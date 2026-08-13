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
import type { TenantEntitlements } from "./subscription";
import { startOfCurrentUtcMonth, startOfNextUtcMonth } from "./subscription";
import { withTenantRlsContext } from "./tenant-rls";

type AiUsageClient = PrismaClient | Prisma.TransactionClient;

export type MonthlyAiUsageSnapshot = {
  periodStartUtc: Date;
  periodEndUtc: Date;
  monthlyCreditsUsed: number;
  monthlyCreditsLimit: number | null;
  monthlyCreditsRemaining: number | null;
  monthlySpendUsedUsd: number;
  monthlySpendLimitUsd: number | null;
  monthlySpendRemainingUsd: number | null;
  monthlySpendUsagePercent: number | null;
  estimatedPromptCostUsd: number;
  estimatedPromptsRemaining: number | null;
};

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
  prisma: AiUsageClient,
  tenantId: string,
  limits: {
    credits?: number | null;
    spendUsd?: number | null;
  },
  now = new Date(),
): Promise<MonthlyAiUsageSnapshot> {
  const periodStartUtc = startOfCurrentUtcMonth(now);
  const periodEndUtc = startOfNextUtcMonth(now);

  const baseWhere: Prisma.AiUsageEventWhereInput = {
    tenantId,
    deletedAtUtc: null,
    createdAt: {
      gte: periodStartUtc,
      lt: periodEndUtc,
    },
  };

  const [aggregate, costedAggregate] = await Promise.all([
    prisma.aiUsageEvent.aggregate({
      where: baseWhere,
      _sum: {
        creditsConsumed: true,
        estimatedCostUsd: true,
      },
    }),
    prisma.aiUsageEvent.aggregate({
      where: {
        ...baseWhere,
        estimatedCostUsd: {
          gt: 0,
        },
      },
      _sum: {
        creditsConsumed: true,
        estimatedCostUsd: true,
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const monthlyCreditsUsed = aggregate._sum.creditsConsumed ?? 0;
  const monthlyCreditsLimit = limits.credits ?? null;
  const monthlyCreditsRemaining =
    monthlyCreditsLimit === null ? null : Math.max(monthlyCreditsLimit - monthlyCreditsUsed, 0);

  const monthlySpendUsedUsd = roundUsd(Number(aggregate._sum.estimatedCostUsd ?? 0));
  const monthlySpendLimitUsd = limits.spendUsd ?? null;
  const monthlySpendRemainingUsd =
    monthlySpendLimitUsd === null ? null : roundUsd(Math.max(monthlySpendLimitUsd - monthlySpendUsedUsd, 0));
  const monthlySpendUsagePercent =
    monthlySpendLimitUsd !== null && monthlySpendLimitUsd > 0
      ? Number(Math.min((monthlySpendUsedUsd / monthlySpendLimitUsd) * 100, 100).toFixed(2))
      : null;
  const observedCostedSamples = costedAggregate._count._all ?? 0;
  const observedCredits = Number(costedAggregate._sum.creditsConsumed ?? 0);
  const observedSpendUsd = Number(costedAggregate._sum.estimatedCostUsd ?? 0);
  const observedPromptCostUsd =
    observedCostedSamples >= MIN_COST_SAMPLE_COUNT && observedCredits > 0
      ? observedSpendUsd / observedCredits
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
    monthlyCreditsUsed,
    monthlyCreditsLimit,
    monthlyCreditsRemaining,
    monthlySpendUsedUsd,
    monthlySpendLimitUsd,
    monthlySpendRemainingUsd,
    monthlySpendUsagePercent,
    estimatedPromptCostUsd,
    estimatedPromptsRemaining,
  };
}

export async function assertAiUsageAvailable(
  prisma: AiUsageClient,
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
  );
  const spendBlocked =
    snapshot.monthlySpendLimitUsd !== null &&
    snapshot.monthlySpendUsedUsd >= snapshot.monthlySpendLimitUsd;
  const creditsBlocked =
    snapshot.monthlySpendLimitUsd === null &&
    snapshot.monthlyCreditsLimit !== null &&
    snapshot.monthlyCreditsUsed >= snapshot.monthlyCreditsLimit;

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
) {
  const consumedCredits = consumed?.consumedCredits ?? 1;
  const consumedSpendUsd = roundUsd(consumed?.consumedSpendUsd ?? 0);
  const monthlyCreditsUsed = snapshot.monthlyCreditsUsed + consumedCredits;
  const monthlySpendUsedUsd = roundUsd(snapshot.monthlySpendUsedUsd + consumedSpendUsd);
  const monthlyCreditsRemaining =
    snapshot.monthlyCreditsLimit === null
      ? null
      : Math.max(snapshot.monthlyCreditsLimit - monthlyCreditsUsed, 0);
  const monthlySpendRemainingUsd =
    snapshot.monthlySpendLimitUsd === null
      ? null
      : roundUsd(Math.max(snapshot.monthlySpendLimitUsd - monthlySpendUsedUsd, 0));
  const monthlySpendUsagePercent =
    snapshot.monthlySpendLimitUsd !== null && snapshot.monthlySpendLimitUsd > 0
      ? Number(Math.min((monthlySpendUsedUsd / snapshot.monthlySpendLimitUsd) * 100, 100).toFixed(2))
      : null;
  const estimatedPromptsRemaining =
    monthlySpendRemainingUsd === null
      ? null
      : Math.max(Math.floor(monthlySpendRemainingUsd / snapshot.estimatedPromptCostUsd), 0);

  return {
    consumedCredits,
    consumedSpendUsd,
    monthlyCreditsUsed,
    monthlyCreditsLimit: snapshot.monthlyCreditsLimit,
    monthlyCreditsRemaining,
    monthlySpendUsedUsd,
    monthlySpendLimitUsd: snapshot.monthlySpendLimitUsd,
    monthlySpendRemainingUsd,
    monthlySpendUsagePercent,
    estimatedPromptCostUsd: snapshot.estimatedPromptCostUsd,
    estimatedPromptsRemaining,
    renewsAtUtc: snapshot.periodEndUtc,
  };
}
