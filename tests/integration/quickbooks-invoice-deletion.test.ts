import { createHash, createHmac, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { encryptQuickBooksHostedPaymentLink, quickBooksInvoiceFingerprint, QuickBooksProviderError } from "../../src/services/quickbooks";
import { reconcileQuickBooksInvoice } from "../../src/services/quickbooks-reconciliation";
import { adoptQuickBooksWebhookQuarantine, quickBooksWebhookEventId } from "../../src/services/quickbooks-webhook-inbox";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import { disconnectQuickBooksConnection, invalidateQuickBooksHostedPaymentLinks } from "../../src/services/quickbooks-credentials";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

const provider = vi.hoisted(() => ({ fetchInvoice: vi.fn() }));
vi.mock("../../src/services/quickbooks", async () => ({
  ...await vi.importActual<typeof import("../../src/services/quickbooks")>("../../src/services/quickbooks"),
  fetchQuickBooksInvoice: provider.fetchInvoice,
}));

let app: FastifyInstance;
type Owner = { tenantId: string; memberId: string };

async function owner(): Promise<Owner> {
  const unique = randomUUID();
  const tenant = await prisma.tenant.create({ data: { name: "Deletion test", slug: unique } });
  const user = await prisma.user.create({ data: { email: `${unique}@example.com`, fullName: "Test owner", passwordHash: "unused-test-hash" } });
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  return { tenantId: tenant.id, memberId: member.id };
}

async function fixture(account: Owner, providerInvoiceId = "provider-invoice", sequence = 1) {
  const now = new Date();
  const phone = String(5550000000 + sequence);
  const customer = await prisma.customer.create({ data: { tenantId: account.tenantId, fullName: "Test customer", phone, phoneDigits: phone } });
  const quote = await prisma.quote.create({ data: {
    tenantId: account.tenantId, customerId: customer.id, serviceType: "CONSTRUCTION", status: "ACCEPTED",
    title: "Test work", scopeText: "Test work", customerPriceSubtotal: 100, internalCostSubtotal: 20, taxAmount: 0, totalAmount: 100,
  } });
  const job = await prisma.job.create({ data: {
    tenantId: account.tenantId, customerId: customer.id, sourceQuoteId: quote.id,
    jobNumber: sequence, title: "Test work", scopeSnapshot: "Test work", serviceType: "CONSTRUCTION", acceptedAtUtc: now,
  } });
  const invoice = await prisma.invoice.create({ data: {
    tenantId: account.tenantId, customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id,
    invoiceNumber: sequence, status: "OPEN", titleSnapshot: "Test work", subtotalAmount: 100, taxAmount: 0, totalAmount: 100, balanceDue: 100,
  } });
  const connection = await prisma.quickBooksConnection.upsert({
    where: { tenantId: account.tenantId }, update: {}, create: {
      tenantId: account.tenantId, realmId: `realm-${account.tenantId}`, environment: "sandbox", status: "CONNECTED",
      setupConfirmedAtUtc: now, setupConfirmedByTenantUserId: account.memberId, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    },
  });
  await prisma.quickBooksRealmBinding.upsert({
    where: { quickBooksConnectionId: connection.id }, update: {}, create: {
      tenantId: account.tenantId, quickBooksConnectionId: connection.id, realmId: connection.realmId, active: true,
    },
  });
  const snapshot = {
    Id: providerInvoiceId, DocNumber: `QF-${sequence}`, CustomerRef: { value: "test-customer" }, CurrencyRef: { value: "USD" },
    TotalAmt: 100, Balance: 100, SyncToken: "1", MetaData: { LastUpdatedTime: now.toISOString() },
    AllowOnlineACHPayment: false, AllowOnlineCreditCardPayment: true, AllowOnlinePayment: true,
    InvoiceLink: "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-test",
    Line: [{ Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "test-item" }, Qty: 1, UnitPrice: 100 } }],
  };
  const operation = await prisma.quickBooksInvoiceOperation.create({ data: {
    tenantId: account.tenantId, invoiceId: invoice.id, quickBooksConnectionId: connection.id, requestedByTenantUserId: account.memberId,
    status: "SUCCEEDED", commandKeyHash: createHash("sha256").update(invoice.id).digest("hex"), payloadHash: quickBooksInvoiceFingerprint(snapshot),
    providerRealmId: connection.realmId, providerInvoiceId, providerRequestId: invoice.id, providerDocNumber: snapshot.DocNumber,
    providerInvoiceLink: encryptQuickBooksHostedPaymentLink(env, snapshot.InvoiceLink), providerSyncToken: "1", providerUpdatedAtUtc: now,
    invoiceLinkFetchedAtUtc: now, lastReconciledAtUtc: now, processingStartedAtUtc: now, lastAttemptAtUtc: now, succeededAtUtc: now,
    providerBalance: 100, allowOnlineCardPayment: true,
  } });
  return { account, invoice, connection, operation, snapshot };
}

