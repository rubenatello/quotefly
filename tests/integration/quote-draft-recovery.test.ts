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
      primaryTrade: "CONSTRUCTION",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

async function addMember(owner: Session) {
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
  return {
    ...(signedIn.json() as Omit<Session, "cookie">),
    cookie: cookieFrom(signedIn),
    membershipId,
  };
}

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      version: 1,
      savedAtUtc: "2026-08-15T12:00:00.000Z",
      quote: { title: "Private recovery draft" },
      ...overrides,
    },
  };
}

describe("tenant-scoped quote draft recovery", () => {
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

  test("stores a bounded server draft for only the authenticated tenant membership", async () => {
    const alpha = await signUp("draft-alpha");
    const beta = await signUp("draft-beta");

    const saved = await app.inject({
      method: "PUT",
      url: "/v1/quote-drafts/new",
      headers: { cookie: alpha.cookie },
      payload: draftPayload(),
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json() as { draft: { savedAtUtc: string; expiresAtUtc: string } };
    expect(Date.parse(savedBody.draft.expiresAtUtc) - Date.parse(savedBody.draft.savedAtUtc)).toBe(12 * 60 * 60 * 1_000);

    const alphaRead = await app.inject({ method: "GET", url: "/v1/quote-drafts/new", headers: { cookie: alpha.cookie } });
    expect(alphaRead.statusCode).toBe(200);
    expect(alphaRead.json()).toMatchObject({ draft: { payload: { quote: { title: "Private recovery draft" } } } });

    const betaRead = await app.inject({ method: "GET", url: "/v1/quote-drafts/new", headers: { cookie: beta.cookie } });
    expect(betaRead.statusCode).toBe(200);
    expect(betaRead.json()).toEqual({ draft: null });

    const stored = await prisma.quoteDraftRecovery.findMany({ select: { tenantId: true, tenantUserId: true } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tenantId).toBe(alpha.tenant.id);
  });

  test("keeps owner and member recovery scopes isolated inside one tenant", async () => {
    const owner = await signUp("draft-membership");
    const member = await addMember(owner);
    const staleIdentityWrite = await app.inject({
      method: "PUT",
      url: "/v1/quote-drafts/new",
      headers: { cookie: member.cookie },
      payload: draftPayload({
        recoveryIdentity: { tenantId: owner.tenant.id, userId: owner.user.id },
      }),
    });
    expect(staleIdentityWrite.statusCode).toBe(403);
    await app.inject({
      method: "PUT",
      url: "/v1/quote-drafts/new",
      headers: { cookie: owner.cookie },
      payload: draftPayload({ quote: { title: "Owner draft" } }),
    });
    await app.inject({
      method: "PUT",
      url: "/v1/quote-drafts/new",
      headers: { cookie: member.cookie },
      payload: draftPayload({ quote: { title: "Member draft" } }),
    });

    const ownerRead = await app.inject({ method: "GET", url: "/v1/quote-drafts/new", headers: { cookie: owner.cookie } });
    const memberRead = await app.inject({ method: "GET", url: "/v1/quote-drafts/new", headers: { cookie: member.cookie } });
    expect(ownerRead.json()).toMatchObject({ draft: { payload: { quote: { title: "Owner draft" } } } });
    expect(memberRead.json()).toMatchObject({ draft: { payload: { quote: { title: "Member draft" } } } });
    expect(await prisma.quoteDraftRecovery.count({ where: { tenantId: owner.tenant.id } })).toBe(2);
  });

  test("enforces assigned quote visibility and rejects scope-payload mismatches", async () => {
    const owner = await signUp("draft-assignment");
    const member = await addMember(owner);
    const customer = await prisma.customer.create({
      data: { tenantId: owner.tenant.id, fullName: "Assigned Customer", phone: "5554040101", phoneDigits: "5554040101" },
    });
    const quote = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: customer.id,
        serviceType: "CONSTRUCTION",
        title: "Assigned Quote",
        scopeText: "Repair",
        internalCostSubtotal: 10,
        customerPriceSubtotal: 20,
        taxAmount: 0,
        totalAmount: 20,
      },
    });

    const hidden = await app.inject({
      method: "PUT",
      url: `/v1/quote-drafts/quote:${quote.id}`,
      headers: { cookie: member.cookie },
      payload: draftPayload({ quoteId: quote.id }),
    });
    expect(hidden.statusCode).toBe(404);

    await prisma.quote.update({ where: { id: quote.id }, data: { assignedTenantUserId: member.membershipId } });
    const mismatch = await app.inject({
      method: "PUT",
      url: `/v1/quote-drafts/quote:${quote.id}`,
      headers: { cookie: member.cookie },
      payload: draftPayload({ quoteId: "different-quote" }),
    });
    expect(mismatch.statusCode).toBe(400);

    const visible = await app.inject({
      method: "PUT",
      url: `/v1/quote-drafts/quote:${quote.id}`,
      headers: { cookie: member.cookie },
      payload: draftPayload({ quoteId: quote.id }),
    });
    expect(visible.statusCode).toBe(200);
  });

  test("deletes expired drafts and supports explicit discard", async () => {
    const owner = await signUp("draft-expiry");
    await app.inject({
      method: "PUT",
      url: "/v1/quote-drafts/new",
      headers: { cookie: owner.cookie },
      payload: draftPayload(),
    });
    await prisma.quoteDraftRecovery.updateMany({
      where: { tenantId: owner.tenant.id },
      data: { expiresAtUtc: new Date(Date.now() - 1_000) },
    });

    const expired = await app.inject({ method: "GET", url: "/v1/quote-drafts/new", headers: { cookie: owner.cookie } });
    expect(expired.json()).toEqual({ draft: null });
    expect(await prisma.quoteDraftRecovery.count({ where: { tenantId: owner.tenant.id } })).toBe(0);

    await app.inject({ method: "PUT", url: "/v1/quote-drafts/new", headers: { cookie: owner.cookie }, payload: draftPayload() });
    const discarded = await app.inject({ method: "DELETE", url: "/v1/quote-drafts/new", headers: { cookie: owner.cookie } });
    expect(discarded.statusCode).toBe(204);
    expect(await prisma.quoteDraftRecovery.count({ where: { tenantId: owner.tenant.id } })).toBe(0);
  });
});
