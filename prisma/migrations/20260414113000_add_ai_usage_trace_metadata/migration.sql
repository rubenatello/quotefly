ALTER TABLE "AiUsageEvent"
ADD COLUMN "insightSummary" TEXT,
ADD COLUMN "insightReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "insightSourceLabels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "confidenceLevel" TEXT,
ADD COLUMN "confidenceLabel" TEXT,
ADD COLUMN "riskNote" TEXT,
ADD COLUMN "patchAdded" INTEGER,
ADD COLUMN "patchUpdated" INTEGER,
ADD COLUMN "patchRemoved" INTEGER;
