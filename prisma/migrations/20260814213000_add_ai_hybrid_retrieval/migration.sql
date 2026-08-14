-- Expand retrieval metadata and content-free audit diagnostics for hybrid RAG.
-- All columns are nullable so older application instances remain compatible
-- while Railway rolls the new API and worker processes.
ALTER TABLE "AiRetrievalChunk"
  ADD COLUMN "customerId" TEXT,
  ADD COLUMN "quoteId" TEXT,
  ADD COLUMN "serviceType" "ServiceCategory",
  ADD COLUMN "recordStatus" VARCHAR(64),
  ADD COLUMN "lifecycle" VARCHAR(32),
  ADD COLUMN "assignedTenantUserId" TEXT,
  ADD COLUMN "section" VARCHAR(128),
  ADD COLUMN "pageNumber" INTEGER,
  ADD COLUMN "sourceCreatedAtUtc" TIMESTAMPTZ(3);

ALTER TABLE "QuoteLineItem"
  ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AiRetrievalAuditEvent"
  ADD COLUMN "rankingMode" VARCHAR(64),
  ADD COLUMN "candidateCount" INTEGER,
  ADD COLUMN "authorizedCandidateCount" INTEGER,
  ADD COLUMN "semanticCandidateCount" INTEGER,
  ADD COLUMN "keywordCandidateCount" INTEGER,
  ADD COLUMN "embeddingDurationMs" INTEGER,
  ADD COLUMN "authorizationDurationMs" INTEGER,
  ADD COLUMN "keywordDurationMs" INTEGER,
  ADD COLUMN "rankingDurationMs" INTEGER,
  ADD COLUMN "totalDurationMs" INTEGER,
  ADD COLUMN "filterSummary" JSONB,
  ADD COLUMN "rankingSummary" JSONB;

ALTER TABLE "AiRetrievalChunk"
  ADD CONSTRAINT "AiRetrievalChunk_pageNumber_check"
    CHECK ("pageNumber" IS NULL OR "pageNumber" > 0),
  ADD CONSTRAINT "AiRetrievalChunk_lifecycle_check"
    CHECK ("lifecycle" IS NULL OR "lifecycle" IN ('active', 'archived', 'deleted'));

ALTER TABLE "AiRetrievalAuditEvent"
  ADD CONSTRAINT "AiRetrievalAuditEvent_candidate_counts_check"
    CHECK (
      ("candidateCount" IS NULL OR "candidateCount" >= 0) AND
      ("authorizedCandidateCount" IS NULL OR "authorizedCandidateCount" >= 0) AND
      ("semanticCandidateCount" IS NULL OR "semanticCandidateCount" >= 0) AND
      ("keywordCandidateCount" IS NULL OR "keywordCandidateCount" >= 0)
    ),
  ADD CONSTRAINT "AiRetrievalAuditEvent_stage_durations_check"
    CHECK (
      ("embeddingDurationMs" IS NULL OR "embeddingDurationMs" >= 0) AND
      ("authorizationDurationMs" IS NULL OR "authorizationDurationMs" >= 0) AND
      ("keywordDurationMs" IS NULL OR "keywordDurationMs" >= 0) AND
      ("rankingDurationMs" IS NULL OR "rankingDurationMs" >= 0) AND
      ("totalDurationMs" IS NULL OR "totalDurationMs" >= 0)
    );

UPDATE "AiRetrievalChunk"
SET
  "customerId" = NULLIF("metadata"->>'customerId', ''),
  "quoteId" = NULLIF("metadata"->>'quoteId', ''),
  "serviceType" = CASE
    WHEN "metadata"->>'serviceType' IN ('HVAC', 'PLUMBING', 'FLOORING', 'ROOFING', 'GARDENING', 'CONSTRUCTION')
      THEN ("metadata"->>'serviceType')::"ServiceCategory"
    ELSE NULL
  END,
  "lifecycle" = CASE WHEN "deletedAtUtc" IS NULL THEN 'active' ELSE 'deleted' END,
  "section" = "sourceField";

CREATE INDEX "AiRetrievalChunk_tenant_customer_active_idx"
  ON "AiRetrievalChunk" ("tenantId", "customerId", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenant_quote_active_idx"
  ON "AiRetrievalChunk" ("tenantId", "quoteId", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenant_assignee_active_idx"
  ON "AiRetrievalChunk" ("tenantId", "assignedTenantUserId", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenant_service_lifecycle_status_idx"
  ON "AiRetrievalChunk" ("tenantId", "serviceType", "lifecycle", "recordStatus", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenant_source_created_idx"
  ON "AiRetrievalChunk" ("tenantId", "sourceCreatedAtUtc", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_content_fts_idx"
  ON "AiRetrievalChunk"
  USING GIN (to_tsvector('simple', "content"))
  WHERE "deletedAtUtc" IS NULL;
