-- Preserve the original one-row-per-worker heartbeat contract for rolling
-- compatibility while recording every process instance that writes through
-- it. An old worker binary therefore participates in fleet readiness without
-- needing to know that the mirror exists.

CREATE TABLE "WorkerHeartbeatInstance" (
  "workerKey" VARCHAR(64) NOT NULL,
  "instanceRefHash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "startedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "cycleStartedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "heartbeatAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "observedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "lastCycleDurationMs" INTEGER,
  "releaseSha" VARCHAR(40),
  "metrics" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "WorkerHeartbeatInstance_pkey"
    PRIMARY KEY ("workerKey", "instanceRefHash"),
  CONSTRAINT "WorkerHeartbeatInstance_status_check"
    CHECK ("status" IN ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED')),
  CONSTRAINT "WorkerHeartbeatInstance_cycle_duration_check"
    CHECK ("lastCycleDurationMs" IS NULL OR "lastCycleDurationMs" >= 0),
  CONSTRAINT "WorkerHeartbeatInstance_release_sha_check"
    CHECK ("releaseSha" IS NULL OR "releaseSha" ~ '^[a-f0-9]{40}$')
);

CREATE INDEX "WorkerHeartbeatInstance_worker_observed_idx"
  ON "WorkerHeartbeatInstance"("workerKey", "observedAtUtc" DESC);
CREATE INDEX "WorkerHeartbeatInstance_observed_idx"
  ON "WorkerHeartbeatInstance"("observedAtUtc");

-- Default privileges in an existing cluster may be broader than this model
-- needs. The runtime can inspect the content-free mirror, but all writes are
-- mediated by the trigger or the fixed-policy cleanup function below.
REVOKE ALL PRIVILEGES ON TABLE "WorkerHeartbeatInstance" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE "WorkerHeartbeatInstance" FROM quotefly_runtime;
GRANT SELECT ON TABLE "WorkerHeartbeatInstance" TO quotefly_runtime;

CREATE FUNCTION public.quotefly_mirror_worker_heartbeat_instance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."WorkerHeartbeatInstance" AS instance (
    "workerKey",
    "instanceRefHash",
    "status",
    "startedAtUtc",
    "cycleStartedAtUtc",
    "heartbeatAtUtc",
    "observedAtUtc",
    "lastCycleDurationMs",
    "releaseSha",
    "metrics",
    "updatedAt"
  ) VALUES (
    NEW."workerKey",
    NEW."instanceRefHash",
    NEW."status",
    NEW."startedAtUtc",
    NEW."cycleStartedAtUtc",
    NEW."heartbeatAtUtc",
    clock_timestamp(),
    NEW."lastCycleDurationMs",
    CASE
      WHEN jsonb_typeof(NEW."metrics" -> 'releaseSha') = 'string'
        AND lower(btrim(NEW."metrics" ->> 'releaseSha')) ~ '^[a-f0-9]{40}$'
        THEN lower(btrim(NEW."metrics" ->> 'releaseSha'))
      ELSE NULL
    END,
    NEW."metrics",
    NEW."updatedAt"
  )
  ON CONFLICT ("workerKey", "instanceRefHash") DO UPDATE SET
    "status" = EXCLUDED."status",
    "startedAtUtc" = EXCLUDED."startedAtUtc",
    "cycleStartedAtUtc" = EXCLUDED."cycleStartedAtUtc",
    "heartbeatAtUtc" = EXCLUDED."heartbeatAtUtc",
    "observedAtUtc" = EXCLUDED."observedAtUtc",
    "lastCycleDurationMs" = EXCLUDED."lastCycleDurationMs",
    "releaseSha" = EXCLUDED."releaseSha",
    "metrics" = EXCLUDED."metrics",
    "updatedAt" = EXCLUDED."updatedAt";

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.quotefly_mirror_worker_heartbeat_instance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quotefly_mirror_worker_heartbeat_instance() FROM quotefly_runtime;

CREATE TRIGGER "WorkerHeartbeat_instance_mirror"
AFTER INSERT OR UPDATE ON "WorkerHeartbeat"
FOR EACH ROW
EXECUTE FUNCTION public.quotefly_mirror_worker_heartbeat_instance();

-- Seed the mirror from the currently visible singleton. This is intentionally
-- additive; no existing heartbeat row or API contract is changed.
INSERT INTO "WorkerHeartbeatInstance" (
  "workerKey",
  "instanceRefHash",
  "status",
  "startedAtUtc",
  "cycleStartedAtUtc",
  "heartbeatAtUtc",
  "observedAtUtc",
  "lastCycleDurationMs",
  "releaseSha",
  "metrics",
  "updatedAt"
)
SELECT
  "workerKey",
  "instanceRefHash",
  "status",
  "startedAtUtc",
  "cycleStartedAtUtc",
  "heartbeatAtUtc",
  -- Do not let a worker-supplied future timestamp make a migrated singleton
  -- appear fresh. The next real write receives a new database observation.
  LEAST(clock_timestamp(), "heartbeatAtUtc"),
  "lastCycleDurationMs",
  CASE
    WHEN jsonb_typeof("metrics" -> 'releaseSha') = 'string'
      AND lower(btrim("metrics" ->> 'releaseSha')) ~ '^[a-f0-9]{40}$'
      THEN lower(btrim("metrics" ->> 'releaseSha'))
    ELSE NULL
  END,
  "metrics",
  "updatedAt"
FROM "WorkerHeartbeat"
ON CONFLICT ("workerKey", "instanceRefHash") DO NOTHING;

-- Runtime callers cannot choose a cutoff or row limit. Retention is fixed at
-- 30 days and each invocation removes at most 100 rows under one advisory
-- lock, keeping cleanup safe when multiple workers overlap.
CREATE FUNCTION public.quotefly_purge_worker_heartbeat_instances()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  acquired boolean;
  deleted_count integer := 0;
BEGIN
  SELECT pg_try_advisory_xact_lock(
    hashtextextended('quotefly:worker-heartbeat-instance-retention', 0)
  ) INTO acquired;

  IF NOT acquired THEN
    RETURN 0;
  END IF;

  WITH candidates AS (
    SELECT instance."workerKey", instance."instanceRefHash"
    FROM public."WorkerHeartbeatInstance" instance
    WHERE instance."observedAtUtc" <= clock_timestamp() - INTERVAL '30 days'
    ORDER BY instance."observedAtUtc" ASC,
      instance."workerKey" ASC,
      instance."instanceRefHash" ASC
    LIMIT 100
  )
  DELETE FROM public."WorkerHeartbeatInstance" instance
  USING candidates
  WHERE instance."workerKey" = candidates."workerKey"
    AND instance."instanceRefHash" = candidates."instanceRefHash"
    AND instance."observedAtUtc" <= clock_timestamp() - INTERVAL '30 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

REVOKE ALL ON FUNCTION public.quotefly_purge_worker_heartbeat_instances() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quotefly_purge_worker_heartbeat_instances()
  TO quotefly_runtime;
