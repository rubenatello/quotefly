-- Tenant-bound webhook envelopes are provider data owned by the connected
-- workspace. Hard tenant or connection deletion must remove those envelopes
-- atomically instead of temporarily producing a half-bound row or converting
-- it into indefinite unknown-realm quarantine.

BEGIN;

ALTER TABLE "QuickBooksWebhookEvent"
  DROP CONSTRAINT "QuickBooksWebhookEvent_tenantId_fkey",
  DROP CONSTRAINT "QuickBooksWebhookEvent_connection_tenant_fkey";

ALTER TABLE "QuickBooksWebhookEvent"
  ADD CONSTRAINT "QuickBooksWebhookEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "QuickBooksWebhookEvent_connection_tenant_fkey"
    FOREIGN KEY ("quickBooksConnectionId", "tenantId")
    REFERENCES "QuickBooksConnection"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
