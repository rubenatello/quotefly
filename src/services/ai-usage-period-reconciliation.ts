import { Prisma, type PrismaClient } from "@prisma/client";
import { setTenantRlsContext } from "../lib/tenant-rls";

type ReconciliationClient = Prisma.TransactionClient;

export async function inspectAuthoritativeAiUsagePeriod(
  db: ReconciliationClient,
  input: {
    tenantId: string;
    periodId: string | null;
    periodStartUtc: Date;
    periodEndUtc: Date;
  },
) {
  const { tenantId, periodId, periodStartUtc, periodEndUtc } = input;
  const [activeReservations, linkedTotals, legacyTotals] = await Promise.all([
    periodId
      ? db.aiUsageReservation.count({
          where: {
            tenantId,
            periodId,
            state: { in: ["RESERVED", "STARTED"] },
          },
        })
      : Promise.resolve(0),
    periodId
      ? db.aiUsageEvent.aggregate({
          where: {
            tenantId,
            deletedAtUtc: null,
            rootReservationId: { not: null },
            rootReservation: { periodId },
          },
          _sum: { creditsConsumed: true, estimatedCostUsd: true },
        })
      : Promise.resolve({ _sum: { creditsConsumed: null, estimatedCostUsd: null } }),
    db.aiUsageEvent.aggregate({
      where: {
        tenantId,
        deletedAtUtc: null,
        rootReservationId: null,
        createdAt: { gte: periodStartUtc, lt: periodEndUtc },
      },
      _sum: { creditsConsumed: true, estimatedCostUsd: true },
    }),
  ]);
  const completedCredits =
    (linkedTotals._sum.creditsConsumed ?? 0) + (legacyTotals._sum.creditsConsumed ?? 0);
  const completedCostMicros = BigInt(Math.round((
    Number(linkedTotals._sum.estimatedCostUsd ?? 0)
    + Number(legacyTotals._sum.estimatedCostUsd ?? 0)
  ) * 1_000_000));
  return { activeReservations, completedCredits, completedCostMicros };
}

export async function reconcileAuthoritativeAiUsagePeriod(
  db: ReconciliationClient,
  input: {
    tenantId: string;
    periodStartUtc: Date;
    periodEndUtc: Date;
    deferOnActiveReservations?: boolean;
  },
) {
  const { tenantId, periodStartUtc, periodEndUtc } = input;
  if (periodStartUtc.getTime() >= periodEndUtc.getTime()) {
    throw new Error("AI_USAGE_PERIOD_RECONCILIATION_BOUNDS_INVALID");
  }

  await setTenantRlsContext(db, tenantId);
  const period = await db.aiUsagePeriod.upsert({
    where: { tenantId_periodStartUtc: { tenantId, periodStartUtc } },
    create: { tenantId, periodStartUtc, periodEndUtc },
    update: { periodEndUtc },
    select: { id: true },
  });
  await db.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "AiUsagePeriod"
    WHERE "id" = ${period.id} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `);

  // Active work already reserved into the target period must settle and emit
  // its linked content-free audit before counters are rebuilt. Work reserved
  // into another period remains immutably attributed there, even if a delayed
  // renewal webhook arrives while that old-period request is still active.
  const inspected = await inspectAuthoritativeAiUsagePeriod(db, {
    tenantId,
    periodId: period.id,
    periodStartUtc,
    periodEndUtc,
  });
  if (inspected.activeReservations > 0) {
    if (input.deferOnActiveReservations) {
      return {
        periodId: period.id,
        completedCredits: null,
        completedCostMicros: null,
        deferred: true as const,
      };
    }
    throw new Error("AI_USAGE_PERIOD_RECONCILIATION_ACTIVE_RESERVATION");
  }

  // Linked audits are attributed to their immutable root reservation period,
  // even when settlement/event persistence crosses renewal. Only rolling-era
  // unlinked events use event.createdAt. Replacing counters is then idempotent.
  await db.aiUsagePeriod.update({
    where: { id: period.id },
    data: {
      periodEndUtc,
      completedCredits: inspected.completedCredits,
      completedCostMicros: inspected.completedCostMicros,
    },
  });

  return {
    periodId: period.id,
    completedCredits: inspected.completedCredits,
    completedCostMicros: inspected.completedCostMicros,
    deferred: false as const,
  };
}

export async function reconcileAuthoritativeAiUsagePeriodTransaction(
  prisma: PrismaClient,
  input: Parameters<typeof reconcileAuthoritativeAiUsagePeriod>[1],
) {
  return prisma.$transaction(
    (tx) => reconcileAuthoritativeAiUsagePeriod(tx, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 },
  );
}
