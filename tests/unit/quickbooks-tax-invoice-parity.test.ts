import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { evaluateQuickBooksTaxInvoiceParity } from "../../src/services/quickbooks-tax-invoice-parity";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const observed = "2026-10-03T12:00:00.000Z";
const address = (line: string) => ({ Line1: line, City: "Austin", CountrySubDivisionCode: "TX", PostalCode: "78701", Country: "US" });

function fixture() {
  const estimateAst = {
    CustomerRef: { value: "customer-1" }, TxnDate: "2026-10-03", CurrencyRef: { value: "USD" as const },
    ShipFromAddr: address("100 Origin Ave"), ShipAddr: address("200 Jobsite Rd"),
    Line: [
      { Description: "Taxable labor", DetailType: "SalesItemLineDetail" as const, Amount: 100,
        SalesItemLineDetail: { ItemRef: { value: "item-1" }, Qty: 2, UnitPrice: 50, TaxCodeRef: { value: "TAX" as const } } },
      { Description: "Non-taxable permit", DetailType: "SalesItemLineDetail" as const, Amount: 50,
        SalesItemLineDetail: { ItemRef: { value: "item-2" }, Qty: 1, UnitPrice: 50, TaxCodeRef: { value: "NON" as const } } },
    ],
  };
  const sourceSnapshot = {
    contractVersion: 2 as const, tenantId: "tenant-1", invoiceId: "invoice-1", invoiceVersion: 3,
    customerId: "local-customer", sourceQuoteId: "quote-1", jobId: "job-1",
    invoiceTaxContext: { id: "context-1", revision: 2, inputHash: "a".repeat(64),
      confirmedByTenantUserId: "member-1", confirmedAtUtc: observed },
    transactionDate: "2026-10-03", currency: "USD" as const, subtotal: "150.00", quotedTax: "12.00", total: "162.00",
    connection: { id: "connection-1", realmId: "12345", connectedAtUtc: observed, generation: 4, environment: "sandbox" as const },
    customerMapping: { id: "customer-map", reviewVersion: 2, reviewedAtUtc: observed, providerId: "customer-1" },
    customerFacts: { providerCustomerId: "customer-1", providerSyncToken: "0", observedAtUtc: observed,
      exemption: "TAXABLE" as const, exemptionReasonId: null, fingerprint: "b".repeat(64) },
    origin: address("100 Origin Ave"), destination: address("200 Jobsite Rd"),
    preferences: { observedAtUtc: observed, fingerprint: "c".repeat(64), companyObservedAtUtc: observed,
      companyInfoFingerprint: "d".repeat(64), capabilities: { companyPrerequisitesReady: true,
        automatedTaxCalculationProven: false as const, usCompany: true, companyAddressComplete: true,
        salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [] } },
    lines: [
      { invoiceLineItemId: "line-1", position: 0, description: "Taxable labor", quantity: "2.00", unitPrice: "50.00", amount: "100.00",
        taxIntent: "TAXABLE" as const, itemMapping: { id: "map-1", reviewVersion: 1, reviewedAtUtc: observed, providerId: "item-1" },
        itemFacts: { providerItemId: "item-1", providerSyncToken: "0", observedAtUtc: observed, taxClassificationFingerprint: "e".repeat(64) } },
      { invoiceLineItemId: "line-2", position: 1, description: "Non-taxable permit", quantity: "1.00", unitPrice: "50.00", amount: "50.00",
        taxIntent: "NON_TAXABLE" as const, itemMapping: { id: "map-2", reviewVersion: 1, reviewedAtUtc: observed, providerId: "item-2" },
        itemFacts: { providerItemId: "item-2", providerSyncToken: "0", observedAtUtc: observed, taxClassificationFingerprint: "f".repeat(64) } },
    ],
  };
  const canonicalEstimate = { Id: "estimate-1", SyncToken: "0", MetaData: { LastUpdatedTime: observed }, ...structuredClone(estimateAst),
    TxnTaxDetail: { TotalTax: 12 }, TotalAmt: 162 };
  const binding = { tenantId: "tenant-1", invoiceId: "invoice-1", invoiceVersion: 3,
    quickBooksConnectionId: "connection-1", providerRealmId: "12345", connectionGeneration: 4,
    invoiceTaxContextId: "context-1", invoiceTaxContextRevision: 2, invoiceTaxContextInputHash: "a".repeat(64) };
  return { sourceSnapshot, estimateAstSnapshot: estimateAst, currentIdentity: { ...binding },
    ledger: { status: "ESTIMATE_CANONICAL" as const, supersededAtUtc: null, ...binding,
      sourceHash: hash(sourceSnapshot), estimateAstHash: hash(estimateAst), providerEstimateId: "estimate-1",
      providerEstimateSyncToken: "0", providerEstimateUpdatedAtUtc: observed,
      canonicalEstimateHash: hash(canonicalEstimate), providerSubtotal: "150.00", providerTax: "12.00", providerTotal: "162.00" },
    canonicalEstimate, canonicalInvoice: { Id: "invoice-qbo-1", SyncToken: "0", MetaData: { LastUpdatedTime: observed }, ...structuredClone(estimateAst),
      TxnTaxDetail: { TotalTax: 12 }, TotalAmt: 162, LinkedTxn: [{ TxnId: "estimate-1", TxnType: "Estimate" as const }] } };
}

