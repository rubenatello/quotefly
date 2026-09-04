import { Prisma, type PrismaClient } from "@prisma/client";

export const QUICKBOOKS_RECONCILIATION_WORKER_KEY = "quickbooks-reconciliation";
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 60_000;
export const WORKER_HEARTBEAT_FRESH_LIVE_LIMIT = 100;

export type WorkerHeartbeatStatus = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED";

export type WorkerHeartbeatSnapshot = Readonly<{
  status: WorkerHeartbeatStatus;
  fresh: boolean;
  heartbeatAtUtc: Date;
  observedAtUtc?: Date;
  startedAtUtc: Date;
  cycleStartedAtUtc: Date;
  lastCycleDurationMs: number | null;
  metrics: Prisma.JsonValue;
}>;

export type WorkerHeartbeatFleetSnapshot = Readonly<{
  representative: WorkerHeartbeatSnapshot | null;
  ready: boolean;
  counts: Readonly<{
    totalInstanceCount: number;
    freshLiveInstanceCount: number;
    capacityInstanceCount: number;
    stoppingInstanceCount: number;
    staleInstanceCount: number;
    terminalInstanceCount: number;
    missingReleaseShaInstanceCount: number;
    releaseMismatchInstanceCount: number;
    overflowedFreshLiveInstanceCount: number;
  }>;
  freshLiveLimit: typeof WORKER_HEARTBEAT_FRESH_LIVE_LIMIT;
  freshLiveOverflowed: boolean;
  releaseIdentity: Readonly<{
    apiReleaseSha: string | null;
    workerReleaseSha: string | null;
    matches: boolean | null;
  }>;
}>;

const CAPACITY_WORKER_STATUSES = new Set<WorkerHeartbeatStatus>(["STARTING", "RUNNING"]);

function heartbeatIsWithinFreshWindow(heartbeatAtUtc: Date, now: Date) {
  const ageMs = now.getTime() - heartbeatAtUtc.getTime();
  return ageMs >= 0 && ageMs <= WORKER_HEARTBEAT_STALE_AFTER_MS;
}

function heartbeatRowSnapshot(
  row: {
    status: string;
    heartbeatAtUtc: Date;
    startedAtUtc: Date;
    cycleStartedAtUtc: Date;
    lastCycleDurationMs: number | null;
    metrics: Prisma.JsonValue;
  },
  now: Date,
): WorkerHeartbeatSnapshot {
  const status = row.status as WorkerHeartbeatStatus;
  return {
    ...row,
    status,
    fresh: CAPACITY_WORKER_STATUSES.has(status)
      && heartbeatIsWithinFreshWindow(row.heartbeatAtUtc, now),
  };
}

export async function recordWorkerHeartbeat(
  prisma: PrismaClient,
  params: {
    workerKey: string;
    instanceRefHash: string;
    status: WorkerHeartbeatStatus;
    startedAtUtc: Date;
    cycleStartedAtUtc: Date;
    heartbeatAtUtc?: Date;
    lastCycleDurationMs?: number | null;
    metrics?: Prisma.InputJsonValue;
  },
) {
  const heartbeatAtUtc = params.heartbeatAtUtc ?? new Date();
  const data = {
    instanceRefHash: params.instanceRefHash,
    status: params.status,
    startedAtUtc: params.startedAtUtc,
    cycleStartedAtUtc: params.cycleStartedAtUtc,
    heartbeatAtUtc,
    lastCycleDurationMs: params.lastCycleDurationMs ?? null,
    metrics: params.metrics ?? {},
  };
  await prisma.workerHeartbeat.upsert({
    where: { workerKey: params.workerKey },
    create: { workerKey: params.workerKey, ...data },
    update: data,
  });
}

export async function loadWorkerHeartbeat(
  prisma: PrismaClient,
  workerKey: string,
  now = new Date(),
): Promise<WorkerHeartbeatSnapshot | null> {
  const row = await prisma.workerHeartbeat.findUnique({
    where: { workerKey },
    select: {
      status: true,
      startedAtUtc: true,
      cycleStartedAtUtc: true,
      heartbeatAtUtc: true,
      lastCycleDurationMs: true,
      metrics: true,
    },
  });
  if (!row) return null;
  return heartbeatRowSnapshot(row, now);
}

/**
 * Loads the additive, per-process heartbeat mirror used for rollout-safe
 * readiness. The instance reference hashes are deliberately not selected, so
 * neither this service result nor a route serializer can expose them.
 */
