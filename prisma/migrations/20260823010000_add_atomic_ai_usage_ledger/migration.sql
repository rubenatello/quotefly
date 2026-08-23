-- Atomic tenant/month accounting for paid AI work. Usage rows remain the
-- content-minimized audit trail; these tables are accounting/control-plane
-- records and are intentionally excluded from retrieval and vector indexing.

-- Stripe Dahlia exposes subscription billing bounds on the configured item.
-- Persist both endpoints; a paid period start must never be guessed by
-- subtracting a month from its end (proration and anchors make that unsafe).
ALTER TABLE "Tenant"
    ADD COLUMN "subscriptionCurrentPeriodStartUtc" TIMESTAMPTZ(3);

ALTER TYPE "AiUsageEventType" ADD VALUE IF NOT EXISTS 'ACCOUNTING';
CREATE TYPE "AiUsageReservationKind" AS ENUM ('OPERATION', 'PROVIDER_CALL');
CREATE TYPE "AiUsageReservationState" AS ENUM (
    'RESERVED',
    'STARTED',
    'SETTLED',
    'VOIDED',
    'AMBIGUOUS_CHARGED',
    'EXPIRED_CHARGED',
    'ACCOUNTING_INCIDENT'
);

CREATE TABLE "AiUsagePeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStartUtc" TIMESTAMPTZ(3) NOT NULL,
    "periodEndUtc" TIMESTAMPTZ(3) NOT NULL,
    "completedCredits" INTEGER NOT NULL DEFAULT 0,
    "completedCostMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AiUsagePeriod_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiUsagePeriod_bounds_check" CHECK ("periodEndUtc" > "periodStartUtc"),
    CONSTRAINT "AiUsagePeriod_credits_check" CHECK ("completedCredits" >= 0),
    CONSTRAINT "AiUsagePeriod_cost_check" CHECK ("completedCostMicros" >= 0)
);

CREATE UNIQUE INDEX "AiUsagePeriod_id_tenantId_key" ON "AiUsagePeriod"("id", "tenantId");
CREATE UNIQUE INDEX "AiUsagePeriod_tenantId_periodStartUtc_key" ON "AiUsagePeriod"("tenantId", "periodStartUtc");
CREATE INDEX "AiUsagePeriod_tenantId_periodEndUtc_idx" ON "AiUsagePeriod"("tenantId", "periodEndUtc");

