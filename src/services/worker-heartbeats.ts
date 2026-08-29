import type { Prisma, PrismaClient } from "@prisma/client";

export const QUICKBOOKS_RECONCILIATION_WORKER_KEY = "quickbooks-reconciliation";
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 60_000;

export type WorkerHeartbeatStatus = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED";

export type WorkerHeartbeatSnapshot = Readonly<{
  status: WorkerHeartbeatStatus;
  fresh: boolean;
  heartbeatAtUtc: Date;
  startedAtUtc: Date;
  cycleStartedAtUtc: Date;
  lastCycleDurationMs: number | null;
  metrics: Prisma.JsonValue;
}>;

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
  const status = row.status as WorkerHeartbeatStatus;
  return {
    ...row,
    status,
    fresh: (status === "STARTING" || status === "RUNNING")
      && now.getTime() - row.heartbeatAtUtc.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS,
  };
}

export function serializeWorkerHeartbeat(snapshot: WorkerHeartbeatSnapshot | null) {
  return snapshot
    ? {
        status: snapshot.status,
        fresh: snapshot.fresh,
        heartbeatAtUtc: snapshot.heartbeatAtUtc,
        startedAtUtc: snapshot.startedAtUtc,
        cycleStartedAtUtc: snapshot.cycleStartedAtUtc,
        lastCycleDurationMs: snapshot.lastCycleDurationMs,
        metrics: snapshot.metrics,
      }
    : null;
}
