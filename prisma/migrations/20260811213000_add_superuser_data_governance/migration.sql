CREATE TYPE "DataGovernanceValidationStatus" AS ENUM ('PASSED', 'FAILED');

CREATE TABLE "DataGovernanceValidationRun" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "requestId" VARCHAR(128) NOT NULL,
    "schemaHash" VARCHAR(64) NOT NULL,
    "baselineHash" VARCHAR(64) NOT NULL,
    "policyVersion" VARCHAR(32) NOT NULL,
    "status" "DataGovernanceValidationStatus" NOT NULL,
    "modelCount" INTEGER NOT NULL,
    "fieldCount" INTEGER NOT NULL,
    "issueCount" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataGovernanceValidationRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DataGovernanceValidationRun_schema_hash_check"
        CHECK ("schemaHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DataGovernanceValidationRun_baseline_hash_check"
        CHECK ("baselineHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DataGovernanceValidationRun_counts_check"
        CHECK ("modelCount" >= 0 AND "fieldCount" >= 0 AND "issueCount" >= 0)
);

CREATE TABLE "SuperuserAuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "requestId" VARCHAR(128) NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "targetType" VARCHAR(64),
    "targetRefHash" VARCHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperuserAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SuperuserAuditEvent_target_ref_hash_check"
        CHECK ("targetRefHash" IS NULL OR "targetRefHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "DataGovernanceValidationRun_createdAt_idx"
    ON "DataGovernanceValidationRun"("createdAt");
CREATE INDEX "DataGovernanceValidationRun_status_createdAt_idx"
    ON "DataGovernanceValidationRun"("status", "createdAt");
CREATE INDEX "DataGovernanceValidationRun_actorUserId_createdAt_idx"
    ON "DataGovernanceValidationRun"("actorUserId", "createdAt");

CREATE INDEX "SuperuserAuditEvent_actorUserId_createdAt_idx"
    ON "SuperuserAuditEvent"("actorUserId", "createdAt");
CREATE INDEX "SuperuserAuditEvent_action_createdAt_idx"
    ON "SuperuserAuditEvent"("action", "createdAt");
CREATE INDEX "SuperuserAuditEvent_createdAt_idx"
    ON "SuperuserAuditEvent"("createdAt");

ALTER TABLE "DataGovernanceValidationRun"
    ADD CONSTRAINT "DataGovernanceValidationRun_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SuperuserAuditEvent"
    ADD CONSTRAINT "SuperuserAuditEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
