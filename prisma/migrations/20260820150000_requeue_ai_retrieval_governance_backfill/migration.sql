-- Requeue every active canonical RAG source for the governed-content rollout.
-- Existing PROCESSING leases retain their lock while generation advances; the
-- stale worker fence releases safely and the next claim processes the newest
-- generation. No customer, quote, or source record is modified here.
--
-- Derived index rows are not the system of record. Purge legacy chunks and
-- document metadata first so pre-governance excerpts, citations, and vectors
-- cannot remain readable at rest while the existing queue rebuilds them.
DELETE FROM "AiRetrievalChunk" chunk
USING "AiRetrievalDocument" document
WHERE chunk."documentId" = document."id"
  AND chunk."tenantId" = document."tenantId"
  AND (
    chunk."chunkerVersion" IS DISTINCT FROM 'nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v1'
    OR document."chunkerVersion" IS DISTINCT FROM 'nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v1'
  );

DELETE FROM "AiRetrievalDocument"
WHERE "chunkerVersion" IS DISTINCT FROM 'nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v1';

WITH active_sources AS (
  SELECT customer."tenantId", 'Customer'::text AS "sourceType", customer."id" AS "sourceId", customer."updatedAt" AS "sourceUpdatedAtUtc"
  FROM "Customer" customer
  WHERE customer."archivedAtUtc" IS NULL AND customer."deletedAtUtc" IS NULL

  UNION ALL

  SELECT quote."tenantId", 'Quote'::text, quote."id", quote."updatedAt"
  FROM "Quote" quote
  WHERE quote."archivedAtUtc" IS NULL AND quote."deletedAtUtc" IS NULL

  UNION ALL

  SELECT line_item."tenantId", 'QuoteLineItem'::text, line_item."id", line_item."updatedAt"
  FROM "QuoteLineItem" line_item
  INNER JOIN "Quote" quote
    ON quote."id" = line_item."quoteId"
   AND quote."tenantId" = line_item."tenantId"
  WHERE line_item."deletedAtUtc" IS NULL
    AND quote."archivedAtUtc" IS NULL
    AND quote."deletedAtUtc" IS NULL

  UNION ALL

  SELECT activity."tenantId", 'CustomerActivityEvent'::text, activity."id", activity."createdAt"
  FROM "CustomerActivityEvent" activity
  INNER JOIN "Customer" customer
    ON customer."id" = activity."customerId"
   AND customer."tenantId" = activity."tenantId"
  WHERE activity."deletedAtUtc" IS NULL
    AND customer."archivedAtUtc" IS NULL
    AND customer."deletedAtUtc" IS NULL

  UNION ALL

  SELECT preset."tenantId", 'WorkPreset'::text, preset."id", preset."updatedAt"
  FROM "WorkPreset" preset
  WHERE preset."deletedAtUtc" IS NULL
)
INSERT INTO "AiIndexJob" (
  "id", "tenantId", "sourceType", "sourceId", "operation", "status",
  "expectedSourceUpdatedAtUtc", "availableAtUtc", "maxAttempts", "createdAt", "updatedAt"
)
SELECT
  'idx_governance_' || md5(source."sourceType" || ':' || source."tenantId" || ':' || source."sourceId"),
  source."tenantId", source."sourceType", source."sourceId",
  'UPSERT'::"AiIndexJobOperation", 'PENDING'::"AiIndexJobStatus",
  source."sourceUpdatedAtUtc", NOW(), 5, NOW(), NOW()
FROM active_sources source
ON CONFLICT ("tenantId", "sourceType", "sourceId") DO UPDATE SET
  "operation" = EXCLUDED."operation",
  "generation" = "AiIndexJob"."generation" + 1,
  "expectedSourceUpdatedAtUtc" = EXCLUDED."expectedSourceUpdatedAtUtc",
  "status" = CASE
    WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
      THEN "AiIndexJob"."status"
    ELSE 'PENDING'::"AiIndexJobStatus"
  END,
  "availableAtUtc" = CASE
    WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
      THEN "AiIndexJob"."availableAtUtc"
    ELSE EXCLUDED."availableAtUtc"
  END,
  "attempts" = CASE
    WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
      THEN "AiIndexJob"."attempts"
    ELSE 0
  END,
  "maxAttempts" = EXCLUDED."maxAttempts",
  "lockedAtUtc" = CASE
    WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
      THEN "AiIndexJob"."lockedAtUtc"
    ELSE NULL
  END,
  "lockedBy" = CASE
    WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
      THEN "AiIndexJob"."lockedBy"
    ELSE NULL
  END,
  "completedAtUtc" = NULL,
  "lastErrorCode" = NULL,
  "updatedAt" = NOW();
