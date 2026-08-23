import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import { listNotifications, summarizeNotifications } from "../../src/services/notification-outbox";
import { runNotificationRetentionForTenant } from "../../src/services/notification-retention";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function runtimeDatabaseUrl(password: string) {
  const base = new URL(process.env.DATABASE_URL!);
  base.username = "quotefly_runtime";
  base.password = password;
  base.searchParams.set("connection_limit", "2");
  return base.toString();
}

async function holdTenantRetentionLock(tenantId: string) {
  const release = deferred();
  const acquired = deferred();
  const holding = prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT true AS "acquired"
      FROM pg_advisory_xact_lock(hashtextextended(${`${tenantId}:notification-retention`}, 0))
    `);
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  return { release, holding };
}

async function createFixture(label: string) {
  return prisma.$transaction(async (transaction) => {
    const phoneDigits = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
    const tenant = await transaction.tenant.create({
      data: { name: `${label} Services`, slug: `${label.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    const ownerUser = await transaction.user.create({
      data: { email: `${label}-owner-${Math.random().toString(36).slice(2)}@example.com`, fullName: `${label} Owner`, passwordHash: "fixture" },
    });
    const techUser = await transaction.user.create({
      data: { email: `${label}-tech-${Math.random().toString(36).slice(2)}@example.com`, fullName: `${label} Tech`, passwordHash: "fixture" },
    });
    const owner = await transaction.tenantUser.create({
      data: { tenantId: tenant.id, userId: ownerUser.id, role: "owner" },
    });
    const tech = await transaction.tenantUser.create({
      data: { tenantId: tenant.id, userId: techUser.id, role: "member" },
    });
    const customer = await transaction.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: `${label} Customer`,
        phone: phoneDigits,
        phoneDigits,
        assignedTenantUserId: tech.id,
      },
    });
    const quote = await transaction.quote.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        assignedTenantUserId: tech.id,
        serviceType: "CONSTRUCTION",
        status: "ACCEPTED",
        title: `${label} Quote`,
        scopeText: "Fixture scope",
        internalCostSubtotal: 10,
        customerPriceSubtotal: 20,
        taxAmount: 0,
        totalAmount: 20,
      },
    });
    const job = await transaction.job.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        sourceQuoteId: quote.id,
        assignedTenantUserId: tech.id,
        jobNumber: 1,
        status: "SCHEDULED",
        title: `${label} Job`,
        scopeSnapshot: "Fixture scope",
        serviceType: "CONSTRUCTION",
        acceptedAtUtc: daysBefore(400),
        scheduledAtUtc: daysBefore(400),
      },
    });
    const appointment = await transaction.jobAppointment.create({
      data: {
        tenantId: tenant.id,
        jobId: job.id,
        assignedTenantUserId: tech.id,
        createdByTenantUserId: owner.id,
        status: "SCHEDULED",
        startsAtUtc: daysBefore(400),
        endsAtUtc: new Date(daysBefore(400).getTime() + 60 * 60 * 1_000),
        timeZone: "UTC",
      },
    });
    const event = await transaction.jobEvent.create({
      data: {
        tenantId: tenant.id,
        jobId: job.id,
        actorTenantUserId: owner.id,
        type: "APPOINTMENT_CREATED",
        requestId: `${label}-retention`,
        commandKeyHash: hash(`${label}:command`),
        commandPayloadHash: hash(`${label}:payload`),
      },
    });
    return { tenant, owner, tech, techUser, job, appointment, event };
  });
}

async function createNotification(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  params: { label: string; createdAt: Date; readAtUtc?: Date },
) {
  const delivered = Boolean(params.readAtUtc);
  return prisma.notificationOutbox.create({
    data: {
      tenantId: fixture.tenant.id,
      recipientTenantUserId: fixture.tech.id,
      actorTenantUserId: fixture.owner.id,
      jobId: fixture.job.id,
      appointmentId: fixture.appointment.id,
      sourceJobEventId: fixture.event.id,
      kind: "BOOKED",
      templateKey: "job_appointment_booked",
      sourceVersion: fixture.appointment.version,
      startsAtUtc: fixture.appointment.startsAtUtc,
      endsAtUtc: fixture.appointment.endsAtUtc,
      timeZone: fixture.appointment.timeZone,
      dedupeKeyHash: hash(`${params.label}:dedupe`),
      payloadHash: hash(`${params.label}:payload`),
      deliveryStatus: delivered ? "DELIVERED" : "AVAILABLE",
      deliveredAtUtc: params.readAtUtc,
      readAtUtc: params.readAtUtc,
      createdAt: params.createdAt,
    },
  });
}

