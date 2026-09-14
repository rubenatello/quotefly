import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { QuickBooksReconciliationError, type QuickBooksReconciliationResult } from "../../src/services/quickbooks-reconciliation";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import { claimQuickBooksWebhookEvent, type QuickBooksWebhookClaim } from "../../src/services/quickbooks-webhook-inbox";
import { processQuickBooksWebhookClaim, processQuickBooksWebhookForTenant } from "../../src/services/quickbooks-webhook-processing";

const pendingKey = "quoteflyPendingInvoiceIds";
const providerKey = "quoteflyPendingProviderInvoiceIds";
const terminalKey = "quoteflyInvoiceTerminalFailures";

async function fixture(localIds: string[], providerIds: string[] = []) {
  const stamp = randomUUID();
  const tenant = await prisma.tenant.create({ data: { name: "Webhook isolation test", slug: stamp } });
  const user = await prisma.user.create({ data: { email: `${stamp}@example.com`, passwordHash: "synthetic-test-hash", fullName: "Test owner" } });
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const connection = await prisma.quickBooksConnection.create({ data: {
    tenantId: tenant.id, realmId: stamp, environment: "sandbox", status: "CONNECTED",
    setupConfirmedAtUtc: new Date(), setupConfirmedByTenantUserId: member.id,
    setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
  } });
  const event = await prisma.quickBooksWebhookEvent.create({ data: {
    tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: stamp,
    webhookEventId: stamp, eventType: "Payment", entityId: "payment-test", operation: "Update",
    payload: { [pendingKey]: localIds, [providerKey]: providerIds },
  } });
  const read = () => prisma.quickBooksWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
  const makeDue = () => prisma.quickBooksWebhookEvent.update({ where: { id: event.id }, data: { nextAttemptAtUtc: new Date(0) } });
  return { tenant, member, connection, event, read, makeDue };
}

function success(invoiceId: string): QuickBooksReconciliationResult {
  return { invoiceId, providerInvoiceId: invoiceId, invoiceStatus: "OPEN", paymentStatus: "PENDING",
    amountPaid: 0, balanceDue: 100, hostedPaymentUrlAvailable: false };
}

async function addMappedInvoice(f: Awaited<ReturnType<typeof fixture>>, providerInvoiceId: string, number: number) {
  const customer = await prisma.customer.create({ data: { tenantId: f.tenant.id, fullName: "Test customer", phone: String(5550100 + number) } });
  const quote = await prisma.quote.create({ data: {
    tenantId: f.tenant.id, customerId: customer.id, serviceType: "PLUMBING", title: "Test", scopeText: "Test",
    internalCostSubtotal: 0, customerPriceSubtotal: 100, taxAmount: 0, totalAmount: 100,
  } });
  const job = await prisma.job.create({ data: {
    tenantId: f.tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobNumber: number,
    title: "Test", scopeSnapshot: "Test", serviceType: "PLUMBING", acceptedAtUtc: new Date(),
  } });
  const invoice = await prisma.invoice.create({ data: {
    tenantId: f.tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id,
    invoiceNumber: number, titleSnapshot: "Test", subtotalAmount: 100, taxAmount: 0, totalAmount: 100, balanceDue: 100,
  } });
  await prisma.quickBooksInvoiceOperation.create({ data: {
    tenantId: f.tenant.id, invoiceId: invoice.id, quickBooksConnectionId: f.connection.id,
    requestedByTenantUserId: f.member.id, status: "SUCCEEDED", commandKeyHash: "a".repeat(64),
    payloadHash: "b".repeat(64), providerRealmId: f.connection.realmId, providerRequestId: providerInvoiceId,
    providerInvoiceId, providerDocNumber: providerInvoiceId, processingStartedAtUtc: new Date(), lastAttemptAtUtc: new Date(), succeededAtUtc: new Date(),
  } });
  return invoice.id;
}

