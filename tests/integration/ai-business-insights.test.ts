import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

let app: FastifyInstance;

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie.");
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
      primaryTrade: "ROOFING",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as Omit<Session, "cookie">;
  return { ...body, cookie: cookieFrom(response) };
}

async function addWorkspaceUser(owner: Session, role: "admin" | "member"): Promise<Session> {
  const unique = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const fullName = `${role} Insight User`;
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName, role },
  });
  expect(created.statusCode).toBe(201);

  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/signin",
    payload: { email, password },
  });
  expect(signedIn.statusCode).toBe(200);
  const body = signedIn.json() as Omit<Session, "cookie">;
  return { ...body, cookie: cookieFrom(signedIn) };
}

async function createCustomer(session: Session, name: string) {
  return prisma.customer.create({
    data: {
      tenantId: session.tenant.id,
      fullName: name,
      phone: "555-456-7890",
      phoneDigits: "5554567890",
      notes: "Insight test customer.",
    },
  });
}

async function createQuote(params: {
  session: Session;
  customerId: string;
  title: string;
  serviceType: "ROOFING" | "HVAC";
  status: "ACCEPTED" | "SENT_TO_CUSTOMER" | "REJECTED";
  price: number;
  cost: number;
  createdAt: Date;
  lineDescription?: string;
}) {
  const quote = await prisma.quote.create({
    data: {
      tenantId: params.session.tenant.id,
      customerId: params.customerId,
      serviceType: params.serviceType,
      status: params.status,
      title: params.title,
      scopeText: `${params.title} scope`,
      internalCostSubtotal: params.cost,
      customerPriceSubtotal: params.price,
      taxAmount: 0,
      totalAmount: params.price,
      closedAtUtc: params.status === "ACCEPTED" ? params.createdAt : null,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    },
  });
  await prisma.quoteLineItem.create({
    data: {
      tenantId: params.session.tenant.id,
      quoteId: quote.id,
      description: params.lineDescription ?? params.title,
      quantity: 1,
      unitCost: params.cost,
      unitPrice: params.price,
    },
  });
  return quote;
}

