import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";
import { encryptQuickBooksSecret, fetchQuickBooksTaxCustomer, fetchQuickBooksTaxItem } from "../../src/services/quickbooks";
import { readQuickBooksTaxProviderFacts, quickBooksTaxFactFingerprints, type QuickBooksTaxProviderFactsInput } from "../../src/services/quickbooks-tax-provider-facts";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION, QUICKBOOKS_ACCOUNTING_SCOPE } from "../../src/services/quickbooks-setup";

const runtime: QuickBooksCredentialRuntimeEnv = {
  QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1000, QUICKBOOKS_PROVIDER_READ_RETRIES: 3,
  QUICKBOOKS_CLIENT_ID: "synthetic", QUICKBOOKS_CLIENT_SECRET: "synthetic", JWT_SECRET: "synthetic",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-tax-facts-key-material-at-least-32", QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "",
};
const input = (): QuickBooksTaxProviderFactsInput => ({ tenantId: "tenant", connection: { id: "connection", realmId: "123456", environment: "sandbox", connectedAtUtc: "2026-09-01T00:00:00.000Z", generation: 3 },
  providerCustomerId: "customer", lines: [{ providerItemId: "item", taxIntent: "TAXABLE" }] });
const company = () => ({ Id: "123456", Country: "US", CompanyAddr: { Line1: "123 Private St", City: "Private City", Country: "US", CountrySubDivisionCode: "CA", PostalCode: "94105" } });
const preferences = () => ({ TaxPrefs: { UsingSalesTax: true }, SalesFormsPrefs: { AllowEstimates: true, UsingProgressInvoicing: false }, CurrencyPrefs: { HomeCurrency: { value: "USD" } } });
const customer = () => ({ Id: "customer", SyncToken: "2", Active: true, Taxable: true });
const item = (id = "item") => ({ Id: id, SyncToken: "5", Active: true, Type: "Service" as const, Taxable: true, TaxClassificationRef: { value: "opaque-classification" } });
const fixedError = (code: string) => (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, code); assert.equal("cause" in error, false); return true; };

function database() {
  const row = { ...input().connection, tenantId: "tenant", connectedAtUtc: new Date(input().connection.connectedAtUtc), status: "CONNECTED", deletedAtUtc: null as Date | null, disconnectRequestedAtUtc: null as Date | null,
    setupConfirmedAtUtc: new Date("2026-09-02T00:00:00.000Z") as Date | null, setupConfirmedByTenantUserId: "manager" as string | null,
    setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION, scopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
    bindingActive: true, tenantDeleted: false, accessTokenEncrypted: encryptQuickBooksSecret(runtime, "synthetic-token-a"),
    refreshTokenEncrypted: encryptQuickBooksSecret(runtime, "synthetic-refresh"), accessTokenExpiresAtUtc: new Date(Date.now() + 3600000) };
  let activeTransactions = 0;
  let factsChecks = 0;
  let generation = 3;
  const tx = { $queryRaw: async () => [], quickBooksConnectionEvent: { findFirst: async () => ({ connectionGeneration: generation }) },
    quickBooksConnection: { findFirst: async ({ where, select }: any) => {
      if (select.scopes) {
        factsChecks++;
        assert.equal(where.tenantId, "tenant"); assert.equal(where.realmBinding.is.tenantId, "tenant");
        assert.equal(where.scopes.has, QUICKBOOKS_ACCOUNTING_SCOPE);
        if (row.id !== where.id || row.tenantId !== where.tenantId || row.realmId !== where.realmId || row.environment !== where.environment
          || row.connectedAtUtc.getTime() !== where.connectedAtUtc.getTime() || row.status !== "CONNECTED" || row.deletedAtUtc || row.disconnectRequestedAtUtc
          || !row.setupConfirmedAtUtc || !row.setupConfirmedByTenantUserId || row.setupChecklistVersion !== where.setupChecklistVersion
          || !row.scopes.includes(where.scopes.has) || !row.bindingActive || row.tenantDeleted) return null;
      }
      return { ...row };
    }, updateMany: async ({ data }: any) => { Object.assign(row, data); return { count: 1 }; } } };
  const prisma = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { activeTransactions++; try { return await fn(tx); } finally { activeTransactions--; } } } as unknown as PrismaClient;
  return { prisma, row, transactions: () => activeTransactions, checks: () => factsChecks, setGeneration: (value: number) => { generation = value; } };
}
function mockProvider(t: TestContext, db: ReturnType<typeof database>, override?: (url: string) => Promise<Response | undefined> | Response | undefined) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(db.transactions(), 0, "provider I/O cannot overlap a DB transaction");
    assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.body, undefined);
    calls.push(url);
    const replacement = await override?.(url); if (replacement) return replacement;
    let data: unknown;
    if (url.includes("/companyinfo/")) data = { CompanyInfo: { ...company(), CompanyName: "private-name" } };
    else if (url.endsWith("/preferences")) data = { Preferences: preferences() };
    else if (url.includes("/customer/")) data = { Customer: { ...customer(), PrimaryEmailAddr: { Address: "private@example.invalid" } } };
    else data = { Item: { ...item(decodeURIComponent(url.split("/").at(-1)!)), Name: "private-item", UnitPrice: 123 } };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return calls;
}

