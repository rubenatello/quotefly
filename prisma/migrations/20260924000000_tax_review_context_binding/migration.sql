-- Additive binding: legacy v1 evidence remains intact but cannot be newly claimed.
ALTER TABLE "QuickBooksTaxEstimateOperation"
 ADD COLUMN "invoiceTaxContextId" TEXT,
 ADD COLUMN "invoiceTaxContextRevision" INTEGER,
 ADD COLUMN "invoiceTaxContextInputHash" VARCHAR(64),
 ADD COLUMN "connectionGeneration" INTEGER;
CREATE UNIQUE INDEX "InvoiceTaxContext_id_invoice_tenant_key" ON "InvoiceTaxContext" ("id", "invoiceId", "tenantId");
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_context_invoice_tenant_fkey"
 FOREIGN KEY ("invoiceTaxContextId", "invoiceId", "tenantId") REFERENCES "InvoiceTaxContext"("id", "invoiceId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksTaxEstimateOperation" ADD CONSTRAINT "QbTaxEstimate_context_binding_check" CHECK (
 ("contractVersion" = 1 AND "invoiceTaxContextId" IS NULL AND "invoiceTaxContextRevision" IS NULL AND "invoiceTaxContextInputHash" IS NULL AND "connectionGeneration" IS NULL)
 OR ("contractVersion" = 2 AND "invoiceTaxContextId" IS NOT NULL AND "invoiceTaxContextRevision" IS NOT NULL AND "invoiceTaxContextRevision" > 0
  AND "invoiceTaxContextInputHash" IS NOT NULL AND "invoiceTaxContextInputHash" ~ '^[0-9a-f]{64}$' AND "connectionGeneration" IS NOT NULL AND "connectionGeneration" > 0)
);
CREATE FUNCTION public.quotefly_tax_estimate_context_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW."invoiceTaxContextId" IS DISTINCT FROM OLD."invoiceTaxContextId"
 OR NEW."invoiceTaxContextRevision" IS DISTINCT FROM OLD."invoiceTaxContextRevision"
 OR NEW."invoiceTaxContextInputHash" IS DISTINCT FROM OLD."invoiceTaxContextInputHash"
 OR NEW."connectionGeneration" IS DISTINCT FROM OLD."connectionGeneration" THEN
  RAISE EXCEPTION 'Tax Estimate context binding is immutable' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER "QbTaxEstimate_context_immutable" BEFORE UPDATE ON "QuickBooksTaxEstimateOperation"
 FOR EACH ROW EXECUTE FUNCTION public.quotefly_tax_estimate_context_immutable();
-- Existing table SELECT/INSERT include new columns; column-scoped UPDATE grants
-- deliberately do not. Existing FORCE RLS and all evidence triggers remain.
