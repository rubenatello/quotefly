import { z } from "zod";

const providerId = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const syncToken = z.string().min(1).max(191).regex(/^(?:0|[1-9]\d*)$/);
const rfc3339Timestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
);
const moneyLexeme = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
const money = z.number().finite().nonnegative().max(99_999_999.99)
  .refine((value) => moneyLexeme.test(String(value)));
const address = z.object({
  Line1: z.string().min(1).max(200),
  Line2: z.string().min(1).max(200).optional(),
  City: z.string().min(1).max(100),
  CountrySubDivisionCode: z.string().regex(/^[A-Z]{2}$/),
  PostalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
  Country: z.literal("US"),
}).passthrough();
const reference = z.object({ value: providerId }).passthrough();
const salesLine = z.object({
  Description: z.string().min(1).max(4_000),
  DetailType: z.literal("SalesItemLineDetail"),
  Amount: money,
  SalesItemLineDetail: z.object({
    ItemRef: reference,
    Qty: money.refine((value) => value > 0),
    UnitPrice: money,
    TaxCodeRef: z.object({ value: z.enum(["TAX", "NON"]) }).passthrough(),
  }).passthrough(),
}).passthrough();
const subtotalLine = z.object({
  DetailType: z.literal("SubTotalLineDetail"),
  Amount: money,
  SubTotalLineDetail: z.object({}).passthrough(),
}).passthrough();
const commonEntity = z.object({
  Id: providerId,
  SyncToken: syncToken,
  MetaData: z.object({ LastUpdatedTime: z.string() }).passthrough(),
  CustomerRef: reference,
  TxnDate: z.iso.date(),
  CurrencyRef: z.object({ value: z.literal("USD") }).passthrough(),
  ShipFromAddr: address,
  ShipAddr: address,
  Line: z.array(z.unknown()).min(1).max(501),
  TxnTaxDetail: z.object({ TotalTax: money }).passthrough(),
  TotalAmt: money,
}).passthrough();
const estimateEnvelope = z.object({ Estimate: z.unknown() }).passthrough();
const invoiceEnvelope = z.object({ Invoice: z.unknown() }).passthrough();
const invoiceDeliveryEntity = commonEntity.extend({
  EmailStatus: z.literal("NotSet"),
  AllowOnlineACHPayment: z.literal(false),
  AllowOnlineCreditCardPayment: z.literal(false),
  AllowOnlinePayPalPayment: z.literal(false),
  AllowOnlineAffirmPayment: z.literal(false),
  AllowOnlinePayment: z.literal(false).optional(),
  AllowIPNPayment: z.literal(false).optional(),
}).passthrough();
const linkedTransactions = z.array(z.object({ TxnId: providerId, TxnType: z.string() }).passthrough()).max(10);

export type QuickBooksTaxCanonicalProjectionFailureCode =
  | "QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID"
  | "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"
  | "QUICKBOOKS_TAX_CANONICAL_LINK_INVALID"
  | "QUICKBOOKS_TAX_CANONICAL_DELIVERY_UNSAFE";

export class QuickBooksTaxCanonicalProjectionError extends Error {
  constructor(readonly code: QuickBooksTaxCanonicalProjectionFailureCode) {
    super(code);
    this.name = "QuickBooksTaxCanonicalProjectionError";
  }
}

function fail(code: QuickBooksTaxCanonicalProjectionFailureCode): never {
  throw new QuickBooksTaxCanonicalProjectionError(code);
}

