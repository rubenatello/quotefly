import {
  AiRetrievalAuditStatus,
  Prisma,
  PrismaClient,
  type AiPurpose,
  type AiUsageEventType,
  type DataClassification,
  type ServiceCategory,
} from "@prisma/client";
import type { ActivityActor } from "./activity";
import {
  governAiPrompt,
  hashSourceReference,
  maxClassificationForQuotePurpose,
} from "./ai-data-governance";
import { AI_DATA_POLICY_VERSION } from "./data-classification";
import type { TenantEntitlements, TenantUsagePeriod, TenantUsagePeriodSource } from "./subscription";
import { withTenantRlsContext } from "./tenant-rls";
import {
  currentAiUsageRootReservation,
  loadAiUsageLedgerTotals,
} from "../services/ai-usage-ledger";

type AiUsageClient = PrismaClient | Prisma.TransactionClient;

export type MonthlyAiUsageSnapshot = {
  periodStartUtc: Date;
  periodEndUtc: Date;
  periodSource: TenantUsagePeriodSource;
  billingCycleReconciliationPending: boolean;
  monthlyCreditsUsed: number;
  monthlyCreditsLimit: number | null;
  monthlyCreditsRemaining: number | null;
  monthlySpendUsedUsd: number;
  monthlySpendLimitUsd: number | null;
  monthlySpendRemainingUsd: number | null;
  monthlySpendUsagePercent: number | null;
  warningThresholdPercent: AiUsageWarningThreshold | null;
  limitReached: boolean;
  estimatedPromptCostUsd: number;
  estimatedPromptsRemaining: number | null;
  monthlyCreditsReserved: number;
  monthlySpendReservedUsd: number;
  monthlyUsageCompletedPercent: number | null;
  monthlyUsageReservedPercent: number | null;
  monthlyUsageEffectivePercent: number | null;
  monthlyUsageRemainingPercent: number | null;
  activeReservationCount: number;
  enforcementMode: "SPEND" | "CREDITS" | "UNLIMITED";
};

export const AI_USAGE_WARNING_THRESHOLDS = [25, 50, 75, 85, 95, 100] as const;
export type AiUsageWarningThreshold = (typeof AI_USAGE_WARNING_THRESHOLDS)[number];

export function resolveAiUsageWarningThreshold(
  usagePercent: number | null | undefined,
): AiUsageWarningThreshold | null {
  if (usagePercent === null || usagePercent === undefined || !Number.isFinite(usagePercent)) return null;
  for (let index = AI_USAGE_WARNING_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    const threshold = AI_USAGE_WARNING_THRESHOLDS[index];
    if (threshold !== undefined && usagePercent >= threshold) return threshold;
  }
  return null;
}

export type AiUsageTelemetry = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export function mergeAiUsageTelemetry(
  ...values: readonly (AiUsageTelemetry | null | undefined)[]
): AiUsageTelemetry | null {
  const present = values.filter((value): value is AiUsageTelemetry => Boolean(value));
  if (present.length === 0) return null;
  return {
    requestCount: present.reduce((sum, value) => sum + value.requestCount, 0),
    promptTokens: present.reduce((sum, value) => sum + value.promptTokens, 0),
    completionTokens: present.reduce((sum, value) => sum + value.completionTokens, 0),
    totalTokens: present.reduce((sum, value) => sum + value.totalTokens, 0),
    estimatedCostUsd: roundUsd(present.reduce((sum, value) => sum + value.estimatedCostUsd, 0)),
  };
}

export function accumulateAiUsageTelemetry(
  target: AiUsageTelemetry,
  value: AiUsageTelemetry | null | undefined,
) {
  if (!value) return target;
  const merged = mergeAiUsageTelemetry(target, value);
  if (!merged) return target;
  Object.assign(target, merged);
  return target;
}

export type AiUsageTrace = {
  insightSummary?: string | null;
  insightReasons?: string[] | null;
  insightSourceLabels?: string[] | null;
  sourceTypes?: string[] | null;
  confidenceLevel?: string | null;
  confidenceLabel?: string | null;
  riskNote?: string | null;
  patch?: {
    added: number;
    updated: number;
    removed: number;
  } | null;
};

export const DEFAULT_ESTIMATED_PROMPT_COST_USD = 0.001615;
const ESTIMATED_PROMPT_COST_SAFETY_MULTIPLIER = 1.1;
const MIN_COST_SAMPLE_COUNT = 5;

function roundUsd(value: number) {
  return Number(value.toFixed(6));
}

