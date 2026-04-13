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
      promptText: params.promptText,
      model: params.model ?? null,
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
  };
}
