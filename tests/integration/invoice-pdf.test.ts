import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { encryptQuickBooksHostedPaymentLink } from "../../src/services/quickbooks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

const render = vi.hoisted(() => vi.fn(async (_data: unknown) => Buffer.from("%PDF-1.4\nsynthetic route test\n%%EOF")));
vi.mock("../../src/services/invoice-pdf", () => ({ renderInvoicePdf: render }));

let app: FastifyInstance;
const tenants: string[] = [];
const users: string[] = [];
const link = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-synthetic-invoice-pdf";
const saved = {
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
  QUICKBOOKS_OAUTH_ONLY_MODE: env.QUICKBOOKS_OAUTH_ONLY_MODE,
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
  QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED,
  QUICKBOOKS_WEBHOOK_VERIFIER: env.QUICKBOOKS_WEBHOOK_VERIFIER,
};

async function fixture() {
  const unique = randomUUID();
  const response = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: {
    email: `invoice-pdf-${unique}@example.com`, password: "SyntheticInvoicePassword123!",
    fullName: "Invoice PDF Owner", companyName: `Invoice PDF ${unique}`, primaryTrade: "CONSTRUCTION",
    acceptedLegalTerms: true, termsVersion: "2026-07-30", privacyPolicyVersion: "2026-08-10",
  }, remoteAddress: `192.0.2.${tenants.length + 1}` });
  expect(response.statusCode).toBe(201);
  const session = response.json() as { tenant: { id: string }; user: { id: string } };
  const header = response.headers["set-cookie"];
  const cookie = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
  const tenantId = session.tenant.id;
  tenants.push(tenantId); users.push(session.user.id);
  const membership = await prisma.tenantUser.findFirstOrThrow({ where: { tenantId, userId: session.user.id } });
  const customer = await prisma.customer.create({ data: { tenantId, fullName: "Synthetic customer", phone: unique,
    notes: "PRIVATE_CUSTOMER_NOTES" } });
  const quote = await prisma.quote.create({ data: { tenantId, customerId: customer.id, serviceType: "CONSTRUCTION",
    status: "ACCEPTED", title: "Customer-safe service", scopeText: "Customer-approved scope", internalCostSubtotal: 1234.56,
    customerPriceSubtotal: 150, taxAmount: 0, totalAmount: 150, aiPromptText: "PRIVATE_AI_PROMPT" } });
  const job = await prisma.job.create({ data: { tenantId, customerId: customer.id, sourceQuoteId: quote.id,
    jobNumber: 1, title: quote.title, scopeSnapshot: quote.scopeText, serviceType: "CONSTRUCTION",
    acceptedAtUtc: new Date(), accessInstructions: "PRIVATE_ACCESS_INSTRUCTIONS" } });
  const invoice = await prisma.invoice.create({ data: { tenantId, customerId: customer.id, sourceQuoteId: quote.id,
    jobId: job.id, invoiceNumber: 1, status: "OPEN", titleSnapshot: quote.title, scopeSnapshot: quote.scopeText,
    subtotalAmount: 150, taxAmount: 0, totalAmount: 150, balanceDue: 150, issuedAtUtc: new Date(),
    dueAtUtc: new Date(Date.now() + 86400000) } });
  await prisma.invoiceLineItem.create({ data: { tenantId, invoiceId: invoice.id, description: "Customer-safe line",
    position: 0, quantity: 1, unitPrice: 150, lineTotal: 150 } });
  const connection = await prisma.quickBooksConnection.create({ data: { tenantId, realmId: unique, environment: "sandbox",
    status: "CONNECTED", setupConfirmedAtUtc: new Date(), setupConfirmedByTenantUserId: membership.id,
    setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION } });
  await prisma.quickBooksRealmBinding.create({ data: { tenantId, quickBooksConnectionId: connection.id, realmId: unique, active: true } });
  const now = new Date();
  const operation = await prisma.quickBooksInvoiceOperation.create({ data: { tenantId, invoiceId: invoice.id,
    quickBooksConnectionId: connection.id, requestedByTenantUserId: membership.id, status: "SUCCEEDED",
    commandKeyHash: "a".repeat(64), payloadHash: "b".repeat(64), providerRealmId: unique, providerRequestId: unique,
    providerInvoiceId: "123", providerDocNumber: "QF-1", providerInvoiceLink: encryptQuickBooksHostedPaymentLink(env, link),
    providerSyncToken: "1", providerUpdatedAtUtc: now, providerBalance: 150,
    allowOnlineCardPayment: true, processingStartedAtUtc: now, lastAttemptAtUtc: now,
    lastReconciledAtUtc: now, invoiceLinkFetchedAtUtc: now, succeededAtUtc: now } });
  return { tenantId, userId: session.user.id, cookie, invoice, operation, connection, membership, customer, quote, job };
}

