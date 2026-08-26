import assert from "node:assert/strict";
import test from "node:test";
import {
  claimAiQuoteProviderTimeout,
  createAiQuoteProviderBudget,
} from "../../src/services/ai-quote-provider-budget";

test("AI quote provider budget caps a request at two bounded calls", () => {
  const budget = createAiQuoteProviderBudget({
    maxCalls: 2,
    operationTimeoutMs: 30_000,
    perCallTimeoutMs: 12_000,
  });

  const firstTimeout = claimAiQuoteProviderTimeout(budget);
  const secondTimeout = claimAiQuoteProviderTimeout(budget);

  assert.equal(budget.callsUsed, 2);
  assert.ok(firstTimeout >= 1_000 && firstTimeout <= 12_000);
  assert.ok(secondTimeout >= 1_000 && secondTimeout <= 12_000);
  assert.throws(
    () => claimAiQuoteProviderTimeout(budget),
    /provider budget exhausted/i,
  );
});

test("AI quote provider budget refuses a call after the shared deadline", () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const budget = createAiQuoteProviderBudget({
      maxCalls: 2,
      operationTimeoutMs: 1_000,
      perCallTimeoutMs: 12_000,
    });
    now = 10_500;
    assert.throws(
      () => claimAiQuoteProviderTimeout(budget),
      /provider budget exhausted/i,
    );
    assert.equal(budget.callsUsed, 0);
  } finally {
    Date.now = originalNow;
  }
});