describe("notification soft-archive retention", () => {
  beforeEach(async () => {
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("dry-runs, archives only expired read and never-read rows, and is idempotent", async () => {
    const fixture = await createFixture("RetentionPolicy");
    const expiredRead = await createNotification(fixture, { label: "expired-read", createdAt: daysBefore(200), readAtUtc: daysBefore(91) });
    const currentRead = await createNotification(fixture, { label: "current-read", createdAt: daysBefore(200), readAtUtc: daysBefore(89) });
    const expiredUnread = await createNotification(fixture, { label: "expired-unread", createdAt: daysBefore(366) });
    const currentUnread = await createNotification(fixture, { label: "current-unread", createdAt: daysBefore(364) });
    const eventCount = await prisma.jobEvent.count({ where: { tenantId: fixture.tenant.id } });

    const dryRun = await runNotificationRetentionForTenant(prisma, { tenantId: fixture.tenant.id, now: NOW, apply: false });
    expect(dryRun).toMatchObject({
      lockSkipped: false,
      eligibleReadCount: 1,
      eligibleUnreadCount: 1,
      archivedReadCount: 0,
      archivedUnreadCount: 0,
      hasMore: false,
    });
    expect(await prisma.notificationOutbox.count({ where: { archivedAtUtc: { not: null } } })).toBe(0);

    const applied = await runNotificationRetentionForTenant(prisma, { tenantId: fixture.tenant.id, now: NOW, apply: true });
    expect(applied).toMatchObject({ archivedReadCount: 1, archivedUnreadCount: 1, hasMore: false });
    const rows = await prisma.notificationOutbox.findMany({ where: { tenantId: fixture.tenant.id } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(expiredRead.id)).toMatchObject({ version: 2 });
    expect(byId.get(expiredRead.id)?.archivedAtUtc).not.toBeNull();
    expect(byId.get(expiredUnread.id)).toMatchObject({ version: 2 });
    expect(byId.get(expiredUnread.id)?.archivedAtUtc).not.toBeNull();
    expect(byId.get(currentRead.id)).toMatchObject({ version: 1, archivedAtUtc: null });
    expect(byId.get(currentUnread.id)).toMatchObject({ version: 1, archivedAtUtc: null });
    expect(await prisma.jobEvent.count({ where: { tenantId: fixture.tenant.id } })).toBe(eventCount);

    const repeated = await runNotificationRetentionForTenant(prisma, { tenantId: fixture.tenant.id, now: NOW, apply: true });
    expect(repeated).toMatchObject({ archivedReadCount: 0, archivedUnreadCount: 0, hasMore: false });

    const access: AccessContext = Object.freeze({
      tenantId: fixture.tenant.id,
      tenantUserId: fixture.tech.id,
      userId: fixture.techUser.id,
      role: "member",
      capabilities: capabilitiesForRole("member"),
      requestId: "retention-test",
    });
    const visible = await withTenantRlsContext(prisma, fixture.tenant.id, async (transaction) => ({
      list: await listNotifications(transaction, access, { unreadOnly: false, limit: 25 }),
      summary: await summarizeNotifications(transaction, access),
    }));
    expect(visible.list.items.map((item) => item.id).sort()).toEqual([currentRead.id, currentUnread.id].sort());
    expect(visible.summary).toMatchObject({ totalCount: 2, unreadCount: 1 });
  });

  test("tenant scope and duplicate workers cannot archive or increment a row twice", async () => {
    const first = await createFixture("RetentionFirst");
    const second = await createFixture("RetentionSecond");
    const firstRow = await createNotification(first, { label: "first-old", createdAt: daysBefore(400) });
    const secondRow = await createNotification(second, { label: "second-old", createdAt: daysBefore(400) });

    const concurrent = await Promise.all([
      runNotificationRetentionForTenant(prisma, { tenantId: first.tenant.id, now: NOW, apply: true }),
      runNotificationRetentionForTenant(prisma, { tenantId: first.tenant.id, now: NOW, apply: true }),
    ]);
    expect(concurrent.reduce((total, result) => total + result.archivedUnreadCount, 0)).toBe(1);
    expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: firstRow.id } })).toMatchObject({ version: 2 });
    expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: secondRow.id } })).toMatchObject({ version: 1, archivedAtUtc: null });
  });

  test("reports retry-needed work when advisory-lock contention skips an apply run", async () => {
    const fixture = await createFixture("RetentionContention");
    const row = await createNotification(fixture, { label: "contention-old", createdAt: daysBefore(400) });
    const lock = await holdTenantRetentionLock(fixture.tenant.id);
    try {
      const skipped = await runNotificationRetentionForTenant(prisma, {
        tenantId: fixture.tenant.id,
        now: NOW,
        apply: true,
      });
      expect(skipped).toMatchObject({
        lockSkipped: true,
        archivedReadCount: 0,
        archivedUnreadCount: 0,
        hasMore: true,
      });
      expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        version: 1,
        archivedAtUtc: null,
      });
    } finally {
      lock.release.resolve();
      await lock.holding;
    }
  });

  test("archives through the actual runtime role without crossing the tenant boundary", async () => {
    const first = await createFixture("RetentionRuntimeFirst");
    const second = await createFixture("RetentionRuntimeSecond");
    const firstRow = await createNotification(first, { label: "runtime-first-old", createdAt: daysBefore(400) });
    const secondRow = await createNotification(second, { label: "runtime-second-old", createdAt: daysBefore(400) });
    const runtimeRolePassword = `notification_retention_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(
      `ALTER ROLE quotefly_runtime LOGIN PASSWORD '${runtimeRolePassword.replaceAll("'", "''")}'`,
    );
    const runtimePrisma = new PrismaClient({
      datasources: { db: { url: runtimeDatabaseUrl(runtimeRolePassword) } },
    });
    try {
      await runtimePrisma.$connect();
      const result = await runNotificationRetentionForTenant(runtimePrisma, {
        tenantId: first.tenant.id,
        now: NOW,
        apply: true,
      });
      expect(result).toMatchObject({ archivedUnreadCount: 1, lockSkipped: false, hasMore: false });
      await expect(runtimePrisma.notificationOutbox.count()).resolves.toBe(0);
      await expect(withTenantRlsContext(runtimePrisma, first.tenant.id, (transaction) => (
        transaction.notificationOutbox.count()
      ))).resolves.toBe(1);
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
    expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: firstRow.id } })).toMatchObject({
      version: 2,
      archivedAtUtc: expect.any(Date),
    });
    expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: secondRow.id } })).toMatchObject({
      version: 1,
      archivedAtUtc: null,
    });
  });
});
