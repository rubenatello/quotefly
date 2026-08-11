-- Additive AI data-governance metadata. Existing prompt content is preserved;
-- application code stops writing new raw prompts and a separately authorized
-- retention command will handle historical deletion.
CREATE TYPE "AiPurpose" AS ENUM ('QUOTE_DRAFT', 'QUOTE_REVISION', 'BUSINESS_INSIGHT');
CREATE TYPE "DataClassification" AS ENUM (
    'C0_PUBLIC',
    'C1_BUSINESS_INTERNAL',
    'C2_CUSTOMER_CONFIDENTIAL',
    'C3_FINANCIAL_CONFIDENTIAL',
    'C4_RESTRICTED'
);
CREATE TYPE "AiRetrievalAuditStatus" AS ENUM ('SUCCEEDED', 'DENIED', 'FAILED');

ALTER TABLE "AiUsageEvent"
    ALTER COLUMN "promptText" DROP NOT NULL,
    ADD COLUMN "purpose" "AiPurpose",
    ADD COLUMN "classification" "DataClassification",
    ADD COLUMN "serviceType" "ServiceCategory",
    ADD COLUMN "promptRedacted" TEXT,
    ADD COLUMN "promptHash" VARCHAR(64),
    ADD COLUMN "sourceCount" INTEGER,
    ADD COLUMN "retentionExpiresAtUtc" TIMESTAMPTZ(3),
    ADD COLUMN "retrievalAuditEventId" TEXT;

UPDATE "AiUsageEvent"
SET
    "purpose" = CASE
        WHEN "eventType" = 'REVISE' THEN 'QUOTE_REVISION'::"AiPurpose"
        ELSE 'QUOTE_DRAFT'::"AiPurpose"
    END,
    "classification" = 'C2_CUSTOMER_CONFIDENTIAL'::"DataClassification",
    -- Existing rows still contain raw prompts, so they receive the shorter raw
    -- content window. No content is removed by this additive migration.
    "retentionExpiresAtUtc" = "createdAt" + INTERVAL '30 days'
WHERE "purpose" IS NULL
   OR "classification" IS NULL
   OR "retentionExpiresAtUtc" IS NULL;

ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_prompt_hash_check"
        CHECK ("promptHash" IS NULL OR "promptHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "AiUsageEvent_source_count_check"
        CHECK ("sourceCount" IS NULL OR "sourceCount" >= 0);

CREATE TABLE "AiRetrievalAuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "requestId" VARCHAR(128) NOT NULL,
    "purpose" "AiPurpose" NOT NULL,
    "model" TEXT,
    "maxClassification" "DataClassification" NOT NULL,
    "sourceTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourceRefs" JSONB,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokenCount" INTEGER,
    "outputTokenCount" INTEGER,
    "queryHash" VARCHAR(64) NOT NULL,
    "policyVersion" VARCHAR(32) NOT NULL,
    "status" "AiRetrievalAuditStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "denialCode" VARCHAR(64),
    "retentionExpiresAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "AiRetrievalAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRetrievalAuditEvent_query_hash_check"
        CHECK ("queryHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiRetrievalAuditEvent_result_count_check"
        CHECK ("resultCount" >= 0),
    CONSTRAINT "AiRetrievalAuditEvent_token_counts_check"
        CHECK (
            ("inputTokenCount" IS NULL OR "inputTokenCount" >= 0)
            AND ("outputTokenCount" IS NULL OR "outputTokenCount" >= 0)
        )
);

CREATE UNIQUE INDEX "AiUsageEvent_retrievalAuditEventId_key"
    ON "AiUsageEvent"("retrievalAuditEventId");
CREATE INDEX "AiUsageEvent_tenantId_purpose_createdAt_idx"
    ON "AiUsageEvent"("tenantId", "purpose", "createdAt");
CREATE INDEX "AiUsageEvent_tenantId_retentionExpiresAtUtc_idx"
    ON "AiUsageEvent"("tenantId", "retentionExpiresAtUtc");

CREATE INDEX "AiRetrievalAuditEvent_tenantId_createdAt_idx"
    ON "AiRetrievalAuditEvent"("tenantId", "createdAt");
CREATE INDEX "AiRetrievalAuditEvent_tenantId_actorUserId_createdAt_idx"
    ON "AiRetrievalAuditEvent"("tenantId", "actorUserId", "createdAt");
CREATE INDEX "AiRetrievalAuditEvent_tenantId_purpose_createdAt_idx"
    ON "AiRetrievalAuditEvent"("tenantId", "purpose", "createdAt");
CREATE INDEX "AiRetrievalAuditEvent_tenantId_retentionExpiresAtUtc_idx"
    ON "AiRetrievalAuditEvent"("tenantId", "retentionExpiresAtUtc");
CREATE INDEX "AiRetrievalAuditEvent_tenantId_deletedAtUtc_idx"
    ON "AiRetrievalAuditEvent"("tenantId", "deletedAtUtc");

ALTER TABLE "AiRetrievalAuditEvent"
    ADD CONSTRAINT "AiRetrievalAuditEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRetrievalAuditEvent"
    ADD CONSTRAINT "AiRetrievalAuditEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_retrievalAuditEventId_fkey"
    FOREIGN KEY ("retrievalAuditEventId") REFERENCES "AiRetrievalAuditEvent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
