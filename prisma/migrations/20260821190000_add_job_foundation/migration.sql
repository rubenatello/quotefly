-- Phase 2A job foundation. Jobs are separate operational records created
-- from accepted quotes; accepted quotes remain the commercial source of truth.

CREATE TYPE "JobStatus" AS ENUM (
    'UNSCHEDULED',
    'SCHEDULED',
    'DISPATCHED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELED'
);

CREATE TYPE "JobEventType" AS ENUM (
    'CREATED',
    'UPDATED',
    'ASSIGNED',
    'CANCELED',
    'ARCHIVED',
    'DELETED'
);

CREATE TABLE "TenantSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSequence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantSequence_next_value_check" CHECK ("nextValue" >= 1),
    CONSTRAINT "TenantSequence_key_check" CHECK (char_length(btrim("key")) > 0)
);

CREATE UNIQUE INDEX "TenantSequence_id_tenantId_key"
    ON "TenantSequence"("id", "tenantId");

CREATE UNIQUE INDEX "TenantSequence_tenantId_key_key"
    ON "TenantSequence"("tenantId", "key");

CREATE INDEX "TenantSequence_tenant_key_idx"
    ON "TenantSequence"("tenantId", "key");

ALTER TABLE "TenantSequence"
    ADD CONSTRAINT "TenantSequence_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceQuoteId" TEXT NOT NULL,
    "assignedTenantUserId" TEXT,
    "jobNumber" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'UNSCHEDULED',
    "title" VARCHAR(191) NOT NULL,
    "scopeSnapshot" TEXT NOT NULL,
    "serviceType" "ServiceCategory" NOT NULL,
    "serviceAddressSnapshot" TEXT,
    "accessInstructions" VARCHAR(2000),
    "acceptedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "scheduledAtUtc" TIMESTAMPTZ(3),
    "dispatchedAtUtc" TIMESTAMPTZ(3),
    "startedAtUtc" TIMESTAMPTZ(3),
    "completedAtUtc" TIMESTAMPTZ(3),
    "canceledAtUtc" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAtUtc" TIMESTAMPTZ(3),
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Job_number_check" CHECK ("jobNumber" >= 1),
    CONSTRAINT "Job_version_check" CHECK ("version" >= 1),
    CONSTRAINT "Job_title_check" CHECK (char_length(btrim("title")) > 0)
);

CREATE UNIQUE INDEX "Job_id_tenantId_key"
    ON "Job"("id", "tenantId");

CREATE UNIQUE INDEX "Job_tenantId_sourceQuoteId_key"
    ON "Job"("tenantId", "sourceQuoteId");

CREATE UNIQUE INDEX "Job_sourceQuoteId_customerId_tenantId_key"
    ON "Job"("sourceQuoteId", "customerId", "tenantId");

CREATE UNIQUE INDEX "Job_tenantId_jobNumber_key"
    ON "Job"("tenantId", "jobNumber");

CREATE INDEX "Job_assignee_status_updated_idx"
    ON "Job"("tenantId", "assignedTenantUserId", "deletedAtUtc", "archivedAtUtc", "status", "updatedAt" DESC, "id" DESC);

CREATE INDEX "Job_status_updated_idx"
    ON "Job"("tenantId", "deletedAtUtc", "archivedAtUtc", "status", "updatedAt" DESC, "id" DESC);

CREATE INDEX "Job_customer_lifecycle_idx"
    ON "Job"("tenantId", "customerId", "deletedAtUtc", "archivedAtUtc");

