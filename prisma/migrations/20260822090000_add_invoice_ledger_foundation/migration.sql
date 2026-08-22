-- Phase 4A invoice ledger foundation.
-- This adds QuoteFly-owned invoice/payment status records only. Provider-side
-- invoice/payment creation remains separate until idempotent processing claims
-- and reconciliation are implemented.

CREATE TYPE "InvoiceStatus" AS ENUM (
    'DRAFT',
    'OPEN',
    'PAID',
    'VOID',
    'UNCOLLECTIBLE'
);

CREATE TYPE "InvoicePaymentStatus" AS ENUM (
    'PENDING',
    'SUCCEEDED',
    'FAILED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'CANCELED'
);

CREATE TYPE "InvoicePaymentProvider" AS ENUM (
    'MANUAL',
    'STRIPE',
    'SQUARE',
    'QUICKBOOKS',
    'OTHER'
);

CREATE TYPE "InvoiceEventType" AS ENUM (
    'CREATED',
    'CREATE_REPLAYED',
    'UPDATED',
    'SENT',
    'PAYMENT_RECORDED',
    'PAYMENT_UPDATED',
    'VOIDED',
    'DELETED'
);

CREATE UNIQUE INDEX "Job_id_sourceQuoteId_customerId_tenantId_key"
    ON "Job"("id", "sourceQuoteId", "customerId", "tenantId");

CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceQuoteId" TEXT NOT NULL,
    "invoiceNumber" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "InvoicePaymentStatus" NOT NULL DEFAULT 'PENDING',
    "titleSnapshot" VARCHAR(191) NOT NULL,
    "scopeSnapshot" TEXT,
    "documentLocale" VARCHAR(5) NOT NULL DEFAULT 'en-US',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "subtotalAmount" DECIMAL(10,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(10,2) NOT NULL,
    "issuedAtUtc" TIMESTAMPTZ(3),
    "dueAtUtc" TIMESTAMPTZ(3),
    "sentAtUtc" TIMESTAMPTZ(3),
    "paidAtUtc" TIMESTAMPTZ(3),
    "voidedAtUtc" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAtUtc" TIMESTAMPTZ(3),
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Invoice_number_check" CHECK ("invoiceNumber" >= 1),
    CONSTRAINT "Invoice_title_check" CHECK (char_length(btrim("titleSnapshot")) > 0),
    CONSTRAINT "Invoice_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "Invoice_locale_check" CHECK ("documentLocale" IN ('en-US', 'es-US')),
    CONSTRAINT "Invoice_amounts_check" CHECK (
        "subtotalAmount" >= 0
        AND "taxAmount" >= 0
        AND "totalAmount" >= 0
        AND "amountPaid" >= 0
        AND "balanceDue" >= 0
    ),
    CONSTRAINT "Invoice_balance_check" CHECK ("balanceDue" = "totalAmount" - "amountPaid"),
    CONSTRAINT "Invoice_due_after_issue_check" CHECK (
        "issuedAtUtc" IS NULL
        OR "dueAtUtc" IS NULL
        OR "dueAtUtc" >= "issuedAtUtc"
    ),
    CONSTRAINT "Invoice_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "Invoice_id_tenantId_key"
    ON "Invoice"("id", "tenantId");

CREATE UNIQUE INDEX "Invoice_tenantId_jobId_key"
    ON "Invoice"("tenantId", "jobId");

CREATE UNIQUE INDEX "Invoice_tenantId_sourceQuoteId_key"
    ON "Invoice"("tenantId", "sourceQuoteId");

CREATE UNIQUE INDEX "Invoice_tenantId_invoiceNumber_key"
    ON "Invoice"("tenantId", "invoiceNumber");

CREATE INDEX "Invoice_customer_lifecycle_idx"
    ON "Invoice"("tenantId", "customerId", "deletedAtUtc", "archivedAtUtc");

CREATE INDEX "Invoice_status_updated_idx"
    ON "Invoice"("tenantId", "status", "paymentStatus", "deletedAtUtc", "updatedAt" DESC, "id" DESC);

CREATE INDEX "Invoice_due_status_idx"
    ON "Invoice"("tenantId", "dueAtUtc", "status", "deletedAtUtc", "id");

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId")
    REFERENCES "Customer"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_jobId_sourceQuoteId_customerId_tenantId_fkey"
    FOREIGN KEY ("jobId", "sourceQuoteId", "customerId", "tenantId")
    REFERENCES "Job"("id", "sourceQuoteId", "customerId", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_sourceQuoteId_customerId_tenantId_fkey"
    FOREIGN KEY ("sourceQuoteId", "customerId", "tenantId")
    REFERENCES "Quote"("id", "customerId", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" "InvoicePaymentProvider" NOT NULL,
    "providerPaymentId" VARCHAR(191),
    "providerInvoiceId" VARCHAR(191),
    "status" "InvoicePaymentStatus" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "paidAtUtc" TIMESTAMPTZ(3),
    "failedAtUtc" TIMESTAMPTZ(3),
    "refundedAtUtc" TIMESTAMPTZ(3),
    "receiptUrl" VARCHAR(2048),
    "failureCode" VARCHAR(191),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoicePayment_amount_check" CHECK ("amount" >= 0),
    CONSTRAINT "InvoicePayment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "InvoicePayment_provider_payment_id_check" CHECK (
        "providerPaymentId" IS NULL OR char_length(btrim("providerPaymentId")) > 0
    ),
    CONSTRAINT "InvoicePayment_provider_invoice_id_check" CHECK (
        "providerInvoiceId" IS NULL OR char_length(btrim("providerInvoiceId")) > 0
    ),
    CONSTRAINT "InvoicePayment_receipt_url_check" CHECK (
        "receiptUrl" IS NULL OR char_length(btrim("receiptUrl")) > 0
    )
);

CREATE UNIQUE INDEX "InvoicePayment_id_tenantId_key"
    ON "InvoicePayment"("id", "tenantId");

CREATE UNIQUE INDEX "InvoicePayment_tenantId_provider_providerPaymentId_key"
    ON "InvoicePayment"("tenantId", "provider", "providerPaymentId");

CREATE INDEX "InvoicePayment_invoice_created_idx"
    ON "InvoicePayment"("tenantId", "invoiceId", "deletedAtUtc", "createdAt" DESC, "id" DESC);

CREATE INDEX "InvoicePayment_status_updated_idx"
    ON "InvoicePayment"("tenantId", "status", "deletedAtUtc", "updatedAt" DESC, "id" DESC);

ALTER TABLE "InvoicePayment"
    ADD CONSTRAINT "InvoicePayment_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoicePayment"
    ADD CONSTRAINT "InvoicePayment_invoiceId_tenantId_fkey"
    FOREIGN KEY ("invoiceId", "tenantId")
    REFERENCES "Invoice"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InvoiceEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "actorTenantUserId" TEXT,
    "type" "InvoiceEventType" NOT NULL,
    "fromStatus" "InvoiceStatus",
    "toStatus" "InvoiceStatus",
    "fromPaymentStatus" "InvoicePaymentStatus",
    "toPaymentStatus" "InvoicePaymentStatus",
    "requestId" VARCHAR(191),
    "commandKeyHash" VARCHAR(64),
    "commandPayloadHash" VARCHAR(64),
    "providerEventId" VARCHAR(191),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoiceEvent_command_key_hash_check" CHECK (
        "commandKeyHash" IS NULL OR "commandKeyHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "InvoiceEvent_command_payload_hash_check" CHECK (
        "commandPayloadHash" IS NULL OR "commandPayloadHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "InvoiceEvent_provider_event_id_check" CHECK (
        "providerEventId" IS NULL OR char_length(btrim("providerEventId")) > 0
    )
);

