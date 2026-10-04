-- Additive, no backfill. Audit references survive inbox retention deliberately.
CREATE TABLE "QuickBooksWebhookReplay" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "actorTenantUserId" TEXT NOT NULL,
  "eventId" VARCHAR(191) NOT NULL,
  "reason" VARCHAR(32) NOT NULL,
  "priorFailureCode" VARCHAR(64) NOT NULL,
  "priorAttemptCount" INTEGER NOT NULL,
  "commandHash" VARCHAR(64) NOT NULL,
  "createdAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickBooksWebhookReplay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "QuickBooksWebhookReplay_actorTenantUserId_tenantId_fkey" FOREIGN KEY ("actorTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "QuickBooksWebhookReplay_reason_check" CHECK ("reason" IN ('PROVIDER_RECOVERED', 'CONNECTION_REAUTHORIZED', 'MAPPING_CORRECTED')),
  CONSTRAINT "QuickBooksWebhookReplay_attempt_check" CHECK ("priorAttemptCount" >= 0),
  CONSTRAINT "QuickBooksWebhookReplay_hash_check" CHECK ("commandHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "QuickBooksWebhookReplay_tenantId_commandHash_key" ON "QuickBooksWebhookReplay"("tenantId", "commandHash");
CREATE INDEX "QuickBooksWebhookReplay_tenantId_eventId_createdAtUtc_idx" ON "QuickBooksWebhookReplay"("tenantId", "eventId", "createdAtUtc");
ALTER TABLE "QuickBooksWebhookReplay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksWebhookReplay" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksWebhookReplay_tenant_isolation" ON "QuickBooksWebhookReplay" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));
REVOKE ALL PRIVILEGES ON "QuickBooksWebhookReplay" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "QuickBooksWebhookReplay" TO quotefly_runtime;