describe("AI business insights", () => {
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

  test("members get revenue-only pipeline insights without C3 financial fields", async () => {
    const owner = await signUp("insights-member-owner");
    const member = await addWorkspaceUser(owner, "member");
    const customer = await createCustomer(owner, "Pipeline Customer");
    const now = new Date("2026-08-12T12:00:00.000Z");
    await createQuote({ session: owner, customerId: customer.id, title: "Accepted roof", serviceType: "ROOFING", status: "ACCEPTED", price: 2000, cost: 1100, createdAt: now });
    await createQuote({ session: owner, customerId: customer.id, title: "Open HVAC", serviceType: "HVAC", status: "SENT_TO_CUSTOMER", price: 1200, cost: 500, createdAt: now });

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/business-insights",
      headers: { cookie: member.cookie },
      payload: {
        prompt: "How is our pipeline doing?",
        tool: "SALES_PIPELINE",
        dateFrom: "2026-08-01T00:00:00.000Z",
        dateTo: "2026-08-31T23:59:59.999Z",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      insight: {
        maxClassification: string;
        summary: Record<string, unknown>;
        rows: Array<Record<string, unknown>>;
        fieldsExcluded: string[];
        auditEventId: string;
      };
    };
    expect(body.insight.maxClassification).toBe("C2_CUSTOMER_CONFIDENTIAL");
    expect(body.insight.summary).toMatchObject({
      quoteCount: 2,
      acceptedQuoteCount: 1,
      pipelineQuoteCount: 1,
      acceptedRevenue: 2000,
      pipelineRevenue: 1200,
    });
    expect(body.insight.summary).not.toHaveProperty("grossCost");
    expect(body.insight.summary).not.toHaveProperty("grossProfit");
    expect(body.insight.fieldsExcluded).toEqual(expect.arrayContaining(["internal costs", "gross profit", "margins"]));
    expect(JSON.stringify(body)).not.toContain(customer.id);

    const audit = await prisma.aiUsageEvent.findUniqueOrThrow({
      where: { id: body.insight.auditEventId },
      include: { retrievalAuditEvent: true },
    });
    expect(audit.tenantId).toBe(owner.tenant.id);
    expect(audit.actorUserId).toBe(member.user.id);
    expect(audit.eventType).toBe("BUSINESS_INSIGHT");
    expect(audit.purpose).toBe("BUSINESS_INSIGHT");
    expect(audit.classification).toBe("C2_CUSTOMER_CONFIDENTIAL");
    expect(audit.promptText).toBeNull();
    expect(audit.retrievalAuditEvent?.maxClassification).toBe("C2_CUSTOMER_CONFIDENTIAL");
  });

  test("profitability tools require admin or owner and remain tenant-scoped", async () => {
    const owner = await signUp("insights-owner");
    const member = await addWorkspaceUser(owner, "member");
    const beta = await signUp("insights-beta");
    const customer = await createCustomer(owner, "Profit Customer");
    const betaCustomer = await createCustomer(beta, "Cross Tenant Customer");
    const now = new Date("2026-08-12T12:00:00.000Z");
    await createQuote({ session: owner, customerId: customer.id, title: "Roof replacement", serviceType: "ROOFING", status: "ACCEPTED", price: 5000, cost: 3000, createdAt: now, lineDescription: "Architectural shingles" });
    await createQuote({ session: owner, customerId: customer.id, title: "Low margin repair", serviceType: "ROOFING", status: "ACCEPTED", price: 1000, cost: 900, createdAt: now, lineDescription: "Leak repair" });
    await createQuote({ session: beta, customerId: betaCustomer.id, title: "Beta tenant job", serviceType: "ROOFING", status: "ACCEPTED", price: 99000, cost: 100, createdAt: now, lineDescription: "Beta secret item" });

    const denied = await app.inject({
      method: "POST",
      url: "/v1/ai/business-insights",
      headers: { cookie: member.cookie },
      payload: {
        prompt: "Rank profitability",
        tool: "SERVICE_PROFITABILITY",
        dateFrom: "2026-08-01T00:00:00.000Z",
        dateTo: "2026-08-31T23:59:59.999Z",
      },
    });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/business-insights",
      headers: { cookie: owner.cookie },
      payload: {
        prompt: "Rank profitability",
        tool: "SERVICE_PROFITABILITY",
        dateFrom: "2026-08-01T00:00:00.000Z",
        dateTo: "2026-08-31T23:59:59.999Z",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      insight: {
        maxClassification: string;
        summary: Record<string, unknown>;
        rows: Array<Record<string, unknown>>;
        auditEventId: string;
      };
    };
    expect(body.insight.maxClassification).toBe("C3_FINANCIAL_CONFIDENTIAL");
    expect(body.insight.summary).toMatchObject({
      acceptedQuoteCount: 2,
      acceptedRevenue: 6000,
      grossCost: 3900,
      grossProfit: 2100,
      grossMarginPercent: 35,
    });
    expect(JSON.stringify(body)).not.toContain("99000");
    expect(JSON.stringify(body)).not.toContain("Beta tenant job");

    const audit = await prisma.aiUsageEvent.findUniqueOrThrow({
      where: { id: body.insight.auditEventId },
      include: { retrievalAuditEvent: true },
    });
    expect(audit.classification).toBe("C3_FINANCIAL_CONFIDENTIAL");
    expect(audit.retrievalAuditEvent?.maxClassification).toBe("C3_FINANCIAL_CONFIDENTIAL");
  });

  test("item and low-margin tools return bounded aggregate rows without raw ids", async () => {
    const owner = await signUp("insights-items");
    const customer = await createCustomer(owner, "Item Customer");
    const now = new Date("2026-08-12T12:00:00.000Z");
    await createQuote({ session: owner, customerId: customer.id, title: "Good roof", serviceType: "ROOFING", status: "ACCEPTED", price: 3000, cost: 1200, createdAt: now, lineDescription: "Premium shingles" });
    const weakQuote = await createQuote({ session: owner, customerId: customer.id, title: "Weak repair", serviceType: "ROOFING", status: "ACCEPTED", price: 1000, cost: 950, createdAt: now, lineDescription: "Emergency leak repair" });

    const items = await app.inject({
      method: "POST",
      url: "/v1/ai/business-insights",
      headers: { cookie: owner.cookie },
      payload: {
        prompt: "Rank items by gross profit",
        tool: "ITEM_PROFITABILITY",
        dateFrom: "2026-08-01T00:00:00.000Z",
        dateTo: "2026-08-31T23:59:59.999Z",
      },
    });
    expect(items.statusCode).toBe(200);
    expect(items.body).toContain("Premium shingles");
    expect(items.body).not.toContain(weakQuote.id);

    const lowMargin = await app.inject({
      method: "POST",
      url: "/v1/ai/business-insights",
      headers: { cookie: owner.cookie },
      payload: {
        prompt: "Which accepted jobs are underpriced?",
        tool: "LOW_MARGIN_QUOTES",
        dateFrom: "2026-08-01T00:00:00.000Z",
        dateTo: "2026-08-31T23:59:59.999Z",
      },
    });
    expect(lowMargin.statusCode).toBe(200);
    expect(lowMargin.body).toContain("Weak repair");
    expect(lowMargin.body).not.toContain(weakQuote.id);
    expect(lowMargin.body).toMatch(/[0-9a-f]{64}/);
  });
});
