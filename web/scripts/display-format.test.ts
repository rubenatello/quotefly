import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBackendLabel,
  formatLocalDateTime,
  formatShortLocalDate,
  isDateResultKey,
  resolveActivityTiming,
  toUtcIsoString,
} from "../src/lib/display-format";

test("backend enum values become customer-friendly labels", () => {
  assert.equal(formatBackendLabel("SENT_QUOTE"), "Sent Quote");
  assert.equal(formatBackendLabel("NEW_CUSTOMER"), "New Customer");
  assert.equal(formatBackendLabel("SENT_TO_CUSTOMER"), "Sent to Customer");
  assert.equal(formatBackendLabel("READY_FOR_REVIEW"), "Ready for Review");
  assert.equal(formatBackendLabel("FIND_CUSTOMER"), "Find Customer");
  assert.equal(formatBackendLabel("HVAC"), "HVAC");
  assert.equal(formatBackendLabel("Michael Scott"), "Michael Scott");
});

test("UTC timestamps render in the configured workspace timezone", () => {
  const utcValue = "2026-08-15T01:45:05.103Z";
  assert.equal(formatShortLocalDate(utcValue, "America/Los_Angeles"), "Aug 14, 2026");
  assert.equal(formatShortLocalDate(utcValue, "Asia/Tokyo"), "Aug 15, 2026");
  assert.match(formatLocalDateTime(utcValue, "America/Los_Angeles") ?? "", /Aug 14, 2026.*6:45 PM.*PDT/);
  assert.equal(toUtcIsoString("2026-08-14T18:45:05.103-07:00"), utcValue);
});

test("date field detection covers Kody and future scheduling fields", () => {
  assert.equal(isDateResultKey("dueSinceUtc"), true);
  assert.equal(isDateResultKey("scheduledAtUtc"), true);
  assert.equal(isDateResultKey("appointmentDate"), true);
  assert.equal(isDateResultKey("quoteStatus"), false);
});

test("Activity timing remains readable during an API-first or web-first rolling deployment", () => {
  assert.deepEqual(resolveActivityTiming({
    createdAt: "2026-08-18T16:30:00.000Z",
    quoteId: "quote-1",
  }), {
    atUtc: "2026-08-18T16:30:00.000Z",
    kind: "UPDATED",
  });
  assert.deepEqual(resolveActivityTiming({
    createdAt: "2026-08-18T16:30:00.000Z",
    activityAtUtc: "2026-08-18T17:45:00.000Z",
    activityKind: "ADDED",
  }), {
    atUtc: "2026-08-18T17:45:00.000Z",
    kind: "ADDED",
  });
});
