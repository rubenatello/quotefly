ALTER TABLE "Quote"
ADD COLUMN "aiGeneratedAtUtc" TIMESTAMPTZ(3);

CREATE INDEX "Quote_tenantId_aiGeneratedAtUtc_idx"
ON "Quote"("tenantId", "aiGeneratedAtUtc");
