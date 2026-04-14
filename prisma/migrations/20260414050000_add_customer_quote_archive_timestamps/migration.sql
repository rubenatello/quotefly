ALTER TABLE "Customer" ADD COLUMN "archivedAtUtc" TIMESTAMPTZ(3);
ALTER TABLE "Quote" ADD COLUMN "archivedAtUtc" TIMESTAMPTZ(3);

CREATE INDEX "Customer_tenantId_archivedAtUtc_deletedAtUtc_idx"
  ON "Customer"("tenantId", "archivedAtUtc", "deletedAtUtc");

CREATE INDEX "Quote_tenantId_archivedAtUtc_deletedAtUtc_idx"
  ON "Quote"("tenantId", "archivedAtUtc", "deletedAtUtc");
