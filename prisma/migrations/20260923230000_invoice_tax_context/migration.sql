-- Additive capture only; no inferred tax defaults or backfill.
-- CreateTable
CREATE TABLE "InvoiceTaxContext" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "invoiceVersion" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceQuoteId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "quickBooksConnectionId" TEXT NOT NULL,
    "providerRealmId" VARCHAR(191) NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "connectionConnectedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "customerMapId" TEXT NOT NULL,
    "customerMapReviewVersion" INTEGER NOT NULL,
    "customerMapReviewedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "providerCustomerId" VARCHAR(191) NOT NULL,
    "transactionDate" DATE NOT NULL,
    "origin" JSONB NOT NULL,
    "destination" JSONB NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "subtotalAmount" DECIMAL(10,2) NOT NULL,
    "quotedTaxAmount" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "confirmedByTenantUserId" TEXT NOT NULL,
    "confirmedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "idempotencyKeyHash" VARCHAR(64) NOT NULL,
    "supersededAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "InvoiceTaxContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceTaxContextLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceTaxContextId" TEXT NOT NULL,
    "invoiceLineItemIdSnapshot" VARCHAR(191) NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxIntent" VARCHAR(16) NOT NULL,
    "itemMapId" TEXT NOT NULL,
    "itemMapReviewVersion" INTEGER NOT NULL,
    "itemMapReviewedAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "providerItemId" VARCHAR(191) NOT NULL,
    "itemKey" VARCHAR(120) NOT NULL,

    CONSTRAINT "InvoiceTaxContextLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceTaxContext_tenantId_invoiceId_supersededAtUtc_idx" ON "InvoiceTaxContext"("tenantId", "invoiceId", "supersededAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTaxContext_id_tenantId_key" ON "InvoiceTaxContext"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTaxContext_tenantId_invoiceId_revision_key" ON "InvoiceTaxContext"("tenantId", "invoiceId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTaxContext_idempotency_key" ON "InvoiceTaxContext"("tenantId", "invoiceId", "idempotencyKeyHash");

-- CreateIndex
CREATE INDEX "InvoiceTaxContextLine_tenantId_invoiceTaxContextId_idx" ON "InvoiceTaxContextLine"("tenantId", "invoiceTaxContextId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTaxContextLine_source_line_key" ON "InvoiceTaxContextLine"("invoiceTaxContextId", "invoiceLineItemIdSnapshot");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTaxContextLine_invoiceTaxContextId_position_key" ON "InvoiceTaxContextLine"("invoiceTaxContextId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksCustomerMap_id_tenantId_key" ON "QuickBooksCustomerMap"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksItemMap_id_tenantId_key" ON "QuickBooksItemMap"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_invoice_source_tenant_fkey" FOREIGN KEY ("invoiceId", "sourceQuoteId", "customerId", "tenantId") REFERENCES "Invoice"("id", "sourceQuoteId", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_quickBooksConnectionId_tenantId_fkey" FOREIGN KEY ("quickBooksConnectionId", "tenantId") REFERENCES "QuickBooksConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_customerMapId_tenantId_fkey" FOREIGN KEY ("customerMapId", "tenantId") REFERENCES "QuickBooksCustomerMap"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_confirmedByTenantUserId_tenantId_fkey" FOREIGN KEY ("confirmedByTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContextLine" ADD CONSTRAINT "InvoiceTaxContextLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContextLine" ADD CONSTRAINT "InvoiceTaxContextLine_invoiceTaxContextId_tenantId_fkey" FOREIGN KEY ("invoiceTaxContextId", "tenantId") REFERENCES "InvoiceTaxContext"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTaxContextLine" ADD CONSTRAINT "InvoiceTaxContextLine_itemMapId_tenantId_fkey" FOREIGN KEY ("itemMapId", "tenantId") REFERENCES "QuickBooksItemMap"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InvoiceTaxContext_one_active" ON "InvoiceTaxContext" ("tenantId", "invoiceId") WHERE "supersededAtUtc" IS NULL;
ALTER TABLE "InvoiceTaxContext" ADD CONSTRAINT "InvoiceTaxContext_evidence_check" CHECK (
  "revision" > 0 AND "invoiceVersion" > 0 AND "connectionGeneration" > 0 AND "customerMapReviewVersion" > 0
  AND "lineCount" BETWEEN 1 AND 500 AND "currency" = 'USD' AND "environment" IN ('sandbox', 'production')
  AND "providerRealmId" ~ '^[0-9]{1,64}$' AND char_length("providerCustomerId") > 0
  AND "inputHash" ~ '^[0-9a-f]{64}$' AND "idempotencyKeyHash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("origin") = 'object' AND jsonb_typeof("destination") = 'object'
  AND "subtotalAmount" <> 'NaN'::numeric AND "quotedTaxAmount" <> 'NaN'::numeric AND "totalAmount" <> 'NaN'::numeric
  AND "subtotalAmount" >= 0 AND "quotedTaxAmount" >= 0 AND "totalAmount" = "subtotalAmount" + "quotedTaxAmount"
  AND ("supersededAtUtc" IS NULL OR "supersededAtUtc" >= "confirmedAtUtc")
);
ALTER TABLE "InvoiceTaxContextLine" ADD CONSTRAINT "InvoiceTaxContextLine_evidence_check" CHECK (
  "position" >= 0 AND "itemMapReviewVersion" > 0 AND "taxIntent" IN ('TAXABLE', 'NON_TAXABLE')
  AND char_length("invoiceLineItemIdSnapshot") > 0 AND char_length("providerItemId") > 0 AND char_length("itemKey") > 0
  AND "quantity" <> 'NaN'::numeric AND "unitPrice" <> 'NaN'::numeric AND "amount" <> 'NaN'::numeric
  AND "quantity" > 0 AND "unitPrice" >= 0 AND "amount" >= 0 AND "amount" = round("quantity" * "unitPrice", 2)
);

CREATE FUNCTION public.quotefly_invoice_tax_context_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'InvoiceTaxContextLine' THEN
    RAISE EXCEPTION 'Confirmed tax context lines are immutable' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - 'supersededAtUtc') IS DISTINCT FROM (to_jsonb(OLD) - 'supersededAtUtc')
    OR (OLD."supersededAtUtc" IS NOT NULL AND NEW."supersededAtUtc" IS DISTINCT FROM OLD."supersededAtUtc") THEN
    RAISE EXCEPTION 'Confirmed tax context evidence is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "InvoiceTaxContext_immutable" BEFORE UPDATE ON "InvoiceTaxContext"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_invoice_tax_context_immutable();
CREATE TRIGGER "InvoiceTaxContextLine_immutable" BEFORE UPDATE ON "InvoiceTaxContextLine"
  FOR EACH ROW EXECUTE FUNCTION public.quotefly_invoice_tax_context_immutable();

-- A deferred cardinality check seals the complete child set at transaction commit.
-- Runtime cannot append a line to an already confirmed revision, even with INSERT.
CREATE FUNCTION public.quotefly_invoice_tax_context_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE context_id TEXT; expected_count INTEGER; actual_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'InvoiceTaxContext' THEN context_id := NEW."id";
  ELSE context_id := NEW."invoiceTaxContextId"; END IF;
  SELECT "lineCount" INTO expected_count FROM public."InvoiceTaxContext"
    WHERE "id" = context_id AND "tenantId" = NEW."tenantId" FOR SHARE;
  SELECT count(*) INTO actual_count FROM public."InvoiceTaxContextLine"
    WHERE "invoiceTaxContextId" = context_id AND "tenantId" = NEW."tenantId";
  IF expected_count IS NULL OR actual_count <> expected_count THEN
    RAISE EXCEPTION 'Confirmed tax context line set is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "InvoiceTaxContext_complete" AFTER INSERT ON "InvoiceTaxContext"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quotefly_invoice_tax_context_complete();
CREATE CONSTRAINT TRIGGER "InvoiceTaxContextLine_complete" AFTER INSERT ON "InvoiceTaxContextLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quotefly_invoice_tax_context_complete();

ALTER TABLE "InvoiceTaxContext" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceTaxContext" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceTaxContextLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceTaxContextLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "InvoiceTaxContext_tenant_isolation" ON "InvoiceTaxContext" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY "InvoiceTaxContextLine_tenant_isolation" ON "InvoiceTaxContextLine" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));
REVOKE ALL PRIVILEGES ON "InvoiceTaxContext", "InvoiceTaxContextLine" FROM PUBLIC, quotefly_runtime;
GRANT SELECT, INSERT ON "InvoiceTaxContext", "InvoiceTaxContextLine" TO quotefly_runtime;
GRANT UPDATE ("supersededAtUtc") ON "InvoiceTaxContext" TO quotefly_runtime;
