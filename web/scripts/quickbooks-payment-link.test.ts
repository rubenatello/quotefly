import { strict as assert } from "node:assert";
import test from "node:test";
import {
  isCurrentQuickBooksRequestContext,
  isQuickBooksPreviewCurrentForPublish,
  isValidQuickBooksBillingEmail,
  normalizeQuickBooksInvoiceReviewOptions,
  safeQuickBooksHostedPaymentUrl,
} from "../src/lib/quickbooks-payment-link";

test("QuickBooks hosted payment links allow only HTTPS Intuit and QuickBooks hosts", () => {
  assert.equal(
    safeQuickBooksHostedPaymentUrl("https://payments.intuit.com/invoice/abc"),
    "https://payments.intuit.com/invoice/abc",
  );
  assert.equal(
    safeQuickBooksHostedPaymentUrl("https://pay.quickbooks.com/invoice/abc"),
    "https://pay.quickbooks.com/invoice/abc",
  );
  assert.equal(safeQuickBooksHostedPaymentUrl("http://payments.intuit.com/invoice/abc"), null);
  assert.equal(safeQuickBooksHostedPaymentUrl("https://intuit.com.attacker.example/invoice/abc"), null);
  assert.equal(safeQuickBooksHostedPaymentUrl("https://user:password@payments.intuit.com/invoice/abc"), null);
  assert.equal(safeQuickBooksHostedPaymentUrl("not a URL"), null);
});

test("QuickBooks billing email validation is bounded and rejects malformed values", () => {
  assert.equal(isValidQuickBooksBillingEmail("billing@example.com"), true);
  assert.equal(isValidQuickBooksBillingEmail(" billing@example.com "), true);
  assert.equal(isValidQuickBooksBillingEmail("billing@example"), false);
  assert.equal(isValidQuickBooksBillingEmail("billing @example.com"), false);
  assert.equal(isValidQuickBooksBillingEmail(`${"a".repeat(310)}@example.com`), false);
});

test("QuickBooks review requests normalize blank email to an explicit offline-safe null", () => {
  assert.deepEqual(normalizeQuickBooksInvoiceReviewOptions({
    billingEmail: "   ",
    allowOnlineAchPayment: false,
    allowOnlineCardPayment: false,
  }), {
    billingEmail: null,
    allowOnlineAchPayment: false,
    allowOnlineCardPayment: false,
  });
  assert.deepEqual(normalizeQuickBooksInvoiceReviewOptions({
    billingEmail: " billing@example.com ",
    allowOnlineAchPayment: true,
    allowOnlineCardPayment: false,
  }), {
    billingEmail: "billing@example.com",
    allowOnlineAchPayment: true,
    allowOnlineCardPayment: false,
  });
});

test("delayed QuickBooks lookup and hosted-link responses cannot cross invoice context", () => {
  assert.equal(isCurrentQuickBooksRequestContext({
    requestedSource: "invoice-a",
    requestedGeneration: 4,
    currentSource: "invoice-b",
    currentGeneration: 5,
  }), false);
  assert.equal(isCurrentQuickBooksRequestContext({
    requestedSource: "invoice-b",
    requestedGeneration: 5,
    currentSource: "invoice-b",
    currentGeneration: 5,
    requestedInvoiceId: "invoice-b",
    responseInvoiceId: "invoice-a",
  }), false);
  assert.equal(isCurrentQuickBooksRequestContext({
    requestedSource: "invoice-b",
    requestedGeneration: 5,
    currentSource: "invoice-b",
    currentGeneration: 5,
    requestedInvoiceId: "invoice-b",
    responseInvoiceId: "invoice-b",
  }), true);
});

test("delayed QuickBooks mapping review cannot cross source, generation, invoice, or version context", () => {
  const currentReview = {
    requestedSource: "quote:a",
    requestedGeneration: 7,
    currentSource: "quote:a",
    currentGeneration: 7,
    requestedInvoiceId: "invoice-a",
    currentInvoiceId: "invoice-a",
    requestedInvoiceVersion: 3,
    currentInvoiceVersion: 3,
  };

  assert.equal(isCurrentQuickBooksRequestContext(currentReview), true);
  assert.equal(isCurrentQuickBooksRequestContext({ ...currentReview, currentSource: "quote:b" }), false);
  assert.equal(isCurrentQuickBooksRequestContext({ ...currentReview, currentGeneration: 8 }), false);
  assert.equal(isCurrentQuickBooksRequestContext({ ...currentReview, currentInvoiceId: "invoice-b" }), false);
  assert.equal(isCurrentQuickBooksRequestContext({ ...currentReview, currentInvoiceVersion: 4 }), false);
  assert.equal(isCurrentQuickBooksRequestContext({
    ...currentReview,
    responseInvoiceId: "invoice-b",
  }), false);
});

test("QuickBooks publish requires the reviewed preview to match the active invoice and version", () => {
  const currentReview = {
    activeInvoiceId: "invoice-b",
    activeInvoiceVersion: 5,
    previewInvoiceId: "invoice-b",
    previewInvoiceVersion: 5,
  };

  assert.equal(isQuickBooksPreviewCurrentForPublish(currentReview), true);
  assert.equal(isQuickBooksPreviewCurrentForPublish({ ...currentReview, previewInvoiceId: "invoice-a" }), false);
  assert.equal(isQuickBooksPreviewCurrentForPublish({ ...currentReview, previewInvoiceVersion: 4 }), false);
  assert.equal(isQuickBooksPreviewCurrentForPublish({ ...currentReview, activeInvoiceId: null }), false);
});
