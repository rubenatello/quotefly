-- Retain a complete provider identity tuple before canonical reconciliation.
-- This is evidence of the original one-shot attempt, never canonical proof by
-- itself. Existing ID-only retained rows remain valid for backward safety.
ALTER TABLE "QuickBooksTaxEstimateOperation"
  DROP CONSTRAINT "QbTaxEstimate_identity_check",
  DROP CONSTRAINT "QbTaxEstimate_proof_check",
  ADD CONSTRAINT "QbTaxEstimate_identity_check" CHECK (
    char_length(btrim("providerRealmId")) > 0 AND char_length(btrim("bindingKeyId")) > 0
    AND char_length(btrim("estimateRequestId")) > 0 AND char_length(btrim("invoiceRequestId")) > 0
    AND "estimateRequestId" <> "invoiceRequestId"
    AND ("providerEstimateId" IS NULL OR char_length(btrim("providerEstimateId")) > 0)
    AND ("providerEstimateSyncToken" IS NULL OR "providerEstimateSyncToken" ~ '^(0|[1-9][0-9]*)$')
  ),
  ADD CONSTRAINT "QbTaxEstimate_proof_check" CHECK (
    -- No canonical proof. An ID alone is retained legacy evidence.
    (
      "providerEstimateSyncToken" IS NULL
      AND "providerEstimateUpdatedAtUtc" IS NULL
      AND "canonicalEstimateHash" IS NULL
      AND "providerSubtotal" IS NULL
      AND "providerTax" IS NULL
      AND "providerTotal" IS NULL
      AND "canonicalAtUtc" IS NULL
    )
    OR
    -- Complete retained identity, deliberately still noncanonical.
    (
      "providerEstimateId" IS NOT NULL
      AND "providerEstimateSyncToken" IS NOT NULL
      AND "providerEstimateUpdatedAtUtc" IS NOT NULL
      AND "canonicalEstimateHash" IS NULL
      AND "providerSubtotal" IS NULL
      AND "providerTax" IS NULL
      AND "providerTotal" IS NULL
      AND "canonicalAtUtc" IS NULL
      AND "status" IN ('ESTIMATE_RECONCILIATION_REQUIRED', 'SUPERSEDED')
    )
    OR
    -- Canonical positive-tax proof remains complete and atomic.
    (
      "providerEstimateId" IS NOT NULL
      AND "providerEstimateSyncToken" IS NOT NULL
      AND "providerEstimateUpdatedAtUtc" IS NOT NULL
      AND "canonicalEstimateHash" IS NOT NULL
      AND "providerSubtotal" IS NOT NULL
      AND "providerTax" IS NOT NULL
      AND "providerTotal" IS NOT NULL
      AND "canonicalAtUtc" IS NOT NULL
      AND "status" IN ('ESTIMATE_CANONICAL', 'SUPERSEDED')
      AND "providerSubtotal" <> 'NaN'::numeric
      AND "providerTax" <> 'NaN'::numeric
      AND "providerTotal" <> 'NaN'::numeric
      AND "providerSubtotal" >= 0
      AND "providerTax" > 0
      AND "providerTotal" = "providerSubtotal" + "providerTax"
    )
  );
