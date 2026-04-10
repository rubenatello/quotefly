DO $$
BEGIN
  ALTER TYPE "ServiceCategory" ADD VALUE IF NOT EXISTS 'CONSTRUCTION';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TYPE "PresetCategory" AS ENUM ('LABOR', 'MATERIAL', 'FEE', 'SERVICE');
CREATE TYPE "PresetUnitType" AS ENUM ('FLAT', 'SQ_FT', 'HOUR', 'EACH');

ALTER TABLE "Tenant"
ADD COLUMN "primaryTrade" "ServiceCategory",
ADD COLUMN "onboardingCompletedAtUtc" TIMESTAMPTZ(3);

CREATE INDEX "Tenant_primaryTrade_idx" ON "Tenant"("primaryTrade");

CREATE TABLE "WorkPreset" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "serviceType" "ServiceCategory" NOT NULL,
  "category" "PresetCategory" NOT NULL,
  "unitType" "PresetUnitType" NOT NULL DEFAULT 'FLAT',
  "name" TEXT NOT NULL,
  "description" TEXT,
  "defaultQuantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
  "unitCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "unitPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "isDefault" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAtUtc" TIMESTAMPTZ(3),
  CONSTRAINT "WorkPreset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkPreset_tenantId_serviceType_name_key"
ON "WorkPreset"("tenantId", "serviceType", "name");

CREATE INDEX "WorkPreset_tenantId_serviceType_deletedAtUtc_idx"
ON "WorkPreset"("tenantId", "serviceType", "deletedAtUtc");

ALTER TABLE "WorkPreset"
ADD CONSTRAINT "WorkPreset_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
