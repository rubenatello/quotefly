-- Refuse to add global provider identifiers until legacy collisions have been
-- reconciled. Silently choosing a tenant would violate the billing boundary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Tenant"
    WHERE "stripeCustomerId" IS NOT NULL
    GROUP BY "stripeCustomerId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Tenant.stripeCustomerId values must be reconciled before this migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Tenant"
    WHERE "stripeSubscriptionId" IS NOT NULL
    GROUP BY "stripeSubscriptionId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Tenant.stripeSubscriptionId values must be reconciled before this migration';
  END IF;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN "stripeCheckoutSessionId" TEXT,
  ADD COLUMN "stripeCheckoutSessionExpiresAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "stripeCheckoutAttemptId" TEXT,
  ADD COLUMN "stripeCheckoutAttemptExpiresAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "billingStateEventCreatedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "billingStateEventId" TEXT;

CREATE UNIQUE INDEX "Tenant_stripeCustomerId_key"
  ON "Tenant"("stripeCustomerId");
CREATE UNIQUE INDEX "Tenant_stripeSubscriptionId_key"
  ON "Tenant"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Tenant_stripeCheckoutSessionId_key"
  ON "Tenant"("stripeCheckoutSessionId");
CREATE INDEX "Tenant_checkout_attempt_expiry_idx"
  ON "Tenant"("stripeCheckoutAttemptExpiresAtUtc");
CREATE INDEX "Tenant_checkout_session_expiry_idx"
  ON "Tenant"("stripeCheckoutSessionExpiresAtUtc");

ALTER TABLE "BillingWebhookEvent"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "processingLeaseToken" TEXT,
  ADD COLUMN "stripeCreatedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "lastAttemptAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "succeededAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "failedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "lastError" TEXT;

-- Existing rows were inserted only after their reducer completed, so they are
-- historical successes under the previous schema.
UPDATE "BillingWebhookEvent"
SET
  "status" = 'SUCCEEDED',
  "attemptCount" = 1,
  "lastAttemptAtUtc" = "processedAtUtc",
  "succeededAtUtc" = "processedAtUtc";

-- Terminal historical rows do not need an owner token, but every active lease
-- must have one so processing can only finish through an ownership CAS.
ALTER TABLE "BillingWebhookEvent"
  ADD CONSTRAINT "BillingWebhookEvent_processing_lease_token_check"
  CHECK ("status" <> 'PROCESSING' OR "processingLeaseToken" IS NOT NULL);

-- Historical Stripe objects can include billing contact details. Preserve only
-- the provider identifiers required for audit and replay diagnostics.
UPDATE "BillingWebhookEvent"
SET "payload" = jsonb_strip_nulls(jsonb_build_object(
  'version', 1,
  'eventId', "stripeEventId",
  'eventType', "eventType",
  'created', "payload" ->> 'created',
  'objectId', "payload" #>> '{data,object,id}',
  'objectType', "payload" #>> '{data,object,object}',
  'tenantHintId', COALESCE(
    "payload" #>> '{data,object,metadata,tenantId}',
    "payload" #>> '{data,object,client_reference_id}'
  ),
  'customerId', CASE
    WHEN jsonb_typeof("payload" #> '{data,object,customer}') = 'string'
      THEN "payload" #>> '{data,object,customer}'
    WHEN jsonb_typeof("payload" #> '{data,object,customer}') = 'object'
      THEN "payload" #>> '{data,object,customer,id}'
    ELSE NULL
  END,
  'subscriptionId', COALESCE(
    CASE
      WHEN jsonb_typeof("payload" #> '{data,object,subscription}') = 'string'
        THEN "payload" #>> '{data,object,subscription}'
      WHEN jsonb_typeof("payload" #> '{data,object,subscription}') = 'object'
        THEN "payload" #>> '{data,object,subscription,id}'
      ELSE NULL
    END,
    CASE
      WHEN jsonb_typeof("payload" #> '{data,object,parent,subscription_details,subscription}') = 'string'
        THEN "payload" #>> '{data,object,parent,subscription_details,subscription}'
      WHEN jsonb_typeof("payload" #> '{data,object,parent,subscription_details,subscription}') = 'object'
        THEN "payload" #>> '{data,object,parent,subscription_details,subscription,id}'
      ELSE NULL
    END
  )
));

ALTER TABLE "BillingWebhookEvent"
  ALTER COLUMN "processedAtUtc" DROP DEFAULT,
  ALTER COLUMN "processedAtUtc" DROP NOT NULL;

CREATE INDEX "BillingWebhookEvent_status_lastAttemptAtUtc_idx"
  ON "BillingWebhookEvent"("status", "lastAttemptAtUtc");
