-- Permit the least-privileged runtime role to durably quarantine a signed
-- QuickBooks webhook before a realm is tenant-bound. Ingress writes are
-- limited to one transaction-local realm/event identity and a content-minimal
-- unclaimed envelope. Adoption requires a tenant context and the same realm.

DROP POLICY "QuickBooksWebhookEvent_tenant_isolation" ON "QuickBooksWebhookEvent";

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
      AND "webhookEventId" = NULLIF(current_setting('app.quickbooks_webhook_event_id', true), '')
      AND "status" = 'RECEIVED'
      AND "attemptCount" = 0
      AND "claimTokenHash" IS NULL
      AND "claimExpiresAtUtc" IS NULL
      AND "processedAtUtc" IS NULL
      AND "deadAtUtc" IS NULL
    )
  );
