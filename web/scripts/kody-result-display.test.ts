import assert from "node:assert/strict";
import test from "node:test";
import { visibleKodyResultEntries } from "../src/components/ai/kody-result-display";

test("Kody product cards prioritize customer price and authorized internal cost", () => {
  const ownerEntries = visibleKodyResultEntries({
    productId: "hidden-product-id",
    name: "Labor Hours",
    description: "Approved labor",
    serviceType: "CONSTRUCTION",
    category: "LABOR",
    unitType: "HOUR",
    defaultQuantity: 1,
    unitPrice: 75,
    unitCost: 30,
  });
  assert.deepEqual(ownerEntries.slice(0, 2), [["unitPrice", 75], ["unitCost", 30]]);
  assert.equal(ownerEntries.some(([key]) => key === "productId" || key === "name"), false);

  const memberEntries = visibleKodyResultEntries({
    productId: "hidden-product-id",
    name: "Labor Hours",
    unitPrice: 75,
    serviceType: "CONSTRUCTION",
    category: "LABOR",
    unitType: "HOUR",
  });
  assert.equal(memberEntries[0]?.[0], "unitPrice");
  assert.equal(memberEntries.some(([key]) => key === "unitCost"), false);
});

test("Kody hides opaque identifiers without hiding ordinary words ending in id", () => {
  assert.deepEqual(visibleKodyResultEntries({
    quoteId: "hidden",
    paid: true,
    status: "SENT_TO_CUSTOMER",
  }), [["paid", true], ["status", "SENT_TO_CUSTOMER"]]);
});

test("Kody invoice cards retain the authorized monetary facts before secondary context", () => {
  const entries = visibleKodyResultEntries({
    invoiceId: "hidden-invoice-id",
    invoiceNumber: 42,
    status: "OPEN",
    paymentStatus: "PENDING",
    title: "Roof repair",
    customerName: "Example Customer",
    jobId: "hidden-job-id",
    jobNumber: 7,
    totalAmount: 1_250,
    amountPaid: 250,
    balanceDue: 1_000,
  });

  assert.deepEqual(entries.map(([key]) => key), [
    "invoiceNumber",
    "status",
    "paymentStatus",
    "totalAmount",
    "amountPaid",
    "balanceDue",
    "customerName",
    "jobNumber",
  ]);
  assert.equal(entries.some(([key]) => key === "invoiceId" || key === "jobId" || key === "title"), false);
});

test("Kody follow-up cards show the reason and next action without rendering internal rank metadata", () => {
  const entries = visibleKodyResultEntries({
    followUpType: "SENT_QUOTE",
    quoteId: "hidden-quote-id",
    quoteTitle: "Dining table build",
    attentionReason: "TASK_OVERDUE",
    recommendedAction: "Complete overdue task: Call customer",
    openFollowUpTaskTitle: "Call customer",
    openFollowUpTaskDueAtUtc: "2026-08-27T16:00:00.000Z",
    lastRecordedFollowUpAtUtc: null,
    hasFollowUpNotes: true,
    quoteAmount: 3500,
    attentionRank: 0,
  });

  assert.deepEqual(entries.map(([key]) => key), [
    "quoteTitle",
    "attentionReason",
    "recommendedAction",
    "openFollowUpTaskTitle",
    "openFollowUpTaskDueAtUtc",
    "hasFollowUpNotes",
    "quoteAmount",
  ]);
  assert.equal(entries.some(([key]) => key === "quoteId" || key === "attentionRank"), false);
});

test("Kody scheduled follow-up cards prioritize due evidence and omit null quote fields", () => {
  const entries = visibleKodyResultEntries({
    followUpType: "SCHEDULED_CUSTOMER",
    quoteTitle: null,
    quoteStatus: null,
    attentionReason: "DUE_TODAY",
    dueSinceUtc: "2026-08-28T16:00:00.000Z",
    dueBucket: "TODAY",
    priority: "URGENT",
    followUpStepNumber: 2,
    neverAttempted: true,
    notSuccessfullyContacted: true,
  });

  assert.deepEqual(entries.map(([key]) => key), [
    "attentionReason",
    "dueSinceUtc",
    "dueBucket",
    "priority",
    "followUpStepNumber",
    "neverAttempted",
    "notSuccessfullyContacted",
  ]);
});

test("Kody customer cards prioritize structured loss context over secondary quote data", () => {
  const entries = visibleKodyResultEntries({
    customerId: "hidden-customer-id",
    fullName: "Lost Customer",
    email: "lost@example.com",
    phone: "555-555-1212",
    followUpStatus: "LOST",
    lostReason: "PRICE",
    lostReasonNotes: "Selected a competitor.",
    lostAtUtc: "2026-08-28T16:00:00.000Z",
    lostByName: "Workspace Owner",
    quoteCount: 3,
    latestQuoteTitle: "Kitchen remodel",
  });

  assert.deepEqual(entries.map(([key]) => key), [
    "fullName",
    "followUpStatus",
    "lostReason",
    "lostReasonNotes",
    "lostAtUtc",
    "lostByName",
    "email",
    "phone",
  ]);
  assert.equal(entries.some(([key]) => key === "customerId"), false);
});
