import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKodyAssistantResponse } from "../src/components/ai/kody-response-normalization";

test("normalizes version-skewed Kody response without diagnostics", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "SEARCH_CUSTOMERS",
    generatedAtUtc: "2026-08-12T18:00:00.000Z",
    policyVersion: "2026-08-12",
    maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
    answer: "Found Ruben in this workspace.",
    results: [{ customerId: "customer-1", fullName: "Ruben", nested: { ignored: true } }],
    citations: [{
      key: "A1",
      label: "Active tenant customer lookup",
      sourceType: "Customer",
      classification: "C2_CUSTOMER_CONFIDENTIAL",
    }],
    actions: [{
      type: "OPEN_CUSTOMER",
      label: "Open Ruben",
      requiresConfirmation: false,
      payload: { customerId: "customer-1" },
    }],
    auditEventId: "audit-kody-production",
    fieldsExcluded: ["tenantId"],
  });

  assert.equal(response.diagnostics.answerMode, "DETERMINISTIC");
  assert.equal(response.diagnostics.resolvedTool, "SEARCH_CUSTOMERS");
  assert.equal(response.diagnostics.resultCount, 1);
  assert.equal(response.diagnostics.citationCount, 1);
  assert.equal(response.results[0].fullName, "Ruben");
  assert.equal("nested" in response.results[0], false);
  assert.equal(response.actions[0].type, "OPEN_CUSTOMER");
  assert.equal(response.maxClassification, "C2_CUSTOMER_CONFIDENTIAL");
});

test("normalizes invalid Kody response to a safe non-crashing fallback", () => {
  const response = normalizeKodyAssistantResponse(undefined);

  assert.equal(response.tool, "DRAFT_QUOTE");
  assert.equal(response.maxClassification, "C1_BUSINESS_INTERNAL");
  assert.equal(response.results.length, 0);
  assert.equal(response.citations.length, 0);
  assert.equal(response.actions.length, 0);
  assert.equal(response.diagnostics.answerMode, "DETERMINISTIC");
  assert.equal(response.diagnostics.model, null);
  assert.equal(response.auditEventId, "audit-unavailable");
});
