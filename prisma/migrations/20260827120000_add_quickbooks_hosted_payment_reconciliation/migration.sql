-- QuickBooks hosted-payment and durable reconciliation foundation.
-- Provider workflows remain default-off; this migration only makes the
-- tenant-safe state machine available for controlled sandbox verification.

ALTER TYPE "QuickBooksConnectionStatus" ADD VALUE IF NOT EXISTS 'REVOCATION_PENDING';
ALTER TYPE "InvoicePaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_PAID';

CREATE TYPE "QuickBooksWebhookEventStatus" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DEAD'
);

ALTER TABLE "Invoice"
  ADD COLUMN "billingEmailSnapshot" VARCHAR(320);

UPDATE "Invoice" invoice
SET "billingEmailSnapshot" = lower(btrim(customer."email"))
FROM "Customer" customer
WHERE customer."id" = invoice."customerId"
  AND customer."tenantId" = invoice."tenantId"
  AND customer."email" IS NOT NULL
  AND btrim(customer."email") <> '';

ALTER TABLE "InvoicePayment"
  ADD COLUMN "refundedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "providerSyncToken" VARCHAR(191),
  ADD COLUMN "providerUpdatedAtUtc" TIMESTAMPTZ(3),
  ADD CONSTRAINT "InvoicePayment_refunded_amount_check"
    CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount");

DROP INDEX "InvoicePayment_tenantId_provider_providerPaymentId_key";
CREATE UNIQUE INDEX "InvoicePayment_provider_application_key"
  ON "InvoicePayment"("tenantId", "provider", "providerPaymentId", "invoiceId");

ALTER TABLE "QuickBooksInvoiceOperation"
  ADD COLUMN "providerInvoiceLink" VARCHAR(2048),
  ADD COLUMN "providerSyncToken" VARCHAR(191),
  ADD COLUMN "providerInvoiceStatus" VARCHAR(191),
  ADD COLUMN "providerBalance" DECIMAL(10,2),
  ADD COLUMN "providerUpdatedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "invoiceLinkFetchedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "allowOnlineAchPayment" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowOnlineCardPayment" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "QuickBooksInvoiceOperation_balance_check"
    CHECK ("providerBalance" IS NULL OR "providerBalance" >= 0),
  ADD CONSTRAINT "QuickBooksInvoiceOperation_link_check"
    CHECK ("providerInvoiceLink" IS NULL OR char_length(btrim("providerInvoiceLink")) > 0);

ALTER TABLE "QuickBooksConnection"
  ADD COLUMN "allowOnlineAchPayment" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowOnlineCardPayment" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revocationPendingAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "revocationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revocationNextAttemptAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "tokenRefreshClaimHash" VARCHAR(64),
  ADD COLUMN "tokenRefreshClaimExpiresAtUtc" TIMESTAMPTZ(3),
  ADD CONSTRAINT "QuickBooksConnection_revocation_attempt_check"
    CHECK ("revocationAttemptCount" >= 0),
  ADD CONSTRAINT "QuickBooksConnection_refresh_claim_hash_check"
    CHECK ("tokenRefreshClaimHash" IS NULL OR "tokenRefreshClaimHash" ~ '^[0-9a-f]{64}$');
CREATE INDEX "QuickBooksConnection_refresh_claim_idx"
  ON "QuickBooksConnection"("tenantId", "tokenRefreshClaimExpiresAtUtc");

ALTER TABLE "QuickBooksCustomerMap"
  DROP CONSTRAINT "QuickBooksCustomerMap_quickBooksConnectionId_fkey";
ALTER TABLE "QuickBooksCustomerMap"
  ADD COLUMN "reviewedByTenantUserId" TEXT,
  ADD COLUMN "reviewedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "reviewVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "QuickBooksCustomerMap_review_version_check" CHECK ("reviewVersion" >= 0),
  ADD CONSTRAINT "QuickBooksCustomerMap_review_pair_check" CHECK (
    ("reviewedByTenantUserId" IS NULL AND "reviewedAtUtc" IS NULL AND "reviewVersion" = 0)
    OR ("reviewedByTenantUserId" IS NOT NULL AND "reviewedAtUtc" IS NOT NULL AND "reviewVersion" > 0)
  );