export async function loadWorkerHeartbeatFleet(
  prisma: PrismaClient,
  workerKey: string,
  options: {
    apiReleaseSha: string | null;
    requireReleaseIdentity?: boolean;
  },
): Promise<WorkerHeartbeatFleetSnapshot> {
  type FleetQueryRow = Readonly<{
    representativeStatus: string | null;
    representativeHeartbeatAtUtc: Date | null;
    representativeObservedAtUtc: Date | null;
    representativeStartedAtUtc: Date | null;
    representativeCycleStartedAtUtc: Date | null;
    representativeLastCycleDurationMs: number | null;
    representativeMetrics: Prisma.JsonValue | null;
    representativeFresh: boolean | null;
    totalInstanceCount: bigint | number;
    freshLiveInstanceCount: bigint | number;
    capacityInstanceCount: bigint | number;
    stoppingInstanceCount: bigint | number;
    staleInstanceCount: bigint | number;
    terminalInstanceCount: bigint | number;
    missingReleaseShaInstanceCount: bigint | number;
    releaseMismatchInstanceCount: bigint | number;
    overflowedFreshLiveInstanceCount: bigint | number;
    freshLiveOverflowed: boolean;
    workerReleaseSha: string | null;
    releaseMatches: boolean | null;
    ready: boolean;
  }>;

  const normalizedApiReleaseSha = options.apiReleaseSha?.trim().toLowerCase() ?? null;
  const apiReleaseSha = normalizedApiReleaseSha && /^[a-f0-9]{40}$/.test(normalizedApiReleaseSha)
    ? normalizedApiReleaseSha
    : null;
  const requireReleaseIdentity = options.requireReleaseIdentity ?? apiReleaseSha !== null;

  // Counts and release identity are reduced in PostgreSQL to one fixed-shape
  // row. Only the single representative subquery reads metrics; process hashes
  // are never projected out of the database.
  const [row] = await prisma.$queryRaw<FleetQueryRow[]>(Prisma.sql`
    WITH params AS MATERIALIZED (
      SELECT
        clock_timestamp() AS evaluated_at,
        ${workerKey}::text AS worker_key,
        ${apiReleaseSha}::text AS api_release_sha,
        ${requireReleaseIdentity}::boolean AS require_release_identity
    ),
    classified AS MATERIALIZED (
      SELECT
        instance."status",
        instance."releaseSha",
        instance."observedAtUtc" >= params.evaluated_at
          - (${WORKER_HEARTBEAT_STALE_AFTER_MS}::integer * INTERVAL '1 millisecond')
          AND instance."observedAtUtc" <= params.evaluated_at AS observation_fresh,
        instance."status" IN ('STARTING', 'RUNNING', 'STOPPING') AS live
      FROM public."WorkerHeartbeatInstance" instance
      CROSS JOIN params
      WHERE instance."workerKey" = params.worker_key
    ),
    summary AS (
      SELECT
        COUNT(*)::bigint AS total_instance_count,
        COUNT(*) FILTER (WHERE live AND observation_fresh)::bigint AS fresh_live_instance_count,
        COUNT(*) FILTER (
          WHERE observation_fresh AND "status" IN ('STARTING', 'RUNNING')
        )::bigint AS capacity_instance_count,
        COUNT(*) FILTER (
          WHERE observation_fresh AND "status" = 'STOPPING'
        )::bigint AS stopping_instance_count,
        COUNT(*) FILTER (WHERE live AND NOT observation_fresh)::bigint AS stale_instance_count,
        COUNT(*) FILTER (WHERE NOT live)::bigint AS terminal_instance_count,
        COUNT(*) FILTER (
          WHERE live AND observation_fresh AND "releaseSha" IS NULL
        )::bigint AS missing_release_sha_instance_count,
        COUNT(*) FILTER (
          WHERE live
            AND observation_fresh
            AND "releaseSha" IS NOT NULL
            AND params.api_release_sha IS NOT NULL
            AND "releaseSha" <> params.api_release_sha
        )::bigint AS release_mismatch_instance_count,
        COUNT(DISTINCT "releaseSha") FILTER (
          WHERE live AND observation_fresh AND "releaseSha" IS NOT NULL
        )::bigint AS distinct_release_sha_count,
        MIN("releaseSha") FILTER (
          WHERE live AND observation_fresh AND "releaseSha" IS NOT NULL
        ) AS sole_release_sha
      FROM classified
      CROSS JOIN params
    ),
    resolved AS (
      SELECT
        summary.*,
        GREATEST(
          summary.fresh_live_instance_count - ${WORKER_HEARTBEAT_FRESH_LIVE_LIMIT}::bigint,
          0::bigint
        ) AS overflowed_fresh_live_instance_count,
        summary.fresh_live_instance_count > ${WORKER_HEARTBEAT_FRESH_LIVE_LIMIT}::bigint
          AS fresh_live_overflowed,
        CASE
          WHEN summary.distinct_release_sha_count = 1 THEN summary.sole_release_sha
          ELSE NULL
        END AS worker_release_sha,
        CASE
          WHEN params.api_release_sha IS NULL THEN NULL
          ELSE summary.fresh_live_instance_count > 0
            AND summary.missing_release_sha_instance_count = 0
            AND summary.release_mismatch_instance_count = 0
        END AS release_matches
      FROM summary
      CROSS JOIN params
    ),
    representative AS MATERIALIZED (
      SELECT
        instance."status",
        instance."heartbeatAtUtc",
        instance."observedAtUtc",
        instance."startedAtUtc",
        instance."cycleStartedAtUtc",
        instance."lastCycleDurationMs",
        instance."metrics",
        instance."observedAtUtc" >= params.evaluated_at
          - (${WORKER_HEARTBEAT_STALE_AFTER_MS}::integer * INTERVAL '1 millisecond')
          AND instance."observedAtUtc" <= params.evaluated_at
          AND instance."status" IN ('STARTING', 'RUNNING') AS fresh
      FROM public."WorkerHeartbeatInstance" instance
      CROSS JOIN params
      WHERE instance."workerKey" = params.worker_key
      ORDER BY
        CASE
          WHEN instance."observedAtUtc" >= params.evaluated_at
              - (${WORKER_HEARTBEAT_STALE_AFTER_MS}::integer * INTERVAL '1 millisecond')
            AND instance."observedAtUtc" <= params.evaluated_at
            AND instance."status" IN ('STARTING', 'RUNNING') THEN 0
          WHEN instance."observedAtUtc" >= params.evaluated_at
              - (${WORKER_HEARTBEAT_STALE_AFTER_MS}::integer * INTERVAL '1 millisecond')
            AND instance."observedAtUtc" <= params.evaluated_at
            AND instance."status" = 'STOPPING' THEN 1
          ELSE 2
        END,
        instance."observedAtUtc" DESC,
        instance."startedAtUtc" DESC
      LIMIT 1
    )
    SELECT
      representative."status" AS "representativeStatus",
      representative."heartbeatAtUtc" AS "representativeHeartbeatAtUtc",
      representative."observedAtUtc" AS "representativeObservedAtUtc",
      representative."startedAtUtc" AS "representativeStartedAtUtc",
      representative."cycleStartedAtUtc" AS "representativeCycleStartedAtUtc",
      representative."lastCycleDurationMs" AS "representativeLastCycleDurationMs",
      representative."metrics" AS "representativeMetrics",
      representative.fresh AS "representativeFresh",
      resolved.total_instance_count AS "totalInstanceCount",
      resolved.fresh_live_instance_count AS "freshLiveInstanceCount",
      resolved.capacity_instance_count AS "capacityInstanceCount",
      resolved.stopping_instance_count AS "stoppingInstanceCount",
      resolved.stale_instance_count AS "staleInstanceCount",
      resolved.terminal_instance_count AS "terminalInstanceCount",
      resolved.missing_release_sha_instance_count AS "missingReleaseShaInstanceCount",
      resolved.release_mismatch_instance_count AS "releaseMismatchInstanceCount",
      resolved.overflowed_fresh_live_instance_count AS "overflowedFreshLiveInstanceCount",
      resolved.fresh_live_overflowed AS "freshLiveOverflowed",
      resolved.worker_release_sha AS "workerReleaseSha",
      resolved.release_matches AS "releaseMatches",
      resolved.capacity_instance_count > 0
        AND NOT resolved.fresh_live_overflowed
        AND CASE
          WHEN params.api_release_sha IS NOT NULL THEN resolved.release_matches IS TRUE
          WHEN params.require_release_identity THEN FALSE
          ELSE TRUE
        END AS "ready"
    FROM resolved
    CROSS JOIN params
    LEFT JOIN representative ON TRUE
  `);

  if (!row) throw new Error("Worker heartbeat fleet query returned no summary row.");

  const count = (value: bigint | number) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error("Worker heartbeat fleet count exceeded the supported range.");
    }
    return result;
  };
  const representative = row.representativeStatus
    && row.representativeHeartbeatAtUtc
    && row.representativeObservedAtUtc
    && row.representativeStartedAtUtc
    && row.representativeCycleStartedAtUtc
    ? {
        status: row.representativeStatus as WorkerHeartbeatStatus,
        fresh: row.representativeFresh === true,
        heartbeatAtUtc: row.representativeHeartbeatAtUtc,
        observedAtUtc: row.representativeObservedAtUtc,
        startedAtUtc: row.representativeStartedAtUtc,
        cycleStartedAtUtc: row.representativeCycleStartedAtUtc,
        lastCycleDurationMs: row.representativeLastCycleDurationMs,
        metrics: row.representativeMetrics,
      }
    : null;

  return {
    representative,
    ready: row.ready,
    counts: {
      totalInstanceCount: count(row.totalInstanceCount),
      freshLiveInstanceCount: count(row.freshLiveInstanceCount),
      capacityInstanceCount: count(row.capacityInstanceCount),
      stoppingInstanceCount: count(row.stoppingInstanceCount),
      staleInstanceCount: count(row.staleInstanceCount),
      terminalInstanceCount: count(row.terminalInstanceCount),
      missingReleaseShaInstanceCount: count(row.missingReleaseShaInstanceCount),
      releaseMismatchInstanceCount: count(row.releaseMismatchInstanceCount),
      overflowedFreshLiveInstanceCount: count(row.overflowedFreshLiveInstanceCount),
    },
    freshLiveLimit: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
    freshLiveOverflowed: row.freshLiveOverflowed,
    releaseIdentity: {
      apiReleaseSha,
      workerReleaseSha: row.workerReleaseSha,
      matches: row.releaseMatches,
    },
  };
}

