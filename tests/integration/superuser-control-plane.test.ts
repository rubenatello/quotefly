import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string; name: string };
  user: { id: string; email: string; fullName: string };
};

let app: FastifyInstance;

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(email: string, label: string): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "SuperuserTestPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} Services ${unique}`,
      primaryTrade: "ROOFING",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

describe("superuser data-governance control plane", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.superuserAuditEvent.deleteMany();
    await prisma.dataGovernanceValidationRun.deleteMany();
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("requires an authenticated live allowlisted identity", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/v1/internal/control-plane/summary" });
    expect(anonymous.statusCode).toBe(401);

    const ordinary = await signUp("ordinary-operator-test@example.com", "Ordinary");
    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/summary",
      headers: { cookie: ordinary.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      code: "SUPERUSER_REQUIRED",
      error: "Superuser access required.",
    });

    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/summary",
      headers: { cookie: superuser.cookie },
    });
    expect(allowed.statusCode).toBe(200);

    await prisma.tenantUser.update({
      where: {
        tenantId_userId: {
          tenantId: superuser.tenant.id,
          userId: superuser.user.id,
        },
      },
      data: { deletedAtUtc: new Date() },
    });
    const deletedMembership = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/summary",
      headers: { cookie: superuser.cookie },
    });
    expect(deletedMembership.statusCode).toBe(401);
  });

  test("exposes bounded metadata and classification policy without tenant content", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    const privateOwnerEmail = "private-owner-sentinel@example.com";
    const privateCustomerEmail = "customer-secret-sentinel@example.com";
    const privateProviderId = "cus_provider_secret_sentinel";
    const other = await signUp(privateOwnerEmail, "Private Tenant");
    await prisma.tenant.update({
      where: { id: other.tenant.id },
      data: { stripeCustomerId: privateProviderId },
    });
    await prisma.customer.create({
      data: {
        tenantId: other.tenant.id,
        fullName: "Private Customer Sentinel",
        email: privateCustomerEmail,
        phone: "555-404-0101",
        phoneDigits: "5554040101",
        notes: "Never expose this tenant note from the control plane.",
      },
    });

    const tenantsResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/tenants?lifecycle=all&limit=25&search=Private",
      headers: { cookie: superuser.cookie },
    });
    expect(tenantsResponse.statusCode).toBe(200);
    const tenantBody = tenantsResponse.json() as {
      tenants: Array<Record<string, unknown>>;
      fieldsExcluded: string[];
    };
    expect(tenantBody.tenants).toHaveLength(1);
    expect(tenantBody.fieldsExcluded).toContain("customer records");
    expect(tenantsResponse.body).not.toContain(privateOwnerEmail);
    expect(tenantsResponse.body).not.toContain(privateCustomerEmail);
    expect(tenantsResponse.body).not.toContain(privateProviderId);
    expect(tenantsResponse.body).not.toContain("Never expose this tenant note");

    const catalogResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/data-catalog?classification=C4_RESTRICTED",
      headers: { cookie: superuser.cookie },
    });
    expect(catalogResponse.statusCode).toBe(200);
    const catalogBody = catalogResponse.json() as {
      validation: { status: string; schemaHash: string; baselineHash: string };
      models: Array<{ model: string; fields: Array<{ field: string; classification: string; ragStatus: string }> }>;
    };
    expect(catalogBody.validation.status).toBe("PASSED");
    expect(catalogBody.validation.schemaHash).toBe(catalogBody.validation.baselineHash);
    const restrictedFields = catalogBody.models.flatMap((model) => model.fields);
    expect(restrictedFields.length).toBeGreaterThan(0);
    expect(restrictedFields.every((field) => field.classification === "C4_RESTRICTED")).toBe(true);
    expect(restrictedFields.every((field) => field.ragStatus === "EXCLUDED")).toBe(true);

    const permissionsResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/permissions",
      headers: { cookie: superuser.cookie },
    });
    expect(permissionsResponse.statusCode).toBe(200);
    expect(permissionsResponse.json()).toMatchObject({
      operatorCapabilities: {
        viewTenantMetadata: true,
        runDataValidation: true,
        viewRawTenantRows: false,
        mutateTenantState: false,
        mutateClassificationPolicy: false,
        changeProviderCredentials: false,
      },
    });

    for (const url of [
      "/v1/internal/ai-quality/summary?days=30",
      "/v1/internal/ai-quality/tenants?days=30&limit=25",
    ]) {
      const aiQualityResponse = await app.inject({
        method: "GET",
        url,
        headers: { cookie: superuser.cookie },
      });
      expect(aiQualityResponse.statusCode).toBe(200);
    }

    const auditEvents = await prisma.superuserAuditEvent.findMany();
    expect(auditEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
      "AI_QUALITY_SUMMARY_VIEWED",
      "AI_QUALITY_TENANT_LIST_VIEWED",
    ]));
    const auditText = JSON.stringify(auditEvents);
    expect(auditText).not.toContain("Private");
    expect(auditText).not.toContain(privateOwnerEmail);
    expect(auditText).not.toContain(privateCustomerEmail);
    expect(auditText).not.toContain(privateProviderId);
  });

  test("audits superuser Kody diagnostic runs without raw prompt content", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    await prisma.customer.create({
      data: {
        tenantId: superuser.tenant.id,
        fullName: "Diagnostic Customer Sentinel",
        email: "diagnostic-customer-sentinel@example.com",
        phone: "555-616-0101",
        phoneDigits: "5556160101",
        notes: "This note must not be copied into superuser audit metadata.",
      },
    });

    const prompt = "Find customer Diagnostic Customer Sentinel and explain the match.";
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/ai-quality/assistant-test",
      headers: { cookie: superuser.cookie },
      payload: {
        message: prompt,
        tool: "SEARCH_CUSTOMERS",
        context: { currentPage: "customers", search: "Diagnostic Customer Sentinel" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      assistant: {
        auditEventId: string;
        tool: string;
        results: unknown[];
        diagnostics: {
          filters: Record<string, unknown>;
          archivePolicy: string;
          answerMode: string;
          model: string | null;
        };
      };
    };
    expect(body.assistant.tool).toBe("SEARCH_CUSTOMERS");
    expect(body.assistant.results).toHaveLength(1);
    expect(body.assistant.diagnostics.filters).toMatchObject({
      currentPage: "customers",
      searchProvided: true,
      includeArchivedEffective: false,
    });
    expect(body.assistant.diagnostics.archivePolicy).toContain("active customers only");
    expect(body.assistant.diagnostics.answerMode).toBe("DETERMINISTIC");
    expect(body.assistant.diagnostics.model).toBeNull();

    const superuserAudit = await prisma.superuserAuditEvent.findFirstOrThrow({
      where: {
        action: "AI_QUALITY_ASSISTANT_TEST_RUN",
        actorUserId: superuser.user.id,
      },
    });
    expect(superuserAudit.targetType).toBe("AiUsageEvent");
    expect(superuserAudit.targetRefHash).toMatch(/^[0-9a-f]{64}$/);
    expect(superuserAudit.metadata).toMatchObject({
      requestedTool: "SEARCH_CUSTOMERS",
      resolvedTool: "SEARCH_CUSTOMERS",
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answerMode: "DETERMINISTIC",
      answerModel: null,
      resultCount: 1,
      citationCount: 1,
      actionCount: 1,
      consumedSpendUsd: 0,
      emptyResult: false,
    });
    const superuserAuditText = JSON.stringify(superuserAudit);
    expect(superuserAuditText).not.toContain(prompt);
    expect(superuserAuditText).not.toContain("Diagnostic Customer Sentinel");
    expect(superuserAuditText).not.toContain("diagnostic-customer-sentinel@example.com");
    expect(superuserAuditText).not.toContain("This note must not");

    const aiAudit = await prisma.aiUsageEvent.findUniqueOrThrow({
      where: { id: body.assistant.auditEventId },
      include: { retrievalAuditEvent: true },
    });
    expect(aiAudit.tenantId).toBe(superuser.tenant.id);
    expect(aiAudit.retrievalAuditEvent?.tenantId).toBe(superuser.tenant.id);
  });

  test("audits rejected superuser Kody diagnostic request bodies without raw prompt content", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/ai-quality/assistant-test",
      headers: { cookie: superuser.cookie },
      payload: {
        message: "x",
        tool: "SEARCH_CUSTOMERS",
      },
    });

    expect(response.statusCode).toBe(400);
    const rejectedAudit = await prisma.superuserAuditEvent.findFirstOrThrow({
      where: {
        action: "AI_QUALITY_ASSISTANT_TEST_REJECTED",
        actorUserId: superuser.user.id,
      },
    });
    expect(rejectedAudit.targetType).toBe("AiAssistantTest");
    expect(rejectedAudit.metadata).toMatchObject({
      requestedTool: "UNKNOWN",
      includeArchivedRequested: false,
      promptRefHash: null,
      status: "REJECTED",
      reason: "INVALID_REQUEST_BODY",
    });
    expect(JSON.stringify(rejectedAudit)).not.toContain('"x"');
  });

  test("persists deterministic validation evidence and the operator audit atomically", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/control-plane/validation-runs",
      headers: { cookie: superuser.cookie },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      run: {
        id: string;
        status: string;
        schemaHash: string;
        baselineHash: string;
        modelCount: number;
        fieldCount: number;
        issueCount: number;
      };
    };
    expect(body.run).toMatchObject({
      status: "PASSED",
      modelCount: 30,
      fieldCount: 411,
      issueCount: 0,
    });
    expect(body.run.schemaHash).toBe(body.run.baselineHash);

    const [storedRun, storedAudit] = await Promise.all([
      prisma.dataGovernanceValidationRun.findUnique({ where: { id: body.run.id } }),
      prisma.superuserAuditEvent.findFirst({
        where: {
          action: "DATA_GOVERNANCE_VALIDATION_RUN",
          actorUserId: superuser.user.id,
        },
      }),
    ]);
    expect(storedRun).not.toBeNull();
    expect(storedAudit).not.toBeNull();
    expect(storedAudit?.metadata).toMatchObject({
      validationRunId: body.run.id,
      status: "PASSED",
      issueCount: 0,
    });

    const history = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/validation-runs?limit=10",
      headers: { cookie: superuser.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { runs: unknown[] }).runs).toHaveLength(1);

    const ragIndex = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/rag-index",
      headers: { cookie: superuser.cookie },
    });
    expect(ragIndex.statusCode).toBe(200);
    const ragIndexBody = ragIndex.json() as {
      totals: {
        documents: number;
        activeDocuments: number;
        chunks: number;
        activeChunks: number;
      };
      fieldsExcluded: string[];
    };
    expect(ragIndexBody.totals).toMatchObject({
      documents: 0,
      activeDocuments: 0,
      chunks: 0,
      activeChunks: 0,
    });
    expect(ragIndexBody.fieldsExcluded).toEqual(expect.arrayContaining([
      "chunk content",
      "embedding vectors",
      "source row ids",
    ]));
  });
});
