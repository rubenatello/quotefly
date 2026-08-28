import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenantRlsContext } from "../lib/tenant-rls";

// OAuth states are short-lived replay credentials, not an audit store. Keep a
// small incident-investigation window after their terminal state only.
export const QUICKBOOKS_OAUTH_STATE_RETENTION_DAYS = 7;
// Processed provider envelopes are useful for short-term replay/support
// diagnosis. Dead letters need a longer operational remediation window.
export const QUICKBOOKS_PROCESSED_WEBHOOK_RETENTION_DAYS = 30;
export const QUICKBOOKS_DEAD_WEBHOOK_RETENTION_DAYS = 90;
// Unbound realms retain a minimal envelope solely to allow a later legitimate
// realm binding to adopt it. They are never scanned tenant-globally.
export const QUICKBOOKS_UNKNOWN_REALM_QUARANTINE_RETENTION_DAYS = 7;

export const QUICKBOOKS_RETENTION_MAX_ROWS_PER_TENANT = 100;
export const QUICKBOOKS_RETENTION_BATCH_SIZE = 100;

export type QuickBooksUnknownRealmRetentionResult = Readonly<{
  deletedCount: number;
  hasMore: boolean;
}>;

export type QuickBooksRetentionResult = Readonly<{
  lockSkipped: boolean;
  oauthStatesDeleted: number;
  processedWebhookEventsDeleted: number;
  deadWebhookEventsDeleted: number;
  hasMore: boolean;
}>;

function subtractUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

function retentionLockKey(tenantId: string): string {
  return `${tenantId}:quickbooks-retention`;
}

function boundedMaxRows(maxRows: number | undefined): number {
  const requested = Math.trunc(maxRows ?? QUICKBOOKS_RETENTION_MAX_ROWS_PER_TENANT);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("QuickBooks retention maxRows must be a positive integer.");
  }
  return Math.min(requested, QUICKBOOKS_RETENTION_MAX_ROWS_PER_TENANT);
}

function assertUtcNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("QuickBooks retention requires a valid UTC timestamp.");
  }
}

/**
 * Invokes the database-owned, least-privileged purge for webhook envelopes
 * that never became tenant-bound. The SECURITY DEFINER function has no
 * caller-controlled cutoff or row limit: PostgreSQL applies the reviewed
 * seven-day policy and a hard 100-row cap under a dedicated NOLOGIN role.
 */
export async function runQuickBooksUnknownRealmQuarantineRetention(
  prisma: PrismaClient,
): Promise<QuickBooksUnknownRealmRetentionResult> {
  const rows = await prisma.$queryRaw<Array<{ deletedCount: number }>>(Prisma.sql`
    SELECT public.quotefly_purge_quickbooks_unknown_realm_quarantine() AS "deletedCount"
  `);
  const deletedCount = rows[0]?.deletedCount ?? 0;
  return {
    deletedCount,
    // A full batch is a conservative continuation signal. The next hourly
    // cadence remains bounded and will drain another page without exposing a
    // cross-realm cursor to the application role.
    hasMore: deletedCount >= QUICKBOOKS_RETENTION_BATCH_SIZE,
  };
}

type RetentionCategory = "OAUTH" | "PROCESSED_WEBHOOK" | "DEAD_WEBHOOK";

async function deleteEligibleBatch(
  transaction: Prisma.TransactionClient,
  params: Readonly<{
    tenantId: string;
    category: RetentionCategory;
    cutoffAtUtc: Date;
    limit: number;
  }>,
): Promise<number> {
  if (params.category === "OAUTH") {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "QuickBooksOAuthState"
        WHERE "tenantId" = ${params.tenantId}
          AND (
            ("consumedAtUtc" IS NOT NULL AND "consumedAtUtc" <= ${params.cutoffAtUtc})
            OR ("consumedAtUtc" IS NULL AND "expiresAtUtc" <= ${params.cutoffAtUtc})
          )
        ORDER BY COALESCE("consumedAtUtc", "expiresAtUtc") ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${params.limit}
      )
      DELETE FROM "QuickBooksOAuthState" state
      USING candidates
      WHERE state."id" = candidates."id"
        AND state."tenantId" = ${params.tenantId}
      RETURNING state."id"
    `);
    return rows.length;
  }

  const column = params.category === "PROCESSED_WEBHOOK" ? "processedAtUtc" : "deadAtUtc";
  const status = params.category === "PROCESSED_WEBHOOK" ? "PROCESSED" : "DEAD";
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id"
      FROM "QuickBooksWebhookEvent"
      WHERE "tenantId" = ${params.tenantId}
        AND "status" = ${status}::"QuickBooksWebhookEventStatus"
        AND ${Prisma.raw(`"${column}"`)} <= ${params.cutoffAtUtc}
      ORDER BY ${Prisma.raw(`"${column}"`)} ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${params.limit}
    )
    DELETE FROM "QuickBooksWebhookEvent" event
    USING candidates
    WHERE event."id" = candidates."id"
      AND event."tenantId" = ${params.tenantId}
      AND event."status" = ${status}::"QuickBooksWebhookEventStatus"
    RETURNING event."id"
  `);
  return rows.length;
}

