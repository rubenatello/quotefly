import { createHash } from "node:crypto";
import { z } from "zod";
import { taxReviewSourceSchema, usTaxAddressSchema } from "./quickbooks-tax-review-contract";

const id = z.string().min(1).max(191);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ precision: 3 });
const moneyLexeme = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
const moneyNumber = z.number().finite().nonnegative().max(99_999_999.99)
  .refine((value) => moneyLexeme.test(String(value)));
const reference = z.strictObject({ value: id });
const line = z.strictObject({
  Description: z.string().min(1).max(4_000),
  DetailType: z.literal("SalesItemLineDetail"),
  Amount: moneyNumber,
  SalesItemLineDetail: z.strictObject({
    ItemRef: reference,
    Qty: moneyNumber.refine((value) => value > 0),
    UnitPrice: moneyNumber,
    TaxCodeRef: z.strictObject({ value: z.enum(["TAX", "NON"]) }),
  }),
});
const estimateAst = z.strictObject({
  CustomerRef: reference,
  TxnDate: z.iso.date(),
  CurrencyRef: z.strictObject({ value: z.literal("USD") }),
  ShipFromAddr: usTaxAddressSchema,
  ShipAddr: usTaxAddressSchema,
  Line: z.array(line).min(1).max(500),
});
const canonicalEstimate = estimateAst.extend({
  Id: id,
  SyncToken: z.string().max(191).regex(/^(0|[1-9][0-9]*)$/),
  MetaData: z.strictObject({ LastUpdatedTime: timestamp }),
  TxnTaxDetail: z.strictObject({ TotalTax: moneyNumber }),
  TotalAmt: moneyNumber,
}).strict();
const canonicalInvoice = estimateAst.extend({
  Id: id,
  SyncToken: z.string().max(191).regex(/^(0|[1-9][0-9]*)$/),
  MetaData: z.strictObject({ LastUpdatedTime: timestamp }),
  TxnTaxDetail: z.strictObject({ TotalTax: moneyNumber }),
  TotalAmt: moneyNumber,
  LinkedTxn: z.tuple([z.strictObject({ TxnId: id, TxnType: z.literal("Estimate") })]),
}).strict();
const ledger = z.strictObject({
  status: z.literal("ESTIMATE_CANONICAL"),
  supersededAtUtc: z.null(),
  tenantId: id,
  invoiceId: id,
  invoiceVersion: z.number().int().positive(),
  quickBooksConnectionId: id,
  providerRealmId: id,
  connectionGeneration: z.number().int().positive(),
  invoiceTaxContextId: id,
  invoiceTaxContextRevision: z.number().int().positive(),
  invoiceTaxContextInputHash: digest,
  sourceHash: digest,
  estimateAstHash: digest,
  providerEstimateId: id,
  providerEstimateSyncToken: z.string().max(191).regex(/^(0|[1-9][0-9]*)$/),
  providerEstimateUpdatedAtUtc: timestamp,
  canonicalEstimateHash: digest,
  providerSubtotal: z.string().regex(/^(?:0|[1-9]\d{0,7})\.\d{2}$/),
  providerTax: z.string().regex(/^(?:0|[1-9]\d{0,7})\.\d{2}$/),
  providerTotal: z.string().regex(/^(?:0|[1-9]\d{0,7})\.\d{2}$/),
});
const currentIdentity = z.strictObject({
  tenantId: id,
  invoiceId: id,
  invoiceVersion: z.number().int().positive(),
  quickBooksConnectionId: id,
  providerRealmId: id,
  connectionGeneration: z.number().int().positive(),
  invoiceTaxContextId: id,
  invoiceTaxContextRevision: z.number().int().positive(),
  invoiceTaxContextInputHash: digest,
});
const inputSchema = z.strictObject({
  sourceSnapshot: taxReviewSourceSchema,
  estimateAstSnapshot: estimateAst,
  ledger,
  currentIdentity,
  canonicalEstimate,
  canonicalInvoice,
});

