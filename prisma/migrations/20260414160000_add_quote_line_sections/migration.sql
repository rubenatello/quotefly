-- CreateEnum
CREATE TYPE "QuoteLineSectionType" AS ENUM ('INCLUDED', 'ALTERNATE');

-- AlterTable
ALTER TABLE "QuoteLineItem"
ADD COLUMN     "sectionType" "QuoteLineSectionType" NOT NULL DEFAULT 'INCLUDED',
ADD COLUMN     "sectionLabel" TEXT;