async function deliver(record: Awaited<ReturnType<typeof fixture>>, entity = "Invoice", signatureValid = true) {
  const payload = JSON.stringify({ eventNotifications: [{ realmId: record.connection.realmId, dataChangeEvent: { entities: [{
    name: entity, id: record.operation.providerInvoiceId, operation: "Delete", lastUpdated: "2026-09-13T20:00:00.000Z",
  }] } }] });
  return app.inject({
    method: "POST", url: "/v1/integrations/quickbooks/webhook", payload,
    headers: { "content-type": "application/json", "intuit-signature": createHmac("sha256", signatureValid ? env.QUICKBOOKS_WEBHOOK_VERIFIER : "invalid-test-verifier").update(payload).digest("base64") },
  });
}

function reconcile(record: Awaited<ReturnType<typeof fixture>>, client = prisma) {
  return reconcileQuickBooksInvoice({ prisma: client, runtimeEnv: env, tenantId: record.account.tenantId, invoiceId: record.invoice.id, trigger: "MANUAL", getAccessToken: async () => "synthetic-test-access" });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitForBlockedClient(holderPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND ${holderPid} = ANY(pg_blocking_pids(pid))
      ) AS blocked
    `);
    if (state?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the concurrent QuickBooks transaction.");
}

async function seedPendingDeletion(record: Awaited<ReturnType<typeof fixture>>) {
  const notification = {
    realmId: record.connection.realmId, name: "Invoice", id: record.operation.providerInvoiceId!,
    operation: "Delete", lastUpdated: "2026-09-13T20:00:00.000Z",
  };
  return prisma.quickBooksWebhookEvent.create({ data: {
    tenantId: record.account.tenantId, quickBooksConnectionId: record.connection.id,
    realmId: notification.realmId, webhookEventId: quickBooksWebhookEventId(notification),
    eventType: notification.name, entityId: notification.id, operation: notification.operation,
    status: "DEAD", deadAtUtc: new Date(), lastError: "QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED", payload: {},
  } });
}

describe("QuickBooks deleted invoice payment-link safety", () => {
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  beforeEach(() => { provider.fetchInvoice.mockReset(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  test("signed duplicate Invoice Delete invalidates only the bound invoice and preserves financial history", async () => {
    const account = await owner();
    const record = await fixture(account);
    const unrelated = await fixture(account, "unrelated-invoice", 2);
    const otherTenant = await fixture(await owner()); // Same provider invoice ID, different realm/tenant.
    const payment = await prisma.invoicePayment.create({ data: {
      tenantId: account.tenantId, invoiceId: record.invoice.id, provider: "QUICKBOOKS", providerPaymentId: "retained-payment",
      providerInvoiceId: record.operation.providerInvoiceId, status: "SUCCEEDED", amount: 25,
    } });
    expect((await deliver(record)).statusCode).toBe(200);
    const invalidated = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } });
    expect(invalidated).toMatchObject({ status: "RECONCILIATION_REQUIRED", providerInvoiceLink: null, invoiceLinkFetchedAtUtc: null,
      providerSyncToken: null, providerUpdatedAtUtc: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW", claimTokenHash: null });
    expect((await deliver(record)).statusCode).toBe(200);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(invalidated);
    for (const unaffected of [unrelated, otherTenant]) {
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: unaffected.operation.id } })).toEqual(unaffected.operation);
    }
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
    expect(await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment);
    expect(await prisma.invoiceEvent.count({ where: { tenantId: account.tenantId, invoiceId: record.invoice.id, type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBe(1);
    expect(await prisma.quickBooksWebhookEvent.findFirstOrThrow({ where: { tenantId: account.tenantId } })).toMatchObject({ status: "DEAD", lastError: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW" });
    await expect(reconcile(record)).rejects.toMatchObject({ code: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW", retryable: false });
    expect(provider.fetchInvoice).not.toHaveBeenCalled();
  });

  test("invalid signature cannot invalidate a cached link", async () => {
    const record = await fixture(await owner());
    expect((await deliver(record, "Invoice", false)).statusCode).toBe(401);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(record.operation);
    expect(await prisma.quickBooksWebhookEvent.count({ where: { tenantId: record.account.tenantId } })).toBe(0);
  });

  test("a quarantined Invoice Delete is applied atomically on realm adoption", async () => {
    const record = await fixture(await owner());
    await prisma.quickBooksRealmBinding.update({ where: { quickBooksConnectionId: record.connection.id }, data: { active: false } });
    expect((await deliver(record)).statusCode).toBe(200);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(record.operation);
    await prisma.quickBooksRealmBinding.update({ where: { quickBooksConnectionId: record.connection.id }, data: { active: true } });
    const binding = { tenantId: record.account.tenantId, quickBooksConnectionId: record.connection.id, realmId: record.connection.realmId };
    expect(await adoptQuickBooksWebhookQuarantine(prisma, binding)).toBe(1);
    expect(await adoptQuickBooksWebhookQuarantine(prisma, binding)).toBe(0);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({ providerInvoiceLink: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW" });
    expect(await prisma.invoiceEvent.count({ where: { tenantId: record.account.tenantId, invoiceId: record.invoice.id } })).toBe(1);
  });

  test("RefundReceipt Delete with no stored receipt linkage stays manual attention without guessing an invoice", async () => {
    const record = await fixture(await owner());
    expect((await deliver(record, "RefundReceipt")).statusCode).toBe(200);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(record.operation);
    expect(await prisma.quickBooksWebhookEvent.findFirstOrThrow({ where: { tenantId: record.account.tenantId } })).toMatchObject({ status: "DEAD", lastError: "QUICKBOOKS_REFUND_DELETED_LINKAGE_UNKNOWN_MANUAL_REVIEW" });
  });

  test("an in-flight canonical read cannot restore a deleted invoice's link", async () => {
    const record = await fixture(await owner());
    provider.fetchInvoice.mockImplementationOnce(async () => {
      expect((await deliver(record)).statusCode).toBe(200);
      return record.snapshot;
    });
    await expect(reconcile(record)).rejects.toMatchObject({ code: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW", retryable: false });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({ providerInvoiceLink: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
  });

  test("canonical typed 404 clears the cached link and requires manual review without changing the ledger", async () => {
    const record = await fixture(await owner());
    provider.fetchInvoice.mockRejectedValueOnce(new QuickBooksProviderError("QUICKBOOKS_REQUEST_FAILED", false, 404));
    await expect(reconcile(record)).rejects.toMatchObject({ code: "QUICKBOOKS_INVOICE_NOT_FOUND_MANUAL_REVIEW", retryable: false });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({ status: "RECONCILIATION_REQUIRED", providerInvoiceLink: null, invoiceLinkFetchedAtUtc: null, providerSyncToken: null, providerUpdatedAtUtc: null, lastFailureCode: "QUICKBOOKS_INVOICE_NOT_FOUND_MANUAL_REVIEW" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
    await expect(reconcile(record)).rejects.toMatchObject({ code: "QUICKBOOKS_INVOICE_NOT_FOUND_MANUAL_REVIEW" });
    expect(provider.fetchInvoice).toHaveBeenCalledTimes(1);
    expect(await prisma.invoiceEvent.count({ where: { tenantId: record.account.tenantId, invoiceId: record.invoice.id } })).toBe(1);
  });

  test("500 signed ingress notifications drain a 125-event backlog in a constant number of database round trips", async () => {
    const record = await fixture(await owner());
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: record.invoice.sourceQuoteId } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: record.invoice.jobId } });
    const rows = Array.from({ length: 625 }, (_, index) => ({
      quoteId: randomUUID(), jobId: randomUUID(), invoiceId: randomUUID(), operationId: randomUUID(),
      providerId: `batch-provider-${index}`, sequence: index + 2,
    }));
    await prisma.quote.createMany({ data: rows.map((row) => ({ ...quote, id: row.quoteId })) });
    await prisma.job.createMany({ data: rows.map((row) => ({ ...job, id: row.jobId, sourceQuoteId: row.quoteId, jobNumber: row.sequence })) });
    await prisma.invoice.createMany({ data: rows.map((row) => ({ ...record.invoice, id: row.invoiceId, jobId: row.jobId, sourceQuoteId: row.quoteId, invoiceNumber: row.sequence })) });
    await prisma.quickBooksInvoiceOperation.createMany({ data: rows.map((row) => ({
      ...record.operation, id: row.operationId, invoiceId: row.invoiceId, providerInvoiceId: row.providerId,
      providerRequestId: row.operationId, commandKeyHash: createHash("sha256").update(row.operationId).digest("hex"),
    })) });
    await prisma.quickBooksWebhookEvent.createMany({ data: rows.slice(0, 125).map((row) => ({
      tenantId: record.account.tenantId, quickBooksConnectionId: record.connection.id, realmId: record.connection.realmId,
      webhookEventId: createHash("sha256").update(row.operationId).digest("hex"), entityId: row.providerId,
      eventType: "Invoice", operation: "Delete", status: "DEAD", deadAtUtc: new Date(),
      lastError: "QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED", payload: {},
    })) });
    const observed = new PrismaClient({ log: [{ level: "query", emit: "event" }] });
    let queryCount = 0;
    let invalidationStatements = 0;
    observed.$on("query", (event) => {
      queryCount += 1;
      if (event.query.includes("WITH deletion_candidates")) invalidationStatements += 1;
    });
    const previousClient = app.prisma;
    app.prisma = observed;
    try {
      const payload = JSON.stringify({ eventNotifications: Array.from({ length: 5 }, (_, batch) => ({ realmId: record.connection.realmId, dataChangeEvent: { entities: rows.slice(125 + batch * 100, 225 + batch * 100).map((row) => ({
        name: "Invoice", id: row.providerId, operation: "Delete", lastUpdated: "2026-09-13T20:00:00.000Z",
      })) } })) });
      const started = performance.now();
      const response = await app.inject({ method: "POST", url: "/v1/integrations/quickbooks/webhook", payload,
        headers: { "content-type": "application/json", "intuit-signature": createHmac("sha256", env.QUICKBOOKS_WEBHOOK_VERIFIER).update(payload).digest("base64") } });
      const elapsedMs = Math.round(performance.now() - started);
      expect(response.statusCode).toBe(200);
      expect(invalidationStatements).toBe(1);
      expect(queryCount).toBeLessThanOrEqual(20);
      console.info(JSON.stringify({ notificationCount: 500, priorDeletionBacklog: 125, queryCount, elapsedMs }));
      expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: record.account.tenantId, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW", providerInvoiceLink: null } })).toBe(625);
      expect(await prisma.invoiceEvent.count({ where: { tenantId: record.account.tenantId, type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBe(625);
      expect(await prisma.quickBooksWebhookEvent.count({ where: { tenantId: record.account.tenantId, lastError: "QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED" } })).toBe(0);
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(record.operation);
    } finally {
      app.prisma = previousClient;
      await observed.$disconnect();
    }
  });

  test("deletion between projection read and CAS fences an operation with initially null generation", async () => {
    const record = await fixture(await owner());
    await prisma.quickBooksInvoiceOperation.update({ where: { id: record.operation.id }, data: {
      status: "RECONCILIATION_REQUIRED", providerSyncToken: null, providerUpdatedAtUtc: null, lastReconciledAtUtc: null,
      failedAtUtc: new Date(), lastFailureCode: "QUICKBOOKS_INVOICE_CONFIRMATION_FAILED", succeededAtUtc: null,
    } });
    provider.fetchInvoice.mockResolvedValueOnce(record.snapshot);
    let interrupted = false;
    const racingClient = prisma.$extends({ query: { quickBooksInvoiceOperation: {
      async updateMany({ args, query }) {
        if (args.data.status === "SUCCEEDED" && !interrupted) {
          interrupted = true;
          expect((await deliver(record)).statusCode).toBe(200);
        }
        return query(args);
      },
    } } });
    await expect(reconcile(record, racingClient as unknown as PrismaClient)).rejects.toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_CAS_LOST" });
    expect(interrupted).toBe(true);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({ providerInvoiceLink: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
  });

  test("deletion after a successful canonical projection clears the newly refreshed link", async () => {
    const record = await fixture(await owner());
    await prisma.quickBooksInvoiceOperation.update({ where: { id: record.operation.id }, data: { providerSyncToken: null, providerUpdatedAtUtc: null, lastReconciledAtUtc: null } });
    provider.fetchInvoice.mockResolvedValueOnce(record.snapshot);
    await expect(reconcile(record)).resolves.toMatchObject({ hostedPaymentUrlAvailable: true });
    expect((await deliver(record)).statusCode).toBe(200);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({ providerInvoiceLink: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
  });

  for (const firstLock of ["connection", "tenant"] as const) {
    test(`signed deletion and a ${firstLock}-first lifecycle transaction complete without deadlock`, async () => {
      const record = await fixture(await owner());
      await seedPendingDeletion(record);
      const holder = new PrismaClient();
      const locked = deferred();
      const proceed = deferred();
      let holderPid = 0;
      const lifecycle = withTenantRlsContext(holder, record.account.tenantId, async (tx) => {
        [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (firstLock === "tenant") {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${record.account.tenantId} FOR UPDATE`);
        } else {
          // Matches an ordinary non-key credential UPDATE: child foreign-key
          // reads remain compatible, so the old event-first ingress deadlocks.
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "id" = ${record.connection.id} FOR NO KEY UPDATE`);
        }
        locked.resolve();
        await proceed.promise;
        await tx.quickBooksConnection.update({ where: { id: record.connection.id }, data: { lastError: "synthetic-lifecycle" } });
        await invalidateQuickBooksHostedPaymentLinks(tx, record.account.tenantId, record.connection.id);
      }, { timeout: 15_000 });
      void lifecycle.catch(() => locked.resolve());
      let delivery: PromiseLike<Awaited<ReturnType<typeof deliver>>> | undefined;
      try {
        await locked.promise;
        delivery = deliver(record);
        await waitForBlockedClient(holderPid);
        proceed.resolve();
        await lifecycle;
        expect((await delivery).statusCode).toBe(200);
        expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toMatchObject({
          providerInvoiceLink: null, lastFailureCode: "QUICKBOOKS_INVOICE_DELETED_MANUAL_REVIEW",
        });
        expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
        expect(await prisma.invoiceEvent.count({ where: { invoiceId: record.invoice.id, type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBe(1);
      } finally {
        proceed.resolve();
        await Promise.allSettled([lifecycle, ...(delivery ? [delivery] : [])]);
        await holder.$disconnect();
      }
    });
  }

  test("a realm binding deactivated while ingress waits is quarantined without touching the old invoice", async () => {
    const record = await fixture(await owner());
    const holder = new PrismaClient();
    const locked = deferred();
    const proceed = deferred();
    let holderPid = 0;
    const lifecycle = withTenantRlsContext(holder, record.account.tenantId, async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${record.account.tenantId} FOR UPDATE`);
      locked.resolve();
      await proceed.promise;
      await tx.quickBooksRealmBinding.update({ where: { quickBooksConnectionId: record.connection.id }, data: { active: false } });
    }, { timeout: 15_000 });
    void lifecycle.catch(() => locked.resolve());
    let delivery: PromiseLike<Awaited<ReturnType<typeof deliver>>> | undefined;
    try {
      await locked.promise;
      delivery = deliver(record);
      await waitForBlockedClient(holderPid);
      proceed.resolve();
      await lifecycle;
      const response = await delivery;
      expect(response.statusCode).toBe(200);
      // Public acknowledgements intentionally disclose no realm-routing state.
      expect(response.json()).toMatchObject({ received: true, persisted: 1 });
      expect(await prisma.quickBooksWebhookEvent.findFirstOrThrow({ where: { realmId: record.connection.realmId } })).toMatchObject({
        tenantId: null, quickBooksConnectionId: null, payload: { quarantined: true }, status: "RECEIVED",
      });
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: record.operation.id } })).toEqual(record.operation);
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: record.invoice.id } })).toEqual(record.invoice);
      expect(await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: record.connection.id } })).toEqual(record.connection);
      expect(await adoptQuickBooksWebhookQuarantine(prisma, {
        tenantId: record.account.tenantId, quickBooksConnectionId: record.connection.id, realmId: record.connection.realmId,
      })).toBe(0);
    } finally {
      proceed.resolve();
      await Promise.allSettled([lifecycle, ...(delivery ? [delivery] : [])]);
      await holder.$disconnect();
    }
  });

  for (const parent of ["tenant", "previous actor"] as const) {
    test(`disconnect waits for the ${parent} before locking the connection and preserves the original audit actor`, async () => {
      const record = await fixture(await owner());
      const callerUser = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, fullName: "Current caller", passwordHash: "unused-test-hash" } });
      const caller = await prisma.tenantUser.create({ data: { tenantId: record.account.tenantId, userId: callerUser.id, role: "admin" } });
      await prisma.quickBooksConnectionEvent.create({ data: {
        tenantId: record.account.tenantId, quickBooksConnectionId: record.connection.id,
        actorTenantUserId: record.account.memberId, action: "DISCONNECT_REQUESTED", outcome: "PENDING",
        requestId: "synthetic-previous-disconnect", connectionGeneration: 1,
      } });
      const holder = new PrismaClient();
      const locked = deferred();
      const proceed = deferred();
      let holderPid = 0;
      const parentTransaction = withTenantRlsContext(holder, record.account.tenantId, async (tx) => {
        [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (parent === "tenant") {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${record.account.tenantId} FOR UPDATE`);
        } else {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TenantUser" WHERE "id" = ${record.account.memberId} FOR UPDATE`);
        }
        locked.resolve();
        await proceed.promise;
        // This fails immediately if disconnect takes its child connection lock
        // before the tenant or reused audit actor's foreign-key lock.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "id" = ${record.connection.id} FOR UPDATE NOWAIT`);
      }, { timeout: 15_000 });
      void parentTransaction.catch(() => locked.resolve());
      let disconnect: ReturnType<typeof disconnectQuickBooksConnection> | undefined;
      try {
        await locked.promise;
        disconnect = disconnectQuickBooksConnection({ prisma, runtimeEnv: env, tenantId: record.account.tenantId, actorTenantUserId: caller.id });
        await waitForBlockedClient(holderPid);
        proceed.resolve();
        await parentTransaction;
        expect(await disconnect).toBe("disconnected");
        expect(await prisma.quickBooksConnectionEvent.findFirstOrThrow({ where: { tenantId: record.account.tenantId, action: "DISCONNECTED" } })).toMatchObject({ actorTenantUserId: record.account.memberId });
      } finally {
        proceed.resolve();
        await Promise.allSettled([parentTransaction, ...(disconnect ? [disconnect] : [])]);
        await holder.$disconnect();
      }
    });
  }
});
