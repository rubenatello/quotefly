-- Preserve an Intuit refresh credential when OAuth succeeds but QuoteFly's
-- post-exchange authorization/lifecycle CAS rejects attachment to a connection.
-- The row is deliberately separate from QuickBooksConnection: retry cleanup
-- can never activate, replace, or mutate a tenant's valid provider connection.

CREATE TYPE "QuickBooksOrphanCredentialRevocationStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'REVOKED',
  'DEAD'
);

CREATE TABLE "QuickBooksOrphanCredentialRevocation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "dedupeKeyHash" VARCHAR(64) NOT NULL,
  "refreshTokenEncrypted" TEXT,
  "status" "QuickBooksOrphanCredentialRevocationStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 1,
  "nextAttemptAtUtc" TIMESTAMPTZ(3),
  "claimTokenHash" VARCHAR(64),
  "claimExpiresAtUtc" TIMESTAMPTZ(3),
  "lastAttemptAtUtc" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(191),
  "revokedAtUtc" TIMESTAMPTZ(3),
  "deadAtUtc" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QuickBooksOrphanCredentialRevocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuickBooksOrphanCredentialRevocation_attempt_check"
    CHECK ("attemptCount" >= 1),
  CONSTRAINT "QuickBooksOrphanCredentialRevocation_claim_pair_check"
    CHECK (
      ("claimTokenHash" IS NULL AND "claimExpiresAtUtc" IS NULL)
      OR ("claimTokenHash" IS NOT NULL AND "claimExpiresAtUtc" IS NOT NULL)
    ),
  CONSTRAINT "QuickBooksOrphanCredentialRevocation_state_check"
    CHECK (
      (
        "status" = 'PENDING'
        AND "refreshTokenEncrypted" IS NOT NULL
        AND "nextAttemptAtUtc" IS NOT NULL
        AND "claimTokenHash" IS NULL
        AND "revokedAtUtc" IS NULL
        AND "deadAtUtc" IS NULL
      )
      OR (
        "status" = 'PROCESSING'
        AND "refreshTokenEncrypted" IS NOT NULL
        AND "claimTokenHash" IS NOT NULL
        AND "revokedAtUtc" IS NULL
        AND "deadAtUtc" IS NULL
      )
      OR (
        "status" = 'REVOKED'
        AND "refreshTokenEncrypted" IS NULL
        AND "nextAttemptAtUtc" IS NULL
        AND "claimTokenHash" IS NULL
        AND "revokedAtUtc" IS NOT NULL
        AND "deadAtUtc" IS NULL
      )
      OR (
        "status" = 'DEAD'
        AND "refreshTokenEncrypted" IS NOT NULL
        AND "nextAttemptAtUtc" IS NULL
        AND "claimTokenHash" IS NULL
        AND "revokedAtUtc" IS NULL
        AND "deadAtUtc" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "QuickBooksOrphanCredentialRevocation_id_tenantId_key"
  ON "QuickBooksOrphanCredentialRevocation"("id", "tenantId");
CREATE UNIQUE INDEX "QuickBooksOrphanCredentialRevocation_tenantId_dedupeKeyHash_key"
  ON "QuickBooksOrphanCredentialRevocation"("tenantId", "dedupeKeyHash");
CREATE INDEX "QuickBooksOrphanCredentialRevocation_worker_idx"
  ON "QuickBooksOrphanCredentialRevocation"(
    "tenantId", "status", "nextAttemptAtUtc", "claimExpiresAtUtc", "createdAt", "id"
  );

ALTER TABLE "QuickBooksOrphanCredentialRevocation"
  ADD CONSTRAINT "QuickBooksOrphanCredentialRevocation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuickBooksOrphanCredentialRevocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksOrphanCredentialRevocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksOrphanCredentialRevocation_tenant_isolation"
  ON "QuickBooksOrphanCredentialRevocation" FOR ALL TO quotefly_runtime
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE DELETE, TRUNCATE ON "QuickBooksOrphanCredentialRevocation" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "QuickBooksOrphanCredentialRevocation" TO quotefly_runtime;
