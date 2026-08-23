import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  signUpViaApi,
} from "./helpers";

type MockNotification = {
  id: string;
  appointmentId: string;
  kind: "BOOKED" | "RESCHEDULED" | "DISPATCHED" | "ARRIVED" | "COMPLETED" | "CANCELED";
  templateKey: string;
  templateVersion: number;
  sourceVersion: number;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  deliveryStatus: "AVAILABLE" | "DELIVERED";
  deliveredAtUtc: string | null;
  readAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  job: {
    id: string;
    jobNumber: number;
    title: string;
    customer: { id: string; fullName: string };
  };
};

function mockNotification(
  id: string,
  kind: MockNotification["kind"],
  job: "a" | "b" | "c",
  createdAt: string,
  readAtUtc: string | null = null,
): MockNotification {
  const index = job === "a" ? 1 : job === "b" ? 2 : 3;
  return {
    id,
    appointmentId: `appointment-${job}`,
    kind,
    templateKey: `job_appointment_${kind.toLowerCase()}`,
    templateVersion: 1,
    sourceVersion: 2,
    startsAtUtc: `2026-08-${24 + index}T16:00:00.000Z`,
    endsAtUtc: `2026-08-${24 + index}T18:00:00.000Z`,
    timeZone: "America/Los_Angeles",
    deliveryStatus: "AVAILABLE",
    deliveredAtUtc: null,
    readAtUtc,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    job: {
      id: `job-${job}`,
      jobNumber: 4100 + index,
      title: `${job.toUpperCase()} HVAC service`,
      customer: { id: `customer-${job}`, fullName: `Customer ${job.toUpperCase()}` },
    },
  };
}

function mockJob(job: "a" | "b") {
  const index = job === "a" ? 1 : 2;
  const now = `2026-08-2${index}T16:00:00.000Z`;
  return {
    id: `job-${job}`,
    customerId: `customer-${job}`,
    sourceQuoteId: `quote-${job}`,
    assignedTenantUserId: null,
    jobNumber: 4100 + index,
    status: "UNSCHEDULED",
    title: `${job.toUpperCase()} HVAC service`,
    scopeSnapshot: "Inspect and service the equipment.",
    serviceType: "HVAC",
    serviceAddressSnapshot: null,
    accessInstructions: null,
    acceptedAtUtc: now,
    scheduledAtUtc: null,
    dispatchedAtUtc: null,
    startedAtUtc: null,
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    customer: { id: `customer-${job}`, fullName: `Customer ${job.toUpperCase()}` },
    sourceQuote: { id: `quote-${job}`, title: `${job.toUpperCase()} quote`, status: "ACCEPTED", totalAmount: 500 },
    assignedTenantUser: null,
  };
}