function expectCode(value: unknown, code: string) {
  assert.throws(() => evaluateQuickBooksTaxInvoiceParity(value), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const serialized = JSON.stringify(error);
    assert.equal(error.name, "QuickBooksTaxInvoiceParityError");
    assert.equal(error.message, code);
    assert.equal((error as { code?: string }).code, code);
    assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), ["code", "name"]);
    assert.doesNotMatch(serialized, /100 Origin Ave|Taxable labor|tenant-1|invoice-1/);
    return true;
  });
}

function rehashSource(input: ReturnType<typeof fixture>) {
  input.ledger.sourceHash = hash(input.sourceSnapshot);
}

function syncAstAndProjections(input: ReturnType<typeof fixture>) {
  const ast = structuredClone(input.estimateAstSnapshot);
  Object.assign(input.canonicalEstimate, ast);
  Object.assign(input.canonicalInvoice, structuredClone(ast));
  input.ledger.estimateAstHash = hash(input.estimateAstSnapshot);
  input.ledger.canonicalEstimateHash = hash(input.canonicalEstimate);
}

describe("QuickBooks taxable Invoice parity projection", () => {
  it("matches exact bounded observations without granting freshness, parity, or publishing authority", () => {
    const input = fixture(); const before = structuredClone(input);
    const result = evaluateQuickBooksTaxInvoiceParity(input);
    assert.deepEqual(input, before);
    assert.deepEqual(result, { projectionMatches: true, sourceHash: input.ledger.sourceHash,
      estimateAstHash: input.ledger.estimateAstHash, canonicalEstimateHash: input.ledger.canonicalEstimateHash,
      canonicalInvoiceHash: hash(input.canonicalInvoice), currentAuthorityEstablished: false,
      freshnessEstablished: false, providerProvenanceEstablished: false,
      estimateInvoiceParityProven: false, publishingAuthorized: false });
    assert.ok(Object.isFrozen(result));
  });

  it("rejects malformed and unbounded observations with a fixed content-free error", () => {
    const input = fixture() as any; input.canonicalInvoice.Line = Array.from({ length: 501 }, () => input.canonicalInvoice.Line[0]);
    expectCode(input, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  });

  it("rejects source, current identity, and canonical Estimate identity drift", () => {
    const source = fixture(); source.sourceSnapshot.invoiceVersion += 1;
    expectCode(source, "QUICKBOOKS_TAX_INVOICE_SOURCE_BINDING_MISMATCH");
    const current = fixture(); current.currentIdentity.connectionGeneration += 1;
    expectCode(current, "QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH");
    const estimate = fixture(); estimate.canonicalEstimate.SyncToken = "1";
    expectCode(estimate, "QUICKBOOKS_TAX_INVOICE_ESTIMATE_IDENTITY_MISMATCH");
    const context = fixture(); context.currentIdentity.invoiceTaxContextRevision += 1;
    expectCode(context, "QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH");
    const version = fixture(); version.currentIdentity.invoiceVersion += 1;
    expectCode(version, "QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH");
    const realm = fixture(); realm.currentIdentity.providerRealmId = "99999";
    expectCode(realm, "QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH");
    const superseded = fixture() as any; superseded.ledger.status = "SUPERSEDED"; superseded.ledger.supersededAtUtc = observed;
    expectCode(superseded, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  });

  it("derives the AST from semantically valid source instead of trusting coherent hashes", () => {
    const addressDrift = fixture(); addressDrift.sourceSnapshot.destination.Line1 = "300 Reviewed Elsewhere";
    rehashSource(addressDrift);
    expectCode(addressDrift, "QUICKBOOKS_TAX_INVOICE_SOURCE_BINDING_MISMATCH");

    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.customerFacts.providerCustomerId = "different-customer"; },
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.lines[0].itemFacts.providerItemId = "different-item"; },
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.lines[0].amount = "99.00"; },
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.lines[1].invoiceLineItemId = "line-1"; },
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.lines[1].position = 0; },
      (value: ReturnType<typeof fixture>) => { Object.assign(value.sourceSnapshot.customerFacts,
        { exemption: "EXEMPT", exemptionReasonId: "reason-1" }); },
      (value: ReturnType<typeof fixture>) => { value.sourceSnapshot.lines.forEach(line => { line.taxIntent = "NON_TAXABLE"; }); },
    ]) {
      const invalid = fixture(); mutate(invalid); rehashSource(invalid);
      expectCode(invalid, "QUICKBOOKS_TAX_INVOICE_SOURCE_INVALID");
    }

    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { value.estimateAstSnapshot.Line.reverse(); },
      (value: ReturnType<typeof fixture>) => { value.estimateAstSnapshot.Line.pop(); },
      (value: ReturnType<typeof fixture>) => { value.estimateAstSnapshot.Line[1] = structuredClone(value.estimateAstSnapshot.Line[0]); },
    ]) {
      const drift = fixture(); mutate(drift); syncAstAndProjections(drift);
      expectCode(drift, "QUICKBOOKS_TAX_INVOICE_SOURCE_BINDING_MISMATCH");
    }
  });

  it("requires positive tax and exact QuoteFly quoted tax and total", () => {
    const zero = fixture(); zero.canonicalEstimate.TxnTaxDetail.TotalTax = 0; zero.canonicalEstimate.TotalAmt = 150;
    zero.ledger.canonicalEstimateHash = hash(zero.canonicalEstimate); zero.ledger.providerTax = "0.00"; zero.ledger.providerTotal = "150.00";
    expectCode(zero, "QUICKBOOKS_TAX_INVOICE_TAX_NOT_POSITIVE");
    const mismatch = fixture(); mismatch.sourceSnapshot.quotedTax = "11.00"; mismatch.sourceSnapshot.total = "161.00";
    mismatch.ledger.sourceHash = hash(mismatch.sourceSnapshot);
    expectCode(mismatch, "QUICKBOOKS_TAX_INVOICE_QUOTED_TOTAL_MISMATCH");
  });

  it("requires one exact Estimate link", () => {
    const wrong = fixture(); wrong.canonicalInvoice.LinkedTxn[0].TxnId = "estimate-other";
    expectCode(wrong, "QUICKBOOKS_TAX_INVOICE_LINK_MISMATCH");
    const extra = fixture() as any; extra.canonicalInvoice.LinkedTxn.push({ TxnId: "estimate-2", TxnType: "Estimate" });
    expectCode(extra, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  });

  it("rejects ordered line, tax-code, customer, currency, date, address, tax, and total drift", () => {
    const changes: Array<(value: ReturnType<typeof fixture>) => void> = [
      value => { value.canonicalInvoice.Line.reverse(); },
      value => { value.canonicalInvoice.Line[0].SalesItemLineDetail.TaxCodeRef.value = "NON"; },
      value => { value.canonicalInvoice.CustomerRef.value = "customer-2"; },
      value => { value.canonicalInvoice.TxnDate = "2026-10-04"; },
      value => { value.canonicalInvoice.ShipAddr.Line1 = "Different destination"; },
      value => { value.canonicalInvoice.TxnTaxDetail.TotalTax = 13; },
      value => { value.canonicalInvoice.TotalAmt = 163; },
    ];
    for (const change of changes) { const input = fixture(); change(input); expectCode(input, "QUICKBOOKS_TAX_INVOICE_PROJECTION_MISMATCH"); }
    const currency = fixture() as any; currency.canonicalInvoice.CurrencyRef.value = "CAD";
    expectCode(currency, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  });

  it("accepts exact decimal cents through the maximum total and rejects subcent or unbounded generations", () => {
    const decimal = fixture();
    Object.assign(decimal.sourceSnapshot.lines[0], { quantity: "1.00", unitPrice: "100.29", amount: "100.29" });
    Object.assign(decimal.sourceSnapshot, { subtotal: "150.29", quotedTax: "12.01", total: "162.30" });
    Object.assign(decimal.estimateAstSnapshot.Line[0], { Amount: 100.29,
      SalesItemLineDetail: { ...decimal.estimateAstSnapshot.Line[0].SalesItemLineDetail, Qty: 1, UnitPrice: 100.29 } });
    Object.assign(decimal.canonicalEstimate, { TxnTaxDetail: { TotalTax: 12.01 }, TotalAmt: 162.3 });
    Object.assign(decimal.canonicalInvoice, { TxnTaxDetail: { TotalTax: 12.01 }, TotalAmt: 162.3 });
    Object.assign(decimal.ledger, { providerSubtotal: "150.29", providerTax: "12.01", providerTotal: "162.30" });
    rehashSource(decimal); syncAstAndProjections(decimal);
    decimal.ledger.canonicalEstimateHash = hash(decimal.canonicalEstimate);
    assert.equal(evaluateQuickBooksTaxInvoiceParity(decimal).projectionMatches, true);

    const maximum = fixture();
    maximum.sourceSnapshot.lines = [structuredClone(maximum.sourceSnapshot.lines[0])];
    Object.assign(maximum.sourceSnapshot.lines[0], { quantity: "1.00", unitPrice: "99999998.99", amount: "99999998.99" });
    Object.assign(maximum.sourceSnapshot, { subtotal: "99999998.99", quotedTax: "1.00", total: "99999999.99" });
    maximum.estimateAstSnapshot.Line = [structuredClone(maximum.estimateAstSnapshot.Line[0])];
    Object.assign(maximum.estimateAstSnapshot.Line[0], { Amount: 99999998.99,
      SalesItemLineDetail: { ...maximum.estimateAstSnapshot.Line[0].SalesItemLineDetail, Qty: 1, UnitPrice: 99999998.99 } });
    Object.assign(maximum.canonicalEstimate, { TxnTaxDetail: { TotalTax: 1 }, TotalAmt: 99999999.99 });
    Object.assign(maximum.canonicalInvoice, { TxnTaxDetail: { TotalTax: 1 }, TotalAmt: 99999999.99 });
    Object.assign(maximum.ledger, { providerSubtotal: "99999998.99", providerTax: "1.00", providerTotal: "99999999.99" });
    rehashSource(maximum); syncAstAndProjections(maximum);
    maximum.ledger.canonicalEstimateHash = hash(maximum.canonicalEstimate);
    assert.equal(evaluateQuickBooksTaxInvoiceParity(maximum).projectionMatches, true);

    const subcent = fixture() as any; subcent.canonicalInvoice.TotalAmt = 162.001;
    expectCode(subcent, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
    const exponent = fixture() as any; exponent.canonicalInvoice.TxnTaxDetail.TotalTax = 1e-7;
    expectCode(exponent, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
    const token = fixture() as any; token.canonicalInvoice.SyncToken = "1".repeat(192);
    expectCode(token, "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  });
});
