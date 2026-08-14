import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { createAiUsageEvent } from "../../src/lib/ai-usage";
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

async function addWorkspaceUser(
  owner: Session,
  role: "admin" | "member",
): Promise<Session> {
  const unique = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const fullName = `${role} AI User`;
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

async function createCustomerAndQuote(owner: Session) {
  const customerResponse = await app.inject({
    method: "POST",
    url: "/v1/customers",
    headers: { cookie: owner.cookie },
    payload: {
      fullName: "AI Governance Customer",
      email: "ai-governance-customer@example.com",
      phone: "555-321-7654",
      notes: "Roof leak near the rear valley.",
    },
  });
  expect(customerResponse.statusCode).toBe(201);
  const customer = (customerResponse.json() as { customer: { id: string; fullName: string; email: string; phone: string } }).customer;

  const quoteResponse = await app.inject({
    method: "POST",
    url: "/v1/quotes",
    headers: { cookie: owner.cookie },
    payload: {
      customerId: customer.id,
      serviceType: "ROOFING",
      title: "Rear valley roof repair",
      scopeText: "Repair the rear valley and replace damaged underlayment.",
      internalCostSubtotal: 625,
      customerPriceSubtotal: 1_250,
      taxAmount: 0,
    },
  });
  expect(quoteResponse.statusCode).toBe(201);
  const quote = (quoteResponse.json() as { quote: { id: string } }).quote;
  return { customer, quote };
}

describe("AI data governance", () => {
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

  test("stores redacted audit data and projects AI runs by live role and tenant", async () => {
    const owner = await signUp("ai-governance-alpha");
    const admin = await addWorkspaceUser(owner, "admin");
    const member = await addWorkspaceUser(owner, "member");
    const beta = await signUp("ai-governance-beta");
    const { customer, quote } = await createCustomerAndQuote(owner);
    const betaRecords = await createCustomerAndQuote(beta);
    const memberMembership = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: member.user.id, deletedAtUtc: null },
      select: { id: true },
    });
    await prisma.customer.update({ where: { id: customer.id }, data: { assignedTenantUserId: memberMembership.id } });
    await prisma.quote.update({ where: { id: quote.id }, data: { assignedTenantUserId: memberMembership.id } });

    await expect(
      createAiUsageEvent(prisma, {
        tenantId: owner.tenant.id,
        quoteId: betaRecords.quote.id,
        customerId: betaRecords.customer.id,
        actor: {
          actorUserId: owner.user.id,
          actorEmail: owner.user.email,
          actorName: owner.user.fullName,
        },
        eventType: "DRAFT",
        requestId: "cross-tenant-source-must-rollback",
        serviceType: "ROOFING",
        promptText: "This cross-tenant source binding must fail atomically.",
      }),
    ).rejects.toThrow();
    await expect(
      prisma.aiRetrievalAuditEvent.count({
        where: { requestId: "cross-tenant-source-must-rollback" },
      }),
    ).resolves.toBe(0);

    const ownerPrompt = [
      `Prepare a roof repair for ${customer.fullName}.`,
      `Call ${customer.phone} or email ${customer.email}.`,
      "Provider key sk_live_do_not_store_123456.",
    ].join(" ");
    const governed = await createAiUsageEvent(prisma, {
      tenantId: owner.tenant.id,
      quoteId: quote.id,
      customerId: customer.id,
      actor: {
        actorUserId: owner.user.id,
        actorEmail: owner.user.email,
        actorName: owner.user.fullName,
      },
      eventType: "DRAFT",
      requestId: "integration-owner-ai-request",
      serviceType: "ROOFING",
      promptText: ownerPrompt,
      sensitiveValues: [customer.fullName, customer.email, customer.phone],
      model: "test-model",
      telemetry: {
        requestCount: 1,
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        estimatedCostUsd: 0.0042,
      },
      trace: {
        insightSummary: "Prepared a roof repair draft.",
        insightSourceLabels: ["Customer record", "Current quote"],
        sourceTypes: ["customer", "current_quote"],
      },
    });

    await createAiUsageEvent(prisma, {
      tenantId: owner.tenant.id,
      quoteId: quote.id,
      customerId: customer.id,
      actor: {
        actorUserId: member.user.id,
        actorEmail: member.user.email,
        actorName: member.user.fullName,
      },
      eventType: "REVISE",
      requestId: "integration-member-ai-request",
      serviceType: "ROOFING",
      promptText: "Revise the roof repair with two alternates.",
      model: "test-model",
      telemetry: {
        requestCount: 1,
        promptTokens: 30,
        completionTokens: 20,
        totalTokens: 50,
        estimatedCostUsd: 0.001,
      },
      trace: { sourceTypes: ["current_quote"] },
    });

    await prisma.aiUsageEvent.create({
      data: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        customerId: customer.id,
        actorUserId: owner.user.id,
        actorEmail: owner.user.email,
        actorName: owner.user.fullName,
        eventType: "DRAFT",
        promptText: "HISTORICAL RAW PROMPT MUST NEVER LEAVE THE API",
        model: "legacy-model",
      },
    });
    await prisma.quote.update({
      where: { id: quote.id },
      data: { aiPromptText: "HISTORICAL QUOTE PROMPT MUST NEVER LEAVE THE API" },
    });

    const stored = await prisma.aiUsageEvent.findUniqueOrThrow({
      where: { id: governed.id },
      include: { retrievalAuditEvent: true },
    });
    expect(stored.promptText).toBeNull();
    expect(stored.promptRedacted).not.toContain(customer.fullName);
    expect(stored.promptRedacted).not.toContain(customer.email);
    expect(stored.promptRedacted).not.toContain(customer.phone);
    expect(stored.promptRedacted).not.toContain("sk_live_");
    expect(stored.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.retentionExpiresAtUtc).not.toBeNull();
    expect(stored.retrievalAuditEvent).toMatchObject({
      tenantId: owner.tenant.id,
      actorUserId: owner.user.id,
      purpose: "QUOTE_DRAFT",
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
      sourceTypes: ["customer", "current_quote"],
      resultCount: 2,
      policyVersion: "2026-08-11",
      status: "SUCCEEDED",
    });
    const auditJson = JSON.stringify(stored.retrievalAuditEvent);
    expect(auditJson).not.toContain(ownerPrompt);
    expect(auditJson).not.toContain(customer.email);
    expect(auditJson).not.toContain(customer.phone);
    expect(auditJson).not.toContain(customer.id);
    expect(auditJson).not.toContain(quote.id);

    const memberRunsResponse = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/ai-runs`,
      headers: { cookie: member.cookie },
    });
    expect(memberRunsResponse.statusCode).toBe(200);
    const memberBody = memberRunsResponse.json() as {
      runs: Array<Record<string, unknown>>;
      pagination: { total: number };
    };
    expect(memberBody.pagination.total).toBe(1);
    expect(memberBody.runs).toHaveLength(1);
    expect(memberBody.runs[0]?.actorUserId).toBe(member.user.id);
    expect(memberBody.runs[0]).not.toHaveProperty("promptText");
    expect(memberBody.runs[0]).not.toHaveProperty("estimatedCostUsd");

    const memberQuoteResponse = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: member.cookie },
    });
    expect(memberQuoteResponse.statusCode).toBe(200);
    const memberQuoteBody = memberQuoteResponse.json() as { quote: Record<string, unknown> };
    expect(memberQuoteBody.quote).not.toHaveProperty("aiPromptText");
    expect(memberQuoteResponse.body).not.toContain("HISTORICAL QUOTE PROMPT MUST NEVER LEAVE THE API");

    const memberQuoteListResponse = await app.inject({
      method: "GET",
      url: "/v1/quotes",
      headers: { cookie: member.cookie },
    });
    expect(memberQuoteListResponse.statusCode).toBe(200);
    expect(memberQuoteListResponse.body).not.toContain("HISTORICAL QUOTE PROMPT MUST NEVER LEAVE THE API");
    expect(
      (memberQuoteListResponse.json() as { quotes: Array<Record<string, unknown>> }).quotes.every(
        (listedQuote) => !("aiPromptText" in listedQuote),
      ),
    ).toBe(true);

    for (const privileged of [owner, admin]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/quotes/${quote.id}/ai-runs`,
        headers: { cookie: privileged.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        runs: Array<Record<string, unknown>>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(3);
      expect(body.runs.every((run) => !("promptText" in run))).toBe(true);
      expect(body.runs.some((run) => run.promptRedacted === null)).toBe(true);
      expect(body.runs.some((run) => "estimatedCostUsd" in run)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("HISTORICAL RAW PROMPT MUST NEVER LEAVE THE API");
    }

    await prisma.tenantUser.update({
      where: {
        tenantId_userId: {
          tenantId: owner.tenant.id,
          userId: admin.user.id,
        },
      },
      data: { role: "member" },
    });
    await prisma.quote.update({ where: { id: quote.id }, data: { assignedTenantUserId: memberMembership.id } });
    const demotedAdmin = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/ai-runs`,
      headers: { cookie: admin.cookie },
    });
    expect(demotedAdmin.statusCode).toBe(404);

    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/ai-runs`,
      headers: { cookie: beta.cookie },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.body).not.toContain(ownerPrompt);
  });
});
