ALTER TYPE "AiUsageEventType" ADD VALUE IF NOT EXISTS 'INDEXING';

CREATE TYPE "AiIndexJobOperation" AS ENUM ('UPSERT', 'DELETE');
CREATE TYPE "AiIndexJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'DEAD');

ALTER TABLE "AiRetrievalDocument"
    ADD COLUMN "chunkerVersion" VARCHAR(64) NOT NULL DEFAULT 'legacy-char-v1';

ALTER TABLE "AiRetrievalChunk"
    ADD COLUMN "embeddingContentHash" VARCHAR(64),
    ADD COLUMN "chunkerVersion" VARCHAR(64) NOT NULL DEFAULT 'legacy-char-v1';

CREATE INDEX "AiRetrievalChunk_embedding_cache_idx"
    ON "AiRetrievalChunk"("tenantId", "embeddingContentHash", "embeddingModel", "embeddingDimensions", "chunkerVersion", "deletedAtUtc")
    WHERE "embeddingContentHash" IS NOT NULL;

CREATE TABLE "AiIndexJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" VARCHAR(64) NOT NULL,
    "sourceId" TEXT NOT NULL,
    "operation" "AiIndexJobOperation" NOT NULL,
    "status" "AiIndexJobStatus" NOT NULL DEFAULT 'PENDING',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "expectedSourceUpdatedAtUtc" TIMESTAMPTZ(3),
    "availableAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAtUtc" TIMESTAMPTZ(3),
    "lockedBy" VARCHAR(128),
    "completedAtUtc" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "lastDurationMs" INTEGER,
    "lastChunkCount" INTEGER,
    "lastEmbeddingCacheHitCount" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiIndexJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiIndexJob_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "AiIndexJob_maxAttempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 10),
    CONSTRAINT "AiIndexJob_generation_check" CHECK ("generation" > 0)
);

CREATE UNIQUE INDEX "AiIndexJob_tenantId_sourceType_sourceId_key"
    ON "AiIndexJob"("tenantId", "sourceType", "sourceId");
CREATE UNIQUE INDEX "AiIndexJob_id_tenantId_key"
    ON "AiIndexJob"("id", "tenantId");
CREATE INDEX "AiIndexJob_tenantId_status_availableAtUtc_createdAt_idx"
    ON "AiIndexJob"("tenantId", "status", "availableAtUtc", "createdAt");
CREATE INDEX "AiIndexJob_tenantId_lockedAtUtc_idx"
    ON "AiIndexJob"("tenantId", "lockedAtUtc");
CREATE INDEX "AiIndexJob_status_availableAtUtc_idx"
    ON "AiIndexJob"("status", "availableAtUtc");

ALTER TABLE "AiIndexJob"
    ADD CONSTRAINT "AiIndexJob_source_nonempty_check"
        CHECK (length(btrim("sourceType")) > 0 AND length(btrim("sourceId")) > 0),
    ADD CONSTRAINT "AiIndexJob_metrics_nonnegative_check"
        CHECK (
            ("lastDurationMs" IS NULL OR "lastDurationMs" >= 0)
            AND ("lastChunkCount" IS NULL OR "lastChunkCount" >= 0)
            AND ("lastEmbeddingCacheHitCount" IS NULL OR "lastEmbeddingCacheHitCount" >= 0)
        ),
    ADD CONSTRAINT "AiIndexJob_lock_state_check"
        CHECK (
            ("status" = 'PROCESSING' AND "lockedAtUtc" IS NOT NULL AND "lockedBy" IS NOT NULL)
            OR
            ("status" <> 'PROCESSING' AND "lockedAtUtc" IS NULL AND "lockedBy" IS NULL)
        );

ALTER TABLE "AiIndexJob"
    ADD CONSTRAINT "AiIndexJob_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Expand-phase backfill. Inline request-time refresh stays enabled during this
-- release, so these jobs warm untouched aggregate roots without a cutover gap.
INSERT INTO "AiIndexJob" (
    "id", "tenantId", "sourceType", "sourceId", "operation", "status",
    "expectedSourceUpdatedAtUtc", "availableAtUtc", "createdAt", "updatedAt"
)
SELECT
    'idx_' || md5('Customer:' || customer."tenantId" || ':' || customer."id"),
    customer."tenantId", 'Customer', customer."id", 'UPSERT', 'PENDING',
    customer."updatedAt", NOW(), NOW(), NOW()
FROM "Customer" customer
WHERE customer."archivedAtUtc" IS NULL AND customer."deletedAtUtc" IS NULL
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "AiIndexJob" (
    "id", "tenantId", "sourceType", "sourceId", "operation", "status",
    "expectedSourceUpdatedAtUtc", "availableAtUtc", "createdAt", "updatedAt"
)
SELECT
    'idx_' || md5('Quote:' || quote."tenantId" || ':' || quote."id"),
    quote."tenantId", 'Quote', quote."id", 'UPSERT', 'PENDING',
    quote."updatedAt", NOW(), NOW(), NOW()
FROM "Quote" quote
WHERE quote."archivedAtUtc" IS NULL AND quote."deletedAtUtc" IS NULL
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "AiIndexJob" (
    "id", "tenantId", "sourceType", "sourceId", "operation", "status",
    "expectedSourceUpdatedAtUtc", "availableAtUtc", "createdAt", "updatedAt"
)
SELECT
    'idx_' || md5('QuoteLineItem:' || line_item."tenantId" || ':' || line_item."id"),
    line_item."tenantId", 'QuoteLineItem', line_item."id", 'UPSERT', 'PENDING',
    line_item."createdAt", NOW(), NOW(), NOW()
FROM "QuoteLineItem" line_item
JOIN "Quote" quote
  ON quote."id" = line_item."quoteId"
 AND quote."tenantId" = line_item."tenantId"
WHERE line_item."deletedAtUtc" IS NULL
  AND quote."archivedAtUtc" IS NULL
  AND quote."deletedAtUtc" IS NULL
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "AiIndexJob" (
    "id", "tenantId", "sourceType", "sourceId", "operation", "status",
    "expectedSourceUpdatedAtUtc", "availableAtUtc", "createdAt", "updatedAt"
)
SELECT
    'idx_' || md5('CustomerActivityEvent:' || activity."tenantId" || ':' || activity."id"),
    activity."tenantId", 'CustomerActivityEvent', activity."id", 'UPSERT', 'PENDING',
    activity."createdAt", NOW(), NOW(), NOW()
FROM "CustomerActivityEvent" activity
JOIN "Customer" customer
  ON customer."id" = activity."customerId"
 AND customer."tenantId" = activity."tenantId"
WHERE activity."deletedAtUtc" IS NULL
  AND customer."archivedAtUtc" IS NULL
  AND customer."deletedAtUtc" IS NULL
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "AiIndexJob" (
    "id", "tenantId", "sourceType", "sourceId", "operation", "status",
    "expectedSourceUpdatedAtUtc", "availableAtUtc", "createdAt", "updatedAt"
)
SELECT
    'idx_' || md5('WorkPreset:' || preset."tenantId" || ':' || preset."id"),
    preset."tenantId", 'WorkPreset', preset."id", 'UPSERT', 'PENDING',
    preset."updatedAt", NOW(), NOW(), NOW()
FROM "WorkPreset" preset
WHERE preset."deletedAtUtc" IS NULL
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO NOTHING;

ALTER TABLE "AiIndexJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiIndexJob" FORCE ROW LEVEL SECURITY;

CREATE POLICY "AiIndexJob_tenant_isolation"
    ON "AiIndexJob"
    FOR ALL
    USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
    WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AiIndexJob" TO quotefly_runtime;
