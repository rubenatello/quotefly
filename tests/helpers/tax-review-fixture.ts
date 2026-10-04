import { hkdfSync, randomUUID } from "node:crypto";
import { createQuickBooksTaxReview, type TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";
import type { InvoiceTaxContextInput } from "../../src/services/quickbooks-tax-context";
export function testRuntime(keys: { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: string; QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS?: string }): QuickBooksCredentialRuntimeEnv {
 return { ...keys, QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS ?? "",
 QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1000, QUICKBOOKS_PROVIDER_READ_RETRIES: 0,
 QUICKBOOKS_CLIENT_ID: "synthetic", QUICKBOOKS_CLIENT_SECRET: "synthetic", JWT_SECRET: "synthetic-test-only-jwt-key-material" };
}
/** Pure fixture signer used only to assert stored evidence, never to persist it. */
export function syntheticReview(source: TaxReviewSource, keys: { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: string }) {
 const key = Buffer.from(hkdfSync("sha256", keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY, "quotefly/quickbooks", "quotefly/quickbooks/tax-review/v1", 32)).toString("hex");
 return createQuickBooksTaxReview(source, key);
}
export function contextInput(source: TaxReviewSource, revision = 0): InvoiceTaxContextInput {
 return { invoiceId: source.invoiceId, invoiceVersion: source.invoiceVersion, expectedRevision: revision, idempotencyKey: randomUUID(),
 transactionDate: source.transactionDate, origin: source.origin, destination: source.destination, connection: source.connection,
 customerMapping: source.customerMapping, lines: source.lines.map(line => ({ invoiceLineItemId: line.invoiceLineItemId, taxIntent: line.taxIntent, itemMapping: line.itemMapping })) };
}
export function syntheticFacts(source: TaxReviewSource) {
 return { customer: { providerCustomerId: source.customerFacts.providerCustomerId, providerSyncToken: source.customerFacts.providerSyncToken,
 observedAtUtc: source.customerFacts.observedAtUtc, classification: source.customerFacts.exemption === "TAXABLE" ? "TAXABLE" as const : "UNKNOWN" as const, fingerprint: source.customerFacts.fingerprint },
 items: source.lines.map(line => ({ providerItemId: line.itemFacts.providerItemId, providerSyncToken: line.itemFacts.providerSyncToken,
 observedAtUtc: line.itemFacts.observedAtUtc, classification: line.taxIntent, fingerprint: line.itemFacts.taxClassificationFingerprint })),
 companyInfo: { observedAtUtc: source.preferences.companyObservedAtUtc, fingerprint: source.preferences.companyInfoFingerprint },
 preferences: { observedAtUtc: source.preferences.observedAtUtc, fingerprint: source.preferences.fingerprint }, capabilities: source.preferences.capabilities,
 observedFromUtc: source.preferences.observedAtUtc, observedThroughUtc: source.preferences.observedAtUtc,
 blockers: [] as string[], providerFactsSupported: true, automatedTaxCalculationProven: false as const, publishingAuthorized: false as const };
}