/**
 * Executes a database-owned fixed retention policy. Callers cannot choose the
 * 30-day cutoff or the 100-row limit.
 */
export async function runWorkerHeartbeatInstanceRetention(
  prisma: PrismaClient,
): Promise<number> {
  const [result] = await prisma.$queryRaw<Array<{ deletedCount: bigint | number }>>(Prisma.sql`
    SELECT public.quotefly_purge_worker_heartbeat_instances() AS "deletedCount"
  `);
  return Number(result?.deletedCount ?? 0);
}

export function serializeWorkerHeartbeat(snapshot: WorkerHeartbeatSnapshot | null) {
  return snapshot
    ? {
        status: snapshot.status,
        fresh: snapshot.fresh,
        heartbeatAtUtc: snapshot.heartbeatAtUtc,
        ...(snapshot.observedAtUtc ? { observedAtUtc: snapshot.observedAtUtc } : {}),
        startedAtUtc: snapshot.startedAtUtc,
        cycleStartedAtUtc: snapshot.cycleStartedAtUtc,
        lastCycleDurationMs: snapshot.lastCycleDurationMs,
        metrics: snapshot.metrics,
      }
    : null;
}

export function serializeWorkerHeartbeatFleet(snapshot: WorkerHeartbeatFleetSnapshot) {
  const representative = serializeWorkerHeartbeat(snapshot.representative);
  return representative
    ? {
        ...representative,
        fresh: snapshot.ready,
        fleet: {
          ...snapshot.counts,
          freshLiveInstanceLimit: snapshot.freshLiveLimit,
          freshLiveOverflowed: snapshot.freshLiveOverflowed,
        },
        releaseIdentity: snapshot.releaseIdentity,
      }
    : null;
}

/**
 * Tenant managers need actionable health only. Provider-process metrics,
 * release SHAs, fleet topology, and process timing details remain in the
 * audited superuser control plane. The existing heartbeat field is populated
 * with the trustworthy database-observed time.
 */
export function serializeWorkerHeartbeatFleetForTenant(snapshot: WorkerHeartbeatFleetSnapshot) {
  const representative = snapshot.representative;
  return representative
    ? {
        status: representative.status,
        fresh: snapshot.ready,
        heartbeatAtUtc: representative.observedAtUtc ?? representative.heartbeatAtUtc,
      }
    : null;
}
