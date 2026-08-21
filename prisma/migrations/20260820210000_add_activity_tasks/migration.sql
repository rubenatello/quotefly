-- Assignable activity tasks are operational records, separate from immutable
-- customer history. They are tenant-bound from the first release and fail
-- closed when the API transaction has no app.tenant_id context.

CREATE TYPE "ActivityTaskType" AS ENUM (
    'FOLLOW_UP',
    'PREPARE_QUOTE',
    'SEND_QUOTE',
    'CHECK_IN',
    'CUSTOM'
);

CREATE TYPE "ActivityTaskStatus" AS ENUM (
    'OPEN',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELED'
);

CREATE TYPE "ActivityTaskPriority" AS ENUM (
    'LOW',
    'NORMAL',
    'HIGH',
    'URGENT'
);

CREATE TYPE "ActivityTaskEventType" AS ENUM (
    'CREATED',
    'UPDATED',
    'COMPLETED',
    'REOPENED',
    'CANCELED',
    'DELETED'
);

CREATE TABLE "ActivityTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quoteId" TEXT,
    "assignedTenantUserId" TEXT NOT NULL,
    "createdByTenantUserId" TEXT NOT NULL,
    "completedByTenantUserId" TEXT,
    "type" "ActivityTaskType" NOT NULL,
    "status" "ActivityTaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ActivityTaskPriority" NOT NULL DEFAULT 'NORMAL',
    "title" VARCHAR(160) NOT NULL,
    "notes" VARCHAR(2000),
    "dueAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "completedAtUtc" TIMESTAMPTZ(3),
    "canceledAtUtc" TIMESTAMPTZ(3),
    "sourceKey" VARCHAR(191),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "ActivityTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityTask_version_check" CHECK ("version" >= 1),
    CONSTRAINT "ActivityTask_title_check" CHECK (char_length(btrim("title")) > 0),
    CONSTRAINT "ActivityTask_source_key_check" CHECK (
        "sourceKey" IS NULL OR char_length(btrim("sourceKey")) > 0
    ),
    CONSTRAINT "ActivityTask_completed_state_check" CHECK (
        ("status" = 'COMPLETED' AND "completedAtUtc" IS NOT NULL AND "completedByTenantUserId" IS NOT NULL AND "canceledAtUtc" IS NULL)
        OR ("status" <> 'COMPLETED' AND "completedAtUtc" IS NULL AND "completedByTenantUserId" IS NULL)
    ),
    CONSTRAINT "ActivityTask_canceled_state_check" CHECK (
        ("status" = 'CANCELED' AND "canceledAtUtc" IS NOT NULL AND "completedAtUtc" IS NULL)
        OR ("status" <> 'CANCELED' AND "canceledAtUtc" IS NULL)
    )
);

CREATE UNIQUE INDEX "ActivityTask_id_tenantId_key"
    ON "ActivityTask"("id", "tenantId");

CREATE UNIQUE INDEX "ActivityTask_tenantId_sourceKey_key"
    ON "ActivityTask"("tenantId", "sourceKey");

CREATE UNIQUE INDEX "Quote_id_customerId_tenantId_key"
    ON "Quote"("id", "customerId", "tenantId");

CREATE INDEX "ActivityTask_assignee_status_due_idx"
    ON "ActivityTask"("tenantId", "assignedTenantUserId", "deletedAtUtc", "status", "dueAtUtc", "id");

CREATE INDEX "ActivityTask_status_due_idx"
    ON "ActivityTask"("tenantId", "deletedAtUtc", "status", "dueAtUtc", "id");

CREATE INDEX "ActivityTask_customer_lifecycle_idx"
    ON "ActivityTask"("tenantId", "customerId", "deletedAtUtc");

CREATE INDEX "ActivityTask_quote_lifecycle_idx"
    ON "ActivityTask"("tenantId", "quoteId", "deletedAtUtc");

CREATE INDEX "ActivityTask_lifecycle_updated_idx"
    ON "ActivityTask"("tenantId", "deletedAtUtc", "updatedAt" DESC, "id" DESC);

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId")
    REFERENCES "Customer"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_quoteId_tenantId_fkey"
    FOREIGN KEY ("quoteId", "customerId", "tenantId")
    REFERENCES "Quote"("id", "customerId", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_assignedTenantUserId_tenantId_fkey"
    FOREIGN KEY ("assignedTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_createdByTenantUserId_tenantId_fkey"
    FOREIGN KEY ("createdByTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
    ADD CONSTRAINT "ActivityTask_completedByTenantUserId_tenantId_fkey"
    FOREIGN KEY ("completedByTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityTask" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ActivityTask_tenant_isolation" ON "ActivityTask";
CREATE POLICY "ActivityTask_tenant_isolation"
    ON "ActivityTask"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "ActivityTask" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "ActivityTask" TO quotefly_runtime;

CREATE TABLE "ActivityTaskEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "activityTaskId" TEXT NOT NULL,
    "actorTenantUserId" TEXT NOT NULL,
    "type" "ActivityTaskEventType" NOT NULL,
    "fromStatus" "ActivityTaskStatus",
    "toStatus" "ActivityTaskStatus",
    "requestId" VARCHAR(191) NOT NULL,
    "commandKeyHash" VARCHAR(64) NOT NULL,
    "commandPayloadHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityTaskEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityTaskEvent_command_key_hash_check" CHECK ("commandKeyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ActivityTaskEvent_command_payload_hash_check" CHECK ("commandPayloadHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "ActivityTaskEvent_tenantId_commandKeyHash_key"
    ON "ActivityTaskEvent"("tenantId", "commandKeyHash");

CREATE INDEX "ActivityTaskEvent_task_created_idx"
    ON "ActivityTaskEvent"("tenantId", "activityTaskId", "createdAt", "id");

CREATE INDEX "ActivityTaskEvent_actor_created_idx"
    ON "ActivityTaskEvent"("tenantId", "actorTenantUserId", "createdAt");

ALTER TABLE "ActivityTaskEvent"
    ADD CONSTRAINT "ActivityTaskEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTaskEvent"
    ADD CONSTRAINT "ActivityTaskEvent_activityTaskId_tenantId_fkey"
    FOREIGN KEY ("activityTaskId", "tenantId")
    REFERENCES "ActivityTask"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTaskEvent"
    ADD CONSTRAINT "ActivityTaskEvent_actorTenantUserId_tenantId_fkey"
    FOREIGN KEY ("actorTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTaskEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityTaskEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ActivityTaskEvent_tenant_select" ON "ActivityTaskEvent";
CREATE POLICY "ActivityTaskEvent_tenant_select"
    ON "ActivityTaskEvent"
    FOR SELECT
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

DROP POLICY IF EXISTS "ActivityTaskEvent_tenant_insert" ON "ActivityTaskEvent";
CREATE POLICY "ActivityTaskEvent_tenant_insert"
    ON "ActivityTaskEvent"
    FOR INSERT
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE ALL PRIVILEGES ON "ActivityTaskEvent" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "ActivityTaskEvent" TO quotefly_runtime;
