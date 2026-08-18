import assert from "node:assert/strict";
import test from "node:test";
import {
  aiUsageProgressTone,
  aiUsageWarningCopy,
  formatAiUsageNotice,
  resolveAiUsageWarningThreshold,
} from "../src/lib/ai-credits";

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

  assert.match(notice, /50% used this month/i);
  assert.doesNotMatch(notice, /prompt/i);
  assert.match(aiUsageWarningCopy(100, "2026-09-01T00:00:00.000Z").description, /paused/i);
});
