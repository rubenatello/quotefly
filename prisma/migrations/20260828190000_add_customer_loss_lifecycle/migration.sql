CREATE TYPE "CustomerLostReason" AS ENUM (
  'PRICE',
  'NO_RESPONSE',
  'COMPETITOR',
  'TIMING',
  'NOT_A_FIT',
  'CUSTOMER_CANCELED',
  'OTHER'
);

ALTER TABLE "Customer"
  ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lostReason" "CustomerLostReason",
  ADD COLUMN "lostReasonNotes" VARCHAR(1000),
  ADD COLUMN "lostAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "lostByTenantUserId" TEXT,
  ADD COLUMN "reopenedAtUtc" TIMESTAMPTZ(3);

UPDATE "Customer"
SET
  "lostReason" = 'OTHER'::"CustomerLostReason",
  "lostReasonNotes" = 'Legacy lost status; reason was not captured.',
  "lostAtUtc" = COALESCE("followUpUpdatedAtUtc", "updatedAt")
WHERE "followUpStatus" = 'LOST'::"LeadFollowUpStatus";

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_lostByTenantUserId_tenantId_fkey"
  FOREIGN KEY ("lostByTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE,
  ADD CONSTRAINT "Customer_loss_metadata_check"
  CHECK (
    (
      "followUpStatus" = 'LOST'::"LeadFollowUpStatus"
      AND "lostReason" IS NOT NULL
      AND "lostAtUtc" IS NOT NULL
      AND "reopenedAtUtc" IS NULL
    )
    OR
    (
      "followUpStatus" <> 'LOST'::"LeadFollowUpStatus"
      AND "lostReason" IS NULL
      AND "lostReasonNotes" IS NULL
      AND "lostAtUtc" IS NULL
      AND "lostByTenantUserId" IS NULL
    )
  );

CREATE INDEX "Customer_tenantId_status_lostAt_idx"
  ON "Customer"("tenantId", "followUpStatus", "lostAtUtc" DESC);