it("returns only bound, stripped facts and false authority flags through the real credential wrapper", async (t) => {
  const db = database(); const calls = mockProvider(t, db);
  const result = await readQuickBooksTaxProviderFacts(db.prisma, runtime, input());
  assert.ok(result); assert.equal(result.providerFactsSupported, true); assert.equal(result.publishingAuthorized, false); assert.equal(result.automatedTaxCalculationProven, false);
  assert.equal(db.checks(), 2); assert.equal(calls.length, 4); assert.ok(calls[0].includes("/companyinfo/"));
  for (const secret of ["private", "opaque-classification", "123456", "synthetic-token", "94105", "ExemptionReason", "TaxClassificationRef"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

it("rejects malformed identity, version, activity and tax-only fields without returning provider data", async (t) => {
  for (const [kind, changes, code] of [
    ["Customer", { Id: "other" }, "CUSTOMER_ID_MISMATCH"], ["Customer", { Id: " customer" }, "CUSTOMER_RESPONSE_INVALID"],
    ["Customer", { SyncToken: "-1" }, "CUSTOMER_RESPONSE_INVALID"], ["Customer", { SyncToken: "1".repeat(65) }, "CUSTOMER_RESPONSE_INVALID"],
    ["Customer", { Active: undefined }, "CUSTOMER_RESPONSE_INVALID"], ["Customer", { Active: false }, "CUSTOMER_INACTIVE"],
    ["Customer", { Taxable: "true" }, "CUSTOMER_RESPONSE_INVALID"], ["Customer", { TaxExemptionReasonId: {} }, "CUSTOMER_RESPONSE_INVALID"],
    ["Item", { Id: "item\n" }, "ITEM_RESPONSE_INVALID"], ["Item", { SyncToken: undefined }, "ITEM_RESPONSE_INVALID"],
    ["Item", { Active: false }, "ITEM_INACTIVE"], ["Item", { Type: "Inventory" }, "ITEM_TYPE_UNSUPPORTED"],
    ["Item", { Type: "invented" }, "ITEM_RESPONSE_INVALID"], ["Item", { Type: undefined }, "ITEM_RESPONSE_INVALID"],
    ["Item", { TaxClassificationRef: { value: " invalid " } }, "ITEM_RESPONSE_INVALID"], ["Item", { TaxClassificationRef: null }, "ITEM_RESPONSE_INVALID"],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ [kind]: { ...(kind === "Customer" ? customer() : item()), ...changes } })));
    const promise = kind === "Customer" ? fetchQuickBooksTaxCustomer(runtime, "123456", "synthetic", "customer") : fetchQuickBooksTaxItem(runtime, "123456", "synthetic", "item");
    await assert.rejects(promise, fixedError(`QUICKBOOKS_TAX_${code}`)); t.mock.restoreAll();
  }
});

it("never rewrites opaque IDs and rejects invalid requests before I/O", async (t) => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  for (const id of ["", ".", "..", " x", "x y", "x\u200b", "x".repeat(192)]) await assert.rejects(fetchQuickBooksTaxCustomer(runtime, "123456", "synthetic", id), fixedError("QUICKBOOKS_TAX_FACTS_INPUT_INVALID"));
  assert.equal(calls, 0);
});

