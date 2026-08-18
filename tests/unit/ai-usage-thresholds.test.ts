import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiUsageWarningThreshold } from "../../src/lib/ai-usage";

test("AI usage warnings resolve to the highest reached monthly milestone", () => {
  const cases = [
    [null, null],
    [0, null],
    [24.99, null],
    [25, 25],
    [49.99, 25],
    [50, 50],
    [74.99, 50],
    [75, 75],
    [84.99, 75],
    [85, 85],
    [94.99, 85],
    [95, 95],
    [99.99, 95],
    [100, 100],
    [140, 100],
  ] as const;

  for (const [percent, expected] of cases) {
    assert.equal(resolveAiUsageWarningThreshold(percent), expected, String(percent));
  }
});
