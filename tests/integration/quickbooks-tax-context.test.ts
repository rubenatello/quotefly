import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { setTenantRlsContext } from "../../src/lib/tenant-rls";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { assertQuickBooksInvoiceCreateFence, bindCreatedQuickBooksInvoiceIdentity,
  claimQuickBooksInvoicePublish, getQuickBooksInvoiceSyncPreview } from "../../src/services/quickbooks-invoices";
import { lockQuickBooksInvoicePublication } from "../../src/services/quickbooks-locks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import { confirmInvoiceTaxContext, readInvoiceTaxContextAssessment, type InvoiceTaxContextInput } from "../../src/services/quickbooks-tax-context";
import { persistReviewedTaxEstimate, prepareQuickBooksTaxEstimateReview, claimReviewedTaxEstimate } from "../../src/services/quickbooks-tax-estimate-ledger";
import type { TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";
const tenantIds: string[] = []; const userIds: string[] = [];
const keys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-tax-context-tests-only-key-material" };
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
    contractVersion: 1, tenantId: tenant.id, invoiceId: invoice.id, invoiceVersion: invoice.version,
    customerId: customer.id, sourceQuoteId: quote.id, transactionDate: observed.toISOString().slice(0, 10), currency: "USD",
    subtotal: "100.00", quotedTax: "8.00", total: "108.00",
    connection: { id: connection.id, realmId: connection.realmId, connectedAtUtc: observed.toISOString(), environment: "sandbox" },
    customerMapping: { id: customerMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "42" },
    customerFacts: { providerCustomerId: "42", providerSyncToken: "0", observedAtUtc: observed.toISOString(), exemption: "TAXABLE", exemptionReasonId: null },
    origin: { Line1: "123 Synthetic Origin", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" },
    destination: { Line1: "456 Synthetic Destination", City: "Los Angeles", CountrySubDivisionCode: "CA", PostalCode: "90001", Country: "US" },
    preferences: { observedAtUtc: observed.toISOString(), fingerprint: "a".repeat(64), companyInfoFingerprint: "b".repeat(64), capabilities: { companyPrerequisitesReady: true, automatedTaxCalculationProven: false, usCompany: true, companyAddressComplete: true, salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [] } },
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
async function ledger(f: Fixture) { const prepared = prepareQuickBooksTaxEstimateReview(f.source, keys);
  return persistReviewedTaxEstimate(runtimePrisma, f.actor, keys, { source: f.source, binding: prepared.binding }); }

function access(f: Fixture): AccessContext { return { tenantId: f.tenant.id, userId: f.user.id, tenantUserId: f.member.id,
  role: "owner", capabilities: capabilitiesForRole("owner"), requestId: randomUUID() }; }
async function zeroTaxFixture() {
  const f = await fixture();
  await prisma.invoice.update({ where: { id: f.invoice.id }, data: { taxAmount: 0, totalAmount: 100, balanceDue: 100, dueAtUtc: new Date("2026-10-01T00:00:00.000Z") } });
  return f;
}
const directPreview = (f: Fixture) => runtimePrisma.$transaction(tx => getQuickBooksInvoiceSyncPreview(tx, access(f), f.invoice.id, keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY));
const directClaim = (tx: Prisma.TransactionClient, f: Fixture, reviewBinding: string) => claimQuickBooksInvoicePublish(tx, access(f), {
  invoiceId: f.invoice.id, invoiceVersion: f.invoice.version, idempotencyKey: randomUUID(), reviewBinding, reviewSecret: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("manager-confirmed invoice tax context", () => {
 const fetchSpy = vi.spyOn(globalThis, "fetch");
 beforeAll(() => { fetchSpy.mockRejectedValue(new Error("Provider calls forbidden")); });
 test("zero quoted tax cannot override explicit TAXABLE intent, even when its context is stale", async () => {
  const f = await zeroTaxFixture(); const baseline = await directPreview(f); expect(baseline.ready).toBe(true);
  await confirm(f);
  expect(await directPreview(f)).toMatchObject({ ready: false, reviewBinding: null,
    blockers: ["QUICKBOOKS_TAX_CONTEXT_REQUIRES_TAX_WORKFLOW"] });
  await expect(runtimePrisma.$transaction(tx => directClaim(tx, f, baseline.reviewBinding!))).rejects.toMatchObject({ statusCode: 409, code: "QUICKBOOKS_REVIEW_STALE" });
  await prisma.quickBooksItemMap.update({ where: { id: f.itemMap.id }, data: { reviewVersion: 2 } });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: "QUICKBOOKS_TAX_MAPPING_CHANGED" });
  expect(await directPreview(f)).toMatchObject({ ready: false, reviewBinding: null,
    blockers: ["QUICKBOOKS_TAX_CONTEXT_REQUIRES_TAX_WORKFLOW"] });
  expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  const replacement = input(f); replacement.expectedRevision = 1; replacement.lines[0].taxIntent = "NON_TAXABLE";
  replacement.lines[0].itemMapping = { ...replacement.lines[0].itemMapping, reviewVersion: 2 };
  await confirm(f, replacement);
  const refreshed = await directPreview(f); expect(refreshed).toMatchObject({ ready: true, blockers: [] });
  const claim = await runtimePrisma.$transaction(tx => directClaim(tx, f, refreshed.reviewBinding!));
  expect(claim.claimToken).toBeTruthy();
  if (claim.claimToken) expect(claim.providerPayload.Line).toEqual([expect.objectContaining({ SalesItemLineDetail: expect.objectContaining({ TaxCodeRef: { value: "NON" } }) })]);
 });
 test("taxable context from another tenant never blocks this invoice", async () => {
  const foreign = await zeroTaxFixture(); await confirm(foreign); const local = await zeroTaxFixture();
  expect(await directPreview(local)).toMatchObject({ ready: true, blockers: [] });
 });
 test.each(["invoice", "context"] as const)("direct publish and context confirmation serialize with %s winning the real PostgreSQL lock", async winner => {
  const f = await zeroTaxFixture(); const preview = await directPreview(f); const value = input(f);
  const entered = deferred<number>(); const release = deferred<void>();
  const first = runtimePrisma.$transaction(async tx => {
    if (winner === "context") await tx.$queryRaw(Prisma.sql`SELECT id FROM "Tenant" WHERE id = ${f.tenant.id} FOR NO KEY UPDATE`);
    await lockQuickBooksInvoicePublication(tx, f.tenant.id, f.invoice.id);
    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; entered.resolve(backend.pid);
    await release.promise;
    if (winner === "invoice") return directClaim(tx, f, preview.reviewBinding!);
    const bound = new Proxy(runtimePrisma, { get(target, property) {
      return property === "$transaction" ? (action: (inner: Prisma.TransactionClient) => Promise<unknown>) => action(tx) : Reflect.get(target, property);
    } });
    return confirmInvoiceTaxContext(bound, f.actor, "sandbox", value);
  }, { maxWait: 10_000, timeout: 15_000 });
  const pid = await entered.promise;
  const contender = winner === "invoice" ? confirm(f, value) : runtimePrisma.$transaction(tx => directClaim(tx, f, preview.reviewBinding!), { maxWait: 10_000, timeout: 15_000 });
  const second = contender.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  try {
    await expect.poll(async () => { const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`); return row.blocked; }).toBe(true);
  } finally { release.resolve(); }
  await first; const loser = await second; expect(loser.ok).toBe(false);
  if (!loser.ok) expect(loser.error).toMatchObject({ code: winner === "invoice" ? "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" : "QUICKBOOKS_REVIEW_STALE" });
  expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(winner === "invoice" ? 1 : 0);
  expect(await prisma.invoiceTaxContext.count({ where: { tenantId: f.tenant.id } })).toBe(winner === "context" ? 1 : 0);
 });
 test("preview waits for a concurrent context confirmation before issuing any NON review binding", async () => {
  const f = await zeroTaxFixture(); const entered = deferred<number>(); const release = deferred<void>();
  const first = runtimePrisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Tenant" WHERE id = ${f.tenant.id} FOR NO KEY UPDATE`);
    await lockQuickBooksInvoicePublication(tx, f.tenant.id, f.invoice.id);
    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; entered.resolve(backend.pid);
    const bound = new Proxy(runtimePrisma, { get(target, property) {
      return property === "$transaction" ? (action: (inner: Prisma.TransactionClient) => Promise<unknown>) => action(tx) : Reflect.get(target, property);
    } });
    await confirmInvoiceTaxContext(bound, f.actor, "sandbox", input(f)); await release.promise;
  }, { maxWait: 10_000, timeout: 15_000 });
  const pid = await entered.promise; const preview = directPreview(f);
  try {
    await expect.poll(async () => { const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`); return row.blocked; }).toBe(true);
  } finally { release.resolve(); }
  await first; expect(await preview).toMatchObject({ ready: false, reviewBinding: null, blockers: ["QUICKBOOKS_TAX_CONTEXT_REQUIRES_TAX_WORKFLOW"] });
 });
 test("the final CREATE fence blocks inconsistent taxable evidence without blocking late provider identity retention", async () => {
  const f = await zeroTaxFixture(); await confirm(f); const old = await current(f);
  const replacement = input(f); replacement.expectedRevision = 1; replacement.lines[0].taxIntent = "NON_TAXABLE"; await confirm(f, replacement);
  const preview = await directPreview(f); const claim = await runtimePrisma.$transaction(tx => directClaim(tx, f, preview.reviewBinding!));
  if (!claim.claimToken) throw new Error("Expected active synthetic claim");
  await runtimePrisma.$transaction(tx => assertQuickBooksInvoiceCreateFence(tx, access(f), claim, 1000));
  // A privileged/legacy writer can create inconsistent state; the final dispatch
  // fence must still fail closed, while a late financial identity must survive.
  await prisma.invoiceTaxContext.updateMany({ where: { tenantId: f.tenant.id, supersededAtUtc: null }, data: { supersededAtUtc: new Date() } });
  const { id: _id, lines, ...parent } = old;
  await prisma.invoiceTaxContext.create({ data: { ...parent, revision: 3, idempotencyKeyHash: "c".repeat(64), supersededAtUtc: null,
    lines: { create: lines.map(({ id: _lineId, tenantId: _tenantId, invoiceTaxContextId: _contextId, ...line }) => line) } } });
  await expect(runtimePrisma.$transaction(tx => assertQuickBooksInvoiceCreateFence(tx, access(f), claim, 1000))).rejects.toMatchObject({ code: "QUICKBOOKS_OPERATION_STALE", statusCode: 409 });
  const retained = await runtimePrisma.$transaction(tx => bindCreatedQuickBooksInvoiceIdentity(tx, access(f), claim, "late-provider-id"));
  expect(retained.operation.providerInvoiceId).toBe("late-provider-id");
 });
 test("both evidence tables force RLS and runtime can update only the supersession marker", async () => {
  const tables = await prisma.$queryRaw<Array<{ name: string; enabled: boolean; forced: boolean; canDelete: boolean; canUpdate: boolean }>>(Prisma.sql`
    SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced,
      has_table_privilege('quotefly_runtime', oid, 'DELETE') AS "canDelete",
      has_table_privilege('quotefly_runtime', oid, 'UPDATE') AS "canUpdate"
    FROM pg_class WHERE relname IN ('InvoiceTaxContext', 'InvoiceTaxContextLine') ORDER BY relname`);
  expect(tables).toHaveLength(2);
  for (const table of tables) expect(table).toMatchObject({ enabled: true, forced: true, canDelete: false, canUpdate: false });
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
    SELECT column_name FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name IN ('InvoiceTaxContext', 'InvoiceTaxContextLine')
      AND grantee = 'quotefly_runtime' AND privilege_type = 'UPDATE'`);
  expect(columns).toEqual([{ column_name: "supersededAtUtc" }]);
 });
 test("concurrent identical confirmations are idempotent and leave financial totals untouched", async () => {
  const f = await fixture(); const value = input(f); const before = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
  expect(await assess(f)).toMatchObject({ current: false, revision: null, staleReason: "QUICKBOOKS_TAX_CONTEXT_REQUIRED" });
  const results = await Promise.all([confirm(f, value), confirm(f, value)]);
  expect(results).toEqual([expect.objectContaining({ current: true, revision: 1, publishingAuthorized: false, taxCalculationProven: false }), expect.objectContaining({ current: true, revision: 1 })]);
  const stored = await current(f);
  expect(stored).toMatchObject({ invoiceVersion: 1, connectionGeneration: 1, customerMapId: f.customerMap.id, confirmedByTenantUserId: f.member.id });
  expect(stored.lines).toHaveLength(1); expect(stored.lines[0]).toMatchObject({ invoiceLineItemIdSnapshot: f.line.id, taxIntent: "TAXABLE", itemMapId: f.itemMap.id });
  expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).toEqual(before);
  expect(await assess(f)).toMatchObject({ current: true, revision: 1 });
  expect(JSON.stringify(results)).not.toContain("Synthetic");
 });
 test("only accepted command keys are replayable and an unchanged new key is rejected", async () => {
  const f = await fixture(); const original = input(f);
  expect(await confirm(f, original)).toMatchObject({ current: true, revision: 1 });
  expect(await confirm(f, original)).toMatchObject({ current: true, revision: 1 });
  const unaccepted = { ...original, expectedRevision: 1, idempotencyKey: randomUUID() };
  await expect(confirm(f, unaccepted)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_CONTEXT_UNCHANGED" });
  expect(await prisma.invoiceTaxContext.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  const changed = { ...unaccepted, destination: { ...unaccepted.destination, Line1: "Changed explicit destination" } };
  await expect(confirm(f, { ...changed, idempotencyKey: original.idempotencyKey })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_CONTEXT_IDEMPOTENCY_CONFLICT" });
  expect(await confirm(f, changed)).toMatchObject({ current: true, revision: 2 });
  expect(await confirm(f, changed)).toMatchObject({ current: true, revision: 2 });
  await expect(confirm(f, { ...changed, expectedRevision: 2, transactionDate: "2026-09-24" })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_CONTEXT_IDEMPOTENCY_CONFLICT" });
 });
 test("concurrent different confirmations require the same expected revision and exactly one wins", async () => {
  const f = await fixture(); const a = input(f); const b = input(f); b.destination = { ...b.destination, Line1: "Different explicit address" };
  const result = await Promise.allSettled([confirm(f, a), confirm(f, b)]);
  expect(result.filter(x => x.status === "fulfilled")).toHaveLength(1);
  expect(result.find(x => x.status === "rejected")).toMatchObject({ reason: { code: "QUICKBOOKS_TAX_CONTEXT_REVISION_CHANGED" } });
  expect(await prisma.invoiceTaxContext.count({ where: { tenantId: f.tenant.id } })).toBe(1);
 });
 test("replacement preserves immutable old evidence, supersedes only unattempted reviews and rejects reused keys", async () => {
  const f = await fixture(); const original = input(f); await confirm(f, original); const old = await current(f);
  const operation = await ledger(f);
  const next = input(f); next.expectedRevision = 1; next.destination = { ...next.destination, Line1: "Changed explicit destination" };
  expect(await confirm(f, next)).toMatchObject({ revision: 2 });
  expect(await prisma.invoiceTaxContext.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ inputHash: old.inputHash, origin: old.origin, destination: old.destination, supersededAtUtc: expect.any(Date) });
  expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: operation.id } })).toMatchObject({ status: "SUPERSEDED", attemptCount: 0 });
  await expect(confirm(f, original)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_CONTEXT_IDEMPOTENCY_CONFLICT" });
  await expect(prisma.invoiceTaxContext.update({ where: { id: old.id }, data: { destination: next.destination } })).rejects.toThrow();
  await expect(prisma.invoiceTaxContext.update({ where: { id: old.id }, data: { supersededAtUtc: null } })).rejects.toThrow();
  await expect(prisma.invoiceTaxContextLine.update({ where: { id: old.lines[0].id }, data: { taxIntent: "NON_TAXABLE" } })).rejects.toThrow();
 });
 test("runtime has no context delete/evidence update and cannot append to the sealed line set", async () => {
  const f = await fixture(); await confirm(f); const row = await current(f);
  await expect(runtime(f.tenant.id, tx => tx.invoiceTaxContext.deleteMany({ where: { tenantId: f.tenant.id } }))).rejects.toThrow();
  await expect(runtime(f.tenant.id, tx => tx.invoiceTaxContext.updateMany({ where: { tenantId: f.tenant.id }, data: { inputHash: "a".repeat(64) } }))).rejects.toThrow();
  await expect(runtime(f.tenant.id, tx => tx.invoiceTaxContextLine.deleteMany({ where: { tenantId: f.tenant.id } }))).rejects.toThrow();
  const { id: _id, ...line } = row.lines[0];
  await expect(runtime(f.tenant.id, tx => tx.invoiceTaxContextLine.create({ data: { ...line, invoiceLineItemIdSnapshot: "additional-line", position: 1 } }))).rejects.toThrow();
  expect((await current(f)).lines).toHaveLength(1);
 });
 test("RLS denies missing/wrong tenant visibility and composite foreign keys reject foreign evidence", async () => {
  const a = await fixture(); const b = await fixture(); await confirm(a); const row = await current(a);
  expect(await runtime(null, tx => tx.invoiceTaxContext.count())).toBe(0);
  expect(await runtime(b.tenant.id, tx => tx.invoiceTaxContext.count())).toBe(0);
  expect(await runtime(b.tenant.id, tx => tx.invoiceTaxContextLine.count())).toBe(0);
  const { id: _lineId, ...child } = row.lines[0];
  await expect(runtime(b.tenant.id, tx => tx.invoiceTaxContextLine.create({ data: { ...child, position: 2, invoiceLineItemIdSnapshot: "foreign-insert" } }))).rejects.toThrow();
  await expect(confirmInvoiceTaxContext(runtimePrisma, b.actor, "sandbox", input(a))).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_CHANGED" });
  const { id: _id, lines: _lines, ...parent } = row;
  await expect(prisma.invoiceTaxContext.create({ data: { ...parent, tenantId: b.tenant.id, invoiceId: b.invoice.id, customerId: b.customer.id, sourceQuoteId: b.quote.id, jobId: b.job.id } })).rejects.toThrow();
 });
 test("changed financial facts without a version bump are detected and invalid totals use a fixed diagnostic", async () => {
  const f = await fixture(); await confirm(f);
  await prisma.invoice.update({ where: { id: f.invoice.id }, data: { taxAmount: 9, totalAmount: 109, balanceDue: 109 } });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: "QUICKBOOKS_TAX_CONTEXT_CHANGED" });
  await prisma.invoiceLineItem.update({ where: { id: f.line.id }, data: { quantity: 0 } });
  await expect(confirm(f)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_CHANGED" });
 });
 test.each(["demotion", "authVersion", "membershipDelete", "accountDelete", "tenantDelete"])("live authorization rejects %s before returning or changing context", async kind => {
  const f = await fixture(); await confirm(f);
  if (kind === "demotion") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
  if (kind === "authVersion") await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: 1 } });
  if (kind === "membershipDelete") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { deletedAtUtc: new Date() } });
  if (kind === "accountDelete") await prisma.user.update({ where: { id: f.user.id }, data: { deletedAtUtc: new Date() } });
  if (kind === "tenantDelete") await prisma.tenant.update({ where: { id: f.tenant.id }, data: { deletedAtUtc: new Date() } });
  await expect(confirm(f)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_MANAGER_REQUIRED" });
  await expect(assess(f)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_MANAGER_REQUIRED" });
 });
 test.each(["version", "currency", "paid", "published", "customer", "job", "canceledJob", "quote", "archived"])("source %s drift makes prior confirmation stale", async kind => {
  const f = await fixture(); await confirm(f);
  if (kind === "version") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { version: 2 } });
  if (kind === "currency") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { currency: "CAD" } });
  if (kind === "paid") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { amountPaid: 1, balanceDue: 107 } });
  if (kind === "published") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "OPEN" } });
  if (kind === "customer") await prisma.customer.update({ where: { id: f.customer.id }, data: { archivedAtUtc: new Date() } });
  if (kind === "job") await prisma.job.update({ where: { id: f.job.id }, data: { deletedAtUtc: new Date() } });
  if (kind === "canceledJob") await prisma.job.update({ where: { id: f.job.id }, data: { status: "CANCELED" } });
  if (kind === "quote") await prisma.quote.update({ where: { id: f.quote.id }, data: { status: "DRAFT" } });
  if (kind === "archived") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { archivedAtUtc: new Date() } });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: "QUICKBOOKS_TAX_INVOICE_CHANGED" });
 });
 test.each(["customerMap", "itemMap", "generation", "connectedAt", "environment", "binding", "scope", "setup", "disconnect"])("%s drift is rechecked", async kind => {
  const f = await fixture(); await confirm(f);
  if (kind === "customerMap") await prisma.quickBooksCustomerMap.update({ where: { id: f.customerMap.id }, data: { reviewVersion: 2 } });
  if (kind === "itemMap") await prisma.quickBooksItemMap.update({ where: { id: f.itemMap.id }, data: { quickBooksItemId: "999" } });
  if (kind === "generation") await prisma.quickBooksConnectionEvent.create({ data: { tenantId: f.tenant.id, quickBooksConnectionId: f.connection.id, action: "RECONNECTED", outcome: "SUCCEEDED", connectionGeneration: 2, requestId: randomUUID() } });
  if (kind === "connectedAt") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { connectedAtUtc: new Date(Date.now() + 1000) } });
  if (kind === "environment") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { environment: "production" } });
  if (kind === "binding") await prisma.quickBooksRealmBinding.update({ where: { quickBooksConnectionId: f.connection.id }, data: { active: false } });
  if (kind === "scope") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { scopes: [] } });
  if (kind === "setup") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { setupConfirmedAtUtc: null, setupConfirmedByTenantUserId: null, setupChecklistVersion: null } });
  if (kind === "disconnect") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { disconnectRequestedAtUtc: new Date() } });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: kind.endsWith("Map") ? "QUICKBOOKS_TAX_MAPPING_CHANGED" : "QUICKBOOKS_TAX_CONNECTION_CHANGED" });
 });
 test("privileged draft line replacement makes context stale without erasing historical evidence", async () => {
  const f = await fixture(); await confirm(f); const before = await current(f);
  const nextLine = await prisma.$transaction(async tx => {
    await tx.invoice.update({ where: { id: f.invoice.id }, data: { version: { increment: 1 } } });
    await tx.invoiceLineItem.deleteMany({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id } });
    return tx.invoiceLineItem.create({ data: { tenantId: f.tenant.id, invoiceId: f.invoice.id, description: f.line.description, position: 0, quantity: 2, unitPrice: 50, lineTotal: 100 } });
  });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: "QUICKBOOKS_TAX_INVOICE_CHANGED" });
  const next = input(f); next.invoiceVersion = 2; next.expectedRevision = 1; next.lines[0].invoiceLineItemId = nextLine.id;
  expect(await confirm(f, next)).toMatchObject({ current: true, revision: 2 });
  expect((await prisma.invoiceTaxContext.findUniqueOrThrow({ where: { id: before.id }, include: { lines: true } })).lines).toEqual(before.lines);
  expect((await current(f)).lines[0].invoiceLineItemIdSnapshot).toBe(nextLine.id);
 });
 test.each(["missing", "extra", "duplicate", "reordered", "foreignInvoice", "foreignTenant"])("rejects %s line sets", async kind => {
  const f = await fixture(); const value = input(f);
  const line = await prisma.invoiceLineItem.create({ data: { tenantId: f.tenant.id, invoiceId: f.invoice.id, description: f.line.description, quantity: 1, unitPrice: 0, lineTotal: 0, position: 1 } });
  value.lines.push({ ...value.lines[0], invoiceLineItemId: line.id });
  if (kind === "missing") value.lines.pop();
  if (kind === "extra") value.lines.push({ ...value.lines[0], invoiceLineItemId: "extra" });
  if (kind === "duplicate") value.lines[1].invoiceLineItemId = value.lines[0].invoiceLineItemId;
  if (kind === "reordered") value.lines.reverse();
  if (kind === "foreignTenant") value.lines[0].invoiceLineItemId = (await fixture()).line.id;
  if (kind === "foreignInvoice") {
    const quote = await prisma.quote.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, serviceType: "PLUMBING", title: "Other", scopeText: "Other", internalCostSubtotal: 0, customerPriceSubtotal: 0, taxAmount: 0, totalAmount: 0 } });
    const job = await prisma.job.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobNumber: 2, title: "Other", scopeSnapshot: "Other", serviceType: "PLUMBING", acceptedAtUtc: new Date() } });
    const other = await prisma.invoice.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 2, titleSnapshot: "Other", subtotalAmount: 0, taxAmount: 0, totalAmount: 0, balanceDue: 0 } });
    value.lines[0].invoiceLineItemId = (await prisma.invoiceLineItem.create({ data: { tenantId: f.tenant.id, invoiceId: other.id, description: "Other", quantity: 1, unitPrice: 0, lineTotal: 0 } })).id;
  }
  await expect(confirm(f, value)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_LINES_CHANGED" });
 });
 test.each(["attempted", "attemptedSuperseded", "legacy", "direct"])("retained %s provider-operation evidence blocks confirmation", async kind => {
  const f = await fixture(); const value = input(f); await confirm(f, value);
  if (kind.startsWith("attempted")) {
    const row = await ledger(f); await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id);
    if (kind === "attemptedSuperseded") await prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date(), claimTokenHash: null, claimExpiresAtUtc: null } });
  }
  if (kind === "legacy") await prisma.quickBooksInvoiceSync.create({ data: { tenantId: f.tenant.id, quoteId: f.quote.id, quickBooksConnectionId: f.connection.id, quickBooksInvoiceId: "retained-remote", status: "SYNCED", deletedAtUtc: new Date() } });
  if (kind === "direct") await prisma.quickBooksInvoiceOperation.create({ data: { tenantId: f.tenant.id, invoiceId: f.invoice.id, quickBooksConnectionId: f.connection.id, requestedByTenantUserId: f.member.id, status: "FAILED", commandKeyHash: "a".repeat(64), payloadHash: "b".repeat(64), providerRealmId: f.connection.realmId, providerRequestId: randomUUID(), providerDocNumber: "QF-1", processingStartedAtUtc: new Date(), lastAttemptAtUtc: new Date(), failedAtUtc: new Date(), lastFailureCode: "QUICKBOOKS_HTTP_400", archivedAtUtc: new Date() } });
  value.idempotencyKey = randomUUID(); value.expectedRevision = 1; value.destination = { ...value.destination, Line1: "Replacement" };
  const code = kind.startsWith("attempted") ? "QUICKBOOKS_TAX_RECONCILIATION_REQUIRED" : "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION";
  await expect(confirm(f, value)).rejects.toMatchObject({ code });
  expect(await assess(f)).toMatchObject({ current: false, staleReason: code });
  expect(await prisma.invoiceTaxContext.count({ where: { tenantId: f.tenant.id } })).toBe(1);
 });
 afterAll(async () => { try { expect(fetchSpy).not.toHaveBeenCalled(); } finally {
  fetchSpy.mockRestore();
  await prisma.invoiceTaxContextLine.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.invoiceTaxContext.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.quickBooksInvoiceOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await prisma.$disconnect();
 } });
});
