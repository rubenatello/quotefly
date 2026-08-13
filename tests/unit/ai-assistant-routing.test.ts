import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/quotefly_unit_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "unit-test-secret-that-is-long-enough-for-validation";

test("routes operational Kody prompts before broad customer and quote intents", async () => {
  const { resolveAssistantTool } = await import("../../src/lib/ai-assistant");
  assert.equal(resolveAssistantTool("Which customers need follow up today?"), "FOLLOW_UP_QUEUE");
  assert.equal(resolveAssistantTool("Which quotes haven't been followed up on?"), "FOLLOW_UP_QUEUE");
  assert.equal(resolveAssistantTool("Which customers do not have a quote?"), "CUSTOMERS_WITHOUT_QUOTES");
  assert.equal(resolveAssistantTool("If we close 30% of open quotes, what is the revenue boost?"), "PIPELINE_SCENARIO");
  assert.equal(resolveAssistantTool("If we sold 30 percent of open quotes, what would that realize?"), "PIPELINE_SCENARIO");
  assert.equal(resolveAssistantTool("Take me to products"), "NAVIGATE_WORKSPACE");
  assert.equal(resolveAssistantTool("Show me the most profitable products"), "RANK_PROFITABLE_JOBS");
  assert.equal(resolveAssistantTool("Show me customer named Ruben"), "SEARCH_CUSTOMERS");
  assert.equal(resolveAssistantTool("Open customer Ruben"), "SEARCH_CUSTOMERS");
  assert.equal(resolveAssistantTool("Open customers"), "NAVIGATE_WORKSPACE");
  assert.equal(resolveAssistantTool("Find customer Ruben"), "SEARCH_CUSTOMERS");
  assert.equal(resolveAssistantTool("Draft a roofing quote for Ruben"), "DRAFT_QUOTE");
});

test("deterministic operational tools do not consume the external AI budget", async () => {
  const { assistantToolConsumesAiBudget } = await import("../../src/lib/ai-assistant");
  for (const tool of [
    "NAVIGATE_WORKSPACE",
    "FOLLOW_UP_QUEUE",
    "CUSTOMERS_WITHOUT_QUOTES",
    "PIPELINE_SCENARIO",
  ] as const) {
    assert.equal(assistantToolConsumesAiBudget(tool), false);
  }
  assert.equal(assistantToolConsumesAiBudget("SEARCH_CUSTOMERS"), true);
  assert.equal(assistantToolConsumesAiBudget("DRAFT_QUOTE"), true);
});