it("requires explicitly taxable customer without exemption reason and never infers EXEMPT", async (t) => {
  for (const changes of [{ Taxable: false }, { Taxable: undefined }, { TaxExemptionReasonId: "reason-secret" }]) {
    const db = database(); mockProvider(t, db, (url) => url.includes("/customer/") ? new Response(JSON.stringify({ Customer: { ...customer(), ...changes } })) : undefined);
    const result = await readQuickBooksTaxProviderFacts(db.prisma, runtime, input()); assert.ok(result);
    assert.equal(result.customer.classification, "UNKNOWN"); assert.equal(result.providerFactsSupported, false); assert.ok(result.blockers.includes("CUSTOMER_TAX_STATUS_UNSUPPORTED"));
    assert.equal(JSON.stringify(result).includes("reason-secret"), false); t.mock.restoreAll();
  }
});

it("requires exact line intent match, accepts absent classification ref without entitlement inference", async (t) => {
  for (const [taxable, intent, expected] of [[true, "NON_TAXABLE", "ITEM_TAX_INTENT_MISMATCH"], [false, "TAXABLE", "ITEM_TAX_INTENT_MISMATCH"], [undefined, "TAXABLE", "ITEM_TAX_STATUS_UNSUPPORTED"], [false, "NON_TAXABLE", null]] as const) {
    const db = database(); mockProvider(t, db, (url) => url.includes("/item/") ? new Response(JSON.stringify({ Item: { ...item(), Taxable: taxable, TaxClassificationRef: undefined } })) : undefined);
    const request = input(); request.lines[0].taxIntent = intent;
    const result = await readQuickBooksTaxProviderFacts(db.prisma, runtime, request); assert.ok(result);
    assert.equal(result.providerFactsSupported, expected === null); if (expected) assert.ok(result.blockers.includes(expected));
    assert.equal(result.automatedTaxCalculationProven, false); t.mock.restoreAll();
  }
});

it("deduplicates and sorts 25 items, rejects 26 and conflicting intents before provider/DB reads", async (t) => {
  const db = database(); const calls = mockProvider(t, db); const request = input();
  request.lines = Array.from({ length: 25 }, (_, i) => ({ providerItemId: `item-${24 - i}`, taxIntent: "TAXABLE" }));
  request.lines.push({ ...request.lines[0] });
  const result = await readQuickBooksTaxProviderFacts(db.prisma, runtime, request); assert.ok(result);
  assert.equal(calls.length, 28); assert.deepEqual(result.items.map((entry) => entry.providerItemId), [...new Set(request.lines.map((entry) => entry.providerItemId))].sort());
  request.lines.push({ providerItemId: "extra", taxIntent: "TAXABLE" });
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, request), fixedError("QUICKBOOKS_TAX_FACTS_ITEM_LIMIT"));
  const conflicting = input(); conflicting.lines.push({ providerItemId: "item", taxIntent: "NON_TAXABLE" });
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, conflicting), fixedError("QUICKBOOKS_TAX_FACTS_CONFLICTING_INTENTS"));
  assert.equal(calls.length, 28); assert.equal(db.checks(), 2);
});

it("bounds concurrency to four and drains started reads after failure without scheduling more", async (t) => {
  const db = database(); let active = 0; let peak = 0; let started = 0;
  const calls = mockProvider(t, db, async (url) => {
    if (url.includes("/companyinfo/")) return;
    active++; peak = Math.max(peak, active); started++;
    await new Promise((resolve) => setTimeout(resolve, url.endsWith("/preferences") ? 1 : 15));
    active--;
    if (url.endsWith("/preferences")) return new Response("sensitive-provider-prose", { status: 500 });
  });
  const request = input(); request.lines = Array.from({ length: 25 }, (_, i) => ({ providerItemId: `item-${i}`, taxIntent: "TAXABLE" }));
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, request), fixedError("QUICKBOOKS_TAX_FACTS_READ_FAILED"));
  assert.equal(peak, 4); assert.equal(started, 4); assert.equal(active, 0); assert.equal(calls.length, 5); assert.equal(db.checks(), 1);
});

