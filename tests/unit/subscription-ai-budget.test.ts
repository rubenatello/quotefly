import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH,
  BASIC_AI_SPEND_LIMIT_USD,
  buildTenantEntitlements,
  resolveReconciledSubscriptionUsagePeriod,
} from "../../src/lib/subscription";
import {
  buildStripePeriodReport,
  resolveStripePeriodCandidate,
  stripePeriodBindingsMatch,
  summarizeStripePeriodOutcomes,
} from "../../src/services/stripe-period-reconciliation-policy";

test("paid Basic workspaces receive the approved monthly AI spend ceiling", () => {
  const entitlements = buildTenantEntitlements({
    subscriptionStatus: "active",
    subscriptionPlanCode: "starter",
    stripeCustomerId: "cus_paid_basic",
    stripeSubscriptionId: "sub_paid_basic",
    trialStartsAtUtc: null,
    trialEndsAtUtc: null,
    subscriptionCurrentPeriodStartUtc: new Date("2026-08-13T00:00:00.000Z"),
    subscriptionCurrentPeriodEndUtc: new Date("2026-09-13T00:00:00.000Z"),
  }, new Date("2026-08-13T00:00:00.000Z"));

  assert.equal(BASIC_AI_SPEND_LIMIT_USD, 1.25);
  assert.equal(entitlements.planCode, "starter");
  assert.equal(entitlements.limits.aiQuotesPerMonth, BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH);
  assert.equal(entitlements.limits.aiSpendUsdPerMonth, 1.25);
  assert.equal(entitlements.seatPlanCode, "starter");
  assert.equal(entitlements.seatPlanName, "Basic");
  assert.equal(entitlements.limits.teamMembers, 7);
});

test("full-feature trials cannot consume the Enterprise AI spend ceiling", () => {
  const entitlements = buildTenantEntitlements({
    subscriptionStatus: "trialing",
    subscriptionPlanCode: null,
    trialStartsAtUtc: new Date("2026-08-10T00:00:00.000Z"),
    trialEndsAtUtc: new Date("2026-08-24T00:00:00.000Z"),
    subscriptionCurrentPeriodEndUtc: null,
  }, new Date("2026-08-13T00:00:00.000Z"));

  assert.equal(entitlements.isTrial, true);
  assert.equal(entitlements.planCode, "enterprise");
  assert.equal(entitlements.features.advancedAnalytics, true);
  assert.equal(entitlements.limits.aiQuotesPerMonth, BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH);
  assert.equal(entitlements.limits.aiSpendUsdPerMonth, BASIC_AI_SPEND_LIMIT_USD);
  assert.equal(entitlements.seatPlanCode, "starter");
  assert.equal(entitlements.seatPlanName, "Basic");
  assert.equal(entitlements.limits.teamMembers, 7);
});

test("Professional workspaces receive the 15-seat allowance", () => {
  const entitlements = buildTenantEntitlements({
    subscriptionStatus: "active",
    subscriptionPlanCode: "professional",
    stripeCustomerId: "cus_paid_professional",
    stripeSubscriptionId: "sub_paid_professional",
    trialStartsAtUtc: null,
    trialEndsAtUtc: null,
    subscriptionCurrentPeriodStartUtc: new Date("2026-08-13T00:00:00.000Z"),
    subscriptionCurrentPeriodEndUtc: new Date("2026-09-13T00:00:00.000Z"),
  }, new Date("2026-08-13T00:00:00.000Z"));

  assert.equal(entitlements.planCode, "professional");
  assert.equal(entitlements.seatPlanCode, "professional");
  assert.equal(entitlements.seatPlanName, "Professional");
  assert.equal(entitlements.limits.teamMembers, 15);
});

test("Stripe period reconciliation classifies provider failures and never loses an outcome", async () => {
  const candidate = {
    id: "tenant_reconcile",
    stripeCustomerId: "cus_expected",
    stripeSubscriptionId: "sub_expected",
    subscriptionPlanCode: "starter",
    subscriptionStatus: "active",
  };
  const pricePlans = new Map([["price_starter", "starter" as const]]);
  const retrieveFailure = await resolveStripePeriodCandidate(
    candidate,
    async () => { throw new Error("provider unavailable"); },
    pricePlans,
  );
  assert.deepEqual(retrieveFailure, { state: "FAILED", reason: "stripe_retrieve_failed" });

  const mismatched = await resolveStripePeriodCandidate(
    candidate,
    async () => ({
      id: "sub_expected",
      customer: "cus_different",
      status: "active",
      metadata: { tenantId: candidate.id },
      items: {
        data: [{
          price: { id: "price_starter" },
          current_period_start: 1_787_400_000,
          current_period_end: 1_790_000_000,
        }],
      },
    } as unknown as Stripe.Subscription),
    pricePlans,
    new Date(1_788_000_000_000),
  );
  assert.deepEqual(mismatched, { state: "FAILED", reason: "provider_state_not_reconcilable" });

  const summary = summarizeStripePeriodOutcomes(2, [retrieveFailure, mismatched]);
  assert.deepEqual(summary, {
    inSyncCount: 0,
    needsUpdateCount: 0,
    updatedCount: 0,
    unresolvedCount: 2,
    exitRequired: true,
  });
  assert.throws(
    () => summarizeStripePeriodOutcomes(3, [retrieveFailure, mismatched]),
    /not fully classified/,
  );

  const missingSubscription = await resolveStripePeriodCandidate(
    { ...candidate, stripeSubscriptionId: null },
    async () => { throw new Error("must not retrieve"); },
    pricePlans,
  );
  const missingPlan = await resolveStripePeriodCandidate(
    { ...candidate, subscriptionPlanCode: null },
    async () => { throw new Error("must not retrieve"); },
    pricePlans,
  );
  assert.deepEqual(missingSubscription, {
    state: "FAILED",
    reason: "missing_stripe_subscription_binding",
  });
  assert.deepEqual(missingPlan, { state: "FAILED", reason: "missing_plan_binding" });

  const report = buildStripePeriodReport(2, [
    {
      candidate: { id: "tenant_drift", stripeSubscriptionId: "sub_drift" },
      state: "NEEDS_UPDATE",
      reason: "usage_totals_drift",
    },
    {
      candidate: { id: "tenant_orphan", stripeSubscriptionId: null },
      state: "FAILED",
      reason: "missing_stripe_subscription_binding",
    },
  ]);
  assert.deepEqual(report.needsUpdate, [{
    id: "tenant_drift",
    stripeSubscriptionId: "sub_drift",
    reason: "usage_totals_drift",
  }]);
  assert.deepEqual(report.unresolved, [{
    id: "tenant_orphan",
    stripeSubscriptionId: null,
    reason: "missing_stripe_subscription_binding",
  }]);
  assert.equal(
    report.inSyncCount + report.needsUpdateCount + report.updatedCount + report.unresolvedCount,
    2,
  );
});

