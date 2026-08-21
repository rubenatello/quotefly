-- Customer-facing document language is intentionally separate from the signed-in
-- user's interface language. Existing tenants and quotes remain English.
ALTER TABLE "Tenant"
ADD COLUMN "defaultCustomerLocale" VARCHAR(5) NOT NULL DEFAULT 'en-US';

ALTER TABLE "Customer"
ADD COLUMN "preferredLocale" VARCHAR(5);

ALTER TABLE "Quote"
ADD COLUMN "documentLocale" VARCHAR(5) NOT NULL DEFAULT 'en-US';

ALTER TABLE "Tenant"
ADD CONSTRAINT "Tenant_defaultCustomerLocale_supported"
CHECK ("defaultCustomerLocale" IN ('en-US', 'es-US')) NOT VALID;

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_preferredLocale_supported"
CHECK ("preferredLocale" IS NULL OR "preferredLocale" IN ('en-US', 'es-US')) NOT VALID;

ALTER TABLE "Quote"
ADD CONSTRAINT "Quote_documentLocale_supported"
CHECK ("documentLocale" IN ('en-US', 'es-US')) NOT VALID;

ALTER TABLE "Tenant"
VALIDATE CONSTRAINT "Tenant_defaultCustomerLocale_supported";

ALTER TABLE "Customer"
VALIDATE CONSTRAINT "Customer_preferredLocale_supported";

ALTER TABLE "Quote"
VALIDATE CONSTRAINT "Quote_documentLocale_supported";
