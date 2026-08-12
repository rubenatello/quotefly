CREATE TYPE "AiRetrievalDocumentStatus" AS ENUM ('ACTIVE', 'DELETED');

CREATE TABLE "AiRetrievalDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" VARCHAR(64) NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceUpdatedAtUtc" TIMESTAMPTZ(3),
    "status" "AiRetrievalDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxClassification" "DataClassification" NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "citationLabel" VARCHAR(160) NOT NULL,
    "metadata" JSONB,
    "policyVersion" VARCHAR(32) NOT NULL,
    "indexedAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "AiRetrievalDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRetrievalDocument_content_hash_check"
        CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "AiRetrievalChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceType" VARCHAR(64) NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceField" VARCHAR(128) NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "embedding" DOUBLE PRECISION[] NOT NULL,
    "embeddingModel" VARCHAR(80) NOT NULL,
    "embeddingDimensions" INTEGER NOT NULL,
    "classification" "DataClassification" NOT NULL,
    "citationLabel" VARCHAR(160) NOT NULL,
    "metadata" JSONB,
    "policyVersion" VARCHAR(32) NOT NULL,
    "sourceUpdatedAtUtc" TIMESTAMPTZ(3),
    "indexedAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "AiRetrievalChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRetrievalChunk_chunk_index_check"
        CHECK ("chunkIndex" >= 0),
    CONSTRAINT "AiRetrievalChunk_content_hash_check"
        CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiRetrievalChunk_embedding_dimensions_check"
        CHECK ("embeddingDimensions" > 0 AND array_length("embedding", 1) = "embeddingDimensions")
);

CREATE UNIQUE INDEX "AiRetrievalDocument_tenantId_sourceType_sourceId_key"
    ON "AiRetrievalDocument"("tenantId", "sourceType", "sourceId");
CREATE UNIQUE INDEX "AiRetrievalDocument_id_tenantId_key"
    ON "AiRetrievalDocument"("id", "tenantId");
CREATE INDEX "AiRetrievalDocument_tenantId_status_indexedAtUtc_idx"
    ON "AiRetrievalDocument"("tenantId", "status", "indexedAtUtc");
CREATE INDEX "AiRetrievalDocument_tenantId_sourceType_deletedAtUtc_idx"
    ON "AiRetrievalDocument"("tenantId", "sourceType", "deletedAtUtc");
CREATE INDEX "AiRetrievalDocument_tenantId_maxClassification_deletedAtUtc_idx"
    ON "AiRetrievalDocument"("tenantId", "maxClassification", "deletedAtUtc");

CREATE UNIQUE INDEX "AiRetrievalChunk_tenantId_documentId_chunkIndex_key"
    ON "AiRetrievalChunk"("tenantId", "documentId", "chunkIndex");
CREATE INDEX "AiRetrievalChunk_tenantId_classification_deletedAtUtc_idx"
    ON "AiRetrievalChunk"("tenantId", "classification", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenantId_sourceType_sourceId_deletedAtUtc_idx"
    ON "AiRetrievalChunk"("tenantId", "sourceType", "sourceId", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenantId_sourceField_deletedAtUtc_idx"
    ON "AiRetrievalChunk"("tenantId", "sourceField", "deletedAtUtc");
CREATE INDEX "AiRetrievalChunk_tenantId_indexedAtUtc_idx"
    ON "AiRetrievalChunk"("tenantId", "indexedAtUtc");

ALTER TABLE "AiRetrievalDocument"
    ADD CONSTRAINT "AiRetrievalDocument_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRetrievalChunk"
    ADD CONSTRAINT "AiRetrievalChunk_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRetrievalChunk"
    ADD CONSTRAINT "AiRetrievalChunk_documentId_fkey"
    FOREIGN KEY ("documentId", "tenantId") REFERENCES "AiRetrievalDocument"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
