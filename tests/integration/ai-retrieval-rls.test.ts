import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setTenantRlsContext, withTenantRlsContext } from "../../src/lib/tenant-rls";
import { prisma } from "../../src/lib/prisma";

let runtimePrisma: PrismaClient;
let runtimeRolePassword = "";
let alphaTenantId = "";
let betaTenantId = "";

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
