ALTER TABLE "WorkPreset"
ADD COLUMN "catalogVersion" INTEGER,
ADD COLUMN "catalogContentHash" VARCHAR(64),
ADD COLUMN "catalogCustomizedAtUtc" TIMESTAMPTZ(3);

-- Existing catalog rows may already contain tenant-authored pricing or scope.
-- Treat them as customized so future catalog releases never overwrite them.
UPDATE "WorkPreset"
SET
  "catalogVersion" = 1,
  "catalogCustomizedAtUtc" = "updatedAt"
WHERE "catalogKey" IS NOT NULL;

CREATE UNIQUE INDEX "WorkPreset_id_tenantId_key"
ON "WorkPreset"("id", "tenantId");

CREATE UNIQUE INDEX "QuickBooksConnection_id_tenantId_key"
ON "QuickBooksConnection"("id", "tenantId");

-- Remove only invalid legacy associations before enforcing tenant-matched
-- QuickBooks item mappings. The mapping row remains available for repair.
UPDATE "QuickBooksItemMap" AS item_map
SET "workPresetId" = NULL
WHERE item_map."workPresetId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "WorkPreset" AS preset
    WHERE preset."id" = item_map."workPresetId"
      AND preset."tenantId" = item_map."tenantId"
  );

ALTER TABLE "QuickBooksItemMap"
DROP CONSTRAINT "QuickBooksItemMap_workPresetId_fkey";

ALTER TABLE "QuickBooksItemMap"
ADD CONSTRAINT "QuickBooksItemMap_workPresetId_tenantId_fkey"
FOREIGN KEY ("workPresetId", "tenantId")
REFERENCES "WorkPreset"("id", "tenantId")
ON DELETE NO ACTION
ON UPDATE CASCADE;

-- A QuickBooks item map is derived integration state and can be rebuilt on the
-- next sync. Remove only legacy cross-tenant connection associations rather
-- than reassigning provider identifiers into a different tenant.
DELETE FROM "QuickBooksItemMap" AS item_map
WHERE NOT EXISTS (
  SELECT 1
  FROM "QuickBooksConnection" AS connection
  WHERE connection."id" = item_map."quickBooksConnectionId"
    AND connection."tenantId" = item_map."tenantId"
);

ALTER TABLE "QuickBooksItemMap"
DROP CONSTRAINT "QuickBooksItemMap_quickBooksConnectionId_fkey";

ALTER TABLE "QuickBooksItemMap"
ADD CONSTRAINT "QuickBooksItemMap_quickBooksConnectionId_tenantId_fkey"
FOREIGN KEY ("quickBooksConnectionId", "tenantId")
REFERENCES "QuickBooksConnection"("id", "tenantId")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "WorkPreset"
ADD CONSTRAINT "WorkPreset_catalogVersion_check"
CHECK ("catalogVersion" IS NULL OR "catalogVersion" > 0);
