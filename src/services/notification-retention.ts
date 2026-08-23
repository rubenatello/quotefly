import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenantRlsContext } from "../lib/tenant-rls";

export const DEFAULT_NOTIFICATION_READ_RETENTION_DAYS = 90;
export const DEFAULT_NOTIFICATION_UNREAD_RETENTION_DAYS = 365;
export const NOTIFICATION_RETENTION_BATCH_SIZE = 250;
export const NOTIFICATION_RETENTION_MAX_ROWS_PER_TENANT = 5_000;

const MIN_READ_RETENTION_DAYS = 30;
const MIN_UNREAD_RETENTION_DAYS = 180;

export type NotificationRetentionPolicy = Readonly<{
  readDays: number;
  unreadDays: number;
}>;

export type NotificationRetentionResult = Readonly<{
  lockSkipped: boolean;
  archivedReadCount: number;
  archivedUnreadCount: number;
  eligibleReadCount: number;
  eligibleUnreadCount: number;
  hasMore: boolean;
}>;

type RetentionCategory = "READ" | "UNREAD";

function subtractUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

export function validateNotificationRetentionPolicy(
  policy: NotificationRetentionPolicy,
): NotificationRetentionPolicy {
  if (!Number.isInteger(policy.readDays) || policy.readDays < MIN_READ_RETENTION_DAYS) {
    throw new Error(`Read notification retention must be at least ${MIN_READ_RETENTION_DAYS} days.`);
  }
  if (!Number.isInteger(policy.unreadDays) || policy.unreadDays < MIN_UNREAD_RETENTION_DAYS) {
    throw new Error(`Unread notification retention must be at least ${MIN_UNREAD_RETENTION_DAYS} days.`);
  }
  if (policy.unreadDays <= policy.readDays) {
    throw new Error("Unread notification retention must be longer than read notification retention.");
  }
  return Object.freeze({ ...policy });
}

function retentionLockKey(tenantId: string): string {
  return `${tenantId}:notification-retention`;
}

async function countEligible(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    category: RetentionCategory;
    cutoffAtUtc: Date;
    limit: number;
  }>,
): Promise<{ lockSkipped: boolean; count: number; hasMore: boolean }> {
  return withTenantRlsContext(prisma, params.tenantId, async (transaction) => {
    const locks = await transaction.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${retentionLockKey(params.tenantId)}, 0)
      ) AS "acquired"
    `);
    // A skipped lock means this bounded view is incomplete. Treat it as work
    // remaining so a scheduler never records a contested probe as "clean".
    if (!locks[0]?.acquired) return { lockSkipped: true, count: 0, hasMore: true };

    const rows = params.category === "READ"
      ? await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "count"
          FROM (
            SELECT 1
            FROM "NotificationOutbox"
            WHERE "tenantId" = ${params.tenantId}
              AND "archivedAtUtc" IS NULL
              AND "readAtUtc" IS NOT NULL
              AND "readAtUtc" <= ${params.cutoffAtUtc}
            ORDER BY "readAtUtc" ASC, "id" ASC
            LIMIT ${params.limit + 1}
          ) eligible
        `)
      : await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "count"
          FROM (
            SELECT 1
            FROM "NotificationOutbox"
            WHERE "tenantId" = ${params.tenantId}
              AND "archivedAtUtc" IS NULL
              AND "readAtUtc" IS NULL
              AND "createdAt" <= ${params.cutoffAtUtc}
            ORDER BY "createdAt" ASC, "id" ASC
            LIMIT ${params.limit + 1}
          ) eligible
        `);
    const boundedCount = Number(rows[0]?.count ?? 0);
    return {
      lockSkipped: false,
      count: Math.min(boundedCount, params.limit),
      hasMore: boundedCount > params.limit,
    };
  });
}

async function archiveBatch(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    category: RetentionCategory;
    cutoffAtUtc: Date;
    limit: number;
  }>,
): Promise<{ lockSkipped: boolean; count: number }> {
  return withTenantRlsContext(prisma, params.tenantId, async (transaction) => {
    const locks = await transaction.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${retentionLockKey(params.tenantId)}, 0)
      ) AS "acquired"
    `);
    if (!locks[0]?.acquired) return { lockSkipped: true, count: 0 };

    const result = params.category === "READ"
      ? await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          WITH candidates AS (
            SELECT "id"
            FROM "NotificationOutbox"
            WHERE "tenantId" = ${params.tenantId}
              AND "archivedAtUtc" IS NULL
              AND "readAtUtc" IS NOT NULL
              AND "readAtUtc" <= ${params.cutoffAtUtc}
            ORDER BY "readAtUtc" ASC, "id" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${params.limit}
          ), archived AS (
            UPDATE "NotificationOutbox" notification
            SET "archivedAtUtc" = clock_timestamp(),
                "updatedAt" = clock_timestamp(),
                "version" = notification."version" + 1
            FROM candidates
            WHERE notification."id" = candidates."id"
              AND notification."tenantId" = ${params.tenantId}
              AND notification."archivedAtUtc" IS NULL
            RETURNING notification."id"
          )
          SELECT COUNT(*)::bigint AS "count" FROM archived
        `)
      : await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          WITH candidates AS (
            SELECT "id"
            FROM "NotificationOutbox"
            WHERE "tenantId" = ${params.tenantId}
              AND "archivedAtUtc" IS NULL
              AND "readAtUtc" IS NULL
              AND "createdAt" <= ${params.cutoffAtUtc}
            ORDER BY "createdAt" ASC, "id" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${params.limit}
          ), archived AS (
            UPDATE "NotificationOutbox" notification
            SET "archivedAtUtc" = clock_timestamp(),
                "updatedAt" = clock_timestamp(),
                "version" = notification."version" + 1
            FROM candidates
            WHERE notification."id" = candidates."id"
              AND notification."tenantId" = ${params.tenantId}
              AND notification."archivedAtUtc" IS NULL
            RETURNING notification."id"
          )
          SELECT COUNT(*)::bigint AS "count" FROM archived
        `);
    return { lockSkipped: false, count: Number(result[0]?.count ?? 0) };
  });
}

