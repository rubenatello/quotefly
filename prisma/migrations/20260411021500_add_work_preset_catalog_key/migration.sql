ALTER TABLE "WorkPreset"
ADD COLUMN "catalogKey" TEXT;

DROP INDEX IF EXISTS "WorkPreset_tenantId_serviceType_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "WorkPreset_tenantId_serviceType_catalogKey_key"
ON "WorkPreset"("tenantId", "serviceType", "catalogKey");
