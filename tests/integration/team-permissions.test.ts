import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
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

async function addMember(owner: Session): Promise<Session & { membershipId: string }> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `field-${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName: "Field Member", role: "member" },
  });
  expect(created.statusCode).toBe(201);
  const membershipId = (created.json() as { member: { id: string } }).member.id;
  const signedIn = await app.inject({ method: "POST", url: "/v1/auth/signin", payload: { email, password } });
  expect(signedIn.statusCode).toBe(200);
  return { ...(signedIn.json() as Omit<Session, "cookie">), cookie: cookieFrom(signedIn), membershipId };
}

let app: FastifyInstance;

describe("workspace team permissions", () => {
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

  test("members see assigned work, can quote with hidden catalog costs, and cannot manage products", async () => {
    const owner = await signUp("team-policy");
    const member = await addMember(owner);
    const customer = await prisma.customer.create({
      data: {
        tenantId: owner.tenant.id,
        fullName: "Assigned Homeowner",
        phone: "5554040101",
        phoneDigits: "5554040101",
      },
    });
    const privateCustomer = await prisma.customer.create({
      data: {
        tenantId: owner.tenant.id,
        fullName: "Office Only Homeowner",
        phone: "5554040102",
        phoneDigits: "5554040102",
      },
    });
    const preset = await prisma.workPreset.create({
      data: {
        tenantId: owner.tenant.id,
        serviceType: "CONSTRUCTION",
        name: "Approved field labor",
        category: "LABOR",
        unitType: "HOUR",
        defaultQuantity: 1,
        unitCost: 30,
        unitPrice: 75,
      },
    });

    const beforeAssignment = await app.inject({ method: "GET", url: "/v1/customers", headers: { cookie: member.cookie } });
    expect(beforeAssignment.statusCode).toBe(200);
    expect((beforeAssignment.json() as { customers: unknown[] }).customers).toHaveLength(0);

    const assigned = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { assignedTenantUserId: member.membershipId },
    });
    expect(assigned.statusCode).toBe(200);

    const memberCustomers = await app.inject({ method: "GET", url: "/v1/customers", headers: { cookie: member.cookie } });
    const visibleCustomers = (memberCustomers.json() as { customers: Array<{ id: string }> }).customers;
    expect(visibleCustomers.map((entry) => entry.id)).toEqual([customer.id]);
    expect(visibleCustomers.map((entry) => entry.id)).not.toContain(privateCustomer.id);

    const catalog = await app.inject({ method: "GET", url: "/v1/products", headers: { cookie: member.cookie } });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json() as { products: Array<Record<string, unknown>>; policy: { canManageCatalog: boolean; canViewInternalCosts: boolean } };
    expect(catalogBody.policy).toEqual({ canManageCatalog: false, canViewInternalCosts: false });
    expect(catalogBody.products.find((entry) => entry.id === preset.id)).not.toHaveProperty("unitCost");

    const setupPricing = await app.inject({ method: "GET", url: "/v1/onboarding/setup", headers: { cookie: member.cookie } });
    expect(setupPricing.statusCode).toBe(403);
    const recommendedPricing = await app.inject({
      method: "GET",
      url: "/v1/onboarding/presets/recommended?serviceType=CONSTRUCTION",
      headers: { cookie: member.cookie },
    });
    expect(recommendedPricing.statusCode).toBe(403);

    const forbiddenProduct = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: { cookie: member.cookie },
      payload: {
        serviceType: "CONSTRUCTION",
        name: "Member-created cost leak",
        category: "LABOR",
        unitType: "HOUR",
        defaultQuantity: 1,
        unitCost: 1,
        unitPrice: 100,
      },
    });
    expect(forbiddenProduct.statusCode).toBe(403);

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { cookie: member.cookie },
      payload: {
        customerId: customer.id,
        serviceType: "CONSTRUCTION",
        title: "Assigned labor quote",
        scopeText: "Approved work",
        internalCostSubtotal: 0.01,
        customerPriceSubtotal: 150,
        taxAmount: 0,
        lineItems: [{
          description: "Approved field labor",
          quantity: 2,
          unitCost: 0.01,
          unitPrice: 75,
          sourcePresetId: preset.id,
        }],
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const publicQuote = (quoteResponse.json() as { quote: Record<string, unknown> }).quote;
    expect(publicQuote).not.toHaveProperty("internalCostSubtotal");
    expect(quoteResponse.body).not.toContain("unitCost");

    const stored = await prisma.quote.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, title: "Assigned labor quote" },
      include: { lineItems: true },
    });
    expect(stored.assignedTenantUserId).toBe(member.membershipId);
    expect(Number(stored.internalCostSubtotal)).toBe(60);
    expect(Number(stored.lineItems[0]?.unitCost)).toBe(30);

    const memberQuoteDetail = await app.inject({ method: "GET", url: `/v1/quotes/${stored.id}`, headers: { cookie: member.cookie } });
    expect(memberQuoteDetail.statusCode).toBe(200);
    expect(memberQuoteDetail.body).not.toContain("unitCost");
    expect(memberQuoteDetail.body).not.toContain("internalCostSubtotal");

    const privateRead = await app.inject({ method: "GET", url: `/v1/customers/${privateCustomer.id}`, headers: { cookie: member.cookie } });
    expect(privateRead.statusCode).toBe(404);

    const forbiddenCustomerArchive = await app.inject({ method: "POST", url: `/v1/customers/${customer.id}/archive`, headers: { cookie: member.cookie } });
    expect(forbiddenCustomerArchive.statusCode).toBe(403);
    const forbiddenQuoteDelete = await app.inject({ method: "DELETE", url: `/v1/quotes/${stored.id}`, headers: { cookie: member.cookie } });
    expect(forbiddenQuoteDelete.statusCode).toBe(403);

    const memberNavigation = await app.inject({
      method: "POST",
      url: "/v1/ai/assistant",
      headers: { cookie: member.cookie },
      payload: { message: "Take me to products", tool: "AUTO" },
    });
    expect(memberNavigation.statusCode).toBe(200);
    expect(memberNavigation.json()).toMatchObject({
      assistant: {
        tool: "NAVIGATE_WORKSPACE",
        actions: [{ type: "OPEN_WORKSPACE_PAGE", payload: { page: "quotes" } }],
      },
    });

    const removeAssignedMember = await app.inject({ method: "DELETE", url: `/v1/org/users/${member.membershipId}`, headers: { cookie: owner.cookie } });
    expect(removeAssignedMember.statusCode).toBe(409);
    expect(removeAssignedMember.json()).toMatchObject({ code: "MEMBER_HAS_ACTIVE_ASSIGNMENTS" });
  });

  test("Basic seat additions are serialized and never exceed seven active users", async () => {
    const owner = await signUp("seat-cap");
    for (let index = 0; index < 5; index += 1) {
      const user = await prisma.user.create({
        data: {
          email: `existing-seat-${index}-${Date.now()}@example.com`,
          fullName: `Existing Seat ${index}`,
          passwordHash: "not-used-in-this-test",
        },
      });
      await prisma.tenantUser.create({ data: { tenantId: owner.tenant.id, userId: user.id, role: "member" } });
    }

    const before = await app.inject({ method: "GET", url: "/v1/org/users", headers: { cookie: owner.cookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      policy: {
        seatPlanCode: "starter",
        seatPlanName: "Basic",
        teamMembersLimit: 7,
        teamMembersUsed: 6,
        teamMembersRemaining: 1,
      },
    });

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attempts = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/org/users",
        headers: { cookie: owner.cookie },
        payload: { email: `seat-a-${nonce}@example.com`, fullName: "Seat A", password: "SeatPassword123!", role: "member" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/org/users",
        headers: { cookie: owner.cookie },
        payload: { email: `seat-b-${nonce}@example.com`, fullName: "Seat B", password: "SeatPassword123!", role: "member" },
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([201, 403]);
    expect(attempts.find((response) => response.statusCode === 403)?.json()).toMatchObject({
      code: "PLAN_LIMIT_EXCEEDED",
      feature: "teamMembers",
      currentPlan: "starter",
      limit: 7,
      used: 7,
    });
    await expect(prisma.tenantUser.count({ where: { tenantId: owner.tenant.id, deletedAtUtc: null } })).resolves.toBe(7);
  });
});
