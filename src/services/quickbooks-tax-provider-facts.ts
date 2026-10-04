import { createHmac, hkdfSync } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { currentQuickBooksConnectionGeneration } from "./quickbooks-connection-events";
import { runQuickBooksProviderRequestWithRefresh } from "./quickbooks-credentials";
import { QUICKBOOKS_ACCOUNTING_SCOPE, QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import { evaluateQuickBooksTaxCapabilities } from "./quickbooks-tax-capabilities";
import {
  fetchQuickBooksCompanyTaxInfo, fetchQuickBooksTaxPreferences, fetchQuickBooksTaxCustomer,
  fetchQuickBooksTaxItem, quickBooksTaxOpaqueIdSchema, QuickBooksProviderError,
  type QuickBooksCompanyTaxInfo, type QuickBooksTaxPreferences,
  type QuickBooksTaxCustomer, type QuickBooksTaxItem,
} from "./quickbooks";

const inputSchema = z.strictObject({
  tenantId: quickBooksTaxOpaqueIdSchema,
  connection: z.strictObject({ id: quickBooksTaxOpaqueIdSchema, realmId: z.string().regex(/^\d{1,30}$/),
    environment: z.enum(["sandbox", "production"]), connectedAtUtc: z.iso.datetime({ precision: 3 }),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  providerCustomerId: quickBooksTaxOpaqueIdSchema,
  lines: z.array(z.strictObject({ providerItemId: quickBooksTaxOpaqueIdSchema,
    taxIntent: z.enum(["TAXABLE", "NON_TAXABLE"]) })).min(1).max(500),
});
export type QuickBooksTaxProviderFactsInput = z.infer<typeof inputSchema>;
export class QuickBooksTaxProviderFactsError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QuickBooksTaxProviderFactsError"; }
}
function reject(code: string): never { throw new QuickBooksTaxProviderFactsError(code); }
function normalizeText(value: string | undefined) {
  if (value === undefined) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) reject("QUICKBOOKS_TAX_COMPANY_RESPONSE_INVALID");
  return value.normalize("NFC").trim();
}

/** Internal keyed fingerprints; never log or expose them as content-free diagnostics. */
export function quickBooksTaxFactFingerprints(keyMaterial: string, company: QuickBooksCompanyTaxInfo,
  preferences: QuickBooksTaxPreferences, customer: QuickBooksTaxCustomer, items: readonly QuickBooksTaxItem[]) {
  if (keyMaterial.trim().length < 32) reject("QUICKBOOKS_TAX_FACTS_KEY_UNAVAILABLE");
  const key = Buffer.from(hkdfSync("sha256", keyMaterial.trim(), "quotefly/quickbooks", "quotefly/quickbooks/tax-provider-facts/v1", 32));
  const fingerprint = (kind: string, tuple: unknown[]) => createHmac("sha256", key)
    .update(JSON.stringify(["quotefly.quickbooks.tax-provider-facts", 1, kind, ...tuple])).digest("hex");
  const addr = company.CompanyAddr;
  return {
    companyInfo: fingerprint("company", [company.Id, normalizeText(company.Country),
      addr === undefined ? null : [normalizeText(addr.Line1), normalizeText(addr.City), normalizeText(addr.Country),
        normalizeText(addr.CountrySubDivisionCode), normalizeText(addr.PostalCode)]]),
    preferences: fingerprint("preferences", [preferences.TaxPrefs === undefined ? null : [preferences.TaxPrefs.UsingSalesTax ?? null],
      preferences.SalesFormsPrefs === undefined ? null : [preferences.SalesFormsPrefs.AllowEstimates ?? null, preferences.SalesFormsPrefs.UsingProgressInvoicing ?? null],
      preferences.CurrencyPrefs === undefined ? null : [preferences.CurrencyPrefs.HomeCurrency?.value ?? null]]),
    customer: fingerprint("customer", [customer.Id, customer.SyncToken, customer.Active, customer.Taxable ?? null, customer.TaxExemptionReasonId ?? null]),
    items: items.map((item) => fingerprint("item", [item.Id, item.SyncToken, item.Active, item.Type,
      item.Taxable ?? null, item.TaxClassificationRef?.value ?? null])),
  };
}

async function checkConnection(prisma: PrismaClient, input: QuickBooksTaxProviderFactsInput) {
  return withTenantRlsContext(prisma, input.tenantId, async (tx) => {
    const connection = await tx.quickBooksConnection.findFirst({ where: {
      id: input.connection.id, tenantId: input.tenantId, realmId: input.connection.realmId,
      environment: input.connection.environment, connectedAtUtc: new Date(input.connection.connectedAtUtc),
      status: "CONNECTED", deletedAtUtc: null, disconnectRequestedAtUtc: null,
      setupConfirmedAtUtc: { not: null }, setupConfirmedByTenantUserId: { not: null },
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      scopes: { has: QUICKBOOKS_ACCOUNTING_SCOPE }, tenant: { deletedAtUtc: null },
      realmBinding: { is: { tenantId: input.tenantId, realmId: input.connection.realmId, active: true } },
    }, select: { setupConfirmedAtUtc: true, setupConfirmedByTenantUserId: true, scopes: true } });
    if (!connection || await currentQuickBooksConnectionGeneration(tx, input.tenantId) !== input.connection.generation) {
      reject("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED");
    }
    return JSON.stringify([connection.setupConfirmedAtUtc!.toISOString(), connection.setupConfirmedByTenantUserId, [...connection.scopes].sort()]);
  }, { maxWait: 5_000, timeout: 5_000, isolationLevel: "RepeatableRead" });
}

/** Stop scheduling on failure and drain already-started reads before propagating 401 to refresh. */
async function readPool(tasks: Array<() => Promise<void>>) {
  let cursor = 0;
  const failures: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (failures.length === 0 && cursor < tasks.length) {
      const task = tasks[cursor++];
      try { await task(); } catch (error) { failures.push(error); }
    }
  }));
  if (failures.length) throw failures.find((error) => error instanceof QuickBooksProviderError && error.statusCode === 401) ?? failures[0];
}

