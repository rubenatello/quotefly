ALTER TABLE "QuoteLineItem"
ADD COLUMN "position" INTEGER;

WITH ranked_lines AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "quoteId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) - 1 AS "position"
  FROM "QuoteLineItem"
)
UPDATE "QuoteLineItem" AS line_item
SET "position" = ranked_lines."position"
FROM ranked_lines
WHERE line_item."id" = ranked_lines."id";

ALTER TABLE "QuoteLineItem"
ALTER COLUMN "position" SET NOT NULL,
ALTER COLUMN "position" SET DEFAULT 0;

CREATE INDEX "QuoteLineItem_quoteId_tenantId_position_idx"
ON "QuoteLineItem"("quoteId", "tenantId", "position");
