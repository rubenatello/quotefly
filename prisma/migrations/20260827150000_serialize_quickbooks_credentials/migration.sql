-- Serialize QuickBooks refresh, disconnect, and retry-revocation operations.
-- A disconnect request that arrives during token rotation is retained until
-- the rotated token is durably stored and moved to REVOCATION_PENDING.

ALTER TABLE "QuickBooksConnection"
  ADD COLUMN "disconnectRequestedAtUtc" TIMESTAMPTZ(3);

-- Repair any pre-release candidate rows produced by the former race before
-- enforcing that every pending revocation has retriable encrypted material.
UPDATE "QuickBooksConnection"
SET
  "status" = 'DISCONNECTED',
  "accessTokenEncrypted" = NULL,
  "accessTokenExpiresAtUtc" = NULL,
  "disconnectedAtUtc" = COALESCE("disconnectedAtUtc", CURRENT_TIMESTAMP),
  "revocationPendingAtUtc" = NULL,
  "revocationAttemptCount" = 0,
  "revocationNextAttemptAtUtc" = NULL,
  "tokenRefreshClaimHash" = NULL,
  "tokenRefreshClaimExpiresAtUtc" = NULL,
  "lastError" = NULL
WHERE "status" = 'REVOCATION_PENDING'
  AND "refreshTokenEncrypted" IS NULL;

ALTER TABLE "QuickBooksConnection"
  ADD CONSTRAINT "QuickBooksConnection_credential_claim_pair_check"
    CHECK (
      ("tokenRefreshClaimHash" IS NULL AND "tokenRefreshClaimExpiresAtUtc" IS NULL)
      OR ("tokenRefreshClaimHash" IS NOT NULL AND "tokenRefreshClaimExpiresAtUtc" IS NOT NULL)
    ),
  ADD CONSTRAINT "QuickBooksConnection_revocation_token_check"
    CHECK (
      "status" <> 'REVOCATION_PENDING'
      OR "refreshTokenEncrypted" IS NOT NULL
    );

CREATE INDEX "QuickBooksConnection_disconnect_request_idx"
  ON "QuickBooksConnection"("tenantId", "disconnectRequestedAtUtc", "status");
