import { Prisma, PrismaClient, type AiUsageEventType } from "@prisma/client";
import type { ActivityActor } from "./activity";
import type { TenantEntitlements } from "./subscription";
import { startOfCurrentUtcMonth, startOfNextUtcMonth } from "./subscription";

type AiUsageClient =
  | Pick<PrismaClient, "aiUsageEvent">
  | Pick<Prisma.TransactionClient, "aiUsageEvent">;

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

export type AiUsageTrace = {
  insightSummary?: string | null;
  insightReasons?: string[] | null;
  insightSourceLabels?: string[] | null;
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

  const aggregate = await prisma.aiUsageEvent.aggregate({
    where: {
      tenantId,
      deletedAtUtc: null,
      createdAt: {
        gte: periodStartUtc,
        lt: periodEndUtc,
      },
    },
    _sum: {
      creditsConsumed: true,
      estimatedCostUsd: true,
    },
  });

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
  const estimatedPromptsRemaining =
    monthlySpendRemainingUsd === null
      ? null
      : Math.max(Math.floor(monthlySpendRemainingUsd / DEFAULT_ESTIMATED_PROMPT_COST_USD), 0);

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
    estimatedPromptCostUsd: DEFAULT_ESTIMATED_PROMPT_COST_USD,
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
    model?: string | null;
    creditsConsumed?: number;
    telemetry?: AiUsageTelemetry | null;
    trace?: AiUsageTrace | null;
  },
) {
  return prisma.aiUsageEvent.create({
    data: {
      tenantId: params.tenantId,
      quoteId: params.quoteId ?? null,
      customerId: params.customerId ?? null,
      actorUserId: params.actor?.actorUserId ?? null,
      actorEmail: params.actor?.actorEmail ?? null,
      actorName: params.actor?.actorName ?? null,
      eventType: params.eventType,
      creditsConsumed: params.creditsConsumed ?? 1,
      requestCount: params.telemetry?.requestCount ?? 1,
      promptTokens: params.telemetry?.promptTokens ?? null,
      completionTokens: params.telemetry?.completionTokens ?? null,
      totalTokens: params.telemetry?.totalTokens ?? null,
      estimatedCostUsd: params.telemetry?.estimatedCostUsd ?? null,
      promptText: params.promptText,
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
    },
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