export async function loadMonthlyAiUsageSnapshot(
  prisma: PrismaClient,
  tenantId: string,
  limits: {
    credits?: number | null;
    spendUsd?: number | null;
  },
  now = new Date(),
  options?: { userEmail?: string | null; usagePeriod?: TenantUsagePeriod },
): Promise<MonthlyAiUsageSnapshot> {
  const ledger = await loadAiUsageLedgerTotals(prisma, tenantId, now, options);
  const periodStartUtc = ledger.periodStartUtc;
  const periodEndUtc = ledger.periodEndUtc;
  const periodSource = ledger.periodSource;
  const billingCycleReconciliationPending = periodSource === "UTC_CALENDAR_LEGACY";

  const monthlyCreditsUsed = ledger.completedCredits;
  const monthlyCreditsReserved = ledger.reservedCredits;
  const monthlyCreditsLimit = limits.credits ?? null;
  const monthlyCreditsRemaining =
    monthlyCreditsLimit === null
      ? null
      : Math.max(monthlyCreditsLimit - monthlyCreditsUsed - monthlyCreditsReserved, 0);

  const monthlySpendUsedUsd = roundUsd(Number(ledger.completedCostMicros) / 1_000_000);
  const monthlySpendReservedUsd = roundUsd(Number(ledger.reservedCostMicros) / 1_000_000);
  const monthlySpendLimitUsd = limits.spendUsd ?? null;
  const monthlySpendRemainingUsd =
    monthlySpendLimitUsd === null
      ? null
      : roundUsd(Math.max(monthlySpendLimitUsd - monthlySpendUsedUsd - monthlySpendReservedUsd, 0));
  const enforcementMode = monthlySpendLimitUsd !== null
    ? "SPEND" as const
    : monthlyCreditsLimit !== null
      ? "CREDITS" as const
      : "UNLIMITED" as const;
  const completedValue = enforcementMode === "SPEND" ? monthlySpendUsedUsd : monthlyCreditsUsed;
  const reservedValue = enforcementMode === "SPEND" ? monthlySpendReservedUsd : monthlyCreditsReserved;
  const limitValue = enforcementMode === "SPEND" ? monthlySpendLimitUsd : monthlyCreditsLimit;
  const percentage = (value: number) =>
    limitValue !== null && limitValue > 0
      ? Number(Math.min((value / limitValue) * 100, 100).toFixed(2))
      : null;
  const monthlyUsageCompletedPercent = percentage(completedValue);
  const monthlyUsageReservedPercent = percentage(reservedValue);
  const monthlyUsageEffectivePercent = percentage(completedValue + reservedValue);
  const monthlyUsageRemainingPercent = monthlyUsageEffectivePercent === null
    ? null
    : Number(Math.max(100 - monthlyUsageEffectivePercent, 0).toFixed(2));
  const monthlySpendUsagePercent = monthlyUsageEffectivePercent;
  const spendLimitReached =
    monthlySpendLimitUsd !== null
    && monthlySpendUsedUsd + monthlySpendReservedUsd >= monthlySpendLimitUsd;
  const creditsLimitReached =
    monthlySpendLimitUsd === null &&
    monthlyCreditsLimit !== null &&
    monthlyCreditsUsed + monthlyCreditsReserved >= monthlyCreditsLimit;
  const observedPromptCostUsd = monthlyCreditsUsed >= MIN_COST_SAMPLE_COUNT && monthlyCreditsUsed > 0
    ? monthlySpendUsedUsd / monthlyCreditsUsed
    : null;
  const estimatedPromptCostUsd = roundUsd(
    observedPromptCostUsd && Number.isFinite(observedPromptCostUsd) && observedPromptCostUsd > 0
      ? Math.max(
          DEFAULT_ESTIMATED_PROMPT_COST_USD,
          observedPromptCostUsd * ESTIMATED_PROMPT_COST_SAFETY_MULTIPLIER,
        )
      : DEFAULT_ESTIMATED_PROMPT_COST_USD,
  );

  const estimatedPromptsRemaining =
    monthlySpendRemainingUsd === null
      ? null
      : Math.max(Math.floor(monthlySpendRemainingUsd / estimatedPromptCostUsd), 0);

  return {
    periodStartUtc,
    periodEndUtc,
    periodSource,
    billingCycleReconciliationPending,
    monthlyCreditsUsed,
    monthlyCreditsLimit,
    monthlyCreditsRemaining,
    monthlySpendUsedUsd,
    monthlySpendLimitUsd,
    monthlySpendRemainingUsd,
    monthlySpendUsagePercent,
    warningThresholdPercent: resolveAiUsageWarningThreshold(monthlySpendUsagePercent),
    limitReached: spendLimitReached || creditsLimitReached,
    estimatedPromptCostUsd,
    estimatedPromptsRemaining,
    monthlyCreditsReserved,
    monthlySpendReservedUsd,
    monthlyUsageCompletedPercent,
    monthlyUsageReservedPercent,
    monthlyUsageEffectivePercent,
    monthlyUsageRemainingPercent,
    activeReservationCount: ledger.activeReservationCount,
    enforcementMode,
  };
}

