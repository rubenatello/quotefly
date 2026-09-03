import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  runQuickBooksRetentionForTenant,
  runQuickBooksUnknownRealmQuarantineRetention,
} from "../../src/services/quickbooks-retention";
import { persistQuickBooksWebhookNotifications } from "../../src/services/quickbooks-webhook-inbox";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const connectionIdsByTenant = new Map<string, string>();

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
}

function runtimeDatabaseUrl(password: string) {
  const base = new URL(process.env.DATABASE_URL!);
  base.username = "quotefly_runtime";
  base.password = password;
  base.searchParams.set("connection_limit", "2");
  return base.toString();
}

async function createTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.tenant.create({
    data: { name: `${label} Services`, slug: `${label.toLowerCase()}-${stamp}` },
  });
}

async function createOAuthState(params: {
  tenantId: string;
  label: string;
  expiresAtUtc: Date;
  consumedAtUtc?: Date | null;
}) {
  const userId = `user-${params.label}`;
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      email: `${userId}@retention.test`,
      fullName: `Retention ${params.label}`,
      passwordHash: "not-used-by-retention-tests",
    },
  });
  await prisma.tenantUser.create({
    data: {
      tenantId: params.tenantId,
      userId,
      role: "owner",
    },
  });
  return prisma.quickBooksOAuthState.create({
    data: {
      tenantId: params.tenantId,
      userId,
      stateHash: `${params.label}-${Math.random().toString(36).slice(2)}`.padEnd(64, "0").slice(0, 64),
      expiresAtUtc: params.expiresAtUtc,
      consumedAtUtc: params.consumedAtUtc ?? null,
    },
  });
}

async function createWebhookEvent(params: {
  tenantId?: string | null;
  label: string;
  realmId?: string;
  status: "RECEIVED" | "PROCESSED" | "DEAD";
  receivedAtUtc?: Date;
  processedAtUtc?: Date | null;
  deadAtUtc?: Date | null;
  lastError?: string | null;
  payload?: Record<string, boolean>;
}) {
  let quickBooksConnectionId: string | null = null;
  if (params.tenantId) {
    quickBooksConnectionId = connectionIdsByTenant.get(params.tenantId) ?? null;
    if (!quickBooksConnectionId) {
      const connection = await prisma.quickBooksConnection.create({
        data: {
          tenantId: params.tenantId,
          realmId: `retention-connection-${params.tenantId}`,
          environment: "sandbox",
          status: "CONNECTED",
        },
      });
      quickBooksConnectionId = connection.id;
      connectionIdsByTenant.set(params.tenantId, connection.id);
    }
  }
  return prisma.quickBooksWebhookEvent.create({
    data: {
      tenantId: params.tenantId ?? null,
      quickBooksConnectionId,
      webhookEventId: `event-${params.label}-${Math.random().toString(36).slice(2)}`,
      realmId: params.realmId ?? `realm-${params.label}`,
      eventType: "Invoice",
      entityId: `invoice-${params.label}`,
      operation: "Update",
      payload: params.payload ?? { fixture: true },
      status: params.status,
      receivedAtUtc: params.receivedAtUtc ?? NOW,
      processedAtUtc: params.processedAtUtc ?? null,
      deadAtUtc: params.deadAtUtc ?? null,
      lastError: params.lastError ?? null,
    },
  });
}