describe("QuickBooks webhook invoice fanout checkpoints", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  test("a terminal middle invoice does not skip siblings and dead-letters only after draining", async () => {
    const f = await fixture(["first", "middle", "third"]);
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => {
      const row = await f.read();
      expect((row.payload as Prisma.JsonObject)[pendingKey]).toContain(invoiceId);
      if (invoiceId === "middle") throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_INVALID", "private provider payload", false);
      return success(invoiceId);
    });
    expect(await processQuickBooksWebhookForTenant({ prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile })).toMatchObject({ status: "dead" });
    expect(reconcile.mock.calls.map(([args]) => args.invoiceId)).toEqual(["first", "middle", "third"]);
    expect(await f.read()).toMatchObject({ status: "DEAD", payload: {
      [pendingKey]: [], [providerKey]: [], [terminalKey]: [["QUICKBOOKS_INVOICE_INVALID", 1]],
    } });
    expect(JSON.stringify((await f.read()).payload)).not.toContain("private provider payload");
  });

  test("transient middle failure retains only that invoice and retries without replaying successes", async () => {
    const f = await fixture(["first", "middle", "third"]);
    let fail = true;
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => {
      if (invoiceId === "middle" && fail) throw new QuickBooksReconciliationError("QUICKBOOKS_TEMPORARY", "temporary", true);
      return success(invoiceId);
    });
    const context = { prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile };
    expect(await processQuickBooksWebhookForTenant(context)).toMatchObject({ status: "failed" });
    expect(await f.read()).toMatchObject({ status: "FAILED", payload: { [pendingKey]: ["middle"] } });
    fail = false;
    await f.makeDue();
    expect(await processQuickBooksWebhookForTenant(context)).toMatchObject({ status: "processed" });
    expect(reconcile.mock.calls.map(([args]) => args.invoiceId)).toEqual(["first", "middle", "third", "middle"]);
    expect((await f.read()).status).toBe("PROCESSED");
  });

  test("eleven provider refs preserve page two after a terminal first-page failure", async () => {
    const providerIds = Array.from({ length: 11 }, (_, i) => `provider-${String(i).padStart(2, "0")}`);
    const f = await fixture([], providerIds);
    const invoiceIds = [];
    for (let i = 0; i < providerIds.length; i += 1) invoiceIds.push(await addMappedInvoice(f, providerIds[i]!, i + 1));
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => {
      if (invoiceId === invoiceIds[1]) throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_INVALID", "invalid", false);
      return success(invoiceId);
    });
    const context = { prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile };
    expect(await processQuickBooksWebhookForTenant(context)).toMatchObject({ status: "processed" });
    expect(await f.read()).toMatchObject({ status: "RECEIVED", payload: { [providerKey]: [providerIds[10]] } });
    expect(await processQuickBooksWebhookForTenant(context)).toMatchObject({ status: "dead" });
    expect(reconcile).toHaveBeenCalledTimes(11);
    expect(new Set(reconcile.mock.calls.map(([args]) => args.invoiceId))).toEqual(new Set(invoiceIds));
  });

  test("bounded retries cannot exhaust the parent before later local siblings are attempted", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `invoice-${i}`);
    const f = await fixture(ids);
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => {
      if (invoiceId === ids[0]) throw new QuickBooksReconciliationError("QUICKBOOKS_TEMPORARY", "temporary", true);
      return success(invoiceId);
    });
    const context = { prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile };
    await processQuickBooksWebhookForTenant(context);
    await processQuickBooksWebhookForTenant(context);
    expect(reconcile.mock.calls.some(([args]) => args.invoiceId === ids[10])).toBe(true);
    for (let i = 0; i < 6; i += 1) { await f.makeDue(); await processQuickBooksWebhookForTenant(context); }
    expect((await f.read()).status).toBe("DEAD");
    expect(reconcile.mock.calls.filter(([args]) => args.invoiceId === ids[0])).toHaveLength(8);
    expect(reconcile.mock.calls.filter(([args]) => args.invoiceId !== ids[0])).toHaveLength(10);
  });

  test("lease loss between canonical commit and checkpoint replays unresolved work idempotently", async () => {
    const f = await fixture(["first", "middle", "third"]);
    let reclaimed: QuickBooksWebhookClaim | null = null;
    const committed = new Set<string>();
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => {
      committed.add(invoiceId); // The canonical reconciler independently deduplicates provider evidence.
      if (invoiceId === "middle" && !reclaimed) {
        await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { claimExpiresAtUtc: new Date(0) } });
        reclaimed = await claimQuickBooksWebhookEvent(prisma, f.tenant.id);
      }
      return success(invoiceId);
    });
    expect(await processQuickBooksWebhookForTenant({ prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile }))
      .toMatchObject({ status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" });
    expect(await f.read()).toMatchObject({ status: "PROCESSING", payload: { [pendingKey]: ["middle", "third"] } });
    expect(reclaimed).not.toBeNull();
    expect(await processQuickBooksWebhookClaim({ prisma, runtimeEnv: env, reconcile }, reclaimed!)).toMatchObject({ status: "processed" });
    expect(reconcile.mock.calls.map(([args]) => args.invoiceId)).toEqual(["first", "middle", "middle", "third"]);
    expect([...committed]).toEqual(["first", "middle", "third"]);
    expect((await f.read()).status).toBe("PROCESSED");
  });

  test("an empty checkpoint resumes completion without refetching or replaying provider work", async () => {
    const f = await fixture([]);
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => success(invoiceId));
    expect(await processQuickBooksWebhookForTenant({ prisma, runtimeEnv: env, tenantId: f.tenant.id, reconcile })).toMatchObject({ status: "processed" });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("PROCESSED");
  });

  test("a stale or wrong-tenant lease never drains or completes a newer claim", async () => {
    const f = await fixture(["first"]);
    const first = await claimQuickBooksWebhookEvent(prisma, f.tenant.id);
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { claimExpiresAtUtc: new Date(0) } });
    const second = await claimQuickBooksWebhookEvent(prisma, f.tenant.id);
    const reconcile = vi.fn(async ({ invoiceId }: { invoiceId: string }) => success(invoiceId));
    expect(await processQuickBooksWebhookClaim({ prisma, runtimeEnv: env, reconcile }, first!)).toMatchObject({ failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" });
    expect(await processQuickBooksWebhookClaim({ prisma, runtimeEnv: env, reconcile }, { ...second!, tenantId: "other-tenant" })).toMatchObject({ status: "failed" });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("PROCESSING");
  });
});