export async function assertAiUsageAvailable(
  prisma: PrismaClient,
  tenantId: string,
  entitlements: TenantEntitlements,
  now = new Date(),
) {
  const snapshot = await loadMonthlyAiUsageSnapshot(
    prisma,
    tenantId,
    {
      credits: entitlements.limits.aiQuotesPerMonth,
      spendUsd: entitlements.limits.aiSpendUsdPerMonth,
    },
    now,
    { usagePeriod: entitlements.usagePeriod },
  );
  const spendBlocked =
    snapshot.monthlySpendLimitUsd !== null && snapshot.limitReached;
  const creditsBlocked =
    snapshot.monthlySpendLimitUsd === null && snapshot.limitReached;

  return {
    blocked: spendBlocked || creditsBlocked,
    blockedBy: spendBlocked
      ? "aiSpendUsdPerMonth"
      : creditsBlocked
        ? "aiQuotesPerMonth"
        : null,
    snapshot,
  };
}

export async function createAiUsageEvent(
  prisma: AiUsageClient,
  params: {
    tenantId: string;
    quoteId?: string | null;
    customerId?: string | null;
    actor?: ActivityActor | null;
    eventType: AiUsageEventType;
    promptText: string;
    requestId: string;
    purpose?: AiPurpose;
    classification?: DataClassification;
    serviceType?: ServiceCategory | null;
    sensitiveValues?: readonly (string | null | undefined)[];
    model?: string | null;
    creditsConsumed?: number;
    telemetry?: AiUsageTelemetry | null;
    trace?: AiUsageTrace | null;
    retrievalAuditEventId?: string | null;
  },
) {
  const requestId = params.requestId.trim();
  if (!requestId) {
    throw new Error("AI audit requestId is required.");
  }
  const purpose: AiPurpose =
    params.purpose ?? (params.eventType === "REVISE" ? "QUOTE_REVISION" : "QUOTE_DRAFT");
  const classification = params.classification ?? maxClassificationForQuotePurpose(purpose);
  const governedPrompt = governAiPrompt(params.promptText, {
    knownSensitiveValues: [
      params.actor?.actorEmail,
      params.actor?.actorName,
      ...(params.sensitiveValues ?? []),
    ].filter((value): value is string => Boolean(value?.trim())),
  });
  const sourceTypes = Array.from(
    new Set((params.trace?.sourceTypes ?? []).map((value) => value.trim()).filter(Boolean)),
  )
    .slice(0, 16)
    .map((value) => value.slice(0, 64));
  const sourceRefs = [
    params.quoteId
      ? { type: "quote", refHash: hashSourceReference("quote", params.quoteId) }
      : null,
    params.customerId
      ? { type: "customer", refHash: hashSourceReference("customer", params.customerId) }
      : null,
  ].filter((value): value is { type: string; refHash: string } => value !== null);
  const retrievalAuditEventId = params.retrievalAuditEventId?.trim() || null;
  const currentRoot = currentAiUsageRootReservation();
  if (currentRoot && currentRoot.tenantId !== params.tenantId) {
    throw new Error("AI usage reservation tenant mismatch.");
  }
  return withTenantRlsContext(prisma, params.tenantId, async (tx) => {
  const existingRetrievalAuditEvent = retrievalAuditEventId
    ? await tx.aiRetrievalAuditEvent.findFirst({
        where: {
          id: retrievalAuditEventId,
          tenantId: params.tenantId,
          deletedAtUtc: null,
        },
        select: { id: true },
      })
    : null;

  if (retrievalAuditEventId && !existingRetrievalAuditEvent) {
    throw new Error("AI retrieval audit event not found for tenant.");
  }

  return tx.aiUsageEvent.create({
    data: {
      tenant: { connect: { id: params.tenantId } },
      ...(params.quoteId
        ? { quote: { connect: { id_tenantId: { id: params.quoteId, tenantId: params.tenantId } } } }
        : {}),
      ...(params.customerId
        ? { customer: { connect: { id_tenantId: { id: params.customerId, tenantId: params.tenantId } } } }
        : {}),
      ...(params.actor?.actorUserId
        ? { actorUser: { connect: { id: params.actor.actorUserId } } }
        : {}),
      actorEmail: params.actor?.actorEmail ?? null,
      actorName: params.actor?.actorName ?? null,
      eventType: params.eventType,
      purpose,
      classification,
      serviceType: params.serviceType ?? null,
      creditsConsumed: params.creditsConsumed ?? 1,
      requestCount: params.telemetry?.requestCount ?? 1,
      promptTokens: params.telemetry?.promptTokens ?? null,
      completionTokens: params.telemetry?.completionTokens ?? null,
      totalTokens: params.telemetry?.totalTokens ?? null,
      estimatedCostUsd: params.telemetry?.estimatedCostUsd ?? null,
      // New events intentionally avoid retaining the raw prompt. Historical
      // rows remain untouched until an explicitly authorized purge is run.
      promptText: null,
      promptRedacted: governedPrompt.redacted,
      promptHash: governedPrompt.sha256,
      model: params.model ?? null,
      insightSummary: params.trace?.insightSummary?.trim() || null,
      insightReasons: params.trace?.insightReasons?.filter(Boolean) ?? [],
      insightSourceLabels: params.trace?.insightSourceLabels?.filter(Boolean) ?? [],
      confidenceLevel: params.trace?.confidenceLevel?.trim() || null,
      confidenceLabel: params.trace?.confidenceLabel?.trim() || null,
      riskNote: params.trace?.riskNote?.trim() || null,
      patchAdded: params.trace?.patch?.added ?? null,
      patchUpdated: params.trace?.patch?.updated ?? null,
      patchRemoved: params.trace?.patch?.removed ?? null,
      sourceCount: sourceTypes.length,
      retentionExpiresAtUtc: governedPrompt.retentionExpiresAtUtc,
      retrievalAuditEvent: existingRetrievalAuditEvent
        ? { connect: { id: existingRetrievalAuditEvent.id } }
        : {
            create: {
              tenant: { connect: { id: params.tenantId } },
              ...(params.actor?.actorUserId
                ? { actorUser: { connect: { id: params.actor.actorUserId } } }
                : {}),
              requestId: requestId.slice(0, 128),
              purpose,
              model: params.model ?? null,
              maxClassification: classification,
              sourceTypes,
              sourceRefs: sourceRefs.length ? sourceRefs : Prisma.JsonNull,
              resultCount: sourceTypes.length,
              inputTokenCount: params.telemetry?.promptTokens ?? null,
              outputTokenCount: params.telemetry?.completionTokens ?? null,
              queryHash: governedPrompt.sha256,
              policyVersion: AI_DATA_POLICY_VERSION,
              status: AiRetrievalAuditStatus.SUCCEEDED,
              retentionExpiresAtUtc: governedPrompt.retentionExpiresAtUtc,
            },
          },
      ...(currentRoot
        ? {
            rootReservation: {
              connect: {
                id_tenantId: {
                  id: currentRoot.rootReservationId,
                  tenantId: params.tenantId,
                },
              },
            },
            ledgerAccountedAtUtc: new Date(),
          }
        : {}),
    },
  });
  });
}

