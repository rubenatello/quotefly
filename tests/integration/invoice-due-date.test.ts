import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { setTenantRlsContext } from "../../src/lib/tenant-rls";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { claimQuickBooksInvoicePublish, getQuickBooksInvoiceSyncPreview } from "../../src/services/quickbooks-invoices";
import { lockQuickBooksInvoicePublication } from "../../src/services/quickbooks-locks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import { confirmInvoiceTaxContext, readInvoiceTaxContextAssessment, type InvoiceTaxContextInput } from "../../src/services/quickbooks-tax-context";
import { assembleReviewedTaxEstimate } from "../../src/services/quickbooks-tax-estimate-ledger";
import type { TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";
import { readQuickBooksTaxProviderFacts } from "../../src/services/quickbooks-tax-provider-facts";
import { syntheticFacts, testRuntime } from "../helpers/tax-review-fixture";
import { updateInvoiceDueDate } from "../../src/services/invoice-due-date";
vi.mock("../../src/services/quickbooks-tax-provider-facts", () => ({ readQuickBooksTaxProviderFacts: vi.fn() }));
const tenantIds: string[] = []; const userIds: string[] = [];
const keys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-tax-context-tests-only-key-material" };
let app: FastifyInstance;
const runtimePrisma = new Proxy(prisma, {
  get(target, property) {
    if (property === "$transaction") {
      return <T>(action: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) =>
        target.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
          return action(tx);
        }, options);
    }
    return Reflect.get(target, property);
  },
}) as PrismaClient;

