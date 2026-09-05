-- Allow one signed, realm-bounded webhook delivery to be quarantined with a
-- set-based insert. Event identifiers are QuoteFly-generated SHA-256 values;
-- the transaction-local allowlist keeps the existing exact-event RLS fence
-- without requiring one SQL round trip per notification.

DROP POLICY "QuickBooksWebhookEvent_tenant_or_quarantine" ON "QuickBooksWebhookEvent";

CREATE POLICY "QuickBooksWebhookEvent_tenant_or_quarantine"
  ON "QuickBooksWebhookEvent" FOR ALL
  USING (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    OR (
      "tenantId" IS NULL
      AND "quickBooksConnectionId" IS NULL
      AND "realmId" = NULLIF(current_setting('app.quickbooks_webhook_realm_id', true), '')
      AND NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL
    )
  )
  WITH CHECK (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    OR (
      "tenantId" IS NULL
      AND "quickBooksConnectionId" IS NULL
      AND "realmId" = NULLIF(current_setting('app.quickbooks_webhook_realm_id', true), '')
      AND (
        "webhookEventId" = NULLIF(current_setting('app.quickbooks_webhook_event_id', true), '')
        OR "webhookEventId" = ANY (
          string_to_array(
            NULLIF(current_setting('app.quickbooks_webhook_event_ids', true), ''),
            ','
          )
        )
      )
      AND "status" = 'RECEIVED'
      AND "attemptCount" = 0
      AND "claimTokenHash" IS NULL
      AND "claimExpiresAtUtc" IS NULL
      AND "processedAtUtc" IS NULL
      AND "deadAtUtc" IS NULL
    )
  );
