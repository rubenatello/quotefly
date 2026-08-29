import { PrismaClient } from "@prisma/client";
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
  return prisma.quickBooksOAuthState.create({
    data: {
      tenantId: params.tenantId,
      userId: `user-${params.label}`,
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

  test("unknown-realm ingress deletes only old quarantine for its exact realm", async () => {
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
      const result = await persistQuickBooksWebhookNotifications(runtimePrisma, [{
        realmId,
        name: "Invoice",
        id: "fresh-invoice",
        operation: "Update",
        lastUpdated: NOW.toISOString(),
      }]);
      expect(result).toEqual({ persisted: 1, duplicate: 0, unknownRealm: 1 });
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldSameRealm.id } })).resolves.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: currentSameRealm.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldOtherRealm.id } })).resolves.not.toBeNull();
    await expect(prisma.quickBooksWebhookEvent.findUnique({ where: { id: oldNonQuarantine.id } })).resolves.not.toBeNull();
  });
});
