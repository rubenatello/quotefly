-- Quote creation is retried by mobile/browser clients after ambiguous network
-- failures. Persist only tenant-scoped hashes so the request can be replayed
-- without retaining the raw idempotency key or a duplicate request body.
ALTER TABLE "Quote"
  ADD COLUMN "createIdempotencyKeyHash" VARCHAR(64),
  ADD COLUMN "createRequestHash" VARCHAR(64);

CREATE UNIQUE INDEX "Quote_tenantId_createIdempotencyKeyHash_key"
  ON "Quote"("tenantId", "createIdempotencyKeyHash");

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_create_hashes_pair_check"
  CHECK (
    ("createIdempotencyKeyHash" IS NULL AND "createRequestHash" IS NULL)
    OR
    (
      "createIdempotencyKeyHash" IS NOT NULL
      AND "createRequestHash" IS NOT NULL
      AND
      "createIdempotencyKeyHash" ~ '^[0-9a-f]{64}$'
      AND "createRequestHash" ~ '^[0-9a-f]{64}$'
    )
  );
