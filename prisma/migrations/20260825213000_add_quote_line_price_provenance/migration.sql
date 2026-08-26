CREATE TYPE "QuoteLinePriceProvenance" AS ENUM (
  'MANUAL',
  'TENANT_PRESET',
  'AI_REVIEWED',
  'REVISION_RESTORE'
);

ALTER TABLE "QuoteLineItem"
  ADD COLUMN "priceProvenance" "QuoteLinePriceProvenance" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sourcePresetIdSnapshot" VARCHAR(191),
  ADD COLUMN "sourcePresetNameSnapshot" VARCHAR(191),
  ADD COLUMN "sourcePresetCatalogKeySnapshot" VARCHAR(191),
  ADD COLUMN "sourcePresetCatalogVersionSnapshot" INTEGER,
  ADD COLUMN "sourcePresetUpdatedAtUtcSnapshot" TIMESTAMPTZ(3);

CREATE INDEX "QuoteLineItem_tenantId_sourcePresetIdSnapshot_idx"
  ON "QuoteLineItem"("tenantId", "sourcePresetIdSnapshot");
