-- Expand-only migration: old application versions can continue writing ratings
-- because the optional note column is nullable.
ALTER TABLE "AiAssistantFeedback"
    ADD COLUMN "note" VARCHAR(500);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AiAssistantFeedback" TO quotefly_runtime;
