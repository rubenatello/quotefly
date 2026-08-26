import { strict as assert } from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/quotefly_unit_test";
process.env.JWT_SECRET ||= "test-jwt-secret-for-quotefly-unit-suite-min-32";
process.env.APP_URL ||= "http://localhost:5173";
process.env.API_URL ||= "http://localhost:4000";

test("quote AI fallback logs request-aware fixed diagnostics without prompt or provider exception data", async () => {
  const {
    aiParseChatToQuotePrompt,
    setAiQuoteChatCompletionForTest,
  } = await import("../../src/services/ai-quote");
  const rawPrompt = "Quote Secret Customer at secret@example.com for a roof repair";
  const providerSecret = "SENTINEL_PROVIDER_AUTHORIZATION_HEADER_AND_BODY";
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  setAiQuoteChatCompletionForTest(async () => {
    throw new Error(providerSecret);
  });

  try {
    const fallback = await aiParseChatToQuotePrompt(rawPrompt, {
      diagnosticContext: { requestId: "request-safe-quote-123" },
    });
    assert.equal(fallback.serviceType, "ROOFING");
  } finally {
    setAiQuoteChatCompletionForTest(null);
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"event":"ai_quote_fallback"/);
  assert.match(warnings[0], /"requestId":"request-safe-quote-123"/);
  assert.match(warnings[0], /"operation":"DRAFT_PARSE"/);
  assert.match(warnings[0], /"failureCode":"PROVIDER_OR_VALIDATION_FAILED"/);
  assert.doesNotMatch(warnings[0], /SENTINEL_PROVIDER|secret@example\.com|Secret Customer|Authorization/i);
});

test("quote revision provider input removes customer identity while preserving work facts", async () => {
  const {
    aiBuildQuoteRevisionPlan,
    setAiQuoteChatCompletionForTest,
  } = await import("../../src/services/ai-quote");
  let capturedRequest: { store?: boolean | null; messages: unknown[] } | null = null;
  setAiQuoteChatCompletionForTest(async (request) => {
    capturedRequest = request;
    return {
      id: "chatcmpl-revision-minimized",
      object: "chat.completion",
      created: 1,
      model: "test-revision-minimized",
      choices: [{
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: {
          role: "assistant",
          refusal: null,
          content: JSON.stringify({
            serviceType: "PLUMBING",
            title: null,
            scopeText: "Replace the failed pipe section.",
            summary: "Prepared the pipe repair revision.",
            reasons: ["Matched the requested repair."],
            sourceHints: [],
            lineOperations: [],
          }),
        },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    };
  });

  try {
    const plan = await aiBuildQuoteRevisionPlan(
      "Revise Acme, email acme.private@example.com, phone 555-808-9090, for a failed pipe repair.",
      {
        context: "Customer context:\n- Name: Acme\nCurrent scope: Failed pipe repair for acme.private@example.com.",
        sensitiveValues: ["Acme", "acme.private@example.com", "555-808-9090"],
      },
    );
    assert.equal(plan.serviceType, "PLUMBING");
  } finally {
    setAiQuoteChatCompletionForTest(null);
  }

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.store, false);
  const serialized = JSON.stringify(capturedRequest.messages);
  assert.match(serialized, /failed pipe repair/i);
  assert.doesNotMatch(serialized, /Acme|acme\.private@example\.com|555[- ]?808[- ]?9090/i);
});
