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
  assert.equal(response.conversation.mode, "NEW");
});

test("normalizes invalid Kody response to a safe non-crashing fallback", () => {
  const response = normalizeKodyAssistantResponse(undefined);

  assert.equal(response.tool, "OUT_OF_SCOPE");
  assert.equal(response.maxClassification, "C1_BUSINESS_INTERNAL");
  assert.equal(response.results.length, 0);
  assert.equal(response.citations.length, 0);
  assert.equal(response.actions.length, 0);
  assert.equal(response.diagnostics.answerMode, "DETERMINISTIC");
  assert.equal(response.diagnostics.model, null);
  assert.equal(response.auditEventId, "audit-unavailable");
  assert.equal(response.conversation.mode, "NEW");
});

test("accepts only a typed workspace navigation action", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "NAVIGATE_WORKSPACE",
    answer: "I can take you to Products.",
    actions: [{
      type: "OPEN_WORKSPACE_PAGE",
      label: "Open Products",
      requiresConfirmation: false,
      payload: { page: "products" },
    }, {
      type: "OPEN_ARBITRARY_URL",
      label: "Unsafe action",
      requiresConfirmation: false,
      payload: { url: "https://example.com" },
    }],
    diagnostics: { resolvedTool: "NAVIGATE_WORKSPACE" },
  });

  assert.equal(response.tool, "NAVIGATE_WORKSPACE");
  assert.equal(response.actions.length, 1);
  assert.equal(response.actions[0].type, "OPEN_WORKSPACE_PAGE");
  assert.deepEqual(response.actions[0].payload, { page: "products" });
});

test("preserves only the typed rolling schedule handoff range", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "LIST_SCHEDULE",
    answer: "Here is the next seven days.",
    actions: [{
      type: "OPEN_SCHEDULE",
      label: "Open schedule",
      requiresConfirmation: false,
      payload: {
        range: "next7",
        date: "2026-08-29",
        mine: true,
        serviceAddress: "must not travel through the handoff",
      },
    }, {
      type: "OPEN_SCHEDULE",
      label: "Invalid range",
      requiresConfirmation: false,
      payload: { range: "arbitrary", date: "2026-08-29", mine: true },
    }],
    diagnostics: { resolvedTool: "LIST_SCHEDULE" },
  });

  assert.equal(response.actions.length, 2);
  assert.deepEqual(response.actions[0]?.payload, { range: "next7", date: "2026-08-29", mine: true });
  assert.deepEqual(response.actions[1]?.payload, { date: "2026-08-29", mine: true });
});

test("accepts a review-only product draft action", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "DRAFT_PRODUCT",
    answer: "I prepared Labor Hours for review.",
    actions: [{
      type: "OPEN_PRODUCT_DRAFT",
      label: "Review product draft",
      requiresConfirmation: true,
      payload: { name: "Labor Hours", unitType: "HOUR", unitCost: 30, unitPrice: 75 },
    }],
    diagnostics: { resolvedTool: "DRAFT_PRODUCT" },
  });

  assert.equal(response.tool, "DRAFT_PRODUCT");
  assert.equal(response.actions.length, 1);
  assert.equal(response.actions[0].type, "OPEN_PRODUCT_DRAFT");
  assert.equal(response.actions[0].requiresConfirmation, true);
});

test("preserves bounded catalog pricing and provenance in a quote draft handoff", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "DRAFT_QUOTE",
    answer: "Prepared a priced review draft.",
    actions: [{
      type: "OPEN_QUOTE_DRAFT",
      label: "Draft for Maria Lopez (match 1)",
      requiresConfirmation: true,
      payload: {
        serviceType: "PLUMBING",
        estimatedDurationHoursLow: 3,
        estimatedDurationHoursHigh: 4,
        lineItems: [{
          description: "Plumbing labor hours",
          quantity: 4,
          sectionType: "INCLUDED",
          sourcePresetId: "preset-labor",
          unitType: "HOUR",
          unitPrice: 95,
          unitCost: 42,
          catalogMatched: true,
          tenantId: "must-not-travel",
        }],
      },
    }],
  });

  assert.deepEqual(response.actions[0]?.payload, {
    serviceType: "PLUMBING",
    estimatedDurationHoursLow: 3,
    estimatedDurationHoursHigh: 4,
    lineItems: [{
      description: "Plumbing labor hours",
      quantity: 4,
      sectionType: "INCLUDED",
      sourcePresetId: "preset-labor",
      unitType: "HOUR",
      unitPrice: 95,
      unitCost: 42,
      catalogMatched: true,
    }],
    retrievedSourceLabels: [],
  });
});

test("accepts only typed review handoffs for customer creation and quote sending", () => {
  const customer = normalizeKodyAssistantResponse({
    tool: "DRAFT_CUSTOMER",
    answer: "I prepared Maria Lopez for review.",
    actions: [{
      type: "OPEN_CUSTOMER_DRAFT",
      label: "Review customer",
      requiresConfirmation: false,
      payload: { fullName: "Maria Lopez", phone: "5554443333", email: "maria@example.com" },
    }],
  });
  const send = normalizeKodyAssistantResponse({
    tool: "PREPARE_QUOTE_SEND",
    answer: "I found the saved quote. You can review the send message next.",
    actions: [{
      type: "OPEN_QUOTE_SEND",
      label: "Review send",
      requiresConfirmation: false,
      payload: { quoteId: "quote-1", channel: "email" },
    }],
  });

  assert.equal(customer.actions[0]?.type, "OPEN_CUSTOMER_DRAFT");
  assert.equal(customer.actions[0]?.requiresConfirmation, true);
  assert.equal(send.actions[0]?.type, "OPEN_QUOTE_SEND");
  assert.equal(send.actions[0]?.requiresConfirmation, true);
});

test("normalizes only a typed server-authored context shift acknowledgement", () => {
  const response = normalizeKodyAssistantResponse({
    tool: "DRAFT_PRODUCT",
    answer: "I prepared the product details.",
    conversation: {
      mode: "SHIFTED",
      acknowledgement: "Got it — we're switching to setting up a product or service.",
      previousTool: "SEARCH_CUSTOMERS",
      currentTool: "DRAFT_PRODUCT",
    },
    diagnostics: { resolvedTool: "DRAFT_PRODUCT" },
  });

  assert.equal(response.conversation.mode, "SHIFTED");
  assert.equal(response.conversation.previousTool, "SEARCH_CUSTOMERS");
  assert.equal(response.conversation.currentTool, "DRAFT_PRODUCT");
  assert.match(response.conversation.acknowledgement ?? "", /switching/);
});
