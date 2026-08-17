-- Draft recovery contains unsent customer details, scope, and pricing. Keep it
-- server-side, tenant-bound, short-lived, and protected by forced PostgreSQL RLS.
CREATE TABLE "QuoteDraftRecovery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tenantUserId" TEXT NOT NULL,
    "scope" VARCHAR(191) NOT NULL,
    "payload" JSONB NOT NULL,
    "savedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "expiresAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuoteDraftRecovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuoteDraftRecovery_tenantId_tenantUserId_scope_key"
    ON "QuoteDraftRecovery"("tenantId", "tenantUserId", "scope");

CREATE INDEX "QuoteDraftRecovery_tenantId_tenantUserId_expiresAtUtc_idx"
    ON "QuoteDraftRecovery"("tenantId", "tenantUserId", "expiresAtUtc");

CREATE INDEX "QuoteDraftRecovery_expiresAtUtc_idx"
    ON "QuoteDraftRecovery"("expiresAtUtc");

ALTER TABLE "QuoteDraftRecovery"
    ADD CONSTRAINT "QuoteDraftRecovery_tenantUserId_tenantId_fkey"
    FOREIGN KEY ("tenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuoteDraftRecovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuoteDraftRecovery" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "QuoteDraftRecovery_tenant_isolation" ON "QuoteDraftRecovery";
CREATE POLICY "QuoteDraftRecovery_tenant_isolation"
    ON "QuoteDraftRecovery"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON "QuoteDraftRecovery" TO quotefly_runtime;
