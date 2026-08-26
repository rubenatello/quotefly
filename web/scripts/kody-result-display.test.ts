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
