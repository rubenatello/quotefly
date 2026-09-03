import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  loadWorkerHeartbeat,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
} from "../../src/services/worker-heartbeats";

describe("worker heartbeat evidence", () => {
  beforeEach(async () => {
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
});
