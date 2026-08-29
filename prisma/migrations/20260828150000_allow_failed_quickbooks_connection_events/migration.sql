-- Connection revocation can exhaust its bounded retry budget. Preserve an
-- immutable, content-free failure outcome for operator escalation without
-- adding provider identifiers or credential material to the event stream.

ALTER TABLE "QuickBooksConnectionEvent"
  DROP CONSTRAINT "QuickBooksConnectionEvent_outcome_check";

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_outcome_check"
  CHECK ("outcome" IN ('PENDING', 'SUCCEEDED', 'FAILED'));