it("discards observations when any connection fence drifts, and rejects the same pre-read states", async (t) => {
  const drifts: Array<(db: ReturnType<typeof database>) => void> = [
    (db) => { db.row.realmId = "other"; }, (db) => { db.row.environment = "production"; },
    (db) => { db.row.connectedAtUtc = new Date("2026-09-03"); }, (db) => db.setGeneration(4),
    (db) => { db.row.scopes = []; }, (db) => { db.row.setupConfirmedAtUtc = null; },
    (db) => { db.row.setupConfirmedAtUtc = new Date("2026-09-03"); }, (db) => { db.row.setupConfirmedByTenantUserId = "other-manager"; },
    (db) => { db.row.setupChecklistVersion = "old"; }, (db) => { db.row.disconnectRequestedAtUtc = new Date(); },
    (db) => { db.row.deletedAtUtc = new Date(); }, (db) => { db.row.status = "NEEDS_REAUTH"; },
    (db) => { db.row.bindingActive = false; }, (db) => { db.row.tenantDeleted = true; },
  ];
  for (const drift of drifts) {
    const db = database(); mockProvider(t, db, (url) => { if (url.includes("/item/")) drift(db); return undefined; });
    await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, input()), fixedError("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED")); t.mock.restoreAll();
  }
  for (const drift of drifts.filter((_, index) => ![6, 7].includes(index))) {
    const db = database(); drift(db); const calls = mockProvider(t, db);
    await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, input()), fixedError("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED")); assert.equal(calls.length, 0); t.mock.restoreAll();
  }
});

it("replays 401 via existing wrapper after draining, sharing original deadline", async (t) => {
  const db = database(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  let unauthorized = true; let active = 0;
  const calls = mockProvider(t, db, async (url) => {
    if (url.includes("/companyinfo/")) { assert.equal(active, 0); return; }
    active++; await new Promise((resolve) => setImmediate(resolve)); active--;
    if (url.endsWith("/preferences") && unauthorized) {
      unauthorized = false; now += 19_000;
      db.row.accessTokenEncrypted = encryptQuickBooksSecret(runtime, "synthetic-token-b");
      return new Response("private-401", { status: 401 });
    }
  });
  const result = await readQuickBooksTaxProviderFacts(db.prisma, runtime, input()); assert.ok(result);
  assert.equal(calls.filter((url) => url.includes("/companyinfo/")).length, 2);
  t.mock.restoreAll();
});

it("expired resource deadline after credential refresh forbids even first replay GET", async (t) => {
  const db = database(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  const calls = mockProvider(t, db, (url) => {
    if (url.includes("/companyinfo/")) {
      db.row.accessTokenEncrypted = encryptQuickBooksSecret(runtime, "synthetic-token-b");
      // Move the clock during the next credential read, after transport has preserved 401.
      const original = db.prisma.$transaction;
      db.prisma.$transaction = (async (...args: any[]) => { now += 20_001; return (original as any)(...args); }) as any;
      return new Response("private-401", { status: 401 });
    }
  });
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, input()), fixedError("QUICKBOOKS_TAX_FACTS_DEADLINE"));
  assert.equal(calls.length, 1);
});

it("fingerprints ignore PII and timestamps but bind every projected material field and key", () => {
  const base = quickBooksTaxFactFingerprints(runtime.QUICKBOOKS_TOKEN_ENCRYPTION_KEY, company(), preferences(), customer(), [item()]);
  const extended = quickBooksTaxFactFingerprints(runtime.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
    { ...company(), CompanyName: "private", MetaData: { LastUpdatedTime: "now" } } as any,
    { ...preferences(), Other: "private" } as any, { ...customer(), DisplayName: "private", MetaData: { LastUpdatedTime: "now" } } as any,
    [{ ...item(), UnitPrice: 99, Name: "private" } as any]);
  assert.deepEqual(base, extended);
  const hash = (c = company(), p = preferences(), cu: any = customer(), items: any = [item()], key = runtime.QUICKBOOKS_TOKEN_ENCRYPTION_KEY) => quickBooksTaxFactFingerprints(key, c, p, cu, items);
  for (const [field, value] of Object.entries({ Id: "new", SyncToken: "3", Active: false, Taxable: false, TaxExemptionReasonId: "reason" })) assert.notEqual(hash(undefined, undefined, { ...customer(), [field]: value }).customer, base.customer);
  for (const [field, value] of Object.entries({ Id: "new", SyncToken: "6", Active: false, Type: "NonInventory", Taxable: false, TaxClassificationRef: { value: "new-ref" } })) assert.notEqual(hash(undefined, undefined, undefined, [{ ...item(), [field]: value }]).items[0], base.items[0]);
  for (const field of ["Line1", "City", "Country", "CountrySubDivisionCode", "PostalCode"]) assert.notEqual(hash({ ...company(), CompanyAddr: { ...company().CompanyAddr, [field]: "changed" } }).companyInfo, base.companyInfo);
  for (const change of [{ ...company(), Id: "other" }, { ...company(), Country: "CA" }]) assert.notEqual(hash(change).companyInfo, base.companyInfo);
  for (const p of [{ ...preferences(), TaxPrefs: { UsingSalesTax: false } }, { ...preferences(), SalesFormsPrefs: { AllowEstimates: false, UsingProgressInvoicing: false } }, { ...preferences(), SalesFormsPrefs: { AllowEstimates: true, UsingProgressInvoicing: true } }, { ...preferences(), CurrencyPrefs: { HomeCurrency: { value: "CAD" } } }]) assert.notEqual(hash(undefined, p).preferences, base.preferences);
  assert.notDeepEqual(hash(undefined, undefined, undefined, undefined, "different-synthetic-material-at-least-32"), base);
  assert.equal(hash({ ...company(), CompanyAddr: { ...company().CompanyAddr, Line1: " 123 Private St " } }).companyInfo, base.companyInfo);
});


