import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  loadWorkerHeartbeat,
  loadWorkerHeartbeatFleet,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
  runWorkerHeartbeatInstanceRetention,
  serializeWorkerHeartbeatFleet,
  WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
} from "../../src/services/worker-heartbeats";

describe("worker heartbeat evidence", () => {
  beforeEach(async () => {
    await prisma.workerHeartbeatInstance.deleteMany();
    await prisma.workerHeartbeat.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("distinguishes a running worker from a configured but stale process", async () => {
    const startedAtUtc = new Date("2026-08-28T12:00:00.000Z");
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "a".repeat(64),
      status: "RUNNING",
      startedAtUtc,
      cycleStartedAtUtc: startedAtUtc,
      heartbeatAtUtc: startedAtUtc,
      metrics: { dueEventCount: 0 },
    });

    await expect(loadWorkerHeartbeat(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      new Date(startedAtUtc.getTime() + WORKER_HEARTBEAT_STALE_AFTER_MS),
    )).resolves.toMatchObject({ status: "RUNNING", fresh: true, metrics: { dueEventCount: 0 } });

    await expect(loadWorkerHeartbeat(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      new Date(startedAtUtc.getTime() + WORKER_HEARTBEAT_STALE_AFTER_MS + 1),
    )).resolves.toMatchObject({ status: "RUNNING", fresh: false });
  });

  test("terminal worker status is unhealthy even when its heartbeat is recent", async () => {
    const now = new Date("2026-08-28T13:00:00.000Z");
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "b".repeat(64),
      status: "FAILED",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: { errorName: "SyntheticFailure" },
    });

    await expect(loadWorkerHeartbeat(prisma, QUICKBOOKS_RECONCILIATION_WORKER_KEY, now))
      .resolves.toMatchObject({ status: "FAILED", fresh: false });
  });

  test("an independent refresh keeps a long-running worker healthy beyond the stale window", async () => {
    const startedAtUtc = new Date("2026-09-03T14:00:00.000Z");
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "c".repeat(64),
      status: "RUNNING",
      startedAtUtc,
      cycleStartedAtUtc: startedAtUtc,
      heartbeatAtUtc: startedAtUtc,
      metrics: { phase: "provider_work" },
    });
    const refreshedAtUtc = new Date(startedAtUtc.getTime() + 75_000);
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "c".repeat(64),
      status: "RUNNING",
      startedAtUtc,
      cycleStartedAtUtc: startedAtUtc,
      heartbeatAtUtc: refreshedAtUtc,
      metrics: { phase: "provider_work" },
    });

    await expect(loadWorkerHeartbeat(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      new Date(startedAtUtc.getTime() + 120_000),
    )).resolves.toMatchObject({ status: "RUNNING", fresh: true });
  });

  test("mirrors legacy singleton writes per instance and normalizes release identity", async () => {
    const now = new Date("2026-09-03T16:00:00.000Z");
    const releaseSha = "a".repeat(40);
    const observedBefore = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "1".repeat(64),
      status: "RUNNING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: { releaseSha: releaseSha.toUpperCase(), phase: "legacy_writer" },
    });
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "2".repeat(64),
      status: "STARTING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: new Date(now.getTime() + 1),
      metrics: { releaseSha, phase: "new_writer" },
    });

    const observedAfter = new Date();
    await expect(prisma.workerHeartbeat.count()).resolves.toBe(1);
    const mirrored = await prisma.workerHeartbeatInstance.findMany({
      select: { status: true, releaseSha: true, observedAtUtc: true },
    });
    expect(mirrored).toHaveLength(2);
    expect(mirrored.map(({ status }) => status).sort()).toEqual(["RUNNING", "STARTING"]);
    for (const row of mirrored) {
      expect(row.releaseSha).toBe(releaseSha);
      expect(row.observedAtUtc.getTime()).toBeGreaterThanOrEqual(observedBefore.getTime());
      expect(row.observedAtUtc.getTime()).toBeLessThanOrEqual(observedAfter.getTime());
    }

    const fleet = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    );
    expect(fleet).toMatchObject({
      ready: true,
      counts: {
        totalInstanceCount: 2,
        freshLiveInstanceCount: 2,
        capacityInstanceCount: 2,
        stoppingInstanceCount: 0,
        staleInstanceCount: 0,
        terminalInstanceCount: 0,
        missingReleaseShaInstanceCount: 0,
        releaseMismatchInstanceCount: 0,
      },
      releaseIdentity: { apiReleaseSha: releaseSha, workerReleaseSha: releaseSha, matches: true },
    });
    expect(JSON.stringify(serializeWorkerHeartbeatFleet(fleet))).not.toContain("1".repeat(64));
    expect(JSON.stringify(serializeWorkerHeartbeatFleet(fleet))).not.toContain("2".repeat(64));

    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: null, requireReleaseIdentity: true },
    )).resolves.toMatchObject({
      ready: false,
      releaseIdentity: { apiReleaseSha: null, workerReleaseSha: releaseSha, matches: null },
    });
  });

  test("uses database observation time so a future worker timestamp cannot extend freshness", async () => {
    const releaseSha = "a".repeat(40);
    const workerTime = new Date();
    const futureHeartbeatAtUtc = new Date(workerTime.getTime() + 365 * 24 * 60 * 60 * 1_000);
    const observedBefore = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "a".repeat(64),
      status: "RUNNING",
      startedAtUtc: workerTime,
      cycleStartedAtUtc: workerTime,
      heartbeatAtUtc: futureHeartbeatAtUtc,
      metrics: { releaseSha },
    });
    const observedAfter = new Date();

    const initiallyFresh = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    );
    expect(initiallyFresh).toMatchObject({
      ready: true,
      counts: { freshLiveInstanceCount: 1, staleInstanceCount: 0 },
    });
    expect(initiallyFresh.representative?.heartbeatAtUtc).toEqual(futureHeartbeatAtUtc);
    expect(initiallyFresh.representative?.observedAtUtc?.getTime())
      .toBeGreaterThanOrEqual(observedBefore.getTime());
    expect(initiallyFresh.representative?.observedAtUtc?.getTime())
      .toBeLessThanOrEqual(observedAfter.getTime());

    const staleObservedAtUtc = new Date(Date.now() - WORKER_HEARTBEAT_STALE_AFTER_MS - 1_000);
    await prisma.workerHeartbeatInstance.update({
      where: {
        workerKey_instanceRefHash: {
          workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          instanceRefHash: "a".repeat(64),
        },
      },
      data: { observedAtUtc: staleObservedAtUtc },
    });
    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    )).resolves.toMatchObject({
      ready: false,
      counts: { freshLiveInstanceCount: 0, staleInstanceCount: 1 },
    });

    // A later database write with a lower worker-provided timestamp must still
    // replace the future value and restore a trustworthy observation.
    const recoveredHeartbeatAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "a".repeat(64),
      status: "RUNNING",
      startedAtUtc: workerTime,
      cycleStartedAtUtc: workerTime,
      heartbeatAtUtc: recoveredHeartbeatAtUtc,
      metrics: { releaseSha },
    });
    const recovered = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    );
    expect(recovered.ready).toBe(true);
    expect(recovered.representative?.heartbeatAtUtc).toEqual(recoveredHeartbeatAtUtc);
    expect(recovered.representative?.observedAtUtc?.getTime())
      .toBeGreaterThan(staleObservedAtUtc.getTime());
  });

  test("fails fleet readiness for a fresh stopping mismatch even with matching capacity", async () => {
    const now = new Date("2026-09-03T17:00:00.000Z");
    const apiReleaseSha = "a".repeat(40);
    const oldReleaseSha = "b".repeat(40);
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "3".repeat(64),
      status: "STOPPING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: { releaseSha: oldReleaseSha },
    });
    // Write the matching worker last so the compatibility singleton alone
    // would look healthy. Fleet evaluation must still observe the overlap.
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "4".repeat(64),
      status: "RUNNING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: new Date(now.getTime() + 1),
      metrics: { releaseSha: apiReleaseSha },
    });

    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha },
    )).resolves.toMatchObject({
      ready: false,
      counts: {
        capacityInstanceCount: 1,
        stoppingInstanceCount: 1,
        releaseMismatchInstanceCount: 1,
      },
      releaseIdentity: { apiReleaseSha, workerReleaseSha: null, matches: false },
    });
  });

  test("does not treat stopping alone as capacity and fails on a missing live release identity", async () => {
    const now = new Date("2026-09-03T18:00:00.000Z");
    const apiReleaseSha = "a".repeat(40);
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "5".repeat(64),
      status: "STOPPING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: { releaseSha: apiReleaseSha },
    });
    const stoppingOnly = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha },
    );
    expect(stoppingOnly).toMatchObject({
      ready: false,
      counts: { capacityInstanceCount: 0, stoppingInstanceCount: 1 },
      releaseIdentity: { matches: true },
    });

    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "6".repeat(64),
      status: "RUNNING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: new Date(now.getTime() + 1),
      metrics: { releaseSha: "malformed" },
    });
    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha },
    )).resolves.toMatchObject({
      ready: false,
      counts: { capacityInstanceCount: 1, missingReleaseShaInstanceCount: 1 },
      releaseIdentity: { matches: false },
    });
  });

  test("counts stale and terminal instances without letting them block matching capacity", async () => {
    const now = new Date("2026-09-03T19:00:00.000Z");
    const apiReleaseSha = "a".repeat(40);
    const staleAtUtc = new Date(now.getTime() - WORKER_HEARTBEAT_STALE_AFTER_MS - 1);
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "7".repeat(64),
      status: "RUNNING",
      startedAtUtc: staleAtUtc,
      cycleStartedAtUtc: staleAtUtc,
      heartbeatAtUtc: staleAtUtc,
      metrics: { releaseSha: "b".repeat(40) },
    });
    await prisma.workerHeartbeatInstance.update({
      where: {
        workerKey_instanceRefHash: {
          workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          instanceRefHash: "7".repeat(64),
        },
      },
      data: { observedAtUtc: staleAtUtc },
    });
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "8".repeat(64),
      status: "FAILED",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: {},
    });
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "9".repeat(64),
      status: "RUNNING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: new Date(now.getTime() + 1),
      metrics: { releaseSha: apiReleaseSha },
    });

    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha },
    )).resolves.toMatchObject({
      ready: true,
      counts: {
        capacityInstanceCount: 1,
        staleInstanceCount: 1,
        terminalInstanceCount: 1,
        releaseMismatchInstanceCount: 0,
      },
    });
  });

  test("fails closed when the fresh live fleet exceeds its fixed ceiling", async () => {
    const now = new Date();
    const releaseSha = "a".repeat(40);
    await prisma.workerHeartbeatInstance.createMany({
      data: Array.from({ length: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1 }, (_, index) => ({
        workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
        instanceRefHash: index.toString(16).padStart(64, "0"),
        status: "RUNNING",
        startedAtUtc: now,
        cycleStartedAtUtc: now,
        heartbeatAtUtc: now,
        observedAtUtc: now,
        lastCycleDurationMs: null,
        releaseSha,
        metrics: { representativeMarker: index },
        updatedAt: now,
      })),
    });

    const overflowed = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    );
    expect(overflowed).toMatchObject({
      ready: false,
      freshLiveLimit: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
      freshLiveOverflowed: true,
      counts: {
        freshLiveInstanceCount: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1,
        capacityInstanceCount: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT + 1,
        overflowedFreshLiveInstanceCount: 1,
      },
      releaseIdentity: { matches: true },
    });
    expect(serializeWorkerHeartbeatFleet(overflowed)).toMatchObject({
      fresh: false,
      fleet: {
        freshLiveInstanceLimit: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
        freshLiveOverflowed: true,
        overflowedFreshLiveInstanceCount: 1,
      },
    });

    await prisma.workerHeartbeatInstance.update({
      where: {
        workerKey_instanceRefHash: {
          workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          instanceRefHash: "0".repeat(64),
        },
      },
      data: { status: "STOPPED" },
    });
    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    )).resolves.toMatchObject({
      ready: true,
      freshLiveOverflowed: false,
      counts: {
        freshLiveInstanceCount: WORKER_HEARTBEAT_FRESH_LIVE_LIMIT,
        terminalInstanceCount: 1,
        overflowedFreshLiveInstanceCount: 0,
      },
    });
  });

  test("returns fixed-shape fleet evidence with one representative metrics object for thousands of terminal rows", async () => {
    const terminalAtUtc = new Date("2020-01-01T00:00:00.000Z");
    const releaseSha = "a".repeat(40);
    await prisma.workerHeartbeatInstance.createMany({
      data: Array.from({ length: 2_000 }, (_, index) => ({
        workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
        instanceRefHash: index.toString(16).padStart(64, "0"),
        status: "STOPPED",
        startedAtUtc: terminalAtUtc,
        cycleStartedAtUtc: terminalAtUtc,
        heartbeatAtUtc: terminalAtUtc,
        observedAtUtc: terminalAtUtc,
        lastCycleDurationMs: null,
        releaseSha: null,
        metrics: { terminalSequence: index },
        updatedAt: terminalAtUtc,
      })),
    });
    const now = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "f".repeat(64),
      status: "RUNNING",
      startedAtUtc: now,
      cycleStartedAtUtc: now,
      heartbeatAtUtc: now,
      metrics: { releaseSha, activeRepresentative: true },
    });

    const fleet = await loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    );
    expect(fleet).toMatchObject({
      ready: true,
      counts: {
        totalInstanceCount: 2_001,
        freshLiveInstanceCount: 1,
        capacityInstanceCount: 1,
        terminalInstanceCount: 2_000,
      },
      representative: { metrics: { activeRepresentative: true } },
    });
    const serialized = JSON.stringify(serializeWorkerHeartbeatFleet(fleet));
    expect(serialized).toContain('"activeRepresentative":true');
    expect(serialized).not.toContain("terminalSequence");
    expect(serialized).not.toContain("f".repeat(64));
    expect(serialized.length).toBeLessThan(2_000);
  });

  test("restricts runtime mirror access to SELECT and the fixed cleanup function", async () => {
    const [privileges] = await prisma.$queryRaw<Array<{
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      canTruncate: boolean;
      canCleanup: boolean;
      canInvokeMirror: boolean;
      mirrorSecurityDefiner: boolean;
      cleanupSecurityDefiner: boolean;
      mirrorConfig: string;
      cleanupConfig: string;
    }>>(Prisma.sql`
      SELECT
        has_table_privilege('quotefly_runtime', 'public."WorkerHeartbeatInstance"', 'SELECT') AS "canSelect",
        has_table_privilege('quotefly_runtime', 'public."WorkerHeartbeatInstance"', 'INSERT') AS "canInsert",
        has_table_privilege('quotefly_runtime', 'public."WorkerHeartbeatInstance"', 'UPDATE') AS "canUpdate",
        has_table_privilege('quotefly_runtime', 'public."WorkerHeartbeatInstance"', 'DELETE') AS "canDelete",
        has_table_privilege('quotefly_runtime', 'public."WorkerHeartbeatInstance"', 'TRUNCATE') AS "canTruncate",
        has_function_privilege('quotefly_runtime', 'public.quotefly_purge_worker_heartbeat_instances()', 'EXECUTE') AS "canCleanup",
        has_function_privilege('quotefly_runtime', 'public.quotefly_mirror_worker_heartbeat_instance()', 'EXECUTE') AS "canInvokeMirror",
        mirror.prosecdef AS "mirrorSecurityDefiner",
        cleanup.prosecdef AS "cleanupSecurityDefiner",
        mirror.proconfig::text AS "mirrorConfig",
        cleanup.proconfig::text AS "cleanupConfig"
      FROM pg_proc mirror
      INNER JOIN pg_namespace mirror_namespace ON mirror_namespace.oid = mirror.pronamespace
      CROSS JOIN pg_proc cleanup
      INNER JOIN pg_namespace cleanup_namespace ON cleanup_namespace.oid = cleanup.pronamespace
      WHERE mirror_namespace.nspname = 'public'
        AND mirror.proname = 'quotefly_mirror_worker_heartbeat_instance'
        AND cleanup_namespace.nspname = 'public'
        AND cleanup.proname = 'quotefly_purge_worker_heartbeat_instances'
    `);
    expect(privileges).toMatchObject({
      canSelect: true,
      canInsert: false,
      canUpdate: false,
      canDelete: false,
      canTruncate: false,
      canCleanup: true,
      canInvokeMirror: false,
      mirrorSecurityDefiner: true,
      cleanupSecurityDefiner: true,
    });
    expect(privileges?.mirrorConfig).toContain("search_path=pg_catalog, public");
    expect(privileges?.cleanupConfig).toContain("search_path=pg_catalog, public");

    const indexes = await prisma.$queryRaw<Array<{ indexName: string; indexDefinition: string }>>(Prisma.sql`
      SELECT indexname AS "indexName", indexdef AS "indexDefinition"
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'WorkerHeartbeatInstance'
    `);
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        indexName: "WorkerHeartbeatInstance_worker_observed_idx",
        indexDefinition: expect.stringContaining('("workerKey", "observedAtUtc" DESC)'),
      }),
      expect.objectContaining({
        indexName: "WorkerHeartbeatInstance_observed_idx",
        indexDefinition: expect.stringContaining('("observedAtUtc")'),
      }),
    ]));

    await expect(prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "WorkerHeartbeatInstance" (
          "workerKey", "instanceRefHash", "status", "startedAtUtc", "cycleStartedAtUtc",
          "heartbeatAtUtc", "observedAtUtc", "lastCycleDurationMs", "releaseSha", "metrics", "updatedAt"
        ) VALUES (
          ${QUICKBOOKS_RECONCILIATION_WORKER_KEY}, ${"f".repeat(64)}, 'RUNNING', NOW(), NOW(),
          NOW(), NOW(), NULL, ${"a".repeat(40)}, '{}'::jsonb, NOW()
        )
      `);
    })).rejects.toThrow(/permission denied/i);

    const releaseSha = "a".repeat(40);
    const observedBefore = new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "WorkerHeartbeat" (
          "workerKey", "instanceRefHash", "status", "startedAtUtc", "cycleStartedAtUtc",
          "heartbeatAtUtc", "lastCycleDurationMs", "metrics", "updatedAt"
        ) VALUES (
          ${QUICKBOOKS_RECONCILIATION_WORKER_KEY}, ${"e".repeat(64)}, 'RUNNING',
          clock_timestamp(), clock_timestamp(), clock_timestamp(), NULL,
          jsonb_build_object('releaseSha', ${releaseSha.toUpperCase()}::text, 'legacyRuntime', true),
          clock_timestamp()
        )
        ON CONFLICT ("workerKey") DO UPDATE SET
          "instanceRefHash" = EXCLUDED."instanceRefHash",
          "status" = EXCLUDED."status",
          "startedAtUtc" = EXCLUDED."startedAtUtc",
          "cycleStartedAtUtc" = EXCLUDED."cycleStartedAtUtc",
          "heartbeatAtUtc" = EXCLUDED."heartbeatAtUtc",
          "lastCycleDurationMs" = EXCLUDED."lastCycleDurationMs",
          "metrics" = EXCLUDED."metrics",
          "updatedAt" = EXCLUDED."updatedAt"
      `);
    });
    const observedAfter = new Date();
    const runtimeMirror = await prisma.workerHeartbeatInstance.findFirst({
      where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY },
      select: {
        status: true,
        releaseSha: true,
        observedAtUtc: true,
        metrics: true,
      },
    });
    expect(runtimeMirror).toMatchObject({
      status: "RUNNING",
      releaseSha,
      metrics: { releaseSha: releaseSha.toUpperCase(), legacyRuntime: true },
    });
    expect(runtimeMirror?.observedAtUtc.getTime()).toBeGreaterThanOrEqual(observedBefore.getTime());
    expect(runtimeMirror?.observedAtUtc.getTime()).toBeLessThanOrEqual(observedAfter.getTime());
    await expect(loadWorkerHeartbeatFleet(
      prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha: releaseSha },
    )).resolves.toMatchObject({ ready: true });
  });

  test("cleanup is lock-safe, retains 30 days, and removes at most 100 rows", async () => {
    const staleAtUtc = new Date("2020-01-01T00:00:00.000Z");
    const freshAtUtc = new Date();
    await prisma.workerHeartbeatInstance.createMany({
      data: [
        ...Array.from({ length: 101 }, (_, index) => ({
          workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          instanceRefHash: index.toString(16).padStart(64, "0"),
          status: "STOPPED",
          startedAtUtc: staleAtUtc,
          cycleStartedAtUtc: staleAtUtc,
          heartbeatAtUtc: staleAtUtc,
          observedAtUtc: staleAtUtc,
          lastCycleDurationMs: null,
          releaseSha: null,
          metrics: {},
          updatedAt: staleAtUtc,
        })),
        {
          workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          instanceRefHash: "e".repeat(64),
          status: "RUNNING",
          startedAtUtc: freshAtUtc,
          cycleStartedAtUtc: freshAtUtc,
          heartbeatAtUtc: freshAtUtc,
          observedAtUtc: freshAtUtc,
          lastCycleDurationMs: null,
          releaseSha: "a".repeat(40),
          metrics: {},
          updatedAt: freshAtUtc,
        },
      ],
    });

    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended('quotefly:worker-heartbeat-instance-retention', 0)
        )
      `);
      await expect(runWorkerHeartbeatInstanceRetention(prisma)).resolves.toBe(0);
    });

    await expect(runWorkerHeartbeatInstanceRetention(prisma)).resolves.toBe(100);
    await expect(prisma.workerHeartbeatInstance.count()).resolves.toBe(2);
    await expect(runWorkerHeartbeatInstanceRetention(prisma)).resolves.toBe(1);
    await expect(prisma.workerHeartbeatInstance.findMany({
      select: { instanceRefHash: true },
    })).resolves.toEqual([{ instanceRefHash: "e".repeat(64) }]);
  });
});
