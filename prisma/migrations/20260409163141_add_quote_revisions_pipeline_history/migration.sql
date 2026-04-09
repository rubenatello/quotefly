-- CreateEnum
CREATE TYPE "QuoteRevisionEventType" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'LINE_ITEM_CHANGED', 'DECISION');

-- CreateTable
CREATE TABLE "QuoteRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "eventType" "QuoteRevisionEventType" NOT NULL DEFAULT 'UPDATED',
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL,
    "customerPriceSubtotal" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuoteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteRevision_quoteId_tenantId_version_idx" ON "QuoteRevision"("quoteId", "tenantId", "version");

-- CreateIndex
CREATE INDEX "QuoteRevision_tenantId_customerId_createdAt_idx" ON "QuoteRevision"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteRevision_tenantId_createdAt_idx" ON "QuoteRevision"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteRevision_tenantId_deletedAtUtc_idx" ON "QuoteRevision"("tenantId", "deletedAtUtc");

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_quoteId_tenantId_fkey" FOREIGN KEY ("quoteId", "tenantId") REFERENCES "Quote"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
