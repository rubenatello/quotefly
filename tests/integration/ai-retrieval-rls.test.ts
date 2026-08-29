import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setTenantRlsContext, withTenantRlsContext } from "../../src/lib/tenant-rls";
import { prisma } from "../../src/lib/prisma";
import { capabilitiesForRole } from "../../src/lib/access-policy";
import { runAiAssistant } from "../../src/lib/ai-assistant";

let runtimePrisma: PrismaClient;
let runtimeRolePassword = "";
let alphaTenantId = "";
let betaTenantId = "";
let alphaUserId = "";
let betaUserId = "";
let alphaTenantUserId = "";
let alphaJobId = "";
let betaJobId = "";
let alphaInvoiceId = "";
let betaInvoiceId = "";
let alphaFollowUpQuoteId = "";
let betaFollowUpQuoteId = "";

function runtimeDatabaseUrl() {
  const base = new URL(process.env.DATABASE_URL!);
  base.username = "quotefly_runtime";
  base.password = runtimeRolePassword;
  base.searchParams.set("connection_limit", "2");
  return base.toString();
}

describe("AI retrieval PostgreSQL RLS", () => {
  beforeAll(async () => {
    runtimeRolePassword = `rls_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${runtimeRolePassword.replaceAll("'", "''")}'`);

    const [alpha, beta] = await Promise.all([
      prisma.tenant.create({ data: { name: `RLS Alpha ${Date.now()}`, slug: `rls-alpha-${Date.now()}` } }),
      prisma.tenant.create({ data: { name: `RLS Beta ${Date.now()}`, slug: `rls-beta-${Date.now()}` } }),
    ]);
    alphaTenantId = alpha.id;
    betaTenantId = beta.id;

    const fixtureStamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [alphaUser, betaUser] = await Promise.all([
      prisma.user.create({
        data: {
          email: `rls-alpha-${fixtureStamp}@example.test`,
          fullName: "RLS Alpha Owner",
          passwordHash: "runtime-role-test-password-hash",
        },
      }),
      prisma.user.create({
        data: {
          email: `rls-beta-${fixtureStamp}@example.test`,
          fullName: "RLS Beta Owner",
          passwordHash: "runtime-role-test-password-hash",
        },
      }),
    ]);
    alphaUserId = alphaUser.id;
    betaUserId = betaUser.id;

    const [alphaMembership, betaMembership] = await Promise.all([
      prisma.tenantUser.create({ data: { tenantId: alpha.id, userId: alphaUser.id, role: "owner" } }),
      prisma.tenantUser.create({ data: { tenantId: beta.id, userId: betaUser.id, role: "owner" } }),
    ]);
    alphaTenantUserId = alphaMembership.id;

    const [alphaCustomer, betaCustomer] = await Promise.all([
      prisma.customer.create({ data: { tenantId: alpha.id, fullName: "Alpha Runtime Customer", phone: "+16195550101", phoneDigits: "6195550101", assignedTenantUserId: alphaMembership.id } }),
      prisma.customer.create({ data: { tenantId: beta.id, fullName: "Beta Runtime Customer", phone: "+16195550102", phoneDigits: "6195550102", assignedTenantUserId: betaMembership.id } }),
    ]);
    const [alphaQuote, betaQuote] = await Promise.all([
      prisma.quote.create({
        data: {
          tenantId: alpha.id,
          customerId: alphaCustomer.id,
          assignedTenantUserId: alphaMembership.id,
          serviceType: "PLUMBING",
          title: "Alpha Runtime Repair",
          scopeText: "Alpha-only runtime fixture",
          internalCostSubtotal: 10,
          customerPriceSubtotal: 20,
          taxAmount: 0,
          totalAmount: 20,
        },
      }),
      prisma.quote.create({
        data: {
          tenantId: beta.id,
          customerId: betaCustomer.id,
          assignedTenantUserId: betaMembership.id,
          serviceType: "HVAC",
          title: "Beta Runtime Repair",
          scopeText: "Beta-only runtime fixture",
          internalCostSubtotal: 15,
          customerPriceSubtotal: 30,
          taxAmount: 0,
          totalAmount: 30,
        },
      }),
    ]);
    const sentAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1_000);
    const [alphaFollowUpQuote, betaFollowUpQuote] = await Promise.all([
      prisma.quote.create({
        data: {
          tenantId: alpha.id,
          customerId: alphaCustomer.id,
          assignedTenantUserId: alphaMembership.id,
          serviceType: "PLUMBING",
          status: "SENT_TO_CUSTOMER",
          title: "Alpha Runtime Follow Up",
          scopeText: "Alpha runtime follow-up fixture",
          internalCostSubtotal: 10,
          customerPriceSubtotal: 20,
          taxAmount: 0,
          totalAmount: 20,
          sentAt,
        },
      }),
      prisma.quote.create({
        data: {
          tenantId: beta.id,
          customerId: betaCustomer.id,
          assignedTenantUserId: betaMembership.id,
          serviceType: "HVAC",
          status: "SENT_TO_CUSTOMER",
          title: "Beta Runtime Follow Up",
          scopeText: "Beta runtime follow-up fixture",
          internalCostSubtotal: 15,
          customerPriceSubtotal: 30,
          taxAmount: 0,
          totalAmount: 30,
          sentAt,
        },
      }),
    ]);
    alphaFollowUpQuoteId = alphaFollowUpQuote.id;
    betaFollowUpQuoteId = betaFollowUpQuote.id;
    const completedAtUtc = new Date(Date.now() - 60 * 60 * 1_000);
    await Promise.all([
      prisma.activityTask.create({
        data: {
          tenantId: alpha.id,
          customerId: alphaCustomer.id,
          quoteId: alphaFollowUpQuote.id,
          assignedTenantUserId: alphaMembership.id,
          createdByTenantUserId: alphaMembership.id,
          completedByTenantUserId: alphaMembership.id,
          type: "FOLLOW_UP",
          status: "COMPLETED",
          title: "Alpha runtime call",
          notes: "Alpha-only note presence",
          dueAtUtc: completedAtUtc,
          completedAtUtc,
        },
      }),
      prisma.activityTask.create({
        data: {
          tenantId: beta.id,
          customerId: betaCustomer.id,
          quoteId: betaFollowUpQuote.id,
          assignedTenantUserId: betaMembership.id,
          createdByTenantUserId: betaMembership.id,
          completedByTenantUserId: betaMembership.id,
          type: "FOLLOW_UP",
          status: "COMPLETED",
          title: "Beta runtime call",
          notes: "Beta-only note presence",
          dueAtUtc: completedAtUtc,
          completedAtUtc,
        },
      }),
    ]);
    const acceptedAtUtc = new Date();
    const [alphaJob, betaJob] = await Promise.all([
      prisma.job.create({
        data: {
          tenantId: alpha.id,
          customerId: alphaCustomer.id,
          sourceQuoteId: alphaQuote.id,
          assignedTenantUserId: alphaMembership.id,
          jobNumber: 1,
          title: "Alpha Runtime Job",
          scopeSnapshot: alphaQuote.scopeText,
          serviceType: alphaQuote.serviceType,
          acceptedAtUtc,
        },
      }),
      prisma.job.create({
        data: {
          tenantId: beta.id,
          customerId: betaCustomer.id,
          sourceQuoteId: betaQuote.id,
          assignedTenantUserId: betaMembership.id,
          jobNumber: 1,
          title: "Beta Runtime Job",
          scopeSnapshot: betaQuote.scopeText,
          serviceType: betaQuote.serviceType,
          acceptedAtUtc,
        },
      }),
    ]);
    alphaJobId = alphaJob.id;
    betaJobId = betaJob.id;

    const [alphaInvoice, betaInvoice] = await Promise.all([
      prisma.invoice.create({
        data: {
          tenantId: alpha.id,
          customerId: alphaCustomer.id,
          jobId: alphaJob.id,
          sourceQuoteId: alphaQuote.id,
          invoiceNumber: 1,
          titleSnapshot: "Alpha Runtime Invoice",
          subtotalAmount: 20,
          taxAmount: 0,
          totalAmount: 20,
          balanceDue: 20,
        },
      }),
      prisma.invoice.create({
        data: {
          tenantId: beta.id,
          customerId: betaCustomer.id,
          jobId: betaJob.id,
          sourceQuoteId: betaQuote.id,
          invoiceNumber: 1,
          titleSnapshot: "Beta Runtime Invoice",
          subtotalAmount: 30,
          taxAmount: 0,
          totalAmount: 30,
          balanceDue: 30,
        },
      }),
    ]);
    alphaInvoiceId = alphaInvoice.id;
    betaInvoiceId = betaInvoice.id;

    await prisma.aiRetrievalDocument.createMany({
      data: [alpha, beta].map((tenant, index) => ({
        id: `rls-document-${tenant.id}`,
        tenantId: tenant.id,
        sourceType: "Customer",
        sourceId: `source-${index}`,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        contentHash: String(index + 1).repeat(64),
        citationLabel: index === 0 ? "Alpha private" : "Beta private",
        policyVersion: "2026-08-11",
      })),
    });
    await prisma.aiIndexJob.createMany({
      data: [alpha, beta].map((tenant, index) => ({
        id: `rls-index-job-${tenant.id}`,
        tenantId: tenant.id,
        sourceType: "Customer",
        sourceId: `job-source-${index}`,
        operation: "UPSERT",
      })),
    });

    runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl() } } });
    await runtimePrisma.$connect();
  });

  afterAll(async () => {
    await runtimePrisma?.$disconnect();
    if (runtimeRolePassword) await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    if (alphaTenantId || betaTenantId) {
      await prisma.tenant.deleteMany({ where: { id: { in: [alphaTenantId, betaTenantId].filter(Boolean) } } });
    }
    if (alphaUserId || betaUserId) {
      await prisma.user.deleteMany({ where: { id: { in: [alphaUserId, betaUserId].filter(Boolean) } } });
    }
    await prisma.$disconnect();
  });

  test("missing tenant context returns no protected rows and rejects writes", async () => {
    await expect(runtimePrisma.aiRetrievalDocument.count()).resolves.toBe(0);
    await expect(runtimePrisma.aiIndexJob.count()).resolves.toBe(0);
    await expect(runtimePrisma.aiRetrievalDocument.create({
      data: {
        tenantId: alphaTenantId,
        sourceType: "Customer",
        sourceId: "missing-context",
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        contentHash: "a".repeat(64),
        citationLabel: "Must fail",
        policyVersion: "2026-08-11",
      },
    })).rejects.toThrow();
    await expect(runtimePrisma.aiIndexJob.create({
      data: {
        tenantId: alphaTenantId,
        sourceType: "Customer",
        sourceId: "missing-job-context",
        operation: "UPSERT",
      },
    })).rejects.toThrow();
  });

  test("tenant context sees only that tenant and wrong-tenant writes fail", async () => {
    const labels = await withTenantRlsContext(runtimePrisma, alphaTenantId, (tx) => tx.aiRetrievalDocument.findMany({
      select: { tenantId: true, citationLabel: true },
    }));
    expect(labels).toEqual([{ tenantId: alphaTenantId, citationLabel: "Alpha private" }]);
    const jobs = await withTenantRlsContext(runtimePrisma, alphaTenantId, (tx) => tx.aiIndexJob.findMany({
      select: { tenantId: true, sourceId: true },
    }));
    expect(jobs).toEqual([{ tenantId: alphaTenantId, sourceId: "job-source-0" }]);

    await expect(withTenantRlsContext(runtimePrisma, alphaTenantId, (tx) => tx.aiRetrievalDocument.create({
      data: {
        tenantId: betaTenantId,
        sourceType: "Customer",
        sourceId: "wrong-tenant",
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        contentHash: "b".repeat(64),
        citationLabel: "Must fail",
        policyVersion: "2026-08-11",
      },
    }))).rejects.toThrow();
    await expect(withTenantRlsContext(runtimePrisma, alphaTenantId, (tx) => tx.aiIndexJob.create({
      data: {
        tenantId: betaTenantId,
        sourceType: "Customer",
        sourceId: "wrong-tenant-job",
        operation: "UPSERT",
      },
    }))).rejects.toThrow();
  });

  test("tenant context cannot switch and does not leak across pooled transactions", async () => {
    await expect(runtimePrisma.$transaction(async (tx) => {
      await setTenantRlsContext(tx, alphaTenantId);
      await setTenantRlsContext(tx, betaTenantId);
    })).rejects.toThrow("Tenant context cannot be changed");

    await expect(runtimePrisma.aiRetrievalDocument.count()).resolves.toBe(0);
    const betaCount = await withTenantRlsContext(runtimePrisma, betaTenantId, (tx) => tx.aiRetrievalDocument.count());
    expect(betaCount).toBe(1);
    await expect(runtimePrisma.aiRetrievalDocument.count()).resolves.toBe(0);
  });

  test("Kody job and invoice tools see same-tenant rows through the least-privileged runtime role only", async () => {
    const access = {
      tenantId: alphaTenantId,
      tenantUserId: alphaTenantUserId,
      userId: alphaUserId,
      role: "owner" as const,
      capabilities: capabilitiesForRole("owner"),
      requestId: `runtime-kody-${Date.now()}`,
    };
    const actor = {
      actorUserId: alphaUserId,
      actorEmail: "rls-alpha-owner@example.test",
      actorName: "RLS Alpha Owner",
    };

    const jobs = await runAiAssistant(runtimePrisma, {
      access,
      actor,
      message: "Show jobs",
      tool: "SEARCH_JOBS",
      context: { currentPage: "jobs", limit: 8 },
    });
    expect(jobs.assistant.results.map((result) => result.jobId)).toEqual([alphaJobId]);
    expect(jobs.assistant.results.map((result) => result.jobId)).not.toContain(betaJobId);
    expect(jobs.consumedCredits).toBe(0);

    const invoices = await runAiAssistant(runtimePrisma, {
      access: { ...access, requestId: `runtime-kody-invoices-${Date.now()}` },
      actor,
      message: "List invoices",
      tool: "LIST_INVOICES",
      context: { currentPage: "jobs", limit: 8 },
    });
    expect(invoices.assistant.results.map((result) => result.invoiceId)).toEqual([alphaInvoiceId]);
    expect(invoices.assistant.results.map((result) => result.invoiceId)).not.toContain(betaInvoiceId);
    expect(invoices.consumedCredits).toBe(0);

    const followUps = await runAiAssistant(runtimePrisma, {
      access: { ...access, requestId: `runtime-kody-follow-ups-${Date.now()}` },
      actor,
      message: "What quotes should I follow up on?",
      tool: "AUTO",
      context: { currentPage: "follow-up", limit: 8 },
    });
    expect(followUps.assistant.diagnostics.filters.quoteOnly).toBe(true);
    expect(followUps.assistant.results).toContainEqual(expect.objectContaining({
      quoteId: alphaFollowUpQuoteId,
      lastRecordedFollowUpType: "TASK_COMPLETED",
      hasFollowUpNotes: true,
    }));
    expect(followUps.assistant.results.map((result) => result.quoteId)).not.toContain(betaFollowUpQuoteId);
    expect(JSON.stringify(followUps.assistant.results)).not.toContain("Beta-only");
    expect(followUps.consumedCredits).toBe(0);
  });

  test("runtime role has no owner, superuser, or BYPASSRLS privilege", async () => {
    const rows = await prisma.$queryRaw<Array<{
      superuser: boolean;
      bypassRls: boolean;
      ownsTables: bigint;
      memberships: bigint;
      canCreatePublic: boolean;
    }>>(Prisma.sql`
      SELECT
        r.rolsuper AS "superuser",
        r.rolbypassrls AS "bypassRls",
        COUNT(DISTINCT c.oid)::bigint AS "ownsTables",
        COUNT(DISTINCT membership.roleid)::bigint AS "memberships",
        has_schema_privilege(r.rolname, 'public', 'CREATE') AS "canCreatePublic"
      FROM pg_roles r
      LEFT JOIN pg_class c ON c.relowner = r.oid AND c.relkind IN ('r', 'p')
      LEFT JOIN pg_auth_members membership ON membership.member = r.oid
      WHERE r.rolname = 'quotefly_runtime'
      GROUP BY r.rolname, r.rolsuper, r.rolbypassrls
    `);
    expect(rows).toEqual([{
      superuser: false,
      bypassRls: false,
      ownsTables: 0n,
      memberships: 0n,
      canCreatePublic: false,
    }]);
  });

  test("migration SQL avoids superuser-only role alteration on managed PostgreSQL", async () => {
    const { readFile } = await import("node:fs/promises");
    const migrationSql = await readFile(
      new URL("../../prisma/migrations/20260813170000_force_ai_retrieval_tenant_rls/migration.sql", import.meta.url),
      "utf8",
    );
    expect(migrationSql).not.toMatch(/ALTER\s+ROLE\s+quotefly_runtime[^;]*(?:NO)?SUPERUSER/i);
    expect(migrationSql).not.toMatch(/ALTER\s+ROLE\s+quotefly_runtime[^;]*(?:NO)?BYPASSRLS/i);
  });
});
