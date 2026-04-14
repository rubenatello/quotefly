-- Speed up duplicate-customer checks and email search scoped by tenant.
CREATE INDEX "Customer_tenantId_email_idx" ON "Customer"("tenantId", "email");
