import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { getDataClassificationCatalog } from "../../src/lib/data-governance-catalog";
import { prisma } from "../../src/lib/prisma";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

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
    app.addHook("onRequest", async (request) => {
      if (request.method === "POST" && request.url === "/v1/internal/ai-quality/assistant-test" && !request.headers["idempotency-key"]) {
        request.headers["idempotency-key"] = `integration-superuser-${request.id}-${Date.now()}`;
      }
    });
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
    const privateCustomer = await prisma.customer.create({
      data: {
        tenantId: other.tenant.id,
        fullName: "Private Customer Sentinel",
        email: privateCustomerEmail,
        phone: "555-404-0101",
        phoneDigits: "5554040101",
        notes: "Never expose this tenant note from the control plane.",
      },
    });
    const otherMembership = await prisma.tenantUser.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: other.tenant.id, userId: other.user.id } },
      select: { id: true },
    });
    const quickBooksRealm = "realm-superuser-must-not-render";
    const quickBooksConnection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: other.tenant.id,
        realmId: quickBooksRealm,
        environment: "sandbox",
        companyName: "Private QuickBooks Company",
        status: "CONNECTED",
        scopes: ["com.intuit.quickbooks.accounting"],
        accessTokenEncrypted: "encrypted-access-superuser-sentinel",
        refreshTokenEncrypted: "encrypted-refresh-superuser-sentinel",
        accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
        setupConfirmedAtUtc: new Date(),
        setupConfirmedByTenantUserId: otherMembership.id,
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        realmBinding: { create: { realmId: quickBooksRealm, active: true } },
        cdcCursor: { create: { changedSinceUtc: new Date() } },
      },
    });
    const privateQuote = await prisma.quote.create({
      data: {
        tenantId: other.tenant.id,
        customerId: privateCustomer.id,
        serviceType: "ROOFING",
        status: "ACCEPTED",
        title: "Private QuickBooks invoice source",
        scopeText: "Private scope that must not render in the control plane.",
        internalCostSubtotal: 50,
        customerPriceSubtotal: 100,
        taxAmount: 0,
        totalAmount: 100,
      },
    });
    const privateJob = await prisma.job.create({
      data: {
        tenantId: other.tenant.id,
        customerId: privateCustomer.id,
        sourceQuoteId: privateQuote.id,
        jobNumber: 1,
        title: privateQuote.title,
        scopeSnapshot: privateQuote.scopeText,
        serviceType: privateQuote.serviceType,
        acceptedAtUtc: new Date(),
      },
    });
    const privateInvoice = await prisma.invoice.create({
      data: {
        tenantId: other.tenant.id,
        customerId: privateCustomer.id,
        jobId: privateJob.id,
        sourceQuoteId: privateQuote.id,
        invoiceNumber: 1,
        titleSnapshot: privateQuote.title,
        subtotalAmount: 100,
        taxAmount: 0,
        totalAmount: 100,
        balanceDue: 100,
      },
    });
    const privateOperationProviderId = "quickbooks-operation-provider-id-must-not-render";
    const privateOperationRequestId = "quickbooks-operation-request-id-must-not-render";
    await prisma.quickBooksInvoiceOperation.create({
      data: {
        tenantId: other.tenant.id,
        invoiceId: privateInvoice.id,
        quickBooksConnectionId: quickBooksConnection.id,
        requestedByTenantUserId: otherMembership.id,
        status: "SUCCEEDED",
        commandKeyHash: "c".repeat(64),
        payloadHash: "d".repeat(64),
        providerRealmId: quickBooksRealm,
        providerRequestId: privateOperationRequestId,
        providerInvoiceId: privateOperationProviderId,
        providerDocNumber: "QF-000001",
        processingStartedAtUtc: new Date(),
        lastAttemptAtUtc: new Date(),
        succeededAtUtc: new Date(),
      },
    });
    const operationalNow = new Date();
    await prisma.quickBooksCdcCursor.update({
      where: { quickBooksConnectionId: quickBooksConnection.id },
      data: {
        changedSinceUtc: new Date(operationalNow.getTime() - 90_000),
        nextAttemptAtUtc: new Date(operationalNow.getTime() - 30_000),
      },
    });
    await prisma.quickBooksWebhookEvent.createMany({
      data: [
        {
          tenantId: other.tenant.id,
          quickBooksConnectionId: quickBooksConnection.id,
          webhookEventId: "control-plane-outstanding",
          realmId: quickBooksRealm,
          eventType: "Invoice",
          entityId: "invoice-outstanding",
          operation: "Update",
          payload: { safe: true },
          status: "FAILED",
          nextAttemptAtUtc: new Date(operationalNow.getTime() - 10_000),
          receivedAtUtc: new Date(operationalNow.getTime() - 60_000),
        },
        {
          tenantId: other.tenant.id,
          quickBooksConnectionId: quickBooksConnection.id,
          webhookEventId: "control-plane-dead",
          realmId: quickBooksRealm,
          eventType: "Invoice",
          entityId: "invoice-dead",
          operation: "Update",
          payload: { safe: true },
          status: "DEAD",
          deadAtUtc: operationalNow,
          receivedAtUtc: new Date(operationalNow.getTime() - 120_000),
        },
      ],
    });
    await prisma.quickBooksOrphanCredentialRevocation.createMany({
      data: [
        {
          tenantId: other.tenant.id,
          dedupeKeyHash: "a".repeat(64),
          refreshTokenEncrypted: "encrypted-orphan-pending",
          status: "PENDING",
          nextAttemptAtUtc: new Date(operationalNow.getTime() - 10_000),
          createdAt: new Date(operationalNow.getTime() - 45_000),
        },
        {
          tenantId: other.tenant.id,
          dedupeKeyHash: "b".repeat(64),
          refreshTokenEncrypted: "encrypted-orphan-dead",
          status: "DEAD",
          nextAttemptAtUtc: null,
          deadAtUtc: operationalNow,
        },
      ],
    });
    const pendingRevocationTenant = await signUp(
      "quickbooks-pending-revocation@example.com",
      "Pending Revocation",
    );
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: pendingRevocationTenant.tenant.id,
        realmId: "realm-control-plane-pending-revocation",
        environment: "sandbox",
        status: "REVOCATION_PENDING",
        refreshTokenEncrypted: "encrypted-connection-pending",
        revocationPendingAtUtc: new Date(operationalNow.getTime() - 75_000),
        revocationNextAttemptAtUtc: new Date(operationalNow.getTime() - 10_000),
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
      },
    });
    const deadRevocationTenant = await signUp(
      "quickbooks-dead-revocation@example.com",
      "Dead Revocation",
    );
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: deadRevocationTenant.tenant.id,
        realmId: "realm-control-plane-dead-revocation",
        environment: "sandbox",
        status: "ERROR",
        refreshTokenEncrypted: "encrypted-connection-dead",
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_DEAD",
      },
    });

    const tenantsResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/tenants?lifecycle=all&quickBooks=confirmed&limit=25&search=Private",
      headers: { cookie: superuser.cookie },
    });
    expect(tenantsResponse.statusCode).toBe(200);
    expect(tenantsResponse.headers["cache-control"]).toBe("private, no-store");
    const tenantBody = tenantsResponse.json() as {
      tenants: Array<Record<string, unknown>>;
      fieldsExcluded: string[];
    };
    expect(tenantBody.tenants).toHaveLength(1);
    expect(tenantBody.tenants[0]).toMatchObject({
      quickBooks: {
        present: true,
        status: "CONNECTED",
        setupPhase: "CONFIRMED",
        environment: "sandbox",
        counts: { invoiceSyncs: 1 },
      },
    });
    expect(tenantBody.fieldsExcluded).toContain("customer records");
    expect(tenantsResponse.body).not.toContain(privateOwnerEmail);
    expect(tenantsResponse.body).not.toContain(privateCustomerEmail);
    expect(tenantsResponse.body).not.toContain(privateProviderId);
    expect(tenantsResponse.body).not.toContain("Never expose this tenant note");
    expect(tenantsResponse.body).not.toContain(quickBooksRealm);
    expect(tenantsResponse.body).not.toContain("Private QuickBooks Company");
    expect(tenantsResponse.body).not.toContain("encrypted-access-superuser-sentinel");
    expect(tenantsResponse.body).not.toContain("encrypted-refresh-superuser-sentinel");
    expect(tenantsResponse.body).not.toContain("com.intuit.quickbooks.accounting");
    expect(tenantsResponse.body).not.toContain(privateOperationProviderId);
    expect(tenantsResponse.body).not.toContain(privateOperationRequestId);

    const summaryResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/control-plane/summary",
      headers: { cookie: superuser.cookie },
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.headers["cache-control"]).toBe("private, no-store");
    expect(summaryResponse.json()).toMatchObject({
      totals: { quickBooksConnectedTenants: 1, quickBooksConfirmedTenants: 1, quickBooksReadyTenants: 1 },
      workers: {
        quickBooksOperations: {
          webhookOutstandingCount: 1,
          webhookDeadCount: 1,
          reconciliationRequiredCount: 0,
          cdcCursorCount: 1,
          cdcTerminalCount: 0,
          cdcOverdueCount: 1,
          connectionRevocationPendingCount: 1,
          connectionRevocationDeadCount: 1,
          orphanRevocationPendingCount: 1,
          orphanRevocationDeadCount: 1,
        },
      },
    });
    const operations = (summaryResponse.json() as {
      workers: { quickBooksOperations: Record<string, number | null> };
    }).workers.quickBooksOperations;
    expect(operations.oldestWebhookOutstandingAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(operations.maximumCdcLagMs).toBeGreaterThanOrEqual(90_000);
    expect(operations.oldestConnectionRevocationPendingAgeMs).toBeGreaterThanOrEqual(75_000);
    expect(operations.oldestOrphanRevocationPendingAgeMs).toBeGreaterThanOrEqual(45_000);
    expect(summaryResponse.body).not.toContain("encrypted-orphan-pending");
    expect(summaryResponse.body).not.toContain("encrypted-orphan-dead");
    expect(summaryResponse.body).not.toContain("encrypted-connection-pending");
    expect(summaryResponse.body).not.toContain("encrypted-connection-dead");

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
      "/v1/internal/ai-quality/feedback?days=30&limit=25",
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
      "AI_QUALITY_FEEDBACK_VIEWED",
    ]));
    const auditText = JSON.stringify(auditEvents);
    expect(auditText).not.toContain("Private");
    expect(auditText).not.toContain(privateOwnerEmail);
    expect(auditText).not.toContain(privateCustomerEmail);
    expect(auditText).not.toContain(privateProviderId);
  });

  test("keeps Kody feedback notes redacted by default and audits explicit superuser reveal", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser");
    const ordinary = await signUp("ordinary-feedback-review@example.com", "Ordinary");
    const tenant = await signUp("feedback-note-tenant@example.com", "Feedback Tenant");
    const note = "Kody searched customers when I explicitly asked to add a product.";
    const usageEvent = await prisma.aiUsageEvent.create({
      data: {
        tenantId: tenant.tenant.id,
        actorUserId: tenant.user.id,
        eventType: "BUSINESS_INSIGHT",
        purpose: "BUSINESS_INSIGHT",
        classification: "C1_BUSINESS_INTERNAL",
        model: "gpt-test",
        confidenceLevel: "medium",
      },
    });
    await prisma.aiAssistantFeedback.create({
      data: {
        tenantId: tenant.tenant.id,
        actorUserId: tenant.user.id,
        aiUsageEventId: usageEvent.id,
        rating: "DOWN",
        note,
      },
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/internal/ai-quality/feedback?includeNotes=true",
      headers: { cookie: ordinary.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const redacted = await app.inject({
      method: "GET",
      url: "/v1/internal/ai-quality/feedback?days=30&limit=25",
      headers: { cookie: superuser.cookie },
    });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json()).toMatchObject({
      notesIncluded: false,
      summary: { total: 1, down: 1, withNote: 1 },
    });
    expect(redacted.body).not.toContain(note);

    const revealed = await app.inject({
      method: "GET",
      url: "/v1/internal/ai-quality/feedback?days=30&limit=25&includeNotes=true",
      headers: { cookie: superuser.cookie },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toMatchObject({
      notesIncluded: true,
      feedback: [{ rating: "DOWN", note }],
    });

    const revealAudit = await prisma.superuserAuditEvent.findFirstOrThrow({
      where: {
        actorUserId: superuser.user.id,
        action: "AI_QUALITY_FEEDBACK_NOTES_VIEWED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(revealAudit.metadata).toMatchObject({ includeNotes: true, returnedCount: 1, noteCount: 1 });
    expect(JSON.stringify(revealAudit)).not.toContain(note);
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
    const catalog = getDataClassificationCatalog();
    const expectedModelCount = catalog.models.length;
    const expectedFieldCount = catalog.models.reduce((count, model) => count + model.fields.length, 0);
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
      modelCount: expectedModelCount,
      fieldCount: expectedFieldCount,
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
      rollout: {
        mode: string;
        configuredAllowlistSize: number;
        enabledActiveTenantCount: number;
        exposedActiveTenantCount: number;
        inlineRefreshEnabled: boolean;
        workerEnabled: boolean;
      };
      totals: {
        documents: number;
        activeDocuments: number;
        chunks: number;
        activeChunks: number;
      };
      indexingQueue: {
        scope: string;
        activeTenantCount: number;
        jobsByStatus: Record<string, number>;
        successfulJobs: number;
        embeddingCacheHitRate: number | null;
        outOfRollout: {
          activeTenantCount: number;
          jobsByStatus: Record<string, number>;
        };
      };
      fieldsExcluded: string[];
    };
    expect(ragIndexBody.totals).toMatchObject({
      documents: 0,
      activeDocuments: 0,
      chunks: 0,
      activeChunks: 0,
    });
    expect(ragIndexBody.rollout).toMatchObject({
      mode: "all",
      configuredAllowlistSize: 0,
      inlineRefreshEnabled: true,
      workerEnabled: false,
    });
    expect(ragIndexBody.rollout.enabledActiveTenantCount).toBeGreaterThan(0);
    expect(ragIndexBody.rollout.exposedActiveTenantCount).toBe(ragIndexBody.rollout.enabledActiveTenantCount);
    expect(ragIndexBody.fieldsExcluded).toEqual(expect.arrayContaining([
      "chunk content",
      "embedding vectors",
      "source row ids",
    ]));
    expect(ragIndexBody.indexingQueue.jobsByStatus.PENDING).toBeGreaterThan(0);
    expect(ragIndexBody.indexingQueue.scope).toBe("rollout_enabled_active_tenants");
    expect(ragIndexBody.indexingQueue.activeTenantCount).toBe(ragIndexBody.rollout.enabledActiveTenantCount);
    expect(ragIndexBody.indexingQueue.outOfRollout).toMatchObject({
      activeTenantCount: 0,
      jobsByStatus: {},
    });
    expect(ragIndexBody.indexingQueue.successfulJobs).toBe(0);
    expect(ragIndexBody.indexingQueue.embeddingCacheHitRate).toBeNull();
  });

  test("reports active allowlisted queue health separately from disabled and deleted tenants", async () => {
    const superuser = await signUp("superuser-integration@example.com", "RAG allowlisted");
    const outside = await signUp("rag-outside-rollout@example.com", "RAG outside");
    const deleted = await signUp("rag-deleted-rollout@example.com", "RAG deleted");
    await prisma.aiIndexJob.createMany({
      data: [superuser, outside, deleted].map((session, index) => ({
        tenantId: session.tenant.id,
        sourceType: "WorkPreset",
        sourceId: `control-plane-rollout-${index}`,
        operation: "UPSERT",
      })),
    });
    await prisma.tenant.update({
      where: { id: deleted.tenant.id },
      data: { deletedAtUtc: new Date() },
    });

    const originalMode = env.AI_RAG_ROLLOUT_MODE;
    const originalAllowlist = env.AI_RAG_TENANT_ALLOWLIST;
    env.AI_RAG_ROLLOUT_MODE = "allowlist";
    env.AI_RAG_TENANT_ALLOWLIST = superuser.tenant.id;
    try {
      const [enabledPending, outsidePending, deletedPending] = await Promise.all([
        prisma.aiIndexJob.count({ where: { tenantId: superuser.tenant.id, status: "PENDING" } }),
        prisma.aiIndexJob.count({ where: { tenantId: outside.tenant.id, status: "PENDING" } }),
        prisma.aiIndexJob.count({ where: { tenantId: deleted.tenant.id, status: "PENDING" } }),
      ]);
      expect(deletedPending).toBeGreaterThan(0);

      const response = await app.inject({
        method: "GET",
        url: "/v1/internal/control-plane/rag-index",
        headers: { cookie: superuser.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        rollout: {
          enabledActiveTenantCount: number;
          exposedActiveTenantCount: number;
        };
        indexingQueue: {
          activeTenantCount: number;
          jobsByStatus: Record<string, number>;
          oldestPendingAtUtc: string | null;
          outOfRollout: {
            activeTenantCount: number;
            jobsByStatus: Record<string, number>;
            oldestPendingAtUtc: string | null;
            expectedWhileDisabled: boolean;
          };
        };
      };
      expect(body.rollout).toMatchObject({
        enabledActiveTenantCount: 1,
        exposedActiveTenantCount: 1,
      });
      expect(body.indexingQueue).toMatchObject({
        activeTenantCount: 1,
        jobsByStatus: { PENDING: enabledPending },
        outOfRollout: {
          activeTenantCount: 1,
          jobsByStatus: { PENDING: outsidePending },
          expectedWhileDisabled: true,
        },
      });
      expect(body.indexingQueue.oldestPendingAtUtc).not.toBeNull();
      expect(body.indexingQueue.outOfRollout.oldestPendingAtUtc).not.toBeNull();
      expect(body.indexingQueue.jobsByStatus.PENDING).not.toBe(enabledPending + outsidePending + deletedPending);
    } finally {
      env.AI_RAG_ROLLOUT_MODE = originalMode;
      env.AI_RAG_TENANT_ALLOWLIST = originalAllowlist;
    }
  });
});
