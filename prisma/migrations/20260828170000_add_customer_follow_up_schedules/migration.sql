-- Automatic customer follow-up schedules are immutable per-template version.
-- This migration intentionally does not backfill existing customers.

CREATE TYPE "ActivityActorKind" AS ENUM ('USER', 'SYSTEM');
CREATE TYPE "ActivityTaskOrigin" AS ENUM ('MANUAL', 'AUTOMATED_CUSTOMER_FOLLOW_UP');
CREATE TYPE "FollowUpOutcome" AS ENUM ('CONTACTED', 'NO_RESPONSE', 'SKIPPED');
CREATE TYPE "CustomerFollowUpSequenceStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELED');

ALTER TABLE "Customer"
  ADD COLUMN "lastFollowUpAttemptAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "lastSuccessfulContactAtUtc" TIMESTAMPTZ(3);

CREATE TABLE "FollowUpTemplate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "retiredAtUtc" TIMESTAMPTZ(3),
  CONSTRAINT "FollowUpTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FollowUpTemplate_version_check" CHECK ("version" >= 1),
  CONSTRAINT "FollowUpTemplate_default_lifecycle_check" CHECK (
    ("isDefault" AND "retiredAtUtc" IS NULL)
    OR (NOT "isDefault" AND "retiredAtUtc" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "FollowUpTemplate_id_tenantId_key"
  ON "FollowUpTemplate"("id", "tenantId");
CREATE UNIQUE INDEX "FollowUpTemplate_id_tenantId_version_key"
  ON "FollowUpTemplate"("id", "tenantId", "version");
CREATE UNIQUE INDEX "FollowUpTemplate_tenantId_version_key"
  ON "FollowUpTemplate"("tenantId", "version");
CREATE UNIQUE INDEX "FollowUpTemplate_one_default_per_tenant_key"
  ON "FollowUpTemplate"("tenantId") WHERE "isDefault" AND "retiredAtUtc" IS NULL;
CREATE INDEX "FollowUpTemplate_default_idx"
  ON "FollowUpTemplate"("tenantId", "isDefault", "enabled", "retiredAtUtc");

ALTER TABLE "FollowUpTemplate"
  ADD CONSTRAINT "FollowUpTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FollowUpTemplateStep" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "stepNumber" INTEGER NOT NULL,
  "delayMinutes" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "notes" VARCHAR(2000),
  "priority" "ActivityTaskPriority" NOT NULL DEFAULT 'NORMAL',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FollowUpTemplateStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FollowUpTemplateStep_number_check" CHECK ("stepNumber" BETWEEN 1 AND 6),
  CONSTRAINT "FollowUpTemplateStep_delay_check" CHECK ("delayMinutes" BETWEEN 5 AND 43200),
  CONSTRAINT "FollowUpTemplateStep_title_check" CHECK (char_length(btrim("title")) > 0)
);

CREATE UNIQUE INDEX "FollowUpTemplateStep_templateId_stepNumber_key"
  ON "FollowUpTemplateStep"("templateId", "stepNumber");
CREATE UNIQUE INDEX "FollowUpTemplateStep_id_tenantId_key"
  ON "FollowUpTemplateStep"("id", "tenantId");
CREATE INDEX "FollowUpTemplateStep_template_idx"
  ON "FollowUpTemplateStep"("tenantId", "templateId", "stepNumber");

ALTER TABLE "FollowUpTemplateStep"
  ADD CONSTRAINT "FollowUpTemplateStep_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpTemplateStep"
  ADD CONSTRAINT "FollowUpTemplateStep_templateId_tenantId_fkey"
  FOREIGN KEY ("templateId", "tenantId") REFERENCES "FollowUpTemplate"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerFollowUpSequence" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "templateVersion" INTEGER NOT NULL,
  "status" "CustomerFollowUpSequenceStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "completedAtUtc" TIMESTAMPTZ(3),
  "canceledAtUtc" TIMESTAMPTZ(3),
  "cancellationReason" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "CustomerFollowUpSequence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerFollowUpSequence_version_check" CHECK ("templateVersion" >= 1),
  CONSTRAINT "CustomerFollowUpSequence_state_check" CHECK (
    ("status" = 'ACTIVE' AND "completedAtUtc" IS NULL AND "canceledAtUtc" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'COMPLETED' AND "completedAtUtc" IS NOT NULL AND "canceledAtUtc" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'CANCELED' AND "completedAtUtc" IS NULL AND "canceledAtUtc" IS NOT NULL AND "cancellationReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "CustomerFollowUpSequence_id_tenantId_key"
  ON "CustomerFollowUpSequence"("id", "tenantId");
CREATE UNIQUE INDEX "CustomerFollowUpSequence_one_active_customer_key"
  ON "CustomerFollowUpSequence"("tenantId", "customerId") WHERE "status" = 'ACTIVE';
CREATE INDEX "CustomerFollowUpSequence_customer_status_idx"
  ON "CustomerFollowUpSequence"("tenantId", "customerId", "status");
CREATE INDEX "CustomerFollowUpSequence_status_started_idx"
  ON "CustomerFollowUpSequence"("tenantId", "status", "startedAtUtc");

ALTER TABLE "CustomerFollowUpSequence"
  ADD CONSTRAINT "CustomerFollowUpSequence_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFollowUpSequence"
  ADD CONSTRAINT "CustomerFollowUpSequence_customerId_tenantId_fkey"
  FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFollowUpSequence"
  ADD CONSTRAINT "CustomerFollowUpSequence_template_version_fkey"
  FOREIGN KEY ("templateId", "tenantId", "templateVersion") REFERENCES "FollowUpTemplate"("id", "tenantId", "version")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTask"
  ALTER COLUMN "createdByTenantUserId" DROP NOT NULL,
  ADD COLUMN "origin" "ActivityTaskOrigin" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "followUpOutcome" "FollowUpOutcome",
  ADD COLUMN "followUpSequenceId" TEXT,
  ADD COLUMN "followUpStepNumber" INTEGER;

ALTER TABLE "ActivityTask"
  ADD CONSTRAINT "ActivityTask_follow_up_shape_check" CHECK (
    ("origin" = 'MANUAL' AND "createdByTenantUserId" IS NOT NULL AND "followUpSequenceId" IS NULL AND "followUpStepNumber" IS NULL AND "followUpOutcome" IS NULL)
    OR (
      "origin" = 'AUTOMATED_CUSTOMER_FOLLOW_UP'
      AND "type" = 'FOLLOW_UP'
      AND "followUpSequenceId" IS NOT NULL
      AND "followUpStepNumber" >= 1
      AND (("status" = 'COMPLETED' AND "followUpOutcome" IS NOT NULL) OR ("status" <> 'COMPLETED' AND "followUpOutcome" IS NULL))
    )
  );

CREATE UNIQUE INDEX "ActivityTask_tenantId_followUpSequenceId_followUpStepNumber_key"
  ON "ActivityTask"("tenantId", "followUpSequenceId", "followUpStepNumber");
CREATE INDEX "ActivityTask_follow_up_agenda_idx"
  ON "ActivityTask"("tenantId", "origin", "status", "dueAtUtc", "id");

ALTER TABLE "ActivityTask"
  ADD CONSTRAINT "ActivityTask_followUpSequenceId_tenantId_fkey"
  FOREIGN KEY ("followUpSequenceId", "tenantId") REFERENCES "CustomerFollowUpSequence"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityTaskEvent"
  ALTER COLUMN "actorTenantUserId" DROP NOT NULL,
  ADD COLUMN "actorKind" "ActivityActorKind" NOT NULL DEFAULT 'USER';
ALTER TABLE "ActivityTaskEvent"
  ADD CONSTRAINT "ActivityTaskEvent_actor_kind_check" CHECK (
    ("actorKind" = 'USER' AND "actorTenantUserId" IS NOT NULL)
    OR ("actorKind" = 'SYSTEM' AND "actorTenantUserId" IS NULL)
  );

ALTER TABLE "FollowUpTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FollowUpTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "FollowUpTemplate_tenant_isolation" ON "FollowUpTemplate" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "FollowUpTemplateStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FollowUpTemplateStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY "FollowUpTemplateStep_tenant_isolation" ON "FollowUpTemplateStep" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "CustomerFollowUpSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerFollowUpSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CustomerFollowUpSequence_tenant_isolation" ON "CustomerFollowUpSequence" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL PRIVILEGES ON "FollowUpTemplate", "FollowUpTemplateStep", "CustomerFollowUpSequence" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "FollowUpTemplate" TO quotefly_runtime;
GRANT SELECT, INSERT ON "FollowUpTemplateStep" TO quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "CustomerFollowUpSequence" TO quotefly_runtime;
