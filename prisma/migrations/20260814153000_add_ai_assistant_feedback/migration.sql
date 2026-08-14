CREATE TYPE "AiAssistantFeedbackRating" AS ENUM ('UP', 'DOWN');

CREATE UNIQUE INDEX "AiUsageEvent_id_tenantId_key"
    ON "AiUsageEvent"("id", "tenantId");

CREATE TABLE "AiAssistantFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aiUsageEventId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "rating" "AiAssistantFeedbackRating" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAtUtc" TIMESTAMPTZ(3),

    CONSTRAINT "AiAssistantFeedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiAssistantFeedback_tenant_event_match_check"
        CHECK (length("tenantId") > 0 AND length("aiUsageEventId") > 0)
);

CREATE UNIQUE INDEX "AiAssistantFeedback_tenantId_aiUsageEventId_actorUserId_key"
    ON "AiAssistantFeedback"("tenantId", "aiUsageEventId", "actorUserId");

CREATE INDEX "AiAssistantFeedback_tenantId_rating_createdAt_idx"
    ON "AiAssistantFeedback"("tenantId", "rating", "createdAt");

CREATE INDEX "AiAssistantFeedback_tenantId_actorUserId_createdAt_idx"
    ON "AiAssistantFeedback"("tenantId", "actorUserId", "createdAt");

CREATE INDEX "AiAssistantFeedback_aiUsageEventId_idx"
    ON "AiAssistantFeedback"("aiUsageEventId");

CREATE INDEX "AiAssistantFeedback_deletedAtUtc_idx"
    ON "AiAssistantFeedback"("deletedAtUtc");

ALTER TABLE "AiAssistantFeedback"
    ADD CONSTRAINT "AiAssistantFeedback_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiAssistantFeedback"
    ADD CONSTRAINT "AiAssistantFeedback_aiUsageEventId_tenantId_fkey"
    FOREIGN KEY ("aiUsageEventId", "tenantId") REFERENCES "AiUsageEvent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiAssistantFeedback"
    ADD CONSTRAINT "AiAssistantFeedback_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
