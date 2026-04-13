CREATE TYPE "AiUsageEventType" AS ENUM ('DRAFT', 'REVISE');

CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quoteId" TEXT,
    "customerId" TEXT,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "eventType" "AiUsageEventType" NOT NULL,
    "creditsConsumed" INTEGER NOT NULL DEFAULT 1,
    "promptText" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsageEvent_tenantId_createdAt_idx" ON "AiUsageEvent"("tenantId", "createdAt");
CREATE INDEX "AiUsageEvent_tenantId_eventType_createdAt_idx" ON "AiUsageEvent"("tenantId", "eventType", "createdAt");
CREATE INDEX "AiUsageEvent_tenantId_actorUserId_createdAt_idx" ON "AiUsageEvent"("tenantId", "actorUserId", "createdAt");
CREATE INDEX "AiUsageEvent_tenantId_quoteId_createdAt_idx" ON "AiUsageEvent"("tenantId", "quoteId", "createdAt");
CREATE INDEX "AiUsageEvent_tenantId_deletedAtUtc_idx" ON "AiUsageEvent"("tenantId", "deletedAtUtc");

ALTER TABLE "AiUsageEvent"
ADD CONSTRAINT "AiUsageEvent_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiUsageEvent"
ADD CONSTRAINT "AiUsageEvent_quoteId_fkey"
FOREIGN KEY ("quoteId") REFERENCES "Quote"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiUsageEvent"
ADD CONSTRAINT "AiUsageEvent_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiUsageEvent"
ADD CONSTRAINT "AiUsageEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
