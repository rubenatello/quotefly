-- Phase 4B provider-safe QuickBooks invoice operation foundation.
-- Provider workflows remain default-off. This table supplies the durable claim,
-- idempotency binding, uncertain-result quarantine, and reconciliation state
-- required before a QuickBooks invoice can be created from a QuoteFly Invoice.

CREATE TYPE "QuickBooksInvoiceOperationStatus" AS ENUM (
    'PROCESSING',
    'RECONCILING',
    'SUCCEEDED',
    'FAILED',
    'RECONCILIATION_REQUIRED'
);

ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_SYNC_STARTED';
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_SYNC_SUCCEEDED';
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_SYNC_FAILED';
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_RECONCILIATION_REQUIRED';
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_RECONCILED';

CREATE TABLE "QuickBooksInvoiceOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "quickBooksConnectionId" TEXT NOT NULL,
    "requestedByTenantUserId" TEXT NOT NULL,
    "status" "QuickBooksInvoiceOperationStatus" NOT NULL DEFAULT 'PROCESSING',
    "commandKeyHash" VARCHAR(64) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "providerRealmId" VARCHAR(191) NOT NULL,
    "claimTokenHash" VARCHAR(64),
    "providerRequestId" VARCHAR(191) NOT NULL,
    "providerInvoiceId" VARCHAR(191),
    "providerDocNumber" VARCHAR(191) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "reconciliationCount" INTEGER NOT NULL DEFAULT 0,
    "processingStartedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "claimExpiresAtUtc" TIMESTAMPTZ(3),
    "lastAttemptAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "lastReconciledAtUtc" TIMESTAMPTZ(3),
    "succeededAtUtc" TIMESTAMPTZ(3),
    "failedAtUtc" TIMESTAMPTZ(3),
    "lastFailureCode" VARCHAR(191),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuickBooksInvoiceOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuickBooksInvoiceOperation_command_hash_check" CHECK (
        "commandKeyHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_payload_hash_check" CHECK (
        "payloadHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_provider_realm_check" CHECK (
        char_length(btrim("providerRealmId")) > 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_claim_hash_check" CHECK (
        "claimTokenHash" IS NULL OR "claimTokenHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_counts_check" CHECK (
        "attemptCount" >= 1 AND "reconciliationCount" >= 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_provider_request_check" CHECK (
        char_length(btrim("providerRequestId")) > 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_provider_invoice_check" CHECK (
        "providerInvoiceId" IS NULL OR char_length(btrim("providerInvoiceId")) > 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_provider_doc_check" CHECK (
        char_length(btrim("providerDocNumber")) > 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_failure_code_check" CHECK (
        "lastFailureCode" IS NULL OR char_length(btrim("lastFailureCode")) > 0
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_claim_state_check" CHECK (
        (
            "status" IN ('PROCESSING', 'RECONCILING')
            AND "claimTokenHash" IS NOT NULL
            AND "claimExpiresAtUtc" IS NOT NULL
            AND "claimExpiresAtUtc" > "processingStartedAtUtc"
        )
        OR (
            "status" NOT IN ('PROCESSING', 'RECONCILING')
            AND "claimTokenHash" IS NULL
            AND "claimExpiresAtUtc" IS NULL
        )
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_success_state_check" CHECK (
        "status" <> 'SUCCEEDED'
        OR (
            "providerInvoiceId" IS NOT NULL
            AND "succeededAtUtc" IS NOT NULL
        )
    ),
    CONSTRAINT "QuickBooksInvoiceOperation_failure_state_check" CHECK (
        "status" NOT IN ('FAILED', 'RECONCILIATION_REQUIRED')
        OR (
            "failedAtUtc" IS NOT NULL
            AND "lastFailureCode" IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX "QuickBooksInvoiceOperation_id_tenantId_key"
    ON "QuickBooksInvoiceOperation"("id", "tenantId");

CREATE UNIQUE INDEX "QuickBooksInvoiceOperation_tenantId_invoiceId_key"
    ON "QuickBooksInvoiceOperation"("tenantId", "invoiceId");

CREATE UNIQUE INDEX "QuickBooksInvoiceOperation_tenantId_providerRequestId_key"
    ON "QuickBooksInvoiceOperation"("tenantId", "providerRequestId");

CREATE UNIQUE INDEX "QuickBooksInvoiceOperation_connection_providerInvoiceId_key"
    ON "QuickBooksInvoiceOperation"("quickBooksConnectionId", "providerInvoiceId");

CREATE INDEX "QuickBooksInvoiceOperation_status_updated_idx"
    ON "QuickBooksInvoiceOperation"("tenantId", "status", "archivedAtUtc", "updatedAt" DESC, "id" DESC);

CREATE INDEX "QuickBooksInvoiceOperation_claim_expiry_idx"
    ON "QuickBooksInvoiceOperation"("tenantId", "claimExpiresAtUtc", "status");

ALTER TABLE "QuickBooksInvoiceOperation"
    ADD CONSTRAINT "QuickBooksInvoiceOperation_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuickBooksInvoiceOperation"
    ADD CONSTRAINT "QuickBooksInvoiceOperation_invoiceId_tenantId_fkey"
    FOREIGN KEY ("invoiceId", "tenantId")
    REFERENCES "Invoice"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuickBooksInvoiceOperation"
    ADD CONSTRAINT "QuickBooksInvoiceOperation_connection_tenant_fkey"
    FOREIGN KEY ("quickBooksConnectionId", "tenantId")
    REFERENCES "QuickBooksConnection"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuickBooksInvoiceOperation"
    ADD CONSTRAINT "QuickBooksInvoiceOperation_actor_tenant_fkey"
    FOREIGN KEY ("requestedByTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuickBooksInvoiceOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksInvoiceOperation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "QuickBooksInvoiceOperation_tenant_isolation"
    ON "QuickBooksInvoiceOperation";
CREATE POLICY "QuickBooksInvoiceOperation_tenant_isolation"
    ON "QuickBooksInvoiceOperation"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "QuickBooksInvoiceOperation" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "QuickBooksInvoiceOperation" TO quotefly_runtime;
