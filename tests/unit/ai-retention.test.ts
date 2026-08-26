import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_RETENTION_APPLY_CONFIRMATION,
  AI_RETENTION_MAX_ROWS_PER_TENANT,
  DEFAULT_AI_FEEDBACK_RETENTION_DAYS,
  validateAiRetentionApplyAuthorization,
  validateAiRetentionPolicy,
} from "../../src/services/ai-retention";

test("AI retention uses the reviewed feedback window and bounded tenant work", () => {
  assert.equal(DEFAULT_AI_FEEDBACK_RETENTION_DAYS, 180);
  assert.equal(AI_RETENTION_MAX_ROWS_PER_TENANT, 5_000);
  assert.deepEqual(validateAiRetentionPolicy({
    feedbackDays: DEFAULT_AI_FEEDBACK_RETENTION_DAYS,
  }), { feedbackDays: 180 });
  assert.throws(
    () => validateAiRetentionPolicy({ feedbackDays: 89 }),
    /at least 90 days/,
  );
  assert.throws(
    () => validateAiRetentionPolicy({ feedbackDays: 180.5 }),
    /at least 90 days/,
  );
});

test("AI retention is dry-run compatible and rejects unconfirmed apply mode", () => {
  assert.doesNotThrow(() => validateAiRetentionApplyAuthorization(false, undefined));
  assert.throws(
    () => validateAiRetentionApplyAuthorization(true, undefined),
    /Apply requires --confirm=/,
  );
  assert.throws(
    () => validateAiRetentionApplyAuthorization(true, "wrong-confirmation"),
    /Apply requires --confirm=/,
  );
  assert.doesNotThrow(() => validateAiRetentionApplyAuthorization(
    true,
    AI_RETENTION_APPLY_CONFIRMATION,
  ));
});
