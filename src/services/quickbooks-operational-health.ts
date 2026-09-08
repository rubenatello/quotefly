import { Prisma, type PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "../lib/bounded-concurrency";
import { buildTenantEntitlements } from "../lib/subscription";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  loadWorkerHeartbeatFleet,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  type WorkerHeartbeatFleetSnapshot,
} from "./worker-heartbeats";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import {
  evaluateQuickBooksProviderWindow,
  evaluateQuickBooksRetentionHeartbeat,
  parseQuickBooksWorkerOperationalHeartbeat,
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  type QuickBooksProviderWindow,
} from "./quickbooks-worker-operational";

export const QUICKBOOKS_MONITOR_WARNING_AGE_MS = 5 * 60 * 1_000;
export const QUICKBOOKS_MONITOR_CRITICAL_AGE_MS = 15 * 60 * 1_000;
export const QUICKBOOKS_MONITOR_WORKER_CRITICAL_AGE_MS = 3 * 60 * 1_000;
// CDC normally trails by the five-minute poll interval plus a two-minute
// overlap. These bounds intentionally sit above that seven-minute steady-state
// horizon so a healthy cursor does not flap the external monitor.
export const QUICKBOOKS_MONITOR_CDC_WARNING_LAG_MS = 10 * 60 * 1_000;
export const QUICKBOOKS_MONITOR_CDC_CRITICAL_LAG_MS = 20 * 60 * 1_000;

export type QuickBooksOperationalRow = Readonly<{
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
  tokenRefreshFailureConnectionCount: number;
  tokenRefreshReauthRequiredCount: number;
  oldestTokenRefreshFailureStartedAtUtc: Date | null;
}>;

export type QuickBooksOperationalAggregate = Readonly<{
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
  tokenRefreshFailureConnectionCount: number;
  tokenRefreshReauthRequiredCount: number;
  oldestTokenRefreshFailureAgeMs: number | null;
}>;

export type QuickBooksOperationalRuntime = Readonly<{
  environment: "sandbox" | "production";
  providerWorkflowsEnabled: boolean;
  oauthOnlyMode: boolean;
  reconciliationWorkerEnabled: boolean;
  cdcWorkerEnabled: boolean;
  requireWorkerReleaseIdentity: boolean;
}>;

export type QuickBooksOperationalSnapshot = Readonly<{
  operations: QuickBooksOperationalAggregate;
  workerFleet: WorkerHeartbeatFleetSnapshot | null;
  workerOperationalInstances?: readonly QuickBooksWorkerOperationalInstance[];
}>;

export type QuickBooksWorkerOperationalInstance = Readonly<{
  startedAtUtc: Date;
  observedAtUtc: Date;
  metrics: Prisma.JsonValue;
}>;

export type QuickBooksOperationalEvaluation = Readonly<{
  warningUnhealthy: boolean;
  criticalUnhealthy: boolean;
}>;

type QuickBooksOperationalAggregateOptions = Readonly<{
  /** Omit to preserve raw per-tenant control-plane inventory semantics. */
  providerActionTenantIds?: ReadonlySet<string>;
}>;

const COUNT_FIELDS = [
  "webhookOutstandingCount",
  "webhookDeadCount",
  "reconciliationRequiredCount",
  "cdcCursorCount",
  "cdcTerminalCount",
  "cdcOverdueCount",
  "connectionRevocationPendingCount",
  "connectionRevocationDeadCount",
  "orphanRevocationPendingCount",
  "orphanRevocationDeadCount",
  "tokenRefreshFailureConnectionCount",
  "tokenRefreshReauthRequiredCount",
] as const satisfies readonly (keyof QuickBooksOperationalAggregate)[];

const AGE_FIELDS = [
  "oldestWebhookOutstandingAgeMs",
  "oldestReconciliationRequiredAgeMs",
  "maximumCdcLagMs",
  "oldestConnectionRevocationPendingAgeMs",
  "oldestOrphanRevocationPendingAgeMs",
  "oldestTokenRefreshFailureAgeMs",
] as const satisfies readonly (keyof QuickBooksOperationalAggregate)[];

const COUNT_AGE_PAIRS = [
  ["webhookOutstandingCount", "oldestWebhookOutstandingAgeMs"],
  ["reconciliationRequiredCount", "oldestReconciliationRequiredAgeMs"],
  ["connectionRevocationPendingCount", "oldestConnectionRevocationPendingAgeMs"],
  ["orphanRevocationPendingCount", "oldestOrphanRevocationPendingAgeMs"],
  ["tokenRefreshFailureConnectionCount", "oldestTokenRefreshFailureAgeMs"],
] as const satisfies readonly [keyof QuickBooksOperationalAggregate, keyof QuickBooksOperationalAggregate][];