ALTER TABLE "AiUsagePeriod"
    ADD CONSTRAINT "AiUsagePeriod_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiUsageReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "parentReservationId" TEXT,
    "actorTenantUserId" TEXT,
    "kind" "AiUsageReservationKind" NOT NULL,
    "state" "AiUsageReservationState" NOT NULL DEFAULT 'RESERVED',
    "operation" VARCHAR(64) NOT NULL,
    "model" VARCHAR(191),
    "pricingVersion" VARCHAR(64),
    "inputRateMicrosPerM" BIGINT,
    "outputRateMicrosPerM" BIGINT,
    "idempotencyKeyHash" VARCHAR(64) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "reservedCredits" INTEGER NOT NULL DEFAULT 0,
    "actualCredits" INTEGER,
    "ceilingCostMicros" BIGINT NOT NULL DEFAULT 0,
    "actualCostMicros" BIGINT,
    "serializedInputBytes" INTEGER,
    "maxOutputTokens" INTEGER,
    "providerStartedAtUtc" TIMESTAMPTZ(3),
    "expiresAtUtc" TIMESTAMPTZ(3) NOT NULL,
    "finalizedAtUtc" TIMESTAMPTZ(3),
    "incidentCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AiUsageReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiUsageReservation_operation_check" CHECK (char_length(btrim("operation")) > 0),
    CONSTRAINT "AiUsageReservation_hashes_check" CHECK (
        "idempotencyKeyHash" ~ '^[0-9a-f]{64}$' AND "requestHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AiUsageReservation_amounts_check" CHECK (
        "reservedCredits" >= 0 AND ("actualCredits" IS NULL OR "actualCredits" >= 0)
        AND ("actualCredits" IS NULL OR "actualCredits" <= "reservedCredits")
        AND "ceilingCostMicros" >= 0
        AND ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0)
        AND ("serializedInputBytes" IS NULL OR "serializedInputBytes" >= 0)
        AND ("maxOutputTokens" IS NULL OR "maxOutputTokens" >= 0)
        AND ("inputRateMicrosPerM" IS NULL OR "inputRateMicrosPerM" > 0)
        AND ("outputRateMicrosPerM" IS NULL OR "outputRateMicrosPerM" >= 0)
    ),
    CONSTRAINT "AiUsageReservation_parent_kind_check" CHECK (
        (
            "kind" = 'OPERATION'
            AND "parentReservationId" IS NULL
            AND "model" IS NULL
            AND "pricingVersion" IS NULL
            AND "inputRateMicrosPerM" IS NULL
            AND "outputRateMicrosPerM" IS NULL
            AND "serializedInputBytes" IS NULL
            AND "maxOutputTokens" IS NULL
            AND "ceilingCostMicros" = 0
            AND ("actualCostMicros" IS NULL OR "actualCostMicros" = 0)
        )
        OR (
            "kind" = 'PROVIDER_CALL'
            AND "parentReservationId" IS NOT NULL
            AND "model" IS NOT NULL
            AND char_length(btrim("model")) > 0
            AND "pricingVersion" IS NOT NULL
            AND char_length(btrim("pricingVersion")) > 0
            AND "inputRateMicrosPerM" IS NOT NULL
            AND "outputRateMicrosPerM" IS NOT NULL
            AND "serializedInputBytes" IS NOT NULL
            AND "serializedInputBytes" > 0
            AND "maxOutputTokens" IS NOT NULL
            AND "reservedCredits" = 0
            AND ("actualCredits" IS NULL OR "actualCredits" = 0)
            AND "ceilingCostMicros" > 0
        )
    ),
    CONSTRAINT "AiUsageReservation_final_state_check" CHECK (
        ("state" IN ('RESERVED', 'STARTED') AND "finalizedAtUtc" IS NULL)
        OR ("state" NOT IN ('RESERVED', 'STARTED') AND "finalizedAtUtc" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "AiUsageReservation_id_tenantId_key" ON "AiUsageReservation"("id", "tenantId");
CREATE UNIQUE INDEX "AiUsageReservation_id_tenantId_periodId_key"
    ON "AiUsageReservation"("id", "tenantId", "periodId");
CREATE UNIQUE INDEX "AiUsageReservation_tenantId_kind_idempotencyKeyHash_key"
    ON "AiUsageReservation"("tenantId", "kind", "idempotencyKeyHash");
CREATE INDEX "AiUsageReservation_tenantId_periodId_state_expiresAtUtc_idx"
    ON "AiUsageReservation"("tenantId", "periodId", "state", "expiresAtUtc");
CREATE INDEX "AiUsageReservation_tenantId_parentReservationId_state_idx"
    ON "AiUsageReservation"("tenantId", "parentReservationId", "state");
CREATE INDEX "AiUsageReservation_tenantId_actorTenantUserId_createdAt_idx"
    ON "AiUsageReservation"("tenantId", "actorTenantUserId", "createdAt");

ALTER TABLE "AiUsageReservation"
    ADD CONSTRAINT "AiUsageReservation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageReservation"
    ADD CONSTRAINT "AiUsageReservation_periodId_tenantId_fkey"
    FOREIGN KEY ("periodId", "tenantId") REFERENCES "AiUsagePeriod"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageReservation"
    ADD CONSTRAINT "AiUsageReservation_parentReservationId_tenantId_periodId_fkey"
    FOREIGN KEY ("parentReservationId", "tenantId", "periodId") REFERENCES "AiUsageReservation"("id", "tenantId", "periodId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiUsageReservation"
    ADD CONSTRAINT "AiUsageReservation_actorTenantUserId_tenantId_fkey"
    FOREIGN KEY ("actorTenantUserId", "tenantId") REFERENCES "TenantUser"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiUsageEvent"
    ADD COLUMN "rootReservationId" TEXT,
    ADD COLUMN "ledgerAccountedAtUtc" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "AiUsageEvent_tenantId_rootReservationId_key"
    ON "AiUsageEvent"("tenantId", "rootReservationId");

ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_rootReservationId_tenantId_fkey"
    FOREIGN KEY ("rootReservationId", "tenantId") REFERENCES "AiUsageReservation"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Build an exact UTC-calendar-month baseline from every nondeleted historical
-- event before enabling the old-binary bridge.
INSERT INTO "AiUsagePeriod" (
    "id", "tenantId", "periodStartUtc", "periodEndUtc",
    "completedCredits", "completedCostMicros", "createdAt", "updatedAt"
)
SELECT
    md5(event."tenantId" || ':' || (extract(epoch FROM date_trunc('month', event."createdAt", 'UTC'))::bigint)::text),
    event."tenantId",
    date_trunc('month', event."createdAt", 'UTC'),
    date_trunc('month', event."createdAt", 'UTC') + interval '1 month',
    COALESCE(SUM(event."creditsConsumed"), 0)::integer,
    COALESCE(ROUND(SUM(COALESCE(event."estimatedCostUsd", 0)) * 1000000), 0)::bigint,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "AiUsageEvent" event
WHERE event."deletedAtUtc" IS NULL
GROUP BY event."tenantId", date_trunc('month', event."createdAt", 'UTC')
ON CONFLICT ("tenantId", "periodStartUtc") DO NOTHING;

UPDATE "AiUsageEvent"
SET "ledgerAccountedAtUtc" = COALESCE("createdAt", CURRENT_TIMESTAMP)
WHERE "deletedAtUtc" IS NULL;

-- Compatibility bridge for a rolling deployment: an older API binary may
-- still insert an unlinked usage event. New binaries always link the root and
-- set ledgerAccountedAtUtc, so linked events can never double count.
CREATE OR REPLACE FUNCTION quotefly_bridge_legacy_ai_usage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    bound_tenant TEXT;
    billing_status TEXT;
    trial_start TIMESTAMPTZ;
    trial_end TIMESTAMPTZ;
    subscription_period_start TIMESTAMPTZ;
    subscription_period_end TIMESTAMPTZ;
    period_start TIMESTAMPTZ;
    period_end TIMESTAMPTZ;
    period_id TEXT;
BEGIN
    bound_tenant := NULLIF(current_setting('app.tenant_id', true), '');
    IF bound_tenant IS NOT NULL AND bound_tenant <> NEW."tenantId" THEN
        RAISE EXCEPTION 'AI usage tenant context mismatch'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."deletedAtUtc" IS NOT NULL
       OR NEW."rootReservationId" IS NOT NULL
       OR NEW."ledgerAccountedAtUtc" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- A rolling-deployment legacy binary did not bind app.tenant_id before
    -- inserting AiUsageEvent. Bind only the immutable event tenant for this
    -- transaction so the SECURITY INVOKER trigger can satisfy forced RLS.
    IF bound_tenant IS NULL THEN
        PERFORM set_config('app.tenant_id', NEW."tenantId", true);
    END IF;

    SELECT
        lower(btrim(tenant."subscriptionStatus")),
        tenant."trialStartsAtUtc",
        tenant."trialEndsAtUtc",
        tenant."subscriptionCurrentPeriodStartUtc",
        tenant."subscriptionCurrentPeriodEndUtc"
    INTO
        billing_status,
        trial_start,
        trial_end,
        subscription_period_start,
        subscription_period_end
    FROM public."Tenant" tenant
    WHERE tenant."id" = NEW."tenantId" AND tenant."deletedAtUtc" IS NULL;

    IF billing_status = 'trialing'
       AND trial_start IS NOT NULL
       AND trial_end IS NOT NULL
       AND NEW."createdAt" >= trial_start
       AND NEW."createdAt" < trial_end THEN
        period_start := trial_start;
        period_end := trial_end;
    ELSIF billing_status = 'active'
       AND subscription_period_start IS NOT NULL
       AND subscription_period_end IS NOT NULL
       AND NEW."createdAt" >= subscription_period_start
       AND NEW."createdAt" < subscription_period_end THEN
        period_start := subscription_period_start;
        period_end := subscription_period_end;
    ELSE
        -- Superusers and incomplete rolling-deployment billing snapshots use
        -- the already-backfilled UTC calendar bucket. Paid authorization in
        -- the new binary remains fail-closed until Stripe supplies both bounds.
        period_start := date_trunc('month', NEW."createdAt", 'UTC');
        period_end := period_start + interval '1 month';
    END IF;
    period_id := md5(NEW."tenantId" || ':' || (extract(epoch FROM period_start)::bigint)::text);

    INSERT INTO "AiUsagePeriod" (
        "id", "tenantId", "periodStartUtc", "periodEndUtc",
        "completedCredits", "completedCostMicros", "createdAt", "updatedAt"
    ) VALUES (
        period_id, NEW."tenantId", period_start, period_end,
        NEW."creditsConsumed",
        ROUND(COALESCE(NEW."estimatedCostUsd", 0) * 1000000)::bigint,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId", "periodStartUtc") DO UPDATE SET
        "periodEndUtc" = EXCLUDED."periodEndUtc",
        "completedCredits" = "AiUsagePeriod"."completedCredits" + EXCLUDED."completedCredits",
        "completedCostMicros" = "AiUsagePeriod"."completedCostMicros" + EXCLUDED."completedCostMicros",
        "updatedAt" = CURRENT_TIMESTAMP;

    UPDATE "AiUsageEvent"
    SET "ledgerAccountedAtUtc" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."id" AND "tenantId" = NEW."tenantId";
    RETURN NEW;
END
$$;

CREATE TRIGGER "AiUsageEvent_legacy_ledger_bridge"
AFTER INSERT ON "AiUsageEvent"
FOR EACH ROW
EXECUTE FUNCTION quotefly_bridge_legacy_ai_usage_event();

ALTER TABLE "AiUsagePeriod" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiUsagePeriod" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AiUsageReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiUsageReservation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "AiUsagePeriod_tenant_isolation" ON "AiUsagePeriod"
    FOR ALL
    USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
    WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY "AiUsageReservation_tenant_isolation" ON "AiUsageReservation"
    FOR ALL
    USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
    WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE DELETE, TRUNCATE ON "AiUsagePeriod", "AiUsageReservation" FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE ON "AiUsagePeriod", "AiUsageReservation" TO quotefly_runtime;
