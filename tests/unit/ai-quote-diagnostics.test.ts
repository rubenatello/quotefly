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
