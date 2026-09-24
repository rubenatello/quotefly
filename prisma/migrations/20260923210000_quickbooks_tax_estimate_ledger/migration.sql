-- Additive restricted ledger only. No provider calls, backfill, or financial projection.
CREATE TYPE "QuickBooksTaxEstimateOperationStatus" AS ENUM (
  'REVIEWED', 'ESTIMATE_PROCESSING', 'ESTIMATE_RECONCILIATION_REQUIRED',
  'ESTIMATE_CANONICAL', 'FAILED', 'SUPERSEDED'
);

CREATE UNIQUE INDEX "Invoice_id_sourceQuoteId_customerId_tenantId_key"
  ON "Invoice"("id", "sourceQuoteId", "customerId", "tenantId");

CREATE TABLE "QuickBooksTaxEstimateOperation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "sourceQuoteId" TEXT NOT NULL,
  "quickBooksConnectionId" TEXT NOT NULL,
  "requestedByTenantUserId" TEXT NOT NULL,
  "reviewedByTenantUserId" TEXT NOT NULL,
  "providerRealmId" VARCHAR(191) NOT NULL,
  "status" "QuickBooksTaxEstimateOperationStatus" NOT NULL DEFAULT 'REVIEWED',
  "reviewRevision" INTEGER NOT NULL,
  "contractVersion" INTEGER NOT NULL,
  "invoiceVersion" INTEGER NOT NULL,
  "connectionGenerationAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "estimateAstSnapshot" JSONB NOT NULL,
  "sourceHash" VARCHAR(64) NOT NULL,
  "estimateAstHash" VARCHAR(64) NOT NULL,
  "reviewBindingDigest" VARCHAR(64) NOT NULL,
  "bindingKeyId" VARCHAR(32) NOT NULL,
  "estimateRequestId" VARCHAR(191) NOT NULL,
  "invoiceRequestId" VARCHAR(191) NOT NULL,
  "claimTokenHash" VARCHAR(64),
  "claimExpiresAtUtc" TIMESTAMPTZ(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAtUtc" TIMESTAMPTZ(3),
  "providerEstimateId" VARCHAR(191),
  "providerEstimateSyncToken" VARCHAR(191),
  "providerEstimateUpdatedAtUtc" TIMESTAMPTZ(3),
  "canonicalEstimateHash" VARCHAR(64),
  "providerSubtotal" DECIMAL(10,2),
  "providerTax" DECIMAL(10,2),
  "providerTotal" DECIMAL(10,2),
  "reviewedAtUtc" TIMESTAMPTZ(3) NOT NULL,
  "uncertainAtUtc" TIMESTAMPTZ(3),
  "canonicalAtUtc" TIMESTAMPTZ(3),
  "failedAtUtc" TIMESTAMPTZ(3),
  "supersededAtUtc" TIMESTAMPTZ(3),
  "lastFailureCode" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickBooksTaxEstimateOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QbTaxEstimate_hashes_check" CHECK (
    "sourceHash" ~ '^[0-9a-f]{64}$' AND "estimateAstHash" ~ '^[0-9a-f]{64}$'
    AND "reviewBindingDigest" ~ '^[0-9a-f]{64}$'
    AND ("claimTokenHash" IS NULL OR "claimTokenHash" ~ '^[0-9a-f]{64}$')
    AND ("canonicalEstimateHash" IS NULL OR "canonicalEstimateHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "QbTaxEstimate_identity_check" CHECK (
    char_length(btrim("providerRealmId")) > 0 AND char_length(btrim("bindingKeyId")) > 0
    AND char_length(btrim("estimateRequestId")) > 0 AND char_length(btrim("invoiceRequestId")) > 0
    AND "estimateRequestId" <> "invoiceRequestId"
    AND ("providerEstimateId" IS NULL OR char_length(btrim("providerEstimateId")) > 0)
    AND ("providerEstimateSyncToken" IS NULL OR char_length(btrim("providerEstimateSyncToken")) > 0)
  ),
  CONSTRAINT "QbTaxEstimate_versions_check" CHECK (
    "reviewRevision" > 0 AND "contractVersion" > 0 AND "invoiceVersion" > 0 AND "attemptCount" >= 0
  ),
  CONSTRAINT "QbTaxEstimate_claim_check" CHECK (
    ("status" = 'ESTIMATE_PROCESSING' AND "claimTokenHash" IS NOT NULL
      AND "claimExpiresAtUtc" IS NOT NULL AND "lastAttemptAtUtc" IS NOT NULL
      AND "claimExpiresAtUtc" > "lastAttemptAtUtc" AND "attemptCount" > 0)
    OR ("status" <> 'ESTIMATE_PROCESSING' AND "claimTokenHash" IS NULL AND "claimExpiresAtUtc" IS NULL)
  ),
  CONSTRAINT "QbTaxEstimate_failure_code_check" CHECK (
    "lastFailureCode" IS NULL OR "lastFailureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT "QbTaxEstimate_uncertainty_check" CHECK (
    "status" <> 'ESTIMATE_RECONCILIATION_REQUIRED' OR
    ("uncertainAtUtc" IS NOT NULL AND "lastFailureCode" IS NOT NULL
      AND "lastFailureCode" = 'QUICKBOOKS_ESTIMATE_RECONCILIATION_REQUIRED')
  ),
  CONSTRAINT "QbTaxEstimate_failure_check" CHECK (
    "status" <> 'FAILED' OR ("failedAtUtc" IS NOT NULL AND "lastFailureCode" IS NOT NULL)
  ),
  CONSTRAINT "QbTaxEstimate_supersession_check" CHECK (
    ("status" = 'SUPERSEDED') = ("supersededAtUtc" IS NOT NULL)
  ),
  -- An ID may be durably retained after an ambiguous provider response. All other
  -- proof is atomic; partial proof cannot masquerade as a canonical Estimate.
  CONSTRAINT "QbTaxEstimate_proof_check" CHECK (
    ("providerEstimateSyncToken" IS NULL AND "providerEstimateUpdatedAtUtc" IS NULL AND "canonicalEstimateHash" IS NULL AND "providerSubtotal" IS NULL AND "providerTax" IS NULL AND "providerTotal" IS NULL AND "canonicalAtUtc" IS NULL)
    OR ("providerEstimateId" IS NOT NULL AND "providerEstimateSyncToken" IS NOT NULL AND "providerEstimateUpdatedAtUtc" IS NOT NULL AND "canonicalEstimateHash" IS NOT NULL AND "providerSubtotal" IS NOT NULL AND "providerTax" IS NOT NULL AND "providerTotal" IS NOT NULL AND "canonicalAtUtc" IS NOT NULL
      AND "status" IN ('ESTIMATE_CANONICAL', 'SUPERSEDED')
      AND "providerSubtotal" <> 'NaN'::numeric AND "providerTax" <> 'NaN'::numeric
      AND "providerTotal" <> 'NaN'::numeric
      AND "providerSubtotal" >= 0 AND "providerTax" > 0
      AND "providerTotal" = "providerSubtotal" + "providerTax")
  ),
  CONSTRAINT "QbTaxEstimate_canonical_check" CHECK (
    "status" <> 'ESTIMATE_CANONICAL' OR "canonicalAtUtc" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "QuickBooksTaxEstimateOperation_id_tenantId_key" ON "QuickBooksTaxEstimateOperation"("id", "tenantId");
CREATE UNIQUE INDEX "QbTaxEstimate_tenant_invoice_revision_key" ON "QuickBooksTaxEstimateOperation"("tenantId", "invoiceId", "reviewRevision");
CREATE UNIQUE INDEX "QbTaxEstimate_tenant_estimate_request_key" ON "QuickBooksTaxEstimateOperation"("tenantId", "estimateRequestId");
CREATE UNIQUE INDEX "QbTaxEstimate_tenant_invoice_request_key" ON "QuickBooksTaxEstimateOperation"("tenantId", "invoiceRequestId");
CREATE UNIQUE INDEX "QbTaxEstimate_connection_provider_estimate_key" ON "QuickBooksTaxEstimateOperation"("quickBooksConnectionId", "providerEstimateId");
CREATE UNIQUE INDEX "QbTaxEstimate_active_invoice_key" ON "QuickBooksTaxEstimateOperation"("tenantId", "invoiceId") WHERE "supersededAtUtc" IS NULL;
CREATE INDEX "QbTaxEstimate_tenant_status_claim_idx" ON "QuickBooksTaxEstimateOperation"("tenantId", "status", "claimExpiresAtUtc");
CREATE INDEX "QbTaxEstimate_tenant_invoice_created_idx" ON "QuickBooksTaxEstimateOperation"("tenantId", "invoiceId", "createdAt" DESC);

ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QuickBooksTaxEstimateOperation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_invoice_source_customer_tenant_fkey"
  FOREIGN KEY ("invoiceId", "sourceQuoteId", "customerId", "tenantId") REFERENCES "Invoice"("id", "sourceQuoteId", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QuickBooksTaxEstimateOperation_customerId_tenantId_fkey"
  FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_quote_customer_tenant_fkey"
  FOREIGN KEY ("sourceQuoteId", "customerId", "tenantId") REFERENCES "Quote"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId") REFERENCES "QuickBooksConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_requester_tenant_fkey"
  FOREIGN KEY ("requestedByTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_reviewer_tenant_fkey"
  FOREIGN KEY ("reviewedByTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION public.quotefly_tax_estimate_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."sourceQuoteId" IS DISTINCT FROM OLD."sourceQuoteId"
    OR NEW."quickBooksConnectionId" IS DISTINCT FROM OLD."quickBooksConnectionId"
    OR NEW."requestedByTenantUserId" IS DISTINCT FROM OLD."requestedByTenantUserId"
    OR NEW."reviewedByTenantUserId" IS DISTINCT FROM OLD."reviewedByTenantUserId"
    OR NEW."providerRealmId" IS DISTINCT FROM OLD."providerRealmId"
    OR NEW."reviewRevision" IS DISTINCT FROM OLD."reviewRevision"
    OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
    OR NEW."invoiceVersion" IS DISTINCT FROM OLD."invoiceVersion"
    OR NEW."connectionGenerationAtUtc" IS DISTINCT FROM OLD."connectionGenerationAtUtc"
    OR NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot"
    OR NEW."estimateAstSnapshot" IS DISTINCT FROM OLD."estimateAstSnapshot"
    OR NEW."sourceHash" IS DISTINCT FROM OLD."sourceHash"
    OR NEW."estimateAstHash" IS DISTINCT FROM OLD."estimateAstHash"
    OR NEW."reviewBindingDigest" IS DISTINCT FROM OLD."reviewBindingDigest"
    OR NEW."bindingKeyId" IS DISTINCT FROM OLD."bindingKeyId"
    OR NEW."estimateRequestId" IS DISTINCT FROM OLD."estimateRequestId"
    OR NEW."invoiceRequestId" IS DISTINCT FROM OLD."invoiceRequestId"
    OR NEW."reviewedAtUtc" IS DISTINCT FROM OLD."reviewedAtUtc"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Tax Estimate review identity and snapshots are immutable' USING ERRCODE = '42501';
  END IF;
  IF (OLD."providerEstimateId" IS NOT NULL AND NEW."providerEstimateId" IS DISTINCT FROM OLD."providerEstimateId")
    OR (OLD."providerEstimateSyncToken" IS NOT NULL AND NEW."providerEstimateSyncToken" IS DISTINCT FROM OLD."providerEstimateSyncToken")
    OR (OLD."providerEstimateUpdatedAtUtc" IS NOT NULL AND NEW."providerEstimateUpdatedAtUtc" IS DISTINCT FROM OLD."providerEstimateUpdatedAtUtc")
    OR (OLD."canonicalEstimateHash" IS NOT NULL AND NEW."canonicalEstimateHash" IS DISTINCT FROM OLD."canonicalEstimateHash")
    OR (OLD."providerSubtotal" IS NOT NULL AND NEW."providerSubtotal" IS DISTINCT FROM OLD."providerSubtotal")
    OR (OLD."providerTax" IS NOT NULL AND NEW."providerTax" IS DISTINCT FROM OLD."providerTax")
    OR (OLD."providerTotal" IS NOT NULL AND NEW."providerTotal" IS DISTINCT FROM OLD."providerTotal")
    OR (OLD."canonicalAtUtc" IS NOT NULL AND NEW."canonicalAtUtc" IS DISTINCT FROM OLD."canonicalAtUtc") THEN
    RAISE EXCEPTION 'Tax Estimate provider identity and canonical proof are write-once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "QbTaxEstimate_identity_immutable" BEFORE UPDATE ON "QuickBooksTaxEstimateOperation"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_tax_estimate_immutable();

ALTER TABLE "QuickBooksTaxEstimateOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksTaxEstimateOperation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QbTaxEstimate_tenant_isolation" ON "QuickBooksTaxEstimateOperation" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

-- Defeat broad default privileges: operational state only is mutable by runtime.
REVOKE ALL PRIVILEGES ON "QuickBooksTaxEstimateOperation" FROM PUBLIC, quotefly_runtime;
GRANT SELECT, INSERT ON "QuickBooksTaxEstimateOperation" TO quotefly_runtime;
GRANT UPDATE (
  "status",
  "claimTokenHash",
  "claimExpiresAtUtc",
  "attemptCount",
  "lastAttemptAtUtc",
  "providerEstimateId",
  "providerEstimateSyncToken",
  "providerEstimateUpdatedAtUtc",
  "canonicalEstimateHash",
  "providerSubtotal",
  "providerTax",
  "providerTotal",
  "uncertainAtUtc",
  "canonicalAtUtc",
  "failedAtUtc",
  "supersededAtUtc",
  "lastFailureCode",
  "updatedAt"
) ON "QuickBooksTaxEstimateOperation" TO quotefly_runtime;
