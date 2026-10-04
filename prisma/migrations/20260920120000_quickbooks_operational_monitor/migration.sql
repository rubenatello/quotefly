-- Additive content-free platform metrics and fixed-recipient delivery state. No backfill.
CREATE TABLE "QuickBooksOperationalAlertState" (
 "alertCode" VARCHAR(40) PRIMARY KEY,
 "severity" VARCHAR(10) NOT NULL CHECK ("severity" IN ('HEALTHY','WARNING','CRITICAL')),
 "active" BOOLEAN NOT NULL DEFAULT false,
 "incidentGeneration" INTEGER NOT NULL DEFAULT 0 CHECK ("incidentGeneration" >= 0),
 "firstObservedAtUtc" TIMESTAMPTZ(3) NOT NULL,
 "conditionSinceUtc" TIMESTAMPTZ(3),
 "lastObservedAtUtc" TIMESTAMPTZ(3) NOT NULL,
 "failureStreak" INTEGER NOT NULL DEFAULT 0 CHECK ("failureStreak" >= 0),
 "healthyStreak" INTEGER NOT NULL DEFAULT 0 CHECK ("healthyStreak" >= 0),
 "lastReminderAtUtc" TIMESTAMPTZ(3)
);
CREATE TABLE "QuickBooksOperationalAlertDelivery" (
 "id" TEXT PRIMARY KEY,
 "dedupeKeyHash" VARCHAR(64) NOT NULL UNIQUE CHECK ("dedupeKeyHash" ~ '^[0-9a-f]{64}$'),
 "alertCode" VARCHAR(40) NOT NULL,
 "incidentGeneration" INTEGER NOT NULL CHECK ("incidentGeneration" > 0),
 "transition" VARCHAR(10) NOT NULL CHECK ("transition" IN ('OPEN','ESCALATE','REMINDER','RECOVER')),
 "severity" VARCHAR(10) NOT NULL CHECK ("severity" IN ('HEALTHY','WARNING','CRITICAL')),
 "metrics" JSONB NOT NULL CHECK (jsonb_typeof("metrics") = 'object' AND octet_length("metrics"::text) <= 2048),
 "configurationHash" VARCHAR(64) NOT NULL CHECK ("configurationHash" ~ '^[0-9a-f]{64}$'),
 "observedAtUtc" TIMESTAMPTZ(3) NOT NULL,
 "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','PROCESSING','SENT','TERMINAL')),
 "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" >= 0),
 "claimToken" VARCHAR(36),
 "claimExpiresAtUtc" TIMESTAMPTZ(3),
 "firstAttemptAtUtc" TIMESTAMPTZ(3),
 "nextAttemptAtUtc" TIMESTAMPTZ(3) NOT NULL,
 "sentAtUtc" TIMESTAMPTZ(3),
 "lastErrorCode" VARCHAR(40)
);
CREATE INDEX "QuickBooksOperationalAlertDelivery_due_idx" ON "QuickBooksOperationalAlertDelivery"("status", "nextAttemptAtUtc", "observedAtUtc");
-- These tables contain no tenant identifiers/content and intentionally use the existing platform role.
REVOKE ALL ON "QuickBooksOperationalAlertState", "QuickBooksOperationalAlertDelivery" FROM PUBLIC, quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "QuickBooksOperationalAlertState", "QuickBooksOperationalAlertDelivery" TO quotefly_runtime;
