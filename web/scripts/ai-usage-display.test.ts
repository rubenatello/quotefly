import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  aiUsageUpdateFromApiError,
  aiUsageProgressTone,
  aiUsageWarningCopy,
  assistantToolConsumesAiBudget,
  formatAiPaidUsagePause,
  formatAiUsageNotice,
  formatAiUsageBreakdown,
  resolveAiUsagePresentation,
  resolveAiUsageWarningThreshold,
} from "../src/lib/ai-credits";
import { ApiError } from "../src/lib/api";

test("AI usage display uses the approved warning milestones", () => {
  assert.equal(resolveAiUsageWarningThreshold(24.99), null);
  assert.equal(resolveAiUsageWarningThreshold(25), 25);
  assert.equal(resolveAiUsageWarningThreshold(50), 50);
  assert.equal(resolveAiUsageWarningThreshold(75), 75);
  assert.equal(resolveAiUsageWarningThreshold(85), 85);
  assert.equal(resolveAiUsageWarningThreshold(95), 95);
  assert.equal(resolveAiUsageWarningThreshold(100), 100);
  assert.equal(aiUsageProgressTone(74.99), "default");
  assert.equal(aiUsageProgressTone(75), "warning");
  assert.equal(aiUsageProgressTone(95), "danger");
});

test("Kody only pre-disables explicit server-budgeted tools", () => {
  for (const paid of ["SEARCH_CUSTOMERS", "SUMMARIZE_PIPELINE", "RANK_PROFITABLE_JOBS", "DRAFT_QUOTE"] as const) {
    assert.equal(assistantToolConsumesAiBudget(paid), true, `${paid} must be paid`);
  }
  for (const available of [
    "AUTO",
    "ASSISTANT_HELP",
    "NAVIGATE_WORKSPACE",
    "LIST_MY_ACTIVITIES",
    "PRIORITIZE_MY_DAY",
    "LIST_SCHEDULE",
    "SEARCH_PRODUCTS",
    "SEARCH_JOBS",
    "GET_JOB_STATUS",
    "LIST_INVOICES",
    "GET_INVOICE_STATUS",
    "DRAFT_PRODUCT",
    "PREPARE_ACTIVITY",
    "PREPARE_BOOKING",
    "PREPARE_DISPATCH",
    "PREPARE_QUOTE_SEND",
  ] as const) {
    assert.equal(assistantToolConsumesAiBudget(available), false, `${available} must remain available`);
  }
});

