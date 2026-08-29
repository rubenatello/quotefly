-- Persist content-free worker liveness so an enabled configuration flag is
-- not mistaken for a running QuickBooks reconciliation process.

CREATE TABLE "WorkerHeartbeat" (
  "workerKey" VARCHAR(64) NOT NULL,
  "instanceRefHash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "startedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "cycleStartedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "heartbeatAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "lastCycleDurationMs" INTEGER,
  "metrics" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerKey"),
  CONSTRAINT "WorkerHeartbeat_status_check"
    CHECK ("status" IN ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED')),
  CONSTRAINT "WorkerHeartbeat_cycle_duration_check"
    CHECK ("lastCycleDurationMs" IS NULL OR "lastCycleDurationMs" >= 0)
);

CREATE INDEX "WorkerHeartbeat_heartbeat_idx"
  ON "WorkerHeartbeat"("heartbeatAtUtc");
