-- Hot-path indexes for workspace bootstrap, customer/quote lists, live auth,
-- and bounded AI retrieval candidate selection.

CREATE INDEX IF NOT EXISTS "TenantUser_tenantId_userId_deletedAtUtc_idx"
    ON "TenantUser"("tenantId", "userId", "deletedAtUtc");

CREATE INDEX IF NOT EXISTS "Customer_tenantId_updatedAt_id_idx"
    ON "Customer"("tenantId", "updatedAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Customer_tenantId_archived_deleted_updated_id_idx"
    ON "Customer"("tenantId", "archivedAtUtc", "deletedAtUtc", "updatedAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Quote_tenantId_createdAt_id_idx"
    ON "Quote"("tenantId", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Quote_tenantId_archived_deleted_created_id_idx"
    ON "Quote"("tenantId", "archivedAtUtc", "deletedAtUtc", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Quote_tenantId_customer_archived_deleted_updated_id_idx"
    ON "Quote"("tenantId", "customerId", "archivedAtUtc", "deletedAtUtc", "updatedAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "AiRetrievalChunk_tenant_class_deleted_policy_dims_indexed_idx"
    ON "AiRetrievalChunk"("tenantId", "classification", "deletedAtUtc", "policyVersion", "embeddingDimensions", "indexedAtUtc" DESC);