export function buildAiUsageResponse(
  snapshot: MonthlyAiUsageSnapshot,
  consumed?: {
    consumedCredits?: number;
    consumedSpendUsd?: number;
  },
  options: { viewInternalCosts?: boolean } = {},
) {
  const consumedCredits = consumed?.consumedCredits ?? 1;
  const consumedSpendUsd = roundUsd(consumed?.consumedSpendUsd ?? 0);
  return {
    consumedCredits,
    monthlyCreditsUsed: snapshot.monthlyCreditsUsed,
    monthlyCreditsReserved: snapshot.monthlyCreditsReserved,
    monthlyCreditsLimit: snapshot.monthlyCreditsLimit,
    monthlyCreditsRemaining: snapshot.monthlyCreditsRemaining,
    monthlyUsageCompletedPercent: snapshot.monthlyUsageCompletedPercent,
    monthlyUsageReservedPercent: snapshot.monthlyUsageReservedPercent,
    monthlyUsageEffectivePercent: snapshot.monthlyUsageEffectivePercent,
    monthlyUsageRemainingPercent: snapshot.monthlyUsageRemainingPercent,
    // Compatibility alias; the effective percentage includes active holds.
    monthlySpendUsagePercent: snapshot.monthlyUsageEffectivePercent,
    warningThresholdPercent: resolveAiUsageWarningThreshold(snapshot.monthlyUsageEffectivePercent),
    activeReservationCount: snapshot.activeReservationCount,
    enforcementMode: snapshot.enforcementMode,
    periodSource: snapshot.periodSource,
    billingCycleReconciliationPending: snapshot.billingCycleReconciliationPending,
    limitReached: snapshot.limitReached,
    estimatedPromptsRemaining: snapshot.estimatedPromptsRemaining,
    renewsAtUtc: snapshot.billingCycleReconciliationPending ? null : snapshot.periodEndUtc,
    ...(options.viewInternalCosts
      ? {
          consumedSpendUsd,
          monthlySpendUsedUsd: snapshot.monthlySpendUsedUsd,
          monthlySpendReservedUsd: snapshot.monthlySpendReservedUsd,
          monthlySpendLimitUsd: snapshot.monthlySpendLimitUsd,
          monthlySpendRemainingUsd: snapshot.monthlySpendRemainingUsd,
          estimatedPromptCostUsd: snapshot.estimatedPromptCostUsd,
        }
      : {}),
  };
}