it("keeps the first resource deadline on successful credential replay instead of granting another 20 seconds", async (t) => {
  const db = database(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  let companyCalls = 0;
  const calls = mockProvider(t, db, (url) => {
    if (url.includes("/companyinfo/")) {
      companyCalls++;
      if (companyCalls === 1) {
        now += 19_000;
        db.row.accessTokenEncrypted = encryptQuickBooksSecret(runtime, "synthetic-token-b");
        return new Response("private-401", { status: 401 });
      }
      now += 1_001;
    }
  });
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, input()), fixedError("QUICKBOOKS_TAX_FACTS_DEADLINE"));
  assert.equal(companyCalls, 2); assert.equal(calls.length, 2);
});

it("validates the input line cap and environment before any reads", async (t) => {
  const db = database(); const calls = mockProvider(t, db);
  const tooMany = input(); tooMany.lines = Array.from({ length: 501 }, () => ({ ...input().lines[0] }));
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, tooMany), fixedError("QUICKBOOKS_TAX_FACTS_INPUT_INVALID"));
  const wrongEnv = input(); wrongEnv.connection.environment = "production";
  await assert.rejects(readQuickBooksTaxProviderFacts(db.prisma, runtime, wrongEnv), fixedError("QUICKBOOKS_TAX_FACTS_CONNECTION_CHANGED"));
  assert.equal(db.checks(), 0); assert.equal(calls.length, 0);
});

it("rejects every recognized non-Service type without coercing its documented spelling", async (t) => {
  for (const type of ["Assembly", "Category", "Fixed Asset", "Group", "Inventory", "NonInventory", "Other Charge", "Payment", "Subtotal", "Discount", "Tax", "Tax Group"]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ Item: { ...item(), Type: type } })));
    await assert.rejects(fetchQuickBooksTaxItem(runtime, "123456", "synthetic", "item"), fixedError("QUICKBOOKS_TAX_ITEM_TYPE_UNSUPPORTED"));
    t.mock.restoreAll();
  }
});


it("rejects control characters in fingerprinted human address text consistent with review normalization", () => {
  assert.throws(() => quickBooksTaxFactFingerprints(runtime.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
    { ...company(), CompanyAddr: { ...company().CompanyAddr, Line1: "private\naddress" } }, preferences(), customer(), [item()]),
    fixedError("QUICKBOOKS_TAX_COMPANY_RESPONSE_INVALID"));
});


it("preserves allowed opaque punctuation in the exact encoded entity path", async (t) => {
  const providerId = "opaque.a-b_c:/?%#@!";
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    paths.push(new URL(url).pathname);
    return new Response(JSON.stringify(url.includes("/customer/")
      ? { Customer: { ...customer(), Id: providerId } }
      : { Item: { ...item(), Id: providerId } }));
  });
  assert.equal((await fetchQuickBooksTaxCustomer(runtime, "123456", "synthetic", providerId)).Id, providerId);
  assert.equal((await fetchQuickBooksTaxItem(runtime, "123456", "synthetic", providerId)).Id, providerId);
  assert.deepEqual(paths, [
    `/v3/company/123456/customer/${encodeURIComponent(providerId)}`,
    `/v3/company/123456/item/${encodeURIComponent(providerId)}`,
  ]);
});
