import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { setTenantRlsContext } from "../src/lib/tenant-rls";
import {
  inspectAuthoritativeAiUsagePeriod,
  reconcileAuthoritativeAiUsagePeriod,
} from "../src/services/ai-usage-period-reconciliation";
import {
  buildStripePeriodReport,
  resolveStripePeriodCandidate,
  stripePeriodBindingsMatch,
} from "../src/services/stripe-period-reconciliation-policy";

type PlanCode = "starter" | "professional" | "enterprise";
type Candidate = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionPlanCode: string | null;
  subscriptionStatus: string;
  subscriptionCurrentPeriodStartUtc: Date | null;
  subscriptionCurrentPeriodEndUtc: Date | null;
  trialStartsAtUtc: Date | null;
  trialEndsAtUtc: Date | null;
};
const APPLY_FLAG = "--apply";
const MAX_CONCURRENCY = 4;
const STRIPE_TIMEOUT_MS = 10_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function configuredPricePlans(): ReadonlyMap<string, PlanCode> {
  const entries: Array<[string, PlanCode]> = [
    [requiredEnvironment("STRIPE_PRICE_ID_STARTER"), "starter"],
  ];
  const optionalPrices: Array<[string | undefined, PlanCode]> = [
    [process.env.STRIPE_PRICE_ID_PROFESSIONAL?.trim(), "professional"],
    [process.env.STRIPE_PRICE_ID_ENTERPRISE?.trim(), "enterprise"],
  ];
  for (const [priceId, planCode] of optionalPrices) {
    if (priceId) entries.push([priceId, planCode]);
  }
  return new Map(entries);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function inspectReconciliationState(
  prisma: PrismaClient,
  candidate: Candidate,
  billingPeriod: { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date },
  usagePeriod: { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date },
  subscriptionStatus: string,
) {
  return prisma.$transaction(async (tx) => {
    await setTenantRlsContext(tx, candidate.id);
    const stored = await tx.aiUsagePeriod.findUnique({
      where: {
        tenantId_periodStartUtc: {
          tenantId: candidate.id,
          periodStartUtc: usagePeriod.currentPeriodStartUtc,
        },
      },
    });
    const inspected = await inspectAuthoritativeAiUsagePeriod(tx, {
      tenantId: candidate.id,
      periodId: stored?.id ?? null,
      periodStartUtc: usagePeriod.currentPeriodStartUtc,
      periodEndUtc: usagePeriod.currentPeriodEndUtc,
    });
    const boundsMatch = stripePeriodBindingsMatch(candidate, {
      subscriptionStatus,
      billingPeriod,
      usagePeriod,
    });
    const countersMatch =
      stored?.periodEndUtc.getTime() === usagePeriod.currentPeriodEndUtc.getTime()
      && stored.completedCredits === inspected.completedCredits
      && stored.completedCostMicros === inspected.completedCostMicros;
    return {
      inSync: boundsMatch && countersMatch && inspected.activeReservations === 0,
      reason: inspected.activeReservations > 0
        ? "active_ai_reservation"
        : !boundsMatch
          ? "billing_bounds_drift"
          : "usage_totals_drift",
    };
  });
}

async function main() {
  const unknownArgs = process.argv.slice(2).filter((argument) => argument !== APPLY_FLAG);
  if (unknownArgs.length > 0) throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  const apply = process.argv.includes(APPLY_FLAG);
  const prisma = new PrismaClient();
  const stripe = new Stripe(requiredEnvironment("STRIPE_SECRET_KEY"), {
    apiVersion: "2026-06-24.dahlia",
    maxNetworkRetries: 2,
    timeout: STRIPE_TIMEOUT_MS,
  });
  const pricePlans = configuredPricePlans();

  try {
    const candidates = (await prisma.tenant.findMany({
      where: {
        deletedAtUtc: null,
        OR: [
          { subscriptionStatus: "active" },
          { subscriptionStatus: "trialing", stripeSubscriptionId: { not: null } },
        ],
      },
      select: {
        id: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionPlanCode: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodStartUtc: true,
        subscriptionCurrentPeriodEndUtc: true,
        trialStartsAtUtc: true,
        trialEndsAtUtc: true,
      },
      orderBy: { id: "asc" },
    })) as Candidate[];

    const outcomes = await mapWithConcurrency(candidates, MAX_CONCURRENCY, async (candidate) => {
      const provider = await resolveStripePeriodCandidate(
        candidate,
        (subscriptionId) => stripe.subscriptions.retrieve(subscriptionId),
        pricePlans,
      );
      if (provider.state === "FAILED") {
        return { candidate, state: provider.state, reason: provider.reason };
      }
      const { billingPeriod, usagePeriod, subscriptionStatus } = provider;

      const inspection = await inspectReconciliationState(
        prisma,
        candidate,
        billingPeriod,
        usagePeriod,
        subscriptionStatus,
      );
      if (inspection.inSync) {
        return { candidate, state: "IN_SYNC" as const, reason: null };
      }
      if (!apply) {
        return { candidate, state: "NEEDS_UPDATE" as const, reason: inspection.reason };
      }

      try {
        await prisma.$transaction(async (tx) => {
          const bound = await tx.tenant.updateMany({
            where: {
              id: candidate.id,
              stripeCustomerId: candidate.stripeCustomerId,
              stripeSubscriptionId: candidate.stripeSubscriptionId,
              subscriptionStatus: { in: ["active", "trialing"] },
            },
            data: {
              subscriptionCurrentPeriodStartUtc: billingPeriod.currentPeriodStartUtc,
              subscriptionCurrentPeriodEndUtc: billingPeriod.currentPeriodEndUtc,
              ...(subscriptionStatus === "trialing"
                ? {
                    trialStartsAtUtc: usagePeriod.currentPeriodStartUtc,
                    trialEndsAtUtc: usagePeriod.currentPeriodEndUtc,
                  }
                : {}),
            },
          });
          if (bound.count !== 1) throw new Error("TENANT_CHANGED_DURING_RECONCILIATION");
          await reconcileAuthoritativeAiUsagePeriod(tx, {
            tenantId: candidate.id,
            periodStartUtc: usagePeriod.currentPeriodStartUtc,
            periodEndUtc: usagePeriod.currentPeriodEndUtc,
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
        return { candidate, state: "UPDATED" as const, reason: null };
      } catch (error) {
        const reason = error instanceof Error && error.message === "AI_USAGE_PERIOD_RECONCILIATION_ACTIVE_RESERVATION"
          ? "active_ai_reservation"
          : error instanceof Error && error.message === "TENANT_CHANGED_DURING_RECONCILIATION"
            ? "tenant_changed_during_reconciliation"
            : "reconciliation_transaction_failed";
        return { candidate, state: "FAILED" as const, reason };
      }
    });

    const summary = buildStripePeriodReport(candidates.length, outcomes);
    const report = {
      mode: apply ? "apply" : "dry-run",
      candidateCount: candidates.length,
      inSyncCount: summary.inSyncCount,
      needsUpdateCount: summary.needsUpdateCount,
      updatedCount: summary.updatedCount,
      unresolvedCount: summary.unresolvedCount,
      needsUpdate: summary.needsUpdate,
      unresolved: summary.unresolved,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (summary.exitRequired) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "ReconciliationError";
  process.stderr.write(`${JSON.stringify({ error: errorName })}\n`);
  process.exitCode = 1;
});
