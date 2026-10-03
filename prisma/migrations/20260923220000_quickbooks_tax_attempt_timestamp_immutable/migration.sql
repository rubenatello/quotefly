-- Preserve the original dispatch time alongside the existing write-once token.
-- Initial NULL -> timestamp remains valid; later operational updates may only
-- carry the same timestamp. No existing migration or ledger row is rewritten.
CREATE FUNCTION public.quotefly_tax_estimate_attempt_timestamp_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."lastAttemptAtUtc" IS NOT NULL AND NEW."lastAttemptAtUtc" IS DISTINCT FROM OLD."lastAttemptAtUtc" THEN
    RAISE EXCEPTION 'Tax Estimate original dispatch timestamp is write-once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QbTaxEstimate_attempt_timestamp_immutable" BEFORE UPDATE ON "QuickBooksTaxEstimateOperation"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_tax_estimate_attempt_timestamp_immutable();
