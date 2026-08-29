-- Hosted InvoiceLink values are restricted provider data. Existing rows may
-- predate the disconnect/reconnect and terminal-invoice lifecycle fences.
-- Clear every cached link and provider generation once so a fresh canonical
-- reconciliation is required before the API can expose a hosted payment URL.
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
  "lastFailureCode" = 'QUICKBOOKS_CONNECTION_REAUTH_RECONCILIATION_REQUIRED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "archivedAtUtc" IS NULL
  AND "providerInvoiceId" IS NOT NULL
  AND (
    "providerInvoiceLink" IS NOT NULL
    OR "invoiceLinkFetchedAtUtc" IS NOT NULL
    OR "lastReconciledAtUtc" IS NOT NULL
  );
