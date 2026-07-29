import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { resolveReconciledSubscriptionPeriod } from "../src/lib/subscription";

type PlanCode = "starter" | "professional" | "enterprise";
type Candidate = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  subscriptionPlanCode: string;
};
type Unresolved = { id: string; stripeSubscriptionId: string; reason: string };

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
        subscriptionStatus: { in: ["active", "trialing"] },
        subscriptionPlanCode: { not: null },
        stripeSubscriptionId: { not: null },
        subscriptionCurrentPeriodEndUtc: null,
      },
      select: { id: true, stripeCustomerId: true, stripeSubscriptionId: true, subscriptionPlanCode: true },
      orderBy: { id: "asc" },
    })) as Candidate[];

    const outcomes = await mapWithConcurrency(candidates, MAX_CONCURRENCY, async (candidate) => {
      let subscription: Stripe.Subscription;
      try {
        subscription = await stripe.subscriptions.retrieve(candidate.stripeSubscriptionId);
      } catch {
        return { candidate, updated: false, reason: "stripe_retrieve_failed" };
      }

      const reconciledPeriod = resolveReconciledSubscriptionPeriod({
        subscription,
        expectedTenantId: candidate.id,
        expectedCustomerId: candidate.stripeCustomerId,
        expectedSubscriptionId: candidate.stripeSubscriptionId,
        expectedPlanCode: candidate.subscriptionPlanCode,
        pricePlans,
      });
      if (!reconciledPeriod) {
        return { candidate, updated: false, reason: "provider_state_not_reconcilable" };
      }

      if (!apply) return { candidate, updated: false, reason: "dry_run_update_required" };

      const updated = await prisma.tenant.updateMany({
        where: {
          id: candidate.id,
          stripeCustomerId: candidate.stripeCustomerId,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          subscriptionCurrentPeriodEndUtc: null,
          subscriptionStatus: { in: ["active", "trialing"] },
        },
        data: { subscriptionCurrentPeriodEndUtc: reconciledPeriod },
      });
      return {
        candidate,
        updated: updated.count === 1,
        reason: updated.count === 1 ? null : "tenant_changed_during_reconciliation",
      };
    });

    const unresolved: Unresolved[] = outcomes
      .filter((outcome) => !outcome.updated)
      .map((outcome) => ({
        id: outcome.candidate.id,
        stripeSubscriptionId: outcome.candidate.stripeSubscriptionId,
        reason: outcome.reason ?? "unknown",
      }));
    const report = {
      mode: apply ? "apply" : "dry-run",
      candidateCount: candidates.length,
      updatedCount: outcomes.filter((outcome) => outcome.updated).length,
      unresolvedCount: unresolved.length,
      unresolved,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (unresolved.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "ReconciliationError";
  process.stderr.write(`${JSON.stringify({ error: errorName })}\n`);
  process.exitCode = 1;
});