function cents(value: number): bigint {
  const [whole, fraction = ""] = String(value).split(".");
  if (!whole || !moneyLexeme.test(String(value))) fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function normalizedTimestamp(value: string): string {
  if (!rfc3339Timestamp.safeParse(value).success) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  const normalized = new Date(epoch).toISOString();
  if (Date.parse(normalized) !== epoch) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  return normalized;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function projectedAddress(value: z.infer<typeof address>) {
  return {
    Line1: value.Line1,
    ...(value.Line2 === undefined ? {} : { Line2: value.Line2 }),
    City: value.City,
    CountrySubDivisionCode: value.CountrySubDivisionCode,
    PostalCode: value.PostalCode,
    Country: "US" as const,
  };
}

function projectCommon(value: z.infer<typeof commonEntity>) {
  const projectedLines: Array<{
    Description: string;
    DetailType: "SalesItemLineDetail";
    Amount: number;
    SalesItemLineDetail: {
      ItemRef: { value: string };
      Qty: number;
      UnitPrice: number;
      TaxCodeRef: { value: "TAX" | "NON" };
    };
  }> = [];
  let subtotalAmount: number | null = null;
  for (const [index, rawLine] of value.Line.entries()) {
    const record = rawLine !== null && typeof rawLine === "object" ? rawLine as Record<string, unknown> : null;
    const detailSiblings = record ? Object.keys(record).filter((key) => key.endsWith("LineDetail")) : [];
    if (record?.DetailType === "SalesItemLineDetail") {
      if (subtotalAmount !== null || detailSiblings.length !== 1 || detailSiblings[0] !== "SalesItemLineDetail") {
        fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
      }
      const parsed = salesLine.safeParse(rawLine);
      if (!parsed.success) fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
      const line = parsed.data;
      const extended = cents(line.SalesItemLineDetail.Qty) * cents(line.SalesItemLineDetail.UnitPrice);
      if (cents(line.Amount) !== (extended + 50n) / 100n) {
        fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
      }
      projectedLines.push({
        Description: line.Description,
        DetailType: "SalesItemLineDetail",
        Amount: line.Amount,
        SalesItemLineDetail: {
          ItemRef: { value: line.SalesItemLineDetail.ItemRef.value },
          Qty: line.SalesItemLineDetail.Qty,
          UnitPrice: line.SalesItemLineDetail.UnitPrice,
          TaxCodeRef: { value: line.SalesItemLineDetail.TaxCodeRef.value },
        },
      });
      continue;
    }
    if (record?.DetailType === "SubTotalLineDetail") {
      const parsed = subtotalLine.safeParse(rawLine);
      if (!parsed.success || subtotalAmount !== null || index !== value.Line.length - 1
        || detailSiblings.length !== 1 || detailSiblings[0] !== "SubTotalLineDetail") {
        fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
      }
      subtotalAmount = parsed.data.Amount;
      continue;
    }
    fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  }
  if (projectedLines.length < 1 || projectedLines.length > 500) {
    fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  }
  const subtotalCents = projectedLines.reduce((sum, line) => sum + cents(line.Amount), 0n);
  if (subtotalAmount !== null && cents(subtotalAmount) !== subtotalCents) {
    fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  }
  const taxCents = cents(value.TxnTaxDetail.TotalTax);
  if (subtotalCents + taxCents !== cents(value.TotalAmt)) {
    fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  }
  return {
    Id: value.Id,
    SyncToken: value.SyncToken,
    MetaData: { LastUpdatedTime: normalizedTimestamp(value.MetaData.LastUpdatedTime) },
    CustomerRef: { value: value.CustomerRef.value },
    TxnDate: value.TxnDate,
    CurrencyRef: { value: "USD" as const },
    ShipFromAddr: projectedAddress(value.ShipFromAddr),
    ShipAddr: projectedAddress(value.ShipAddr),
    Line: projectedLines,
    TxnTaxDetail: { TotalTax: value.TxnTaxDetail.TotalTax },
    TotalAmt: value.TotalAmt,
  };
}

export type CanonicalQuickBooksTaxEstimate = Readonly<ReturnType<typeof projectCommon>>;
export type CanonicalQuickBooksTaxInvoice = Readonly<ReturnType<typeof projectCommon> & {
  LinkedTxn: readonly [Readonly<{ TxnId: string; TxnType: "Estimate" }>];
}>;

export function projectCanonicalQuickBooksTaxEstimate(rawEnvelope: unknown, expectedEstimateId: string) {
  if (!providerId.safeParse(expectedEstimateId).success) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  const envelope = estimateEnvelope.safeParse(rawEnvelope);
  const entity = envelope.success ? commonEntity.safeParse(envelope.data.Estimate) : null;
  if (!entity?.success) fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  if (entity.data.Id !== expectedEstimateId) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  return deepFreeze(projectCommon(entity.data));
}

export function projectCanonicalQuickBooksTaxInvoice(
  rawEnvelope: unknown,
  expectedInvoiceId: string,
  expectedEstimateId: string,
): CanonicalQuickBooksTaxInvoice {
  if (!providerId.safeParse(expectedInvoiceId).success || !providerId.safeParse(expectedEstimateId).success) {
    fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  }
  const envelope = invoiceEnvelope.safeParse(rawEnvelope);
  const entity = envelope.success ? invoiceDeliveryEntity.safeParse(envelope.data.Invoice) : null;
  if (!entity?.success) {
    const common = envelope.success ? commonEntity.safeParse(envelope.data.Invoice) : null;
    if (common?.success) fail("QUICKBOOKS_TAX_CANONICAL_DELIVERY_UNSAFE");
    fail("QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID");
  }
  if (entity.data.Id !== expectedInvoiceId) fail("QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID");
  const rawEntity = entity.data as Record<string, unknown>;
  const links = linkedTransactions.safeParse(rawEntity.LinkedTxn);
  if (!links.success || links.data.length !== 1 || links.data[0]?.TxnId !== expectedEstimateId
    || links.data[0]?.TxnType !== "Estimate") {
    fail("QUICKBOOKS_TAX_CANONICAL_LINK_INVALID");
  }
  return deepFreeze({
    ...projectCommon(entity.data),
    LinkedTxn: [{ TxnId: expectedEstimateId, TxnType: "Estimate" as const }] as const,
  });
}