describe("QuickBooks security-record retention", () => {
  beforeEach(async () => {
    connectionIdsByTenant.clear();
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.quickBooksOAuthState.deleteMany();
    await prisma.tenant.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("quarantine retention role is managed-PostgreSQL safe and has no inherited privilege path", async () => {
    const rows = await prisma.$queryRaw<Array<{
      canLogin: boolean;
      superuser: boolean;
      bypassRls: boolean;
      createDatabase: boolean;
      createRole: boolean;
      inherits: boolean;
      replication: boolean;
      memberships: bigint;
    }>>`
      SELECT
        role.rolcanlogin AS "canLogin",
        role.rolsuper AS "superuser",
        role.rolbypassrls AS "bypassRls",
        role.rolcreatedb AS "createDatabase",
        role.rolcreaterole AS "createRole",
        role.rolinherit AS "inherits",
        role.rolreplication AS "replication",
        COUNT(membership.roleid)::bigint AS "memberships"
      FROM pg_roles role
      LEFT JOIN pg_auth_members membership ON membership.member = role.oid
      WHERE role.rolname = 'quotefly_quarantine_retention'
      GROUP BY role.rolcanlogin, role.rolsuper, role.rolbypassrls,
        role.rolcreatedb, role.rolcreaterole, role.rolinherit, role.rolreplication
    `;
    expect(rows).toEqual([{
      canLogin: false,
      superuser: false,
      bypassRls: false,
      createDatabase: false,
      createRole: false,
      inherits: false,
      replication: false,
      memberships: 0n,
    }]);

    const incomingMemberships = await prisma.$queryRaw<Array<{
      isMigrationOwner: boolean;
      admin: boolean;
      canSet: boolean;
      inherits: boolean;
    }>>`
      SELECT
        member_role.rolname = current_user AS "isMigrationOwner",
        membership.admin_option AS "admin",
        membership.set_option AS "canSet",
        membership.inherit_option AS "inherits"
      FROM pg_auth_members membership
      INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = 'quotefly_quarantine_retention'
    `;
    expect(incomingMemberships).toEqual([{
      isMigrationOwner: true,
      admin: true,
      canSet: false,
      inherits: false,
    }]);

    for (const migrationPath of [
      "../../prisma/migrations/20260827163000_add_quickbooks_global_quarantine_retention/migration.sql",
      "../../prisma/migrations/20260827163500_avoid_quarantine_retention_update_grant/migration.sql",
      "../../prisma/migrations/20260828123000_quarantine_unsupported_quickbooks_webhooks/migration.sql",
      "../../prisma/migrations/20260831194500_harden_quickbooks_retention_role_portability/migration.sql",
    ]) {
      const migrationSql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
      expect(migrationSql).not.toMatch(/ALTER\s+ROLE\s+quotefly_quarantine_retention[^;]*(?:NO)?SUPERUSER/i);
      expect(migrationSql).not.toMatch(/ALTER\s+ROLE\s+quotefly_quarantine_retention[^;]*(?:NO)?BYPASSRLS/i);
      expect(migrationSql).not.toMatch(/ALTER\s+ROLE\s+quotefly_quarantine_retention/i);
      expect(migrationSql).not.toMatch(/REVOKE\s+quotefly_quarantine_retention\s+FROM\s+CURRENT_USER/i);
    }
  });

  test("deletes only terminal records beyond policy, remains tenant-scoped, and honors the row cap", async () => {
    const first = await createTenant("QuickBooks Retention First");
    const second = await createTenant("QuickBooks Retention Second");
    const eligibleExpired = await createOAuthState({
      tenantId: first.id, label: "expired", expiresAtUtc: daysBefore(8),
    });
    const eligibleConsumed = await createOAuthState({
      tenantId: first.id, label: "consumed", expiresAtUtc: daysBefore(1), consumedAtUtc: daysBefore(8),
    });
    const currentExpired = await createOAuthState({
      tenantId: first.id, label: "current-expired", expiresAtUtc: daysBefore(6),
    });
    const otherTenantExpired = await createOAuthState({
      tenantId: second.id, label: "other-expired", expiresAtUtc: daysBefore(8),
    });
    const eligibleProcessed = await createWebhookEvent({
      tenantId: first.id, label: "processed-old", status: "PROCESSED", processedAtUtc: daysBefore(31),
    });
    const eligibleDead = await createWebhookEvent({
      tenantId: first.id, label: "dead-old", status: "DEAD", deadAtUtc: daysBefore(91),
    });
    const currentProcessed = await createWebhookEvent({
      tenantId: first.id, label: "processed-current", status: "PROCESSED", processedAtUtc: daysBefore(29),
    });
    const currentDead = await createWebhookEvent({
      tenantId: first.id, label: "dead-current", status: "DEAD", deadAtUtc: daysBefore(89),
    });
    const unresolved = await createWebhookEvent({
      tenantId: first.id, label: "received-old", status: "RECEIVED", receivedAtUtc: daysBefore(400),
    });

    const bounded = await runQuickBooksRetentionForTenant(prisma, {
      tenantId: first.id,
      now: NOW,
      maxRows: 3,
    });
    expect(bounded).toEqual({
      lockSkipped: false,
      oauthStatesDeleted: 2,
      processedWebhookEventsDeleted: 1,
      deadWebhookEventsDeleted: 0,
      hasMore: true,
    });
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: eligibleExpired.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: eligibleConsumed.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: eligibleProcessed.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: eligibleDead.id } })).resolves.not.toBeNull();

    const completed = await runQuickBooksRetentionForTenant(prisma, {
      tenantId: first.id,
      now: NOW,
      maxRows: 100,
    });
    expect(completed).toEqual({
      lockSkipped: false,
      oauthStatesDeleted: 0,
      processedWebhookEventsDeleted: 0,
      deadWebhookEventsDeleted: 1,
      hasMore: false,
    });
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: eligibleDead.id } })).resolves.toBeNull();

    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: currentExpired.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: otherTenantExpired.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: currentProcessed.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: currentDead.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: unresolved.id } })).resolves.not.toBeNull();
  });

  test("enforces the OAuth actor tenant boundary and cascades only the matching actor state", async () => {
    const first = await createTenant("QuickBooks Actor First");
    const second = await createTenant("QuickBooks Actor Second");
    const firstState = await createOAuthState({
      tenantId: first.id,
      label: "actor-first",
      expiresAtUtc: daysBefore(-1),
    });
    const secondState = await createOAuthState({
      tenantId: second.id,
      label: "actor-second",
      expiresAtUtc: daysBefore(-1),
    });

    await expect(prisma.quickBooksOAuthState.create({
      data: {
        tenantId: first.id,
        userId: secondState.userId,
        stateHash: `cross-actor-${Math.random().toString(36).slice(2)}`.padEnd(64, "0").slice(0, 64),
        expiresAtUtc: daysBefore(-1),
      },
    })).rejects.toMatchObject({ code: "P2003" });

    await prisma.tenantUser.delete({
      where: {
        tenantId_userId: {
          tenantId: first.id,
          userId: firstState.userId,
        },
      },
    });

    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: firstState.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: secondState.id } })).resolves.not.toBeNull();
  });

  test("cascades only tenant-bound webhook data while preserving unknown-realm quarantine", async () => {
    const first = await createTenant("QuickBooks Webhook Cascade First");
    const second = await createTenant("QuickBooks Webhook Cascade Second");
    const firstEvent = await createWebhookEvent({
      tenantId: first.id,
      label: "cascade-first",
      status: "PROCESSED",
      processedAtUtc: NOW,
    });
    const secondEvent = await createWebhookEvent({
      tenantId: second.id,
      label: "cascade-second",
      status: "PROCESSED",
      processedAtUtc: NOW,
    });
    const unboundEvent = await createWebhookEvent({
      label: "cascade-unbound",
      status: "RECEIVED",
      lastError: "QUICKBOOKS_REALM_UNBOUND",
    });
    const firstConnectionId = connectionIdsByTenant.get(first.id)!;
    const secondConnectionId = connectionIdsByTenant.get(second.id)!;

    await prisma.tenant.delete({ where: { id: first.id } });

    await expect(prisma.quickBooksConnection.findUnique({ where: { id: firstConnectionId } }))
      .resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: firstEvent.id } }))
      .resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: secondEvent.id } }))
      .resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: unboundEvent.id } }))
      .resolves.not.toBeNull();

    await prisma.quickBooksConnection.delete({ where: { id: secondConnectionId } });

    await expect(prisma.tenant.findUnique({ where: { id: second.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: secondEvent.id } }))
      .resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: unboundEvent.id } }))
      .resolves.not.toBeNull();
  });

  test("runtime-role cleanup can delete only its current tenant terminal records", async () => {
    const first = await createTenant("QuickBooks Runtime First");
    const second = await createTenant("QuickBooks Runtime Second");
    const firstState = await createOAuthState({ tenantId: first.id, label: "runtime-first", expiresAtUtc: daysBefore(8) });
    const secondState = await createOAuthState({ tenantId: second.id, label: "runtime-second", expiresAtUtc: daysBefore(8) });
    const password = `quickbooks_retention_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl(password) } } });
    try {
      await runtimePrisma.$connect();
      const visibleBeforeCleanup = await runtimePrisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${first.id}, true)`;
        return transaction.quickBooksOAuthState.count();
      });
      expect(visibleBeforeCleanup).toBe(1);
      await expect(runtimePrisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${first.id}, true)`;
        return transaction.quickBooksOAuthState.create({
          data: {
            tenantId: second.id,
            userId: secondState.userId,
            stateHash: `runtime-cross-${Math.random().toString(36).slice(2)}`.padEnd(64, "0").slice(0, 64),
            expiresAtUtc: daysBefore(-1),
          },
        });
      })).rejects.toThrow();
      const result = await runQuickBooksRetentionForTenant(runtimePrisma, { tenantId: first.id, now: NOW });
      expect(result).toMatchObject({ oauthStatesDeleted: 1, lockSkipped: false, hasMore: false });
      await expect(runtimePrisma.quickBooksOAuthState.count()).resolves.toBe(0);
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: firstState.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksOAuthState.findUnique({ where: { id: secondState.id } })).resolves.not.toBeNull();
  });

  test("scheduled unknown-realm retention drains bounded cross-realm pages without exposing quarantine", async () => {
    const expiredAtUtc = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    const currentAtUtc = new Date(Date.now() - 6 * 24 * 60 * 60 * 1_000);
    const expiredIds = Array.from({ length: 102 }, (_, index) => `global-quarantine-${Date.now()}-${index}`);
    await prisma.quickBooksWebhookEvent.createMany({
      data: expiredIds.map((id, index) => ({
        id,
        webhookEventId: `global-event-${id}`,
        realmId: `global-realm-${index % 3}`,
        eventType: "Invoice",
        entityId: `global-invoice-${index}`,
        operation: "Update",
        payload: { quarantined: true },
        status: "RECEIVED",
        receivedAtUtc: expiredAtUtc,
        lastError: "QUICKBOOKS_REALM_UNBOUND",
      })),
    });
    const current = await createWebhookEvent({
      label: "global-quarantine-current",
      realmId: "global-current-realm",
      status: "RECEIVED",
      receivedAtUtc: currentAtUtc,
      lastError: "QUICKBOOKS_REALM_UNBOUND",
      payload: { quarantined: true },
    });
    const nonQuarantine = await createWebhookEvent({
      label: "global-quarantine-other-failure",
      realmId: "global-other-failure-realm",
      status: "RECEIVED",
      receivedAtUtc: expiredAtUtc,
      lastError: "OTHER_FAILURE",
      payload: { quarantined: true },
    });
    const tenant = await createTenant("QuickBooks Adopted Quarantine");
    const adopted = await createWebhookEvent({
      tenantId: tenant.id,
      label: "global-quarantine-adopted",
      realmId: "global-adopted-realm",
      status: "RECEIVED",
      receivedAtUtc: expiredAtUtc,
      lastError: "QUICKBOOKS_REALM_UNBOUND",
      payload: { quarantined: true },
    });

    const password = `quickbooks_global_quarantine_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl(password) } } });
    try {
      await runtimePrisma.$connect();
      await expect(runtimePrisma.quickBooksWebhookEvent.count()).resolves.toBe(0);
      await expect(runQuickBooksUnknownRealmQuarantineRetention(runtimePrisma)).resolves.toEqual({
        deletedCount: 100,
        hasMore: true,
      });
      await expect(runQuickBooksUnknownRealmQuarantineRetention(runtimePrisma)).resolves.toEqual({
        deletedCount: 2,
        hasMore: false,
      });
      await expect(runtimePrisma.quickBooksWebhookEvent.count()).resolves.toBe(0);
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }

    await expect(prisma.quickBooksWebhookEvent.count({ where: { id: { in: expiredIds } } })).resolves.toBe(0);
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: current.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: nonQuarantine.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: adopted.id } })).resolves.not.toBeNull();
  });

  test("runtime-role unknown-realm ingress batches, deduplicates, and deletes old quarantine only for its exact realm", async () => {
    // Ingress cleanup intentionally uses the wall clock. Keep these fixtures
    // relative to the same clock instead of the fixed policy-test timestamp so
    // this assertion cannot age into the seven-day retention window in CI.
    const ingressNow = new Date();
    const ingressDaysBefore = (days: number) => new Date(
      ingressNow.getTime() - days * 24 * 60 * 60 * 1_000,
    );
    const realmId = `unbound-retention-${Date.now()}`;
    const oldSameRealm = await createWebhookEvent({
      label: "quarantine-old-same",
      realmId,
      status: "RECEIVED",
      receivedAtUtc: ingressDaysBefore(8),
      lastError: "QUICKBOOKS_REALM_UNBOUND",
    });
    const currentSameRealm = await createWebhookEvent({
      label: "quarantine-current-same",
      realmId,
      status: "RECEIVED",
      receivedAtUtc: ingressDaysBefore(6),
      lastError: "QUICKBOOKS_REALM_UNBOUND",
    });
    const oldOtherRealm = await createWebhookEvent({
      label: "quarantine-old-other",
      realmId: `${realmId}-other`,
      status: "RECEIVED",
      receivedAtUtc: ingressDaysBefore(8),
      lastError: "QUICKBOOKS_REALM_UNBOUND",
    });
    const oldNonQuarantine = await createWebhookEvent({
      label: "quarantine-old-nonquarantine",
      realmId,
      status: "RECEIVED",
      receivedAtUtc: ingressDaysBefore(8),
      lastError: "OTHER_FAILURE",
    });

    const password = `quickbooks_quarantine_retention_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl(password) } } });
    try {
      await runtimePrisma.$connect();
      const notifications = Array.from({ length: 500 }, (_, index) => ({
        providerEventId: `runtime-batch-${Date.now()}-${index}`,
        providerEventSource: "quickbooks://sandbox",
        realmId,
        name: "Invoice",
        id: `fresh-invoice-${index}`,
        operation: "Update",
        lastUpdated: NOW.toISOString(),
      }));
      const startedAt = performance.now();
      const result = await persistQuickBooksWebhookNotifications(runtimePrisma, notifications);
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      expect(result).toEqual({ persisted: 500, duplicate: 0, unknownRealm: 500 });

      const replayStartedAt = performance.now();
      const replay = await persistQuickBooksWebhookNotifications(runtimePrisma, notifications);
      expect(performance.now() - replayStartedAt).toBeLessThan(3_000);
      expect(replay).toEqual({ persisted: 0, duplicate: 500, unknownRealm: 500 });
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldSameRealm.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: currentSameRealm.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldOtherRealm.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldNonQuarantine.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.count({
      where: { realmId, lastError: "QUICKBOOKS_REALM_UNBOUND" },
    })).resolves.toBe(501);
  });
});
