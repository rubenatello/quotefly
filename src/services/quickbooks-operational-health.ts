import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { mapWithConcurrency } from "../lib/bounded-concurrency";

export type QuickBooksOperationalRow = Readonly<{
  tokenFailureCount: number;
  tokenReauthCount: number;
  oldestTokenFailureAtUtc: Date | null;
  webhookOutstandingCount: number;
  webhookDeadCount: number;
  oldestWebhookOutstandingAtUtc: Date | null;
  reconciliationRequiredCount: number;
  oldestReconciliationRequiredAtUtc: Date | null;
  cdcCursorCount: number;
  cdcTerminalCount: number;
  cdcOverdueCount: number;
  oldestCdcChangedSinceUtc: Date | null;
  connectionRevocationPendingCount: number;
  connectionRevocationDeadCount: number;
  oldestConnectionRevocationPendingAtUtc: Date | null;
  orphanRevocationPendingCount: number;
  orphanRevocationDeadCount: number;
  oldestOrphanRevocationPendingAtUtc: Date | null;
}>;

export type QuickBooksOperationalAggregate = Readonly<{
  tokenFailureCount: number;
  tokenReauthCount: number;
  oldestTokenFailureAgeMs: number | null;
  webhookOutstandingCount: number;
  webhookDeadCount: number;
  oldestWebhookOutstandingAgeMs: number | null;
  reconciliationRequiredCount: number;
  oldestReconciliationRequiredAgeMs: number | null;
  cdcCursorCount: number;
  cdcTerminalCount: number;
  cdcOverdueCount: number;
  maximumCdcLagMs: number | null;
  connectionRevocationPendingCount: number;
  connectionRevocationDeadCount: number;
  oldestConnectionRevocationPendingAgeMs: number | null;
  orphanRevocationPendingCount: number;
  orphanRevocationDeadCount: number;
  oldestOrphanRevocationPendingAgeMs: number | null;
}>;

export async function loadQuickBooksOperationalRow(
  prisma: PrismaClient,
  tenantId: string,
  now: Date,
): Promise<QuickBooksOperationalRow> {
  const rows = await withTenantRlsContext(prisma, tenantId, (transaction) =>
    transaction.$queryRaw<QuickBooksOperationalRow[]>(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "QuickBooksConnection" c WHERE c."tenantId" = ${tenantId}
          AND c."deletedAtUtc" IS NULL AND c."status" = 'CONNECTED'
          AND c."lastError" = 'QUICKBOOKS_TOKEN_REFRESH_FAILED') AS "tokenFailureCount",
        (SELECT count(*)::int FROM "QuickBooksConnection" c WHERE c."tenantId" = ${tenantId}
          AND c."deletedAtUtc" IS NULL AND c."status" = 'NEEDS_REAUTH') AS "tokenReauthCount",
        (SELECT min(c."updatedAt") FROM "QuickBooksConnection" c WHERE c."tenantId" = ${tenantId}
          AND c."deletedAtUtc" IS NULL AND (c."status" = 'NEEDS_REAUTH' OR
            (c."status" = 'CONNECTED' AND c."lastError" = 'QUICKBOOKS_TOKEN_REFRESH_FAILED'))) AS "oldestTokenFailureAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" IN ('RECEIVED', 'PROCESSING', 'FAILED')
        ) AS "webhookOutstandingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" = 'DEAD'
        ) AS "webhookDeadCount",
        (
          SELECT min(event."receivedAtUtc")
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" IN ('RECEIVED', 'PROCESSING', 'FAILED')
        ) AS "oldestWebhookOutstandingAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksInvoiceOperation" operation
          WHERE operation."tenantId" = ${tenantId}
            AND operation."status" = 'RECONCILIATION_REQUIRED'
            AND operation."archivedAtUtc" IS NULL
        ) AS "reconciliationRequiredCount",
        (
          SELECT min(COALESCE(operation."failedAtUtc", operation."updatedAt"))
          FROM "QuickBooksInvoiceOperation" operation
          WHERE operation."tenantId" = ${tenantId}
            AND operation."status" = 'RECONCILIATION_REQUIRED'
            AND operation."archivedAtUtc" IS NULL
        ) AS "oldestReconciliationRequiredAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
        ) AS "cdcCursorCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NOT NULL
        ) AS "cdcTerminalCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
            AND (cursor."nextAttemptAtUtc" IS NULL OR cursor."nextAttemptAtUtc" <= ${now})
        ) AS "cdcOverdueCount",
        (
          SELECT min(cursor."changedSinceUtc")
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
        ) AS "oldestCdcChangedSinceUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'REVOCATION_PENDING'
        ) AS "connectionRevocationPendingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'ERROR'
            AND connection."lastError" = 'QUICKBOOKS_TOKEN_REVOCATION_DEAD'
        ) AS "connectionRevocationDeadCount",
        (
          SELECT min(COALESCE(
            connection."revocationPendingAtUtc",
            connection."disconnectRequestedAtUtc",
            connection."updatedAt"
          ))
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'REVOCATION_PENDING'
        ) AS "oldestConnectionRevocationPendingAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" IN ('PENDING', 'PROCESSING')
        ) AS "orphanRevocationPendingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" = 'DEAD'
        ) AS "orphanRevocationDeadCount",
        (
          SELECT min(revocation."createdAt")
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" IN ('PENDING', 'PROCESSING')
        ) AS "oldestOrphanRevocationPendingAtUtc"
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("QuickBooks operational metrics query returned no row.");
  return row;
}

