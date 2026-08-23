import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WorkspaceNotification } from "../src/lib/api";
import {
  formatNotificationReceivedAt,
  formatNotificationWindow,
  mergeNotificationPages,
  notificationJobPath,
  notificationTitleKey,
} from "../src/lib/notification-display";

function notification(id: string, createdAt: string, readAtUtc: string | null = null): WorkspaceNotification {
  return {
    id,
    appointmentId: `appointment-${id}`,
    kind: "BOOKED",
    templateKey: "job_appointment_booked",
    templateVersion: 1,
    sourceVersion: 1,
    startsAtUtc: "2026-08-25T16:00:00.000Z",
    endsAtUtc: "2026-08-25T18:00:00.000Z",
    timeZone: "America/Los_Angeles",
    deliveryStatus: "DELIVERED",
    deliveredAtUtc: createdAt,
    readAtUtc,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    job: {
      id: `job-${id}`,
      jobNumber: 4100,
      title: "HVAC tune-up",
      customer: { id: `customer-${id}`, fullName: "Schedule Customer" },
    },
  };
}

test("notification pages de-duplicate and remain newest-first", () => {
  const older = notification("older", "2026-08-23T17:00:00.000Z");
  const newer = notification("newer", "2026-08-23T18:00:00.000Z");
  const updatedOlder = { ...older, readAtUtc: "2026-08-23T19:00:00.000Z" };
  const merged = mergeNotificationPages([older, newer], [updatedOlder]);
  assert.deepEqual(merged.map((item) => item.id), ["newer", "older"]);
  assert.equal(merged[1]?.readAtUtc, "2026-08-23T19:00:00.000Z");
});

test("notification copy mappings and typed job paths are bounded", () => {
  for (const kind of ["BOOKED", "RESCHEDULED", "DISPATCHED", "ARRIVED", "COMPLETED", "CANCELED"] as const) {
    assert.match(notificationTitleKey(kind), /^notificationsCenter\.kind\./);
  }
  assert.equal(notificationJobPath("job/with unsafe segment"), "/app/jobs/job%2Fwith%20unsafe%20segment");
});

test("notification windows render same-day and cross-day ranges in tenant time", () => {
  const sameDay = notification("same-day", "2026-08-23T18:00:00.000Z");
  const sameDayValue = formatNotificationWindow(sameDay, "en-US", "America/Los_Angeles");
  assert.equal((sameDayValue.match(/Tue, Aug 25/g) ?? []).length, 1);
  assert.match(sameDayValue, /9:00\s*AM/);
  assert.match(sameDayValue, /11:00\s*AM/);

  const overnight = {
    ...sameDay,
    startsAtUtc: "2026-08-26T06:00:00.000Z",
    endsAtUtc: "2026-08-26T10:00:00.000Z",
  };
  const overnightValue = formatNotificationWindow(overnight, "en-US", "America/Los_Angeles");
  assert.match(overnightValue, /Tue, Aug 25/);
  assert.match(overnightValue, /Wed, Aug 26/);

  const multiDay = {
    ...sameDay,
    startsAtUtc: "2026-08-25T16:00:00.000Z",
    endsAtUtc: "2026-08-28T18:00:00.000Z",
  };
  const spanishValue = formatNotificationWindow(multiDay, "es-US", "America/Los_Angeles");
  assert.match(spanishValue, /mar.*25.*ago/i);
  assert.match(spanishValue, /vie.*28.*ago/i);
});

test("notification received time always includes a localized tenant date and time", () => {
  const item = notification("received", "2026-08-23T18:00:00.000Z");
  const en = formatNotificationReceivedAt(item, "en-US", "America/Los_Angeles");
  const es = formatNotificationReceivedAt(item, "es-US", "America/Los_Angeles");
  assert.match(en, /Aug 23, 2026/);
  assert.match(en, /11:00\s*AM/);
  assert.match(es, /23.*ago.*2026/i);
  assert.match(es, /11:00/);
});

test("notification center uses one Radix dialog, 44px triggers, safe endpoints, and a narrow live region", () => {
  const component = readFileSync(new URL("../src/components/notifications/NotificationCenter.tsx", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const jobsPage = readFileSync(new URL("../src/pages/JobsPage.tsx", import.meta.url), "utf8");
  const schedule = readFileSync(new URL("../src/components/jobs/JobScheduleWorkspace.tsx", import.meta.url), "utf8");

  assert.equal((component.match(/<DialogPrimitive\.Root/g) ?? []).length, 1);
  assert.match(component, /h-11 w-11/);
  assert.match(component, /safeCount > 99 \? "99\+" : safeCount/);
  assert.match(component, /window\.addEventListener\("focus", refreshOnFocus\)/);
  assert.match(component, /document\.visibilityState === "visible"/);
  assert.match(component, /returnFocusRef\.current\?\.focus\(\)/);
  assert.match(component, /summaryGenerationRef\.current/);
  assert.match(component, /requestGenerationRef\.current/);
  assert.match(component, /lastSummaryCountRef\.current !== nextCount/);
  assert.match(component, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(component, /formatNotificationReceivedAt\(notification/);
  assert.match(component, /notificationsCenter\.receivedAt/);
  assert.match(component, /notification\.createdAt <= response\.cutoffAtUtc/);
  assert.match(component, /filterRef\.current/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|deleteNotification|provider/i);

  const notificationApi = apiSource.slice(apiSource.indexOf("  notifications: {"), apiSource.indexOf("  invoices: {"));
  assert.match(notificationApi, /\/v1\/notifications\/summary/);
  assert.match(notificationApi, /encodeURIComponent\(notificationId\)/);
  assert.doesNotMatch(notificationApi, /tenantId|provider|destination|body:\s*JSON\.stringify/i);
  assert.match(apiSource, /notificationReceipt\?: AppointmentNotificationReceipt/);
  assert.match(jobsPage, /response\.notificationReceipt \?\? null/);
  assert.match(jobsPage, /response\?\.notificationReceipt \?\? null/);
  assert.doesNotMatch(schedule, /className="space-y-3 xl:hidden" aria-live/);
  assert.match(schedule, /aria-live="polite"[^>]*>\{t\("jobs\.bookingCount"/);
  const kody = readFileSync(new URL("../src/components/ai/KodyAssistant.tsx", import.meta.url), "utf8");
  assert.match(kody, /kodyFocusReturnId: "kody-launcher"/);
  assert.match(kody, /id="kody-launcher"/);
  assert.match(jobsPage, /value\.kodyFocusReturnId === "kody-launcher"/);
  assert.match(jobsPage, /document\.getElementById\(kodyFocusReturnId\)/);
});
