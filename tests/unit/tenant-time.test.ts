import assert from "node:assert/strict";
import test from "node:test";
import { isValidIanaTimeZone, tenantActivityWindows } from "../../src/lib/tenant-time";
import { resolveTenantWallTime, tenantWallTimeToIso, toTenantDateTimeInput } from "../../web/src/lib/tenant-time";

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
  assert.deepEqual(resolveTenantWallTime("2026-03-08T02:30", "America/Los_Angeles"), {
    kind: "nonexistent",
    choices: [],
  });
});

test("ambiguous DST wall times expose both concrete UTC choices", () => {
  const resolution = resolveTenantWallTime("2026-11-01T01:30", "America/Los_Angeles");
  assert.equal(resolution.kind, "ambiguous");
  assert.deepEqual(resolution.choices.map((choice) => choice.iso), [
    "2026-11-01T08:30:00.000Z",
    "2026-11-01T09:30:00.000Z",
  ]);
  assert.deepEqual(resolution.choices.map((choice) => choice.offsetLabel), ["UTC-07:00", "UTC-08:00"]);
  assert.equal(tenantWallTimeToIso("2026-11-01T01:30", "America/Los_Angeles"), resolution.choices[0].iso);
});

test("wall-time analysis handles non-DST zones and malformed calendar values", () => {
  assert.deepEqual(resolveTenantWallTime("2026-08-20T09:30", "UTC"), {
    kind: "valid",
    choices: [{
      iso: "2026-08-20T09:30:00.000Z",
      offsetMinutes: 0,
      offsetLabel: "UTC+00:00",
      zoneName: "UTC",
    }],
  });
  assert.deepEqual(resolveTenantWallTime("2026-02-31T09:30", "UTC"), { kind: "invalid", choices: [] });
});
