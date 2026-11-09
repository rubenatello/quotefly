-- Preserve existing migration checksums. An operation has either never been
-- dispatched or exactly one durable original attempt. Provider identity is
-- evidence of that attempt, never independent of it (including after supersession).
ALTER TABLE "QuickBooksTaxEstimateOperation"
  ADD CONSTRAINT "QbTaxEstimate_attempt_evidence_check" CHECK (
    (
      "attemptCount" = 0
      AND "attemptTokenHash" IS NULL
      AND "lastAttemptAtUtc" IS NULL
    )
    OR (
      "attemptCount" = 1
      AND "attemptTokenHash" IS NOT NULL
      AND "lastAttemptAtUtc" IS NOT NULL
    )
  );

ALTER TABLE "QuickBooksTaxEstimateOperation"
  ADD CONSTRAINT "QbTaxEstimate_provider_attempt_check" CHECK (
    "providerEstimateId" IS NULL
    OR (
      "attemptCount" = 1
      AND "attemptTokenHash" IS NOT NULL
      AND "lastAttemptAtUtc" IS NOT NULL
    )
  );
