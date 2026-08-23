-- Repair accepted quotes whose authoritative Job already completed before the
-- Job-to-after-sale handoff was centralized. The NOT_READY predicate makes
-- this safe to rerun and preserves manual DUE or COMPLETED follow-up state.
UPDATE "Quote" AS quote
SET
    "afterSaleFollowUpStatus" = 'DUE',
    "afterSaleFollowUpDueAtUtc" = COALESCE(job."completedAtUtc", job."updatedAt") + INTERVAL '7 days',
    "afterSaleFollowUpCompletedAtUtc" = NULL
FROM "Job" AS job
WHERE job."tenantId" = quote."tenantId"
  AND job."sourceQuoteId" = quote."id"
  AND job."status" = 'COMPLETED'
  AND job."archivedAtUtc" IS NULL
  AND job."deletedAtUtc" IS NULL
  AND quote."status" = 'ACCEPTED'
  AND quote."afterSaleFollowUpStatus" = 'NOT_READY'
  AND quote."archivedAtUtc" IS NULL
  AND quote."deletedAtUtc" IS NULL;
