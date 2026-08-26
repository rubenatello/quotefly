CREATE TABLE "InvoiceLineItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "sourceQuoteLineItemIdSnapshot" VARCHAR(191),
  "description" TEXT NOT NULL,
  "sectionType" "QuoteLineSectionType" NOT NULL DEFAULT 'INCLUDED',
  "sectionLabel" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "quantity" DECIMAL(10,2) NOT NULL,
  "unitPrice" DECIMAL(10,2) NOT NULL,
  "lineTotal" DECIMAL(10,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvoiceLineItem_id_tenantId_key"
  ON "InvoiceLineItem"("id", "tenantId");

CREATE INDEX "InvoiceLineItem_invoiceId_tenantId_position_idx"
  ON "InvoiceLineItem"("invoiceId", "tenantId", "position");

CREATE INDEX "InvoiceLineItem_tenantId_sourceQuoteLineItemIdSnapshot_idx"
  ON "InvoiceLineItem"("tenantId", "sourceQuoteLineItemIdSnapshot");

ALTER TABLE "InvoiceLineItem"
  ADD CONSTRAINT "InvoiceLineItem_invoiceId_tenantId_fkey"
  FOREIGN KEY ("invoiceId", "tenantId")
  REFERENCES "Invoice"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceLineItem"
  ADD CONSTRAINT "InvoiceLineItem_tenantId_fkey"
  FOREIGN KEY ("tenantId")
  REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceLineItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceLineItem" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "InvoiceLineItem_tenant_isolation" ON "InvoiceLineItem";
CREATE POLICY "InvoiceLineItem_tenant_isolation"
  ON "InvoiceLineItem"
  FOR ALL
  USING (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
  )
  WITH CHECK (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
  );

REVOKE UPDATE, DELETE, TRUNCATE ON "InvoiceLineItem" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "InvoiceLineItem" TO quotefly_runtime;
