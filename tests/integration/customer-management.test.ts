import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
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
      generateLogoIfMissing: false,
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { tenant: { id: string } };
  return { cookie: cookieFrom(response), tenant: body.tenant };
}

async function createCustomer(session: Session, index: number, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/customers",
    headers: { cookie: session.cookie },
    payload: {
      fullName: `Customer ${index}`,
      phone: `(555) 200-${String(index).padStart(4, "0")}`,
      email: `customer-${index}@example.com`,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { customer: { id: string } }).customer;
}

describe("customer management", () => {
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

  test("paginates tenant-scoped customer search with accurate summaries", async () => {
    const alpha = await signUp("customer-list-alpha");
    const beta = await signUp("customer-list-beta");
    await prisma.customer.createMany({
      data: Array.from({ length: 105 }, (_, index) => {
        const phoneDigits = `5553${String(index).padStart(6, "0")}`;
        return {
          tenantId: alpha.tenant.id,
          fullName: index === 0 ? "Alpha Roofing Lead" : `Alpha Customer ${String(index).padStart(3, "0")}`,
          phone: phoneDigits,
          phoneDigits,
          email: `alpha-customer-${index}@example.com`,
        };
      }),
    });
    const first = await prisma.customer.findFirstOrThrow({
      where: { tenantId: alpha.tenant.id, fullName: "Alpha Roofing Lead" },
      select: { id: true },
    });
    await createCustomer(beta, 4, { fullName: "Alpha Other Tenant" });

    const quote = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { cookie: alpha.cookie },
      payload: {
        customerId: first.id,
        serviceType: "ROOFING",
        title: "Roof replacement",
        scopeText: "Replace the roof.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
      },
    });
    expect(quote.statusCode).toBe(201);
    const olderQuoteId = (quote.json() as { quote: { id: string } }).quote.id;
    await prisma.quote.update({
      where: { id: olderQuoteId },
      data: {
        status: "ACCEPTED",
        updatedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const latestQuote = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { cookie: alpha.cookie },
      payload: {
        customerId: first.id,
        serviceType: "ROOFING",
        title: "Latest draft",
        scopeText: "This newer draft controls the customer stage.",
        internalCostSubtotal: 50,
        customerPriceSubtotal: 100,
        taxAmount: 0,
      },
    });
    expect(latestQuote.statusCode).toBe(201);

    const pageOne = await app.inject({
      method: "GET",
      url: "/v1/customers?limit=2&offset=0&search=Alpha&lifecycle=active",
      headers: { cookie: alpha.cookie },
    });
    expect(pageOne.statusCode).toBe(200);
    const firstPageBody = pageOne.json() as {
      customers: Array<{ tenantId: string; summary: { quoteCount: number; latestQuote: { title: string } | null } }>;
      pagination: { total: number };
      summary: { lifecycleCounts: { active: number }; stageCounts: Record<string, number> };
    };
    expect(firstPageBody.customers).toHaveLength(2);
    expect(firstPageBody.customers.every((customer) => customer.tenantId === alpha.tenant.id)).toBe(true);
    expect(firstPageBody.pagination.total).toBe(105);
    expect(firstPageBody.summary.lifecycleCounts.active).toBe(105);
    expect(Object.values(firstPageBody.summary.stageCounts).reduce((sum, count) => sum + count, 0)).toBe(105);

    const beyondPriorCap = await app.inject({
      method: "GET",
      url: "/v1/customers?limit=10&offset=100&search=Alpha&lifecycle=active",
      headers: { cookie: alpha.cookie },
    });
    expect(beyondPriorCap.statusCode).toBe(200);
    const beyondPriorCapBody = beyondPriorCap.json() as {
      customers: Array<{ tenantId: string }>;
      pagination: { total: number; offset: number };
    };
    expect(beyondPriorCapBody.customers).toHaveLength(5);
    expect(beyondPriorCapBody.customers.every((customer) => customer.tenantId === alpha.tenant.id)).toBe(true);
    expect(beyondPriorCapBody.pagination).toMatchObject({ total: 105, offset: 100 });

    const quoteSearch = await app.inject({
      method: "GET",
      url: "/v1/customers?search=roof%20replacement",
      headers: { cookie: alpha.cookie },
    });
    const quoteSearchBody = quoteSearch.json() as {
      customers: Array<{ id: string; summary: { quoteCount: number; latestQuote: { title: string } | null } }>;
      pagination: { total: number };
    };
    expect(quoteSearchBody.pagination.total).toBe(1);
    expect(quoteSearchBody.customers[0]).toMatchObject({
      id: first.id,
      summary: { quoteCount: 2, latestQuote: { title: "Latest draft" } },
    });

    const oldAcceptedDoesNotPinStage = await app.inject({
      method: "GET",
      url: "/v1/customers?search=Alpha%20Roofing%20Lead&stage=WON",
      headers: { cookie: alpha.cookie },
    });
    expect(oldAcceptedDoesNotPinStage.statusCode).toBe(200);
    expect(oldAcceptedDoesNotPinStage.json()).toMatchObject({
      customers: [],
      pagination: { total: 0 },
      summary: { stageCounts: { NEW: 1, WON: 0 } },
    });
  });

  test("treats percent, underscore, and backslash as literal search characters in pages and counts", async () => {
    const session = await signUp("customer-literal-search");
    const percentCustomer = await createCustomer(session, 40, { fullName: "Literal % Customer" });
    const underscoreCustomer = await createCustomer(session, 41, { fullName: "Literal _ Customer" });
    const backslashCustomer = await createCustomer(session, 42, { fullName: "Literal \\ Customer" });

    const archive = await app.inject({
      method: "POST",
      url: `/v1/customers/${underscoreCustomer.id}/archive`,
      headers: { cookie: session.cookie },
    });
    expect(archive.statusCode).toBe(204);
    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/customers/${backslashCustomer.id}`,
      headers: { cookie: session.cookie },
    });
    expect(remove.statusCode).toBe(204);

    const cases = [
      {
        url: "/v1/customers?search=%25&lifecycle=active",
        id: percentCustomer.id,
        lifecycleCounts: { active: 1, archived: 0, deleted: 0 },
      },
      {
        url: "/v1/customers?search=_&lifecycle=archived",
        id: underscoreCustomer.id,
        lifecycleCounts: { active: 0, archived: 1, deleted: 0 },
      },
      {
        url: "/v1/customers?search=%5C&lifecycle=deleted",
        id: backslashCustomer.id,
        lifecycleCounts: { active: 0, archived: 0, deleted: 1 },
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: "GET",
        url: testCase.url,
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        customers: [{ id: testCase.id }],
        pagination: { total: 1 },
        summary: {
          lifecycleCounts: testCase.lifecycleCounts,
          stageCounts: { NEW: 1 },
        },
      });
    }
  });

  test("rejects a stale duplicate target and preserves the selected customer", async () => {
    const session = await signUp("customer-stale-duplicate");
    const target = await createCustomer(session, 10, {
      fullName: "Existing Customer",
      email: "existing@example.com",
    });

    const staleMerge = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: session.cookie },
      payload: {
        fullName: "Changed Identity",
        phone: "(555) 999-0011",
        email: "changed@example.com",
        duplicateAction: "merge",
        duplicateCustomerId: target.id,
      },
    });
    expect(staleMerge.statusCode).toBe(409);
    expect(staleMerge.json()).toMatchObject({ code: "STALE_DUPLICATE_TARGET" });

    const retained = await prisma.customer.findUniqueOrThrow({ where: { id: target.id } });
    expect(retained.fullName).toBe("Existing Customer");
    expect(retained.email).toBe("existing@example.com");
  });

  test("serializes concurrent merges so contact data cannot be overwritten", async () => {
    const session = await signUp("customer-concurrent-merge");
    const target = await createCustomer(session, 11, { email: null });
    const merge = (email: string) => app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: session.cookie },
      payload: {
        fullName: `Incoming ${email}`,
        phone: "(555) 200-0011",
        email,
        duplicateAction: "merge",
        duplicateCustomerId: target.id,
      },
    });

    const responses = await Promise.all([
      merge("merge-one@example.com"),
      merge("merge-two@example.com"),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: "MERGE_CONTACT_CONFLICT",
    });

    const retained = await prisma.customer.findUniqueOrThrow({ where: { id: target.id } });
    expect(["merge-one@example.com", "merge-two@example.com"]).toContain(retained.email);
    const mergeEvents = await prisma.customerActivityEvent.count({
      where: { customerId: target.id, eventType: "MERGED" },
    });
    expect(mergeEvents).toBe(1);
  });

  test("restores only the customer and never independently restores related quotes", async () => {
    const owner = await signUp("customer-restore-owner");
    const outsider = await signUp("customer-restore-outsider");
    const customer = await createCustomer(owner, 20);
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { cookie: owner.cookie },
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Retained quote",
        scopeText: "Retained scope.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const quoteId = (quoteResponse.json() as { quote: { id: string } }).quote.id;

    const archive = await app.inject({
      method: "POST",
      url: `/v1/customers/${customer.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    expect(archive.statusCode).toBe(204);

    const crossTenantRestore = await app.inject({
      method: "POST",
      url: `/v1/customers/${customer.id}/restore`,
      headers: { cookie: outsider.cookie },
    });
    expect(crossTenantRestore.statusCode).toBe(404);

    const restore = await app.inject({
      method: "POST",
      url: `/v1/customers/${customer.id}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ restoredQuoteCount: 0 });

    const [restoredCustomer, retainedQuote] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: quoteId } }),
    ]);
    expect(restoredCustomer.archivedAtUtc).toBeNull();
    expect(restoredCustomer.deletedAtUtc).toBeNull();
    expect(retainedQuote.archivedAtUtc).not.toBeNull();
    expect(retainedQuote.deletedAtUtc).toBeNull();
  });

  test("requires a 10-digit US phone and refuses merges that would discard contact data", async () => {
    const session = await signUp("customer-contact-merge");
    const target = await createCustomer(session, 30, { email: "retained@example.com" });

    const invalidPhone = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: session.cookie },
      payload: { fullName: "Invalid Phone", phone: "555-1234" },
    });
    expect(invalidPhone.statusCode).toBe(400);

    const conflictingMerge = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: session.cookie },
      payload: {
        fullName: "Incoming Customer",
        phone: "(555) 200-0030",
        email: "incoming@example.com",
        duplicateAction: "merge",
        duplicateCustomerId: target.id,
      },
    });
    expect(conflictingMerge.statusCode).toBe(409);
    expect(conflictingMerge.json()).toMatchObject({ code: "MERGE_CONTACT_CONFLICT" });

    const retained = await prisma.customer.findUniqueOrThrow({ where: { id: target.id } });
    expect(retained.email).toBe("retained@example.com");
    expect(retained.phone).toBe("(555) 200-0030");
  });
});
