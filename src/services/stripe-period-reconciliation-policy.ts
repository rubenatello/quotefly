import type Stripe from "stripe";
import {
  resolveReconciledSubscriptionBillingPeriod,
  resolveReconciledSubscriptionUsagePeriod,
  type PlanCode,
} from "../lib/subscription";

export type StripePeriodCandidate = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionPlanCode: string | null;
  subscriptionStatus: string;
};

export type StripePeriodOutcomeState = "IN_SYNC" | "NEEDS_UPDATE" | "UPDATED" | "FAILED";

export async function resolveStripePeriodCandidate(
  candidate: StripePeriodCandidate,
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>,
  pricePlans: ReadonlyMap<string, PlanCode>,
  now = new Date(),
) {
  if (!candidate.stripeSubscriptionId) {
    return { state: "FAILED" as const, reason: "missing_stripe_subscription_binding" as const };
  }
  if (!candidate.subscriptionPlanCode) {
    return { state: "FAILED" as const, reason: "missing_plan_binding" as const };
  }
  let subscription: Stripe.Subscription;
  try {
    subscription = await retrieveSubscription(candidate.stripeSubscriptionId);
  } catch {
    return { state: "FAILED" as const, reason: "stripe_retrieve_failed" as const };
  }
  if (subscription.status !== candidate.subscriptionStatus) {
    return { state: "FAILED" as const, reason: "provider_status_mismatch" as const };
  }
  const reconciliationInput = {
    subscription,
    expectedTenantId: candidate.id,
    expectedCustomerId: candidate.stripeCustomerId,
    expectedSubscriptionId: candidate.stripeSubscriptionId,
    expectedPlanCode: candidate.subscriptionPlanCode,
    pricePlans,
    now,
  };
  const billingPeriod = resolveReconciledSubscriptionBillingPeriod(reconciliationInput);
  const usagePeriod = resolveReconciledSubscriptionUsagePeriod(reconciliationInput);
  return billingPeriod && usagePeriod
    ? { state: "READY" as const, billingPeriod, usagePeriod, subscriptionStatus: subscription.status }
    : { state: "FAILED" as const, reason: "provider_state_not_reconcilable" as const };
}

export function summarizeStripePeriodOutcomes(
  candidateCount: number,
  outcomes: ReadonlyArray<{ state: StripePeriodOutcomeState }>,
) {
  const inSyncCount = outcomes.filter((outcome) => outcome.state === "IN_SYNC").length;
  const needsUpdateCount = outcomes.filter((outcome) => outcome.state === "NEEDS_UPDATE").length;
  const updatedCount = outcomes.filter((outcome) => outcome.state === "UPDATED").length;
  const unresolvedCount = outcomes.filter((outcome) => outcome.state === "FAILED").length;
  const classifiedCount = inSyncCount + needsUpdateCount + updatedCount + unresolvedCount;
  if (classifiedCount !== candidateCount) {
    throw new Error("Reconciliation outcomes were not fully classified.");
  }
  return {
    inSyncCount,
    needsUpdateCount,
    updatedCount,
    unresolvedCount,
    exitRequired: needsUpdateCount > 0 || unresolvedCount > 0,
  };
}

export function stripePeriodBindingsMatch(
  stored: {
    subscriptionCurrentPeriodStartUtc: Date | null;
    subscriptionCurrentPeriodEndUtc: Date | null;
    trialStartsAtUtc: Date | null;
    trialEndsAtUtc: Date | null;
  },
  input: {
    subscriptionStatus: string;
    billingPeriod: { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date };
    usagePeriod: { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date };
  },
) {
  const billingMatches =
    stored.subscriptionCurrentPeriodStartUtc?.getTime() === input.billingPeriod.currentPeriodStartUtc.getTime()
    && stored.subscriptionCurrentPeriodEndUtc?.getTime() === input.billingPeriod.currentPeriodEndUtc.getTime();
  if (!billingMatches) return false;
  if (input.subscriptionStatus !== "trialing") return true;
  return stored.trialStartsAtUtc?.getTime() === input.usagePeriod.currentPeriodStartUtc.getTime()
    && stored.trialEndsAtUtc?.getTime() === input.usagePeriod.currentPeriodEndUtc.getTime();
}

type ReportableStripePeriodOutcome = {
  candidate: { id: string; stripeSubscriptionId: string | null };
  state: StripePeriodOutcomeState;
  reason: string | null;
};

export function buildStripePeriodReport(
  candidateCount: number,
  outcomes: ReadonlyArray<ReportableStripePeriodOutcome>,
) {
  const summary = summarizeStripePeriodOutcomes(candidateCount, outcomes);
  const project = (outcome: ReportableStripePeriodOutcome) => ({
    id: outcome.candidate.id,
    stripeSubscriptionId: outcome.candidate.stripeSubscriptionId,
    reason: outcome.reason ?? "unknown",
  });
  return {
    ...summary,
    needsUpdate: outcomes.filter((outcome) => outcome.state === "NEEDS_UPDATE").map(project),
    unresolved: outcomes.filter((outcome) => outcome.state === "FAILED").map(project),
  };
}
