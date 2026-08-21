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