async function hasEligibleRows(
  transaction: Prisma.TransactionClient,
  params: Readonly<{
    tenantId: string;
    oauthCutoffAtUtc: Date;
    processedCutoffAtUtc: Date;
    deadCutoffAtUtc: Date;
  }>,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "QuickBooksOAuthState"
      WHERE "tenantId" = ${params.tenantId}
        AND (
          ("consumedAtUtc" IS NOT NULL AND "consumedAtUtc" <= ${params.oauthCutoffAtUtc})
          OR ("consumedAtUtc" IS NULL AND "expiresAtUtc" <= ${params.oauthCutoffAtUtc})
        )
      UNION ALL
      SELECT 1
      FROM "QuickBooksWebhookEvent"
      WHERE "tenantId" = ${params.tenantId}
        AND (
          ("status" = 'PROCESSED' AND "processedAtUtc" <= ${params.processedCutoffAtUtc})
          OR ("status" = 'DEAD' AND "deadAtUtc" <= ${params.deadCutoffAtUtc})
        )
      LIMIT 1
    ) AS "exists"
  `);
  return rows[0]?.exists ?? false;
}

/**
 * Deletes a bounded number of terminal QuickBooks security records for one
 * tenant. Every read and delete is performed in a tenant RLS transaction; it
 * intentionally does not attempt to enumerate unbound webhook quarantine.
 */
export async function runQuickBooksRetentionForTenant(
  prisma: PrismaClient,
  params: Readonly<{ tenantId: string; now: Date; maxRows?: number }>,
): Promise<QuickBooksRetentionResult> {
  assertUtcNow(params.now);
  const maxRows = boundedMaxRows(params.maxRows);
  const oauthCutoffAtUtc = subtractUtcDays(params.now, QUICKBOOKS_OAUTH_STATE_RETENTION_DAYS);
  const processedCutoffAtUtc = subtractUtcDays(params.now, QUICKBOOKS_PROCESSED_WEBHOOK_RETENTION_DAYS);
  const deadCutoffAtUtc = subtractUtcDays(params.now, QUICKBOOKS_DEAD_WEBHOOK_RETENTION_DAYS);

  return withTenantRlsContext(prisma, params.tenantId, async (transaction) => {
    const locks = await transaction.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${retentionLockKey(params.tenantId)}, 0)
      ) AS "acquired"
    `);
    if (!locks[0]?.acquired) {
      return {
        lockSkipped: true,
        oauthStatesDeleted: 0,
        processedWebhookEventsDeleted: 0,
        deadWebhookEventsDeleted: 0,
        hasMore: true,
      };
    }

    let remaining = maxRows;
    const oauthStatesDeleted = await deleteEligibleBatch(transaction, {
      tenantId: params.tenantId,
      category: "OAUTH",
      cutoffAtUtc: oauthCutoffAtUtc,
      limit: Math.min(QUICKBOOKS_RETENTION_BATCH_SIZE, remaining),
    });
    remaining -= oauthStatesDeleted;

    const processedWebhookEventsDeleted = remaining > 0
      ? await deleteEligibleBatch(transaction, {
          tenantId: params.tenantId,
          category: "PROCESSED_WEBHOOK",
          cutoffAtUtc: processedCutoffAtUtc,
          limit: Math.min(QUICKBOOKS_RETENTION_BATCH_SIZE, remaining),
        })
      : 0;
    remaining -= processedWebhookEventsDeleted;

    const deadWebhookEventsDeleted = remaining > 0
      ? await deleteEligibleBatch(transaction, {
          tenantId: params.tenantId,
          category: "DEAD_WEBHOOK",
          cutoffAtUtc: deadCutoffAtUtc,
          limit: Math.min(QUICKBOOKS_RETENTION_BATCH_SIZE, remaining),
        })
      : 0;

    const hasMore = remaining === 0 && await hasEligibleRows(transaction, {
      tenantId: params.tenantId,
      oauthCutoffAtUtc,
      processedCutoffAtUtc,
      deadCutoffAtUtc,
    });
    return {
      lockSkipped: false,
      oauthStatesDeleted,
      processedWebhookEventsDeleted,
      deadWebhookEventsDeleted,
      hasMore,
    };
  }, { maxWait: 5_000, timeout: 10_000 });
}
