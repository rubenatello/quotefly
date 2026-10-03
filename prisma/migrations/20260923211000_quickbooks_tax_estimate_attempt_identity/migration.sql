-- Retain the original dispatch identity beyond lease expiry/uncertainty so a
-- late provider response can be bound without restoring provider write access.
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD COLUMN "attemptTokenHash" VARCHAR(64);
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_attempt_hash_check"
  CHECK ("attemptTokenHash" IS NULL OR "attemptTokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_attempt_claim_check"
  CHECK ("status" <> 'ESTIMATE_PROCESSING' OR
    ("attemptTokenHash" IS NOT NULL AND "attemptTokenHash" = "claimTokenHash"));
CREATE FUNCTION public.quotefly_tax_estimate_attempt_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."attemptTokenHash" IS NOT NULL AND NEW."attemptTokenHash" IS DISTINCT FROM OLD."attemptTokenHash" THEN
    RAISE EXCEPTION 'Tax Estimate dispatch identity is write-once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "QbTaxEstimate_attempt_immutable" BEFORE UPDATE ON "QuickBooksTaxEstimateOperation"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_tax_estimate_attempt_immutable();
GRANT UPDATE ("attemptTokenHash") ON "QuickBooksTaxEstimateOperation" TO quotefly_runtime;
