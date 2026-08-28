-- A bounded DELETE CTE must be able to select its own realm-exact candidates.
-- This is deliberately not a tenant/global policy: the row must remain
-- unbound, terminal to quarantine, and match both transaction-local controls.

CREATE POLICY "QuickBooksWebhookEvent_quarantine_retention_candidate_read"
  ON "QuickBooksWebhookEvent" FOR SELECT TO quotefly_runtime
  USING (
    "tenantId" IS NULL
    AND "quickBooksConnectionId" IS NULL
    AND "status" = 'RECEIVED'
    AND "lastError" = 'QUICKBOOKS_REALM_UNBOUND'
    AND "realmId" = NULLIF(current_setting('app.quickbooks_webhook_realm_id', true), '')
    AND current_setting('app.quickbooks_webhook_quarantine_retention', true) = '1'
  );