async function installNotificationMocks(page: Page, notifications: MockNotification[]) {
  let summaryFails = false;
  let concurrentNotificationCreated = false;
  const requests: Array<{ method: string; pathname: string; search: string; body: string | null }> = [];

  await page.route(`${apiBaseUrl}/v1/notifications**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), pathname: url.pathname, search: url.search, body: request.postData() });
    if (url.pathname === "/v1/notifications/summary") {
      if (summaryFails) {
        summaryFails = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "raw summary failure" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          unreadCount: notifications.filter((item) => item.readAtUtc === null).length,
          totalCount: notifications.length,
          latestCreatedAtUtc: notifications[0]?.createdAt ?? null,
        }),
      });
      return;
    }
    if (url.pathname === "/v1/notifications/read-all") {
      const cutoffAtUtc = "2026-08-23T20:00:00.000Z";
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (!concurrentNotificationCreated) {
        concurrentNotificationCreated = true;
        notifications.push({
          ...mockNotification("notification-concurrent", "ARRIVED", "c", "2026-08-23T20:01:00.000Z"),
          job: {
            id: "job-concurrent",
            jobNumber: 4199,
            title: "Concurrent emergency visit",
            customer: { id: "customer-concurrent", fullName: "Concurrent Customer" },
          },
        });
      }
      let updatedCount = 0;
      for (const notification of notifications) {
        if (notification.readAtUtc === null && notification.createdAt <= cutoffAtUtc) {
          notification.readAtUtc = cutoffAtUtc;
          updatedCount += 1;
        }
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ updatedCount, cutoffAtUtc }) });
      return;
    }
    const markRead = url.pathname.match(/^\/v1\/notifications\/([^/]+)\/read$/);
    if (markRead) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const notification = notifications.find((item) => item.id === decodeURIComponent(markRead[1] ?? ""));
      if (!notification) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "missing" }) });
        return;
      }
      notification.readAtUtc ??= "2026-08-23T19:00:00.000Z";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notification }) });
      return;
    }

    const filter = url.searchParams.get("filter") ?? "all";
    const cursor = url.searchParams.get("cursor");
    const filtered = notifications
      .filter((item) => filter !== "unread" || item.readAtUtc === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const items = cursor === "page-2" ? filtered.slice(2) : filtered.slice(0, 2);
    const hasMore = cursor === null && filtered.length > 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, page: { limit: 25, hasMore, nextCursor: hasMore ? "page-2" : null } }),
    });
  });

  return {
    requests,
    failSummary: () => { summaryFails = true; },
  };
}

test("owner notification center reads, filters, paginates, navigates without stale job data, and preserves count on refresh failure", async ({ context, page, request }) => {
  test.setTimeout(90_000);
  const owner = await signUpViaApi(request, "notifications-owner");
  await addSessionCookie(context, owner);
  const notifications = [
    mockNotification("notification-b", "RESCHEDULED", "b", "2026-08-23T19:00:00.000Z"),
    mockNotification("notification-a", "BOOKED", "a", "2026-08-23T18:00:00.000Z"),
    mockNotification("notification-c", "COMPLETED", "c", "2026-08-23T17:00:00.000Z", "2026-08-23T17:30:00.000Z"),
  ];
  const mock = await installNotificationMocks(page, notifications);

  await page.route(`${apiBaseUrl}/v1/jobs/job-*/appointments**`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], pagination: { total: 0, limit: 25, offset: 0 } }),
  }));
  await page.route(`${apiBaseUrl}/v1/jobs/job-*/notes**`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], pagination: { total: 0, limit: 25, offset: 0 } }),
  }));
  await page.route(`${apiBaseUrl}/v1/jobs/job-a`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job: mockJob("a") }) });
  });
  await page.route(`${apiBaseUrl}/v1/jobs/job-b`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ job: mockJob("b") }),
  }));

  await page.goto("/app");
  const bell = page.getByRole("button", { name: "Notifications, 2 unread" });
  await expect(bell).toBeVisible();
  mock.failSummary();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bell).toHaveAccessibleName("Notifications, 2 unread");

  await bell.click();
  const center = page.getByRole("dialog", { name: "Notifications" });
  await expect(center).toBeVisible();
  await expect(center.getByText("Visit rescheduled")).toBeVisible();
  await expect(center.getByText("Visit booked")).toBeVisible();
  await expect(center.getByText(/Received Aug 23, 2026/i).first()).toBeVisible();
  await center.getByRole("button", { name: "Load more" }).click();
  await expect(center.getByText("Visit completed")).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('[data-testid="notification-center"]').analyze();
  expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(center).toBeHidden();
  await expect(bell).toBeFocused();

  await bell.click();
  const jobACard = center.locator("article", { hasText: "Job #4101" });
  const jobARequest = page.waitForRequest((pending) => pending.url().endsWith("/v1/jobs/job-a"));
  await jobACard.getByRole("button", { name: "Open job" }).click();
  await jobARequest;
  await page.getByRole("button", { name: "Notifications, 2 unread" }).click();
  const jobBCard = center.locator("article", { hasText: "Job #4102" });
  await jobBCard.getByRole("button", { name: "Open job" }).click();
  await expect(page).toHaveURL(/\/app\/jobs\/job-b$/);
  await expect(page.getByText("Customer B", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.getByText("Customer B", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Customer A", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Notifications, 2 unread" }).click();
  await center.locator("article", { hasText: "Job #4102" }).getByRole("button", { name: "Mark Visit rescheduled as read" }).click();
  await center.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(page.locator('button[aria-label="Notifications, 1 unread"]')).toHaveCount(2);
  await expect(center.locator('article[data-notification-status="unread"]')).toHaveCount(1);
  await expect(page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]')).toHaveText("1 unread notification remaining.");
  await center.getByRole("button", { name: "Mark all read" }).click();
  await center.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator('button[aria-label="Notifications, 1 unread"]')).toHaveCount(2);
  await expect(center.locator('article[data-notification-status="unread"]')).toHaveCount(1);
  await expect(center.getByText("Concurrent emergency visit")).toBeVisible();

  for (const requestRecord of mock.requests) {
    const url = new URL(`http://local${requestRecord.pathname}${requestRecord.search}`);
    expect([...url.searchParams.keys()].every((key) => ["filter", "limit", "cursor"].includes(key))).toBe(true);
    expect(requestRecord.search).not.toMatch(/tenant|customer|provider|destination/i);
    if (requestRecord.method === "POST") expect(requestRecord.body).toBeNull();
  }
});

test("member Spanish mobile dark notification center keeps the real assistive count and touch/keyboard access", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const owner = await signUpViaApi(request, "notifications-member-owner");
  const member = await addWorkspaceMemberViaApi(request, owner, "Técnico de Campo");
  await addSessionCookie(context, member);
  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { user: { preferredLocale: string } };
    payload.user.preferredLocale = "es-US";
    await route.fulfill({ response, json: payload });
  });
  const notification = mockNotification("notification-member", "DISPATCHED", "a", "2026-08-23T18:00:00.000Z");
  await installNotificationMocks(page, Array.from({ length: 120 }, (_, index) => ({
    ...notification,
    id: `notification-member-${index}`,
    appointmentId: `appointment-member-${index}`,
    createdAt: `2026-08-23T${String(23 - (index % 20)).padStart(2, "0")}:00:00.000Z`,
  })));
  await page.addInitScript(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");

  const bell = page.getByRole("button", { name: "Notificaciones, 120 sin leer" });
  await expect(bell).toBeVisible();
  await expect(bell.locator('span[aria-hidden="true"]')).toHaveText("99+");
  expect((await bell.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await bell.click();
  const center = page.getByRole("dialog", { name: "Notificaciones" });
  await expect(center.getByText("Visita despachada").first()).toBeVisible();
  await expect(center.getByText(/Recibida el/i).first()).toBeVisible();
  await expect(center).toContainText("Este centro no envía correos electrónicos ni mensajes de texto.");
  await center.getByRole("button", { name: "Sin leer", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(center.getByRole("button", { name: "Sin leer", exact: true })).toHaveAttribute("aria-pressed", "true");
  const axe = await new AxeBuilder({ page }).include('[data-testid="notification-center"]').analyze();
  expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(bell).toBeFocused();
});
