import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { createSignedQuickBooksState } from "../../src/services/quickbooks";

const quickBooksProviderMocks = vi.hoisted(() => ({
  ensureAccessToken: vi.fn(),
  createInvoice: vi.fn(),
  fetchInvoice: vi.fn(),
  findInvoiceByDocNumber: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  fetchCompanyInfo: vi.fn(),
}));

vi.mock("../../src/services/quickbooks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/quickbooks")>(
    "../../src/services/quickbooks",
  );
  return {
    ...actual,
    ensureQuickBooksAccessToken: quickBooksProviderMocks.ensureAccessToken,
    createQuickBooksInvoice: quickBooksProviderMocks.createInvoice,
    fetchQuickBooksInvoice: quickBooksProviderMocks.fetchInvoice,
    findQuickBooksInvoicesByDocNumber: quickBooksProviderMocks.findInvoiceByDocNumber,
    exchangeQuickBooksAuthorizationCode: quickBooksProviderMocks.exchangeAuthorizationCode,
    fetchQuickBooksCompanyInfo: quickBooksProviderMocks.fetchCompanyInfo,
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
    method: "GET",
    url: `/v1/integrations/quickbooks/invoices/${invoiceId}/sync-preview`,
    headers: { cookie: owner.cookie },
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
  const connection = existingConnection ?? await prisma.quickBooksConnection.create({
    data: {
      tenantId: owner.tenant.id,
      realmId: `realm-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      environment: "sandbox",
      companyName: `${label} QuickBooks Company`,
      status: "CONNECTED",
      accessTokenEncrypted: "test-token-envelope",
      refreshTokenEncrypted: "test-refresh-envelope",
      accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  await prisma.quickBooksCustomerMap.create({
    data: {
      tenantId: owner.tenant.id,
      quickBooksConnectionId: connection.id,
      customerId: customer.id,
      quickBooksCustomerId: `qb-customer-${label}`,
      quickBooksDisplayName: `${label} QuickBooks Customer`,
    },
  });
  await prisma.quickBooksItemMap.create({
    data: {
      tenantId: owner.tenant.id,
      quickBooksConnectionId: connection.id,
      itemKey: title.toLowerCase(),
      quickBooksItemId: `qb-item-${label}`,
      quickBooksItemName: `${label} QuickBooks Service Item`,
    },
  });
  const reviewBinding = await getQuickBooksReviewBinding(owner, invoice.id);
  return { customer, quote, invoice, connection, title, reviewBinding };
}

describe("invoice ledger API", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    quickBooksProviderMocks.ensureAccessToken.mockReset().mockResolvedValue("test-access-token");
    quickBooksProviderMocks.createInvoice.mockReset();
    quickBooksProviderMocks.fetchInvoice.mockReset();
    quickBooksProviderMocks.findInvoiceByDocNumber.mockReset();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockReset();
    quickBooksProviderMocks.fetchCompanyInfo.mockReset();
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
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

  test("previews a mapped QuoteFly invoice without exposing provider identifiers or calling Intuit", async () => {
    const owner = await signUp("invoice-qb-preview");
    const { invoice, title } = await createQuickBooksReadyInvoice(owner, "preview");

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
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
        }],
        operation: null,
      },
    });
    expect(response.body).not.toContain("qb-customer-preview");
    expect(response.body).not.toContain("qb-item-preview");
    expect(response.body).not.toContain("realm-preview");
    expect(quickBooksProviderMocks.ensureAccessToken).not.toHaveBeenCalled();
    expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
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
    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: owner.tenant.id,
        realmId: `realm-snapshot-${Date.now()}`,
        environment: "sandbox",
        companyName: "Snapshot QuickBooks Company",
        status: "CONNECTED",
        accessTokenEncrypted: "test-token-envelope",
        refreshTokenEncrypted: "test-refresh-envelope",
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    await prisma.quickBooksCustomerMap.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        customerId: customer.id,
        quickBooksCustomerId: "qb-customer-snapshot",
        quickBooksDisplayName: "Snapshot QuickBooks Customer",
      },
    });
    await prisma.quickBooksItemMap.createMany({
      data: ["Snapshot labor", "Snapshot materials"].map((description, index) => ({
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        itemKey: description.toLowerCase(),
        quickBooksItemId: `qb-item-snapshot-${index + 1}`,
        quickBooksItemName: description,
      })),
    });

    const firstPreviewResponse = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
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
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
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
      CurrencyRef: { name: "USD" },
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

    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: owner.tenant.id,
        realmId: `realm-fractional-${Date.now()}`,
        environment: "sandbox",
        companyName: "Fractional QuickBooks Company",
        status: "CONNECTED",
        accessTokenEncrypted: "test-token-envelope",
        refreshTokenEncrypted: "test-refresh-envelope",
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    await prisma.quickBooksCustomerMap.create({
      data: {
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        customerId: customer.id,
        quickBooksCustomerId: "qb-customer-fractional",
        quickBooksDisplayName: "Fractional QuickBooks Customer",
      },
    });
    await prisma.quickBooksItemMap.createMany({
      data: descriptions.map((description, index) => ({
        tenantId: owner.tenant.id,
        quickBooksConnectionId: connection.id,
        itemKey: description.toLowerCase(),
        quickBooksItemId: `qb-item-fractional-${index + 1}`,
        quickBooksItemName: description,
      })),
    });

    const previewResponse = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
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
    expect(quickBooksProviderMocks.ensureAccessToken).not.toHaveBeenCalled();
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
      CurrencyRef: { name: "USD" },
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
    const reconciled = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/reconcile`,
      headers: { cookie: owner.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      found: true,
      operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001" },
    });
    expect(reconciled.body).not.toContain("qb-invoice-reconciled");
    expect(reconciled.body).not.toContain("invoiceId");
    expect(quickBooksProviderMocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(quickBooksProviderMocks.findInvoiceByDocNumber).toHaveBeenCalledTimes(3);
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
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      preview: { operation: { status: "PROCESSING", reconciliationAvailable: true } },
    });
    expect(preview.body).not.toContain("claimExpiresAtUtc");
    expect(preview.body).not.toContain(connection.realmId);

    quickBooksProviderMocks.findInvoiceByDocNumber.mockResolvedValue([{
      Id: "qb-invoice-expired-processing",
      ...publishedPayload,
      TotalAmt: 150,
      Balance: 150,
      LinkedTxn: [],
    }]);
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
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: owner.cookie },
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
    const realmB = `realm-b-${Date.now()}`;
    const callback = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=realm-b-code&realmId=${realmB}`,
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

  test("does not restore credentials or call the invoice provider after a concurrent disconnect", async () => {
    const owner = await signUp("invoice-qb-disconnect");
    const { invoice, connection, reviewBinding } = await createQuickBooksReadyInvoice(owner, "disconnect");
    quickBooksProviderMocks.ensureAccessToken.mockImplementation(async (
      _env: unknown,
      _connection: unknown,
      save: (input: Record<string, unknown>) => Promise<void>,
    ) => {
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
      await save({
        accessTokenEncrypted: "must-not-be-restored",
        refreshTokenEncrypted: "must-not-be-restored",
        accessTokenExpiresAtUtc: new Date("2099-01-01T00:00:00.000Z"),
        lastTokenRefreshAtUtc: new Date(),
        refreshTokenRotatedAtUtc: new Date(),
      });
      return "must-not-be-used";
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/publish`,
      headers: { cookie: owner.cookie, "idempotency-key": `qb-disconnect-${Date.now()}` },
      payload: { invoiceVersion: invoice.version, reviewBinding },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "QUICKBOOKS_PUBLISH_REJECTED" });
    expect(quickBooksProviderMocks.createInvoice).not.toHaveBeenCalled();
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
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: member.cookie },
    });
    expect(memberPreview.statusCode).toBe(403);
    expect(memberPreview.body).not.toContain("QF-000001");

    const crossTenantPreview = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`,
      headers: { cookie: otherOwner.cookie },
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
});