ALTER TABLE "QuickBooksCustomerMap"
  ADD CONSTRAINT "QuickBooksCustomerMap_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickBooksCustomerMap"
  ADD CONSTRAINT "QuickBooksCustomerMap_reviewer_tenant_fkey"
  FOREIGN KEY ("reviewedByTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "QuickBooksCustomerMap_reviewer_reviewed_idx"
  ON "QuickBooksCustomerMap"("tenantId", "reviewedByTenantUserId", "reviewedAtUtc");

ALTER TABLE "QuickBooksItemMap"
  ADD COLUMN "reviewedByTenantUserId" TEXT,
  ADD COLUMN "reviewedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "reviewVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "QuickBooksItemMap_review_version_check" CHECK ("reviewVersion" >= 0),
  ADD CONSTRAINT "QuickBooksItemMap_review_pair_check" CHECK (
    ("reviewedByTenantUserId" IS NULL AND "reviewedAtUtc" IS NULL AND "reviewVersion" = 0)
    OR ("reviewedByTenantUserId" IS NOT NULL AND "reviewedAtUtc" IS NOT NULL AND "reviewVersion" > 0)
  );
ALTER TABLE "QuickBooksItemMap"
  ADD CONSTRAINT "QuickBooksItemMap_reviewer_tenant_fkey"
  FOREIGN KEY ("reviewedByTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "QuickBooksItemMap_reviewer_reviewed_idx"
  ON "QuickBooksItemMap"("tenantId", "reviewedByTenantUserId", "reviewedAtUtc");

ALTER TABLE "QuickBooksInvoiceSync"
  DROP CONSTRAINT "QuickBooksInvoiceSync_quickBooksConnectionId_fkey";
ALTER TABLE "QuickBooksInvoiceSync"
  ADD CONSTRAINT "QuickBooksInvoiceSync_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuickBooksWebhookEvent"
  DROP CONSTRAINT "QuickBooksWebhookEvent_quickBooksConnectionId_fkey";
ALTER TABLE "QuickBooksWebhookEvent"
  ADD COLUMN "operation" TEXT,
  ADD COLUMN "providerUpdatedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "status" "QuickBooksWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "claimTokenHash" VARCHAR(64),
  ADD COLUMN "claimExpiresAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "deadAtUtc" TIMESTAMPTZ(3),
  ADD CONSTRAINT "QuickBooksWebhookEvent_claim_hash_check"
    CHECK ("claimTokenHash" IS NULL OR "claimTokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "QuickBooksWebhookEvent_attempt_check"
    CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "QuickBooksWebhookEvent_connection_tenant_pair_check"
    CHECK (
      ("quickBooksConnectionId" IS NULL AND "tenantId" IS NULL)
      OR ("quickBooksConnectionId" IS NOT NULL AND "tenantId" IS NOT NULL)
    );
ALTER TABLE "QuickBooksWebhookEvent"
  ADD CONSTRAINT "QuickBooksWebhookEvent_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "QuickBooksWebhookEvent_worker_idx"
  ON "QuickBooksWebhookEvent"(
    "tenantId", "status", "nextAttemptAtUtc", "claimExpiresAtUtc", "receivedAtUtc", "id"
  );

CREATE TABLE "QuickBooksOAuthState" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quickBooksConnectionId" TEXT,
  "userId" TEXT NOT NULL,
  "stateHash" VARCHAR(64) NOT NULL,
  "expiresAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "consumedAtUtc" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickBooksOAuthState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuickBooksOAuthState_stateHash_key" ON "QuickBooksOAuthState"("stateHash");
CREATE UNIQUE INDEX "QuickBooksOAuthState_id_tenantId_key" ON "QuickBooksOAuthState"("id", "tenantId");
CREATE INDEX "QuickBooksOAuthState_tenant_expiry_consumed_idx"
  ON "QuickBooksOAuthState"("tenantId", "expiresAtUtc", "consumedAtUtc");
ALTER TABLE "QuickBooksOAuthState"
  ADD CONSTRAINT "QuickBooksOAuthState_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickBooksOAuthState"
  ADD CONSTRAINT "QuickBooksOAuthState_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "QuickBooksRealmBinding" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quickBooksConnectionId" TEXT NOT NULL,
  "realmId" VARCHAR(191) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickBooksRealmBinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuickBooksRealmBinding_connection_key" ON "QuickBooksRealmBinding"("quickBooksConnectionId");
CREATE UNIQUE INDEX "QuickBooksRealmBinding_realm_key" ON "QuickBooksRealmBinding"("realmId");
CREATE UNIQUE INDEX "QuickBooksRealmBinding_id_tenantId_key" ON "QuickBooksRealmBinding"("id", "tenantId");
CREATE UNIQUE INDEX "QuickBooksRealmBinding_connection_tenant_key"
  ON "QuickBooksRealmBinding"("quickBooksConnectionId", "tenantId");
CREATE INDEX "QuickBooksRealmBinding_tenant_active_idx" ON "QuickBooksRealmBinding"("tenantId", "active");
ALTER TABLE "QuickBooksRealmBinding"
  ADD CONSTRAINT "QuickBooksRealmBinding_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickBooksRealmBinding"
  ADD CONSTRAINT "QuickBooksRealmBinding_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "QuickBooksRealmBinding" (
  "id", "tenantId", "quickBooksConnectionId", "realmId", "active", "createdAt", "updatedAt"
)
SELECT
  'qbrb_' || connection."id",
  connection."tenantId",
  connection."id",
  connection."realmId",
  connection."status" = 'CONNECTED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "QuickBooksConnection" connection
ON CONFLICT ("realmId") DO NOTHING;

CREATE TABLE "QuickBooksCdcCursor" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quickBooksConnectionId" TEXT NOT NULL,
  "changedSinceUtc" TIMESTAMPTZ(3) NOT NULL,
  "lastAttemptAtUtc" TIMESTAMPTZ(3),
  "lastSucceededAtUtc" TIMESTAMPTZ(3),
  "nextAttemptAtUtc" TIMESTAMPTZ(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" VARCHAR(191),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickBooksCdcCursor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuickBooksCdcCursor_attempt_check" CHECK ("attemptCount" >= 0)
);
CREATE UNIQUE INDEX "QuickBooksCdcCursor_connection_key" ON "QuickBooksCdcCursor"("quickBooksConnectionId");
CREATE UNIQUE INDEX "QuickBooksCdcCursor_id_tenantId_key" ON "QuickBooksCdcCursor"("id", "tenantId");
CREATE UNIQUE INDEX "QuickBooksCdcCursor_connection_tenant_key"
  ON "QuickBooksCdcCursor"("quickBooksConnectionId", "tenantId");
CREATE INDEX "QuickBooksCdcCursor_tenant_next_updated_idx"
  ON "QuickBooksCdcCursor"("tenantId", "nextAttemptAtUtc", "updatedAt");
ALTER TABLE "QuickBooksCdcCursor"
  ADD CONSTRAINT "QuickBooksCdcCursor_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickBooksCdcCursor"
  ADD CONSTRAINT "QuickBooksCdcCursor_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned QuickBooks records are fail-closed under the runtime role.
ALTER TABLE "QuickBooksConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksConnection_tenant_isolation" ON "QuickBooksConnection" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksCustomerMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksCustomerMap" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksCustomerMap_tenant_isolation" ON "QuickBooksCustomerMap" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksItemMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksItemMap" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksItemMap_tenant_isolation" ON "QuickBooksItemMap" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksInvoiceSync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksInvoiceSync" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksInvoiceSync_tenant_isolation" ON "QuickBooksInvoiceSync" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksWebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksWebhookEvent_tenant_isolation" ON "QuickBooksWebhookEvent" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksOAuthState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksOAuthState" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksOAuthState_tenant_isolation" ON "QuickBooksOAuthState" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE "QuickBooksCdcCursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksCdcCursor" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksCdcCursor_tenant_isolation" ON "QuickBooksCdcCursor" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

-- Webhook ingress may resolve exactly one realm before it knows the tenant.
-- The application sets app.quickbooks_webhook_realm_id transaction-locally;
-- writes remain tenant-only through WITH CHECK.
ALTER TABLE "QuickBooksRealmBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksRealmBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksRealmBinding_tenant_or_webhook_lookup"
  ON "QuickBooksRealmBinding" FOR ALL
  USING (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    OR "realmId" = NULLIF(current_setting('app.quickbooks_webhook_realm_id', true), '')
  )
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE DELETE, TRUNCATE ON
  "QuickBooksConnection", "QuickBooksCustomerMap", "QuickBooksItemMap",
  "QuickBooksInvoiceSync", "QuickBooksWebhookEvent", "QuickBooksOAuthState",
  "QuickBooksCdcCursor", "QuickBooksRealmBinding"
FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON
  "QuickBooksConnection", "QuickBooksCustomerMap", "QuickBooksItemMap",
  "QuickBooksInvoiceSync", "QuickBooksWebhookEvent", "QuickBooksOAuthState",
  "QuickBooksCdcCursor", "QuickBooksRealmBinding"
TO quotefly_runtime;
