-- CreateEnum
CREATE TYPE "QuoteJobStatus" AS ENUM ('NOT_STARTED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AfterSaleFollowUpStatus" AS ENUM ('NOT_READY', 'DUE', 'COMPLETED');

-- AlterTable
ALTER TABLE "Quote"
ADD COLUMN "jobStatus" "QuoteJobStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN "afterSaleFollowUpStatus" "AfterSaleFollowUpStatus" NOT NULL DEFAULT 'NOT_READY',
ADD COLUMN "closedAtUtc" TIMESTAMPTZ(3),
ADD COLUMN "jobCompletedAtUtc" TIMESTAMPTZ(3),
ADD COLUMN "afterSaleFollowUpDueAtUtc" TIMESTAMPTZ(3),
ADD COLUMN "afterSaleFollowUpCompletedAtUtc" TIMESTAMPTZ(3);

-- Backfill accepted quotes into the closed stage.
UPDATE "Quote"
SET "closedAtUtc" = COALESCE("sentAt", "updatedAt", "createdAt")
WHERE "status" = 'ACCEPTED'
  AND "closedAtUtc" IS NULL;

-- CreateIndex
CREATE INDEX "Quote_tenantId_jobStatus_idx" ON "Quote"("tenantId", "jobStatus");

-- CreateIndex
CREATE INDEX "Quote_tenantId_afterSaleFollowUpStatus_idx" ON "Quote"("tenantId", "afterSaleFollowUpStatus");