test("AI usage display counts active reservations without requiring dollar fields", () => {
  const presentation = resolveAiUsagePresentation({
    monthlyUsageCompletedPercent: 70,
    monthlyUsageReservedPercent: 8,
    monthlyUsageEffectivePercent: 78,
    monthlyUsageRemainingPercent: 22,
    activeReservationCount: 2,
    enforcementMode: "SPEND",
    limitReached: false,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(presentation, {
    completedPercent: 70,
    reservedPercent: 8,
    effectivePercent: 78,
    remainingPercent: 22,
    activeReservationCount: 2,
    enforcementMode: "SPEND",
    periodSource: null,
    billingCycleReconciliationPending: false,
    accountingUnavailable: false,
    paidActionsUnavailable: false,
    limitReached: false,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
    periodStartUtc: null,
  });
  const copy = formatAiUsageBreakdown({
    monthlyUsageCompletedPercent: 70,
    monthlyUsageReservedPercent: 8,
    monthlyUsageEffectivePercent: 78,
    monthlyUsageRemainingPercent: 22,
    activeReservationCount: 2,
    enforcementMode: "SPEND",
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  }, "en-US");
  assert.match(copy.valueText, /78% used/i);
  assert.match(copy.valueText, /70% completed/i);
  assert.match(copy.valueText, /8% in progress/i);
  assert.match(copy.valueText, /22% available/i);
  assert.match(copy.valueText, /2 active requests/i);
  assert.doesNotMatch(copy.valueText, /\$/);
});

test("billing-cycle reconciliation suppresses percentages and pauses only paid AI", () => {
  const usage = {
    monthlyUsageCompletedPercent: 70,
    monthlyUsageReservedPercent: 8,
    monthlyUsageEffectivePercent: 78,
    monthlyUsageRemainingPercent: 22,
    activeReservationCount: 2,
    enforcementMode: "SPEND" as const,
    periodSource: "UTC_CALENDAR_LEGACY" as const,
    billingCycleReconciliationPending: true,
    limitReached: false,
    periodEndUtc: "2026-09-01T00:00:00.000Z",
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  };
  const presentation = resolveAiUsagePresentation(usage);
  assert.equal(presentation.billingCycleReconciliationPending, true);
  assert.equal(presentation.paidActionsUnavailable, true);
  assert.equal(presentation.limitReached, false);
  assert.equal(presentation.renewsAtUtc, null);

  const copy = formatAiUsageBreakdown(usage, "en-US");
  assert.match(copy.headline, /temporarily unavailable/i);
  assert.match(copy.detail, /reconciling.*billing cycle/i);
  assert.doesNotMatch(`${copy.headline} ${copy.detail}`, /\d+%|used this month|renews|Sep 1/i);

  const pause = formatAiPaidUsagePause(usage, "en-US");
  assert.match(pause, /Paid AI drafting and analysis are paused/i);
  assert.match(pause, /Schedule, task, product lookup, navigation, help, and review tools still work/i);
  assert.doesNotMatch(pause, /monthly|renews|Sep 1/i);

  const oldServer = resolveAiUsagePresentation({
    monthlyUsageEffectivePercent: 78,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
    limitReached: false,
  });
  assert.equal(oldServer.billingCycleReconciliationPending, false);
  assert.equal(oldServer.paidActionsUnavailable, false);
  assert.equal(oldServer.renewsAtUtc, "2026-09-01T00:00:00.000Z");
});

test("paid reconciliation gating is wired through Kody and both quote AI surfaces", () => {
  const layout = readFileSync(new URL("../src/components/CrmAppLayout.tsx", import.meta.url), "utf8");
  const kody = readFileSync(new URL("../src/components/ai/KodyAssistant.tsx", import.meta.url), "utf8");
  const builder = readFileSync(new URL("../src/views/QuoteBuilderView.tsx", import.meta.url), "utf8");
  const desk = readFileSync(new URL("../src/views/QuoteDeskView.tsx", import.meta.url), "utf8");

  assert.match(layout, /aiPaidActionsUnavailable=\{aiUsage\.paidActionsUnavailable\}/);
  assert.match(layout, /aiUsageReconciliationPending=\{aiUsage\.billingCycleReconciliationPending\}/);
  assert.match(kody, /aiPaidActionsUnavailable && assistantToolConsumesAiBudget\(quickPrompt\.tool\)/);
  assert.match(kody, /aiUsageReconciliationPending\s*\? t\("billing\.aiUsage\.reconciliationDescription"\)/);
  assert.match(kody, /aiUsageAccountingUnavailable/);
  assert.match(kody, /errorCode === "AI_USAGE_ACCOUNTING_UNAVAILABLE"/);
  assert.match(kody, /err instanceof ApiError && err\.status === 503\s*\? t\("kody\.errors\.temporaryFailure"\)/);
  assert.match(builder, /disabled=\{!canUseChatToQuote \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(builder, /<QuoteKodyPrepareModal/);
  assert.match(builder, /usageLimitMessage=\{aiUsage\.paidActionsUnavailable \? aiUsageLimitMessage : null\}/);
  assert.doesNotMatch(builder, /assistDisabled=\{!canUseChatToQuote \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(desk, /disabled=\{!canUseChatToQuote \|\| isQuoteLocked \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(desk, /assistDisabled=\{!canUseChatToQuote \|\| isQuoteLocked \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(builder, /disabled=\{!canUseChatToQuote \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(desk, /disabled=\{!canUseChatToQuote \|\| aiUsage\.paidActionsUnavailable\}/);
  assert.match(builder, /quote-builder-ai-pause-desktop/);
  assert.match(builder, /quote-builder-ai-pause-mobile/);
  assert.match(desk, /quote-desk-ai-pause/);
});

test("compatibility usage percent remains effective and period changes reset presentation", () => {
  const capped = resolveAiUsagePresentation({
    monthlySpendUsagePercent: 100,
    limitReached: true,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  });
  const renewed = resolveAiUsagePresentation({
    monthlyUsageCompletedPercent: 0,
    monthlyUsageReservedPercent: 0,
    monthlyUsageEffectivePercent: 0,
    monthlyUsageRemainingPercent: 100,
    limitReached: false,
    renewsAtUtc: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(capped.limitReached, true);
  assert.equal(capped.effectivePercent, 100);
  assert.equal(renewed.limitReached, false);
  assert.equal(renewed.effectivePercent, 0);
  assert.notEqual(capped.renewsAtUtc, renewed.renewsAtUtc);
});

test("user-facing AI usage copy never estimates prompt counts", () => {
  const notice = formatAiUsageNotice({
    consumedCredits: 1,
    consumedSpendUsd: 0.01,
    monthlyCreditsUsed: 25,
    monthlyCreditsLimit: 100,
    monthlyCreditsRemaining: 75,
    monthlySpendUsedUsd: 0.5,
    monthlySpendLimitUsd: 1,
    monthlySpendRemainingUsd: 0.5,
    monthlySpendUsagePercent: 50,
    warningThresholdPercent: 50,
    limitReached: false,
    estimatedPromptCostUsd: 0.001,
    estimatedPromptsRemaining: 500,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  });

  assert.match(notice, /50% used this billing cycle/i);
  assert.doesNotMatch(notice, /prompt/i);
  assert.match(aiUsageWarningCopy(100, "2026-09-01T00:00:00.000Z").description, /paused/i);
});

test("a canonical usage-limit 402 pauses paid AI without inventing usage values", () => {
  const update = aiUsageUpdateFromApiError(new ApiError("limit", 402, {
    code: "AI_USAGE_LIMIT_REACHED",
    error: "The usage limit has been reached.",
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  }));

  assert.deepEqual(update, {
    limitReached: true,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
  });
  assert.equal("monthlyUsageEffectivePercent" in (update ?? {}), false);
  assert.equal("monthlySpendUsedUsd" in (update ?? {}), false);
});

test("a canonical accounting 503 immediately pauses paid AI without fabricating billing data", () => {
  const update = aiUsageUpdateFromApiError(new ApiError("accounting", 503, {
    code: "AI_USAGE_ACCOUNTING_UNAVAILABLE",
    error: "AI usage accounting is being reconciled.",
  }));

  assert.deepEqual(update, { accountingUnavailable: true });
  const presentation = resolveAiUsagePresentation({
    monthlyUsageEffectivePercent: 18,
    renewsAtUtc: "2026-09-01T00:00:00.000Z",
    ...update,
  });
  assert.equal(presentation.billingCycleReconciliationPending, false);
  assert.equal(presentation.accountingUnavailable, true);
  assert.equal(presentation.paidActionsUnavailable, true);
  assert.equal(presentation.renewsAtUtc, "2026-09-01T00:00:00.000Z");
  assert.equal(assistantToolConsumesAiBudget("PREPARE_BOOKING"), false);
});

test("unrelated 503 responses never change paid AI availability", () => {
  const update = aiUsageUpdateFromApiError(new ApiError("temporary", 503, {
    code: "UPSTREAM_TEMPORARILY_UNAVAILABLE",
    error: "Try again later.",
  }));
  assert.equal(update, null);
  assert.equal(resolveAiUsagePresentation({ monthlyUsageEffectivePercent: 18 }).paidActionsUnavailable, false);
});

test("the app session consumes the global accounting-pause event", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const milestoneNotifier = readFileSync(new URL("../src/components/ai/AiUsageMilestoneNotifier.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.addEventListener\(AI_USAGE_UPDATED_EVENT, handleAiUsageUpdate\)/);
  assert.match(app, /usage:\s*\{[\s\S]*\.\.\.detail/);
  assert.match(milestoneNotifier, /detail\?\.accountingUnavailable === true\) return/);
});
