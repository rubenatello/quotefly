-- Additive and backward-compatible: existing users retain the English UI until
-- they explicitly choose Spanish. The database constraint mirrors API validation
-- so imports and maintenance scripts cannot persist an unsupported locale.
ALTER TABLE "User"
ADD COLUMN "preferredLocale" VARCHAR(5) NOT NULL DEFAULT 'en-US';

ALTER TABLE "User"
ADD CONSTRAINT "User_preferredLocale_supported_check"
CHECK ("preferredLocale" IN ('en-US', 'es-US')) NOT VALID;

ALTER TABLE "User"
VALIDATE CONSTRAINT "User_preferredLocale_supported_check";