function ageMs(now: Date, value: Date | null): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

export function aggregateQuickBooksOperationalRows(
  rows: readonly QuickBooksOperationalRow[],
  now: Date,
): QuickBooksOperationalAggregate {
  const oldestDate = (values: readonly (Date | null)[]) => values.reduce<Date | null>(
    (oldest, value) => !value || (oldest && oldest <= value) ? oldest : value,
    null,
  );
  return {
    tokenFailureCount: rows.reduce((total, row) => total + row.tokenFailureCount, 0),
    tokenReauthCount: rows.reduce((total, row) => total + row.tokenReauthCount, 0),
    oldestTokenFailureAgeMs: ageMs(now, oldestDate(rows.map((row) => row.oldestTokenFailureAtUtc))),
    webhookOutstandingCount: rows.reduce((total, row) => total + row.webhookOutstandingCount, 0),
    webhookDeadCount: rows.reduce((total, row) => total + row.webhookDeadCount, 0),
    oldestWebhookOutstandingAgeMs: ageMs(now, oldestDate(rows.map((row) => row.oldestWebhookOutstandingAtUtc))),
    reconciliationRequiredCount: rows.reduce((total, row) => total + row.reconciliationRequiredCount, 0),
    oldestReconciliationRequiredAgeMs: ageMs(now, oldestDate(rows.map((row) => row.oldestReconciliationRequiredAtUtc))),
    cdcCursorCount: rows.reduce((total, row) => total + row.cdcCursorCount, 0),
    cdcTerminalCount: rows.reduce((total, row) => total + row.cdcTerminalCount, 0),
    cdcOverdueCount: rows.reduce((total, row) => total + row.cdcOverdueCount, 0),
    maximumCdcLagMs: ageMs(now, oldestDate(rows.map((row) => row.oldestCdcChangedSinceUtc))),
    connectionRevocationPendingCount: rows.reduce((total, row) => total + row.connectionRevocationPendingCount, 0),
    connectionRevocationDeadCount: rows.reduce((total, row) => total + row.connectionRevocationDeadCount, 0),
    oldestConnectionRevocationPendingAgeMs: ageMs(
      now,
      oldestDate(rows.map((row) => row.oldestConnectionRevocationPendingAtUtc)),
    ),
    orphanRevocationPendingCount: rows.reduce((total, row) => total + row.orphanRevocationPendingCount, 0),
    orphanRevocationDeadCount: rows.reduce((total, row) => total + row.orphanRevocationDeadCount, 0),
    oldestOrphanRevocationPendingAgeMs: ageMs(
      now,
      oldestDate(rows.map((row) => row.oldestOrphanRevocationPendingAtUtc)),
    ),
  };
}


/** Complete bounded-memory keyset scan. No tenant or provider identifiers leave this service. */
export async function loadQuickBooksOperationalHealth(prisma: PrismaClient, now = new Date()) {
  let after: string | undefined;
  let total = aggregateQuickBooksOperationalRows([], now);
  let tenantCount = 0;
  for (;;) {
    const tenants = await prisma.tenant.findMany({
      where: { deletedAtUtc: null, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true }, orderBy: { id: "asc" }, take: 100,
    });
    const rows = await mapWithConcurrency(tenants, 4, (tenant) => loadQuickBooksOperationalRow(prisma, tenant.id, now));
    const page = aggregateQuickBooksOperationalRows(rows, now);
    for (const key of Object.keys(total) as (keyof QuickBooksOperationalAggregate)[]) {
      const value = page[key];
      const prior = total[key];
      (total as Record<string, number | null>)[key] = key.endsWith("Count")
        ? (prior ?? 0) + (value ?? 0)
        : value === null ? prior : prior === null ? value : Math.max(prior, value);
    }
    tenantCount += tenants.length;
    if (tenants.length < 100) return { ...total, tenantCount };
    after = tenants[tenants.length - 1].id;
  }
}
