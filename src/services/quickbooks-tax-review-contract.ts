import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { QuickBooksTaxCapabilityReport } from "./quickbooks-tax-capabilities";

/** Internal, provider-free contract. No result from this module authorizes a write. */
export const QUICKBOOKS_TAX_REVIEW_CONTRACT_VERSION = 1;
const MAX_CENTS = 9_999_999_999n; // Existing Decimal(10, 2) invoice fields.
const states = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
const text = (max: number) => z.string().max(max).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
  .transform((value) => value.normalize("NFC").trim()).pipe(z.string().min(1).max(max));
const id = text(191);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
const money = z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .transform((value) => { const [whole, fraction = ""] = value.split("."); return `${whole}.${fraction.padEnd(2, "0")}`; });
function cents(value: string): bigint { return BigInt(value.replace(".", "")); }

// Initial supported geography is the 50 US states and DC. Territories and
// military addresses need their own provider evidence; never infer a country.
export const usTaxAddressSchema = z.strictObject({
  Line1: text(200), Line2: text(200).optional(), City: text(100),
  CountrySubDivisionCode: z.string().refine((value) => states.has(value)),
  PostalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/), Country: z.literal("US"),
});
export type UsTaxAddress = z.infer<typeof usTaxAddressSchema>;

const capabilityReasons = z.enum([
  "CAPABILITY_READ_FAILED", "CAPABILITY_RESPONSE_INVALID", "COMPANY_BINDING_MISMATCH",
  "CAPABILITY_INPUT_INVALID", "US_COMPANY_REQUIRED", "COMPANY_ADDRESS_INCOMPLETE",
  "SALES_TAX_NOT_ENABLED", "ESTIMATES_NOT_ENABLED", "USD_HOME_CURRENCY_REQUIRED",
]);
const capabilitySchema = z.strictObject({
  companyPrerequisitesReady: z.boolean(), automatedTaxCalculationProven: z.literal(false),
  usCompany: z.boolean(), companyAddressComplete: z.boolean(), salesTaxEnabled: z.boolean(),
  estimatesEnabled: z.boolean(), usdHomeCurrency: z.boolean(),
  progressInvoicingEnabled: z.boolean().nullable(), reasons: z.array(capabilityReasons).max(9),
}) satisfies z.ZodType<QuickBooksTaxCapabilityReport>;

export const taxCustomerFactsSchema = z.strictObject({
  providerCustomerId: id, providerSyncToken: text(64), observedAtUtc: timestamp,
  exemption: z.enum(["TAXABLE", "EXEMPT", "UNKNOWN"]),
  exemptionReasonId: id.nullable(),
}).refine((facts) => facts.exemption !== "EXEMPT" || facts.exemptionReasonId !== null);

