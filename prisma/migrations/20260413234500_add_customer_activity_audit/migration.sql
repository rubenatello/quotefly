-- Add actor snapshot fields for quote revision and outbound events.
ALTER TABLE "QuoteRevision"
  ADD COLUMN "actorUserId" TEXT,
  ADD COLUMN "actorEmail" TEXT,
  ADD COLUMN "actorName" TEXT;

CREATE INDEX "QuoteRevision_tenantId_actorUserId_createdAt_idx"
  ON "QuoteRevision"("tenantId", "actorUserId", "createdAt");

ALTER TABLE "QuoteOutboundEvent"
  ADD COLUMN "actorUserId" TEXT,
  ADD COLUMN "actorEmail" TEXT,
  ADD COLUMN "actorName" TEXT;

CREATE INDEX "QuoteOutboundEvent_tenantId_actorUserId_createdAt_idx"
  ON "QuoteOutboundEvent"("tenantId", "actorUserId", "createdAt");

-- Persist customer-side activity that does not naturally live in quote revision history.
CREATE TABLE "CustomerActivityEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorEmail" TEXT,
  "actorName" TEXT,
  "eventType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAtUtc" TIMESTAMPTZ(3),
  CONSTRAINT "CustomerActivityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerActivityEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomerActivityEvent_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CustomerActivityEvent_tenantId_customerId_createdAt_idx"
  ON "CustomerActivityEvent"("tenantId", "customerId", "createdAt");
CREATE INDEX "CustomerActivityEvent_tenantId_actorUserId_createdAt_idx"
  ON "CustomerActivityEvent"("tenantId", "actorUserId", "createdAt");
CREATE INDEX "CustomerActivityEvent_tenantId_createdAt_idx"
  ON "CustomerActivityEvent"("tenantId", "createdAt");
CREATE INDEX "CustomerActivityEvent_tenantId_deletedAtUtc_idx"
  ON "CustomerActivityEvent"("tenantId", "deletedAtUtc");
