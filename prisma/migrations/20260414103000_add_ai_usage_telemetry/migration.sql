ALTER TABLE "AiUsageEvent"
ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "promptTokens" INTEGER,
ADD COLUMN "completionTokens" INTEGER,
ADD COLUMN "totalTokens" INTEGER,
ADD COLUMN "estimatedCostUsd" DECIMAL(10, 6);