async function fixture() {
  const stamp = randomUUID(); const observed = new Date();
  const tenant = await prisma.tenant.create({ data: { name: "Tax service fixture", slug: stamp } }); tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, fullName: "Tax service owner", passwordHash: "synthetic" } }); userIds.push(user.id);
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, fullName: "Synthetic service customer", phone: stamp } });
  const quote = await prisma.quote.create({ data: { tenantId: tenant.id, customerId: customer.id, status: "ACCEPTED", serviceType: "PLUMBING", title: "Synthetic tax quote", scopeText: "Synthetic", internalCostSubtotal: 10, customerPriceSubtotal: 100, taxAmount: 8, totalAmount: 108 } });
  const job = await prisma.job.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobNumber: 1, title: "Synthetic job", scopeSnapshot: "Synthetic", serviceType: "PLUMBING", acceptedAtUtc: observed } });
  const invoice = await prisma.invoice.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 1, titleSnapshot: "Synthetic invoice", subtotalAmount: 100, taxAmount: 8, totalAmount: 108, balanceDue: 108 } });
  const line = await prisma.invoiceLineItem.create({ data: { tenantId: tenant.id, invoiceId: invoice.id, description: "Synthetic materials", quantity: 2, unitPrice: 50, lineTotal: 100, position: 0 } });
  const connection = await prisma.quickBooksConnection.create({ data: { tenantId: tenant.id, realmId: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`, environment: "sandbox", status: "CONNECTED", connectedAtUtc: observed, scopes: ["com.intuit.quickbooks.accounting"], setupConfirmedAtUtc: observed, setupConfirmedByTenantUserId: member.id, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION } });
  await prisma.quickBooksRealmBinding.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: connection.realmId, active: true } });
  const customerMap = await prisma.quickBooksCustomerMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, customerId: customer.id, quickBooksCustomerId: "42", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const itemMap = await prisma.quickBooksItemMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, itemKey: "synthetic materials", quickBooksItemId: "51", quickBooksItemName: "Synthetic materials", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const source: TaxReviewSource = {
    contractVersion: 2, tenantId: tenant.id, invoiceId: invoice.id, invoiceVersion: invoice.version,
    customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceTaxContext: { id: "pending-context", revision: 1, inputHash: "d".repeat(64), confirmedByTenantUserId: member.id, confirmedAtUtc: observed.toISOString() }, transactionDate: observed.toISOString().slice(0, 10), currency: "USD",
    subtotal: "100.00", quotedTax: "8.00", total: "108.00",
    connection: { id: connection.id, realmId: connection.realmId, connectedAtUtc: observed.toISOString(), generation: 1, environment: "sandbox" },
    customerMapping: { id: customerMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "42" },
    customerFacts: { providerCustomerId: "42", providerSyncToken: "0", observedAtUtc: observed.toISOString(), exemption: "TAXABLE", exemptionReasonId: null, fingerprint: "e".repeat(64) },
    origin: { Line1: "123 Synthetic Origin", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" },
    destination: { Line1: "456 Synthetic Destination", City: "Los Angeles", CountrySubDivisionCode: "CA", PostalCode: "90001", Country: "US" },
    preferences: { observedAtUtc: observed.toISOString(), fingerprint: "a".repeat(64), companyInfoFingerprint: "b".repeat(64), companyObservedAtUtc: observed.toISOString(), capabilities: { companyPrerequisitesReady: true, automatedTaxCalculationProven: false, usCompany: true, companyAddressComplete: true, salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [] } },
    lines: [{ invoiceLineItemId: line.id, position: 0, description: "Synthetic materials", quantity: "2.00", unitPrice: "50.00", amount: "100.00", taxIntent: "TAXABLE", itemMapping: { id: itemMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "51" }, itemFacts: { providerItemId: "51", providerSyncToken: "0", observedAtUtc: observed.toISOString(), taxClassificationFingerprint: "c".repeat(64) } }],
  };
  const actor = { tenantId: tenant.id, userId: user.id, authVersion: 0 };
  return { tenant, user, member, customer, quote, job, invoice, line, connection, customerMap, itemMap, source, actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture): InvoiceTaxContextInput { return {
  invoiceId: f.invoice.id, invoiceVersion: f.invoice.version, expectedRevision: 0, idempotencyKey: randomUUID(),
  transactionDate: "2026-09-23", origin: f.source.origin, destination: f.source.destination,
  connection: { ...f.source.connection, generation: 1 }, customerMapping: f.source.customerMapping,
  lines: f.source.lines.map(line => ({ invoiceLineItemId: line.invoiceLineItemId, taxIntent: line.taxIntent, itemMapping: line.itemMapping })),
}; }
const confirm = (f: Fixture, value: unknown = input(f)) => confirmInvoiceTaxContext(runtimePrisma, f.actor, "sandbox", value);
const assess = (f: Fixture) => readInvoiceTaxContextAssessment(runtimePrisma, f.actor, "sandbox", f.invoice.id);
async function current(f: Fixture) { return prisma.invoiceTaxContext.findFirstOrThrow({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id, supersededAtUtc: null }, include: { lines: true } }); }
async function runtime<T>(tenantId: string | null, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  return runtimePrisma.$transaction(async tx => { if (tenantId) await setTenantRlsContext(tx, tenantId); return action(tx); });
}
async function ledger(f: Fixture) {
  vi.mocked(readQuickBooksTaxProviderFacts).mockResolvedValue(syntheticFacts(f.source));
  const row = await current(f);
  return assembleReviewedTaxEstimate(runtimePrisma, f.actor, testRuntime(keys), { invoiceId: f.invoice.id, expectedContextRevision: row.revision });
}

function access(f: Fixture): AccessContext { return { tenantId: f.tenant.id, userId: f.user.id, tenantUserId: f.member.id,
  role: "owner", capabilities: capabilitiesForRole("owner"), requestId: randomUUID() }; }
async function zeroTaxFixture() {
  const f = await fixture();
  await prisma.invoice.update({ where: { id: f.invoice.id }, data: { taxAmount: 0, totalAmount: 100, balanceDue: 100, dueAtUtc: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000) } });
  return f;
}
const directPreview = (f: Fixture) => runtimePrisma.$transaction(tx => getQuickBooksInvoiceSyncPreview(tx, access(f), f.invoice.id, keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY));
const directClaim = (tx: Prisma.TransactionClient, f: Fixture, reviewBinding: string) => claimQuickBooksInvoicePublish(tx, access(f), {
  invoiceId: f.invoice.id, invoiceVersion: f.invoice.version, idempotencyKey: randomUUID(), reviewBinding, reviewSecret: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

const future = (days = 60) => new Date(Date.now() + days * 86_400_000).toISOString();
const change = (f: Fixture, value: unknown = { invoiceVersion: 1, dueAtUtc: future() }, key = randomUUID(), client = runtimePrisma) =>
  updateInvoiceDueDate(client, f.actor, f.invoice.id, value, key, "due-date-test");
async function directOperation(f: Fixture, overrides: Partial<Prisma.QuickBooksInvoiceOperationUncheckedCreateInput> = {}) {
  return prisma.quickBooksInvoiceOperation.create({ data: { tenantId: f.tenant.id, invoiceId: f.invoice.id,
    quickBooksConnectionId: f.connection.id, requestedByTenantUserId: f.member.id, providerRealmId: f.connection.realmId,
    status: "FAILED", commandKeyHash: "a".repeat(64), payloadHash: "b".repeat(64), providerRequestId: randomUUID(),
    providerDocNumber: "QF-000001", processingStartedAtUtc: new Date(), lastAttemptAtUtc: new Date(),
    failedAtUtc: new Date(), lastFailureCode: "INVOICE_DUE_DATE_ELAPSED", ...overrides } });
}

describe("safe draft invoice due-date repair", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(async () => { fetchSpy.mockRejectedValue(new Error("Provider calls forbidden")); app = buildServer(); await app.ready(); });
  test.each(["owner", "admin"])("%s can repair an elapsed date with one version and audited event", async role => {
    const f = await fixture();
    await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role } });
    await prisma.invoice.update({ where: { id: f.invoice.id }, data: { dueAtUtc: new Date(0) } });
    const date = future(); const result = await change(f, { invoiceVersion: 1, dueAtUtc: date });
    expect(result).toMatchObject({ duplicate: false, invoice: { version: 2, dueAtUtc: new Date(date) } });
    expect(await prisma.invoiceEvent.findMany({ where: { tenantId: f.tenant.id } })).toEqual([expect.objectContaining({
      type: "UPDATED", actorTenantUserId: f.member.id, requestId: "due-date-test", fromStatus: "DRAFT", toStatus: "DRAFT",
      fromPaymentStatus: "PENDING", toPaymentStatus: "PENDING", commandPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
  });
  test.each(["member", "demoted", "staleAuth", "deletedMember", "deletedUser", "deletedTenant"])("rejects %s live authority", async reason => {
    const f = await fixture();
    if (reason === "member" || reason === "demoted") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
    if (reason === "staleAuth") await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: 1 } });
    if (reason === "deletedMember") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { deletedAtUtc: new Date() } });
    if (reason === "deletedUser") await prisma.user.update({ where: { id: f.user.id }, data: { deletedAtUtc: new Date() } });
    if (reason === "deletedTenant") await prisma.tenant.update({ where: { id: f.tenant.id }, data: { deletedAtUtc: new Date() } });
    await expect(change(f)).rejects.toMatchObject({ statusCode: 403 });
  });
  test("tenant RLS and cross-tenant replay cannot expose an invoice", async () => {
    const local = await fixture(); const foreign = await fixture(); const key = randomUUID(); const payload = { invoiceVersion: 1, dueAtUtc: future() };
    await change(foreign, payload, key);
    await expect(updateInvoiceDueDate(runtimePrisma, local.actor, foreign.invoice.id, payload, key, "foreign")).rejects.toMatchObject({ statusCode: 404 });
    expect(await runtime(local.tenant.id, tx => tx.invoice.count({ where: { id: foreign.invoice.id } }))).toBe(0);
  });
  test("exact replay remains harmless after time and status advance, and key reuse conflicts", async () => {
    const f = await fixture(); const key = randomUUID(); const payload = { invoiceVersion: 1, dueAtUtc: future() };
    await change(f, payload, key);
    await prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "OPEN", issuedAtUtc: new Date() } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(future(80)));
    try {
      const replay = await change(f, payload, key);
      expect(replay).toMatchObject({ duplicate: true, invoice: { version: 2, status: "OPEN", dueAtUtc: new Date(payload.dueAtUtc) } });
      expect(new Date(payload.dueAtUtc).getTime()).toBeLessThan(Date.now());
      await expect(change(f, { ...payload, dueAtUtc: payload.dueAtUtc.replace("Z", "+00:00") }, key)).resolves.toMatchObject({ duplicate: true });
    } finally { vi.useRealTimers(); }
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id, type: "UPDATED" } })).toBe(1);
    await expect(change(f, { ...payload, dueAtUtc: future(80) }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await prisma.customer.update({ where: { id: f.customer.id }, data: { deletedAtUtc: new Date() } });
    await expect(change(f, payload, key)).rejects.toMatchObject({ statusCode: 404 });
  });
  test("strict future, exact version, and unchanged checks", async () => {
    const f = await fixture(); const date = future();
    await prisma.invoice.update({ where: { id: f.invoice.id }, data: { dueAtUtc: new Date(date) } });
    for (const dueAtUtc of [new Date(0).toISOString(), "nonsense", null]) {
      await expect(change(f, { invoiceVersion: 1, dueAtUtc })).rejects.toMatchObject({ code: "INVOICE_DUE_DATE_INVALID" });
    }
    await expect(change(f, { invoiceVersion: 1, dueAtUtc: date })).rejects.toMatchObject({ code: "INVOICE_DUE_DATE_UNCHANGED" });
    await expect(change(f, { invoiceVersion: 2, dueAtUtc: future(80) })).rejects.toMatchObject({ code: "INVOICE_VERSION_CHANGED" });
    await expect(change(f, { invoiceVersion: 1, dueAtUtc: future(), status: "OPEN" })).rejects.toMatchObject({ statusCode: 400 });
  });
  test.each(["issued", "sent", "paid", "voided", "amountPaid", "paymentStatus", "invoiceArchive", "customerArchive", "quoteArchive", "jobArchive", "canceledJob", "draftQuote"])("rejects %s lifecycle", async state => {
    const f = await fixture();
    const dates: Record<string, string> = { issued: "issuedAtUtc", sent: "sentAtUtc", paid: "paidAtUtc", voided: "voidedAtUtc" };
    if (dates[state]) await prisma.invoice.update({ where: { id: f.invoice.id }, data: { [dates[state]]: new Date() } });
    if (state === "amountPaid") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { amountPaid: 1, balanceDue: 107 } });
    if (state === "paymentStatus") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { paymentStatus: "SUCCEEDED" } });
    if (state === "invoiceArchive") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { archivedAtUtc: new Date() } });
    if (state === "customerArchive") await prisma.customer.update({ where: { id: f.customer.id }, data: { archivedAtUtc: new Date() } });
    if (state === "quoteArchive") await prisma.quote.update({ where: { id: f.quote.id }, data: { archivedAtUtc: new Date() } });
    if (state === "jobArchive") await prisma.job.update({ where: { id: f.job.id }, data: { archivedAtUtc: new Date() } });
    if (state === "canceledJob") await prisma.job.update({ where: { id: f.job.id }, data: { status: "CANCELED" } });
    if (state === "draftQuote") await prisma.quote.update({ where: { id: f.quote.id }, data: { status: "DRAFT" } });
    await expect(change(f)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).version).toBe(1);
  });
  test("retains a safely failed direct operation for a fresh reviewed retry", async () => {
    const f = await fixture(); const operation = await directOperation(f);
    await expect(change(f)).resolves.toMatchObject({ invoice: { version: 2 } });
    expect(await prisma.quickBooksInvoiceOperation.findUnique({ where: { id: operation.id } })).toEqual(operation);
  });
  test.each([
    { archivedAtUtc: new Date() }, { providerInvoiceId: "123" }, { providerSyncToken: "0" },
    { providerBalance: 0 }, { providerUpdatedAtUtc: new Date() }, { providerInvoiceStatus: "Open" },
    { lastFailureCode: "QUICKBOOKS_TIMEOUT" }, { reconciliationCount: 1 }, { status: "RECONCILIATION_REQUIRED" },
  ])("rejects unsafe direct history %j", async override => {
    const f = await fixture(); await directOperation(f, override);
    await expect(change(f)).rejects.toMatchObject({ code: "INVOICE_DUE_DATE_PROVIDER_LOCKED" });
  });
  test.each([false, true])("rejects legacy active/evidenced history (deleted=%s)", async deleted => {
    const f = await fixture(); await prisma.quickBooksInvoiceSync.create({ data: { tenantId: f.tenant.id,
      quoteId: f.quote.id, quickBooksConnectionId: f.connection.id, ...(deleted ? { deletedAtUtc: new Date(), quickBooksInvoiceId: "123" } : {}) } });
    await expect(change(f)).rejects.toMatchObject({ code: "INVOICE_DUE_DATE_PROVIDER_LOCKED" });
  });
  test("preserves TAXABLE intent and supersedes only unattempted tax reviews", async () => {
    const f = await zeroTaxFixture(); await confirm(f); const context = await current(f); const operation = await ledger(f);
    await change(f);
    expect(await current(f)).toEqual(context);
    expect(await assess(f)).toMatchObject({ current: false });
    expect(await directPreview(f)).toMatchObject({ ready: false, blockers: expect.arrayContaining(["QUICKBOOKS_TAX_CONTEXT_REQUIRES_TAX_WORKFLOW"]) });
    const rows = await prisma.quickBooksTaxEstimateOperation.findMany({ where: { tenantId: f.tenant.id } });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: "SUPERSEDED", attemptCount: 0, supersededAtUtc: expect.any(Date) });
    expect(operation).toBeDefined();
  });
  test.each(["attempt", "id", "identity", "canonical", "uncertain"])("rejects tax evidence in historical rows: %s", async state => {
    const f = await fixture(); await confirm(f); await ledger(f);
    await prisma.quickBooksTaxEstimateOperation.updateMany({ where: { tenantId: f.tenant.id }, data: {
      status: "SUPERSEDED", supersededAtUtc: new Date(),
      ...(state === "uncertain" ? { uncertainAtUtc: new Date() } : {
        attemptCount: 1, attemptTokenHash: "a".repeat(64), lastAttemptAtUtc: new Date(),
        ...(state !== "attempt" ? { providerEstimateId: "123" } : {}),
        ...(["identity", "canonical"].includes(state) ? { providerEstimateSyncToken: "0", providerEstimateUpdatedAtUtc: new Date() } : {}),
        ...(state === "canonical" ? { canonicalEstimateHash: "b".repeat(64), providerSubtotal: 100, providerTax: 8, providerTotal: 108, canonicalAtUtc: new Date() } : {}),
      }),
    } });
    await expect(change(f)).rejects.toMatchObject({ code: "INVOICE_DUE_DATE_PROVIDER_LOCKED" });
  });
  test("concurrent editors produce one winner and one version conflict", async () => {
    const f = await fixture(); const results = await Promise.allSettled([change(f), change(f)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "INVOICE_VERSION_CHANGED" });
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });
  test.each(["edit", "publish"])("edit and publish share the PostgreSQL lock (%s wins)", async winner => {
    const f = await zeroTaxFixture(); const preview = await directPreview(f);
    const entered = deferred<number>(); const release = deferred<void>();
    const first = runtimePrisma.$transaction(async tx => {
      await lockQuickBooksInvoicePublication(tx, f.tenant.id, f.invoice.id);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; entered.resolve(backend.pid);
      await release.promise;
      if (winner === "publish") return directClaim(tx, f, preview.reviewBinding!);
      const bound = new Proxy(runtimePrisma, { get(target, property) {
        return property === "$transaction" ? (action: (inner: Prisma.TransactionClient) => Promise<unknown>) => action(tx) : Reflect.get(target, property);
      } });
      return change(f, undefined, undefined, bound);
    }, { maxWait: 10_000, timeout: 15_000 });
    const pid = await entered.promise;
    const contender = winner === "publish" ? change(f) : runtimePrisma.$transaction(tx => directClaim(tx, f, preview.reviewBinding!), { maxWait: 10_000, timeout: 15_000 });
    const second = contender.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await expect.poll(async () => { const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`); return row.blocked; }).toBe(true);
    } finally { release.resolve(); }
    await first; const loser = await second; expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.error).toMatchObject({ code: winner === "publish" ? "INVOICE_DUE_DATE_PROVIDER_LOCKED" : "INVOICE_VERSION_CONFLICT" });
  });
  test("audit failure rolls back both invoice and tax-review supersession", async () => {
    const f = await fixture(); await confirm(f); await ledger(f);
    const failedClient = new Proxy(runtimePrisma, { get(target, property) {
      if (property === "$transaction") return (action: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        target.$transaction(tx => action(new Proxy(tx, { get(inner, key) {
          return key === "invoiceEvent" ? { ...inner.invoiceEvent, create: async () => { throw new Error("injected audit failure"); } } : Reflect.get(inner, key);
        } })), options);
      return Reflect.get(target, property);
    } });
    await expect(change(f, undefined, undefined, failedClient)).rejects.toThrow("injected audit failure");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).version).toBe(1);
    expect(await prisma.quickBooksTaxEstimateOperation.findFirst({ where: { tenantId: f.tenant.id } })).toMatchObject({ status: "REVIEWED", supersededAtUtc: null });
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });
  test("HTTP route works with provider flags disabled and rejects malformed commands", async () => {
    const f = await fixture(); const enabled = app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED;
    app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = false;
    try {
      await prisma.tenant.update({ where: { id: f.tenant.id }, data: { subscriptionStatus: "trialing", trialStartsAtUtc: new Date(Date.now() - 60_000), trialEndsAtUtc: new Date(Date.now() + 3_600_000) } });
      const token = app.jwt.sign({ ...f.actor, email: f.user.email, role: "owner" });
      const headers = { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() };
      const url = `/v1/invoices/${f.invoice.id}/due-date`;
      expect((await app.inject({ method: "PATCH", url, payload: { invoiceVersion: 1, dueAtUtc: future() } })).statusCode).toBe(401);
      expect((await app.inject({ method: "PATCH", url, headers, payload: { invoiceVersion: 1, dueAtUtc: future(), injected: true } })).statusCode).toBe(400);
      const result = await app.inject({ method: "PATCH", url, headers, payload: { invoiceVersion: 1, dueAtUtc: future() } });
      expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.json()).toMatchObject({ invoice: { version: 2 } });
    } finally { app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = enabled; }
  });
  afterAll(async () => { try { expect(fetchSpy).not.toHaveBeenCalled(); } finally {
    fetchSpy.mockRestore(); await app.close();
    await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.invoiceTaxContextLine.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.invoiceTaxContext.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.quickBooksInvoiceOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await prisma.$disconnect();
  } });
});