test("paid access requires a complete Stripe binding while local trials remain supported", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const paidBase = {
    subscriptionStatus: "active",
    subscriptionPlanCode: "starter",
    trialStartsAtUtc: null,
    trialEndsAtUtc: null,
    subscriptionCurrentPeriodStartUtc: new Date("2026-08-01T00:00:00.000Z"),
    subscriptionCurrentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
  };
  assert.equal(buildTenantEntitlements(paidBase, now).hasWorkspaceAccess, false);
  assert.equal(buildTenantEntitlements({
    ...paidBase,
    stripeCustomerId: "cus_bound",
    stripeSubscriptionId: "sub_bound",
  }, now).hasWorkspaceAccess, true);

  const localTrial = {
    subscriptionStatus: "trialing",
    subscriptionPlanCode: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialStartsAtUtc: new Date("2026-08-10T00:00:00.000Z"),
    trialEndsAtUtc: new Date("2026-08-24T00:00:00.000Z"),
    subscriptionCurrentPeriodEndUtc: null,
  };
  assert.equal(buildTenantEntitlements(localTrial, now).hasWorkspaceAccess, true);
  assert.equal(buildTenantEntitlements({
    ...localTrial,
    stripeCustomerId: "cus_checkout_only",
  }, now).hasWorkspaceAccess, true);
  assert.equal(buildTenantEntitlements({
    ...localTrial,
    stripeCustomerId: "cus_incomplete_trial",
    stripeSubscriptionId: "sub_incomplete_trial",
  }, now).hasWorkspaceAccess, false);
});

test("Stripe trial reconciliation uses exact trial bounds instead of item billing bounds", () => {
  const subscription = {
    id: "sub_trial_bounds",
    customer: "cus_trial_bounds",
    status: "trialing",
    metadata: { tenantId: "tenant_trial_bounds" },
    trial_start: 1_786_000_000,
    trial_end: 1_787_000_000,
    items: { data: [{
      price: { id: "price_starter" },
      current_period_start: 1_785_000_000,
      current_period_end: 1_790_000_000,
    }] },
  } as unknown as Stripe.Subscription;
  const period = resolveReconciledSubscriptionUsagePeriod({
    subscription,
    expectedTenantId: "tenant_trial_bounds",
    expectedCustomerId: "cus_trial_bounds",
    expectedSubscriptionId: "sub_trial_bounds",
    expectedPlanCode: "starter",
    pricePlans: new Map([["price_starter", "starter"]]),
    now: new Date(1_786_500_000_000),
  });
  assert.deepEqual(period, {
    currentPeriodStartUtc: new Date(1_786_000_000_000),
    currentPeriodEndUtc: new Date(1_787_000_000_000),
  });
  const billingPeriod = {
    currentPeriodStartUtc: new Date(1_785_000_000_000),
    currentPeriodEndUtc: new Date(1_790_000_000_000),
  };
  assert.equal(stripePeriodBindingsMatch({
    subscriptionCurrentPeriodStartUtc: billingPeriod.currentPeriodStartUtc,
    subscriptionCurrentPeriodEndUtc: billingPeriod.currentPeriodEndUtc,
    trialStartsAtUtc: null,
    trialEndsAtUtc: null,
  }, {
    subscriptionStatus: "trialing",
    billingPeriod,
    usagePeriod: period!,
  }), false);
  assert.equal(stripePeriodBindingsMatch({
    subscriptionCurrentPeriodStartUtc: billingPeriod.currentPeriodStartUtc,
    subscriptionCurrentPeriodEndUtc: billingPeriod.currentPeriodEndUtc,
    trialStartsAtUtc: period!.currentPeriodStartUtc,
    trialEndsAtUtc: period!.currentPeriodEndUtc,
  }, {
    subscriptionStatus: "trialing",
    billingPeriod,
    usagePeriod: period!,
  }), true);
});