export async function runNotificationRetentionForTenant(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    now: Date;
    apply: boolean;
    policy?: NotificationRetentionPolicy;
    maxRows?: number;
  }>,
): Promise<NotificationRetentionResult> {
  const policy = validateNotificationRetentionPolicy(params.policy ?? {
    readDays: DEFAULT_NOTIFICATION_READ_RETENTION_DAYS,
    unreadDays: DEFAULT_NOTIFICATION_UNREAD_RETENTION_DAYS,
  });
  const maxRows = Math.max(1, Math.min(
    Math.trunc(params.maxRows ?? NOTIFICATION_RETENTION_MAX_ROWS_PER_TENANT),
    NOTIFICATION_RETENTION_MAX_ROWS_PER_TENANT,
  ));
  const readCutoffAtUtc = subtractUtcDays(params.now, policy.readDays);
  const unreadCutoffAtUtc = subtractUtcDays(params.now, policy.unreadDays);

  if (!params.apply) {
    const read = await countEligible(prisma, {
      tenantId: params.tenantId,
      category: "READ",
      cutoffAtUtc: readCutoffAtUtc,
      limit: maxRows,
    });
    if (read.lockSkipped) {
      return {
        lockSkipped: true,
        archivedReadCount: 0,
        archivedUnreadCount: 0,
        eligibleReadCount: 0,
        eligibleUnreadCount: 0,
        hasMore: true,
      };
    }
    const unreadLimit = Math.max(0, maxRows - read.count);
    const unreadProbeLimit = Math.max(1, unreadLimit);
    const unread = await countEligible(prisma, {
      tenantId: params.tenantId,
      category: "UNREAD",
      cutoffAtUtc: unreadCutoffAtUtc,
      limit: unreadProbeLimit,
    });
    return {
      lockSkipped: unread.lockSkipped,
      archivedReadCount: 0,
      archivedUnreadCount: 0,
      eligibleReadCount: read.count,
      eligibleUnreadCount: unreadLimit > 0 ? unread.count : 0,
      hasMore: read.hasMore || unread.hasMore || unread.lockSkipped || (unreadLimit === 0 && unread.count > 0),
    };
  }

  let archivedReadCount = 0;
  let archivedUnreadCount = 0;
  let remaining = maxRows;
  for (const category of ["READ", "UNREAD"] as const) {
    const cutoffAtUtc = category === "READ" ? readCutoffAtUtc : unreadCutoffAtUtc;
    while (remaining > 0) {
      const batch = await archiveBatch(prisma, {
        tenantId: params.tenantId,
        category,
        cutoffAtUtc,
        limit: Math.min(NOTIFICATION_RETENTION_BATCH_SIZE, remaining),
      });
      if (batch.lockSkipped) {
        return {
          lockSkipped: true,
          archivedReadCount,
          archivedUnreadCount,
          eligibleReadCount: 0,
          eligibleUnreadCount: 0,
          hasMore: true,
        };
      }
      if (category === "READ") archivedReadCount += batch.count;
      else archivedUnreadCount += batch.count;
      remaining -= batch.count;
      if (batch.count < Math.min(NOTIFICATION_RETENTION_BATCH_SIZE, remaining + batch.count)) break;
    }
  }

  const probe = remaining === 0
    ? await countEligible(prisma, {
        tenantId: params.tenantId,
        category: "READ",
        cutoffAtUtc: readCutoffAtUtc,
        limit: 1,
      })
    : { lockSkipped: false, count: 0, hasMore: false };
  const unreadProbe = remaining === 0 && probe.count === 0
    ? await countEligible(prisma, {
        tenantId: params.tenantId,
        category: "UNREAD",
        cutoffAtUtc: unreadCutoffAtUtc,
        limit: 1,
      })
    : { lockSkipped: false, count: 0, hasMore: false };

  return {
    lockSkipped: probe.lockSkipped || unreadProbe.lockSkipped,
    archivedReadCount,
    archivedUnreadCount,
    eligibleReadCount: 0,
    eligibleUnreadCount: 0,
    hasMore: probe.lockSkipped
      || unreadProbe.lockSkipped
      || probe.count > 0
      || probe.hasMore
      || unreadProbe.count > 0
      || unreadProbe.hasMore,
  };
}