CREATE INDEX "Job_source_quote_idx"
    ON "Job"("tenantId", "sourceQuoteId");

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId")
    REFERENCES "Customer"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_sourceQuoteId_customerId_tenantId_fkey"
    FOREIGN KEY ("sourceQuoteId", "customerId", "tenantId")
    REFERENCES "Quote"("id", "customerId", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_assignedTenantUserId_tenantId_fkey"
    FOREIGN KEY ("assignedTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actorTenantUserId" TEXT NOT NULL,
    "type" "JobEventType" NOT NULL,
    "fromStatus" "JobStatus",
    "toStatus" "JobStatus",
    "requestId" VARCHAR(191) NOT NULL,
    "commandKeyHash" VARCHAR(64) NOT NULL,
    "commandPayloadHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobEvent_command_key_hash_check" CHECK ("commandKeyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "JobEvent_command_payload_hash_check" CHECK ("commandPayloadHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "JobEvent_tenantId_commandKeyHash_key"
    ON "JobEvent"("tenantId", "commandKeyHash");

CREATE INDEX "JobEvent_job_created_idx"
    ON "JobEvent"("tenantId", "jobId", "createdAt", "id");

CREATE INDEX "JobEvent_actor_created_idx"
    ON "JobEvent"("tenantId", "actorTenantUserId", "createdAt");

ALTER TABLE "JobEvent"
    ADD CONSTRAINT "JobEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobEvent"
    ADD CONSTRAINT "JobEvent_jobId_tenantId_fkey"
    FOREIGN KEY ("jobId", "tenantId")
    REFERENCES "Job"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobEvent"
    ADD CONSTRAINT "JobEvent_actorTenantUserId_tenantId_fkey"
    FOREIGN KEY ("actorTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

WITH accepted_quotes AS (
    SELECT
        quote.*,
        ROW_NUMBER() OVER (
            PARTITION BY quote."tenantId"
            ORDER BY COALESCE(quote."closedAtUtc", quote."updatedAt", quote."createdAt"), quote."createdAt", quote."id"
        ) AS "jobNumber"
    FROM "Quote" quote
    WHERE quote."status" = 'ACCEPTED'
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
)
INSERT INTO "Job" (
    "id",
    "tenantId",
    "customerId",
    "sourceQuoteId",
    "assignedTenantUserId",
    "jobNumber",
    "status",
    "title",
    "scopeSnapshot",
    "serviceType",
    "acceptedAtUtc",
    "completedAtUtc",
    "createdAt",
    "updatedAt"
)
SELECT
    'job_' || accepted_quotes."id",
    accepted_quotes."tenantId",
    accepted_quotes."customerId",
    accepted_quotes."id",
    accepted_quotes."assignedTenantUserId",
    accepted_quotes."jobNumber"::INTEGER,
    CASE accepted_quotes."jobStatus"
        WHEN 'SCHEDULED' THEN 'SCHEDULED'::"JobStatus"
        WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'::"JobStatus"
        WHEN 'COMPLETED' THEN 'COMPLETED'::"JobStatus"
        ELSE 'UNSCHEDULED'::"JobStatus"
    END,
    COALESCE(LEFT(NULLIF(btrim(accepted_quotes."title"), ''), 191), LEFT('Accepted quote ' || accepted_quotes."id", 191)),
    accepted_quotes."scopeText",
    accepted_quotes."serviceType",
    COALESCE(accepted_quotes."closedAtUtc", accepted_quotes."updatedAt", accepted_quotes."createdAt"),
    CASE WHEN accepted_quotes."jobStatus" = 'COMPLETED' THEN accepted_quotes."jobCompletedAtUtc" ELSE NULL END,
    accepted_quotes."createdAt",
    accepted_quotes."updatedAt"
FROM accepted_quotes
ON CONFLICT ("tenantId", "sourceQuoteId") DO NOTHING;

WITH inserted_jobs AS (
    SELECT
        job."tenantId",
        job."id",
        job."sourceQuoteId",
        job."status",
        quote."assignedTenantUserId",
        COALESCE(quote."closedAtUtc", quote."updatedAt", quote."createdAt") AS "acceptedAtUtc"
    FROM "Job" job
    INNER JOIN "Quote" quote
        ON quote."id" = job."sourceQuoteId"
       AND quote."tenantId" = job."tenantId"
    WHERE quote."status" = 'ACCEPTED'
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
      AND job."id" = 'job_' || quote."id"
),
tenant_actors AS (
    SELECT DISTINCT ON ("tenantId")
        "tenantId",
        "id" AS "actorTenantUserId"
    FROM "TenantUser"
    WHERE "deletedAtUtc" IS NULL
    ORDER BY "tenantId", CASE WHEN "role" = 'owner' THEN 0 WHEN "role" = 'admin' THEN 1 ELSE 2 END, "createdAt", "id"
)
INSERT INTO "JobEvent" (
    "id",
    "tenantId",
    "jobId",
    "actorTenantUserId",
    "type",
    "toStatus",
    "requestId",
    "commandKeyHash",
    "commandPayloadHash",
    "createdAt"
)
SELECT
    'jobevt_' || inserted_jobs."sourceQuoteId",
    inserted_jobs."tenantId",
    inserted_jobs."id",
    COALESCE(inserted_jobs."assignedTenantUserId", tenant_actors."actorTenantUserId"),
    'CREATED'::"JobEventType",
    inserted_jobs."status",
    'migration:20260821190000',
    repeat(md5('job-created:' || inserted_jobs."tenantId" || ':' || inserted_jobs."id"), 2),
    repeat(md5('job-created-payload:' || inserted_jobs."tenantId" || ':' || inserted_jobs."id"), 2),
    inserted_jobs."acceptedAtUtc"
FROM inserted_jobs
INNER JOIN tenant_actors
    ON tenant_actors."tenantId" = inserted_jobs."tenantId"
ON CONFLICT ("tenantId", "commandKeyHash") DO NOTHING;

INSERT INTO "TenantSequence" (
    "id",
    "tenantId",
    "key",
    "nextValue",
    "createdAt",
    "updatedAt"
)
SELECT
    'tenantseq_' || tenant."id" || '_job_number',
    tenant."id",
    'job_number',
    COALESCE(MAX(job."jobNumber"), 0) + 1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant" tenant
LEFT JOIN "Job" job
    ON job."tenantId" = tenant."id"
GROUP BY tenant."id"
ON CONFLICT ("tenantId", "key") DO UPDATE
SET "nextValue" = GREATEST("TenantSequence"."nextValue", EXCLUDED."nextValue"),
    "updatedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "TenantSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSequence" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "TenantSequence_tenant_isolation" ON "TenantSequence";
CREATE POLICY "TenantSequence_tenant_isolation"
    ON "TenantSequence"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "TenantSequence" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "TenantSequence" TO quotefly_runtime;

ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Job_tenant_isolation" ON "Job";
CREATE POLICY "Job_tenant_isolation"
    ON "Job"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "Job" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "Job" TO quotefly_runtime;

ALTER TABLE "JobEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "JobEvent_tenant_select" ON "JobEvent";
CREATE POLICY "JobEvent_tenant_select"
    ON "JobEvent"
    FOR SELECT
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

DROP POLICY IF EXISTS "JobEvent_tenant_insert" ON "JobEvent";
CREATE POLICY "JobEvent_tenant_insert"
    ON "JobEvent"
    FOR INSERT
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE ALL PRIVILEGES ON "JobEvent" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "JobEvent" TO quotefly_runtime;
