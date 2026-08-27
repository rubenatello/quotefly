import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AiQuoteSuggestion, QuotePreparationResult } from "../src/lib/api";
import { normalizeAiQuoteSuggestionResult } from "../src/lib/api";
import { applyQuotePreparationPricingGuard } from "../src/lib/quote-preparation";
import {
  formatQuotePricingReviewLineDescriptions,
  hasUnsupportedStructuralQuotePatch,
  isQuotePricingReviewBlocking,
  parseQuotePricingReviewState,
  resolveQuoteHandoffCustomerTotal,
  resolveQuotePreparationRetryIdentity,
} from "../src/lib/quote-preparation";

test("uses the tax-inclusive prepared total for the Kody quote handoff", () => {
  assert.equal(resolveQuoteHandoffCustomerTotal({
    customerPriceSubtotal: 875,
    totalAmount: 950,
  }, 900), 950);
  assert.equal(resolveQuoteHandoffCustomerTotal({
    customerPriceSubtotal: 875,
    totalAmount: null,
  }, 900), 875);
  assert.equal(resolveQuoteHandoffCustomerTotal({
    customerPriceSubtotal: 875,
  }, 900), 875);
  assert.equal(resolveQuoteHandoffCustomerTotal({}, 900), 900);
});

test("forces unresolved suggestion and patch prices to zero for every quote-preparation consumer", () => {
  const line = {
    description: "Inspection-dependent repair",
    sectionType: "INCLUDED" as const,
    sectionLabel: null,
    quantity: 1,
    unitPrice: 875,
    priceProvenance: "UNRESOLVED" as const,
  };
  const suggestion: AiQuoteSuggestion = {
    serviceType: "HVAC",
    title: "Inspection quote",
    scopeText: "Inspect and repair after approval.",
    customerPriceSubtotal: 875,
    taxAmount: 0,
    totalAmount: 875,
    requiresPricingReview: false,
    model: "test",
    lineItems: [line],
  };
  const preparation = {
    draft: { lineItems: [line], requiresPricingReview: true },
  } as unknown as QuotePreparationResult;
  const guarded = applyQuotePreparationPricingGuard({
    preparation,
    suggestion,
    patch: {
      lineChanges: [{
        action: "ADD",
        targetLineId: null,
        previousDescription: null,
        ...line,
        unitCost: 0,
        reason: "Requested work",
      }],
      added: 1,
      updated: 0,
      removed: 0,
    },
  });

  assert.equal(guarded.suggestion.lineItems[0]?.unitPrice, 0);
  assert.equal(guarded.patch.lineChanges[0]?.unitPrice, 0);
  assert.equal(guarded.suggestion.requiresPricingReview, true);
  assert.equal(guarded.pricingReviewLines.length, 1);
});

test("rejects unsupported structural Quote Desk patches while allowing update-only patches", () => {
  const update = {
    action: "UPDATE" as const,
    targetLineId: "line-1",
    previousDescription: "Old repair",
    description: "Updated repair",
    sectionType: "INCLUDED" as const,
    sectionLabel: null,
    quantity: 1,
    unitCost: 0,
    unitPrice: 250,
    reason: "Requested update",
  };
  assert.equal(hasUnsupportedStructuralQuotePatch({ lineChanges: [update], added: 0, updated: 1, removed: 0 }), false);
  assert.equal(hasUnsupportedStructuralQuotePatch({
    lineChanges: [{ ...update, action: "ADD", targetLineId: null, previousDescription: null }],
    added: 1,
    updated: 0,
    removed: 0,
  }), true);
  assert.equal(hasUnsupportedStructuralQuotePatch({
    lineChanges: [{ action: "REMOVE", targetLineId: "line-1", previousDescription: "Old repair", reason: "Requested removal" }],
    added: 0,
    updated: 0,
    removed: 1,
  }), true);
});

test("pricing review is quote-scoped, recoverable, and blocks until acknowledged", () => {
  const raw = { quoteId: "quote-1", lineDescriptions: ["Inspection repair"], acknowledged: false };
  const restored = parseQuotePricingReviewState(raw, "quote-1");
  assert.deepEqual(restored, raw);
  assert.equal(isQuotePricingReviewBlocking(restored, "quote-1"), true);
  assert.equal(isQuotePricingReviewBlocking(restored, "quote-2"), false);
  assert.equal(isQuotePricingReviewBlocking({ ...raw, acknowledged: true }, "quote-1"), false);
  assert.equal(parseQuotePricingReviewState(raw, "quote-2"), null);
});

test("cancelled preparation retry reuses its key only for unchanged input", () => {
  let sequence = 0;
  const createKey = () => `qf-ai-${++sequence}`;
  const first = resolveQuotePreparationRetryIdentity(null, "same", createKey);
  const retry = resolveQuotePreparationRetryIdentity(first, "same", createKey);
  const changed = resolveQuotePreparationRetryIdentity(first, "changed", createKey);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
});

