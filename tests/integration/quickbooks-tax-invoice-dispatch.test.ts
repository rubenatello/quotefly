import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import { assembleReviewedTaxEstimate, claimReviewedTaxEstimate, finalizeTaxEstimateSandboxProof, retainTaxEstimateIdentity } from "../../src/services/quickbooks-tax-estimate-ledger";
import { encryptQuickBooksSecret } from "../../src/services/quickbooks";
import { dispatchReviewedQuickBooksTaxInvoiceOnce } from "../../src/services/quickbooks-tax-invoice-dispatch";
import * as taxInvoiceLedger from "../../src/services/quickbooks-tax-invoices";
import type { TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";
import { readQuickBooksTaxProviderFacts } from "../../src/services/quickbooks-tax-provider-facts";
import { confirmInvoiceTaxContext } from "../../src/services/quickbooks-tax-context";
import { contextInput, syntheticFacts, syntheticReview, testRuntime } from "../helpers/tax-review-fixture";
vi.mock("../../src/services/quickbooks-tax-provider-facts", () => ({ readQuickBooksTaxProviderFacts: vi.fn() }));
const keys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-tax-invoice-lifecycle-key-for-tests-only" };
const sources = new Map<string, TaxReviewSource>();
const tenantIds: string[] = [];
const userIds: string[] = [];

const runtimePrisma = new Proxy(prisma, {
  get(target, property) {
    if (property === "$transaction") {
      return <T>(action: (tx: Prisma.TransactionClient) => Promise<T>, options?: {
        maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel;
      }) => target.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
        return action(tx);
      }, options);
    }
    return Reflect.get(target, property);
  },
}) as PrismaClient;

