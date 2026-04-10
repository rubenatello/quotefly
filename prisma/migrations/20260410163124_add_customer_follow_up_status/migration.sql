-- CreateEnum
CREATE TYPE "LeadFollowUpStatus" AS ENUM ('NEEDS_FOLLOW_UP', 'FOLLOWED_UP', 'WON', 'LOST');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "followUpStatus" "LeadFollowUpStatus" NOT NULL DEFAULT 'NEEDS_FOLLOW_UP',
ADD COLUMN     "followUpUpdatedAtUtc" TIMESTAMPTZ(3);