CREATE UNIQUE INDEX "InvoiceEvent_id_tenantId_key"
    ON "InvoiceEvent"("id", "tenantId");

CREATE UNIQUE INDEX "InvoiceEvent_tenantId_commandKeyHash_key"
    ON "InvoiceEvent"("tenantId", "commandKeyHash");

CREATE UNIQUE INDEX "InvoiceEvent_tenantId_providerEventId_key"
    ON "InvoiceEvent"("tenantId", "providerEventId");

CREATE INDEX "InvoiceEvent_invoice_created_idx"
    ON "InvoiceEvent"("tenantId", "invoiceId", "createdAt", "id");

CREATE INDEX "InvoiceEvent_actor_created_idx"
    ON "InvoiceEvent"("tenantId", "actorTenantUserId", "createdAt");

INSERT INTO "TenantSequence" (
    "id",
    "tenantId",
    "key",
    "nextValue",
    "createdAt",
    "updatedAt"
)
SELECT
    'tenantseq_' || tenant."id" || '_invoice_number',
    tenant."id",
    'invoice_number',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant" tenant
ON CONFLICT ("tenantId", "key") DO NOTHING;

ALTER TABLE "InvoiceEvent"
    ADD CONSTRAINT "InvoiceEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceEvent"
    ADD CONSTRAINT "InvoiceEvent_invoiceId_tenantId_fkey"
    FOREIGN KEY ("invoiceId", "tenantId")
    REFERENCES "Invoice"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceEvent"
    ADD CONSTRAINT "InvoiceEvent_actorTenantUserId_tenantId_fkey"
    FOREIGN KEY ("actorTenantUserId", "tenantId")
    REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Invoice_tenant_isolation" ON "Invoice";
CREATE POLICY "Invoice_tenant_isolation"
    ON "Invoice"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "Invoice" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "Invoice" TO quotefly_runtime;

ALTER TABLE "InvoicePayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoicePayment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "InvoicePayment_tenant_isolation" ON "InvoicePayment";
CREATE POLICY "InvoicePayment_tenant_isolation"
    ON "InvoicePayment"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE DELETE, TRUNCATE ON "InvoicePayment" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "InvoicePayment" TO quotefly_runtime;

ALTER TABLE "InvoiceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "InvoiceEvent_tenant_select" ON "InvoiceEvent";
CREATE POLICY "InvoiceEvent_tenant_select"
    ON "InvoiceEvent"
    FOR SELECT
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

DROP POLICY IF EXISTS "InvoiceEvent_tenant_insert" ON "InvoiceEvent";
CREATE POLICY "InvoiceEvent_tenant_insert"
    ON "InvoiceEvent"
    FOR INSERT
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

REVOKE ALL PRIVILEGES ON "InvoiceEvent" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "InvoiceEvent" TO quotefly_runtime;
