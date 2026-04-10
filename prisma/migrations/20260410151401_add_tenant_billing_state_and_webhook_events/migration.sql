-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "subscriptionCurrentPeriodEndUtc" TIMESTAMPTZ(3),
ADD COLUMN     "subscriptionPlanCode" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT NOT NULL DEFAULT 'inactive',
ADD COLUMN     "trialEndsAtUtc" TIMESTAMPTZ(3),
ADD COLUMN     "trialStartsAtUtc" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "tenantId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAtUtc" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_stripeEventId_key" ON "BillingWebhookEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_tenantId_createdAt_idx" ON "BillingWebhookEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_createdAt_idx" ON "BillingWebhookEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "BillingWebhookEvent" ADD CONSTRAINT "BillingWebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
