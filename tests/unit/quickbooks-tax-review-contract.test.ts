import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createQuickBooksTaxReview, verifyQuickBooksTaxReview, QuickBooksTaxReviewError,
  type TaxReviewSource,
} from "../../src/services/quickbooks-tax-review-contract";

const key = "synthetic-tax-review-signing-key-for-tests-only";
const observed = "2026-09-23T12:00:00.000Z";
function fixture(): TaxReviewSource {
  return {
    contractVersion: 2, tenantId: "tenant-a", invoiceId: "invoice-a", invoiceVersion: 1,
    customerId: "customer-a", sourceQuoteId: "quote-a", jobId: "job-a", invoiceTaxContext: { id: "context-a", revision: 1, inputHash: "d".repeat(64), confirmedByTenantUserId: "manager-a", confirmedAtUtc: observed }, transactionDate: "2026-09-23", currency: "USD",
    subtotal: "300.00", quotedTax: "24.00", total: "324.00",
    connection: { id: "connection-a", realmId: "1234567890", connectedAtUtc: observed, generation: 1, environment: "sandbox" },
    customerMapping: { id: "customer-map-a", reviewVersion: 1, reviewedAtUtc: observed, providerId: "42" },
    customerFacts: { providerCustomerId: "42", providerSyncToken: "0", observedAtUtc: observed,
      exemption: "TAXABLE", exemptionReasonId: null, fingerprint: "e".repeat(64) },
    origin: { Line1: "123 Synthetic Origin", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" },
    destination: { Line1: "456 Synthetic Destination", Line2: "Suite 2", City: "Los Angeles",
      CountrySubDivisionCode: "CA", PostalCode: "90001-1234", Country: "US" },
    preferences: { observedAtUtc: observed, fingerprint: "a".repeat(64), companyInfoFingerprint: "b".repeat(64), companyObservedAtUtc: observed,
      capabilities: { companyPrerequisitesReady: true, automatedTaxCalculationProven: false, usCompany: true,
        companyAddressComplete: true, salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true,
        progressInvoicingEnabled: false, reasons: [] } },
    lines: [
      { invoiceLineItemId: "line-a", position: 0, description: "Synthetic materials", quantity: "2.00", unitPrice: "100.00", amount: "200.00",
        taxIntent: "TAXABLE", itemMapping: { id: "item-map-a", reviewVersion: 1, reviewedAtUtc: observed, providerId: "51" },
        itemFacts: { providerItemId: "51", providerSyncToken: "0", observedAtUtc: observed, taxClassificationFingerprint: "c".repeat(64) } },
      { invoiceLineItemId: "line-b", position: 1, description: "Synthetic labor", quantity: "1.00", unitPrice: "100.00", amount: "100.00",
        taxIntent: "NON_TAXABLE", itemMapping: { id: "item-map-b", reviewVersion: 1, reviewedAtUtc: observed, providerId: "52" },
        itemFacts: { providerItemId: "52", providerSyncToken: "1", observedAtUtc: observed, taxClassificationFingerprint: "d".repeat(64) } },
    ],
  };
}

function setPath(source: unknown, path: string, value: unknown) {
  const parts = path.split(".");
  let target = source as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  return value;
}

it("binds canonical input independently of object key order and harmless outer whitespace", () => {
  const source = fixture();
  const review = createQuickBooksTaxReview(source, key);
  assert.equal(createQuickBooksTaxReview(reversedKeys(source), key).binding, review.binding);
  source.destination.Line1 = ` ${source.destination.Line1} `;
  source.subtotal = "300";
  assert.equal(createQuickBooksTaxReview(source, key).binding, review.binding);
  assert.equal(verifyQuickBooksTaxReview(source, key, review.binding), true);
  assert.equal(review.assessment.providerPrerequisitesReady, true);
  assert.equal(review.assessment.reviewSourceReady, true);
  assert.equal(review.assessment.taxCalculationProven, false);
  assert.equal(review.assessment.estimateInvoiceParityProven, false);
  assert.equal(review.assessment.publishingAuthorized, false);
});

it("invalidates the review for material identity, provider fact, mapping, address and content changes", async (t) => {
  const baseline = createQuickBooksTaxReview(fixture(), key);
  const changes: Array<[string, unknown]> = [
    ["jobId", "job-b"], ["invoiceTaxContext.id", "context-b"], ["invoiceTaxContext.revision", 2],
    ["invoiceTaxContext.inputHash", "f".repeat(64)], ["invoiceTaxContext.confirmedByTenantUserId", "manager-b"],
    ["invoiceTaxContext.confirmedAtUtc", "2026-09-23T13:00:00.000Z"], ["connection.generation", 2],
    ["customerFacts.fingerprint", "f".repeat(64)], ["preferences.companyObservedAtUtc", "2026-09-23T13:00:00.000Z"],
    ["tenantId", "tenant-b"], ["invoiceId", "invoice-b"], ["invoiceVersion", 2], ["customerId", "customer-b"],
    ["sourceQuoteId", "quote-b"], ["transactionDate", "2026-09-24"], ["connection.id", "connection-b"],
    ["connection.realmId", "9876543210"], ["connection.connectedAtUtc", "2026-09-23T13:00:00.000Z"],
    ["connection.environment", "production"], ["customerMapping.id", "customer-map-b"], ["customerMapping.reviewVersion", 2],
    ["customerMapping.reviewedAtUtc", "2026-09-23T13:00:00.000Z"], ["customerMapping.providerId", "99"],
    ["customerFacts.providerCustomerId", "99"], ["customerFacts.providerSyncToken", "2"],
    ["customerFacts.observedAtUtc", "2026-09-23T13:00:00.000Z"], ["customerFacts.exemption", "UNKNOWN"],
    ["customerFacts.exemptionReasonId", "reason-1"],
    ["origin.Line1", "789 Synthetic Origin"], ["origin.City", "Oakland"], ["origin.CountrySubDivisionCode", "NY"],
    ["origin.PostalCode", "10001"], ["destination.Line1", "789 Synthetic Destination"], ["destination.Line2", "Suite 3"],
    ["destination.City", "Oakland"], ["destination.CountrySubDivisionCode", "NY"], ["destination.PostalCode", "10001"],
    ["preferences.fingerprint", "e".repeat(64)], ["preferences.companyInfoFingerprint", "e".repeat(64)],
    ["preferences.observedAtUtc", "2026-09-23T13:00:00.000Z"],
    ["lines.0.invoiceLineItemId", "line-c"], ["lines.0.description", "Changed synthetic materials"],
    ["lines.0.taxIntent", "NON_TAXABLE"], ["lines.0.itemMapping.id", "item-map-c"],
    ["lines.0.itemMapping.reviewVersion", 2], ["lines.0.itemMapping.reviewedAtUtc", "2026-09-23T13:00:00.000Z"],
    ["lines.0.itemMapping.providerId", "99"], ["lines.0.itemFacts.providerItemId", "99"],
    ["lines.0.itemFacts.providerSyncToken", "3"], ["lines.0.itemFacts.observedAtUtc", "2026-09-23T13:00:00.000Z"],
    ["lines.0.itemFacts.taxClassificationFingerprint", "e".repeat(64)],
    ...["companyPrerequisitesReady", "usCompany", "companyAddressComplete", "salesTaxEnabled", "estimatesEnabled", "usdHomeCurrency"]
      .map((field): [string, unknown] => [`preferences.capabilities.${field}`, false]),
    ["preferences.capabilities.progressInvoicingEnabled", true],
    ["preferences.capabilities.reasons", ["SALES_TAX_NOT_ENABLED"]],
  ];
  for (const [path, value] of changes) await t.test(path, () => {
    const changed = fixture(); setPath(changed, path, value);
    assert.equal(verifyQuickBooksTaxReview(changed, key, baseline.binding), false);
  });
  const changedTax = fixture(); changedTax.quotedTax = "25.00"; changedTax.total = "325.00";
  assert.notEqual(createQuickBooksTaxReview(changedTax, key).binding, baseline.binding);
  const changedLine = fixture(); changedLine.lines[0].unitPrice = "101.00"; changedLine.lines[0].amount = "202.00";
  changedLine.subtotal = "302.00"; changedLine.total = "326.00";
  assert.notEqual(createQuickBooksTaxReview(changedLine, key).binding, baseline.binding);
  const reordered = fixture(); reordered.lines.reverse(); reordered.lines.forEach((line, index) => { line.position = index; });
  assert.notEqual(createQuickBooksTaxReview(reordered, key).binding, baseline.binding);
});

it("rejects incomplete, foreign or unsupported addresses and impossible dates", () => {
  for (const [path, value] of [
    ["destination.Country", undefined], ["destination.Country", "CA"], ["destination.CountrySubDivisionCode", "ZZ"],
    ["destination.CountrySubDivisionCode", "AA"], ["destination.CountrySubDivisionCode", "PR"],
    ["origin.Line1", ""], ["destination.Line1", "secret\naddress"], ["destination.City", "city\u200b"],
    ["destination.PostalCode", "9000"], ["transactionDate", "2026-02-29"], ["transactionDate", "2026-04-31"],
  ] as Array<[string, unknown]>) {
    const source = fixture(); setPath(source, path, value);
    assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_INPUT_INVALID" });
  }
  const leap = fixture(); leap.transactionDate = "2028-02-29";
  assert.doesNotThrow(() => createQuickBooksTaxReview(leap, key));
});

it("uses exact bounded decimals and refuses inconsistent money or quantity calculations", () => {
  for (const value of ["-1", "NaN", "Infinity", "1e2", "1.001", "100000000.00", "01.00", 100, null]) {
    const source = fixture(); setPath(source, "lines.0.amount", value);
    assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_INPUT_INVALID" });
  }
  for (const path of ["subtotal", "quotedTax", "total"]) {
    const source = fixture(); setPath(source, path, "1.00");
    assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_TOTALS_INVALID" });
  }
  const quantity = fixture(); quantity.lines[0].quantity = "1.99";
  assert.throws(() => createQuickBooksTaxReview(quantity, key), { code: "TAX_REVIEW_LINES_INVALID" });
  const halfCent = fixture(); halfCent.lines = [{ ...halfCent.lines[0], quantity: "0.50", unitPrice: "0.01", amount: "0.01" }];
  halfCent.subtotal = "0.01"; halfCent.quotedTax = "0.00"; halfCent.total = "0.01";
  assert.equal(createQuickBooksTaxReview(halfCent, key).estimateAst.Line[0].Amount, 0.01);
});

it("requires reviewed mappings, explicit tax intent and a unique ordered set of lines", () => {
  for (const [path, value] of [
    ["lines", []], ["lines.0.taxIntent", undefined], ["lines.0.taxIntent", "UNKNOWN"],
    ["lines.0.itemMapping", undefined], ["lines.0.itemMapping.reviewVersion", 0],
    ["customerMapping.reviewedAtUtc", undefined], ["lines.0.itemFacts.providerSyncToken", undefined],
  ] as Array<[string, unknown]>) {
    const source = fixture(); setPath(source, path, value);
    assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_INPUT_INVALID" });
  }
  for (const [path, value] of [["lines.1.invoiceLineItemId", "line-a"], ["lines.1.position", 0], ["lines.0.itemFacts.providerItemId", "99"]] as Array<[string, unknown]>) {
    const source = fixture(); setPath(source, path, value);
    assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_LINES_INVALID" });
  }
});

it("builds explicit TAX/NON and both addresses without overriding provider-calculated tax", () => {
  const review = createQuickBooksTaxReview(fixture(), key);
  assert.deepEqual(review.estimateAst.Line.map((line) => line.SalesItemLineDetail.TaxCodeRef.value), ["TAX", "NON"]);
  assert.notEqual(review.estimateAst.ShipFromAddr.Line1, review.estimateAst.ShipAddr.Line1);
  assert.equal(review.estimateAst.CustomerRef.value, "42");
  const serialized = JSON.stringify(review.estimateAst);
  for (const field of ["TxnTaxDetail", "TotalTax", "TotalAmt", "GlobalTaxCalculation", "TaxRate", "unitCost", "internalCost", "margin", "quotedTax"]) {
    assert.equal(serialized.includes(field), false);
  }
  const injected = fixture(); setPath(injected, "lines.0.unitCost", "1.00");
  assert.throws(() => createQuickBooksTaxReview(injected, key), { code: "TAX_REVIEW_INPUT_INVALID" });
});

it("never equates prerequisites, exemptions, zero tax or source readiness with permission to publish", () => {
  for (const exemption of ["EXEMPT", "UNKNOWN"] as const) {
    const source = fixture(); source.customerFacts.exemption = exemption;
    if (exemption === "EXEMPT") source.customerFacts.exemptionReasonId = "synthetic-exemption";
    const review = createQuickBooksTaxReview(source, key);
    assert.equal(review.assessment.reviewSourceReady, false);
    assert.ok(review.assessment.blockers.includes("CUSTOMER_TAX_STATUS_UNSUPPORTED"));
    assert.equal(review.assessment.publishingAuthorized, false);
  }
  const source = fixture(); source.preferences.capabilities.salesTaxEnabled = false;
  assert.equal(createQuickBooksTaxReview(source, key).assessment.providerPrerequisitesReady, false);
  source.lines[0].taxIntent = "NON_TAXABLE";
  assert.ok(createQuickBooksTaxReview(source, key).assessment.blockers.includes("TAXABLE_LINE_REQUIRED"));
  setPath(source, "preferences.capabilities.automatedTaxCalculationProven", true);
  assert.throws(() => createQuickBooksTaxReview(source, key), { code: "TAX_REVIEW_INPUT_INVALID" });
});

it("returns fixed diagnostics and verifies only well-formed bindings under the correct key", () => {
  const source = fixture(); const review = createQuickBooksTaxReview(source, key);
  for (const binding of [null, undefined, "", "a".repeat(63), "a".repeat(65), "x".repeat(64), "A".repeat(64)]) {
    assert.equal(verifyQuickBooksTaxReview(source, key, binding), false);
  }
  assert.equal(verifyQuickBooksTaxReview(source, `${key}-other`, review.binding), false);
  assert.equal(verifyQuickBooksTaxReview(source, "short", review.binding), false);
  assert.throws(() => createQuickBooksTaxReview(source, "short"), { code: "TAX_REVIEW_KEY_INVALID" });
  const sensitive = "Sensitive-address-to-omit\n"; source.origin.Line1 = sensitive;
  try { createQuickBooksTaxReview(source, key); assert.fail("Expected fixed failure"); }
  catch (error) {
    assert.ok(error instanceof QuickBooksTaxReviewError);
    assert.equal(error.message, "TAX_REVIEW_INPUT_INVALID");
    assert.equal(JSON.stringify(error).includes(sensitive), false);
  }
  for (const privateValue of ["tenant-a", "1234567890", "Synthetic", "94105", key]) {
    assert.equal(JSON.stringify(review.assessment).includes(privateValue), false);
  }
});

it("freezes source and payload so accidental post-review mutation cannot change reviewed data", () => {
  const input = fixture(); const review = createQuickBooksTaxReview(input, key);
  input.destination.Line1 = "Changed caller-owned input";
  assert.equal(review.source.destination.Line1, "456 Synthetic Destination");
  assert.ok(Object.isFrozen(review.estimateAst.Line[0].SalesItemLineDetail));
  assert.equal(Reflect.set(review.estimateAst.Line[0], "Amount", 900), false);
  assert.equal(Reflect.set(review.source.destination, "Line1", "Changed output"), false);
  assert.equal(review.estimateAst.Line[0].Amount, 200);
  assert.equal(review.source.destination.Line1, "456 Synthetic Destination");
});
