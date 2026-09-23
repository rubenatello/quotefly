import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { setTenantRlsContext } from "../../src/lib/tenant-rls";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { claimQuickBooksInvoicePublish, getQuickBooksInvoiceSyncPreview } from "../../src/services/quickbooks-invoices";
import { lockQuickBooksInvoicePublication } from "../../src/services/quickbooks-locks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import {
  claimReviewedTaxEstimate, markTaxEstimateUncertain, persistReviewedTaxEstimate,
  prepareQuickBooksTaxEstimateReview, retainTaxEstimateIdentity,
} from "../../src/services/quickbooks-tax-estimate-ledger";
import type { TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";

const keys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-original-tax-ledger-key-for-tests-only" };
const rotatedKeys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-rotated-tax-ledger-key-for-tests-only", QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY };
const tenantIds: string[] = [];
const userIds: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Real service transactions and PostgreSQL permissions, without altering login
// passwords or requiring a second secret-bearing database URL for this suite.
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
function persist(f: Fixture, source = f.source, environment: typeof keys & { QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS?: string } = keys) {
  const review = prepareQuickBooksTaxEstimateReview(source, environment);
  return persistReviewedTaxEstimate(runtimePrisma, f.actor, environment, { source, binding: review.binding });
}
async function claimed(f: Fixture) {
  const row = await persist(f);
  const claim = await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id);
  if (claim.outcome !== "CLAIMED") throw new Error("Expected synthetic ledger claim");
  return { row, claim, attempt: { tenantId: f.tenant.id, operationId: row.id, estimateRequestId: claim.estimateRequestId, sourceHash: claim.sourceHash, claimToken: claim.claimToken } };
}

