import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

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

describe("invoice ledger API", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
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
    });
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

    const noContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      const invoices = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Invoice"`);
      const payments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoicePayment"`);
      const events = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoiceEvent"`);
      return { invoices, payments, events };
    });
    expect(noContext).toEqual({ invoices: [], payments: [], events: [] });

    const tenantA = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      const invoices = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Invoice" ORDER BY "id"`);
      const payments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "InvoicePayment" ORDER BY "id"`);
      const events = await tx.$queryRaw<Array<{ invoiceId: string }>>(Prisma.sql`SELECT "invoiceId" FROM "InvoiceEvent" ORDER BY "invoiceId"`);
      const crossTenantInvoiceUpdate = await tx.$executeRaw(Prisma.sql`
        UPDATE "Invoice" SET "status" = 'OPEN'::"InvoiceStatus" WHERE "id" = ${otherInvoiceId}
      `);
      const crossTenantPaymentUpdate = await tx.$executeRaw(Prisma.sql`
        UPDATE "InvoicePayment" SET "status" = 'SUCCEEDED'::"InvoicePaymentStatus" WHERE "id" = ${otherPayment.id}
      `);
      return { invoices, payments, events, crossTenantInvoiceUpdate, crossTenantPaymentUpdate };
    });
    expect(tenantA.invoices.map((row) => row.id)).toEqual([invoiceId]);
    expect(tenantA.payments.map((row) => row.id)).toEqual([payment.id]);
    expect(tenantA.events.every((row) => row.invoiceId === invoiceId)).toBe(true);
    expect(tenantA.crossTenantInvoiceUpdate).toBe(0);
    expect(tenantA.crossTenantPaymentUpdate).toBe(0);

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
  });
});