export async function loadQuickBooksOperationalRow(
  prisma: PrismaClient,
  tenantId: string,
  now: Date,
): Promise<QuickBooksOperationalRow> {
  const rows = await withTenantRlsContext(prisma, tenantId, (transaction) =>
    transaction.$queryRaw<QuickBooksOperationalRow[]>(Prisma.sql`
      SELECT
        (
          SELECT count(*)::int
          FROM "QuickBooksWebhookEvent" event
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = event."quickBooksConnectionId"
            AND connection."tenantId" = event."tenantId"
          WHERE event."tenantId" = ${tenantId}
            AND event."quickBooksConnectionId" IS NOT NULL
            AND event."entityId" IS NOT NULL
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
            AND (
              event."status" = 'RECEIVED'
              OR (event."status" = 'FAILED' AND event."nextAttemptAtUtc" <= ${now})
              OR (event."status" = 'PROCESSING' AND event."claimExpiresAtUtc" <= ${now})
            )
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
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = event."quickBooksConnectionId"
            AND connection."tenantId" = event."tenantId"
          WHERE event."tenantId" = ${tenantId}
            AND event."quickBooksConnectionId" IS NOT NULL
            AND event."entityId" IS NOT NULL
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
            AND (
              event."status" = 'RECEIVED'
              OR (event."status" = 'FAILED' AND event."nextAttemptAtUtc" <= ${now})
              OR (event."status" = 'PROCESSING' AND event."claimExpiresAtUtc" <= ${now})
            )
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
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = cursor."quickBooksConnectionId"
            AND connection."tenantId" = cursor."tenantId"
          WHERE cursor."tenantId" = ${tenantId}
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
        ) AS "cdcCursorCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = cursor."quickBooksConnectionId"
            AND connection."tenantId" = cursor."tenantId"
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NOT NULL
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
        ) AS "cdcTerminalCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = cursor."quickBooksConnectionId"
            AND connection."tenantId" = cursor."tenantId"
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
            AND (cursor."nextAttemptAtUtc" IS NULL OR cursor."nextAttemptAtUtc" <= ${now})
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
        ) AS "cdcOverdueCount",
        (
          SELECT min(cursor."changedSinceUtc")
          FROM "QuickBooksCdcCursor" cursor
          INNER JOIN "QuickBooksConnection" connection
            ON connection."id" = cursor."quickBooksConnectionId"
            AND connection."tenantId" = cursor."tenantId"
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
            AND (cursor."nextAttemptAtUtc" IS NULL OR cursor."nextAttemptAtUtc" <= ${now})
            AND connection."status" = 'CONNECTED'
            AND connection."deletedAtUtc" IS NULL
            AND connection."setupConfirmedAtUtc" IS NOT NULL
            AND connection."setupConfirmedByTenantUserId" IS NOT NULL
            AND connection."setupChecklistVersion" = ${QUICKBOOKS_SETUP_CHECKLIST_VERSION}
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
        ) AS "oldestOrphanRevocationPendingAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."tokenRefreshFailureStartedAtUtc" IS NOT NULL
        ) AS "tokenRefreshFailureConnectionCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'NEEDS_REAUTH'
            AND connection."tokenRefreshFailureStartedAtUtc" IS NOT NULL
        ) AS "tokenRefreshReauthRequiredCount",
        (
          SELECT min(connection."tokenRefreshFailureStartedAtUtc")
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."tokenRefreshFailureStartedAtUtc" IS NOT NULL
        ) AS "oldestTokenRefreshFailureStartedAtUtc"
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
    tokenRefreshFailureConnectionCount: rows.reduce(
      (total, row) => total + row.tokenRefreshFailureConnectionCount,
      0,
    ),
    tokenRefreshReauthRequiredCount: rows.reduce(
      (total, row) => total + row.tokenRefreshReauthRequiredCount,
      0,
    ),
    oldestTokenRefreshFailureAgeMs: ageMs(
      now,
      oldestDate(rows.map((row) => row.oldestTokenRefreshFailureStartedAtUtc)),
    ),
  };
}

/**
 * Deliberately paused provider queues are inventory, not incidents. Credential
 * revocation, dead webhook audit, and reauthorization signals remain visible
 * across billing states because they are lifecycle/security obligations.
 */
export function maskPausedQuickBooksProviderActionMetrics(
  row: QuickBooksOperationalRow,
): QuickBooksOperationalRow {
  return {
    ...row,
    webhookOutstandingCount: 0,
    oldestWebhookOutstandingAtUtc: null,
    reconciliationRequiredCount: 0,
    oldestReconciliationRequiredAtUtc: null,
    cdcCursorCount: 0,
    cdcTerminalCount: 0,
    cdcOverdueCount: 0,
    oldestCdcChangedSinceUtc: null,
  };
}

export async function loadQuickBooksOperationalAggregate(
  prisma: PrismaClient,
  tenantIds: readonly string[],
  now: Date,
  options: QuickBooksOperationalAggregateOptions = {},
): Promise<QuickBooksOperationalAggregate> {
  const rows = await mapWithConcurrency(
    tenantIds,
    4,
    async (tenantId) => {
      const row = await loadQuickBooksOperationalRow(prisma, tenantId, now);
      return options.providerActionTenantIds === undefined
        || options.providerActionTenantIds.has(tenantId)
        ? row
        : maskPausedQuickBooksProviderActionMetrics(row);
    },
  );
  return aggregateQuickBooksOperationalRows(rows, now);
}

export async function loadQuickBooksOperationalSnapshot(
  prisma: PrismaClient,
  runtime: QuickBooksOperationalRuntime,
  options: { apiReleaseSha: string | null; now?: Date },
): Promise<QuickBooksOperationalSnapshot> {
  const now = options.now ?? new Date();
  const tenants = await prisma.tenant.findMany({
    where: { deletedAtUtc: null },
    select: {
      id: true,
      subscriptionStatus: true,
      subscriptionPlanCode: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodStartUtc: true,
      subscriptionCurrentPeriodEndUtc: true,
    },
  });
  const providerActionTenantIds = new Set(
    tenants
      .filter((tenant) => buildTenantEntitlements(tenant, now).hasWorkspaceAccess)
      .map(({ id }) => id),
  );
  const workerRequired = runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled;
  const [operations, workerState] = await Promise.all([
    loadQuickBooksOperationalAggregate(
      prisma,
      tenants.map(({ id }) => id),
      now,
      { providerActionTenantIds },
    ),
    workerRequired
      ? loadQuickBooksWorkerOperationalState(prisma, {
          apiReleaseSha: options.apiReleaseSha,
          requireReleaseIdentity: runtime.requireWorkerReleaseIdentity,
        })
      : Promise.resolve({ workerFleet: null, workerOperationalInstances: [] }),
  ]);
  return { operations, ...workerState };
}

export async function loadQuickBooksWorkerOperationalState(
  prisma: PrismaClient,
  options: { apiReleaseSha: string | null; requireReleaseIdentity: boolean },
) {
  return prisma.$transaction(async (transaction) => {
    // Fleet topology and its per-instance metrics must share one database
    // snapshot. A rollout transition between independent READ COMMITTED
    // statements would otherwise create a transient count mismatch and a
    // false critical page. Both queries use transaction_timestamp(), which is
    // stable across this transaction's freshness checks.
    const workerFleet = await loadWorkerHeartbeatFleet(
      transaction,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      options,
    );
    const workerOperationalInstances = await loadFreshQuickBooksWorkerOperationalInstances(transaction);
    return { workerFleet, workerOperationalInstances };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function loadFreshQuickBooksWorkerOperationalInstances(
  prisma: Pick<PrismaClient, "$queryRaw">,
): Promise<readonly QuickBooksWorkerOperationalInstance[]> {
  // The extra row makes overflow fail closed while keeping the metrics read
  // bounded. Freshness uses the database clock, matching the fleet readiness
  // query rather than trusting process-supplied heartbeat timestamps.
  return prisma.$queryRaw<QuickBooksWorkerOperationalInstance[]>(Prisma.sql`
    WITH params AS MATERIALIZED (
      SELECT transaction_timestamp() AS evaluated_at
    )
    SELECT
      instance."startedAtUtc" AS "startedAtUtc",
      instance."observedAtUtc" AS "observedAtUtc",
      instance."metrics" AS "metrics"
    FROM public."WorkerHeartbeatInstance" instance
    CROSS JOIN params
    WHERE instance."workerKey" = ${QUICKBOOKS_RECONCILIATION_WORKER_KEY}
      AND instance."status" IN ('STARTING', 'RUNNING', 'STOPPING')
      AND instance."observedAtUtc" >= params.evaluated_at
        - (${WORKER_HEARTBEAT_STALE_AFTER_MS}::integer * INTERVAL '1 millisecond')
      AND instance."observedAtUtc" <= params.evaluated_at
    ORDER BY instance."observedAtUtc" DESC, instance."startedAtUtc" DESC
    LIMIT ${WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1}
  `);
}

function assertOperationalAggregate(metrics: QuickBooksOperationalAggregate): void {
  for (const field of COUNT_FIELDS) {
    const value = metrics[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("QuickBooks operational count is invalid.");
    }
  }
  for (const field of AGE_FIELDS) {
    const value = metrics[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error("QuickBooks operational age is invalid.");
    }
  }
  for (const [countField, ageField] of COUNT_AGE_PAIRS) {
    if (metrics[countField] > 0 && metrics[ageField] === null) {
      throw new Error("QuickBooks operational inventory age is unavailable.");
    }
  }
  if (metrics.cdcOverdueCount > 0 && metrics.maximumCdcLagMs === null) {
    throw new Error("QuickBooks CDC overdue age is unavailable.");
  }
  if (metrics.cdcOverdueCount > metrics.cdcCursorCount || metrics.cdcTerminalCount > metrics.cdcCursorCount) {
    throw new Error("QuickBooks CDC operational counts are inconsistent.");
  }
}

function ageAtLeast(value: number | null, thresholdMs: number): boolean {
  return value !== null && value >= thresholdMs;
}

function workerObservationAgeMs(
  fleet: WorkerHeartbeatFleetSnapshot,
  now: Date,
): number | null {
  const observedAtUtc = fleet.representative?.observedAtUtc;
  if (!observedAtUtc) return null;
  const age = now.getTime() - observedAtUtc.getTime();
  if (!Number.isFinite(age) || age < 0) {
    throw new Error("QuickBooks worker observation time is invalid.");
  }
  return age;
}

function workerIsCritical(
  fleet: WorkerHeartbeatFleetSnapshot | null,
  runtime: QuickBooksOperationalRuntime,
  now: Date,
): boolean {
  if (!fleet) return true;
  if (
    fleet.freshLiveOverflowed
    || (runtime.requireWorkerReleaseIdentity && fleet.counts.missingReleaseShaInstanceCount > 0)
    || fleet.counts.releaseMismatchInstanceCount > 0
    || (runtime.requireWorkerReleaseIdentity && !fleet.releaseIdentity.apiReleaseSha)
    || fleet.releaseIdentity.matches === false
  ) {
    return true;
  }
  if (fleet.counts.capacityInstanceCount > 0) {
    return !fleet.ready;
  }
  const representative = fleet.representative;
  if (!representative) return true;
  if (representative.status !== "STARTING" && representative.status !== "RUNNING") return true;
  const observationAgeMs = workerObservationAgeMs(fleet, now);
  return observationAgeMs === null || observationAgeMs >= QUICKBOOKS_MONITOR_WORKER_CRITICAL_AGE_MS;
}

function evaluateWorkerOperationalInstances(
  runtime: QuickBooksOperationalRuntime,
  snapshot: QuickBooksOperationalSnapshot,
  now: Date,
): QuickBooksOperationalEvaluation {
  const fleet = snapshot.workerFleet;
  if (!fleet || fleet.counts.freshLiveInstanceCount === 0) {
    return { warningUnhealthy: false, criticalUnhealthy: false };
  }
  const instances = snapshot.workerOperationalInstances === undefined
    ? fleet.representative?.fresh
      ? [{
          startedAtUtc: fleet.representative.startedAtUtc,
          observedAtUtc: fleet.representative.observedAtUtc ?? fleet.representative.heartbeatAtUtc,
          metrics: fleet.representative.metrics,
        }]
      : []
    : snapshot.workerOperationalInstances;
  if (
    instances.length === 0
    || instances.length > WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1
    || instances.length !== Math.min(
      fleet.counts.freshLiveInstanceCount,
      WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1,
    )
  ) {
    throw new Error("QuickBooks worker operational heartbeat inventory is unavailable.");
  }

  const providerWindow = {
    windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
    callCount: 0,
    failureCount: 0,
    throttleCount: 0,
    timeoutCount: 0,
    slowCount: 0,
    degradedCallCount: 0,
    maximumDurationMs: 0,
  } satisfies QuickBooksProviderWindow;
  let warningUnhealthy = false;
  let criticalUnhealthy = false;
  for (const instance of instances) {
    const operational = parseQuickBooksWorkerOperationalHeartbeat(instance.metrics);
    if (!operational) {
      throw new Error("QuickBooks worker operational heartbeat is invalid.");
    }
    if (operational.retention.startupAtUtc !== instance.startedAtUtc.toISOString()) {
      throw new Error("QuickBooks worker operational startup identity is inconsistent.");
    }
    const lastRetentionSucceededAtMs = operational.retention.lastSucceededAtUtc === null
      ? null
      : new Date(operational.retention.lastSucceededAtUtc).getTime();
    if (
      lastRetentionSucceededAtMs !== null
      && lastRetentionSucceededAtMs > now.getTime() + WORKER_HEARTBEAT_STALE_AFTER_MS
    ) {
      throw new Error("QuickBooks worker retention timestamp is invalid.");
    }

    for (const field of [
      "callCount",
      "failureCount",
      "throttleCount",
      "timeoutCount",
      "slowCount",
      "degradedCallCount",
    ] as const) {
      const combined = providerWindow[field] + operational.providerWindow[field];
      if (!Number.isSafeInteger(combined)) {
        throw new Error("QuickBooks fleet provider window exceeds the supported range.");
      }
      providerWindow[field] = combined;
    }
    providerWindow.maximumDurationMs = Math.max(
      providerWindow.maximumDurationMs,
      operational.providerWindow.maximumDurationMs,
    );
    const retentionHealth = evaluateQuickBooksRetentionHeartbeat(operational.retention, now);
    const environmentMismatch = operational.environment !== runtime.environment;
    warningUnhealthy ||= retentionHealth !== "HEALTHY" || environmentMismatch;
    criticalUnhealthy ||= retentionHealth === "CRITICAL" || environmentMismatch;
  }
  const providerHealth = evaluateQuickBooksProviderWindow(providerWindow);
  warningUnhealthy ||= providerHealth !== "HEALTHY";
  criticalUnhealthy ||= providerHealth === "CRITICAL";
  return { warningUnhealthy, criticalUnhealthy };
}

export function evaluateQuickBooksOperationalSnapshot(
  runtime: QuickBooksOperationalRuntime,
  snapshot: QuickBooksOperationalSnapshot,
  now = new Date(),
): QuickBooksOperationalEvaluation {
  if (
    (runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled) && !runtime.providerWorkflowsEnabled
    || runtime.cdcWorkerEnabled && !runtime.reconciliationWorkerEnabled
    || runtime.oauthOnlyMode && (runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled)
  ) {
    throw new Error("QuickBooks operational phase is invalid.");
  }

  const operations = snapshot.operations;
  assertOperationalAggregate(operations);
  const workerRequired = runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled;
  const workerWarning = workerRequired && snapshot.workerFleet?.ready !== true;
  const workerCritical = workerRequired && workerIsCritical(snapshot.workerFleet, runtime, now);
  const workerOperational = workerRequired
    ? evaluateWorkerOperationalInstances(runtime, snapshot, now)
    : { warningUnhealthy: false, criticalUnhealthy: false };

  const agedWarning = [
    operations.oldestWebhookOutstandingAgeMs,
    operations.oldestReconciliationRequiredAgeMs,
    operations.oldestConnectionRevocationPendingAgeMs,
    operations.oldestOrphanRevocationPendingAgeMs,
    operations.oldestTokenRefreshFailureAgeMs,
  ].some((age) => ageAtLeast(age, QUICKBOOKS_MONITOR_WARNING_AGE_MS));
  const agedCritical = [
    operations.oldestWebhookOutstandingAgeMs,
    operations.oldestReconciliationRequiredAgeMs,
    operations.oldestConnectionRevocationPendingAgeMs,
    operations.oldestOrphanRevocationPendingAgeMs,
    operations.oldestTokenRefreshFailureAgeMs,
  ].some((age) => ageAtLeast(age, QUICKBOOKS_MONITOR_CRITICAL_AGE_MS));
  const cdcWarning = runtime.cdcWorkerEnabled
    && operations.cdcOverdueCount > 0
    && ageAtLeast(operations.maximumCdcLagMs, QUICKBOOKS_MONITOR_CDC_WARNING_LAG_MS);
  const cdcCritical = runtime.cdcWorkerEnabled
    && operations.cdcOverdueCount > 0
    && ageAtLeast(operations.maximumCdcLagMs, QUICKBOOKS_MONITOR_CDC_CRITICAL_LAG_MS);
  const terminalCritical = operations.webhookDeadCount > 0
    || operations.connectionRevocationDeadCount > 0
    || operations.orphanRevocationDeadCount > 0
    || operations.tokenRefreshReauthRequiredCount > 0
    || operations.cdcTerminalCount > 0;
  const criticalUnhealthy = workerCritical
    || workerOperational.criticalUnhealthy
    || agedCritical
    || cdcCritical
    || terminalCritical;
  return {
    warningUnhealthy: workerWarning
      || workerOperational.warningUnhealthy
      || agedWarning
      || cdcWarning
      || criticalUnhealthy,
    criticalUnhealthy,
  };
}
