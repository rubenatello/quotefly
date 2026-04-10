-- CreateEnum
CREATE TYPE "QuoteOutboundChannel" AS ENUM ('EMAIL_APP', 'SMS_APP', 'COPY');

-- CreateTable
CREATE TABLE "QuoteOutboundEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "QuoteOutboundChannel" NOT NULL,
    "destination" TEXT,
    "subject" TEXT,
    "bodyPreview" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "QuoteOutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteOutboundEvent_tenantId_quoteId_createdAt_idx" ON "QuoteOutboundEvent"("tenantId", "quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteOutboundEvent_tenantId_customerId_createdAt_idx" ON "QuoteOutboundEvent"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteOutboundEvent_tenantId_deletedAtUtc_idx" ON "QuoteOutboundEvent"("tenantId", "deletedAtUtc");

-- AddForeignKey
ALTER TABLE "QuoteOutboundEvent" ADD CONSTRAINT "QuoteOutboundEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOutboundEvent" ADD CONSTRAINT "QuoteOutboundEvent_quoteId_tenantId_fkey" FOREIGN KEY ("quoteId", "tenantId") REFERENCES "Quote"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOutboundEvent" ADD CONSTRAINT "QuoteOutboundEvent_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