async function fixture() {
  const stamp = randomUUID();
  const observed = new Date();
  const tenant = await prisma.tenant.create({ data: { name: "Tax Invoice lifecycle", slug: stamp } });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, fullName: "Tax Invoice owner", passwordHash: "synthetic" } });
  userIds.push(user.id);
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, fullName: "Synthetic taxable customer", phone: stamp } });
  const quote = await prisma.quote.create({ data: { tenantId: tenant.id, customerId: customer.id, status: "ACCEPTED", serviceType: "PLUMBING", title: "Synthetic taxable quote", scopeText: "Synthetic", internalCostSubtotal: 10, customerPriceSubtotal: 100, taxAmount: 8, totalAmount: 108 } });
  const job = await prisma.job.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobNumber: 1, title: "Synthetic taxable job", scopeSnapshot: "Synthetic", serviceType: "PLUMBING", acceptedAtUtc: observed } });
  const invoice = await prisma.invoice.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 1, titleSnapshot: "Synthetic taxable invoice", subtotalAmount: 100, taxAmount: 8, totalAmount: 108, balanceDue: 108, dueAtUtc: new Date(Date.now() + 86_400_000) } });
  const line = await prisma.invoiceLineItem.create({ data: { tenantId: tenant.id, invoiceId: invoice.id, description: "Synthetic materials", quantity: 2, unitPrice: 50, lineTotal: 100, position: 0 } });
  const connection = await prisma.quickBooksConnection.create({ data: { tenantId: tenant.id, realmId: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`, environment: "sandbox", status: "CONNECTED", connectedAtUtc: observed, scopes: ["com.intuit.quickbooks.accounting"], setupConfirmedAtUtc: observed, setupConfirmedByTenantUserId: member.id, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION } });
  await prisma.quickBooksRealmBinding.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: connection.realmId, active: true } });
  const customerMap = await prisma.quickBooksCustomerMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, customerId: customer.id, quickBooksCustomerId: "42", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const itemMap = await prisma.quickBooksItemMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, itemKey: "synthetic materials", quickBooksItemId: "51", quickBooksItemName: "Synthetic materials", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const source: TaxReviewSource = {
    contractVersion: 2, tenantId: tenant.id, invoiceId: invoice.id, invoiceVersion: invoice.version,
    customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id,
    invoiceTaxContext: { id: "pending", revision: 1, inputHash: "d".repeat(64), confirmedByTenantUserId: member.id, confirmedAtUtc: observed.toISOString() },
    transactionDate: observed.toISOString().slice(0, 10), currency: "USD",
    subtotal: "100.00", quotedTax: "8.00", total: "108.00",
    connection: { id: connection.id, realmId: connection.realmId, connectedAtUtc: observed.toISOString(), generation: 1, environment: "sandbox" },
    customerMapping: { id: customerMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "42" },
    customerFacts: { providerCustomerId: "42", providerSyncToken: "0", observedAtUtc: observed.toISOString(), exemption: "TAXABLE", exemptionReasonId: null, fingerprint: "e".repeat(64) },
    origin: { Line1: "123 Synthetic Origin", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" },
    destination: { Line1: "456 Synthetic Destination", City: "Los Angeles", CountrySubDivisionCode: "CA", PostalCode: "90001", Country: "US" },
    preferences: { observedAtUtc: observed.toISOString(), fingerprint: "a".repeat(64), companyInfoFingerprint: "b".repeat(64), companyObservedAtUtc: observed.toISOString(), capabilities: { companyPrerequisitesReady: true, automatedTaxCalculationProven: false, usCompany: true, companyAddressComplete: true, salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [] } },
    lines: [{ invoiceLineItemId: line.id, position: 0, description: "Synthetic materials", quantity: "2.00", unitPrice: "50.00", amount: "100.00", taxIntent: "TAXABLE", itemMapping: { id: itemMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "51" }, itemFacts: { providerItemId: "51", providerSyncToken: "0", observedAtUtc: observed.toISOString(), taxClassificationFingerprint: "c".repeat(64) } }],
  };
  const actor = { tenantId: tenant.id, userId: user.id, authVersion: 0, requestId: randomUUID() };
  return { tenant, user, member, customer, quote, job, invoice, connection, source, actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function canonicalEstimate(f: Fixture) {
  await confirmInvoiceTaxContext(runtimePrisma, f.actor, "sandbox", contextInput(f.source));
  const context = await prisma.invoiceTaxContext.findFirstOrThrow({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id, supersededAtUtc: null } });
  f.source.invoiceTaxContext = { id: context.id, revision: context.revision, inputHash: context.inputHash, confirmedByTenantUserId: context.confirmedByTenantUserId, confirmedAtUtc: context.confirmedAtUtc.toISOString() };
  sources.set(f.tenant.id, f.source);
  const row = await assembleReviewedTaxEstimate(runtimePrisma, f.actor, testRuntime(keys), { invoiceId: f.invoice.id, expectedContextRevision: context.revision });
  const claim = await claimReviewedTaxEstimate(runtimePrisma, f.actor, testRuntime(keys), row.id);
  if (claim.outcome !== "CLAIMED") throw new Error("Expected tax Estimate claim");
  const attempt = { tenantId: f.tenant.id, operationId: row.id, estimateRequestId: claim.estimateRequestId, sourceHash: claim.sourceHash, claimToken: claim.claimToken };
  const identity = { providerEstimateId: `estimate-${randomUUID()}`, providerEstimateSyncToken: "0", providerEstimateUpdatedAtUtc: "2026-10-03T20:00:00.000Z" };
  await retainTaxEstimateIdentity(runtimePrisma, attempt, identity);
  const estimate = { Id: identity.providerEstimateId, SyncToken: identity.providerEstimateSyncToken, MetaData: { LastUpdatedTime: identity.providerEstimateUpdatedAtUtc }, ...structuredClone(syntheticReview(f.source, keys).estimateAst), TxnTaxDetail: { TotalTax: 8 }, TotalAmt: 108 };
  await finalizeTaxEstimateSandboxProof(runtimePrisma, testRuntime(keys), attempt, estimate);
  return { row: await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } }), estimate };
}
function invoiceProjection(estimate: Record<string, unknown>, providerInvoiceId: string) {
  const { Id: estimateId, SyncToken: _sync, MetaData: _meta, TxnTaxDetail, TotalAmt, ...ast } = estimate;
  return { Id: providerInvoiceId, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-10-03T20:01:00.000Z" }, ...ast, TxnTaxDetail, TotalAmt, LinkedTxn: [{ TxnId: estimateId, TxnType: "Estimate" }] };
}


describe("QuickBooks tax Invoice one-shot dispatcher", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const runtime = { ...testRuntime(keys), QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true, QUICKBOOKS_OAUTH_ONLY_MODE: false };
  beforeAll(() => {
    fetchSpy.mockRejectedValue(new Error("Unexpected provider request"));
    vi.mocked(readQuickBooksTaxProviderFacts).mockImplementation(async (_client, _env, input) => {
      const source = sources.get(input.tenantId);
      if (!source) throw new Error("Missing synthetic provider facts");
      return syntheticFacts(source);
    });
  });
  afterEach(() => { fetchSpy.mockReset(); fetchSpy.mockRejectedValue(new Error("Unexpected provider request")); });
  afterAll(async () => {
    fetchSpy.mockRestore();
    await prisma.quickBooksInvoiceOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.invoiceTaxContextLine.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.invoiceTaxContext.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  async function ready() {
    const f = await fixture(), canonical = await canonicalEstimate(f);
    await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: {
      accessTokenEncrypted: encryptQuickBooksSecret(runtime, "synthetic-dispatch-access-token"),
      accessTokenExpiresAtUtc: new Date(Date.now() + 3_600_000),
    } });
    const command = { taxEstimateOperationId: canonical.row.id, idempotencyKey: randomUUID() };
    return { f, canonical, command, run: () => dispatchReviewedQuickBooksTaxInvoiceOnce({ prisma: runtimePrisma, actor: f.actor, runtimeEnv: runtime, command }) };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function transport(r: Awaited<ReturnType<typeof ready>>, options: { postStatus?: number; postThrows?: boolean; postResponse?: () => Response; readFails?: boolean; numbering?: boolean; drift?: boolean; postDrift?: boolean } = {}) {
    const invoiceId = "invoice-" + randomUUID(), calls: string[] = [];
    fetchSpy.mockImplementation(async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      calls.push(method + " " + url.pathname);
      expect(url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
      if (url.pathname.endsWith("/preferences")) return json({ Preferences: { SalesFormsPrefs: { CustomTxnNumbers: options.numbering !== false } } });
      if (url.pathname.endsWith("/query")) {
        if (options.drift) await prisma.user.update({ where: { id: r.f.user.id }, data: { authVersion: 1 } });
        return json({ QueryResponse: {} });
      }
      if (method === "POST" && url.pathname.endsWith("/invoice")) {
        expect(url.searchParams.get("requestid")).toBe(r.canonical.row.invoiceRequestId);
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ EmailStatus: "NotSet", AllowOnlineACHPayment: false, AllowOnlineCreditCardPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false });
        expect(body).not.toHaveProperty("BillEmail"); expect(body).not.toHaveProperty("AllowOnlinePayment");
        if (options.postThrows) throw new TypeError("Synthetic uncertain transport");
        if (options.postDrift) await prisma.user.update({ where: { id: r.f.user.id }, data: { authVersion: 1 } });
        if (options.postResponse) return options.postResponse();
        return options.postStatus ? json({ Fault: { type: "synthetic" } }, options.postStatus) : json({ Invoice: { Id: invoiceId } });
      }
      const operation = await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } });
      expect(operation.providerInvoiceId).toBe(invoiceId);
      expect(operation.status).toBe("RECONCILIATION_REQUIRED");
      if (options.readFails) return json({ Fault: { type: "synthetic" } }, 500);
      if (url.pathname.endsWith("/invoice/" + invoiceId)) return json({ Invoice: { ...invoiceProjection(r.canonical.estimate, invoiceId), EmailStatus: "NotSet", AllowOnlineACHPayment: false, AllowOnlineCreditCardPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false } });
      if (url.pathname.endsWith("/estimate/" + r.canonical.estimate.Id)) return json({ Estimate: r.canonical.estimate });
      throw new Error("Unexpected synthetic endpoint");
    });
    return { calls, invoiceId, posts: () => calls.filter(x => x.startsWith("POST ")) };
  }
  test("disabled and OAuth-only modes make no provider request or durable claim", async () => {
    const r = await ready();
    for (const flags of [{ QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: false }, { QUICKBOOKS_OAUTH_ONLY_MODE: true }]) {
      expect(await dispatchReviewedQuickBooksTaxInvoiceOnce({ prisma: runtimePrisma, actor: r.f.actor, runtimeEnv: { ...runtime, ...flags }, command: r.command })).toMatchObject({ outcome: "DISABLED", providerCreateAttempted: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: r.f.tenant.id } })).toBe(0);
  });
  test("concurrent commands create once, retain identity before GET and keep matched evidence quarantined", async () => {
    const r = await ready(), mock = transport(r);
    const results = await Promise.all([r.run(), r.run()]);
    expect(results.filter(x => x.outcome === "EVIDENCE_RECORDED")).toHaveLength(1);
    expect(results.filter(x => x.outcome === "EXISTING_ATTEMPT")).toHaveLength(1);
    expect(mock.posts()).toHaveLength(1);
    expect(await r.run()).toMatchObject({ outcome: "EXISTING_ATTEMPT", publishingAuthorized: false });
    expect(mock.posts()).toHaveLength(1);
    const operation = await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } });
    expect(operation).toMatchObject({ status: "RECONCILIATION_REQUIRED", attemptCount: 1, providerInvoiceId: mock.invoiceId });
    expect(operation.taxCanonicalInvoiceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: r.f.invoice.id } })).status).toBe("DRAFT");
  });
  test("foreign tenant and caller-supplied payload fail before credentials, claims or provider I/O", async () => {
    const r = await ready(), foreign = await fixture();
    await expect(dispatchReviewedQuickBooksTaxInvoiceOnce({ prisma: runtimePrisma, actor: foreign.actor,
      runtimeEnv: runtime, command: r.command })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_OPERATION_NOT_FOUND" });
    await expect(dispatchReviewedQuickBooksTaxInvoiceOnce({ prisma: runtimePrisma, actor: r.f.actor,
      runtimeEnv: runtime, command: { ...r.command, payload: { AllowOnlineACHPayment: true } } }))
      .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: { in: [r.f.tenant.id, foreign.tenant.id] } } })).toBe(0);
  });
  test("authority drift during CREATE preserves returned identity but blocks subsequent GETs", async () => {
    const r = await ready(), mock = transport(r, { postDrift: true });
    expect(await r.run()).toMatchObject({ outcome: "IDENTITY_RETAINED_READBACK_PENDING",
      providerIdentityRetained: true, recoveryStatePersisted: true, publishingAuthorized: false });
    expect(mock.calls).toHaveLength(3); expect(mock.posts()).toHaveLength(1);
    expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } }))
      .toMatchObject({ providerInvoiceId: mock.invoiceId, status: "RECONCILIATION_REQUIRED", taxCanonicalInvoiceHash: null });
  });
  for (const postStatus of [401, 408, 429, 500]) test("uncertain CREATE " + postStatus + " is never replayed or refreshed", async () => {
    const r = await ready(), mock = transport(r, { postStatus });
    expect(await r.run()).toMatchObject({ outcome: "RESULT_UNKNOWN", providerCreateAttempted: true, recoveryStatePersisted: true, publishingAuthorized: false });
    expect(mock.posts()).toHaveLength(1); expect(mock.calls).toHaveLength(3);
    expect(await r.run()).toMatchObject({ outcome: "EXISTING_ATTEMPT" }); expect(mock.posts()).toHaveLength(1);
    expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } })).toMatchObject({ status: "RECONCILIATION_REQUIRED", attemptCount: 1, providerInvoiceId: null, lastFailureCode: "QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN" });
  });
  test("transport ambiguity leaves one durable attempt without provider replay", async () => {
    const r = await ready(), mock = transport(r, { postThrows: true });
    expect(await r.run()).toMatchObject({ outcome: "RESULT_UNKNOWN", recoveryStatePersisted: true });
    expect(mock.posts()).toHaveLength(1);
  });
  test("fallback quarantine preserves a known provider identity after the first retention write fails", async () => {
    const r = await ready(), mock = transport(r);
    const retention = vi.spyOn(taxInvoiceLedger, "retainCreatedQuickBooksTaxInvoiceIdentity")
      .mockRejectedValueOnce(new Error("Synthetic transient retention failure"));
    try {
      expect(await r.run()).toMatchObject({ outcome: "IDENTITY_RETAINED_READBACK_PENDING",
        providerIdentityRetained: true, recoveryStatePersisted: true });
      expect(mock.posts()).toHaveLength(1);
      expect(mock.calls).toHaveLength(3);
      expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } }))
        .toMatchObject({ providerInvoiceId: mock.invoiceId, status: "RECONCILIATION_REQUIRED",
          lastFailureCode: "QUICKBOOKS_TAX_INVOICE_IDENTITY_RETENTION_PENDING" });
      expect(await r.run()).toMatchObject({ outcome: "EXISTING_ATTEMPT" });
      expect(mock.posts()).toHaveLength(1);
    } finally { retention.mockRestore(); }
  });
  test("fallback retention is idempotent after an ambiguous database commit and rejects a conflicting ID", async () => {
    const r = await ready(), mock = transport(r);
    const retain = taxInvoiceLedger.retainCreatedQuickBooksTaxInvoiceIdentity;
    const retention = vi.spyOn(taxInvoiceLedger, "retainCreatedQuickBooksTaxInvoiceIdentity")
      .mockImplementationOnce(async (client, input) => {
        await retain(client, input);
        throw new Error("Synthetic lost commit acknowledgement");
      });
    try {
      expect(await r.run()).toMatchObject({ outcome: "IDENTITY_RETAINED_READBACK_PENDING",
        providerIdentityRetained: true, recoveryStatePersisted: true });
      const retainedInput = retention.mock.calls[0]![1] as Record<string, unknown>;
      await expect(taxInvoiceLedger.quarantineQuickBooksTaxInvoiceAttempt(runtimePrisma,
        { ...retainedInput, providerInvoiceId: "conflicting-invoice", failureCode: "SYNTHETIC_FAILURE" }))
        .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_CONFLICT" });
      expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } }))
        .toMatchObject({ providerInvoiceId: mock.invoiceId, status: "RECONCILIATION_REQUIRED" });
      expect(await r.run()).toMatchObject({ outcome: "EXISTING_ATTEMPT" });
      expect(mock.posts()).toHaveLength(1);
      expect(mock.calls).toHaveLength(3);
    } finally { retention.mockRestore(); }
  });
  for (const oversized of [false, true]) test("CREATE response " + (oversized ? "overflow" : "stall") + " is bounded and quarantined without replay", async () => {
    const r = await ready();
    let cancellations = 0;
    const mock = transport(r, { postResponse: () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancellations += 1; return new Promise<void>(() => {}); },
    }), { status: 200, ...(oversized ? { headers: { "content-length": String(4 * 1024 * 1024 + 1) } } : {}) }) });
    expect(await dispatchReviewedQuickBooksTaxInvoiceOnce({ prisma: runtimePrisma, actor: r.f.actor,
      runtimeEnv: { ...runtime, QUICKBOOKS_PROVIDER_TIMEOUT_MS: 50 }, command: r.command }))
      .toMatchObject({ outcome: "RESULT_UNKNOWN", providerCreateAttempted: true, recoveryStatePersisted: true });
    expect(cancellations).toBe(1);
    expect(mock.posts()).toHaveLength(1);
    expect(await r.run()).toMatchObject({ outcome: "EXISTING_ATTEMPT" });
    expect(mock.posts()).toHaveLength(1);
    expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } }))
      .toMatchObject({ status: "RECONCILIATION_REQUIRED", attemptCount: 1, providerInvoiceId: null,
        lastFailureCode: "QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: r.f.invoice.id } })).status).toBe("DRAFT");
  });
  for (const mode of ["numbering", "authority"] as const) test(mode + " failure before CREATE sends no POST", async () => {
    const r = await ready(), mock = transport(r, mode === "numbering" ? { numbering: false } : { drift: true });
    expect(await r.run()).toMatchObject({ outcome: "NO_POST_FAILURE", providerCreateAttempted: false, recoveryStatePersisted: true });
    expect(mock.posts()).toHaveLength(0);
  });
  test("failed canonical read retains the identity and leaves the local invoice a draft", async () => {
    const r = await ready(), mock = transport(r, { readFails: true });
    expect(await r.run()).toMatchObject({ outcome: "IDENTITY_RETAINED_READBACK_PENDING", providerIdentityRetained: true, recoveryStatePersisted: true });
    expect(mock.posts()).toHaveLength(1);
    expect(await prisma.quickBooksInvoiceOperation.findFirstOrThrow({ where: { tenantId: r.f.tenant.id } })).toMatchObject({ providerInvoiceId: mock.invoiceId, status: "RECONCILIATION_REQUIRED", taxCanonicalInvoiceHash: null });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: r.f.invoice.id } })).status).toBe("DRAFT");
  });
});
