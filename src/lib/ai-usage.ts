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
  monthlyUsed: number;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
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

export async function loadMonthlyAiUsageSnapshot(
  prisma: AiUsageClient,
  tenantId: string,
  monthlyLimit: number | null,
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
    },
  });

  const monthlyUsed = aggregate._sum.creditsConsumed ?? 0;

  return {
    periodStartUtc,
    periodEndUtc,
    monthlyUsed,
    monthlyLimit,
    monthlyRemaining: monthlyLimit === null ? null : Math.max(monthlyLimit - monthlyUsed, 0),
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
    entitlements.limits.aiQuotesPerMonth,
    now,
  );

  const blocked =
    snapshot.monthlyLimit !== null && snapshot.monthlyUsed >= snapshot.monthlyLimit;

  return {
    blocked,
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
  consumedCredits = 1,
) {
  const monthlyUsed = snapshot.monthlyUsed + consumedCredits;
  return {
    consumedCredits,
    monthlyUsed,
    monthlyLimit: snapshot.monthlyLimit,
    monthlyRemaining:
      snapshot.monthlyLimit === null ? null : Math.max(snapshot.monthlyLimit - monthlyUsed, 0),
    renewsAtUtc: snapshot.periodEndUtc,
  };
}
