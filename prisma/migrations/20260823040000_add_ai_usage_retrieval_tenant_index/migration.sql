-- Support tenant-scoped joins and cleanup for the composite retrieval-audit
-- relation. The retrieval embedding cache index remains the intentionally
-- partial index created by 20260814190000_add_ai_index_foundation.
CREATE INDEX "AiUsageEvent_retrievalAuditTenantId_idx"
    ON "AiUsageEvent"("retrievalAuditTenantId");
