-- Store immutable quote-branding binaries once per tenant and content hash.
CREATE TABLE "TenantBrandAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "mimeType" VARCHAR(32) NOT NULL,
    "data" BYTEA NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBrandAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantBrandAsset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "TenantBrandAsset_mime_type_check" CHECK ("mimeType" IN ('image/png', 'image/jpeg')),
    CONSTRAINT "TenantBrandAsset_byte_length_check" CHECK (
        "byteLength" > 0
        AND "byteLength" <= 675000
        AND octet_length("data") = "byteLength"
    )
);

CREATE UNIQUE INDEX "TenantBrandAsset_tenantId_sha256_key"
    ON "TenantBrandAsset"("tenantId", "sha256");

CREATE INDEX "TenantBrandAsset_tenantId_createdAt_idx"
    ON "TenantBrandAsset"("tenantId", "createdAt");

ALTER TABLE "TenantBrandAsset"
    ADD CONSTRAINT "TenantBrandAsset_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