const providerCodes = new Set([
  "QUICKBOOKS_TAX_COMPANY_RESPONSE_INVALID", "QUICKBOOKS_TAX_PREFERENCES_RESPONSE_INVALID",
  "QUICKBOOKS_TAX_COMPANY_REALM_MISMATCH", "QUICKBOOKS_TAX_CUSTOMER_RESPONSE_INVALID",
  "QUICKBOOKS_TAX_CUSTOMER_ID_MISMATCH", "QUICKBOOKS_TAX_CUSTOMER_INACTIVE",
  "QUICKBOOKS_TAX_ITEM_RESPONSE_INVALID", "QUICKBOOKS_TAX_ITEM_ID_MISMATCH", "QUICKBOOKS_TAX_ITEM_INACTIVE",
  "QUICKBOOKS_TAX_ITEM_TYPE_UNSUPPORTED",
]);
/**
 * Internal GET-only reader for a trusted, already-authorized assembler. No route,
 * ledger signer, provider writer, tax eligibility proof or public serialization.
 * The 20s budget covers resource GETs, including a possible 401 replay. Credential
 * acquisition/refresh retains its existing configured timeouts and durable fences;
 * this is NOT an end-to-end request deadline. No custom credential callback is used.
 */
export async function readQuickBooksTaxProviderFacts(prisma: PrismaClient, runtimeEnv: QuickBooksCredentialRuntimeEnv,
  rawInput: QuickBooksTaxProviderFactsInput) {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) reject("QUICKBOOKS_TAX_FACTS_INPUT_INVALID");
  const input = parsed.data; // Immutable independent parsed copy; never retain caller-owned arrays.
  if (input.connection.environment !== runtimeEnv.QUICKBOOKS_ENVIRONMENT) reject("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED");
  const intents = new Map<string, "TAXABLE" | "NON_TAXABLE">();
  for (const line of input.lines) {
    if (intents.has(line.providerItemId) && intents.get(line.providerItemId) !== line.taxIntent) reject("QUICKBOOKS_TAX_FACTS_CONFLICTING_INTENTS");
    intents.set(line.providerItemId, line.taxIntent);
  }
  if (intents.size > 25) reject("QUICKBOOKS_TAX_FACTS_ITEM_LIMIT");
  if (runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim().length < 32) reject("QUICKBOOKS_TAX_FACTS_KEY_UNAVAILABLE");
  const ids = [...intents.keys()].sort();
  // Disable transport retries only here: maximum 28 resource GETs per callback.
  const readEnv = { ...runtimeEnv, QUICKBOOKS_PROVIDER_READ_RETRIES: 0 };
  let deadlineAtMs: number | undefined;
  try {
    const before = await checkConnection(prisma, input);
    const observed = await runQuickBooksProviderRequestWithRefresh({ prisma, runtimeEnv,
      connection: { id: input.connection.id, tenantId: input.tenantId, realmId: input.connection.realmId },
      operation: async (accessToken) => {
        deadlineAtMs ??= Date.now() + 20_000;
        const checkDeadline = () => { if (Date.now() >= deadlineAtMs!) reject("QUICKBOOKS_TAX_FACTS_DEADLINE"); };
        checkDeadline();
        const observedFromUtc = new Date().toISOString();
        const company = await fetchQuickBooksCompanyTaxInfo(readEnv, input.connection.realmId, accessToken, deadlineAtMs);
        const companyObservedAtUtc = new Date().toISOString();
        let preferences!: QuickBooksTaxPreferences;
        let customer!: QuickBooksTaxCustomer;
        let preferencesObservedAtUtc!: string;
        let customerObservedAtUtc!: string;
        const items: QuickBooksTaxItem[] = new Array(ids.length);
        const itemObservations: string[] = new Array(ids.length);
        await readPool([
          async () => { checkDeadline(); preferences = await fetchQuickBooksTaxPreferences(readEnv, input.connection.realmId, accessToken, deadlineAtMs); preferencesObservedAtUtc = new Date().toISOString(); },
          async () => { checkDeadline(); customer = await fetchQuickBooksTaxCustomer(readEnv, input.connection.realmId, accessToken, input.providerCustomerId, deadlineAtMs); customerObservedAtUtc = new Date().toISOString(); },
          ...ids.map((id, index) => async () => { checkDeadline(); items[index] = await fetchQuickBooksTaxItem(readEnv, input.connection.realmId, accessToken, id, deadlineAtMs); itemObservations[index] = new Date().toISOString(); }),
        ]);
        checkDeadline();
        return { company, preferences, customer, items, observedFromUtc, observedThroughUtc: new Date().toISOString(),
          companyObservedAtUtc, preferencesObservedAtUtc, customerObservedAtUtc, itemObservations };
      },
    });
    if (await checkConnection(prisma, input) !== before) reject("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED");
    const fingerprints = quickBooksTaxFactFingerprints(runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
      observed.company, observed.preferences, observed.customer, observed.items);
    const capabilities = evaluateQuickBooksTaxCapabilities(observed.company, observed.preferences);
    const customerClassification = observed.customer.Taxable === true && observed.customer.TaxExemptionReasonId == null ? "TAXABLE" as const : "UNKNOWN" as const;
    const blockers: string[] = [];
    if (!capabilities.companyPrerequisitesReady) blockers.push("COMPANY_PREREQUISITES_UNSUPPORTED");
    if (customerClassification === "UNKNOWN") blockers.push("CUSTOMER_TAX_STATUS_UNSUPPORTED");
    const items = observed.items.map((item, index) => {
      const classification = item.Taxable === true ? "TAXABLE" as const : item.Taxable === false ? "NON_TAXABLE" as const : "UNKNOWN" as const;
      if (classification === "UNKNOWN") blockers.push("ITEM_TAX_STATUS_UNSUPPORTED");
      else if (classification !== intents.get(item.Id)) blockers.push("ITEM_TAX_INTENT_MISMATCH");
      return { providerItemId: item.Id, providerSyncToken: item.SyncToken, observedAtUtc: observed.itemObservations[index],
        classification, fingerprint: fingerprints.items[index] };
    });
    return {
      customer: { providerCustomerId: observed.customer.Id, providerSyncToken: observed.customer.SyncToken,
        observedAtUtc: observed.customerObservedAtUtc, classification: customerClassification, fingerprint: fingerprints.customer },
      items, companyInfo: { observedAtUtc: observed.companyObservedAtUtc, fingerprint: fingerprints.companyInfo },
      preferences: { observedAtUtc: observed.preferencesObservedAtUtc, fingerprint: fingerprints.preferences }, capabilities,
      observedFromUtc: observed.observedFromUtc, observedThroughUtc: observed.observedThroughUtc,
      blockers: [...new Set(blockers)], providerFactsSupported: blockers.length === 0,
      automatedTaxCalculationProven: false as const, publishingAuthorized: false as const,
    };
  } catch (error) {
    if (error instanceof QuickBooksTaxProviderFactsError) throw error;
    if (error instanceof QuickBooksProviderError && providerCodes.has(error.code)) reject(error.code);
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) reject("QUICKBOOKS_TAX_FACTS_DEADLINE");
    reject("QUICKBOOKS_TAX_FACTS_READ_FAILED");
  }
}
