import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NOTIFICATION_READ_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_UNREAD_RETENTION_DAYS,
  validateNotificationRetentionPolicy,
} from "../../src/services/notification-retention";

test("notification retention uses the reviewed read and unread windows", () => {
  assert.deepEqual(validateNotificationRetentionPolicy({
    readDays: DEFAULT_NOTIFICATION_READ_RETENTION_DAYS,
    unreadDays: DEFAULT_NOTIFICATION_UNREAD_RETENTION_DAYS,
  }), { readDays: 90, unreadDays: 365 });
  assert.throws(
    () => validateNotificationRetentionPolicy({ readDays: 29, unreadDays: 365 }),
    /at least 30 days/,
  );
  assert.throws(
    () => validateNotificationRetentionPolicy({ readDays: 90, unreadDays: 179 }),
    /at least 180 days/,
  );
  assert.throws(
    () => validateNotificationRetentionPolicy({ readDays: 365, unreadDays: 365 }),
    /longer than read notification retention/,
  );
});