describe("customer invoice PDF delivery boundary", () => {
  beforeAll(async () => {
    Object.assign(env, { QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true, QUICKBOOKS_OAUTH_ONLY_MODE: false,
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: true, QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: true,
      QUICKBOOKS_WEBHOOK_VERIFIER: "synthetic-invoice-pdf-verifier" });
    app = await buildServer(); await app.ready();
  });
  afterAll(async () => {
    Object.assign(env, saved);
    const where = { tenantId: { in: tenants } };
    await prisma.quickBooksInvoiceOperation.deleteMany({ where });
    await prisma.invoice.deleteMany({ where });
    await prisma.job.deleteMany({ where });
    await prisma.quote.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  test("delivers only a safe DTO and protected attachment without marking sent", async () => {
    const f = await fixture(); render.mockClear();
    const response = await app.inject({ method: "GET", url: `/v1/invoices/${f.invoice.id}/pdf?includeQuickBooksPayment=true`, headers: { cookie: f.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="invoice-1.pdf"');
    expect(render).toHaveBeenCalledOnce();
    const dto = render.mock.calls[0]![0] as Record<string, unknown>;
    expect(dto).toMatchObject({ title: "Customer-safe service", hostedPaymentUrl: link, balanceDue: 150 });
    const serialized = JSON.stringify(dto);
    for (const forbidden of ["PRIVATE_", "internalCost", "providerRealm", "accessToken", "payloadHash", "1234.56"]) expect(serialized).not.toContain(forbidden);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).sentAtUtc).toBeNull();
  });

  test("plain download never includes a payment link or needs provider enablement", async () => {
    const f = await fixture(); render.mockClear(); env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = false;
    try {
      const plain = await app.inject({ method: "GET", url: `/v1/invoices/${f.invoice.id}/pdf`, headers: { cookie: f.cookie } });
      expect(plain.statusCode).toBe(200);
      expect(render.mock.calls[0]![0]).toMatchObject({ hostedPaymentUrl: null });
      const requested = await app.inject({ method: "GET", url: `/v1/invoices/${f.invoice.id}/pdf?includeQuickBooksPayment=true`, headers: { cookie: f.cookie } });
      expect(requested.statusCode).toBe(409);
      expect(requested.body).not.toContain(link);
    } finally { env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = true; }
  });

  test("returns a stable content error without rendering internals or provider URLs", async () => {
    const f = await fixture();
    render.mockRejectedValueOnce(new Error("INVOICE_PDF_CONTENT_TOO_LARGE"));
    const response = await app.inject({ method: "GET", url: `/v1/invoices/${f.invoice.id}/pdf`, headers: { cookie: f.cookie } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "This invoice cannot be downloaded as a PDF. Review its content and amounts.", code: "INVOICE_PDF_UNAVAILABLE" });
    expect(response.body).not.toContain(link);
  });

  test("denies foreign tenants, anonymous sessions and demoted managers", async () => {
    const f = await fixture(); const other = await fixture();
    const url = `/v1/invoices/${f.invoice.id}/pdf?includeQuickBooksPayment=true`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    await prisma.tenantUser.update({ where: { id: f.membership.id }, data: { role: "member" } });
    expect((await app.inject({ method: "GET", url, headers: { cookie: f.cookie } })).statusCode).toBe(403);
  });

  test.each(["paid", "void", "stale", "disconnected", "invalid-link", "archived-source"])("omits payment delivery for %s", async condition => {
    const f = await fixture();
    if (condition === "paid") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "PAID", paymentStatus: "SUCCEEDED", amountPaid: 150, balanceDue: 0, paidAtUtc: new Date() } });
    if (condition === "void") await prisma.invoice.update({ where: { id: f.invoice.id }, data: { status: "VOID", paymentStatus: "CANCELED", balanceDue: 0, voidedAtUtc: new Date() } });
    if (condition === "stale") await prisma.quickBooksInvoiceOperation.update({ where: { id: f.operation.id }, data: { invoiceLinkFetchedAtUtc: new Date(0) } });
    if (condition === "disconnected") await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    if (condition === "invalid-link") await prisma.quickBooksInvoiceOperation.update({ where: { id: f.operation.id }, data: { providerInvoiceLink: "invalid-envelope" } });
    if (condition === "archived-source") await prisma.quote.update({ where: { id: f.quote.id }, data: { archivedAtUtc: new Date() } });
    render.mockClear();
    const response = await app.inject({ method: "GET", url: `/v1/invoices/${f.invoice.id}/pdf?includeQuickBooksPayment=true`, headers: { cookie: f.cookie } });
    expect(response.statusCode).toBe(condition === "archived-source" ? 404 : 409);
    expect(render).not.toHaveBeenCalled(); expect(response.body).not.toContain(link);
  });
});
