-- CreateEnum
CREATE TYPE "QuickBooksConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "QuickBooksInvoiceSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "QuickBooksConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "companyName" TEXT,
    "status" "QuickBooksConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "accessTokenExpiresAtUtc" TIMESTAMPTZ(3),
    "refreshTokenRotatedAtUtc" TIMESTAMPTZ(3),
    "connectedAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAtUtc" TIMESTAMPTZ(3),
    "lastTokenRefreshAtUtc" TIMESTAMPTZ(3),
    "lastSyncAtUtc" TIMESTAMPTZ(3),
    "lastWebhookAtUtc" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuickBooksConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksCustomerMap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quickBooksConnectionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quickBooksCustomerId" TEXT NOT NULL,
    "quickBooksDisplayName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuickBooksCustomerMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksItemMap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quickBooksConnectionId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "quickBooksItemId" TEXT NOT NULL,
    "quickBooksItemName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'line_description',
    "workPresetId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuickBooksItemMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksInvoiceSync" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quickBooksConnectionId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "quickBooksInvoiceId" TEXT,
    "quickBooksDocNumber" TEXT,
    "requestId" TEXT,
    "status" "QuickBooksInvoiceSyncStatus" NOT NULL DEFAULT 'PENDING',
    "payloadSnapshot" JSONB,
    "lastError" TEXT,
    "lastAttemptedAtUtc" TIMESTAMPTZ(3),
    "syncedAtUtc" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuickBooksInvoiceSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksWebhookEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "quickBooksConnectionId" TEXT,
    "webhookEventId" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAtUtc" TIMESTAMPTZ(3),
    "lastError" TEXT,

    CONSTRAINT "QuickBooksWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksConnection_tenantId_key" ON "QuickBooksConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksConnection_realmId_key" ON "QuickBooksConnection"("realmId");

-- CreateIndex
CREATE INDEX "QuickBooksConnection_tenantId_status_idx" ON "QuickBooksConnection"("tenantId", "status");

-- CreateIndex
CREATE INDEX "QuickBooksConnection_realmId_deletedAtUtc_idx" ON "QuickBooksConnection"("realmId", "deletedAtUtc");

-- CreateIndex
CREATE INDEX "QuickBooksCustomerMap_tenantId_deletedAtUtc_idx" ON "QuickBooksCustomerMap"("tenantId", "deletedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksCustomerMap_quickBooksConnectionId_customerId_key" ON "QuickBooksCustomerMap"("quickBooksConnectionId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksCustomerMap_quickBooksConnectionId_quickBooksCust_key" ON "QuickBooksCustomerMap"("quickBooksConnectionId", "quickBooksCustomerId");

-- CreateIndex
CREATE INDEX "QuickBooksItemMap_tenantId_deletedAtUtc_idx" ON "QuickBooksItemMap"("tenantId", "deletedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksItemMap_quickBooksConnectionId_itemKey_key" ON "QuickBooksItemMap"("quickBooksConnectionId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksItemMap_quickBooksConnectionId_quickBooksItemId_key" ON "QuickBooksItemMap"("quickBooksConnectionId", "quickBooksItemId");

-- CreateIndex
CREATE INDEX "QuickBooksInvoiceSync_tenantId_status_deletedAtUtc_idx" ON "QuickBooksInvoiceSync"("tenantId", "status", "deletedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksInvoiceSync_quickBooksConnectionId_quoteId_key" ON "QuickBooksInvoiceSync"("quickBooksConnectionId", "quoteId");

-- CreateIndex
CREATE INDEX "QuickBooksWebhookEvent_realmId_receivedAtUtc_idx" ON "QuickBooksWebhookEvent"("realmId", "receivedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksWebhookEvent_webhookEventId_realmId_key" ON "QuickBooksWebhookEvent"("webhookEventId", "realmId");

-- AddForeignKey
ALTER TABLE "QuickBooksConnection" ADD CONSTRAINT "QuickBooksConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksCustomerMap" ADD CONSTRAINT "QuickBooksCustomerMap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksCustomerMap" ADD CONSTRAINT "QuickBooksCustomerMap_quickBooksConnectionId_fkey" FOREIGN KEY ("quickBooksConnectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksCustomerMap" ADD CONSTRAINT "QuickBooksCustomerMap_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksItemMap" ADD CONSTRAINT "QuickBooksItemMap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksItemMap" ADD CONSTRAINT "QuickBooksItemMap_quickBooksConnectionId_fkey" FOREIGN KEY ("quickBooksConnectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksItemMap" ADD CONSTRAINT "QuickBooksItemMap_workPresetId_fkey" FOREIGN KEY ("workPresetId") REFERENCES "WorkPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksInvoiceSync" ADD CONSTRAINT "QuickBooksInvoiceSync_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksInvoiceSync" ADD CONSTRAINT "QuickBooksInvoiceSync_quickBooksConnectionId_fkey" FOREIGN KEY ("quickBooksConnectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksInvoiceSync" ADD CONSTRAINT "QuickBooksInvoiceSync_quoteId_tenantId_fkey" FOREIGN KEY ("quoteId", "tenantId") REFERENCES "Quote"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksWebhookEvent" ADD CONSTRAINT "QuickBooksWebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksWebhookEvent" ADD CONSTRAINT "QuickBooksWebhookEvent_quickBooksConnectionId_fkey" FOREIGN KEY ("quickBooksConnectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
