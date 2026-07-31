ALTER TABLE "User"
ADD COLUMN "legalAcceptedAtUtc" TIMESTAMPTZ(3),
ADD COLUMN "termsVersion" TEXT,
ADD COLUMN "privacyPolicyVersion" TEXT;
