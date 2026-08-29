-- Stop persistent CDC failures after a bounded retry budget so operators can
-- distinguish an outage from an endlessly cycling recovery cursor.

ALTER TABLE "QuickBooksCdcCursor"
  ADD COLUMN "terminalAtUtc" TIMESTAMPTZ(3);

ALTER TABLE "QuickBooksCdcCursor"
  ADD CONSTRAINT "QuickBooksCdcCursor_terminal_state_check"
  CHECK ("terminalAtUtc" IS NULL OR "nextAttemptAtUtc" IS NULL);

DROP INDEX "QuickBooksCdcCursor_tenant_next_updated_idx";

CREATE INDEX "QuickBooksCdcCursor_tenant_terminal_due_idx"
  ON "QuickBooksCdcCursor"("tenantId", "terminalAtUtc", "nextAttemptAtUtc", "updatedAt");
