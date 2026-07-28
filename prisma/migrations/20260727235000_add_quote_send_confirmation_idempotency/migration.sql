ALTER TYPE "QuoteOutboundChannel" ADD VALUE IF NOT EXISTS 'NATIVE_SHARE';

ALTER TABLE "QuoteOutboundEvent" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "QuoteOutboundEvent_tenantId_idempotencyKey_key"
  ON "QuoteOutboundEvent"("tenantId", "idempotencyKey");