export type QuickBooksTaxInvoiceParityInput = z.input<typeof inputSchema>;
export type QuickBooksTaxInvoiceParityFailureCode =
  | "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID"
  | "QUICKBOOKS_TAX_INVOICE_SOURCE_INVALID"
  | "QUICKBOOKS_TAX_INVOICE_SOURCE_BINDING_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_ESTIMATE_IDENTITY_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_ESTIMATE_PROJECTION_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_QUOTED_TOTAL_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_TAX_NOT_POSITIVE"
  | "QUICKBOOKS_TAX_INVOICE_LINK_MISMATCH"
  | "QUICKBOOKS_TAX_INVOICE_PROJECTION_MISMATCH";

export class QuickBooksTaxInvoiceParityError extends Error {
  constructor(readonly code: QuickBooksTaxInvoiceParityFailureCode) {
    super(code);
    this.name = "QuickBooksTaxInvoiceParityError";
  }
}

function reject(code: QuickBooksTaxInvoiceParityFailureCode): never {
  throw new QuickBooksTaxInvoiceParityError(code);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function cents(value: number | string): bigint {
  if (typeof value === "string") return BigInt(value.replace(".", ""));
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates bounded structured observations only. It performs no I/O and cannot
 * establish their database freshness, provider provenance, or publication authority.
 * Returned hashes are restricted financial correlation evidence; callers must
 * not treat them as content-free log or public-API fields.
 */
export function evaluateQuickBooksTaxInvoiceParity(raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const value = parsed.data;
  const { sourceSnapshot: source, estimateAstSnapshot: ast, ledger: stored,
    currentIdentity: current, canonicalEstimate: estimate, canonicalInvoice: invoice } = value;

  const lineIds = new Set<string>();
  let sourceSubtotal = 0n;
  let previousPosition = -1;
  for (const entry of source.lines) {
    const amount = cents(entry.amount);
    if (lineIds.has(entry.invoiceLineItemId) || entry.position <= previousPosition
      || entry.itemFacts.providerItemId !== entry.itemMapping.providerId
      || (cents(entry.quantity) * cents(entry.unitPrice) + 50n) / 100n !== amount) {
      reject("QUICKBOOKS_TAX_INVOICE_SOURCE_INVALID");
    }
    lineIds.add(entry.invoiceLineItemId);
    previousPosition = entry.position;
    sourceSubtotal += amount;
  }
  if (source.customerFacts.providerCustomerId !== source.customerMapping.providerId
    || source.customerFacts.exemption !== "TAXABLE" || source.customerFacts.exemptionReasonId !== null
    || !source.lines.some((entry) => entry.taxIntent === "TAXABLE")
    || sourceSubtotal !== cents(source.subtotal)
    || sourceSubtotal + cents(source.quotedTax) !== cents(source.total)) {
    reject("QUICKBOOKS_TAX_INVOICE_SOURCE_INVALID");
  }
  const sourceDerivedAst = {
    CustomerRef: { value: source.customerMapping.providerId },
    TxnDate: source.transactionDate,
    CurrencyRef: { value: "USD" as const },
    ShipFromAddr: source.origin,
    ShipAddr: source.destination,
    Line: source.lines.map((entry) => ({
      Description: entry.description,
      DetailType: "SalesItemLineDetail" as const,
      Amount: Number(entry.amount),
      SalesItemLineDetail: {
        ItemRef: { value: entry.itemMapping.providerId },
        Qty: Number(entry.quantity),
        UnitPrice: Number(entry.unitPrice),
        TaxCodeRef: { value: entry.taxIntent === "TAXABLE" ? "TAX" as const : "NON" as const },
      },
    })),
  };

  const sourceBinding = {
    tenantId: source.tenantId,
    invoiceId: source.invoiceId,
    invoiceVersion: source.invoiceVersion,
    quickBooksConnectionId: source.connection.id,
    providerRealmId: source.connection.realmId,
    connectionGeneration: source.connection.generation,
    invoiceTaxContextId: source.invoiceTaxContext.id,
    invoiceTaxContextRevision: source.invoiceTaxContext.revision,
    invoiceTaxContextInputHash: source.invoiceTaxContext.inputHash,
  };
  const ledgerBinding = {
    tenantId: stored.tenantId, invoiceId: stored.invoiceId, invoiceVersion: stored.invoiceVersion,
    quickBooksConnectionId: stored.quickBooksConnectionId, providerRealmId: stored.providerRealmId,
    connectionGeneration: stored.connectionGeneration, invoiceTaxContextId: stored.invoiceTaxContextId,
    invoiceTaxContextRevision: stored.invoiceTaxContextRevision,
    invoiceTaxContextInputHash: stored.invoiceTaxContextInputHash,
  };
  if (!exact(sourceBinding, ledgerBinding) || sha256(source) !== stored.sourceHash
    || sha256(ast) !== stored.estimateAstHash || !exact(sourceDerivedAst, ast)) {
    reject("QUICKBOOKS_TAX_INVOICE_SOURCE_BINDING_MISMATCH");
  }
  if (!exact(current, ledgerBinding)) reject("QUICKBOOKS_TAX_INVOICE_CURRENT_BINDING_MISMATCH");
  if (estimate.Id !== stored.providerEstimateId || estimate.SyncToken !== stored.providerEstimateSyncToken
    || estimate.MetaData.LastUpdatedTime !== stored.providerEstimateUpdatedAtUtc
    || sha256(estimate) !== stored.canonicalEstimateHash) {
    reject("QUICKBOOKS_TAX_INVOICE_ESTIMATE_IDENTITY_MISMATCH");
  }
  const estimateProjection = {
    CustomerRef: estimate.CustomerRef, TxnDate: estimate.TxnDate, CurrencyRef: estimate.CurrencyRef,
    ShipFromAddr: estimate.ShipFromAddr, ShipAddr: estimate.ShipAddr, Line: estimate.Line,
  };
  if (!exact(estimateProjection, ast)) reject("QUICKBOOKS_TAX_INVOICE_ESTIMATE_PROJECTION_MISMATCH");

  const subtotal = estimate.Line.reduce((sum, entry) => sum + cents(entry.Amount), 0n);
  const tax = cents(estimate.TxnTaxDetail.TotalTax);
  const total = cents(estimate.TotalAmt);
  if (tax <= 0n) reject("QUICKBOOKS_TAX_INVOICE_TAX_NOT_POSITIVE");
  if (subtotal !== cents(stored.providerSubtotal) || tax !== cents(stored.providerTax)
    || total !== cents(stored.providerTotal) || total !== subtotal + tax) {
    reject("QUICKBOOKS_TAX_INVOICE_ESTIMATE_PROJECTION_MISMATCH");
  }
  if (subtotal !== cents(source.subtotal) || tax !== cents(source.quotedTax)
    || total !== cents(source.total)) reject("QUICKBOOKS_TAX_INVOICE_QUOTED_TOTAL_MISMATCH");

  const link = invoice.LinkedTxn[0];
  if (link.TxnId !== estimate.Id) reject("QUICKBOOKS_TAX_INVOICE_LINK_MISMATCH");
  const invoiceProjection = {
    CustomerRef: invoice.CustomerRef, TxnDate: invoice.TxnDate, CurrencyRef: invoice.CurrencyRef,
    ShipFromAddr: invoice.ShipFromAddr, ShipAddr: invoice.ShipAddr, Line: invoice.Line,
  };
  if (!exact(invoiceProjection, estimateProjection)
    || cents(invoice.TxnTaxDetail.TotalTax) !== tax || cents(invoice.TotalAmt) !== total) {
    reject("QUICKBOOKS_TAX_INVOICE_PROJECTION_MISMATCH");
  }

  return freeze({
    projectionMatches: true as const,
    sourceHash: stored.sourceHash,
    estimateAstHash: stored.estimateAstHash,
    canonicalEstimateHash: stored.canonicalEstimateHash,
    canonicalInvoiceHash: sha256(invoice),
    currentAuthorityEstablished: false as const,
    freshnessEstablished: false as const,
    providerProvenanceEstablished: false as const,
    estimateInvoiceParityProven: false as const,
    publishingAuthorized: false as const,
  });
}
