-- Preserve an immutable lifecycle record when Intuit rejects or revokes a
-- connection credential and QuoteFly requires the workspace to reconnect.

ALTER TABLE "QuickBooksConnectionEvent"
  DROP CONSTRAINT "QuickBooksConnectionEvent_action_check";

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_action_check"
  CHECK (
    "action" IN (
      'CONNECT_STARTED',
      'CONNECTED',
      'RECONNECTED',
      'COMPANY_SWITCHED',
      'SETUP_CONFIRMED',
      'REAUTH_REQUIRED',
      'DISCONNECT_REQUESTED',
      'DISCONNECTED'
    )
  );

-- AES-GCM/base64url expands the reviewed provider URL. Keep the provider URL
-- itself bounded at 2,048 characters while allowing room for the encrypted
-- envelope and rotation/version metadata.
ALTER TABLE "QuickBooksInvoiceOperation"
  ALTER COLUMN "providerInvoiceLink" TYPE VARCHAR(4096);

-- InvoiceLink is a restricted capability URL. Earlier releases stored it as
-- plaintext. Clear cached values once; the next canonical reconciliation will
-- persist a purpose-bound encrypted envelope instead.
-- Fence active provider-bound rows first. Keeping this separate from the
-- catch-all clearing statement avoids modifying the same row twice in one
-- PostgreSQL statement, whose result would otherwise be unpredictable.
UPDATE "QuickBooksInvoiceOperation"
SET
  "status" = 'RECONCILIATION_REQUIRED',
  "claimTokenHash" = NULL,
  "claimExpiresAtUtc" = NULL,
  "providerInvoiceLink" = NULL,
  "invoiceLinkFetchedAtUtc" = NULL,
  "providerSyncToken" = NULL,
  "providerInvoiceStatus" = NULL,
  "providerBalance" = NULL,
  "providerUpdatedAtUtc" = NULL,
  "lastReconciledAtUtc" = NULL,
  "succeededAtUtc" = NULL,
  "failedAtUtc" = CURRENT_TIMESTAMP,
  "lastFailureCode" = 'QUICKBOOKS_HOSTED_LINK_REENCRYPTION_REQUIRED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "providerInvoiceLink" IS NOT NULL
  AND "archivedAtUtc" IS NULL
  AND "providerInvoiceId" IS NOT NULL;

-- Clear every remaining plaintext capability, including archived operations
-- and defensive provider-ID-null rows, without changing their lifecycle.
UPDATE "QuickBooksInvoiceOperation"
SET
  "providerInvoiceLink" = NULL,
  "invoiceLinkFetchedAtUtc" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "providerInvoiceLink" IS NOT NULL;