test("pricing review copy renders a clean middle-dot separator", () => {
  const copy = formatQuotePricingReviewLineDescriptions(["Inspection", "Repair"]);
  assert.equal(copy, "Inspection · Repair");
  assert.equal(copy.includes("Â"), false);
});

test("Quote Desk rejects structural patches before any quote draft mutation", () => {
  const source = readFileSync(new URL("../src/views/QuoteDeskView.tsx", import.meta.url), "utf8");
  const guardIndex = source.indexOf("hasUnsupportedStructuralQuotePatch(reviewedPatch)");
  const firstMutationIndex = source.indexOf("setChatParsed(parsed)", guardIndex);
  assert.ok(guardIndex >= 0, "structural patch guard is present");
  assert.ok(firstMutationIndex > guardIndex, "the structural guard runs before quote state mutation");
});

const suggestionContractBase = {
  customer: null,
  parsed: {},
  aiRunId: "ai-run-1",
  usage: { estimatedPromptsRemaining: null },
};

function preparationContract(status: "READY" | "NEEDS_CLARIFICATION" | "CUSTOMER_AMBIGUOUS") {
  return {
    preparationId: "prep-1",
    status,
    customerResolution: status === "CUSTOMER_AMBIGUOUS" ? "AMBIGUOUS" : "NONE",
    customer: null,
    customerDraft: { fullName: null, email: null, phone: null },
    customerCandidates: [],
    clarification: status === "READY" ? null : { code: status === "CUSTOMER_AMBIGUOUS" ? "CUSTOMER_SELECTION_REQUIRED" : "WORK_REQUIRED", message: "Please clarify." },
    draft: {
      quoteId: null,
      serviceType: "PLUMBING",
      title: "Prepared quote",
      scopeText: "Review the work.",
      squareFeetEstimate: null,
      squareFeetEstimateLow: null,
      squareFeetEstimateHigh: null,
      estimatedDurationHoursLow: null,
      estimatedDurationHoursHigh: null,
      customerPriceSubtotal: 0,
      taxAmount: 0,
      totalAmount: 0,
      lineItems: [],
      workspaceContext: [{
        citationKey: " R1 ",
        label: " Prior quote ",
        sourceType: " Quote ",
        fact: " Previously approved copper lines. ",
        secret: "strip-me",
      }],
      requiresPricingReview: false,
    },
    sources: [],
    retrievedSourceCount: 0,
    retrievedSourceLabels: [],
    retrievalAuditEventId: null,
    retrievalDegraded: false,
    model: "deterministic",
  };
}

test("stream contract returns ready-only fields only for READY and normalizes workspace context", () => {
  const result = normalizeAiQuoteSuggestionResult({
    ...suggestionContractBase,
    preparation: preparationContract("READY"),
    suggestion: { serviceType: "PLUMBING", title: "Prepared quote", scopeText: "Review", customerPriceSubtotal: 0, taxAmount: 0, totalAmount: 0, model: "deterministic", lineItems: [] },
    patch: { lineChanges: [], added: 0, updated: 0, removed: 0 },
    insight: { summary: "Ready", reasons: [], sources: [], confidence: { level: "high", label: "High" }, patch: { added: 0, updated: 0, removed: 0 } },
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") assert.fail("READY result did not narrow");
  assert.equal(result.suggestion.title, "Prepared quote");
  assert.deepEqual(result.preparation.draft.workspaceContext, [{
    citationKey: "R1",
    label: "Prior quote",
    sourceType: "Quote",
    fact: "Previously approved copper lines.",
  }]);
});

test("stream contract omits ready-only fields for NEEDS_CLARIFICATION", () => {
  const result = normalizeAiQuoteSuggestionResult({
    ...suggestionContractBase,
    preparation: preparationContract("NEEDS_CLARIFICATION"),
    suggestion: { unsafe: true },
    patch: { unsafe: true },
    insight: { unsafe: true },
  });
  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal("suggestion" in result, false);
  assert.equal("patch" in result, false);
  assert.equal("insight" in result, false);
});

test("stream contract omits ready-only fields for CUSTOMER_AMBIGUOUS", () => {
  const result = normalizeAiQuoteSuggestionResult({
    ...suggestionContractBase,
    preparation: preparationContract("CUSTOMER_AMBIGUOUS"),
    suggestion: { unsafe: true },
  });
  assert.equal(result.status, "CUSTOMER_AMBIGUOUS");
  assert.equal(result.preparation.customerResolution, "AMBIGUOUS");
  assert.equal("suggestion" in result, false);
});

test("stream contract rejects READY responses missing ready-only fields", () => {
  assert.throws(
    () => normalizeAiQuoteSuggestionResult({
      ...suggestionContractBase,
      preparation: preparationContract("READY"),
    }),
    /contract was invalid/,
  );
});
