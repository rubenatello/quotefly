-- Phase 3A job booking foundation: appointments and notes.

CREATE TYPE "JobAppointmentStatus" AS ENUM (
    'SCHEDULED',
    'DISPATCHED',
    'ARRIVED',
    'COMPLETED',
    'CANCELED'
);

ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CREATED';
ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_UPDATED';
ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CANCELED';
ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'NOTE_ADDED';
ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'NOTE_DELETED';

CREATE TABLE "JobAppointment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignedTenantUserId" TEXT NOT NULL,
    "createdByTenantUserId" TEXT NOT NULL,
    "status" "JobAppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "endsAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" VARCHAR(64) NOT NULL,
    "instructions" VARCHAR(2000),
    "dispatchedAtUtc" TIMESTAMPTZ(3),
    "arrivedAtUtc" TIMESTAMPTZ(3),
    "completedAtUtc" TIMESTAMPTZ(3),
    "canceledAtUtc" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "JobAppointment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobAppointment_time_order_check" CHECK ("startsAtUtc" < "endsAtUtc"),
    CONSTRAINT "JobAppointment_duration_check" CHECK ("endsAtUtc" <= "startsAtUtc" + INTERVAL '14 days'),
    CONSTRAINT "JobAppointment_timezone_check" CHECK (char_length(btrim("timeZone")) > 0),
    CONSTRAINT "JobAppointment_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "JobAppointment_id_tenantId_key"
    ON "JobAppointment"("id", "tenantId");

CREATE INDEX "JobAppointment_job_start_idx"
    ON "JobAppointment"("tenantId", "jobId", "deletedAtUtc", "startsAtUtc", "id");

CREATE INDEX "JobAppointment_assignee_status_start_idx"
    ON "JobAppointment"("tenantId", "assignedTenantUserId", "deletedAtUtc", "status", "startsAtUtc", "id");

CREATE INDEX "JobAppointment_tenant_start_idx"
    ON "JobAppointment"("tenantId", "deletedAtUtc", "startsAtUtc", "id");

ALTER TABLE "JobAppointment"
    ADD CONSTRAINT "JobAppointment_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobAppointment"
    ADD CONSTRAINT "JobAppointment_jobId_tenantId_fkey"
    FOREIGN KEY ("jobId", "tenantId")
    REFERENCES "Job"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobAppointment"
    ADD CONSTRAINT "JobAppointment_assignedTenantUserId_tenantId_fkey"
    FOREIGN KEY ("assignedTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobAppointment"
    ADD CONSTRAINT "JobAppointment_createdByTenantUserId_tenantId_fkey"
    FOREIGN KEY ("createdByTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "JobNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdByTenantUserId" TEXT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "JobNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobNote_body_check" CHECK (char_length(btrim("body")) > 0)
);

CREATE UNIQUE INDEX "JobNote_id_tenantId_key"
    ON "JobNote"("id", "tenantId");

CREATE INDEX "JobNote_job_created_idx"
    ON "JobNote"("tenantId", "jobId", "deletedAtUtc", "createdAt" DESC, "id" DESC);

CREATE INDEX "JobNote_creator_created_idx"
    ON "JobNote"("tenantId", "createdByTenantUserId", "createdAt" DESC, "id" DESC);

ALTER TABLE "JobNote"
    ADD CONSTRAINT "JobNote_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobNote"
    ADD CONSTRAINT "JobNote_jobId_tenantId_fkey"
    FOREIGN KEY ("jobId", "tenantId")
    REFERENCES "Job"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobNote"
    ADD CONSTRAINT "JobNote_createdByTenantUserId_tenantId_fkey"
    FOREIGN KEY ("createdByTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobAppointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobAppointment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "JobAppointment_tenant_isolation" ON "JobAppointment";
CREATE POLICY "JobAppointment_tenant_isolation"
    ON "JobAppointment"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "JobAppointment" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "JobAppointment" TO quotefly_runtime;

ALTER TABLE "JobNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobNote" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "JobNote_tenant_isolation" ON "JobNote";
CREATE POLICY "JobNote_tenant_isolation"
    ON "JobNote"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "JobNote" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "JobNote" TO quotefly_runtime;