const mappingSchema = z.strictObject({ id, reviewVersion: version, reviewedAtUtc: timestamp, providerId: id });
export const taxReviewLineSchema = z.strictObject({
  invoiceLineItemId: id, position: z.number().int().min(0).max(999),
  description: text(4000), quantity: money.refine((value) => cents(value) > 0n),
  unitPrice: money, amount: money, taxIntent: z.enum(["TAXABLE", "NON_TAXABLE"]),
  itemMapping: mappingSchema,
  itemFacts: z.strictObject({ providerItemId: id, providerSyncToken: text(64),
    observedAtUtc: timestamp, taxClassificationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
});

export const taxReviewSourceSchema = z.strictObject({
  contractVersion: z.literal(QUICKBOOKS_TAX_REVIEW_CONTRACT_VERSION),
  tenantId: id, invoiceId: id, invoiceVersion: version, customerId: id, sourceQuoteId: id,
  transactionDate: z.iso.date(), currency: z.literal("USD"),
  subtotal: money, quotedTax: money, total: money,
  connection: z.strictObject({ id, realmId: z.string().regex(/^\d{1,64}$/),
    connectedAtUtc: timestamp, environment: z.enum(["sandbox", "production"]) }),
  customerMapping: mappingSchema, customerFacts: taxCustomerFactsSchema,
  origin: usTaxAddressSchema, destination: usTaxAddressSchema,
  preferences: z.strictObject({ observedAtUtc: timestamp, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    companyInfoFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: capabilitySchema }),
  lines: z.array(taxReviewLineSchema).min(1).max(500),
});
export type TaxReviewSource = z.infer<typeof taxReviewSourceSchema>;

export type TaxReviewFailureCode = "TAX_REVIEW_INPUT_INVALID" | "TAX_REVIEW_TOTALS_INVALID"
  | "TAX_REVIEW_LINES_INVALID" | "TAX_REVIEW_CUSTOMER_MISMATCH" | "TAX_REVIEW_KEY_INVALID";
export class QuickBooksTaxReviewError extends Error {
  constructor(readonly code: TaxReviewFailureCode) { super(code); this.name = "QuickBooksTaxReviewError"; }
}

function parseSource(input: unknown): TaxReviewSource {
  const parsed = taxReviewSourceSchema.safeParse(input);
  // Never attach Zod issues/input: addresses, customer data and descriptions are sensitive.
  if (!parsed.success) throw new QuickBooksTaxReviewError("TAX_REVIEW_INPUT_INVALID");
  const source = parsed.data;
  if (source.customerFacts.providerCustomerId !== source.customerMapping.providerId) {
    throw new QuickBooksTaxReviewError("TAX_REVIEW_CUSTOMER_MISMATCH");
  }
  const lineIds = new Set<string>();
  let subtotal = 0n;
  let previousPosition = -1;
  for (const line of source.lines) {
    if (lineIds.has(line.invoiceLineItemId) || line.position <= previousPosition
      || line.itemFacts.providerItemId !== line.itemMapping.providerId
      || (cents(line.quantity) * cents(line.unitPrice) + 50n) / 100n !== cents(line.amount)) {
      throw new QuickBooksTaxReviewError("TAX_REVIEW_LINES_INVALID");
    }
    lineIds.add(line.invoiceLineItemId);
    previousPosition = line.position;
    subtotal += cents(line.amount);
  }
  if (subtotal > MAX_CENTS || subtotal !== cents(source.subtotal)
    || subtotal + cents(source.quotedTax) !== cents(source.total)) {
    throw new QuickBooksTaxReviewError("TAX_REVIEW_TOTALS_INVALID");
  }
  return source;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function estimateAst(source: TaxReviewSource) {
  return {
    CustomerRef: { value: source.customerMapping.providerId },
    TxnDate: source.transactionDate, CurrencyRef: { value: "USD" as const },
    ShipFromAddr: { ...source.origin }, ShipAddr: { ...source.destination },
    Line: source.lines.map((line) => ({
      Description: line.description, DetailType: "SalesItemLineDetail" as const,
      Amount: Number(line.amount), SalesItemLineDetail: {
        ItemRef: { value: line.itemMapping.providerId }, Qty: Number(line.quantity),
        UnitPrice: Number(line.unitPrice), TaxCodeRef: { value: line.taxIntent === "TAXABLE" ? "TAX" : "NON" },
      },
    })),
  };
}
export type TaxEstimateAst = ReturnType<typeof estimateAst>;

export type TaxReviewAssessment = {
  providerPrerequisitesReady: boolean;
  reviewSourceReady: boolean;
  taxCalculationProven: false;
  estimateInvoiceParityProven: false;
  publishingAuthorized: false;
  blockers: Array<"PROVIDER_PREREQUISITES_MISSING" | "CUSTOMER_TAX_STATUS_UNSUPPORTED" | "TAXABLE_LINE_REQUIRED">;
};

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Internal preparatory data only. Canonical JSON, AST, hashes and binding carry
 * business information; do not log them or expose them as content-free evidence.
 * A caller must obtain source facts under live tenant/manager authorization and
 * later persist a reviewed operation before any provider write. This pure module
 * cannot establish fact freshness, trusted provenance, entitlement or tax parity.
 * No Invoice builder exists until canonical Estimate evidence is implemented.
 */
export function createQuickBooksTaxReview(input: unknown, signingKey: string) {
  if (typeof signingKey !== "string" || Buffer.byteLength(signingKey) < 32) {
    throw new QuickBooksTaxReviewError("TAX_REVIEW_KEY_INVALID");
  }
  const source = parseSource(input);
  const ast = estimateAst(source);
  const sourceJson = canonicalJson(source);
  const sourceHash = hash(sourceJson);
  const estimateAstHash = hash(canonicalJson(ast));
  const binding = createHmac("sha256", signingKey).update(canonicalJson({
    contract: "quotefly.quickbooks.tax-review", version: QUICKBOOKS_TAX_REVIEW_CONTRACT_VERSION,
    sourceHash, estimateAstHash,
  })).digest("hex");
  const capabilities = source.preferences.capabilities;
  const providerPrerequisitesReady = capabilities.companyPrerequisitesReady
    && capabilities.usCompany && capabilities.companyAddressComplete && capabilities.salesTaxEnabled
    && capabilities.estimatesEnabled && capabilities.usdHomeCurrency && capabilities.reasons.length === 0;
  const blockers: TaxReviewAssessment["blockers"] = [];
  if (!providerPrerequisitesReady) blockers.push("PROVIDER_PREREQUISITES_MISSING");
  if (source.customerFacts.exemption !== "TAXABLE" || source.customerFacts.exemptionReasonId !== null) {
    blockers.push("CUSTOMER_TAX_STATUS_UNSUPPORTED");
  }
  if (!source.lines.some((line) => line.taxIntent === "TAXABLE")) blockers.push("TAXABLE_LINE_REQUIRED");
  const assessment: TaxReviewAssessment = {
    providerPrerequisitesReady,
    reviewSourceReady: !blockers.some((code) => code !== "PROVIDER_PREREQUISITES_MISSING"),
    taxCalculationProven: false, estimateInvoiceParityProven: false, publishingAuthorized: false,
    blockers,
  };
  return freeze({ source, estimateAst: ast, sourceJson, sourceHash, estimateAstHash, binding, assessment });
}

/** Malformed, changed, or untrusted input always fails verification. */
export function verifyQuickBooksTaxReview(input: unknown, signingKey: string, binding: unknown): boolean {
  if (typeof binding !== "string" || !/^[a-f0-9]{64}$/.test(binding)) return false;
  try {
    const expected = createQuickBooksTaxReview(input, signingKey).binding;
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(binding, "hex"));
  } catch { return false; }
}
