-- Terminal QuickBooks security records have bounded, documented retention.
-- Runtime DELETE remains constrained by forced tenant RLS; unbound quarantine
-- cleanup is separately realm-exact and only usable at webhook ingress.

CREATE INDEX "QuickBooksOAuthState_retention_idx"
  ON "QuickBooksOAuthState"("tenantId", "consumedAtUtc", "expiresAtUtc", "id");

CREATE INDEX "QuickBooksWebhookEvent_processed_retention_idx"
  ON "QuickBooksWebhookEvent"("tenantId", "status", "processedAtUtc", "id");

CREATE INDEX "QuickBooksWebhookEvent_dead_retention_idx"
  ON "QuickBooksWebhookEvent"("tenantId", "status", "deadAtUtc", "id");

-- Do not grant a worker a tenant-global view of unbound realms. The public
-- ingress path may only delete an old, still-unbound, RECEIVED envelope for
-- the one realm configured in its current transaction.
CREATE POLICY "QuickBooksWebhookEvent_quarantine_retention"
  ON "QuickBooksWebhookEvent" FOR DELETE TO quotefly_runtime
  USING (
    "tenantId" IS NULL
    AND "quickBooksConnectionId" IS NULL
    AND "status" = 'RECEIVED'
    AND "lastError" = 'QUICKBOOKS_REALM_UNBOUND'
    AND "realmId" = NULLIF(current_setting('app.quickbooks_webhook_realm_id', true), '')
    AND current_setting('app.quickbooks_webhook_quarantine_retention', true) = '1'
  );

-- These two tables are the explicit exception to append-only operational
-- storage. The deletion service always sets tenant RLS before deleting.
GRANT DELETE ON "QuickBooksOAuthState", "QuickBooksWebhookEvent" TO quotefly_runtime;
