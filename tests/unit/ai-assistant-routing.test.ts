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
  assert.equal(
    resolveAssistantTool(
      "I need to add a new product/service as 'Labor Hours' for quotes, the cost internally is $30.00 and customer price is $75.00",
      "SEARCH_CUSTOMERS",
      { currentPage: "customers", customerId: "stale-customer" },
    ),
    "DRAFT_PRODUCT",
  );
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
    "DRAFT_PRODUCT",
  ] as const) {
    assert.equal(assistantToolConsumesAiBudget(tool), false);
  }
  assert.equal(assistantToolConsumesAiBudget("SEARCH_CUSTOMERS"), true);
  assert.equal(assistantToolConsumesAiBudget("DRAFT_QUOTE"), true);
});

test("bounded conversation hints route genuine follow-ups but never override explicit intent", async () => {
  const { resolveAssistantConversationState, resolveAssistantTool } = await import("../../src/lib/ai-assistant");
  const conversation = [{
    message: "Summarize my sales pipeline for the last 90 days.",
    resolvedTool: "SUMMARIZE_PIPELINE" as const,
  }];

  assert.equal(
    resolveAssistantTool("What about last month?", "AUTO", { currentPage: "quotes" }, conversation),
    "SUMMARIZE_PIPELINE",
  );
  assert.equal(
    resolveAssistantTool("Find customer Smith", "AUTO", { currentPage: "analytics" }, conversation),
    "SEARCH_CUSTOMERS",
  );
  assert.deepEqual(resolveAssistantConversationState(conversation, "SUMMARIZE_PIPELINE"), {
    mode: "CONTINUING",
    acknowledgement: null,
    previousTool: "SUMMARIZE_PIPELINE",
    currentTool: "SUMMARIZE_PIPELINE",
  });
  assert.deepEqual(resolveAssistantConversationState(conversation, "DRAFT_PRODUCT"), {
    mode: "SHIFTED",
    acknowledgement: "Got it — we're switching from business insights to setting up a product or service. I'll use your latest request.",
    previousTool: "SUMMARIZE_PIPELINE",
    currentTool: "DRAFT_PRODUCT",
  });
});

test("relative business-insight dates are deterministic and bounded", async () => {
  const { inferAssistantRelativeDateRange } = await import("../../src/lib/ai-assistant");
  const now = new Date("2026-08-13T12:00:00.000Z");

  assert.deepEqual(inferAssistantRelativeDateRange("Show the last 90 days", now), {
    from: new Date("2026-05-15T12:00:00.000Z"),
    to: now,
  });
  assert.equal(inferAssistantRelativeDateRange("Show the last 999 days", now), null);
  assert.equal(inferAssistantRelativeDateRange("Show recent work", now), null);
});

test("assistant request conversation is strict and hard-bounded", async () => {
  const { AssistantRequestSchema } = await import("../../src/lib/ai-assistant-request");
  const turn = { message: "What about last month?", resolvedTool: "SUMMARIZE_PIPELINE" };

  assert.equal(AssistantRequestSchema.safeParse({ message: "And this month?", conversation: [turn] }).success, true);
  assert.equal(AssistantRequestSchema.safeParse({ message: "And this month?", conversation: Array(5).fill(turn) }).success, false);
  assert.equal(AssistantRequestSchema.safeParse({
    message: "And this month?",
    conversation: [{ ...turn, tenantId: "forged-tenant" }],
  }).success, false);
});
