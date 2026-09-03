import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import {
  createSignedQuickBooksState,
  encryptQuickBooksSecret,
  quickBooksInvoiceFingerprint,
  QuickBooksProviderError,
} from "../../src/services/quickbooks";
import { reconcileQuickBooksInvoice } from "../../src/services/quickbooks-reconciliation";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import {
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
} from "../../src/services/worker-heartbeats";

const quickBooksProviderMocks = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  fetchInvoice: vi.fn(),
  findInvoiceByDocNumber: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  fetchCompanyInfo: vi.fn(),
  fetchPayment: vi.fn(),
  fetchRefundReceipt: vi.fn(),
  fetchCustomer: vi.fn(),
  fetchItem: vi.fn(),
  refreshToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("../../src/services/quickbooks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/quickbooks")>(
    "../../src/services/quickbooks",
  );
  return {
    ...actual,
    createQuickBooksInvoice: quickBooksProviderMocks.createInvoice,
    fetchQuickBooksInvoice: quickBooksProviderMocks.fetchInvoice,
    findQuickBooksInvoicesByDocNumber: quickBooksProviderMocks.findInvoiceByDocNumber,
    exchangeQuickBooksAuthorizationCode: quickBooksProviderMocks.exchangeAuthorizationCode,
    fetchQuickBooksCompanyInfo: quickBooksProviderMocks.fetchCompanyInfo,
    fetchQuickBooksPayment: quickBooksProviderMocks.fetchPayment,
    fetchQuickBooksRefundReceipt: quickBooksProviderMocks.fetchRefundReceipt,
    fetchQuickBooksCustomer: quickBooksProviderMocks.fetchCustomer,
    fetchQuickBooksItem: quickBooksProviderMocks.fetchItem,
    refreshQuickBooksAccessToken: quickBooksProviderMocks.refreshToken,
    revokeQuickBooksToken: quickBooksProviderMocks.revokeToken,
  };
});

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

type MemberSession = Session & { membershipId: string };

let app: FastifyInstance;
let remoteAddressSequence = 1;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(label: string): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${label}-${unique}@example.com`,
      password: "TestPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} Services ${unique}`,
      primaryTrade: "CONSTRUCTION",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

async function addMember(owner: Session, label: string, role: "member" | "admin" = "member"): Promise<MemberSession> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName: label, role },
  });
  expect(created.statusCode).toBe(201);
  const membershipId = (created.json() as { member: { id: string } }).member.id;
  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/signin",
    remoteAddress: `198.51.100.${remoteAddressSequence++}`,
    payload: { email, password },
  });
  expect(signedIn.statusCode).toBe(200);
  return { ...(signedIn.json() as Omit<Session, "cookie">), cookie: cookieFrom(signedIn), membershipId };
}

async function createCustomer(session: Session, name: string, assignedTenantUserId?: string | null) {
  const suffix = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
  return prisma.customer.create({
    data: {
      tenantId: session.tenant.id,
      fullName: name,
      phone: suffix,
      phoneDigits: suffix,
      assignedTenantUserId,
    },
  });
}

async function createQuote(
  session: Session,
  customerId: string,
  title: string,
  assignedTenantUserId?: string | null,
  overrides: Record<string, unknown> = {},
) {
  return prisma.quote.create({
    data: {
      tenantId: session.tenant.id,
      customerId,
      assignedTenantUserId,
      serviceType: "CONSTRUCTION",
      status: "DRAFT",
      title,
      scopeText: `${title} accepted scope snapshot.`,
      documentLocale: "es-US",
      internalCostSubtotal: 50,
      customerPriceSubtotal: 150,
      taxAmount: 12,
      totalAmount: 162,
      ...overrides,
    },
  });
}

async function acceptQuote(session: Session, quoteId: string) {
  const response = await app.inject({
    method: "PATCH",
    url: `/v1/quotes/${quoteId}`,
    headers: { cookie: session.cookie },
    payload: { status: "ACCEPTED" },
  });
  expect(response.statusCode).toBe(200);
  return response;
}

async function jobForQuote(tenantId: string, quoteId: string) {
  return prisma.job.findFirstOrThrow({
    where: { tenantId, sourceQuoteId: quoteId, deletedAtUtc: null },
  });
}

async function getQuickBooksReviewBinding(owner: Session, invoiceId: string): Promise<string> {
  const previewResponse = await app.inject({
    method: "POST",
    url: `/v1/integrations/quickbooks/invoices/${invoiceId}/sync-preview`,
    headers: { cookie: owner.cookie },
    payload: {},
  });
  expect(previewResponse.statusCode).toBe(200);
  const reviewBinding = (previewResponse.json() as {
    preview: { reviewBinding: string | null };
  }).preview.reviewBinding;
  expect(reviewBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return reviewBinding as string;
}

async function createQuickBooksReadyInvoice(
  owner: Session,
  label: string,
  existingConnection?: Awaited<ReturnType<typeof prisma.quickBooksConnection.create>>,
) {
  const customer = await createCustomer(owner, `${label} Customer`);
  const title = `${label} service`;
  const quote = await createQuote(owner, customer.id, title, null, {
    taxAmount: 0,
    totalAmount: 150,
  });
  await acceptQuote(owner, quote.id);
  const created = await app.inject({
    method: "POST",
    url: "/v1/invoices",
    headers: {
      cookie: owner.cookie,
      "idempotency-key": `invoice-qb-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    payload: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
  });
  expect(created.statusCode).toBe(201);
  const invoice = (created.json() as { invoice: { id: string; version: number } }).invoice;
  const reviewer = await prisma.tenantUser.findFirstOrThrow({
    where: { tenantId: owner.tenant.id, userId: owner.user.id, deletedAtUtc: null },
    select: { id: true },
  });
  const connection = existingConnection ?? await prisma.quickBooksConnection.create({
    data: {
      tenantId: owner.tenant.id,
      realmId: `realm-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      environment: "sandbox",
      companyName: `${label} QuickBooks Company`,
      status: "CONNECTED",
      accessTokenEncrypted: encryptQuickBooksSecret(env, "test-access-token"),
      refreshTokenEncrypted: encryptQuickBooksSecret(env, "test-refresh-token"),
      accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: reviewer.id,
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    },
  });
  await prisma.quickBooksConnection.update({
    where: { id: connection.id },
    data: {
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: reviewer.id,
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    },
  });
  await prisma.quickBooksRealmBinding.upsert({
    where: { quickBooksConnectionId: connection.id },
    create: {
      tenantId: owner.tenant.id,
      quickBooksConnectionId: connection.id,
      realmId: connection.realmId,
      active: true,
    },
    update: { realmId: connection.realmId, active: true },
  });
  await prisma.quickBooksCustomerMap.create({
    data: {
      tenantId: owner.tenant.id,
      quickBooksConnectionId: connection.id,
      customerId: customer.id,
      quickBooksCustomerId: `qb-customer-${label}`,
      quickBooksDisplayName: `${label} QuickBooks Customer`,
      reviewedByTenantUserId: reviewer.id,
      reviewedAtUtc: new Date(),
      reviewVersion: 1,
    },
  });
  await prisma.quickBooksItemMap.create({
    data: {
      tenantId: owner.tenant.id,
      quickBooksConnectionId: connection.id,
      itemKey: title.toLowerCase(),
      quickBooksItemId: `qb-item-${label}`,
      quickBooksItemName: `${label} QuickBooks Service Item`,
      reviewedByTenantUserId: reviewer.id,
      reviewedAtUtc: new Date(),
      reviewVersion: 1,
    },
  });
  const reviewBinding = await getQuickBooksReviewBinding(owner, invoice.id);
  return { customer, quote, invoice, connection, title, reviewBinding };
}

async function createQuickBooksReconciliationFixture(
  owner: Session,
  label: string,
  existingConnection?: Awaited<ReturnType<typeof prisma.quickBooksConnection.create>>,
) {
  const fixture = await createQuickBooksReadyInvoice(owner, label, existingConnection);
  const reviewer = await prisma.tenantUser.findFirstOrThrow({
    where: { tenantId: owner.tenant.id, userId: owner.user.id },
    select: { id: true },
  });
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: fixture.invoice.id },
    include: { lineItems: true },
  });
  const providerInvoiceId = `provider-invoice-${label}`;
  const providerPayload = {
    Id: providerInvoiceId,
    DocNumber: `QF-${String(invoice.invoiceNumber).padStart(6, "0")}`,
    TxnDate: invoice.createdAt.toISOString().slice(0, 10),
    DueDate: invoice.dueAtUtc?.toISOString().slice(0, 10),
    PrivateNote: `QuoteFly:${createHash("sha256").update(`${owner.tenant.id}:${invoice.id}`).digest("hex").slice(0, 24)}`,
    CustomerRef: { value: `qb-customer-${label}` },
    CurrencyRef: { value: "USD" },
    TotalAmt: Number(invoice.totalAmount),
    Line: invoice.lineItems.map((line) => ({
      Description: line.description,
      Amount: Number(line.lineTotal),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        Qty: Number(line.quantity),
        UnitPrice: Number(line.unitPrice),
        ItemRef: { value: `qb-item-${label}` },
      },
    })),
  };
  const operation = await prisma.quickBooksInvoiceOperation.create({
    data: {
      tenantId: owner.tenant.id,
      invoiceId: invoice.id,
      quickBooksConnectionId: fixture.connection.id,
      requestedByTenantUserId: reviewer.id,
      status: "SUCCEEDED",
      commandKeyHash: createHash("sha256").update(`${label}-command`).digest("hex"),
      payloadHash: quickBooksInvoiceFingerprint(providerPayload),
      providerRealmId: fixture.connection.realmId,
      providerRequestId: `${label}-request`,
      providerInvoiceId,
      providerDocNumber: providerPayload.DocNumber,
      processingStartedAtUtc: new Date(),
      lastAttemptAtUtc: new Date(),
      succeededAtUtc: new Date(),
    },
  });
  return { ...fixture, invoice, operation, providerInvoiceId, providerPayload };
}

