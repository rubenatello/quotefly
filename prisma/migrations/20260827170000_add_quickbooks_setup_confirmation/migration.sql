-- Persist an explicit, tenant-scoped QuickBooks setup confirmation. Existing
-- connections remain unconfirmed until an owner or admin reviews the current
-- checklist. Provider credentials and provider calls are not involved.

ALTER TABLE "QuickBooksConnection"
  ADD COLUMN "setupConfirmedAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "setupConfirmedByTenantUserId" TEXT,
  ADD COLUMN "setupChecklistVersion" VARCHAR(32),
  ADD CONSTRAINT "QuickBooksConnection_setup_confirmation_pair_check" CHECK (
    ("setupConfirmedAtUtc" IS NULL
      AND "setupConfirmedByTenantUserId" IS NULL
      AND "setupChecklistVersion" IS NULL)
    OR
    ("setupConfirmedAtUtc" IS NOT NULL
      AND "setupConfirmedByTenantUserId" IS NOT NULL
      AND "setupChecklistVersion" IS NOT NULL
      AND char_length(btrim("setupChecklistVersion")) > 0)
  );

ALTER TABLE "QuickBooksConnection"
  ADD CONSTRAINT "QuickBooksConnection_setup_confirmer_tenant_fkey"
  FOREIGN KEY ("setupConfirmedByTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "QuickBooksConnection_tenant_setup_confirmed_idx"
  ON "QuickBooksConnection"("tenantId", "setupConfirmedAtUtc");