function access(f: Fixture): AccessContext {
  return { tenantId: f.tenant.id, tenantUserId: f.member.id, userId: f.user.id,
    role: "owner", capabilities: capabilitiesForRole("owner"), requestId: randomUUID() };
}
async function zeroTaxFixture() {
  const f = await fixture();
  await prisma.quote.update({ where: { id: f.quote.id }, data: { taxAmount: 0, totalAmount: 100 } });
  await prisma.invoice.update({ where: { id: f.invoice.id }, data: { taxAmount: 0, totalAmount: 100, balanceDue: 100, dueAtUtc: new Date(Date.now() + 86_400_000) } });
  f.source.quotedTax = "0.00"; f.source.total = "100.00";
  return f;
}
function normalPreview(f: Fixture) {
  return runtimePrisma.$transaction((tx) => getQuickBooksInvoiceSyncPreview(tx, access(f), f.invoice.id, keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY));
}
function normalClaim(tx: Prisma.TransactionClient, f: Fixture, reviewBinding: string) {
  return claimQuickBooksInvoicePublish(tx, access(f), { invoiceId: f.invoice.id, invoiceVersion: f.invoice.version,
    idempotencyKey: randomUUID(), reviewBinding, reviewSecret: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY });
}
async function competingInvoice(f: Fixture, kind: "operation" | "legacy") {
  if (kind === "legacy") {
    return prisma.quickBooksInvoiceSync.create({ data: { tenantId: f.tenant.id, quickBooksConnectionId: f.connection.id,
      quoteId: f.quote.id, quickBooksInvoiceId: "prior-generation-invoice", status: "SYNCED" } });
  }
  const now = new Date();
  return prisma.quickBooksInvoiceOperation.create({ data: { tenantId: f.tenant.id, invoiceId: f.invoice.id,
    quickBooksConnectionId: f.connection.id, requestedByTenantUserId: f.member.id, status: "FAILED",
    commandKeyHash: sha256(randomUUID()), payloadHash: sha256(randomUUID()), providerRealmId: f.connection.realmId,
    providerRequestId: randomUUID(), providerDocNumber: "QF-000001", processingStartedAtUtc: now,
    lastAttemptAtUtc: now, failedAtUtc: now, lastFailureCode: "QUICKBOOKS_HTTP_400", archivedAtUtc: now } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("QuickBooks tax Estimate ledger services", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(() => { fetchSpy.mockRejectedValue(new Error("Provider calls are forbidden in tax ledger tests")); });
  afterAll(async () => {
    try {
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.quickBooksInvoiceOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  test("a signed review persists exactly once with separate stable request IDs and no financial writes", async () => {
    const f = await fixture();
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
    const [first, second] = await Promise.all([persist(f), persist(f)]);
    expect(first.id).toBe(second.id);
    expect(first.estimateRequestId).toBe(second.estimateRequestId);
    expect(first.invoiceRequestId).toBe(second.invoiceRequestId);
    expect(first.estimateRequestId).not.toBe(first.invoiceRequestId);
    const stored = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: first.id } });
    const review = prepareQuickBooksTaxEstimateReview(f.source, keys);
    expect(stored).toMatchObject({ status: "REVIEWED", reviewRevision: 1, requestedByTenantUserId: f.member.id, reviewedByTenantUserId: f.member.id, sourceHash: review.sourceHash, estimateAstHash: review.estimateAstHash, reviewBindingDigest: sha256(review.binding), sourceSnapshot: review.source, estimateAstSnapshot: review.estimateAst, attemptCount: 0, attemptTokenHash: null });
    expect(JSON.stringify(stored)).not.toContain(keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY);
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(1);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).toEqual(before);
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  test("changed input invalidates the old signature; a fresh signature appends and supersedes safely", async () => {
    const f = await fixture(); const first = await persist(f);
    const oldBinding = prepareQuickBooksTaxEstimateReview(f.source, keys).binding;
    const changed = structuredClone(f.source); changed.destination.Line1 = "789 Updated Synthetic Destination";
    await expect(persistReviewedTaxEstimate(runtimePrisma, f.actor, keys, { source: changed, binding: oldBinding })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_REVIEW_CHANGED" });
    const next = await persist(f, changed);
    expect(next).toMatchObject({ reviewRevision: 2, status: "REVIEWED" });
    expect(next.id).not.toBe(first.id);
    expect(next.estimateRequestId).not.toBe(first.estimateRequestId);
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "SUPERSEDED", sourceSnapshot: f.source });
    expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, first.id)).toMatchObject({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
  });

  test("an in-flight or uncertain attempt blocks replacement even with a newly signed review", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    const changed = structuredClone(f.source); changed.destination.Line1 = "Updated destination";
    await expect(persist(f, changed)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_RECONCILIATION_REQUIRED" });
    await markTaxEstimateUncertain(runtimePrisma, attempt);
    await expect(persist(f, changed)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_RECONCILIATION_REQUIRED" });
    expect((await persist(f)).id).toBe(row.id);
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  test("a failed record that already attempted dispatch cannot be superseded into a fresh attempt", async () => {
    const f = await fixture(); const { row } = await claimed(f);
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "FAILED", failedAtUtc: new Date(), lastFailureCode: "QUICKBOOKS_ESTIMATE_REJECTED", claimTokenHash: null, claimExpiresAtUtc: null } });
    const changed = structuredClone(f.source); changed.destination.Line1 = "Changed destination after failure";
    await expect(persist(f, changed)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_RECONCILIATION_REQUIRED" });
    expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).toMatchObject({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
  });

  test("tenant boundaries reject a signed foreign source and hide foreign operation IDs", async () => {
    const a = await fixture(); const b = await fixture(); const row = await persist(a);
    const binding = prepareQuickBooksTaxEstimateReview(a.source, keys).binding;
    await expect(persistReviewedTaxEstimate(runtimePrisma, b.actor, keys, { source: a.source, binding })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_REVIEW_CHANGED" });
    await expect(claimReviewedTaxEstimate(runtimePrisma, b.actor, row.id)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_OPERATION_NOT_FOUND" });
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: b.tenant.id } })).toBe(0);
  });

  test.each(["demoted", "membership_deleted", "account_deleted", "tenant_deleted", "auth_version"])("live authorization blocks persist and claim after %s", async (change) => {
    const f = await fixture(); const row = await persist(f);
    if (change === "demoted") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
    if (change === "membership_deleted") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { deletedAtUtc: new Date() } });
    if (change === "account_deleted") await prisma.user.update({ where: { id: f.user.id }, data: { deletedAtUtc: new Date() } });
    if (change === "tenant_deleted") await prisma.tenant.update({ where: { id: f.tenant.id }, data: { deletedAtUtc: new Date() } });
    if (change === "auth_version") await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: 1 } });
    await expect(persist(f)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_MANAGER_REQUIRED" });
    await expect(claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_MANAGER_REQUIRED" });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "REVIEWED", attemptCount: 0 });
  });

  const driftCases: Array<{ name: string; code: string; change: (f: Fixture) => Promise<unknown> }> = [
    { name: "open invoice", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "OPEN" } }) },
    { name: "paid invoice", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "PAID" } }) },
    { name: "payment processing state", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { paymentStatus: "PARTIALLY_PAID" } }) },
    { name: "recorded payment and reduced balance", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { amountPaid: 1, balanceDue: 107 } }) },
    { name: "uncollectible invoice", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "UNCOLLECTIBLE" } }) },
    { name: "invoice version", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoice.update({ where: { id: f.invoice.id }, data: { version: 2 } }) },
    { name: "invoice contents", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.invoiceLineItem.update({ where: { id: f.line.id }, data: { description: "Changed line" } }) },
    { name: "archived customer", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.customer.update({ where: { id: f.customer.id }, data: { archivedAtUtc: new Date() } }) },
    { name: "source quote no longer accepted", code: "QUICKBOOKS_TAX_INVOICE_CHANGED", change: (f) => prisma.quote.update({ where: { id: f.quote.id }, data: { status: "DRAFT" } }) },
    { name: "customer mapping revision", code: "QUICKBOOKS_TAX_MAPPING_CHANGED", change: (f) => prisma.quickBooksCustomerMap.update({ where: { id: f.customerMap.id }, data: { reviewVersion: 2 } }) },
    { name: "item provider identity", code: "QUICKBOOKS_TAX_MAPPING_CHANGED", change: (f) => prisma.quickBooksItemMap.update({ where: { id: f.itemMap.id }, data: { quickBooksItemId: "999" } }) },
    { name: "item mapping removed", code: "QUICKBOOKS_TAX_MAPPING_CHANGED", change: (f) => prisma.quickBooksItemMap.update({ where: { id: f.itemMap.id }, data: { deletedAtUtc: new Date() } }) },
    { name: "connection generation", code: "QUICKBOOKS_TAX_CONNECTION_CHANGED", change: (f) => prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { connectedAtUtc: new Date(f.connection.connectedAtUtc.getTime() + 1_000) } }) },
    { name: "disconnected connection", code: "QUICKBOOKS_TAX_CONNECTION_CHANGED", change: (f) => prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } }) },
    { name: "pending disconnect", code: "QUICKBOOKS_TAX_CONNECTION_CHANGED", change: (f) => prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { disconnectRequestedAtUtc: new Date() } }) },
    { name: "setup revoked", code: "QUICKBOOKS_TAX_CONNECTION_CHANGED", change: (f) => prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { setupConfirmedAtUtc: null, setupConfirmedByTenantUserId: null, setupChecklistVersion: null } }) },
    { name: "realm binding inactive", code: "QUICKBOOKS_TAX_CONNECTION_CHANGED", change: (f) => prisma.quickBooksRealmBinding.update({ where: { quickBooksConnectionId: f.connection.id }, data: { active: false } }) },
  ];
  test.each(driftCases)("persist and claim recheck $name", async ({ code, change }) => {
    const f = await fixture(); const row = await persist(f); await change(f);
    await expect(persist(f)).rejects.toMatchObject({ code });
    await expect(claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).rejects.toMatchObject({ code });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "REVIEWED", attemptCount: 0, attemptTokenHash: null });
  });

  test("stale and future provider observations never become a persisted review", async () => {
    const f = await fixture();
    for (const offset of [-301_000, 60_000]) {
      const source = structuredClone(f.source); source.preferences.observedAtUtc = new Date(Date.now() + offset).toISOString();
      await expect(persist(f, source)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_FACTS_STALE" });
    }
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  test.each(["operation", "legacy"] as const)("a competing %s blocks tax persistence before review and invalidates an existing review", async (kind) => {
    const before = await fixture(); await competingInvoice(before, kind);
    if (kind === "legacy") {
      const nextGeneration = new Date(before.connection.connectedAtUtc.getTime() + 1_000);
      await prisma.quickBooksConnection.update({ where: { id: before.connection.id }, data: { connectedAtUtc: nextGeneration } });
      before.source.connection.connectedAtUtc = nextGeneration.toISOString();
    }
    await expect(persist(before)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" });
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: before.tenant.id } })).toBe(0);
    const after = await fixture(); const reviewed = await persist(after); await competingInvoice(after, kind);
    await expect(persist(after)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" });
    await expect(claimReviewedTaxEstimate(runtimePrisma, after.actor, reviewed.id)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: reviewed.id } })).toMatchObject({ status: "REVIEWED", attemptCount: 0 });
  });

  test("soft-deleted legacy provider identity still blocks tax persistence and an existing review's claim", async () => {
    for (const reviewFirst of [false, true]) {
      const f = await fixture(); const row = reviewFirst ? await persist(f) : null;
      await competingInvoice(f, "legacy");
      await prisma.quickBooksInvoiceSync.updateMany({ where: { tenantId: f.tenant.id, quoteId: f.quote.id }, data: { deletedAtUtc: new Date() } });
      await expect(persist(f)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" });
      if (row) await expect(claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" });
      expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(reviewFirst ? 1 : 0);
    }
  });

  test("an active tax review blocks ordinary preview and claim; only unattempted supersession releases it", async () => {
    const f = await zeroTaxFixture(); const baseline = await normalPreview(f);
    expect(baseline.ready).toBe(true);
    const row = await persist(f);
    const blocked = await normalPreview(f);
    expect(blocked).toMatchObject({ ready: false, reviewBinding: null });
    expect(blocked.blockers).toContain("QUICKBOOKS_TAX_ESTIMATE_OPERATION_EXISTS");
    await expect(runtimePrisma.$transaction((tx) => normalClaim(tx, f, baseline.reviewBinding!))).rejects.toMatchObject({ code: "QUICKBOOKS_REVIEW_STALE" });
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date() } });
    const released = await normalPreview(f);
    expect(released.ready).toBe(true);
    const normal = await runtimePrisma.$transaction((tx) => normalClaim(tx, f, released.reviewBinding!));
    expect(normal).toMatchObject({ duplicate: false, requiresReconciliation: false });
    expect(normal.claimToken).toBeTruthy();
  });

  test("an attempted superseded tax review permanently blocks ordinary invoice publishing", async () => {
    const f = await zeroTaxFixture(); const baseline = await normalPreview(f); const { row } = await claimed(f);
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date(), claimTokenHash: null, claimExpiresAtUtc: null } });
    expect((await normalPreview(f)).blockers).toContain("QUICKBOOKS_TAX_ESTIMATE_OPERATION_EXISTS");
    await expect(runtimePrisma.$transaction((tx) => normalClaim(tx, f, baseline.reviewBinding!))).rejects.toMatchObject({ code: "QUICKBOOKS_REVIEW_STALE" });
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  test.each(["invoice", "tax"] as const)("the shared publication lock has one winner when %s holds it first", async (winner) => {
    const f = await zeroTaxFixture(); const preview = await normalPreview(f);
    expect(preview.ready).toBe(true);
    const entered = deferred<number>(); const release = deferred<void>();
    const first = runtimePrisma.$transaction(async (tx) => {
      // Reproduce each service's actual parent-before-advisory acquisition order.
      if (winner === "tax") await tx.$queryRaw(Prisma.sql`SELECT id FROM "Tenant" WHERE id = ${f.tenant.id} FOR NO KEY UPDATE`);
      await lockQuickBooksInvoicePublication(tx, f.tenant.id, f.invoice.id);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      entered.resolve(backend.pid);
      await release.promise;
      if (winner === "invoice") return normalClaim(tx, f, preview.reviewBinding!);
      const boundClient = new Proxy(runtimePrisma, {
        get(target, property) {
          return property === "$transaction" ? (action: (inner: Prisma.TransactionClient) => Promise<unknown>) => action(tx) : Reflect.get(target, property);
        },
      });
      const signed = prepareQuickBooksTaxEstimateReview(f.source, keys);
      return persistReviewedTaxEstimate(boundClient, f.actor, keys, { source: f.source, binding: signed.binding });
    }, { maxWait: 10_000, timeout: 15_000 });
    const firstPid = await entered.promise;
    const secondPromise = winner === "invoice" ? persist(f) : runtimePrisma.$transaction((tx) => normalClaim(tx, f, preview.reviewBinding!), { maxWait: 10_000, timeout: 15_000 });
    const second = secondPromise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    try {
      // Observe a real PostgreSQL wait edge; no sleep or scheduler assumption.
      await expect.poll(async () => {
        const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${firstPid} = ANY(pg_blocking_pids(pid))) AS blocked`);
        return state.blocked;
      }).toBe(true);
    } finally { release.resolve(); }
    await first;
    const loser = await second;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.error).toMatchObject({ code: winner === "invoice" ? "QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION" : "QUICKBOOKS_REVIEW_STALE" });
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(winner === "invoice" ? 1 : 0);
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(winner === "tax" ? 1 : 0);
  });

  test.each(["customer", "job", "quote"] as const)("a %s lifecycle audit insert completes while tax review waits for its child row", async (kind) => {
    const f = await fixture(); const locked = deferred<number>(); const insertAudit = deferred<void>();
    const table = { customer: "Customer", job: "Job", quote: "Quote" }[kind];
    const id = { customer: f.customer.id, job: f.job.id, quote: f.quote.id }[kind];
    const lifecycle = runtimePrisma.$transaction(async (tx) => {
      await setTenantRlsContext(tx, f.tenant.id);
      // Match the existing lifecycle path: hold its child row before appending
      // an audit whose tenant/member/customer foreign keys request KEY SHARE.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE "tenantId" = ${f.tenant.id} AND id = ${id} FOR UPDATE`);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid);
      await insertAudit.promise;
      if (kind === "customer") return tx.customerActivityEvent.create({ data: {
        tenantId: f.tenant.id, customerId: f.customer.id, actorUserId: f.user.id,
        eventType: "UPDATED", title: "Synthetic lifecycle audit",
      } });
      if (kind === "job") return tx.jobEvent.create({ data: {
        tenantId: f.tenant.id, jobId: f.job.id, actorTenantUserId: f.member.id,
        type: "UPDATED", requestId: randomUUID(), commandKeyHash: sha256(randomUUID()), commandPayloadHash: sha256(randomUUID()),
      } });
      return tx.quoteRevision.create({ data: {
        tenantId: f.tenant.id, quoteId: f.quote.id, customerId: f.customer.id,
        actorUserId: f.user.id, version: 1, eventType: "UPDATED", title: f.quote.title,
        status: f.quote.status, customerPriceSubtotal: f.quote.customerPriceSubtotal,
        totalAmount: f.quote.totalAmount, snapshot: { synthetic: true },
      } });
    }, { maxWait: 5_000, timeout: 10_000 });
    // Capture rejection immediately so a detected database deadlock is reported
    // as this assertion, never as an unrelated unhandled rejection.
    const lifecycleResult = lifecycle.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    const lifecyclePid = await locked.promise;
    const reviewResult = persist(f).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await expect.poll(async () => {
        const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${lifecyclePid} = ANY(pg_blocking_pids(pid))) AS blocked`);
        return state.blocked;
      }, { timeout: 5_000 }).toBe(true);
    } finally { insertAudit.resolve(); }
    const [audit, review] = await Promise.all([lifecycleResult, reviewResult]);
    expect(audit, "Lifecycle audit must commit without a deadlock or retry").toMatchObject({ ok: true });
    expect(review, "Tax review must complete after the lifecycle transaction commits").toMatchObject({ ok: true });
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id, status: "REVIEWED" } })).toBe(1);
    const auditCount = kind === "customer"
      ? await prisma.customerActivityEvent.count({ where: { tenantId: f.tenant.id } })
      : kind === "job"
        ? await prisma.jobEvent.count({ where: { tenantId: f.tenant.id } })
        : await prisma.quoteRevision.count({ where: { tenantId: f.tenant.id } });
    expect(auditCount).toBe(1);
  });

  test("parallel claims issue one original token and never authorize provider publishing", async () => {
    const f = await fixture(); const row = await persist(f);
    const results = await Promise.all([claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id), claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)]);
    expect(results.filter((result) => result.outcome === "CLAIMED")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "NOT_CLAIMED")).toHaveLength(1);
    expect(results.every((result) => result.publishingAuthorized === false)).toBe(true);
    const winner = results.find((result) => result.outcome === "CLAIMED")!;
    const stored = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: "ESTIMATE_PROCESSING", attemptCount: 1, claimTokenHash: sha256(winner.claimToken), attemptTokenHash: sha256(winner.claimToken), estimateRequestId: row.estimateRequestId, invoiceRequestId: row.invoiceRequestId });
    expect(JSON.stringify(stored)).not.toContain(winner.claimToken);
  });

  test("an expired lease quarantines durably and never grants another claim", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    const original = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } });
    // Advance only the service's clock; dispatch evidence must remain immutable.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(original.claimExpiresAtUtc!.getTime() + 1));
      expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).toEqual({ outcome: "RECONCILIATION_REQUIRED", publishingAuthorized: false });
      expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).toEqual({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
      expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "ESTIMATE_RECONCILIATION_REQUIRED", attemptCount: 1, claimTokenHash: null, claimExpiresAtUtc: null, attemptTokenHash: sha256(attempt.claimToken), lastAttemptAtUtc: original.lastAttemptAtUtc, lastFailureCode: "QUICKBOOKS_ESTIMATE_RECONCILIATION_REQUIRED" });
      await retainTaxEstimateIdentity(runtimePrisma, attempt, "late-after-expiry");
    } finally { vi.useRealTimers(); }
  });

  test("late identity survives explicit uncertainty, manager demotion and disconnect without resuming publishing", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    expect(await markTaxEstimateUncertain(runtimePrisma, attempt)).toEqual({ outcome: "QUARANTINED", status: "ESTIMATE_RECONCILIATION_REQUIRED", publishingAuthorized: false });
    await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
    await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED", disconnectRequestedAtUtc: new Date() } });
    expect(await retainTaxEstimateIdentity(runtimePrisma, attempt, "late-disconnected-id")).toEqual({ retained: true });
    expect(await markTaxEstimateUncertain(runtimePrisma, attempt)).toEqual({ outcome: "UNCHANGED", status: "ESTIMATE_RECONCILIATION_REQUIRED", publishingAuthorized: false });
    const stored = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: "ESTIMATE_RECONCILIATION_REQUIRED", providerEstimateId: "late-disconnected-id", claimTokenHash: null, canonicalEstimateHash: null, canonicalAtUtc: null, providerSubtotal: null, providerTax: null, providerTotal: null });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).totalAmount.toFixed(2)).toBe("108.00");
  });

  test("a late result can be retained on superseded evidence without reviving its active status", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    const supersededAtUtc = new Date();
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "SUPERSEDED", supersededAtUtc, claimTokenHash: null, claimExpiresAtUtc: null } });
    expect(await retainTaxEstimateIdentity(runtimePrisma, attempt, "late-superseded-id")).toEqual({ retained: true });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SUPERSEDED", supersededAtUtc, providerEstimateId: "late-superseded-id", attemptTokenHash: sha256(attempt.claimToken), canonicalAtUtc: null });
    expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, row.id)).toMatchObject({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
  });

  test("duplicate identities are idempotent under concurrency; competing identities cannot overwrite", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    expect(await Promise.all([retainTaxEstimateIdentity(runtimePrisma, attempt, "estimate-same"), retainTaxEstimateIdentity(runtimePrisma, attempt, "estimate-same")])).toEqual([{ retained: true }, { retained: true }]);
    await expect(retainTaxEstimateIdentity(runtimePrisma, attempt, "estimate-conflicting")).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT" });
    expect((await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).providerEstimateId).toBe("estimate-same");
    const g = await fixture(); const next = await claimed(g);
    const competing = await Promise.allSettled([retainTaxEstimateIdentity(runtimePrisma, next.attempt, "estimate-a"), retainTaxEstimateIdentity(runtimePrisma, next.attempt, "estimate-b")]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = competing.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toMatchObject({ code: "QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT" });
  });

  test("only the original tenant-bound attempt token can record uncertainty or retain a result", async () => {
    const f = await fixture(); const foreign = await fixture(); const { row, attempt } = await claimed(f);
    const invalid = [
      { ...attempt, claimToken: "wrong" }, { ...attempt, claimToken: "A".repeat(43) },
      { ...attempt, tenantId: foreign.tenant.id }, { ...attempt, operationId: randomUUID() },
      { ...attempt, estimateRequestId: randomUUID() }, { ...attempt, sourceHash: "f".repeat(64) },
    ];
    for (const identity of invalid) {
      await expect(retainTaxEstimateIdentity(runtimePrisma, identity, "provider-safe")).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_ATTEMPT_INVALID" });
      await expect(markTaxEstimateUncertain(runtimePrisma, identity)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_ATTEMPT_INVALID" });
    }
    await expect(retainTaxEstimateIdentity(runtimePrisma, attempt, "unsafe provider prose\n")).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_PROVIDER_ID_INVALID" });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "ESTIMATE_PROCESSING", providerEstimateId: null });
  });

  test.each(["existing", "concurrent"] as const)("a provider Estimate cannot bind to two operations on the same connection (%s identity)", async (mode) => {
    const f = await fixture();
    const quote = await prisma.quote.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, status: "ACCEPTED", serviceType: "PLUMBING", title: "Second synthetic quote", scopeText: "Synthetic", internalCostSubtotal: 10, customerPriceSubtotal: 100, taxAmount: 8, totalAmount: 108 } });
    const job = await prisma.job.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobNumber: 2, title: "Second synthetic job", scopeSnapshot: "Synthetic", serviceType: "PLUMBING", acceptedAtUtc: new Date() } });
    const invoice = await prisma.invoice.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 2, titleSnapshot: "Second synthetic invoice", subtotalAmount: 100, taxAmount: 8, totalAmount: 108, balanceDue: 108 } });
    const line = await prisma.invoiceLineItem.create({ data: { tenantId: f.tenant.id, invoiceId: invoice.id, description: "Synthetic materials", quantity: 2, unitPrice: 50, lineTotal: 100, position: 0 } });
    const source = structuredClone(f.source);
    source.invoiceId = invoice.id; source.invoiceVersion = invoice.version; source.sourceQuoteId = quote.id;
    source.lines[0].invoiceLineItemId = line.id;
    const g = { ...f, quote, job, invoice, line, source };
    let first = await claimed(f); let second = await claimed(g);
    const providerId = "one-provider-estimate-two-local-operations";
    if (mode === "concurrent") {
      const results = await Promise.allSettled([
        retainTaxEstimateIdentity(runtimePrisma, first.attempt, providerId),
        retainTaxEstimateIdentity(runtimePrisma, second.attempt, providerId),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find(result => result.status === "rejected");
      expect(failure?.status === "rejected" && failure.reason).toMatchObject({ code: "QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT" });
      if (results[0].status === "rejected") [first, second] = [second, first];
    } else await retainTaxEstimateIdentity(runtimePrisma, first.attempt, providerId);
    const original = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: first.row.id } });
    const secondBefore = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: second.row.id } });
    const conflict = await retainTaxEstimateIdentity(runtimePrisma, second.attempt, providerId).then(() => null, (error: unknown) => error);
    expect(conflict).toMatchObject({ name: "QuickBooksTaxLedgerError", code: "QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT", message: "QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT" });
    expect(JSON.stringify(conflict)).not.toContain(providerId);
    expect(JSON.stringify(conflict)).not.toContain(f.connection.id);
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: first.row.id } })).toEqual(original);
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: second.row.id } })).toEqual(secondBefore);
    expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, first.row.id)).toEqual({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
    expect(await claimReviewedTaxEstimate(runtimePrisma, g.actor, second.row.id)).toEqual({ outcome: "NOT_CLAIMED", publishingAuthorized: false });
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(2);
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  test("identity retention preserves unrelated Prisma failures instead of translating them", async () => {
    const f = await fixture(); const { row, attempt } = await claimed(f);
    const original = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } });
    for (const error of [
      new Prisma.PrismaClientKnownRequestError("Synthetic unrelated uniqueness failure", { code: "P2002", clientVersion: Prisma.prismaVersion.client, meta: { target: ["tenantId", "estimateRequestId"] } }),
      new Prisma.PrismaClientKnownRequestError("Synthetic unspecified uniqueness failure", { code: "P2002", clientVersion: Prisma.prismaVersion.client, meta: { modelName: "QuickBooksTaxEstimateOperation", target: null } }),
      new Prisma.PrismaClientKnownRequestError("Synthetic unrelated database failure", { code: "P2025", clientVersion: Prisma.prismaVersion.client, meta: { target: ["quickBooksConnectionId", "providerEstimateId"] } }),
    ]) {
      const failingClient = new Proxy(runtimePrisma, { get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => runtimePrisma.$transaction(async (tx) => {
          const failure = vi.spyOn(tx.quickBooksTaxEstimateOperation, "updateMany").mockRejectedValueOnce(error);
          try { return await action(tx); } finally { failure.mockRestore(); }
        });
      } });
      await expect(retainTaxEstimateIdentity(failingClient, attempt, "unrelated-error-id")).rejects.toBe(error);
    }
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toEqual(original);
  });

  test("rotation accepts the configured previous key, preserves prior evidence, and signs new revisions with the current key", async () => {
    const f = await fixture(); const oldReview = prepareQuickBooksTaxEstimateReview(f.source, keys);
    const row = await persistReviewedTaxEstimate(runtimePrisma, f.actor, rotatedKeys, { source: f.source, binding: oldReview.binding });
    const original = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } });
    expect((await persist(f, f.source, rotatedKeys)).id).toBe(row.id);
    expect((await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).bindingKeyId).toBe(original.bindingKeyId);
    await expect(persistReviewedTaxEstimate(runtimePrisma, f.actor, { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: rotatedKeys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY }, { source: f.source, binding: oldReview.binding })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_REVIEW_CHANGED" });
    const changed = structuredClone(f.source); changed.destination.Line1 = "Next reviewed destination";
    const next = await persist(f, changed, rotatedKeys);
    expect((await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: next.id } })).bindingKeyId).not.toBe(original.bindingKeyId);
    expect(await claimReviewedTaxEstimate(runtimePrisma, f.actor, next.id)).toMatchObject({ outcome: "CLAIMED", publishingAuthorized: false });
  });
});