describe("invoice ledger API", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    quickBooksProviderMocks.createInvoice.mockReset();
    quickBooksProviderMocks.fetchInvoice.mockReset().mockImplementation(async (
      _runtimeEnv: unknown,
      _realmId: unknown,
      _accessToken: unknown,
      invoiceId: string,
    ) => {
      const latestCall = quickBooksProviderMocks.createInvoice.mock.calls.at(-1);
      const latestResult = quickBooksProviderMocks.createInvoice.mock.results.at(-1)?.value;
      const providerPayload = (latestCall?.[3] ?? {}) as Record<string, unknown>;
      const createdInvoice = await latestResult as Record<string, unknown> | undefined;
      if (!createdInvoice) throw new Error("No mocked QuickBooks invoice exists.");
      const createdCurrencyRef = (createdInvoice.CurrencyRef ?? {}) as Record<string, unknown>;
      const payloadCurrencyRef = (providerPayload.CurrencyRef ?? {}) as Record<string, unknown>;
      return {
        ...createdInvoice,
        ...providerPayload,
        Id: invoiceId,
        CurrencyRef: {
          value: createdCurrencyRef.value
            ?? createdCurrencyRef.name
            ?? payloadCurrencyRef.value
            ?? payloadCurrencyRef.name
            ?? "USD",
        },
        TotalAmt: createdInvoice.TotalAmt ?? providerPayload.TotalAmt,
        Balance: createdInvoice.Balance ?? createdInvoice.TotalAmt ?? providerPayload.TotalAmt,
        SyncToken: createdInvoice.SyncToken ?? "1",
        MetaData: createdInvoice.MetaData ?? { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
        LinkedTxn: createdInvoice.LinkedTxn ?? [],
        ...(providerPayload.AllowOnlinePayment
          ? { InvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=mock-hosted-payment" }
          : {}),
      };
    });
    quickBooksProviderMocks.findInvoiceByDocNumber.mockReset();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockReset();
    quickBooksProviderMocks.fetchCompanyInfo.mockReset();
    quickBooksProviderMocks.fetchPayment.mockReset();
    quickBooksProviderMocks.fetchRefundReceipt.mockReset();
    quickBooksProviderMocks.fetchCustomer.mockReset();
    quickBooksProviderMocks.fetchItem.mockReset();
    quickBooksProviderMocks.refreshToken.mockReset();
    quickBooksProviderMocks.revokeToken.mockReset().mockResolvedValue(undefined);
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
    const heartbeatAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "a".repeat(64),
      status: "RUNNING",
      startedAtUtc: heartbeatAtUtc,
      cycleStartedAtUtc: heartbeatAtUtc,
      heartbeatAtUtc,
      metrics: { fixture: true },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("creates an invoice from an accepted quote with tenant numbering, immutable event, and idempotent replay", async () => {
    const owner = await signUp("invoice-accepted");
    const customer = await createCustomer(owner, "Invoice Accepted Customer");
    const quote = await createQuote(owner, customer.id, "Accepted invoice work");
    const sourceLines = await Promise.all([
      prisma.quoteLineItem.create({
        data: {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Reviewed labor",
          sectionType: "INCLUDED",
          position: 0,
          quantity: 2,
          unitCost: 10,
          unitPrice: 50,
        },
      }),
      prisma.quoteLineItem.create({
        data: {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Reviewed materials",
          sectionType: "INCLUDED",
          position: 1,
          quantity: 1,
          unitCost: 20,
          unitPrice: 50,
        },
      }),
      prisma.quoteLineItem.create({
        data: {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Optional upgrade",
          sectionType: "ALTERNATE",
          position: 2,
          quantity: 1,
          unitCost: 40,
          unitPrice: 100,
        },
      }),
    ]);
    await acceptQuote(owner, quote.id);

    const idempotencyKey = `invoice-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dueAtUtc = "2026-09-01T17:00:00.000Z";
    const created = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": idempotencyKey },
      payload: { sourceQuoteId: quote.id, dueAtUtc },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      duplicate: boolean;
      invoice: {
        id: string;
        invoiceNumber: number;
        status: string;
        paymentStatus: string;
        documentLocale: string;
        subtotalAmount: number;
        taxAmount: number;
        totalAmount: number;
        amountPaid: number;
        balanceDue: number;
        dueAtUtc: string;
        customer: { id: string; fullName: string };
        sourceQuote: { id: string; totalAmount: number };
        lineItems: Array<{
          sourceQuoteLineItemIdSnapshot: string | null;
          description: string;
          quantity: number;
          unitPrice: number;
          lineTotal: number;
        }>;
      };
    };
    expect(body.duplicate).toBe(false);
    expect(body.invoice).toMatchObject({
      invoiceNumber: 1,
      status: "DRAFT",
      paymentStatus: "PENDING",
      documentLocale: "es-US",
      subtotalAmount: 150,
      taxAmount: 12,
      totalAmount: 162,
      amountPaid: 0,
      balanceDue: 162,
      dueAtUtc,
      customer: { id: customer.id, fullName: customer.fullName },
      sourceQuote: { id: quote.id, totalAmount: 162 },
      lineItems: [
        {
          sourceQuoteLineItemIdSnapshot: sourceLines[0]!.id,
          description: "Reviewed labor",
          quantity: 2,
          unitPrice: 50,
          lineTotal: 100,
        },
        {
          sourceQuoteLineItemIdSnapshot: sourceLines[1]!.id,
          description: "Reviewed materials",
          quantity: 1,
          unitPrice: 50,
          lineTotal: 50,
        },
      ],
    });
    expect(body.invoice.lineItems).toHaveLength(2);
    expect(body.invoice.lineItems.map((line) => line.description)).not.toContain("Optional upgrade");
    expect(created.body).not.toContain(owner.tenant.id);
    expect(created.body).not.toContain("scopeSnapshot");
    expect(created.body).not.toContain("providerPaymentId");

    const events = await prisma.invoiceEvent.findMany({
      where: { tenantId: owner.tenant.id, invoiceId: body.invoice.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CREATED",
      actorTenantUserId: expect.any(String),
      toStatus: "DRAFT",
      toPaymentStatus: "PENDING",
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": idempotencyKey },
      payload: { sourceQuoteId: quote.id, dueAtUtc },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      duplicate: true,
      invoice: { id: body.invoice.id, invoiceNumber: 1 },
    });
    expect(await prisma.invoice.count({ where: { tenantId: owner.tenant.id } })).toBe(1);
    const sequence = await prisma.tenantSequence.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: owner.tenant.id, key: "invoice_number" } },
      select: { nextValue: true },
    });
    expect(sequence.nextValue).toBe(2);

    await prisma.quoteLineItem.update({
      where: { id: sourceLines[0]!.id },
      data: { description: "Changed after invoice", unitPrice: 999 },
    });
    const immutableInvoice = await app.inject({
      method: "GET",
      url: `/v1/invoices/${body.invoice.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(immutableInvoice.statusCode).toBe(200);
    expect(immutableInvoice.json()).toMatchObject({
      invoice: {
        lineItems: [
          { description: "Reviewed labor", unitPrice: 50, lineTotal: 100 },
          { description: "Reviewed materials", unitPrice: 50, lineTotal: 50 },
        ],
      },
    });
  });

  test("creates from completed jobs only and returns the existing invoice for the same source", async () => {
    const owner = await signUp("invoice-job");
    const customer = await createCustomer(owner, "Invoice Job Customer");
    const quote = await createQuote(owner, customer.id, "Completed job invoice work");
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const uncompleted = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-job-open-${Date.now()}` },
      payload: { jobId: job.id },
    });
    expect(uncompleted.statusCode).toBe(409);
    expect(uncompleted.json()).toMatchObject({ code: "INVOICE_JOB_NOT_COMPLETED" });

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAtUtc: new Date("2026-08-22T18:00:00.000Z") },
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-job-done-${Date.now()}` },
      payload: { jobId: job.id },
    });
    expect(created.statusCode).toBe(201);
    const invoiceId = (created.json() as { invoice: { id: string } }).invoice.id;

    const sameSourceKey = `invoice-job-same-source-${Date.now()}`;
    const sameSource = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": sameSourceKey },
      payload: { sourceQuoteId: quote.id },
    });
    expect(sameSource.statusCode).toBe(200);
    expect(sameSource.json()).toMatchObject({
      duplicate: true,
      invoice: { id: invoiceId },
    });
    expect(await prisma.invoice.count({ where: { tenantId: owner.tenant.id } })).toBe(1);

    const otherCustomer = await createCustomer(owner, "Other idempotency customer");
    const otherQuote = await createQuote(owner, otherCustomer.id, "Other idempotency work");
    await acceptQuote(owner, otherQuote.id);
    const reusedKey = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": sameSourceKey },
      payload: { sourceQuoteId: otherQuote.id },
    });
    expect(reusedKey.statusCode).toBe(409);
    expect(reusedKey.json()).toMatchObject({ code: "INVOICE_IDEMPOTENCY_KEY_REUSED" });
    expect(await prisma.invoice.count({ where: { tenantId: owner.tenant.id } })).toBe(1);
    expect(await prisma.invoiceEvent.findFirst({
      where: { tenantId: owner.tenant.id, commandKeyHash: { not: null }, type: "CREATE_REPLAYED" },
    })).not.toBeNull();
  });

  test("serializes concurrent distinct commands for the same accepted quote", async () => {
    const owner = await signUp("invoice-concurrent-source");
    const customer = await createCustomer(owner, "Concurrent Invoice Customer");
    const quote = await createQuote(owner, customer.id, "Concurrent invoice work");
    await acceptQuote(owner, quote.id);

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `invoice-concurrent-a-${Date.now()}`,
        },
        payload: { sourceQuoteId: quote.id },
      }),
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `invoice-concurrent-b-${Date.now()}`,
        },
        payload: { sourceQuoteId: quote.id },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const invoiceIds = responses.map((response) =>
      (response.json() as { invoice: { id: string } }).invoice.id,
    );
    expect(new Set(invoiceIds).size).toBe(1);
    expect(await prisma.invoice.count({ where: { tenantId: owner.tenant.id } })).toBe(1);
    expect(await prisma.invoiceEvent.count({
      where: {
        tenantId: owner.tenant.id,
        invoiceId: invoiceIds[0],
        type: { in: ["CREATED", "CREATE_REPLAYED"] },
      },
    })).toBe(2);
    const sequence = await prisma.tenantSequence.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: owner.tenant.id, key: "invoice_number" } },
      select: { nextValue: true },
    });
    expect(sequence.nextValue).toBe(2);
  });

  test("rejects non-accepted and cross-tenant quote sources without creating an invoice", async () => {
    const owner = await signUp("invoice-reject");
    const customer = await createCustomer(owner, "Invoice Reject Customer");
    const draftQuote = await createQuote(owner, customer.id, "Draft invoice work");

    const draft = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-draft-${Date.now()}` },
      payload: { sourceQuoteId: draftQuote.id },
    });
    expect(draft.statusCode).toBe(409);
    expect(draft.json()).toMatchObject({ code: "INVOICE_QUOTE_NOT_ACCEPTED" });

    const otherOwner = await signUp("invoice-other");
    const otherCustomer = await createCustomer(otherOwner, "Other Tenant Invoice Customer");
    const otherQuote = await createQuote(otherOwner, otherCustomer.id, "Other tenant accepted work");
    await acceptQuote(otherOwner, otherQuote.id);

    const crossTenant = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-cross-${Date.now()}` },
      payload: { sourceQuoteId: otherQuote.id },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: "QUOTE_NOT_FOUND" });
    expect(await prisma.invoice.count({ where: { tenantId: owner.tenant.id } })).toBe(0);
  });

  test("scopes member invoice reads to self-assigned jobs and linked assigned records", async () => {
    const owner = await signUp("invoice-member-scope");
    const alpha = await addMember(owner, "Invoice Alpha Member");
    const beta = await addMember(owner, "Invoice Beta Member");

    const alphaCustomer = await createCustomer(owner, "Alpha Invoice Customer", alpha.membershipId);
    const alphaQuote = await createQuote(owner, alphaCustomer.id, "Alpha invoice work", alpha.membershipId);
    const betaCustomer = await createCustomer(owner, "Beta Invoice Customer", beta.membershipId);
    const betaQuote = await createQuote(owner, betaCustomer.id, "Beta invoice work", beta.membershipId);

    await acceptQuote(owner, alphaQuote.id);
    await acceptQuote(owner, betaQuote.id);
    const alphaCreated = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-alpha-${Date.now()}` },
      payload: { sourceQuoteId: alphaQuote.id },
    });
    expect(alphaCreated.statusCode).toBe(201);
    const alphaInvoiceId = (alphaCreated.json() as { invoice: { id: string } }).invoice.id;
    const betaCreated = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-beta-${Date.now()}` },
      payload: { sourceQuoteId: betaQuote.id },
    });
    expect(betaCreated.statusCode).toBe(201);
    const betaInvoiceId = (betaCreated.json() as { invoice: { id: string } }).invoice.id;

    const alphaList = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { cookie: alpha.cookie },
    });
    expect(alphaList.statusCode).toBe(200);
    expect(alphaList.body).toContain(alphaInvoiceId);
    expect(alphaList.body).not.toContain(betaInvoiceId);
    expect(alphaList.body).not.toContain("Beta Invoice Customer");

    const alphaDetail = await app.inject({
      method: "GET",
      url: `/v1/invoices/${alphaInvoiceId}`,
      headers: { cookie: alpha.cookie },
    });
    expect(alphaDetail.statusCode).toBe(200);
    expect(alphaDetail.json()).toMatchObject({ invoice: { id: alphaInvoiceId } });

    const betaDetailFromAlpha = await app.inject({
      method: "GET",
      url: `/v1/invoices/${betaInvoiceId}`,
      headers: { cookie: alpha.cookie },
    });
    expect(betaDetailFromAlpha.statusCode).toBe(404);
    expect(betaDetailFromAlpha.json()).toMatchObject({ code: "INVOICE_NOT_FOUND" });

    const memberCreate = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: alpha.cookie, "idempotency-key": `invoice-member-create-${Date.now()}` },
      payload: { sourceQuoteId: alphaQuote.id },
    });
    expect(memberCreate.statusCode).toBe(403);
    expect(memberCreate.json()).toMatchObject({ code: "INVOICE_FORBIDDEN" });
  });

  test("runtime role enforces invoice tenant RLS and immutable ledger privileges", async () => {
    const owner = await signUp("invoice-runtime");
    const otherOwner = await signUp("invoice-runtime-other");
    const customer = await createCustomer(owner, "Runtime Invoice Customer");
    const otherCustomer = await createCustomer(otherOwner, "Other Runtime Invoice Customer");
    const quote = await createQuote(owner, customer.id, "Runtime invoice work");
    const otherQuote = await createQuote(otherOwner, otherCustomer.id, "Other runtime invoice work");
    await acceptQuote(owner, quote.id);
    await acceptQuote(otherOwner, otherQuote.id);

    const created = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: owner.cookie, "idempotency-key": `invoice-runtime-${Date.now()}` },
      payload: { sourceQuoteId: quote.id },
    });
    const otherCreated = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie: otherOwner.cookie, "idempotency-key": `invoice-runtime-other-${Date.now()}` },
      payload: { sourceQuoteId: otherQuote.id },
    });
    expect(created.statusCode).toBe(201);
    expect(otherCreated.statusCode).toBe(201);
    const invoiceId = (created.json() as { invoice: { id: string } }).invoice.id;
    const otherInvoiceId = (otherCreated.json() as { invoice: { id: string } }).invoice.id;

    const payment = await prisma.invoicePayment.create({
      data: {
        tenantId: owner.tenant.id,
        invoiceId,
        provider: "MANUAL",
        status: "PENDING",
        amount: 162,
      },
    });
    const otherPayment = await prisma.invoicePayment.create({
      data: {
        tenantId: otherOwner.tenant.id,
        invoiceId: otherInvoiceId,
        provider: "MANUAL",
        status: "PENDING",
        amount: 162,
      },
    });
    const event = await prisma.invoiceEvent.findFirstOrThrow({ where: { invoiceId } });
    const invoiceLine = await prisma.invoiceLineItem.findFirstOrThrow({ where: { invoiceId } });
    const otherInvoiceLine = await prisma.invoiceLineItem.findFirstOrThrow({ where: { invoiceId: otherInvoiceId } });

    const noContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      const invoices = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Invoice"`);
      const lines = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoiceLineItem"`);
      const payments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoicePayment"`);
      const events = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoiceEvent"`);
      return { invoices, lines, payments, events };
    });
    expect(noContext).toEqual({ invoices: [], lines: [], payments: [], events: [] });

    const tenantA = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      const invoices = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Invoice" ORDER BY "id"`);
      const lines = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoiceLineItem" ORDER BY "id"`);
      const payments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoicePayment" ORDER BY "id"`);
      const events = await tx.$queryRaw<Array<{ invoiceId: string }>>(Prisma.sql`SELECT "invoiceId" FROM "InvoiceEvent" ORDER BY "invoiceId"`);
      const crossTenantInvoiceUpdate = await tx.$executeRaw(Prisma.sql`
        UPDATE "Invoice" SET "status" = 'OPEN'::"InvoiceStatus" WHERE "id" = ${otherInvoiceId}
      `);
      const crossTenantPaymentUpdate = await tx.$executeRaw(Prisma.sql`
        UPDATE "InvoicePayment" SET "status" = 'SUCCEEDED'::"InvoicePaymentStatus" WHERE "id" = ${otherPayment.id}
      `);
      return { invoices, lines, payments, events, crossTenantInvoiceUpdate, crossTenantPaymentUpdate };
    });
    expect(tenantA.invoices.map((row) => row.id)).toEqual([invoiceId]);
    expect(tenantA.lines.map((row) => row.id)).toEqual([invoiceLine.id]);
    expect(tenantA.payments.map((row) => row.id)).toEqual([payment.id]);
    expect(tenantA.events.every((row) => row.invoiceId === invoiceId)).toBe(true);
    expect(tenantA.crossTenantInvoiceUpdate).toBe(0);
    expect(tenantA.crossTenantPaymentUpdate).toBe(0);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InvoiceLineItem" SET "description" = 'cross-tenant tamper' WHERE "id" = ${otherInvoiceLine.id}
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InvoiceLineItem" SET "description" = 'same-tenant tamper' WHERE "id" = ${invoiceLine.id}
      `);
    })).rejects.toThrow();

    const guessed = await app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(guessed.statusCode).toBe(404);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "InvoicePayment" (
          "id", "tenantId", "invoiceId", "provider", "status", "amount", "currency", "createdAt", "updatedAt"
        ) VALUES (
          ${`wrong-tenant-${Date.now()}`}, ${otherOwner.tenant.id}, ${otherInvoiceId},
          'MANUAL'::"InvoicePaymentProvider", 'PENDING'::"InvoicePaymentStatus", 1, 'USD', NOW(), NOW()
        )
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`UPDATE "InvoiceEvent" SET "requestId" = 'tampered' WHERE "id" = ${event.id}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "Invoice" WHERE "id" = ${invoiceId}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "InvoiceLineItem" WHERE "id" = ${invoiceLine.id}`);
    })).rejects.toThrow();
  });

  test("previews reviewed mapping identities without exposing the realm or calling Intuit", async () => {
    const owner = await signUp("invoice-qb-preview");
    const { invoice, title } = await createQuickBooksReadyInvoice(owner, "preview");

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerWorkflowsEnabled: true,
      preview: {
        ready: true,
        blockers: [],
        providerDocNumber: "QF-000001",
        quickBooksCustomerName: "preview QuickBooks Customer",
        invoice: { id: invoice.id, version: invoice.version, totalAmount: 150 },
        lineItems: [{
          description: title,
          quantity: 1,
          unitPrice: 150,
          amount: 150,
          mapped: true,
          quickBooksItemName: "preview QuickBooks Service Item",
          quickBooksItemId: "qb-item-preview",
        }],
        customerMapping: { quickBooksCustomerId: "qb-customer-preview" },
        operation: null,
      },
    });
    expect(response.body).not.toContain("realm-preview");
    expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
  });

  test("refreshes customer and item reviews without billing email and keeps offline publish available", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-no-email-mapping-refresh");
      const { customer, invoice, connection, title } = await createQuickBooksReadyInvoice(
        owner,
        "no-email-mapping-refresh",
      );
      expect(customer.email).toBeNull();
      await prisma.quickBooksCustomerMap.deleteMany({
        where: { tenantId: owner.tenant.id, quickBooksConnectionId: connection.id, customerId: customer.id },
      });
      await prisma.quickBooksItemMap.deleteMany({
        where: { tenantId: owner.tenant.id, quickBooksConnectionId: connection.id, itemKey: title.toLowerCase() },
      });
      quickBooksProviderMocks.fetchCustomer.mockResolvedValue({
        Id: "qb-customer-no-email-reviewed",
        DisplayName: "Reviewed no-email customer",
        Active: true,
      });
      quickBooksProviderMocks.fetchItem.mockResolvedValue({
        Id: "qb-item-no-email-reviewed",
        Name: "Reviewed no-email service",
        Type: "Service",
        Active: true,
      });

      const customerReview = await app.inject({
        method: "POST",
        url: "/v1/integrations/quickbooks/mappings/customer/review",
        headers: { cookie: owner.cookie },
        payload: { customerId: customer.id, quickBooksCustomerId: "qb-customer-no-email-reviewed" },
      });
      expect(customerReview.statusCode).toBe(200);
      const afterCustomerReview = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        headers: { cookie: owner.cookie },
        payload: {
          billingEmail: null,
          allowOnlineAchPayment: false,
          allowOnlineCardPayment: false,
        },
      });
      expect(afterCustomerReview.statusCode).toBe(200);
      expect(afterCustomerReview.json()).toMatchObject({
        preview: {
          billingEmail: null,
          paymentMethods: { ach: false, card: false },
          customerMapping: { quickBooksCustomerId: "qb-customer-no-email-reviewed" },
          blockers: ["QUICKBOOKS_ITEM_MAPPING_REQUIRED"],
          ready: false,
        },
      });

      const itemReview = await app.inject({
        method: "POST",
        url: "/v1/integrations/quickbooks/mappings/item/review",
        headers: { cookie: owner.cookie },
        payload: { itemKey: title.toLowerCase(), quickBooksItemId: "qb-item-no-email-reviewed" },
      });
      expect(itemReview.statusCode).toBe(200);

      const onlineWithoutEmail = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        headers: { cookie: owner.cookie },
        payload: {
          billingEmail: "   ",
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: false,
        },
      });
      expect(onlineWithoutEmail.statusCode).toBe(200);
      expect(onlineWithoutEmail.json()).toMatchObject({
        preview: {
          billingEmail: null,
          paymentMethods: { ach: true, card: false },
          blockers: ["QUICKBOOKS_BILLING_EMAIL_REQUIRED"],
          ready: false,
          reviewBinding: null,
        },
      });

      const offlinePreview = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        headers: { cookie: owner.cookie },
        payload: {
          billingEmail: "",
          allowOnlineAchPayment: false,
          allowOnlineCardPayment: false,
        },
      });
      expect(offlinePreview.statusCode).toBe(200);
      const offlineReview = (offlinePreview.json() as {
        preview: {
          billingEmail: string | null;
          paymentMethods: { ach: boolean; card: boolean };
          blockers: string[];
          ready: boolean;
          reviewBinding: string;
        };
      }).preview;
      expect(offlineReview).toMatchObject({
        billingEmail: null,
        paymentMethods: { ach: false, card: false },
        blockers: [],
        ready: true,
      });
      expect(offlineReview.reviewBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);

      quickBooksProviderMocks.createInvoice.mockResolvedValue({
        Id: "qb-invoice-no-email-offline",
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
        CurrencyRef: { value: "USD" },
        LinkedTxn: [],
      });
      const publish = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `qb-no-email-offline-${Date.now()}`,
        },
        payload: {
          invoiceVersion: invoice.version,
          reviewBinding: offlineReview.reviewBinding,
          billingEmail: " ",
          allowOnlineAchPayment: false,
          allowOnlineCardPayment: false,
        },
      });
      expect(publish.statusCode).toBe(201);
      expect(publish.json()).toMatchObject({
        operation: { status: "SUCCEEDED", paymentMethods: { ach: false, card: false } },
      });
      const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls.at(-1)?.[3] as Record<string, unknown>;
      expect(providerPayload).not.toHaveProperty("BillEmail");
      expect(providerPayload).toMatchObject({
        AllowOnlinePayment: false,
        AllowOnlineACHPayment: false,
        AllowOnlineCreditCardPayment: false,
      });
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("QuickBooks preview and publish use immutable invoice lines after source quote changes", async () => {
    const owner = await signUp("invoice-qb-snapshot-lines");
    const customer = await createCustomer(owner, "Snapshot Line Customer");
    const quote = await createQuote(owner, customer.id, "Snapshot line service", null, {
      taxAmount: 0,
      customerPriceSubtotal: 300,
      totalAmount: 300,
    });
    await prisma.quoteLineItem.createMany({
      data: [
        {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Snapshot labor",
          sectionType: "INCLUDED",
          position: 0,
          quantity: 2,
          unitCost: 40,
          unitPrice: 100,
        },
        {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Snapshot materials",
          sectionType: "INCLUDED",
          position: 1,
          quantity: 1,
          unitCost: 50,
          unitPrice: 100,
        },
        {
          tenantId: owner.tenant.id,
          quoteId: quote.id,
          description: "Optional alternate excluded",
          sectionType: "ALTERNATE",
          position: 2,
          quantity: 1,
          unitCost: 25,
          unitPrice: 999,
        },
      ],
    });
    await acceptQuote(owner, quote.id);
    const created = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `invoice-qb-snapshot-${Date.now()}`,
      },
      payload: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
    });
    expect(created.statusCode).toBe(201);
    const invoice = (created.json() as { invoice: { id: string; version: number; invoiceNumber: number } }).invoice;
    const reviewer = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id, deletedAtUtc: null },
      select: { id: true },
    });
    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: owner.tenant.id,
        realmId: `realm-snapshot-${Date.now()}`,
        environment: "sandbox",
        companyName: "Snapshot QuickBooks Company",
        status: "CONNECTED",
        accessTokenEncrypted: encryptQuickBooksSecret(env, "test-access-token"),
        refreshTokenEncrypted: encryptQuickBooksSecret(env, "test-refresh-token"),
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
        setupConfirmedAtUtc: new Date(),
        setupConfirmedByTenantUserId: reviewer.id,
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
    });
    await prisma.quickBooksCustomerMap.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        customerId: customer.id,
        quickBooksCustomerId: "qb-customer-snapshot",
        quickBooksDisplayName: "Snapshot QuickBooks Customer",
        reviewedByTenantUserId: reviewer.id,
        reviewedAtUtc: new Date(),
        reviewVersion: 1,
      },
    });
    await prisma.quickBooksItemMap.createMany({
      data: ["Snapshot labor", "Snapshot materials"].map((description, index) => ({
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        itemKey: description.toLowerCase(),
        quickBooksItemId: `qb-item-snapshot-${index + 1}`,
        quickBooksItemName: description,
        reviewedByTenantUserId: reviewer.id,
        reviewedAtUtc: new Date(),
        reviewVersion: 1,
      })),
    });

    const firstPreviewResponse = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(firstPreviewResponse.statusCode).toBe(200);
    const firstPreview = (firstPreviewResponse.json() as {
      preview: { reviewBinding: string; lineItems: Array<Record<string, unknown>> };
    }).preview;
    expect(firstPreview.lineItems).toEqual([
      expect.objectContaining({ description: "Snapshot labor", quantity: 2, unitPrice: 100, amount: 200 }),
      expect.objectContaining({ description: "Snapshot materials", quantity: 1, unitPrice: 100, amount: 100 }),
    ]);
    expect(JSON.stringify(firstPreview)).not.toContain("Optional alternate excluded");

    const sourceLines = await prisma.quoteLineItem.findMany({
      where: { tenantId: owner.tenant.id, quoteId: quote.id },
      orderBy: { position: "asc" },
    });
    await prisma.quoteLineItem.update({
      where: { id: sourceLines[0]!.id },
      data: { description: "Mutated live quote labor", unitPrice: 999 },
    });
    await prisma.quoteLineItem.update({
      where: { id: sourceLines[1]!.id },
      data: { deletedAtUtc: new Date() },
    });
    await prisma.quoteLineItem.update({
      where: { id: sourceLines[2]!.id },
      data: { sectionType: "INCLUDED", description: "Late alternate mutation" },
    });

    const secondPreviewResponse = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(secondPreviewResponse.statusCode).toBe(200);
    const secondPreview = (secondPreviewResponse.json() as {
      preview: { reviewBinding: string; lineItems: Array<Record<string, unknown>> };
    }).preview;
    expect(secondPreview.lineItems).toEqual(firstPreview.lineItems);
    expect(secondPreview.reviewBinding).toBe(firstPreview.reviewBinding);
    expect(JSON.stringify(secondPreview)).not.toMatch(/Mutated live quote|Late alternate mutation|Optional alternate excluded/);

    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: "qb-invoice-snapshot",
      DocNumber: `QF-${String(invoice.invoiceNumber).padStart(6, "0")}`,
      TxnDate: "2026-08-25",
      DueDate: "2026-10-01",
      TotalAmt: 300,
      Balance: 300,
      CurrencyRef: { value: "USD", name: "USD" },
      LinkedTxn: [],
    });
    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `qb-snapshot-publish-${Date.now()}`,
      },
      payload: { invoiceVersion: invoice.version, reviewBinding: firstPreview.reviewBinding },
    });
    expect(publish.statusCode).toBe(201);
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as {
      Line: Array<{ Description: string; Amount: number }>;
    };
    expect(providerPayload.Line).toEqual([
      expect.objectContaining({ Description: "Snapshot labor", Amount: 200 }),
      expect.objectContaining({ Description: "Snapshot materials", Amount: 100 }),
    ]);
    expect(JSON.stringify(providerPayload)).not.toMatch(/Mutated live quote|Late alternate mutation|Optional alternate excluded/);
  });

  test("reconciles fractional invoice lines to the accepted subtotal and publishes consistent QuickBooks math", async () => {
    const owner = await signUp("invoice-fractional-lines");
    const customer = await createCustomer(owner, "Fractional Line Customer");
    const quote = await createQuote(owner, customer.id, "Fractional line service", null, {
      internalCostSubtotal: 0,
      customerPriceSubtotal: 0.05,
      taxAmount: 0,
      totalAmount: 0.05,
    });
    const descriptions = ["Fractional labor A", "Fractional labor B", "Fractional labor C"];
    await prisma.quoteLineItem.createMany({
      data: descriptions.map((description, position) => ({
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        description,
        sectionType: "INCLUDED" as const,
        position,
        quantity: 0.33,
        unitCost: 0,
        unitPrice: 0.05,
      })),
    });
    await acceptQuote(owner, quote.id);

    const created = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `invoice-fractional-${Date.now()}`,
      },
      payload: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
    });
    expect(created.statusCode).toBe(201);
    const invoice = (created.json() as {
      invoice: { id: string; version: number; invoiceNumber: number; subtotalAmount: number };
    }).invoice;
    expect(invoice.subtotalAmount).toBe(0.05);

    const storedLines = await prisma.invoiceLineItem.findMany({
      where: { tenantId: owner.tenant.id, invoiceId: invoice.id },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    expect(storedLines.map((line) => Number(line.lineTotal))).toEqual([0.02, 0.02, 0.01]);
    expect(storedLines.reduce((sum, line) => sum + Number(line.lineTotal), 0)).toBeCloseTo(0.05, 8);

    const reviewer = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id, deletedAtUtc: null },
      select: { id: true },
    });
    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: owner.tenant.id,
        realmId: `realm-fractional-${Date.now()}`,
        environment: "sandbox",
        companyName: "Fractional QuickBooks Company",
        status: "CONNECTED",
        accessTokenEncrypted: encryptQuickBooksSecret(env, "test-access-token"),
        refreshTokenEncrypted: encryptQuickBooksSecret(env, "test-refresh-token"),
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
        setupConfirmedAtUtc: new Date(),
        setupConfirmedByTenantUserId: reviewer.id,
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
    });
    await prisma.quickBooksCustomerMap.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        customerId: customer.id,
        quickBooksCustomerId: "qb-customer-fractional",
        quickBooksDisplayName: "Fractional QuickBooks Customer",
        reviewedByTenantUserId: reviewer.id,
        reviewedAtUtc: new Date(),
        reviewVersion: 1,
      },
    });
    await prisma.quickBooksItemMap.createMany({
      data: descriptions.map((description, index) => ({
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        itemKey: description.toLowerCase(),
        quickBooksItemId: `qb-item-fractional-${index + 1}`,
        quickBooksItemName: description,
        reviewedByTenantUserId: reviewer.id,
        reviewedAtUtc: new Date(),
        reviewVersion: 1,
      })),
    });

    const previewResponse = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = (previewResponse.json() as {
      preview: {
        ready: boolean;
        blockers: string[];
        reviewBinding: string;
        lineItems: Array<{ amount: number }>;
      };
    }).preview;
    expect(preview).toMatchObject({ ready: true, blockers: [] });
    expect(preview.lineItems.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(0.05, 8);

    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: "qb-invoice-fractional",
      DocNumber: `QF-${String(invoice.invoiceNumber).padStart(6, "0")}`,
      TxnDate: "2026-08-25",
      DueDate: "2026-10-01",
      TotalAmt: 0.05,
      Balance: 0.05,
      CurrencyRef: { name: "USD" },
      LinkedTxn: [],
    });
    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `qb-fractional-publish-${Date.now()}`,
      },
      payload: { invoiceVersion: invoice.version, reviewBinding: preview.reviewBinding },
    });
    expect(publish.statusCode).toBe(201);
    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as {
      Line: Array<{
        Amount: number;
        SalesItemLineDetail: { Qty: number; UnitPrice: number };
      }>;
    };
    expect(providerPayload.Line.reduce((sum, line) => sum + line.Amount, 0)).toBeCloseTo(0.05, 8);
    for (const line of providerPayload.Line) {
      expect(Number((line.SalesItemLineDetail.Qty * line.SalesItemLineDetail.UnitPrice).toFixed(2))).toBe(line.Amount);
    }
  });

  test("rejects stale customer, item, and realm reviews before any provider access", async () => {
    const owner = await signUp("invoice-qb-stale-review");
    const fixture = await createQuickBooksReadyInvoice(owner, "stale-review");
    const publish = (reviewBinding: string, suffix: string) => app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/publish`,
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `qb-stale-review-${suffix}-${Date.now()}`,
      },
      payload: { invoiceVersion: fixture.invoice.version, reviewBinding },
    });

    await prisma.quickBooksCustomerMap.updateMany({
      where: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: fixture.connection.id,
        customerId: fixture.customer.id,
      },
      data: {
        quickBooksCustomerId: "qb-customer-stale-review-updated",
        quickBooksDisplayName: "Updated QuickBooks Customer Target",
      },
    });
    const staleCustomer = await publish(fixture.reviewBinding, "customer");
    expect(staleCustomer.statusCode).toBe(409);
    expect(staleCustomer.json()).toMatchObject({ code: "QUICKBOOKS_REVIEW_STALE" });

    const itemReviewBinding = await getQuickBooksReviewBinding(owner, fixture.invoice.id);
    await prisma.quickBooksItemMap.updateMany({
      where: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: fixture.connection.id,
        itemKey: fixture.title.toLowerCase(),
      },
      data: {
        quickBooksItemId: "qb-item-stale-review-updated",
        quickBooksItemName: "Updated QuickBooks Item Target",
      },
    });
    const staleItem = await publish(itemReviewBinding, "item");
    expect(staleItem.statusCode).toBe(409);
    expect(staleItem.json()).toMatchObject({ code: "QUICKBOOKS_REVIEW_STALE" });

    const realmReviewBinding = await getQuickBooksReviewBinding(owner, fixture.invoice.id);
    const changedRealm = `realm-stale-review-updated-${Date.now()}`;
    await prisma.quickBooksConnection.update({
      where: { id: fixture.connection.id },
      data: { realmId: changedRealm },
    });
    const staleRealm = await publish(realmReviewBinding, "realm");
    expect(staleRealm.statusCode).toBe(409);
    expect(staleRealm.json()).toMatchObject({ code: "QUICKBOOKS_REVIEW_STALE" });
    expect(staleRealm.body).not.toContain(changedRealm);
    expect(staleRealm.body).not.toContain("qb-customer-stale-review-updated");
    expect(staleRealm.body).not.toContain("qb-item-stale-review-updated");
    expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
    expect(await prisma.quickBooksInvoiceOperation.count({
      where: { tenantId: owner.tenant.id, invoiceId: fixture.invoice.id },
    })).toBe(0);
  });

  test("publishes once from a durable claim and replays success without a second provider write", async () => {
    const owner = await signUp("invoice-qb-publish");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(owner, "publish");
    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: "qb-invoice-publish",
      DocNumber: "QF-000001",
      TxnDate: "2026-08-24",
      DueDate: "2026-10-01",
      TotalAmt: 150,
      Balance: 150,
      CurrencyRef: { value: "USD", name: "USD" },
      LinkedTxn: [],
    });

    const publish = (key: string) => app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    const first = await publish(`qb-publish-first-${Date.now()}`);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      duplicate: false,
      reconciliationRequired: false,
      operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001" },
    });
    expect(first.body).not.toContain("qb-invoice-publish");
    expect(first.body).not.toContain("invoiceId");
    expect(first.body).not.toContain("lastFailureCode");
    expect(first.body).not.toContain("claimExpiresAtUtc");

    const replay = await publish(`qb-publish-replay-${Date.now()}`);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      duplicate: true,
      reconciliationRequired: false,
      operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001" },
    });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledWith(
      expect.anything(),
      connection.realmId,
      "test-access-token",
      expect.objectContaining({
        DocNumber: "QF-000001",
        CustomerRef: expect.any(Object),
        PrivateNote: expect.stringMatching(/^QuoteFly:[0-9a-f]{24}$/),
      }),
      expect.any(String),
    );
    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(providerPayload).not.toHaveProperty("CustomerMemo");
    expect(JSON.stringify(providerPayload)).not.toContain("accepted scope snapshot");

    const operation = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    });
    expect(operation).toMatchObject({
      status: "SUCCEEDED",
      attemptCount: 1,
      providerInvoiceId: "qb-invoice-publish",
      quickBooksConnectionId: connection.id,
      providerRealmId: connection.realmId,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
    });
    expect(operation.commandKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(prisma.invoiceEvent.count({
      where: {
        tenantId: owner.tenant.id,
        invoiceId: invoice.id,
        type: { in: ["PROVIDER_SYNC_STARTED", "PROVIDER_SYNC_SUCCEEDED"] },
      },
    })).resolves.toBe(2);
  });

  test("refuses invoice publishing when the authoritative reconciliation worker is unavailable", async () => {
    const owner = await signUp("invoice-qb-reconciliation-dependency");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(
      owner,
      "reconciliation-dependency",
    );
    const reconciliationWorkerFlag = app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED;
    app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED = false;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `qb-reconciliation-dependency-${Date.now()}`,
        },
        payload: { invoiceVersion: invoice.version, reviewBinding },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE" });
      expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
      await expect(prisma.quickBooksInvoiceOperation.count({
        where: { tenantId: owner.tenant.id, invoiceId: invoice.id },
      })).resolves.toBe(0);
    } finally {
      app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED = reconciliationWorkerFlag;
    }
  });

  test("binds reviewed hosted-payment choices, snapshots edited billing email, and exposes the validated link", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    const providerWorkflowsFlag = app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
    const owner = await signUp("invoice-qb-hosted-payment-review");
    const { invoice, connection } = await createQuickBooksReadyInvoice(owner, "hosted-payment-review");
    const reviewedBillingEmail = "reviewed.billing@example.com";
    const previewResponse = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {
        billingEmail: reviewedBillingEmail,
        allowOnlineAchPayment: true,
        allowOnlineCardPayment: true,
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = (previewResponse.json() as {
      preview: { reviewBinding: string; billingEmail: string; paymentMethods: { ach: boolean; card: boolean } };
    }).preview;
    expect(preview).toMatchObject({
      billingEmail: reviewedBillingEmail,
      paymentMethods: { ach: true, card: true },
    });
    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: "qb-invoice-hosted-payment-review",
      DocNumber: "QF-000001",
      TotalAmt: 150,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: new Date().toISOString() },
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    });

    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-hosted-payment-${Date.now()}` },
      payload: {
        invoiceVersion: invoice.version,
        reviewBinding: preview.reviewBinding,
        billingEmail: reviewedBillingEmail,
        allowOnlineAchPayment: true,
        allowOnlineCardPayment: true,
      },
    });
    expect(publish.statusCode).toBe(201);
    expect(publish.json()).toMatchObject({
      operation: {
        status: "SUCCEEDED",
        paymentMethods: { ach: true, card: true },
      },
    });
    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(providerPayload).toMatchObject({
      BillEmail: { Address: reviewedBillingEmail },
      AllowOnlinePayment: true,
      AllowOnlineACHPayment: true,
      AllowOnlineCreditCardPayment: true,
    });
    const persistedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(persistedInvoice).toMatchObject({
      status: "OPEN",
      billingEmailSnapshot: reviewedBillingEmail,
      version: invoice.version + 1,
      sentAtUtc: null,
    });
    expect(persistedInvoice.issuedAtUtc).toBeInstanceOf(Date);

    const paymentLink = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
      headers: { cookie: owner.cookie },
    });
    expect(paymentLink.statusCode).toBe(200);
    expect(paymentLink.headers["cache-control"]).toContain("no-store");
    expect(paymentLink.headers["referrer-policy"]).toBe("no-referrer");
    expect(paymentLink.json()).toMatchObject({
      invoiceId: invoice.id,
      provider: "QUICKBOOKS",
      hostedPaymentUrl: "https://app.qbo.intuit.com/app/invoice?txnId=mock-hosted-payment",
      paymentStatus: "PENDING",
      balanceDue: 150,
    });
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { status: "DISCONNECTED" },
    });
    const disconnectedLink = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
      headers: { cookie: owner.cookie },
    });
    expect(disconnectedLink.statusCode).toBe(404);
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { status: "CONNECTED" },
    });
    await prisma.quickBooksRealmBinding.update({
      where: { quickBooksConnectionId: connection.id },
      data: { active: false },
    });
    const inactiveRealmLink = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
      headers: { cookie: owner.cookie },
    });
    expect(inactiveRealmLink.statusCode).toBe(404);
    app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = false;
    const pausedLink = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
      headers: { cookie: owner.cookie },
    });
    expect(pausedLink.statusCode).toBe(503);
    expect(pausedLink.json()).toMatchObject({ code: "QUICKBOOKS_HOSTED_PAYMENTS_UNAVAILABLE" });
    } finally {
      app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = providerWorkflowsFlag;
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("returns the durable reconciliation-required operation when the hosted InvoiceLink is delayed", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-hosted-payment-delayed-link");
      const { invoice } = await createQuickBooksReadyInvoice(owner, "hosted-payment-delayed-link");
      const reviewedBillingEmail = "delayed.link@example.com";
      const previewResponse = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        payload: {
          billingEmail: reviewedBillingEmail,
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: true,
        },
        headers: { cookie: owner.cookie },
      });
      expect(previewResponse.statusCode).toBe(200);
      const reviewBinding = (previewResponse.json() as { preview: { reviewBinding: string } }).preview.reviewBinding;
      quickBooksProviderMocks.createInvoice.mockResolvedValue({
        Id: "qb-invoice-hosted-payment-delayed-link",
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      });
      quickBooksProviderMocks.fetchInvoice.mockImplementation(async (
        _runtimeEnv: unknown,
        _realmId: unknown,
        _accessToken: unknown,
        providerInvoiceId: string,
      ) => {
        const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls.at(-1)?.[3] as Record<string, unknown>;
        return {
          ...providerPayload,
          Id: providerInvoiceId,
          TotalAmt: 150,
          Balance: 150,
          SyncToken: "1",
          MetaData: { LastUpdatedTime: "2026-08-27T21:15:00.000Z" },
          CurrencyRef: { value: "USD" },
          LinkedTxn: [],
          AllowOnlinePayment: true,
          AllowOnlineACHPayment: true,
          AllowOnlineCreditCardPayment: true,
        };
      });

      const publish = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: { cookie: owner.cookie, "idempotency-key": `qb-hosted-delayed-${Date.now()}` },
        payload: {
          invoiceVersion: invoice.version,
          reviewBinding,
          billingEmail: reviewedBillingEmail,
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: true,
        },
      });
      expect(publish.statusCode).toBe(201);
      expect(publish.headers["cache-control"]).toContain("no-store");
      expect(publish.json()).toMatchObject({
        duplicate: false,
        reconciliationRequired: true,
        operation: {
          status: "RECONCILIATION_REQUIRED",
          paymentMethods: { ach: true, card: true },
          paymentLinkAvailable: false,
          reconciliationAvailable: true,
        },
        reconciliation: {
          invoiceStatus: "OPEN",
          paymentStatus: "PENDING",
          balanceDue: 150,
          hostedPaymentUrlAvailable: false,
        },
      });
      expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
      expect(quickBooksProviderMocks.fetchInvoice).toHaveBeenCalledTimes(2);
      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      })).resolves.toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        providerInvoiceLink: null,
        lastFailureCode: "QUICKBOOKS_INVOICE_LINK_UNAVAILABLE",
      });
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("returns a required browser quarantine status when provider success cannot be committed locally", async () => {
    const owner = await signUp("invoice-qb-local-unknown");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "local-unknown");
    quickBooksProviderMocks.createInvoice.mockImplementation(async () => {
      await prisma.quickBooksInvoiceOperation.update({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
        data: {
          status: "RECONCILIATION_REQUIRED",
          claimTokenHash: null,
          claimExpiresAtUtc: null,
          failedAtUtc: new Date(),
          lastFailureCode: "SYNTHETIC_LOCAL_COMMIT_RACE",
        },
      });
      return {
        Id: "qb-invoice-local-unknown",
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      };
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-local-unknown-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      code: "LOCAL_COMMIT_RESULT_UNKNOWN",
      reconciliationRequired: true,
      operation: { status: "RECONCILIATION_REQUIRED", providerDocNumber: "QF-000001" },
    });
    expect(response.body).not.toContain("qb-invoice-local-unknown");
    expect(response.body).not.toContain("SYNTHETIC_LOCAL_COMMIT_RACE");

    const blockedRetry = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-local-unknown-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_REQUIRED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
  });

  test.each([
    { label: "missing", heartbeat: null },
    { label: "stale", heartbeat: { status: "RUNNING" as const, ageMs: 61_000 } },
    { label: "failed", heartbeat: { status: "FAILED" as const, ageMs: 0 } },
  ])("refuses invoice publishing when the worker heartbeat is $label", async ({ heartbeat }) => {
    const owner = await signUp(`invoice-qb-heartbeat-${heartbeat?.status ?? "missing"}`);
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, `heartbeat-${heartbeat?.status ?? "missing"}`);
    await prisma.workerHeartbeat.deleteMany({ where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY } });
    if (heartbeat) {
      const heartbeatAtUtc = new Date(Date.now() - heartbeat.ageMs);
      await recordWorkerHeartbeat(prisma, {
        workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
        instanceRefHash: "b".repeat(64),
        status: heartbeat.status,
        startedAtUtc: heartbeatAtUtc,
        cycleStartedAtUtc: heartbeatAtUtc,
        heartbeatAtUtc,
        metrics: { fixture: true },
      });
    }

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: {
        cookie: owner.cookie,
        "idempotency-key": `qb-worker-heartbeat-${Date.now()}`,
      },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE" });
    expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
    await expect(prisma.quickBooksInvoiceOperation.count({
      where: { tenantId: owner.tenant.id, invoiceId: invoice.id },
    })).resolves.toBe(0);
  });

  test("refuses publishing when the reconciliation worker runs a different release", async () => {
    const apiReleaseSha = "a".repeat(40);
    const workerReleaseSha = "b".repeat(40);
    const previousReleaseSha = process.env.QUOTEFLY_RELEASE_SHA;
    process.env.QUOTEFLY_RELEASE_SHA = apiReleaseSha;
    const releaseAwareApp = await buildServer();
    await releaseAwareApp.ready();
    if (previousReleaseSha === undefined) delete process.env.QUOTEFLY_RELEASE_SHA;
    else process.env.QUOTEFLY_RELEASE_SHA = previousReleaseSha;

    try {
      const owner = await signUp("invoice-qb-release-mismatch");
      const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "release-mismatch");
      const heartbeatAtUtc = new Date();
      await recordWorkerHeartbeat(prisma, {
        workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
        instanceRefHash: "c".repeat(64),
        status: "RUNNING",
        startedAtUtc: heartbeatAtUtc,
        cycleStartedAtUtc: heartbeatAtUtc,
        heartbeatAtUtc,
        metrics: { releaseSha: workerReleaseSha },
      });

      const status = await releaseAwareApp.inject({
        method: "GET",
        url: "/v1/integrations/quickbooks/status",
        headers: { cookie: owner.cookie },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        reconciliationWorker: { fresh: false },
        releaseIdentity: {
          apiReleaseSha,
          workerReleaseSha,
          matches: false,
        },
      });

      const publish = await releaseAwareApp.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `qb-release-mismatch-${Date.now()}`,
        },
        payload: { invoiceVersion: invoice.version, reviewBinding },
      });
      expect(publish.statusCode).toBe(503);
      expect(publish.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE" });
      expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
    } finally {
      await releaseAwareApp.close();
    }
  });

  test("retains provider identity when create succeeds but the authoritative read fails", async () => {
    const owner = await signUp("invoice-qb-created-read-failed");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "created-read-failed");
    const providerInvoiceId = "qb-invoice-created-read-failed";
    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: providerInvoiceId,
      DocNumber: "QF-000001",
      TotalAmt: 150,
      Balance: 150,
    });
    quickBooksProviderMocks.fetchInvoice.mockRejectedValueOnce(
      new QuickBooksProviderError("QUICKBOOKS_HTTP_503", false, 503),
    );

    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-created-read-failed-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(publish.statusCode).toBe(202);
    expect(publish.json()).toMatchObject({
      code: "QUICKBOOKS_RESULT_UNCERTAIN",
      reconciliationRequired: true,
      operation: { status: "RECONCILIATION_REQUIRED", reconciliationAvailable: true },
    });
    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    })).resolves.toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      providerInvoiceId,
      lastFailureCode: "QUICKBOOKS_HTTP_503",
    });

    const blockedRetry = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-created-read-failed-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_REQUIRED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);

    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...providerPayload,
      Id: providerInvoiceId,
      TotalAmt: 150,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-09-02T20:00:00.000Z" },
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    });
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({ found: true, operation: { status: "SUCCEEDED" } });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
  });

  test("retains provider identity when authorization is revoked after create and never creates twice", async () => {
    const owner = await signUp("invoice-qb-created-read-reauth");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(
      owner,
      "created-read-reauth",
    );
    const providerInvoiceId = "qb-invoice-created-read-reauth";
    quickBooksProviderMocks.createInvoice.mockImplementation(async () => {
      // The CREATE used the current access token successfully. Expiring it here
      // makes the immediately following authoritative GET attempt a refresh.
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: { accessTokenExpiresAtUtc: new Date(0) },
      });
      return {
        Id: providerInvoiceId,
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      };
    });
    quickBooksProviderMocks.refreshToken.mockRejectedValueOnce(
      new QuickBooksProviderError("QUICKBOOKS_REAUTH_REQUIRED", false, 400),
    );

    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-created-read-reauth-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json()).toMatchObject({
      code: "QUICKBOOKS_REAUTH_REQUIRED",
      reconciliationRequired: true,
      operation: { status: "RECONCILIATION_REQUIRED", reconciliationAvailable: true },
    });
    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    })).resolves.toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      providerInvoiceId,
      lastFailureCode: "QUICKBOOKS_REAUTH_REQUIRED",
    });
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: connection.id },
    })).resolves.toMatchObject({ status: "NEEDS_REAUTH", refreshTokenEncrypted: null });

    // Simulate a completed OAuth reconnect. The durable provider identity must
    // still block another CREATE and direct the operator to reconciliation.
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        status: "CONNECTED",
        accessTokenEncrypted: encryptQuickBooksSecret(env, "reconnected-access-token"),
        refreshTokenEncrypted: encryptQuickBooksSecret(env, "reconnected-refresh-token"),
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
        setupConfirmedAtUtc: new Date(),
        setupConfirmedByTenantUserId: connection.setupConfirmedByTenantUserId,
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        lastError: null,
      },
    });
    const blockedRetry = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-created-read-reauth-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_REQUIRED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);

    const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...providerPayload,
      Id: providerInvoiceId,
      TotalAmt: 150,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-09-02T20:00:00.000Z" },
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    });
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({ found: true, operation: { status: "SUCCEEDED" } });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
  });

  test("reuses the provider request ID when an invoice create retries after a resource 401", async () => {
    const owner = await signUp("invoice-qb-create-401-retry");
    const { invoice, reviewBinding, connection } = await createQuickBooksReadyInvoice(owner, "create-401-retry");
    quickBooksProviderMocks.refreshToken.mockResolvedValue({
      access_token: "invoice-create-rotated-access",
      refresh_token: "invoice-create-rotated-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    quickBooksProviderMocks.createInvoice
      .mockRejectedValueOnce(new QuickBooksProviderError("QUICKBOOKS_HTTP_401", false, 401))
      .mockResolvedValueOnce({
        Id: "qb-invoice-create-401-retry",
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      });

    const publish = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-create-401-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(publish.statusCode).toBe(201);
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(2);
    expect(quickBooksProviderMocks.createInvoice.mock.calls[0]?.[4]).toBeTruthy();
    expect(quickBooksProviderMocks.createInvoice.mock.calls[1]?.[4])
      .toBe(quickBooksProviderMocks.createInvoice.mock.calls[0]?.[4]);
    expect(quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3])
      .toEqual(quickBooksProviderMocks.createInvoice.mock.calls[1]?.[3]);
    expect(quickBooksProviderMocks.refreshToken).toHaveBeenCalledTimes(1);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({ status: "CONNECTED" });
  });

  test("quarantines an ambiguous provider result and reconciles it without another write", async () => {
    const owner = await signUp("invoice-qb-uncertain");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "uncertain");
    quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic network disconnect"));

    const first = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-uncertain-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      code: "QUICKBOOKS_RESULT_UNCERTAIN",
      reconciliationRequired: true,
      operation: { status: "RECONCILIATION_REQUIRED", providerDocNumber: "QF-000001" },
    });
    expect(first.body).not.toContain("QUICKBOOKS_PROVIDER_RESULT_UNKNOWN");
    expect(first.body).not.toContain("lastFailureCode");

    const blockedRetry = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-uncertain-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json()).toMatchObject({ code: "QUICKBOOKS_RECONCILIATION_REQUIRED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);

    const publishedPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    const matchingProviderInvoice = {
      Id: "qb-invoice-reconciled",
      ...publishedPayload,
      TotalAmt: 150,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T21:00:00.000Z" },
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    };

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([{
      ...matchingProviderInvoice,
      Id: "qb-invoice-wrong-customer",
      CustomerRef: { value: "wrong-customer" },
    }]);
    const wrongMatch = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(wrongMatch.statusCode).toBe(200);
    expect(wrongMatch.json()).toMatchObject({
      found: false,
      operation: { status: "RECONCILIATION_REQUIRED" },
    });

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([
      matchingProviderInvoice,
      { ...matchingProviderInvoice, Id: "qb-invoice-duplicate-number" },
    ]);
    const multipleMatches = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(multipleMatches.statusCode).toBe(200);
    expect(multipleMatches.json()).toMatchObject({
      found: false,
      operation: { status: "RECONCILIATION_REQUIRED" },
    });

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([matchingProviderInvoice]);
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue(matchingProviderInvoice);
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      found: true,
      reconciliationRequired: false,
      operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001" },
      reconciliation: {
        invoiceStatus: "OPEN",
        paymentStatus: "PENDING",
        amountPaid: 0,
        balanceDue: 150,
        hostedPaymentUrlAvailable: false,
      },
    });
    expect(reconciled.body).not.toContain("qb-invoice-reconciled");
    expect(reconciled.body).not.toContain("invoiceId");
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledTimes(3);
    expect(quickBooksProviderMocks.fetchInvoice).toHaveBeenCalledTimes(1);
    const projectedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(projectedInvoice).toMatchObject({
      status: "OPEN",
      paymentStatus: "PENDING",
      amountPaid: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal(150),
    });
  });

  test("authoritatively projects an uncertain create and its hosted link without another provider create", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-uncertain-hosted");
      const { invoice } = await createQuickBooksReadyInvoice(owner, "uncertain-hosted");
      const billingEmail = "uncertain.hosted@example.com";
      const previewResponse = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        payload: {
          billingEmail,
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: false,
        },
        headers: { cookie: owner.cookie },
      });
      expect(previewResponse.statusCode).toBe(200);
      const reviewBinding = (previewResponse.json() as { preview: { reviewBinding: string } }).preview.reviewBinding;
      quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic uncertain hosted create"));

      const publish = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: { cookie: owner.cookie, "idempotency-key": `qb-uncertain-hosted-${Date.now()}` },
        payload: {
          invoiceVersion: invoice.version,
          reviewBinding,
          billingEmail,
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: false,
        },
      });
      expect(publish.statusCode).toBe(202);
      const providerPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
      const providerInvoice = {
        ...providerPayload,
        Id: "qb-invoice-uncertain-hosted",
        TotalAmt: 150,
        Balance: 150,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-27T21:30:00.000Z" },
        CurrencyRef: { value: "USD" },
        LinkedTxn: [],
        AllowOnlinePayment: true,
        AllowOnlineACHPayment: true,
        AllowOnlineCreditCardPayment: false,
        InvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=uncertain-hosted",
      };
      quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([providerInvoice]);
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue(providerInvoice);

      const reconciled = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
        headers: { cookie: owner.cookie },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(reconciled.headers["cache-control"]).toContain("no-store");
      expect(reconciled.json()).toMatchObject({
        found: true,
        reconciliationRequired: false,
        operation: {
          status: "SUCCEEDED",
          paymentMethods: { ach: true, card: false },
          paymentLinkAvailable: true,
        },
        reconciliation: {
          invoiceStatus: "OPEN",
          paymentStatus: "PENDING",
          amountPaid: 0,
          balanceDue: 150,
          hostedPaymentUrlAvailable: true,
        },
      });
      expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
      expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledTimes(1);
      expect(quickBooksProviderMocks.fetchInvoice).toHaveBeenCalledTimes(1);
      await expect(prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).resolves.toMatchObject({
        status: "OPEN",
        paymentStatus: "PENDING",
        amountPaid: new Prisma.Decimal(0),
        balanceDue: new Prisma.Decimal(150),
      });
      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      })).resolves.toMatchObject({
        status: "SUCCEEDED",
        providerInvoiceId: providerInvoice.Id,
        providerInvoiceLink: expect.stringMatching(/^qbl1\./),
        claimTokenHash: null,
        claimExpiresAtUtc: null,
      });
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("commits an expired publish claim to reconciliation-required before returning 409", async () => {
    const owner = await signUp("invoice-qb-expired-publish");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "expired-publish");
    quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic uncertain publish"));
    const initial = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-expired-initial-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(initial.statusCode).toBe(202);

    const processingStartedAtUtc = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.quickBooksInvoiceOperation.update({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      data: {
        status: "PROCESSING",
        claimTokenHash: "a".repeat(64),
        processingStartedAtUtc,
        claimExpiresAtUtc: new Date(processingStartedAtUtc.getTime() + 2 * 60 * 1000),
        failedAtUtc: null,
        lastFailureCode: null,
      },
    });

    const expired = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-expired-retry-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({
      code: "QUICKBOOKS_RECONCILIATION_REQUIRED",
      operation: {
        status: "RECONCILIATION_REQUIRED",
        reconciliationAvailable: true,
      },
    });
    const persisted = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    });
    expect(persisted).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      lastFailureCode: "PUBLISH_CLAIM_EXPIRED",
    });
    expect(await prisma.invoiceEvent.count({
      where: {
        tenantId: owner.tenant.id,
        invoiceId: invoice.id,
        type: "PROVIDER_RECONCILIATION_REQUIRED",
      },
    })).toBe(2);
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
  });

  test("reconciles an expired PROCESSING claim with one lookup and zero additional creates", async () => {
    const owner = await signUp("invoice-qb-expired-processing");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(owner, "expired-processing");
    quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic uncertain publish"));
    const initial = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-processing-initial-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(initial.statusCode).toBe(202);
    const publishedPayload = quickBooksProviderMocks.createInvoice.mock.calls[0]?.[3] as Record<string, unknown>;
    const processingStartedAtUtc = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.quickBooksInvoiceOperation.update({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      data: {
        status: "PROCESSING",
        claimTokenHash: "b".repeat(64),
        processingStartedAtUtc,
        claimExpiresAtUtc: new Date(processingStartedAtUtc.getTime() + 2 * 60 * 1000),
        failedAtUtc: null,
        lastFailureCode: null,
      },
    });
    const preview = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      preview: { operation: { status: "PROCESSING", reconciliationAvailable: true } },
    });
    expect(preview.body).not.toContain("claimExpiresAtUtc");
    expect(preview.body).not.toContain(connection.realmId);

    const providerInvoice = {
      Id: "qb-invoice-expired-processing",
      ...publishedPayload,
      TotalAmt: 150,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T21:00:00.000Z" },
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    };
    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([providerInvoice]);
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue(providerInvoice);
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      found: true,
      operation: { status: "SUCCEEDED", reconciliationAvailable: false },
    });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledWith(
      expect.anything(),
      connection.realmId,
      "test-access-token",
      "QF-000001",
    );
    const persisted = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    });
    expect(persisted).toMatchObject({
      status: "SUCCEEDED",
      reconciliationCount: 1,
      providerRealmId: connection.realmId,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
    });
  });

  test("returns a stable reconnect response when manual refresh or reconciliation finds revoked authorization", async () => {
    quickBooksProviderMocks.refreshToken.mockRejectedValue(
      new QuickBooksProviderError("QUICKBOOKS_REAUTH_REQUIRED", false, 400),
    );

    const refreshOwner = await signUp("invoice-qb-refresh-reauth");
    const refreshFixture = await createQuickBooksReconciliationFixture(refreshOwner, "refresh-reauth");
    await prisma.quickBooksConnection.update({
      where: { id: refreshFixture.connection.id },
      data: { accessTokenExpiresAtUtc: new Date(0) },
    });
    const refresh = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${refreshFixture.invoice.id}/refresh`,
      headers: { cookie: refreshOwner.cookie },
    });
    expect(refresh.statusCode).toBe(409);
    expect(refresh.json()).toMatchObject({ code: "QUICKBOOKS_REAUTH_REQUIRED" });
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: refreshFixture.connection.id },
    })).resolves.toMatchObject({ status: "NEEDS_REAUTH", refreshTokenEncrypted: null });

    const reconcileOwner = await signUp("invoice-qb-reconcile-reauth");
    const reconcileFixture = await createQuickBooksReconciliationFixture(reconcileOwner, "reconcile-reauth");
    await prisma.quickBooksConnection.update({
      where: { id: reconcileFixture.connection.id },
      data: { accessTokenExpiresAtUtc: new Date(0) },
    });
    const reconcile = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${reconcileFixture.invoice.id}/reconcile`,
      headers: { cookie: reconcileOwner.cookie },
    });
    expect(reconcile.statusCode).toBe(409);
    expect(reconcile.json()).toMatchObject({
      code: "QUICKBOOKS_REAUTH_REQUIRED",
      found: true,
      reconciliationRequired: true,
      operation: { status: "RECONCILIATION_REQUIRED" },
    });
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: reconcileFixture.connection.id },
    })).resolves.toMatchObject({ status: "NEEDS_REAUTH", refreshTokenEncrypted: null });
  });

  test("deterministically migrates plaintext hosted links without changing unrelated operation lifecycles", async () => {
    const owner = await signUp("invoice-qb-hosted-link-migration");
    const active = await createQuickBooksReconciliationFixture(owner, "migration-active");
    const archived = await createQuickBooksReconciliationFixture(
      owner,
      "migration-archived",
      active.connection,
    );
    const providerless = await createQuickBooksReadyInvoice(
      owner,
      "migration-providerless",
      active.connection,
    );
    const noLink = await createQuickBooksReconciliationFixture(
      owner,
      "migration-no-link",
      active.connection,
    );
    const reviewer = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id },
      select: { id: true },
    });
    const now = new Date("2026-09-02T20:00:00.000Z");

    await prisma.quickBooksInvoiceOperation.update({
      where: { id: active.operation.id },
      data: {
        providerInvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=migration-active",
        invoiceLinkFetchedAtUtc: now,
        providerSyncToken: "4",
        providerInvoiceStatus: "Open",
        providerBalance: 150,
        providerUpdatedAtUtc: now,
        lastReconciledAtUtc: now,
      },
    });
    await prisma.quickBooksInvoiceOperation.update({
      where: { id: archived.operation.id },
      data: {
        providerInvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=migration-archived",
        invoiceLinkFetchedAtUtc: now,
        archivedAtUtc: now,
      },
    });
    const providerlessOperation = await prisma.quickBooksInvoiceOperation.create({
      data: {
        tenantId: owner.tenant.id,
        invoiceId: providerless.invoice.id,
        quickBooksConnectionId: active.connection.id,
        requestedByTenantUserId: reviewer.id,
        status: "FAILED",
        commandKeyHash: createHash("sha256").update("migration-providerless-command").digest("hex"),
        payloadHash: createHash("sha256").update("migration-providerless-payload").digest("hex"),
        providerRealmId: active.connection.realmId,
        providerRequestId: "migration-providerless-request",
        providerDocNumber: "QF-MIGRATION-PROVIDERLESS",
        processingStartedAtUtc: now,
        lastAttemptAtUtc: now,
        failedAtUtc: now,
        lastFailureCode: "PREEXISTING_PROVIDERLESS_FAILURE",
        providerInvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=migration-providerless",
        invoiceLinkFetchedAtUtc: now,
      },
    });

    const migrationSource = readFileSync(
      new URL(
        "../../prisma/migrations/20260902173500_add_quickbooks_reauth_connection_event/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfillStart = migrationSource.indexOf("-- Fence active provider-bound rows first.");
    expect(backfillStart).toBeGreaterThanOrEqual(0);
    const backfillStatements = migrationSource
      .slice(backfillStart)
      .split(/;\s*(?:\r?\n|$)/u)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(backfillStatements).toHaveLength(2);
    for (const statement of backfillStatements) {
      await prisma.$executeRawUnsafe(statement);
    }

    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { id: active.operation.id },
    })).resolves.toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      providerSyncToken: null,
      providerInvoiceStatus: null,
      providerBalance: null,
      providerUpdatedAtUtc: null,
      lastReconciledAtUtc: null,
      succeededAtUtc: null,
      lastFailureCode: "QUICKBOOKS_HOSTED_LINK_REENCRYPTION_REQUIRED",
    });
    const migratedArchived = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { id: archived.operation.id },
    });
    expect(migratedArchived).toMatchObject({
      status: "SUCCEEDED",
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      lastFailureCode: null,
    });
    expect(migratedArchived.succeededAtUtc).not.toBeNull();
    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { id: providerlessOperation.id },
    })).resolves.toMatchObject({
      status: "FAILED",
      providerInvoiceId: null,
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      lastFailureCode: "PREEXISTING_PROVIDERLESS_FAILURE",
    });
    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { id: noLink.operation.id },
    })).resolves.toMatchObject({
      status: "SUCCEEDED",
      providerInvoiceId: noLink.providerInvoiceId,
      providerInvoiceLink: null,
      lastFailureCode: null,
    });
  });

  test("reclaims an expired RECONCILING lease with one lookup and zero additional creates", async () => {
    const owner = await signUp("invoice-qb-expired-reconciling");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "expired-reconciling");
    quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic uncertain publish"));
    const initial = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-reconciling-initial-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(initial.statusCode).toBe(202);
    const processingStartedAtUtc = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.quickBooksInvoiceOperation.update({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      data: {
        status: "RECONCILING",
        claimTokenHash: "c".repeat(64),
        processingStartedAtUtc,
        claimExpiresAtUtc: new Date(processingStartedAtUtc.getTime() + 2 * 60 * 1000),
        reconciliationCount: 4,
        failedAtUtc: null,
        lastFailureCode: null,
      },
    });
    const preview = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(preview.json()).toMatchObject({
      preview: { operation: { status: "RECONCILING", reconciliationAvailable: true } },
    });

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([]);
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      found: false,
      operation: { status: "RECONCILIATION_REQUIRED", reconciliationAvailable: true },
    });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledTimes(1);
    const persisted = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    });
    expect(persisted).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      reconciliationCount: 5,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
    });
  });

  test("blocks a cross-realm reconnect and reconciles an uncertain operation only in its original realm", async () => {
    const owner = await signUp("invoice-qb-realm-immutable");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(owner, "realm-immutable");
    quickBooksProviderMocks.createInvoice.mockRejectedValue(new TypeError("synthetic uncertain publish"));
    const initial = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-realm-initial-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    expect(initial.statusCode).toBe(202);
    const beforeReconnect = await prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    const operationBefore = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
      where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
    });
    expect(operationBefore.providerRealmId).toBe(connection.realmId);

    const state = createSignedQuickBooksState(env, {
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      role: "owner",
    });
    await prisma.quickBooksOAuthState.create({
      data: {
        tenantId: owner.tenant.id,
        userId: owner.user.id,
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const realmB = `realm-b-${Date.now()}`;
    const callback = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=realm-b-code&realmId=${realmB}`,
      headers: { cookie: owner.cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("integrations=quickbooks_realm_change_blocked");
    expect(quickBooksProviderMocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(quickBooksProviderMocks.fetchCompanyInfo).not.toHaveBeenCalled();
    const afterReconnect = await prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(afterReconnect).toMatchObject({
      realmId: beforeReconnect.realmId,
      accessTokenEncrypted: beforeReconnect.accessTokenEncrypted,
      refreshTokenEncrypted: beforeReconnect.refreshTokenEncrypted,
    });

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([]);
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledWith(
      expect.anything(),
      connection.realmId,
      "test-access-token",
      "QF-000001",
    );
    expect(JSON.stringify(quickBooksProviderMocks.findInvoiceByDocNumber.mock.calls)).not.toContain(realmB);
  });

  test("does not restore credentials after a disconnect races with the provider request", async () => {
    const owner = await signUp("invoice-qb-disconnect");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(owner, "disconnect");
    quickBooksProviderMocks.createInvoice.mockImplementation(async () => {
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: {
          status: "DISCONNECTED",
          disconnectedAtUtc: new Date(),
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
        },
      });
      throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-disconnect-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "QUICKBOOKS_PUBLISH_REJECTED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    const disconnected = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(disconnected).toMatchObject({
      status: "DISCONNECTED",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      accessTokenExpiresAtUtc: null,
    });
  });

  test("rejects an idempotency key reused for a different invoice with a stable conflict", async () => {
    const owner = await signUp("invoice-qb-command-conflict");
    const firstFixture = await createQuickBooksReadyInvoice(owner, "command-first");
    const secondFixture = await createQuickBooksReadyInvoice(owner, "command-second", firstFixture.connection);
    quickBooksProviderMocks.createInvoice.mockResolvedValue({
      Id: "qb-invoice-command-first",
      DocNumber: "QF-000001",
      TotalAmt: 150,
      Balance: 150,
    });
    const key = `qb-shared-command-${Date.now()}`;

    const first = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${firstFixture.invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload: { invoiceVersion: firstFixture.invoice.version, reviewBinding: firstFixture.reviewBinding },
    });
    expect(first.statusCode).toBe(201);

    const reused = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${secondFixture.invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload: { invoiceVersion: secondFixture.invoice.version, reviewBinding: secondFixture.reviewBinding },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent publish commands and enforces manager and tenant boundaries", async () => {
    const owner = await signUp("invoice-qb-concurrent");
    const member = await addMember(owner, "Invoice QB Member");
    const otherOwner = await signUp("invoice-qb-other");
    const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(owner, "concurrent");
    quickBooksProviderMocks.createInvoice.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        Id: "qb-invoice-concurrent",
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
        LinkedTxn: [],
      };
    });

    const publish = (key: string) => app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });
    const responses = await Promise.all([
      publish(`qb-concurrent-a-${Date.now()}`),
      publish(`qb-concurrent-b-${Date.now()}`),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(await prisma.quickBooksInvoiceOperation.count({
      where: { tenantId: owner.tenant.id, invoiceId: invoice.id },
    })).toBe(1);

    const memberPreview = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: member.cookie },
      payload: {},
    });
    expect(memberPreview.statusCode).toBe(403);
    expect(memberPreview.body).not.toContain("QF-000001");

    const crossTenantPreview = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: otherOwner.cookie },
      payload: {},
    });
    expect(crossTenantPreview.statusCode).toBe(404);
    expect(crossTenantPreview.body).not.toContain("QF-000001");

    const noContext = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      return transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "QuickBooksInvoiceOperation"`,
      );
    });
    expect(noContext).toEqual([]);

    const tenantRows = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await transaction.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      return transaction.$queryRaw<Array<{ invoiceId: string }>>(
        Prisma.sql`SELECT "invoiceId" FROM "QuickBooksInvoiceOperation"`,
      );
    });
    expect(tenantRows).toEqual([{ invoiceId: invoice.id }]);
  });

  test("consumes a QuickBooks OAuth state exactly once before provider exchange", async () => {
    const owner = await signUp("invoice-qb-oauth-once");
    const state = createSignedQuickBooksState(env, { tenantId: owner.tenant.id, userId: owner.user.id, role: "owner" });
    await prisma.quickBooksOAuthState.create({
      data: {
        tenantId: owner.tenant.id,
        userId: owner.user.id,
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const realmId = `realm-oauth-once-${Date.now()}`;
    quickBooksProviderMocks.exchangeAuthorizationCode.mockResolvedValue({
      access_token: "oauth-access", refresh_token: "oauth-refresh", token_type: "bearer", expires_in: 3600,
    });
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({ realmId, companyName: "OAuth Once Company" });
    const url = `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=oauth-code&realmId=${realmId}`;
    const first = await app.inject({ method: "GET", url, headers: { cookie: owner.cookie } });
    const replay = await app.inject({ method: "GET", url, headers: { cookie: owner.cookie } });
    expect(first.headers.location).toContain("integrations=quickbooks_connected");
    expect(replay.headers.location).toContain("integrations=quickbooks_invalid_state");
    expect(quickBooksProviderMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);

    const disconnected = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
      headers: { cookie: owner.cookie },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({ disconnected: true });
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(env, "oauth-refresh");
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { tenantId: owner.tenant.id } }))
      .resolves.toMatchObject({
        status: "DISCONNECTED",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
      });
  });

  test("accepts only the newest tenant-wide OAuth generation across concurrent managers", async () => {
    const owner = await signUp("invoice-qb-oauth-generation");
    const admin = await addMember(owner, "QuickBooks generation admin", "admin");
    const ownerConnect = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/connect",
      headers: { cookie: owner.cookie },
    });
    expect(ownerConnect.statusCode).toBe(200);
    const ownerAuthorizationUrl = (ownerConnect.json() as { authorizationUrl: string }).authorizationUrl;
    const ownerState = new URL(ownerAuthorizationUrl).searchParams.get("state");
    expect(ownerState).toBeTruthy();

    const firstExchangeStarted = deferred<void>();
    const firstExchange = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    quickBooksProviderMocks.exchangeAuthorizationCode
      .mockImplementationOnce(() => {
        firstExchangeStarted.resolve();
        return firstExchange.promise;
      })
      .mockResolvedValueOnce({
        access_token: "oauth-generation-admin-access",
        refresh_token: "oauth-generation-admin-refresh",
        token_type: "bearer",
        expires_in: 3_600,
      });
    const realmId = `realm-oauth-generation-${Date.now()}`;
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
      realmId,
      companyName: "OAuth Generation Company",
    });

    const ownerCallbackPromise = app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(ownerState!)}&code=owner-code&realmId=${realmId}`,
      headers: { cookie: owner.cookie },
    });
    await firstExchangeStarted.promise;

    const adminConnect = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/connect",
      headers: { cookie: admin.cookie },
    });
    expect(adminConnect.statusCode).toBe(200);
    const adminAuthorizationUrl = (adminConnect.json() as { authorizationUrl: string }).authorizationUrl;
    const adminState = new URL(adminAuthorizationUrl).searchParams.get("state");
    expect(adminState).toBeTruthy();

    firstExchange.resolve({
      access_token: "oauth-generation-owner-access",
      refresh_token: "oauth-generation-owner-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    const ownerCallback = await ownerCallbackPromise;
    expect(ownerCallback.headers.location).toContain("integrations=quickbooks_invalid_state");
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(env, "oauth-generation-owner-refresh");
    expect(await prisma.quickBooksConnection.count({ where: { tenantId: owner.tenant.id } })).toBe(0);

    const adminCallback = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(adminState!)}&code=admin-code&realmId=${realmId}`,
      headers: { cookie: admin.cookie },
    });
    expect(adminCallback.headers.location).toContain("integrations=quickbooks_connected");
    expect(quickBooksProviderMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(2);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { tenantId: owner.tenant.id } }))
      .resolves.toMatchObject({ status: "CONNECTED", companyName: "OAuth Generation Company" });
  });

  test("blocks reconnect during revocation and cannot overwrite credentials when callback races disconnect", async () => {
    const owner = await signUp("invoice-qb-oauth-revocation-race");
    const { connection } = await createQuickBooksReadyInvoice(owner, "oauth-revocation-race");
    const originalRefreshToken = connection.refreshTokenEncrypted;

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        status: "REVOCATION_PENDING",
        disconnectRequestedAtUtc: new Date(),
        revocationPendingAtUtc: new Date(),
        revocationNextAttemptAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const blockedConnect = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/connect",
      headers: { cookie: owner.cookie },
    });
    expect(blockedConnect.statusCode).toBe(409);
    expect(blockedConnect.json()).toMatchObject({ code: "QUICKBOOKS_CREDENTIAL_LIFECYCLE_BUSY" });

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        status: "ERROR",
        disconnectRequestedAtUtc: null,
        revocationPendingAtUtc: null,
        revocationNextAttemptAtUtc: null,
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_DEAD",
      },
    });
    const terminalBlockedConnect = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/connect",
      headers: { cookie: owner.cookie },
    });
    expect(terminalBlockedConnect.statusCode).toBe(409);
    expect(terminalBlockedConnect.json()).toMatchObject({ code: "QUICKBOOKS_CREDENTIAL_LIFECYCLE_BUSY" });

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        status: "CONNECTED",
        disconnectRequestedAtUtc: null,
        revocationPendingAtUtc: null,
        revocationNextAttemptAtUtc: null,
        lastError: null,
      },
    });
    const state = createSignedQuickBooksState(env, {
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      role: "owner",
    });
    await prisma.quickBooksOAuthState.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        userId: owner.user.id,
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    quickBooksProviderMocks.exchangeAuthorizationCode.mockImplementation(async () => {
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: {
          status: "REVOCATION_PENDING",
          disconnectRequestedAtUtc: new Date(),
          revocationPendingAtUtc: new Date(),
          revocationNextAttemptAtUtc: new Date(Date.now() + 60_000),
        },
      });
      return {
        access_token: "oauth-racing-access",
        refresh_token: "oauth-racing-refresh",
        token_type: "bearer",
        expires_in: 3600,
      };
    });
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
      realmId: connection.realmId,
      companyName: "OAuth Race Company",
    });

    const callback = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=racing-code&realmId=${connection.realmId}`,
      headers: { cookie: owner.cookie },
    });
    expect(callback.headers.location).toContain("integrations=quickbooks_disconnect_pending");
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(env, "oauth-racing-refresh");
    expect(await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({
      status: "REVOCATION_PENDING",
      refreshTokenEncrypted: originalRefreshToken,
    });
  });

  test("keeps a completed disconnect final when an older OAuth callback exchange is in flight", async () => {
    const owner = await signUp("invoice-qb-oauth-disconnect-generation");
    const { connection } = await createQuickBooksReadyInvoice(owner, "oauth-disconnect-generation");
    const state = createSignedQuickBooksState(env, {
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      role: "owner",
    });
    await prisma.quickBooksOAuthState.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        userId: owner.user.id,
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const exchangeStarted = deferred<void>();
    const exchange = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockImplementationOnce(() => {
      exchangeStarted.resolve();
      return exchange.promise;
    });
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
      realmId: connection.realmId,
      companyName: "OAuth Disconnect Generation Company",
    });

    const callbackPromise = app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=older-code&realmId=${connection.realmId}`,
      headers: { cookie: owner.cookie },
    });
    await exchangeStarted.promise;

    const disconnected = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
      headers: { cookie: owner.cookie },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({ disconnected: true });

    exchange.resolve({
      access_token: "oauth-disconnect-generation-access",
      refresh_token: "oauth-disconnect-generation-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    const callback = await callbackPromise;
    expect(callback.headers.location).toContain("integrations=quickbooks_invalid_state");
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(env, "test-refresh-token");
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(
      env,
      "oauth-disconnect-generation-refresh",
    );
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "DISCONNECTED",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
      });
    await expect(prisma.quickBooksOAuthState.count({ where: { tenantId: owner.tenant.id } }))
      .resolves.toBe(0);
  });

  test("invalidates an in-flight OAuth callback when disconnect finds no connection", async () => {
    const owner = await signUp("invoice-qb-oauth-empty-disconnect-generation");
    const state = createSignedQuickBooksState(env, {
      tenantId: owner.tenant.id,
      userId: owner.user.id,
      role: "owner",
    });
    await prisma.quickBooksOAuthState.create({
      data: {
        tenantId: owner.tenant.id,
        userId: owner.user.id,
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const exchangeStarted = deferred<void>();
    const exchange = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockImplementationOnce(() => {
      exchangeStarted.resolve();
      return exchange.promise;
    });
    const realmId = `realm-oauth-empty-disconnect-${Date.now()}`;
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
      realmId,
      companyName: "OAuth Empty Disconnect Company",
    });

    const callbackPromise = app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=older-code&realmId=${realmId}`,
      headers: { cookie: owner.cookie },
    });
    await exchangeStarted.promise;

    const disconnected = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
      headers: { cookie: owner.cookie },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({ disconnected: true });

    exchange.resolve({
      access_token: "oauth-empty-disconnect-access",
      refresh_token: "oauth-empty-disconnect-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    const callback = await callbackPromise;
    expect(callback.headers.location).toContain("integrations=quickbooks_invalid_state");
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledWith(env, "oauth-empty-disconnect-refresh");
    await expect(prisma.quickBooksConnection.count({ where: { tenantId: owner.tenant.id } }))
      .resolves.toBe(0);
    await expect(prisma.quickBooksOAuthState.count({ where: { tenantId: owner.tenant.id } }))
      .resolves.toBe(0);
  });

  test("rejects a sibling-origin disconnect while allowing the configured QuoteFly app origin", async () => {
    const blockedOwner = await signUp("invoice-qb-disconnect-origin-blocked");
    const blocked = await createQuickBooksReadyInvoice(blockedOwner, "disconnect-origin-blocked");
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
      headers: {
        cookie: blockedOwner.cookie,
        origin: "https://hostile.quotefly.us",
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "QUICKBOOKS_ORIGIN_NOT_ALLOWED" });
    expect(quickBooksProviderMocks.revokeToken).not.toHaveBeenCalled();
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: blocked.connection.id } }))
      .resolves.toMatchObject({ status: "CONNECTED", disconnectRequestedAtUtc: null });

    const allowedOwner = await signUp("invoice-qb-disconnect-origin-allowed");
    const allowed = await createQuickBooksReadyInvoice(allowedOwner, "disconnect-origin-allowed");
    const approved = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
      headers: {
        cookie: allowedOwner.cookie,
        origin: new URL(env.APP_URL).origin,
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ disconnected: true });
    expect(quickBooksProviderMocks.revokeToken).toHaveBeenCalledTimes(1);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: allowed.connection.id } }))
      .resolves.toMatchObject({ status: "DISCONNECTED", refreshTokenEncrypted: null });
  });

  test("persists a canonical QuickBooks webhook before acknowledgement and deduplicates replay", async () => {
    const owner = await signUp("invoice-qb-webhook-inbox");
    const { connection } = await createQuickBooksReadyInvoice(owner, "webhook-inbox");
    await prisma.quickBooksRealmBinding.upsert({
      where: { quickBooksConnectionId: connection.id },
      create: { tenantId: owner.tenant.id, quickBooksConnectionId: connection.id, realmId: connection.realmId },
      update: { realmId: connection.realmId, active: true },
    });
    const payload = JSON.stringify({
      eventNotifications: [{ realmId: connection.realmId, dataChangeEvent: { entities: [
        {
          name: "Invoice", id: "provider-invoice-webhook", operation: "Update", lastUpdated: "2026-08-27T20:00:00.000Z",
        },
        {
          name: "RefundReceipt", id: "provider-refund-webhook", operation: "Update", lastUpdated: "2026-08-27T20:01:00.000Z",
        },
      ] } }],
    });
    const signature = createHmac("sha256", env.QUICKBOOKS_WEBHOOK_VERIFIER).update(payload).digest("base64");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/v1/integrations/quickbooks/webhook",
        headers: { "content-type": "application/json", "intuit-signature": signature }, payload,
      });
      expect(response.statusCode).toBe(200);
    }
    expect(await prisma.quickBooksWebhookEvent.count({ where: { tenantId: owner.tenant.id } })).toBe(2);
    expect(await prisma.quickBooksWebhookEvent.findMany({
      where: { tenantId: owner.tenant.id },
      orderBy: { eventType: "asc" },
    })).toEqual([
      expect.objectContaining({ eventType: "Invoice", status: "RECEIVED", attemptCount: 0 }),
      expect.objectContaining({ eventType: "RefundReceipt", status: "RECEIVED", attemptCount: 0 }),
    ]);
  });

  test("persists the maximum multi-realm webhook batch within the acknowledgement budget", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({
      eventNotifications: Array.from({ length: 25 }, (_, index) => ({
        realmId: `unknown-realm-${stamp}-${index}`,
        dataChangeEvent: {
          entities: [{
            name: "Invoice",
            id: `provider-invoice-${index}`,
            operation: "Update",
            lastUpdated: "2026-09-03T12:00:00.000Z",
          }],
        },
      })),
    });
    const signature = createHmac("sha256", env.QUICKBOOKS_WEBHOOK_VERIFIER).update(payload).digest("base64");
    const startedAt = performance.now();
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: { "content-type": "application/json", "intuit-signature": signature },
      payload,
    });
    const durationMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, count: 25, persisted: 25 });
    expect(durationMs).toBeLessThan(3_000);
    await expect(prisma.quickBooksWebhookEvent.count({
      where: { tenantId: null, realmId: { startsWith: `unknown-realm-${stamp}` } },
    })).resolves.toBe(25);
  });

  test("persists and deduplicates the maximum single unknown-realm batch within the acknowledgement budget", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const realmId = `unknown-batch-${stamp}`;
    const payload = JSON.stringify(Array.from({ length: 500 }, (_, index) => ({
      specversion: "1.0",
      id: `evt-${stamp}-${index}`,
      source: "quickbooks://sandbox",
      type: "qbo.invoice.updated.v1",
      time: "2026-09-03T12:00:00.000Z",
      intuitentityid: `inv-${index}`,
      intuitaccountid: realmId,
    })));
    const signature = createHmac("sha256", env.QUICKBOOKS_WEBHOOK_VERIFIER).update(payload).digest("base64");
    const deliver = () => app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: { "content-type": "application/json", "intuit-signature": signature },
      payload,
    });

    const startedAt = performance.now();
    const first = await deliver();
    const firstDurationMs = performance.now() - startedAt;
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, count: 500, persisted: 500 });
    expect(firstDurationMs).toBeLessThan(3_000);

    const replayStartedAt = performance.now();
    const replay = await deliver();
    const replayDurationMs = performance.now() - replayStartedAt;
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ received: true, count: 500, persisted: 0 });
    expect(replayDurationMs).toBeLessThan(3_000);
    await expect(prisma.quickBooksWebhookEvent.count({ where: { realmId } })).resolves.toBe(500);
  });

  test("rejects webhook deliveries that exceed the bounded distinct-realm budget", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify(Array.from({ length: 26 }, (_, index) => ({
      specversion: "1.0",
      id: `event-${stamp}-${index}`,
      source: "quickbooks://sandbox",
      type: "qbo.invoice.updated.v1",
      time: "2026-09-03T12:00:00.000Z",
      intuitentityid: `provider-invoice-${index}`,
      intuitaccountid: `bounded-realm-${stamp}-${index}`,
    })));
    const signature = createHmac("sha256", env.QUICKBOOKS_WEBHOOK_VERIFIER).update(payload).digest("base64");
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: { "content-type": "application/json", "intuit-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "QUICKBOOKS_WEBHOOK_REALM_LIMIT_EXCEEDED" });
    await expect(prisma.quickBooksWebhookEvent.count({
      where: { realmId: { startsWith: `bounded-realm-${stamp}` } },
    })).resolves.toBe(0);
  });

  test("rejects reviewed mapping attempts that cross the tenant boundary", async () => {
    const owner = await signUp("invoice-qb-map-owner");
    const otherOwner = await signUp("invoice-qb-map-other");
    const { connection } = await createQuickBooksReadyInvoice(owner, "map-owner");
    const otherCustomer = await createCustomer(otherOwner, "Other tenant customer");
    quickBooksProviderMocks.fetchCustomer.mockResolvedValue({ Id: "provider-customer-cross", DisplayName: "Provider customer", Active: true });
    const response = await app.inject({
      method: "POST", url: "/v1/integrations/quickbooks/mappings/customer/review",
      headers: { cookie: owner.cookie },
      payload: { customerId: otherCustomer.id, quickBooksCustomerId: "provider-customer-cross" },
    });
    expect(response.statusCode).toBe(404);
    expect(await prisma.quickBooksCustomerMap.count({
      where: { tenantId: owner.tenant.id, quickBooksConnectionId: connection.id, customerId: otherCustomer.id },
    })).toBe(0);

    const hiddenFromOtherTenant = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await transaction.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${otherOwner.tenant.id}, true)`);
      return transaction.$queryRaw<Array<{ customerId: string }>>(Prisma.sql`
        SELECT "customerId"
        FROM "QuickBooksCustomerMap"
        WHERE "quickBooksConnectionId" = ${connection.id}
      `);
    });
    expect(hiddenFromOtherTenant).toEqual([]);

    const visibleToOwningTenant = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await transaction.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      return transaction.$queryRaw<Array<{ customerId: string }>>(Prisma.sql`
        SELECT "customerId"
        FROM "QuickBooksCustomerMap"
        WHERE "quickBooksConnectionId" = ${connection.id}
      `);
    });
    expect(visibleToOwningTenant).toHaveLength(1);
  });

  test("keeps partial and full refund projections idempotent across replayed reconciliation", async () => {
    const owner = await signUp("invoice-qb-refund-replay");
    const fixture = await createQuickBooksReadyInvoice(owner, "refund-replay");
    const reviewer = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id }, select: { id: true },
    });
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: fixture.invoice.id }, include: { lineItems: true },
    });
    const providerInvoiceId = "provider-invoice-refund-replay";
    const providerPayload = {
      Id: providerInvoiceId,
      DocNumber: `QF-${String(invoice.invoiceNumber).padStart(6, "0")}`,
      TxnDate: invoice.createdAt.toISOString().slice(0, 10),
      DueDate: invoice.dueAtUtc?.toISOString().slice(0, 10),
      PrivateNote: `QuoteFly:${createHash("sha256").update(`${owner.tenant.id}:${invoice.id}`).digest("hex").slice(0, 24)}`,
      CustomerRef: { value: `qb-customer-${fixture.title.split(" ")[0]}` },
      CurrencyRef: { value: "USD" },
      TotalAmt: Number(invoice.totalAmount),
      Line: invoice.lineItems.map((line) => ({
        Description: line.description,
        Amount: Number(line.lineTotal),
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          Qty: Number(line.quantity), UnitPrice: Number(line.unitPrice),
          ItemRef: { value: "qb-item-refund-replay" },
        },
      })),
    };
    await prisma.quickBooksInvoiceOperation.create({
      data: {
        tenantId: owner.tenant.id,
        invoiceId: invoice.id,
        quickBooksConnectionId: fixture.connection.id,
        requestedByTenantUserId: reviewer.id,
        status: "SUCCEEDED",
        commandKeyHash: createHash("sha256").update("refund-command").digest("hex"),
        payloadHash: quickBooksInvoiceFingerprint(providerPayload),
        providerRealmId: fixture.connection.realmId,
        providerRequestId: "refund-request",
        providerInvoiceId,
        providerDocNumber: providerPayload.DocNumber,
        processingStartedAtUtc: new Date(),
        lastAttemptAtUtc: new Date(),
        succeededAtUtc: new Date(),
      },
    });
    let applicationAmount = 100;
    let balance = 50;
    let linked = true;
    let syncToken = 1;
    quickBooksProviderMocks.fetchInvoice.mockImplementation(async () => ({
      ...providerPayload,
      Balance: balance,
      SyncToken: `${syncToken}`,
      MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
      LinkedTxn: linked ? [{ TxnId: "payment-refund-replay", TxnType: "Payment" }] : [],
    }));
    quickBooksProviderMocks.fetchPayment.mockImplementation(async () => ({
      Id: "payment-refund-replay", TotalAmt: applicationAmount, SyncToken: `${applicationAmount}`,
      Line: [{ Amount: applicationAmount, LinkedTxn: [{ TxnId: providerInvoiceId, TxnType: "Invoice" }] }],
    }));
    const reconcile = () => reconcileQuickBooksInvoice({
      prisma, runtimeEnv: env, tenantId: owner.tenant.id, invoiceId: invoice.id,
      trigger: "MANUAL", getAccessToken: async () => "test-access-token",
    });
    await reconcile();
    applicationAmount = 60;
    balance = 90;
    syncToken = 2;
    await reconcile();
    const partialVersion = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).version;
    await reconcile();
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
      .toMatchObject({ paymentStatus: "PARTIALLY_REFUNDED" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).version).toBe(partialVersion);
    expect(await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } }))
      .toMatchObject({ status: "PARTIALLY_REFUNDED", amount: new Prisma.Decimal(100), refundedAmount: new Prisma.Decimal(40) });
    applicationAmount = 80;
    balance = 70;
    syncToken = 3;
    await reconcile();
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
      .toMatchObject({ paymentStatus: "PARTIALLY_REFUNDED", amountPaid: new Prisma.Decimal(80) });
    expect(await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } }))
      .toMatchObject({ status: "PARTIALLY_REFUNDED", amount: new Prisma.Decimal(100), refundedAmount: new Prisma.Decimal(20) });
    linked = false;
    balance = 150;
    syncToken = 4;
    await reconcile();
    const fullVersion = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).version;
    await reconcile();
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
      .toMatchObject({ paymentStatus: "REFUNDED", version: fullVersion });
    expect(await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } }))
      .toMatchObject({ status: "CANCELED", amount: new Prisma.Decimal(100), refundedAmount: new Prisma.Decimal(100) });
    linked = true;
    applicationAmount = 80;
    balance = 70;
    syncToken = 5;
    await reconcile();
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
      .toMatchObject({ paymentStatus: "PARTIALLY_REFUNDED", amountPaid: new Prisma.Decimal(80) });
    expect(await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } }))
      .toMatchObject({ status: "PARTIALLY_REFUNDED", amount: new Prisma.Decimal(100), refundedAmount: new Prisma.Decimal(20) });
  });

  test("projects provider-shaped partial and full RefundReceipt evidence without duplicating the payment ledger", async () => {
    const owner = await signUp("invoice-qb-refund-receipt");
    let connection: Awaited<ReturnType<typeof prisma.quickBooksConnection.create>> | undefined;
    const cases = [
      { label: "partial", refundAmount: 40, balance: 90, expectedStatus: "PARTIALLY_REFUNDED", expectedPaid: 60 },
      { label: "full", refundAmount: 100, balance: 150, expectedStatus: "REFUNDED", expectedPaid: 0 },
    ] as const;

    for (const testCase of cases) {
      const fixture = await createQuickBooksReconciliationFixture(
        owner,
        `refund-receipt-${testCase.label}`,
        connection,
      );
      connection = fixture.connection;
      const paymentId = `payment-refund-receipt-${testCase.label}`;
      const refundReceiptId = `refund-receipt-${testCase.label}`;
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
        ...fixture.providerPayload,
        Balance: testCase.balance,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-27T20:05:00.000Z" },
        LinkedTxn: [
          { TxnId: paymentId, TxnType: "Payment" },
          { TxnId: refundReceiptId, TxnType: "RefundReceipt" },
        ],
      });
      quickBooksProviderMocks.fetchPayment.mockResolvedValue({
        Id: paymentId,
        TotalAmt: 100,
        SyncToken: "2",
        TxnDate: "2026-08-27",
        CurrencyRef: { value: "USD" },
        MetaData: { LastUpdatedTime: "2026-08-27T20:03:00.000Z" },
        Line: [{ Amount: 100, LinkedTxn: [{ TxnId: fixture.providerInvoiceId, TxnType: "Invoice" }] }],
      });
      quickBooksProviderMocks.fetchRefundReceipt.mockResolvedValue({
        Id: refundReceiptId,
        TotalAmt: testCase.refundAmount,
        SyncToken: "1",
        TxnDate: "2026-08-27",
        CustomerRef: fixture.providerPayload.CustomerRef,
        CurrencyRef: { value: "USD" },
        MetaData: { LastUpdatedTime: "2026-08-27T20:04:00.000Z" },
        LinkedTxn: [
          { TxnId: paymentId, TxnType: "Payment" },
          { TxnId: fixture.providerInvoiceId, TxnType: "Invoice" },
        ],
      });

      const reconcile = () => reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      });
      await expect(reconcile()).resolves.toMatchObject({
        invoiceStatus: "OPEN",
        paymentStatus: testCase.expectedStatus,
        amountPaid: testCase.expectedPaid,
        balanceDue: testCase.balance,
      });
      const projectedVersion = (await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).version;
      await expect(reconcile()).resolves.toMatchObject({ paymentStatus: testCase.expectedStatus });
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
        status: "OPEN",
        paymentStatus: testCase.expectedStatus,
        amountPaid: new Prisma.Decimal(testCase.expectedPaid),
        balanceDue: new Prisma.Decimal(testCase.balance),
        version: projectedVersion,
      });
      expect(await prisma.invoicePayment.findMany({ where: { invoiceId: fixture.invoice.id } })).toEqual([
        expect.objectContaining({
          providerPaymentId: paymentId,
          status: testCase.expectedStatus,
          amount: new Prisma.Decimal(100),
          refundedAmount: new Prisma.Decimal(testCase.refundAmount),
        }),
      ]);
    }
  });

  test("fails closed when a RefundReceipt does not prove the target invoice and payment application", async () => {
    const owner = await signUp("invoice-qb-refund-ambiguous");
    const fixture = await createQuickBooksReconciliationFixture(owner, "refund-receipt-ambiguous");
    const paymentId = "payment-refund-receipt-ambiguous";
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...fixture.providerPayload,
      Balance: 90,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T20:06:00.000Z" },
      LinkedTxn: [
        { TxnId: paymentId, TxnType: "Payment" },
        { TxnId: "refund-receipt-ambiguous", TxnType: "RefundReceipt" },
      ],
    });
    quickBooksProviderMocks.fetchPayment.mockResolvedValue({
      Id: paymentId,
      TotalAmt: 100,
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: fixture.providerInvoiceId, TxnType: "Invoice" }] }],
    });
    quickBooksProviderMocks.fetchRefundReceipt.mockResolvedValue({
      Id: "refund-receipt-ambiguous",
      TotalAmt: 40,
      CustomerRef: fixture.providerPayload.CustomerRef,
      CurrencyRef: { value: "USD" },
      // A payment-only association cannot prove which of that payment's
      // invoices the refund belongs to, so reconciliation must quarantine it.
      LinkedTxn: [{ TxnId: paymentId, TxnType: "Payment" }],
    });

    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).rejects.toMatchObject({ code: "QUICKBOOKS_REFUND_APPLICATION_UNSUPPORTED", retryable: false });
    expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(0);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
      paymentStatus: "PENDING",
      amountPaid: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal(150),
    });
  });

  test("quarantines incomplete, non-finite, out-of-range, and freshness-free invoice snapshots without touching the ledger", async () => {
    const owner = await signUp("invoice-qb-invalid-snapshot");
    let connection: Awaited<ReturnType<typeof prisma.quickBooksConnection.create>> | undefined;
    const cases = [
      { label: "missing-balance", override: { Balance: undefined }, code: "QUICKBOOKS_INVOICE_BALANCE_INVALID" },
      { label: "nonfinite-total", override: { TotalAmt: Number.POSITIVE_INFINITY, Balance: 150 }, code: "QUICKBOOKS_INVOICE_TOTAL_INVALID" },
      { label: "range-balance", override: { Balance: 151 }, code: "QUICKBOOKS_INVOICE_BALANCE_RANGE_INVALID" },
      { label: "missing-freshness", override: { MetaData: undefined }, code: "QUICKBOOKS_INVOICE_FRESHNESS_INVALID" },
    ] as const;
    for (const testCase of cases) {
      const fixture = await createQuickBooksReconciliationFixture(
        owner,
        `invalid-${testCase.label}`,
        connection,
      );
      connection = fixture.connection;
      const before = await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } });
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
        ...fixture.providerPayload,
        Balance: 150,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
        LinkedTxn: [],
        ...testCase.override,
      });
      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).rejects.toMatchObject({ code: testCase.code });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } });
      expect(after).toMatchObject({
        status: before.status,
        paymentStatus: before.paymentStatus,
        amountPaid: before.amountPaid,
        balanceDue: before.balanceDue,
        version: before.version,
      });
      expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(0);
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
        .toMatchObject({ status: "RECONCILIATION_REQUIRED", lastFailureCode: testCase.code });
    }
  });

  test("quarantines insufficient Payment applications and unsupported credits or deposits with the ledger unchanged", async () => {
    const owner = await signUp("invoice-qb-evidence-gate");
    const insufficient = await createQuickBooksReconciliationFixture(owner, "evidence-insufficient");
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...insufficient.providerPayload,
      Balance: 50,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
      LinkedTxn: [{ TxnId: "payment-insufficient", TxnType: "Payment" }],
    });
    quickBooksProviderMocks.fetchPayment.mockResolvedValue({
      Id: "payment-insufficient",
      TotalAmt: 60,
      Line: [{ Amount: 60, LinkedTxn: [{ TxnId: insufficient.providerInvoiceId, TxnType: "Invoice" }] }],
    });
    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: insufficient.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).rejects.toMatchObject({ code: "QUICKBOOKS_PAYMENT_EVIDENCE_INSUFFICIENT" });
    expect(await prisma.invoicePayment.count({ where: { invoiceId: insufficient.invoice.id } })).toBe(0);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: insufficient.invoice.id } }))
      .toMatchObject({ paymentStatus: "PENDING", amountPaid: new Prisma.Decimal(0), balanceDue: new Prisma.Decimal(150) });

    let connection = insufficient.connection;
    for (const transactionType of ["CreditMemo", "Deposit"] as const) {
      const fixture = await createQuickBooksReconciliationFixture(
        owner,
        `unsupported-${transactionType.toLowerCase()}`,
        connection,
      );
      connection = fixture.connection;
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
        ...fixture.providerPayload,
        Balance: 100,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
        LinkedTxn: [{ TxnId: `${transactionType.toLowerCase()}-1`, TxnType: transactionType }],
      });
      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).rejects.toMatchObject({ code: "QUICKBOOKS_UNSUPPORTED_BALANCE_ADJUSTMENT" });
      expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(0);
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } }))
        .toMatchObject({ paymentStatus: "PENDING", amountPaid: new Prisma.Decimal(0), balanceDue: new Prisma.Decimal(150) });
    }
  });

  test("bounds canonical payment-evidence requests and quarantines oversized evidence sets", async () => {
    const owner = await signUp("invoice-qb-payment-evidence-bounds");
    const bounded = await createQuickBooksReconciliationFixture(owner, "payment-evidence-bounded");
    const paymentIds = Array.from({ length: 10 }, (_, index) => `bounded-payment-${index + 1}`);
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...bounded.providerPayload,
      Balance: 0,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T20:10:00.000Z" },
      LinkedTxn: paymentIds.map((TxnId) => ({ TxnId, TxnType: "Payment" })),
    });
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    quickBooksProviderMocks.fetchPayment.mockImplementation(async (
      _runtimeEnv: unknown,
      _realmId: unknown,
      _accessToken: unknown,
      paymentId: string,
    ) => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCalls -= 1;
      return {
        Id: paymentId,
        TotalAmt: 15,
        Line: [{ Amount: 15, LinkedTxn: [{ TxnId: bounded.providerInvoiceId, TxnType: "Invoice" }] }],
      };
    });
    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: bounded.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).resolves.toMatchObject({ invoiceStatus: "PAID", amountPaid: 150 });
    expect(maximumActiveCalls).toBeGreaterThan(1);
    expect(maximumActiveCalls).toBeLessThanOrEqual(5);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: bounded.invoice.id } })).toBe(10);

    const oversized = await createQuickBooksReconciliationFixture(owner, "payment-evidence-oversized", bounded.connection);
    quickBooksProviderMocks.fetchPayment.mockClear();
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...oversized.providerPayload,
      Balance: 0,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T20:11:00.000Z" },
      LinkedTxn: Array.from({ length: 101 }, (_, index) => ({
        TxnId: `oversized-payment-${index + 1}`,
        TxnType: "Payment",
      })),
    });
    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: oversized.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).rejects.toMatchObject({ code: "QUICKBOOKS_PAYMENT_EVIDENCE_LIMIT_EXCEEDED", retryable: false });
    expect(quickBooksProviderMocks.fetchPayment).not.toHaveBeenCalled();
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: oversized.operation.id } }))
      .toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        lastFailureCode: "QUICKBOOKS_PAYMENT_EVIDENCE_LIMIT_EXCEEDED",
      });
  });

  test("requires canonical provider confirmation of every reviewed hosted-payment choice", async () => {
    const owner = await signUp("invoice-qb-payment-method-confirmation");
    const scenarios = [
      {
        label: "eligibility-rejected",
        reviewed: { ach: true, card: false },
        provider: {
          AllowOnlinePayment: false,
          AllowOnlineACHPayment: false,
          AllowOnlineCreditCardPayment: false,
        },
        code: "QUICKBOOKS_PAYMENT_METHOD_INELIGIBLE",
      },
      {
        label: "confirmation-missing",
        reviewed: { ach: true, card: false },
        provider: { AllowOnlinePayment: true, AllowOnlineCreditCardPayment: false },
        code: "QUICKBOOKS_PAYMENT_METHOD_CONFIRMATION_MISSING",
      },
      {
        label: "unexpected-enabled-method",
        reviewed: { ach: false, card: false },
        provider: {
          AllowOnlinePayment: true,
          AllowOnlineACHPayment: true,
          AllowOnlineCreditCardPayment: false,
        },
        code: "QUICKBOOKS_PAYMENT_METHOD_REVIEW_MISMATCH",
      },
    ] as const;
    let connection: Awaited<ReturnType<typeof prisma.quickBooksConnection.create>> | undefined;
    for (const scenario of scenarios) {
      const fixture = await createQuickBooksReconciliationFixture(owner, scenario.label, connection);
      connection = fixture.connection;
      await prisma.quickBooksInvoiceOperation.update({
        where: { id: fixture.operation.id },
        data: {
          allowOnlineAchPayment: scenario.reviewed.ach,
          allowOnlineCardPayment: scenario.reviewed.card,
        },
      });
      const before = await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } });
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
        ...fixture.providerPayload,
        ...scenario.provider,
        Balance: 150,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-27T20:30:00.000Z" },
        LinkedTxn: [],
      });
      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).rejects.toMatchObject({ code: scenario.code, retryable: false });
      expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(0);
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
        status: before.status,
        paymentStatus: before.paymentStatus,
        amountPaid: before.amountPaid,
        balanceDue: before.balanceDue,
        version: before.version,
      });
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
        .toMatchObject({ status: "RECONCILIATION_REQUIRED", lastFailureCode: scenario.code });
    }

    const defaultOff = await createQuickBooksReconciliationFixture(owner, "provider-default-off", connection);
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...defaultOff.providerPayload,
      Balance: 150,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T20:31:00.000Z" },
      LinkedTxn: [],
    });
    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: defaultOff.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).resolves.toMatchObject({
      invoiceStatus: "OPEN",
      paymentStatus: "PENDING",
      hostedPaymentUrlAvailable: false,
    });
    await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: defaultOff.operation.id } }))
      .resolves.toMatchObject({ status: "SUCCEEDED", lastFailureCode: null });
  });

  test("quarantines materially different financial evidence at the same provider generation", async () => {
    const owner = await signUp("invoice-qb-equal-generation");
    const fixture = await createQuickBooksReconciliationFixture(owner, "equal-generation");
    let balance = 50;
    let applicationAmount = 100;
    quickBooksProviderMocks.fetchInvoice.mockImplementation(async () => ({
      ...fixture.providerPayload,
      Balance: balance,
      SyncToken: "7",
      MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
      LinkedTxn: [{ TxnId: "payment-equal-generation", TxnType: "Payment" }],
    }));
    quickBooksProviderMocks.fetchPayment.mockImplementation(async () => ({
      Id: "payment-equal-generation",
      TotalAmt: applicationAmount,
      Line: [{
        Amount: applicationAmount,
        LinkedTxn: [{ TxnId: fixture.providerInvoiceId, TxnType: "Invoice" }],
      }],
    }));
    const reconcile = () => reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    });
    await reconcile();
    const beforeInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } });
    const beforePayment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: fixture.invoice.id } });
    balance = 90;
    applicationAmount = 60;
    await expect(reconcile()).rejects.toMatchObject({ code: "QUICKBOOKS_EQUAL_GENERATION_SNAPSHOT_DRIFT" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
      paymentStatus: beforeInvoice.paymentStatus,
      amountPaid: beforeInvoice.amountPaid,
      balanceDue: beforeInvoice.balanceDue,
      version: beforeInvoice.version,
    });
    expect(await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: fixture.invoice.id } })).toMatchObject({
      status: beforePayment.status,
      amount: beforePayment.amount,
      refundedAmount: beforePayment.refundedAmount,
    });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
      .toMatchObject({ status: "RECONCILIATION_REQUIRED", lastFailureCode: "QUICKBOOKS_EQUAL_GENERATION_SNAPSHOT_DRIFT" });
  });

  test("projects a canonical void without fabricating payment and preserves the void-safe balance invariant", async () => {
    const owner = await signUp("invoice-qb-canonical-void");
    const fixture = await createQuickBooksReconciliationFixture(owner, "canonical-void");
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...fixture.providerPayload,
      TotalAmt: 0,
      Balance: 0,
      TxnStatus: "Voided",
      SyncToken: "2",
      MetaData: { LastUpdatedTime: "2026-08-27T21:00:00.000Z" },
      LinkedTxn: [],
    });

    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "WEBHOOK",
      providerOperation: "Void",
      getAccessToken: async () => "test-access-token",
    })).resolves.toMatchObject({
      invoiceStatus: "VOID",
      paymentStatus: "CANCELED",
      amountPaid: 0,
      balanceDue: 0,
    });

    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
      status: "VOID",
      paymentStatus: "CANCELED",
      amountPaid: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal(0),
    });
    expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(0);
    expect(await prisma.invoiceEvent.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, invoiceId: fixture.invoice.id, type: "VOIDED" },
    })).toMatchObject({ fromStatus: "DRAFT", toStatus: "VOID" });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
      .toMatchObject({ status: "SUCCEEDED", providerInvoiceStatus: "Voided", lastFailureCode: null });
  });

  test("treats a void event as a hint and keeps the canonical open invoice open", async () => {
    const owner = await signUp("invoice-qb-void-hint");
    const fixture = await createQuickBooksReconciliationFixture(owner, "void-hint");
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...fixture.providerPayload,
      Balance: 150,
      TxnStatus: "Open",
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T21:01:00.000Z" },
      LinkedTxn: [],
    });

    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "WEBHOOK",
      providerOperation: "Void",
      getAccessToken: async () => "test-access-token",
    })).resolves.toMatchObject({
      invoiceStatus: "OPEN",
      paymentStatus: "PENDING",
      amountPaid: 0,
      balanceDue: 150,
    });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } }))
      .toMatchObject({ status: "OPEN", paymentStatus: "PENDING", voidedAtUtc: null });
  });

  test("never stores or exposes a hosted payment link unless an online method was reviewed", async () => {
    const owner = await signUp("invoice-qb-unreviewed-link");
    const fixture = await createQuickBooksReconciliationFixture(owner, "unreviewed-link");
    quickBooksProviderMocks.fetchInvoice.mockResolvedValue({
      ...fixture.providerPayload,
      Balance: 150,
      InvoiceLink: "https://app.qbo.intuit.com/app/invoice?txnId=unreviewed-link",
      SyncToken: "1",
      MetaData: { LastUpdatedTime: "2026-08-27T21:02:00.000Z" },
      LinkedTxn: [],
    });

    await expect(reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    })).resolves.toMatchObject({ hostedPaymentUrlAvailable: false });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
      .toMatchObject({ providerInvoiceLink: null });

    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("unreviewed-link");
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("drops an unreviewed provider InvoiceLink before publish reconciliation can fail", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-unreviewed-publish-link");
      const { invoice, reviewBinding } = await createQuickBooksReadyInvoice(
        owner,
        "unreviewed-publish-link",
      );
      const providerInvoiceId = "qb-invoice-unreviewed-publish-link";
      const providerInvoiceLink = "https://app.qbo.intuit.com/app/invoice?txnId=unreviewed-publish-link";
      quickBooksProviderMocks.createInvoice.mockResolvedValue({
        Id: providerInvoiceId,
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      });
      quickBooksProviderMocks.fetchInvoice
        .mockImplementationOnce(async (
          _runtimeEnv: unknown,
          _realmId: unknown,
          _accessToken: unknown,
          requestedProviderInvoiceId: string,
        ) => ({
          ...(quickBooksProviderMocks.createInvoice.mock.calls.at(-1)?.[3] as Record<string, unknown>),
          Id: requestedProviderInvoiceId,
          TotalAmt: 150,
          Balance: 150,
          InvoiceLink: providerInvoiceLink,
          SyncToken: "1",
          MetaData: { LastUpdatedTime: "2026-08-27T21:04:00.000Z" },
          CurrencyRef: { value: "USD" },
          LinkedTxn: [],
        }))
        .mockRejectedValueOnce(new Error(`synthetic reconciliation failure ${providerInvoiceLink}`));

      const publish = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `qb-unreviewed-publish-link-${Date.now()}`,
        },
        payload: {
          invoiceVersion: invoice.version,
          reviewBinding,
          allowOnlineAchPayment: false,
          allowOnlineCardPayment: false,
        },
      });
      expect(publish.statusCode).toBe(201);
      expect(publish.json()).toMatchObject({
        reconciliationRequired: true,
        operation: {
          status: "RECONCILIATION_REQUIRED",
          paymentMethods: { ach: false, card: false },
          paymentLinkAvailable: false,
          reconciliationAvailable: true,
        },
        reconciliation: null,
      });
      expect(publish.body).not.toContain(providerInvoiceLink);

      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      })).resolves.toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        providerInvoiceId,
        providerInvoiceLink: null,
        allowOnlineAchPayment: false,
        allowOnlineCardPayment: false,
      });

      const paymentLink = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(paymentLink.statusCode).toBe(404);
      expect(paymentLink.body).not.toContain(providerInvoiceLink);
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("withholds a reviewed InvoiceLink after initial reconciliation failure and exposes it only after recovery", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-reviewed-link-recovery");
      const { invoice } = await createQuickBooksReadyInvoice(owner, "reviewed-link-recovery");
      const previewResponse = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
        headers: { cookie: owner.cookie },
        payload: {
          billingEmail: "reviewed.recovery@example.com",
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: true,
        },
      });
      expect(previewResponse.statusCode).toBe(200);
      const reviewBinding = (previewResponse.json() as {
        preview: { reviewBinding: string };
      }).preview.reviewBinding;
      const providerInvoiceId = "qb-invoice-reviewed-link-recovery";
      const providerInvoiceLink = "https://app.qbo.intuit.com/app/invoice?txnId=reviewed-link-recovery";
      quickBooksProviderMocks.createInvoice.mockResolvedValue({
        Id: providerInvoiceId,
        DocNumber: "QF-000001",
        TotalAmt: 150,
        Balance: 150,
      });
      const providerSnapshot = () => ({
        ...(quickBooksProviderMocks.createInvoice.mock.calls.at(-1)?.[3] as Record<string, unknown>),
        Id: providerInvoiceId,
        TotalAmt: 150,
        Balance: 150,
        InvoiceLink: providerInvoiceLink,
        SyncToken: "7",
        MetaData: { LastUpdatedTime: "2026-08-27T22:00:00.000Z" },
        CurrencyRef: { value: "USD" },
        LinkedTxn: [],
        AllowOnlinePayment: true,
        AllowOnlineACHPayment: true,
        AllowOnlineCreditCardPayment: true,
      });
      quickBooksProviderMocks.fetchInvoice
        // The create-follow-up lookup succeeds and contains an InvoiceLink.
        .mockImplementationOnce(async () => providerSnapshot())
        // The separate canonical reconciliation is interrupted.
        .mockRejectedValueOnce(new QuickBooksProviderError("QUICKBOOKS_PROVIDER_TIMEOUT", true));

      const publish = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": `qb-reviewed-link-recovery-${Date.now()}`,
        },
        payload: {
          invoiceVersion: invoice.version,
          reviewBinding,
          billingEmail: "reviewed.recovery@example.com",
          allowOnlineAchPayment: true,
          allowOnlineCardPayment: true,
        },
      });
      expect(publish.statusCode).toBe(201);
      expect(publish.json()).toMatchObject({
        reconciliationRequired: true,
        operation: {
          status: "RECONCILIATION_REQUIRED",
          paymentLinkAvailable: false,
          reconciliationAvailable: true,
        },
        reconciliation: null,
      });
      expect(publish.body).not.toContain(providerInvoiceLink);

      const pendingOperation = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      });
      expect(pendingOperation).toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        providerInvoiceId,
        providerInvoiceLink: null,
        invoiceLinkFetchedAtUtc: null,
        lastReconciledAtUtc: null,
        lastFailureCode: "QUICKBOOKS_PROVIDER_TIMEOUT",
      });

      const unavailable = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.body).not.toContain(providerInvoiceLink);

      quickBooksProviderMocks.fetchInvoice.mockImplementation(async () => providerSnapshot());
      const recovered = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
        headers: { cookie: owner.cookie },
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({
        found: true,
        reconciliationRequired: false,
        operation: {
          status: "SUCCEEDED",
          paymentLinkAvailable: true,
          reconciliationAvailable: false,
        },
        reconciliation: { hostedPaymentUrlAvailable: true },
      });

      const reconciledOperation = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { tenantId_invoiceId: { tenantId: owner.tenant.id, invoiceId: invoice.id } },
      });
      expect(reconciledOperation.providerInvoiceLink).toMatch(/^qbl1\./);
      expect(reconciledOperation.providerInvoiceLink).not.toContain(providerInvoiceLink);
      expect(reconciledOperation.lastReconciledAtUtc).toBeInstanceOf(Date);
      expect(reconciledOperation.invoiceLinkFetchedAtUtc?.getTime())
        .toBe(reconciledOperation.lastReconciledAtUtc?.getTime());
      expect(reconciledOperation.providerSyncToken).toBe("7");

      const available = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(available.statusCode).toBe(200);
      expect(available.json()).toMatchObject({ hostedPaymentUrl: providerInvoiceLink });
      expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
      expect(quickBooksProviderMocks.fetchInvoice).toHaveBeenCalledTimes(4);
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("invalidates hosted payment links across disconnect and requires a fresh post-reconnect reconciliation", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-link-disconnect-fence");
      const fixture = await createQuickBooksReconciliationFixture(owner, "link-disconnect-fence");
      const providerInvoiceLink = "https://app.qbo.intuit.com/app/invoice?txnId=link-disconnect-fence";
      await prisma.quickBooksInvoiceOperation.update({
        where: { id: fixture.operation.id },
        data: { allowOnlineAchPayment: true, allowOnlineCardPayment: true },
      });
      const providerSnapshot = {
        ...fixture.providerPayload,
        Balance: 150,
        InvoiceLink: providerInvoiceLink,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-28T18:00:00.000Z" },
        LinkedTxn: [],
        AllowOnlinePayment: true,
        AllowOnlineACHPayment: true,
        AllowOnlineCreditCardPayment: true,
      };
      quickBooksProviderMocks.fetchInvoice.mockResolvedValue(providerSnapshot);
      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).resolves.toMatchObject({ hostedPaymentUrlAvailable: true });

      const beforeDisconnect = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(beforeDisconnect.statusCode).toBe(200);

      const disconnect = await app.inject({
        method: "POST",
        url: "/v1/integrations/quickbooks/disconnect",
        headers: { cookie: owner.cookie },
      });
      expect(disconnect.statusCode).toBe(200);
      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { id: fixture.operation.id },
      })).resolves.toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        providerInvoiceLink: null,
        invoiceLinkFetchedAtUtc: null,
        providerSyncToken: null,
        providerUpdatedAtUtc: null,
        lastReconciledAtUtc: null,
        lastFailureCode: "QUICKBOOKS_CONNECTION_REAUTH_RECONCILIATION_REQUIRED",
      });

      const reviewer = await prisma.tenantUser.findFirstOrThrow({
        where: { tenantId: owner.tenant.id, userId: owner.user.id },
        select: { id: true },
      });
      await prisma.quickBooksConnection.update({
        where: { id: fixture.connection.id },
        data: {
          status: "CONNECTED",
          accessTokenEncrypted: encryptQuickBooksSecret(env, "reconnected-access"),
          refreshTokenEncrypted: encryptQuickBooksSecret(env, "reconnected-refresh"),
          accessTokenExpiresAtUtc: new Date(Date.now() + 3_600_000),
          setupConfirmedAtUtc: new Date(),
          setupConfirmedByTenantUserId: reviewer.id,
          setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        },
      });
      await prisma.quickBooksRealmBinding.update({
        where: { quickBooksConnectionId: fixture.connection.id },
        data: { active: true },
      });

      const staleAfterReconnect = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(staleAfterReconnect.statusCode).toBe(404);
      expect(staleAfterReconnect.body).not.toContain(providerInvoiceLink);

      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).resolves.toMatchObject({ hostedPaymentUrlAvailable: true });
      const refreshed = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({ hostedPaymentUrl: providerInvoiceLink });
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("clears hosted payment links when canonical reconciliation voids an invoice", async () => {
    const hostedPaymentsFlag = app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
    app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true;
    try {
      const owner = await signUp("invoice-qb-link-terminal-fence");
      const fixture = await createQuickBooksReconciliationFixture(owner, "link-terminal-fence");
      const providerInvoiceLink = "https://app.qbo.intuit.com/app/invoice?txnId=link-terminal-fence";
      await prisma.quickBooksInvoiceOperation.update({
        where: { id: fixture.operation.id },
        data: { allowOnlineAchPayment: true },
      });
      quickBooksProviderMocks.fetchInvoice.mockResolvedValueOnce({
        ...fixture.providerPayload,
        Balance: 150,
        InvoiceLink: providerInvoiceLink,
        SyncToken: "1",
        MetaData: { LastUpdatedTime: "2026-08-28T18:10:00.000Z" },
        LinkedTxn: [],
        AllowOnlinePayment: true,
        AllowOnlineACHPayment: true,
      });
      await reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      });
      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { id: fixture.operation.id },
      })).resolves.toMatchObject({ providerInvoiceLink: expect.stringMatching(/^qbl1\./) });

      quickBooksProviderMocks.fetchInvoice.mockResolvedValueOnce({
        ...fixture.providerPayload,
        Balance: 0,
        InvoiceLink: providerInvoiceLink,
        TxnStatus: "Voided",
        SyncToken: "2",
        MetaData: { LastUpdatedTime: "2026-08-28T18:11:00.000Z" },
        LinkedTxn: [],
        AllowOnlinePayment: true,
        AllowOnlineACHPayment: true,
      });
      await expect(reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        trigger: "MANUAL",
        getAccessToken: async () => "test-access-token",
      })).resolves.toMatchObject({
        invoiceStatus: "VOID",
        paymentStatus: "CANCELED",
        hostedPaymentUrlAvailable: false,
      });
      await expect(prisma.quickBooksInvoiceOperation.findUniqueOrThrow({
        where: { id: fixture.operation.id },
      })).resolves.toMatchObject({
        providerInvoiceLink: null,
        invoiceLinkFetchedAtUtc: null,
      });
      const unavailable = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/payment-link`,
        headers: { cookie: owner.cookie },
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.body).not.toContain(providerInvoiceLink);
    } finally {
      app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = hostedPaymentsFlag;
    }
  });

  test("does not let a delayed invalid snapshot quarantine a newer successful generation", async () => {
    const owner = await signUp("invoice-qb-stale-invalid-race");
    const fixture = await createQuickBooksReconciliationFixture(owner, "stale-invalid-race");
    let releaseInvalid!: () => void;
    const invalidBarrier = new Promise<void>((resolve) => { releaseInvalid = resolve; });
    let markInvalidStarted!: () => void;
    const invalidStarted = new Promise<void>((resolve) => { markInvalidStarted = resolve; });
    let fetchCount = 0;
    quickBooksProviderMocks.fetchInvoice.mockImplementation(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        markInvalidStarted();
        await invalidBarrier;
        return {
          ...fixture.providerPayload,
          Balance: undefined,
          SyncToken: "1",
          MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
          LinkedTxn: [],
        };
      }
      return {
        ...fixture.providerPayload,
        Balance: 150,
        SyncToken: "2",
        MetaData: { LastUpdatedTime: "2026-08-27T21:03:00.000Z" },
        LinkedTxn: [],
      };
    });
    const reconcile = () => reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    });

    const delayedInvalid = reconcile();
    await invalidStarted;
    await expect(reconcile()).resolves.toMatchObject({ invoiceStatus: "OPEN", balanceDue: 150 });
    releaseInvalid();
    await expect(delayedInvalid).rejects.toMatchObject({ code: "QUICKBOOKS_INVOICE_BALANCE_INVALID" });

    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } }))
      .toMatchObject({
        status: "SUCCEEDED",
        providerSyncToken: "2",
        lastFailureCode: null,
      });
    expect(await prisma.invoiceEvent.count({
      where: {
        tenantId: owner.tenant.id,
        invoiceId: fixture.invoice.id,
        type: "PROVIDER_RECONCILIATION_REQUIRED",
      },
    })).toBe(0);
  });

  test("uses durable provider ordering so a delayed stale reconciliation cannot overwrite a newer paid projection", async () => {
    const owner = await signUp("invoice-qb-stale-race");
    const fixture = await createQuickBooksReconciliationFixture(owner, "stale-race");
    let releaseOlder!: () => void;
    const olderBarrier = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let markOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => { markOlderStarted = resolve; });
    let fetchCount = 0;
    quickBooksProviderMocks.fetchInvoice.mockImplementation(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        markOlderStarted();
        await olderBarrier;
        return {
          ...fixture.providerPayload,
          Balance: 150,
          SyncToken: "1",
          MetaData: { LastUpdatedTime: "2026-08-27T19:00:00.000Z" },
          LinkedTxn: [],
        };
      }
      return {
        ...fixture.providerPayload,
        Balance: 0,
        SyncToken: "2",
        MetaData: { LastUpdatedTime: "2026-08-27T20:00:00.000Z" },
        LinkedTxn: [{ TxnId: "payment-stale-race", TxnType: "Payment" }],
      };
    });
    quickBooksProviderMocks.fetchPayment.mockResolvedValue({
      Id: "payment-stale-race",
      TotalAmt: 150,
      Line: [{ Amount: 150, LinkedTxn: [{ TxnId: fixture.providerInvoiceId, TxnType: "Invoice" }] }],
    });
    const reconcile = () => reconcileQuickBooksInvoice({
      prisma,
      runtimeEnv: env,
      tenantId: owner.tenant.id,
      invoiceId: fixture.invoice.id,
      trigger: "MANUAL",
      getAccessToken: async () => "test-access-token",
    });
    const delayedOlder = reconcile();
    await olderStarted;
    const newer = await reconcile();
    releaseOlder();
    const stale = await delayedOlder;
    expect(newer).toMatchObject({ invoiceStatus: "PAID", paymentStatus: "SUCCEEDED", amountPaid: 150, balanceDue: 0 });
    expect(stale).toMatchObject({ invoiceStatus: "PAID", paymentStatus: "SUCCEEDED", amountPaid: 150, balanceDue: 0 });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoice.id } })).toMatchObject({
      status: "PAID",
      paymentStatus: "SUCCEEDED",
      amountPaid: new Prisma.Decimal(150),
      balanceDue: new Prisma.Decimal(0),
    });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: fixture.operation.id } })).toMatchObject({
      providerSyncToken: "2",
      providerBalance: new Prisma.Decimal(0),
    });
    expect(await prisma.invoicePayment.count({ where: { invoiceId: fixture.invoice.id } })).toBe(1);
  });
});
