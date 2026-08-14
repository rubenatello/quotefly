-- Assignment IDs reference tenant memberships, not global users. The composite
-- foreign keys make cross-tenant assignment impossible at the database layer.
CREATE UNIQUE INDEX "TenantUser_id_tenantId_key" ON "TenantUser"("id", "tenantId");

ALTER TABLE "Customer"
  ADD COLUMN "assignedTenantUserId" TEXT;

ALTER TABLE "Quote"
  ADD COLUMN "assignedTenantUserId" TEXT;

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_assignedTenantUserId_tenantId_fkey"
  FOREIGN KEY ("assignedTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_assignedTenantUserId_tenantId_fkey"
  FOREIGN KEY ("assignedTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Customer_tenantId_assignee_lifecycle_idx"
  ON "Customer"("tenantId", "assignedTenantUserId", "archivedAtUtc", "deletedAtUtc");

CREATE INDEX "Quote_tenantId_assignee_lifecycle_idx"
  ON "Quote"("tenantId", "assignedTenantUserId", "archivedAtUtc", "deletedAtUtc");
