import assert from "node:assert/strict";
import test from "node:test";
import { productCatalogSource } from "../src/lib/product-catalog-display";

test("catalog source labels distinguish workspace copies from tenant-created items", () => {
  assert.equal(productCatalogSource({ catalogKey: "labor_hours", catalogCustomizedAtUtc: null }).label, "QuoteFly starter");
  assert.equal(productCatalogSource({ catalogKey: "labor_hours", catalogCustomizedAtUtc: "2026-08-20T00:00:00.000Z" }).label, "Customized starter");
  assert.equal(productCatalogSource({ catalogKey: null, catalogCustomizedAtUtc: null }).label, "Your item");
});
