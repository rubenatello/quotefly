import assert from "node:assert/strict";
import test from "node:test";
import {
  BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH,
  BASIC_AI_SPEND_LIMIT_USD,
  buildTenantEntitlements,
} from "../../src/lib/subscription";

test("paid Basic workspaces receive the approved monthly AI spend ceiling", () => {
  const entitlements = buildTenantEntitlements({
    subscriptionStatus: "active",
    subscriptionPlanCode: "starter",
    trialStartsAtUtc: null,
    trialEndsAtUtc: null,
    subscriptionCurrentPeriodEndUtc: new Date("2026-09-13T00:00:00.000Z"),
  }, new Date("2026-08-13T00:00:00.000Z"));

  assert.equal(BASIC_AI_SPEND_LIMIT_USD, 1.25);
  assert.equal(entitlements.planCode, "starter");
  assert.equal(entitlements.limits.aiQuotesPerMonth, BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH);
  assert.equal(entitlements.limits.aiSpendUsdPerMonth, 1.25);
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
});
