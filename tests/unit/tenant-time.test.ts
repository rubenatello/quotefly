import assert from "node:assert/strict";
import test from "node:test";
import { isValidIanaTimeZone, tenantActivityWindows } from "../../src/lib/tenant-time";
import { tenantWallTimeToIso, toTenantDateTimeInput } from "../../web/src/lib/tenant-time";

test("tenant activity windows preserve spring-forward and fall-back local calendar days", () => {
  const spring = tenantActivityWindows(new Date("2026-03-08T18:00:00.000Z"), "America/Los_Angeles");
  const fall = tenantActivityWindows(new Date("2026-11-01T18:00:00.000Z"), "America/Los_Angeles");
  assert.equal(spring.tomorrowStartUtc.getTime() - spring.todayStartUtc.getTime(), 23 * 60 * 60 * 1000);
  assert.equal(fall.tomorrowStartUtc.getTime() - fall.todayStartUtc.getTime(), 25 * 60 * 60 * 1000);
});

test("invalid tenant timezones fall back safely while branding validation can reject them", () => {
  assert.equal(isValidIanaTimeZone("America/Los_Angeles"), true);
  assert.equal(isValidIanaTimeZone("Definitely/Not_A_Zone"), false);
  assert.equal(tenantActivityWindows(new Date("2026-08-20T12:00:00.000Z"), "bad-zone").timeZone, "UTC");
});

test("browser tenant wall-time conversion round trips through the configured timezone", () => {
  const iso = tenantWallTimeToIso("2026-08-20T09:30", "America/Los_Angeles");
  assert.equal(iso, "2026-08-20T16:30:00.000Z");
  assert.equal(toTenantDateTimeInput(iso!, "America/Los_Angeles"), "2026-08-20T09:30");
});

test("nonexistent DST wall times fail closed", () => {
  assert.equal(tenantWallTimeToIso("2026-03-08T02:30", "America/Los_Angeles"), null);
});
