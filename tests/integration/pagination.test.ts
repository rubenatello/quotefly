import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string };
};

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

let app: FastifyInstance;

describe("bounded collection pagination", () => {
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

  test("customers, quotes, products, users, and follow-up default to 25 with tenant-safe search and later pages", async () => {
    const alpha = await signUp("pagination-alpha");
    const beta = await signUp("pagination-beta");

    const customers = await Promise.all(Array.from({ length: 30 }, (_, index) => prisma.customer.create({
      data: {
        tenantId: alpha.tenant.id,
        fullName: `Pagination Customer ${String(index).padStart(2, "0")}`,
        phone: `555700${String(index).padStart(4, "0")}`,
        phoneDigits: `555700${String(index).padStart(4, "0")}`,
      },
    })));
    await prisma.customer.create({
      data: {
        tenantId: beta.tenant.id,
        fullName: "Cross Tenant Pagination Secret",
        phone: "5557999999",
        phoneDigits: "5557999999",
      },
    });

    await prisma.quote.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        tenantId: alpha.tenant.id,
        customerId: customers[0]!.id,
        serviceType: "CONSTRUCTION" as const,
        status: "DRAFT" as const,
        title: `Pagination Quote ${String(index).padStart(2, "0")}`,
        scopeText: "Pagination regression scope",
        internalCostSubtotal: 25,
        customerPriceSubtotal: 50,
        taxAmount: 0,
        totalAmount: 50,
      })),
    });

    await prisma.workPreset.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        tenantId: alpha.tenant.id,
        serviceType: "CONSTRUCTION" as const,
        category: "SERVICE" as const,
        unitType: "FLAT" as const,
        name: `Pagination Service ${String(index).padStart(2, "0")}`,
        description: "Server-side catalog search regression",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 25,
      })),
    });

    const createdUsers = await Promise.all(Array.from({ length: 30 }, (_, index) => prisma.user.create({
      data: {
        email: `pagination-member-${index}-${Date.now()}@example.com`,
        passwordHash: "not-used-by-pagination-test",
        fullName: `Pagination Member ${String(index).padStart(2, "0")}`,
      },
    })));
    await prisma.tenantUser.createMany({
      data: createdUsers.map((user) => ({ tenantId: alpha.tenant.id, userId: user.id, role: "member" })),
    });

    const customerPageOne = await app.inject({ method: "GET", url: "/v1/customers", headers: { cookie: alpha.cookie } });
    expect(customerPageOne.statusCode).toBe(200);
    expect(customerPageOne.json()).toMatchObject({ pagination: { limit: 25, offset: 0, total: 30 } });
    expect((customerPageOne.json() as { customers: unknown[] }).customers).toHaveLength(25);
    expect(customerPageOne.body).not.toContain("Cross Tenant Pagination Secret");

    const customerPageTwo = await app.inject({ method: "GET", url: "/v1/customers?limit=25&offset=25", headers: { cookie: alpha.cookie } });
    expect(customerPageTwo.statusCode).toBe(200);
    expect((customerPageTwo.json() as { customers: unknown[] }).customers).toHaveLength(5);

    const quotePage = await app.inject({ method: "GET", url: "/v1/quotes", headers: { cookie: alpha.cookie } });
    expect(quotePage.statusCode).toBe(200);
    expect(quotePage.json()).toMatchObject({
      pagination: { limit: 25, offset: 0, total: 30 },
      summary: { stageCounts: { DRAFT: 30 } },
    });
    expect((quotePage.json() as { quotes: unknown[] }).quotes).toHaveLength(25);

    const productPage = await app.inject({
      method: "GET",
      url: "/v1/products?serviceType=CONSTRUCTION&search=Pagination%20Service",
      headers: { cookie: alpha.cookie },
    });
    expect(productPage.statusCode).toBe(200);
    expect(productPage.json()).toMatchObject({ pagination: { limit: 25, offset: 0, total: 30 } });
    expect((productPage.json() as { products: unknown[] }).products).toHaveLength(25);

    const memberPage = await app.inject({ method: "GET", url: "/v1/org/users", headers: { cookie: alpha.cookie } });
    expect(memberPage.statusCode).toBe(200);
    expect(memberPage.json()).toMatchObject({ pagination: { limit: 25, offset: 0, total: 31 }, policy: { teamMembersUsed: 31 } });
    expect((memberPage.json() as { members: unknown[] }).members).toHaveLength(25);

    const memberSearch = await app.inject({
      method: "GET",
      url: "/v1/org/users?search=Pagination%20Member%2029",
      headers: { cookie: alpha.cookie },
    });
    expect(memberSearch.statusCode).toBe(200);
    expect(memberSearch.json()).toMatchObject({ pagination: { total: 1 } });

    const followUpPage = await app.inject({ method: "GET", url: "/v1/workspace/follow-up?queue=new", headers: { cookie: alpha.cookie } });
    expect(followUpPage.statusCode).toBe(200);
    expect(followUpPage.json()).toMatchObject({ pagination: { limit: 25, offset: 0, total: 30 }, totals: { newLeads: 30 } });
    const followUpItems = (followUpPage.json() as { items: Array<{ activityAtUtc: string; activityKind: string }> }).items;
    expect(followUpItems).toHaveLength(25);
    expect(followUpItems.every((item) => typeof item.activityAtUtc === "string")).toBe(true);
    expect(followUpItems.some((item) => item.activityKind === "ADDED")).toBe(true);
    expect(followUpPage.body).not.toContain("Cross Tenant Pagination Secret");
  });

  test("follow-up classifies from the latest active quote and preserves literal search", async () => {
    const alpha = await signUp("follow-up-latest");
    const customer = await prisma.customer.create({
      data: {
        tenantId: alpha.tenant.id,
        fullName: "Latest % Queue Customer",
        phone: "5558112233",
        phoneDigits: "5558112233",
      },
    });
    const older = new Date("2026-08-01T12:00:00.000Z");
    const newer = new Date("2026-08-02T12:00:00.000Z");
    await prisma.quote.create({
      data: {
        tenantId: alpha.tenant.id,
        customerId: customer.id,
        serviceType: "CONSTRUCTION",
        status: "SENT_TO_CUSTOMER",
        title: "Older sent quote",
        scopeText: "Older quote",
        internalCostSubtotal: 50,
        customerPriceSubtotal: 100,
        taxAmount: 0,
        totalAmount: 100,
        createdAt: older,
        updatedAt: older,
      },
    });
    const latestQuote = await prisma.quote.create({
      data: {
        tenantId: alpha.tenant.id,
        customerId: customer.id,
        serviceType: "CONSTRUCTION",
        status: "ACCEPTED",
        jobStatus: "COMPLETED",
        afterSaleFollowUpStatus: "DUE",
        afterSaleFollowUpDueAtUtc: newer,
        title: "Latest accepted quote",
        scopeText: "Latest quote",
        internalCostSubtotal: 75,
        customerPriceSubtotal: 150,
        taxAmount: 0,
        totalAmount: 150,
        createdAt: newer,
        updatedAt: newer,
      },
    });

    const afterSale = await app.inject({
      method: "GET",
      url: "/v1/workspace/follow-up?queue=afterSale&search=%25",
      headers: { cookie: alpha.cookie },
    });
    expect(afterSale.statusCode).toBe(200);
    expect(afterSale.json()).toMatchObject({
      pagination: { total: 1 },
      items: [{
        customerId: customer.id,
        quoteId: latestQuote.id,
        status: "ACCEPTED",
        afterSaleFollowUpStatus: "DUE",
        activityAtUtc: newer.toISOString(),
        activityKind: "UPDATED",
      }],
    });

    const quoted = await app.inject({
      method: "GET",
      url: "/v1/workspace/follow-up?queue=quoted&search=%25",
      headers: { cookie: alpha.cookie },
    });
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json()).toMatchObject({ pagination: { total: 0 }, items: [] });
  });
});
