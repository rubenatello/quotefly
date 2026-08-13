import { strict as assert } from "node:assert";
import test from "node:test";
import type { AiAssistantResult } from "../../src/lib/ai-assistant";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://quotefly:quotefly@localhost:5432/quotefly_unit_test";
process.env.JWT_SECRET ||= "test-jwt-secret-for-quotefly-unit-suite-min-32";
process.env.APP_URL ||= "http://localhost:5173";
process.env.API_URL ||= "http://localhost:4000";

async function loadComposer() {
  return import("../../src/lib/ai-assistant-composer");
}

function baseAssistant(overrides?: Partial<AiAssistantResult>): AiAssistantResult {
  return {
    tool: "SEARCH_CUSTOMERS",
    generatedAtUtc: new Date("2026-08-12T12:00:00.000Z"),
    policyVersion: "2026-08-12",
    maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
    answer: "Found 1 active customer matching Ruben.",
    results: [{
      customerId: "cus_secret_123",
      tenantId: "tenant_secret_456",
      fullName: "Ruben Roofing",
      email: "ruben@example.com",
      phone: "555-111-2222",
      quoteRefHash: "abcdef",
      quoteCount: 2,
      latestQuoteTitle: "Roof repair",
    }],
    citations: [{
      key: "A1",
      label: "Active tenant customer lookup",
      sourceType: "Customer",
      classification: "C2_CUSTOMER_CONFIDENTIAL",
    }],
    actions: [{
      type: "OPEN_CUSTOMER",
      label: "Open Ruben Roofing",
      requiresConfirmation: false,
      payload: { customerId: "cus_secret_123" },
    }],
    auditEventId: "audit_secret_789",
    fieldsExcluded: ["tenant ids", "raw prompts"],
    diagnostics: {
      requestedTool: "SEARCH_CUSTOMERS",
      resolvedTool: "SEARCH_CUSTOMERS",
      resultCount: 1,
      citationCount: 1,
      emptyReason: null,
      archivePolicy: "Customer lookup searches active customers only.",
      filters: {
        includeArchivedRequested: false,
        includeArchivedEffective: false,
      },
    },
    ...overrides,
  };
}

test("assistant composition payload excludes raw ids and redacts prompt PII", async () => {
  const { buildAssistantCompositionPayload } = await loadComposer();
  const payload = buildAssistantCompositionPayload({
    message: "Find Ruben at ruben@example.com or 555-111-2222",
    assistant: baseAssistant(),
    sensitiveValues: ["Ruben Roofing"],
  });
  const serialized = JSON.stringify(payload);

  assert.match(serialized, /REDACTED_EMAIL/);
  assert.match(serialized, /REDACTED_PHONE/);
  assert.doesNotMatch(serialized, /cus_secret_123/);
  assert.doesNotMatch(serialized, /tenant_secret_456/);
  assert.doesNotMatch(serialized, /abcdef/);
  assert.doesNotMatch(serialized, /audit_secret_789/);
  assert.doesNotMatch(serialized, /ruben@example.com/);
  assert.doesNotMatch(serialized, /555-111-2222/);
  assert.match(serialized, /Roof repair/);
  assert.match(serialized, /quoteCount/);
});

test("assistant composition payload trims oversized result context", async () => {
  const { buildAssistantCompositionPayload } = await loadComposer();
  const rows = Array.from({ length: 50 }, (_, index) => ({
    title: `Large result row ${index}`,
    revenue: index * 100,
    grossProfit: index * 10,
    tenantId: `tenant-${index}`,
  }));

  const payload = buildAssistantCompositionPayload({
    message: "Rank profitable jobs.",
    assistant: baseAssistant({
      tool: "RANK_PROFITABLE_JOBS",
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
      results: rows,
      diagnostics: {
        ...baseAssistant().diagnostics,
        requestedTool: "RANK_PROFITABLE_JOBS",
        resolvedTool: "RANK_PROFITABLE_JOBS",
        resultCount: rows.length,
      },
    }),
  });

  assert.ok(payload.results.length <= 6);
  assert.doesNotMatch(JSON.stringify(payload), /tenant-1/);
});
