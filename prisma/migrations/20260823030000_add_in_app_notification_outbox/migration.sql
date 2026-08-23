-- Content-minimal, tenant-scoped in-app notification outbox/inbox for job
-- appointment lifecycle changes. This release intentionally has no external
-- delivery channels or provider worker.

CREATE TYPE "NotificationKind" AS ENUM (
    'BOOKED',
    'RESCHEDULED',
    'DISPATCHED',
    'ARRIVED',
    'COMPLETED',
    'CANCELED'
);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('AVAILABLE', 'DELIVERED');

CREATE UNIQUE INDEX "JobEvent_id_tenantId_key" ON "JobEvent"("id", "tenantId");
CREATE UNIQUE INDEX "JobEvent_id_jobId_tenantId_key" ON "JobEvent"("id", "jobId", "tenantId");
CREATE UNIQUE INDEX "JobAppointment_id_jobId_tenantId_key" ON "JobAppointment"("id", "jobId", "tenantId");

CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipientTenantUserId" TEXT NOT NULL,
    "actorTenantUserId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "sourceJobEventId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'IN_APP',
    "templateKey" VARCHAR(64) NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceVersion" INTEGER NOT NULL,
    "startsAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "endsAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" VARCHAR(64) NOT NULL,
    "dedupeKeyHash" VARCHAR(64) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "deliveredAtUtc" TIMESTAMPTZ(3),
    "readAtUtc" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAtUtc" TIMESTAMPTZ(3),
    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationOutbox_in_app_only_check" CHECK ("channel" = 'IN_APP'),
    CONSTRAINT "NotificationOutbox_template_check" CHECK (
        "templateVersion" = 1
        AND "templateKey" = CASE "kind"
            WHEN 'BOOKED' THEN 'job_appointment_booked'
            WHEN 'RESCHEDULED' THEN 'job_appointment_rescheduled'
            WHEN 'DISPATCHED' THEN 'job_appointment_dispatched'
            WHEN 'ARRIVED' THEN 'job_appointment_arrived'
            WHEN 'COMPLETED' THEN 'job_appointment_completed'
            WHEN 'CANCELED' THEN 'job_appointment_canceled'
        END
    ),
    CONSTRAINT "NotificationOutbox_source_version_check" CHECK ("sourceVersion" >= 1),
    CONSTRAINT "NotificationOutbox_schedule_check" CHECK (
        "startsAtUtc" < "endsAtUtc"
        AND char_length(btrim("timeZone")) > 0
    ),
    CONSTRAINT "NotificationOutbox_hashes_check" CHECK (
        "dedupeKeyHash" ~ '^[0-9a-f]{64}$'
        AND "payloadHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "NotificationOutbox_delivery_check" CHECK (
        ("deliveryStatus" = 'AVAILABLE' AND "deliveredAtUtc" IS NULL)
        OR ("deliveryStatus" = 'DELIVERED' AND "deliveredAtUtc" IS NOT NULL)
    ),
    CONSTRAINT "NotificationOutbox_read_check" CHECK (
        "readAtUtc" IS NULL
        OR ("deliveryStatus" = 'DELIVERED' AND "deliveredAtUtc" IS NOT NULL)
    ),
    CONSTRAINT "NotificationOutbox_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "NotificationOutbox_tenantId_dedupeKeyHash_key"
    ON "NotificationOutbox"("tenantId", "dedupeKeyHash");
CREATE INDEX "NotificationOutbox_recipient_created_idx"
    ON "NotificationOutbox"("tenantId", "recipientTenantUserId", "archivedAtUtc", "createdAt" DESC, "id" DESC);
CREATE INDEX "NotificationOutbox_recipient_unread_idx"
    ON "NotificationOutbox"("tenantId", "recipientTenantUserId", "readAtUtc", "archivedAtUtc", "createdAt" DESC, "id" DESC);
CREATE INDEX "NotificationOutbox_job_created_idx"
    ON "NotificationOutbox"("tenantId", "jobId", "createdAt" DESC);
CREATE INDEX "NotificationOutbox_appointment_version_idx"
    ON "NotificationOutbox"("tenantId", "appointmentId", "sourceVersion");
CREATE INDEX "NotificationOutbox_source_event_idx"
    ON "NotificationOutbox"("tenantId", "sourceJobEventId");

ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_recipientTenantUserId_tenantId_fkey"
    FOREIGN KEY ("recipientTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_actorTenantUserId_tenantId_fkey"
    FOREIGN KEY ("actorTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_jobId_tenantId_fkey"
    FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_appointmentId_jobId_tenantId_fkey"
    FOREIGN KEY ("appointmentId", "jobId", "tenantId") REFERENCES "JobAppointment"("id", "jobId", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_sourceJobEventId_jobId_tenantId_fkey"
    FOREIGN KEY ("sourceJobEventId", "jobId", "tenantId") REFERENCES "JobEvent"("id", "jobId", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION quotefly_enforce_notification_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."recipientTenantUserId" IS DISTINCT FROM OLD."recipientTenantUserId"
       OR NEW."actorTenantUserId" IS DISTINCT FROM OLD."actorTenantUserId"
       OR NEW."jobId" IS DISTINCT FROM OLD."jobId"
       OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
       OR NEW."sourceJobEventId" IS DISTINCT FROM OLD."sourceJobEventId"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."channel" IS DISTINCT FROM OLD."channel"
       OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey"
       OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
       OR NEW."sourceVersion" IS DISTINCT FROM OLD."sourceVersion"
       OR NEW."startsAtUtc" IS DISTINCT FROM OLD."startsAtUtc"
       OR NEW."endsAtUtc" IS DISTINCT FROM OLD."endsAtUtc"
       OR NEW."timeZone" IS DISTINCT FROM OLD."timeZone"
       OR NEW."dedupeKeyHash" IS DISTINCT FROM OLD."dedupeKeyHash"
       OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Notification identity and source payload are immutable'
            USING ERRCODE = '42501';
    END IF;
    IF (OLD."deliveryStatus" = 'DELIVERED' AND NEW."deliveryStatus" <> 'DELIVERED')
       OR (OLD."deliveredAtUtc" IS NOT NULL AND NEW."deliveredAtUtc" IS DISTINCT FROM OLD."deliveredAtUtc")
       OR (OLD."readAtUtc" IS NOT NULL AND NEW."readAtUtc" IS DISTINCT FROM OLD."readAtUtc")
       OR (OLD."archivedAtUtc" IS NOT NULL AND NEW."archivedAtUtc" IS DISTINCT FROM OLD."archivedAtUtc")
       OR NEW."version" <> OLD."version" + 1
       OR NEW."updatedAt" < OLD."updatedAt" THEN
        RAISE EXCEPTION 'Notification delivery, read, and archive state is monotonic'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "NotificationOutbox_identity_immutable"
BEFORE UPDATE ON "NotificationOutbox"
FOR EACH ROW
EXECUTE FUNCTION quotefly_enforce_notification_identity_immutable();

ALTER TABLE "NotificationOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationOutbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY "NotificationOutbox_tenant_isolation" ON "NotificationOutbox"
    FOR ALL
    USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
    WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE DELETE, TRUNCATE ON "NotificationOutbox" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "NotificationOutbox" TO quotefly_runtime;
