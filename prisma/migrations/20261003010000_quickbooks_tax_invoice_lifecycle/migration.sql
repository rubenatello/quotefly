-- Additive, default-off taxable Invoice durability. No route or provider writer
-- is enabled by this migration. Existing rows remain direct NON-tax operations.
ALTER TABLE "QuickBooksInvoiceOperation"
  ADD COLUMN "taxEstimateOperationId" TEXT,
  ADD COLUMN "taxAttemptTokenHash" VARCHAR(64),
  ADD COLUMN "taxCanonicalInvoiceHash" VARCHAR(64),
  ADD COLUMN "taxProjectionMatchedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "taxParityContractVersion" INTEGER;

CREATE UNIQUE INDEX "QbTaxEstimate_invoice_request_binding_key"
  ON "QuickBooksTaxEstimateOperation"("id", "invoiceRequestId", "invoiceId", "quickBooksConnectionId", "tenantId");

CREATE UNIQUE INDEX "QbInvoiceOperation_tax_estimate_key"
  ON "QuickBooksInvoiceOperation"("taxEstimateOperationId");

CREATE UNIQUE INDEX "QbInvoiceOperation_tax_binding_key"
  ON "QuickBooksInvoiceOperation"("taxEstimateOperationId", "providerRequestId", "invoiceId", "quickBooksConnectionId", "tenantId");

ALTER TABLE "QuickBooksInvoiceOperation"
  ADD CONSTRAINT "QbInvoiceOperation_tax_estimate_binding_fkey"
  FOREIGN KEY ("taxEstimateOperationId", "providerRequestId", "invoiceId", "quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksTaxEstimateOperation"("id", "invoiceRequestId", "invoiceId", "quickBooksConnectionId", "tenantId")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "QbInvoiceOperation_tax_hashes_check" CHECK (
    ("taxAttemptTokenHash" IS NULL OR "taxAttemptTokenHash" ~ '^[0-9a-f]{64}$')
    AND ("taxCanonicalInvoiceHash" IS NULL OR "taxCanonicalInvoiceHash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "QbInvoiceOperation_tax_mode_check" CHECK (
    (
      "taxEstimateOperationId" IS NULL
      AND "taxAttemptTokenHash" IS NULL
      AND "taxCanonicalInvoiceHash" IS NULL
      AND "taxProjectionMatchedAtUtc" IS NULL
      AND "taxParityContractVersion" IS NULL
    )
    OR (
      "taxEstimateOperationId" IS NOT NULL
      AND "taxAttemptTokenHash" IS NOT NULL
      AND "attemptCount" = 1
      AND "status" <> 'SUCCEEDED'
      AND (
        (
          "taxCanonicalInvoiceHash" IS NULL
          AND "taxProjectionMatchedAtUtc" IS NULL
          AND "taxParityContractVersion" IS NULL
        )
        OR (
          "taxCanonicalInvoiceHash" IS NOT NULL
          AND "taxProjectionMatchedAtUtc" IS NOT NULL
          AND "taxParityContractVersion" IS NOT NULL
          AND "taxParityContractVersion" = 1
          AND "providerInvoiceId" IS NOT NULL
          AND "status" = 'RECONCILIATION_REQUIRED'
        )
      )
    )
  );

CREATE FUNCTION public.quotefly_tax_invoice_operation_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."taxEstimateOperationId" IS DISTINCT FROM NEW."taxEstimateOperationId" THEN
    RAISE EXCEPTION 'Tax Invoice operation mode binding is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."taxEstimateOperationId" IS NOT NULL AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
    OR NEW."quickBooksConnectionId" IS DISTINCT FROM OLD."quickBooksConnectionId"
    OR NEW."requestedByTenantUserId" IS DISTINCT FROM OLD."requestedByTenantUserId"
    OR NEW."commandKeyHash" IS DISTINCT FROM OLD."commandKeyHash"
    OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
    OR NEW."providerRealmId" IS DISTINCT FROM OLD."providerRealmId"
    OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId"
    OR NEW."providerDocNumber" IS DISTINCT FROM OLD."providerDocNumber"
    OR NEW."processingStartedAtUtc" IS DISTINCT FROM OLD."processingStartedAtUtc"
    OR NEW."lastAttemptAtUtc" IS DISTINCT FROM OLD."lastAttemptAtUtc"
    OR NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount"
    OR NEW."taxAttemptTokenHash" IS DISTINCT FROM OLD."taxAttemptTokenHash"
  ) THEN
    RAISE EXCEPTION 'Tax Invoice attempt identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."taxEstimateOperationId" IS NOT NULL AND (
    (OLD."providerInvoiceId" IS NOT NULL AND NEW."providerInvoiceId" IS DISTINCT FROM OLD."providerInvoiceId")
    OR (OLD."taxCanonicalInvoiceHash" IS NOT NULL AND NEW."taxCanonicalInvoiceHash" IS DISTINCT FROM OLD."taxCanonicalInvoiceHash")
    OR (OLD."taxProjectionMatchedAtUtc" IS NOT NULL AND NEW."taxProjectionMatchedAtUtc" IS DISTINCT FROM OLD."taxProjectionMatchedAtUtc")
    OR (OLD."taxParityContractVersion" IS NOT NULL AND NEW."taxParityContractVersion" IS DISTINCT FROM OLD."taxParityContractVersion")
  ) THEN
    RAISE EXCEPTION 'Tax Invoice provider and projection evidence is write-once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.quotefly_tax_invoice_operation_immutable() FROM PUBLIC;

CREATE TRIGGER "QbInvoiceOperation_tax_immutable"
  BEFORE UPDATE ON "QuickBooksInvoiceOperation"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_tax_invoice_operation_immutable();

-- Replace the historical table-wide UPDATE privilege so newly added columns do
-- not silently become mutable. Existing direct retry fields remain available;
-- the trigger above freezes their identity values for tax-bound rows.
ALTER TABLE "QuickBooksInvoiceOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksInvoiceOperation" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "QuickBooksInvoiceOperation" FROM PUBLIC;
REVOKE UPDATE ON "QuickBooksInvoiceOperation" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "QuickBooksInvoiceOperation" TO quotefly_runtime;
GRANT UPDATE (
  "tenantId", "invoiceId", "quickBooksConnectionId", "requestedByTenantUserId",
  "status", "commandKeyHash", "payloadHash", "providerRealmId", "claimTokenHash",
  "providerRequestId", "providerInvoiceId", "providerDocNumber", "providerInvoiceLink",
  "providerSyncToken", "providerInvoiceStatus", "providerBalance", "providerUpdatedAtUtc",
  "invoiceLinkFetchedAtUtc", "allowOnlineAchPayment", "allowOnlineCardPayment",
  "attemptCount", "reconciliationCount", "processingStartedAtUtc", "claimExpiresAtUtc",
  "lastAttemptAtUtc", "lastReconciledAtUtc", "succeededAtUtc", "failedAtUtc",
  "lastFailureCode", "updatedAt", "archivedAtUtc", "taxCanonicalInvoiceHash",
  "taxProjectionMatchedAtUtc", "taxParityContractVersion"
) ON "QuickBooksInvoiceOperation" TO quotefly_runtime;
REVOKE DELETE, TRUNCATE ON "QuickBooksInvoiceOperation" FROM quotefly_runtime;
