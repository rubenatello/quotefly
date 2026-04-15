-- Persist normalized phone digits to support indexed duplicate checks and phone lookup.
ALTER TABLE "Customer" ADD COLUMN "phoneDigits" TEXT;

UPDATE "Customer"
SET "phoneDigits" = NULLIF(
  CASE
    WHEN LENGTH(REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g')) = 11
      AND LEFT(REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g'), 1) = '1'
    THEN RIGHT(REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g'), 10)
    ELSE REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g')
  END,
  ''
);

CREATE INDEX "Customer_tenantId_phoneDigits_idx" ON "Customer"("tenantId", "phoneDigits");
CREATE INDEX "Customer_tenantId_phoneDigits_archivedAtUtc_deletedAtUtc_idx"
  ON "Customer"("tenantId", "phoneDigits", "archivedAtUtc", "deletedAtUtc");
