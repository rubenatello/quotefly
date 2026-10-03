import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const recoveryPath = "/v1/integrations/quickbooks/recovery/events";
const reasonValues = ["PROVIDER_RECOVERED", "CONNECTION_REAUTHORIZED", "MAPPING_CORRECTED"];
function status(oauthOnlyMode = false) {
  return {
    enabled: true, configured: true, providerWorkflowsEnabled: true, oauthOnlyMode,
    webhookConfigured: true, canManage: true, environment: "sandbox", reconciliationWorker: null,
    setup: { phase: "CONFIRMED", ready: true, confirmed: true, checklistVersion: "2026-08-28.v2", checks: [],
      capabilities: { canConnect: false, canReconnect: false, canConfirm: false, canDisconnect: true },
      operations: { coreConnectionReady: true, hostedPaymentsReady: true, reconciliationReady: true, cdcRecoveryReady: true, allAccountingWorkflowsReady: true } },
    connection: { environment: "sandbox", companyName: "Recovery Test Company", status: "CONNECTED",
      connectedAtUtc: "2026-09-01T12:00:00Z", counts: { customerMaps: 1, itemMaps: 1, invoiceSyncs: 1 } },
  };
}
function event(id = "private-event-123456789", replaySupported = true) {
  return { id, type: "Invoice", state: "DEAD", reason: "SECRET_PROVIDER_DIAGNOSTIC", attempts: 8,
    receivedAtUtc: "2026-09-01T12:00:00Z", deadAtUtc: "2026-09-02T12:00:00Z", replaySupported };
}
async function mockWorkspace(page: Page, options: { member?: boolean; oauthOnly?: boolean } = {}) {
  await page.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], users: [], notifications: [], unreadCount: 0, total: 0 };
    if (path === "/v1/auth/me") body = {
      user: { id: "user-test", email: "owner@example.com", fullName: "Recovery Owner", preferredLocale: "en-US" },
      role: options.member ? "member" : "owner", tenant: { id: "tenant-recovery", name: "Recovery Test", timezone: "America/Los_Angeles",
        onboardingCompletedAtUtc: "2026-09-01T00:00:00Z", subscriptionStatus: "active", subscriptionPlanCode: "starter", effectivePlanCode: "starter" },
    };
    if (path === "/v1/integrations/quickbooks/status") body = status(options.oauthOnly);
    if (path === recoveryPath) body = { replayEnabled: true, reasons: reasonValues, events: [event(), event("private-manual-123456789", false)] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("members never request manager recovery data", async ({ page }) => {
  await mockWorkspace(page, { member: true });
  let requests = 0;
  page.on("request", (request) => { if (request.url().includes(recoveryPath)) requests += 1; });
  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("heading", { name: "QuickBooks setup is manager-only" })).toBeVisible();
  expect(requests).toBe(0);
});

test("OAuth-only settings explain recovery restrictions without requesting events", async ({ page }) => {
  await mockWorkspace(page, { oauthOnly: true });
  let requests = 0;
  page.on("request", (request) => { if (request.url().includes(recoveryPath)) requests += 1; });
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByText("This staging site checks connections only.", { exact: false })).toBeVisible();
  expect(requests).toBe(0);
});

for (const width of [390, 1280]) {
  test(`recovery confirmation is accessible and reuses an uncertain command at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockWorkspace(page);
    let posts = 0;
    let queued = false;
    const keys: string[] = [];
    await page.route(`**${recoveryPath}?*`, async (route) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ replayEnabled: true, reasons: reasonValues, events: queued ? [] : [event(), event("private-manual-123456789", false)] }) }));
    await page.route(`**${recoveryPath}/*/replay`, async (route) => {
      posts += 1;
      keys.push(route.request().headers()["idempotency-key"]!);
      expect(route.request().postDataJSON()).toEqual({ reason: "MAPPING_CORRECTED" });
      if (posts === 1) return route.abort("connectionreset");
      queued = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "QUEUED" }) });
    });
    await page.goto("/app/settings#admin-quickbooks");
    const open = page.getByRole("button", { name: "Review recovery events", exact: true });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.locator("#quickbooks-recovery")).toBeFocused();
    const review = page.getByRole("button", { name: "Review retry", exact: true });
    await expect(review).toHaveCount(1);
    expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("body")).not.toContainText("SECRET_PROVIDER_DIAGNOSTIC");
    await expect(page.locator("body")).not.toContainText("private-event-123456789");
    await page.screenshot({ path: testInfo.outputPath(`recovery-${width}.png`), fullPage: true });
    await review.click();
    const dialog = page.getByRole("dialog", { name: "Retry this accounting update?" });
    const submit = dialog.getByRole("button", { name: "Confirm and queue retry" });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("What was corrected?").selectOption("MAPPING_CORRECTED");
    await page.screenshot({ path: testInfo.outputPath(`recovery-confirm-${width}.png`) });
    const a11y = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(a11y.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await submit.click();
    await expect(dialog.getByText("We could not confirm whether recovery was queued.", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("What was corrected?")).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await review.click();
    await expect(dialog.getByLabel("What was corrected?")).toHaveValue("MAPPING_CORRECTED");
    await expect(dialog.getByLabel("What was corrected?")).toBeDisabled();
    await dialog.getByRole("button", { name: "Retry this request" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Recovery was queued.", { exact: false })).toBeVisible();
    expect(posts).toBe(2);
    expect(keys[0]).toMatch(/^[\da-f-]{36}$/i);
    expect(keys[1]).toBe(keys[0]);
    await expect(page.getByText("No accounting updates need recovery.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test("recovery load failures stay local and refresh without exposing server text", async ({ page }) => {
  await mockWorkspace(page);
  let fail = true;
  await page.route(`**${recoveryPath}?*`, (route) => route.fulfill({ status: fail ? 503 : 200, contentType: "application/json",
    body: JSON.stringify(fail ? { error: "SECRET_PROVIDER_DIAGNOSTIC" } : { replayEnabled: false, reasons: reasonValues, events: [] }) }));
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByText("Recovery events could not be loaded.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SECRET_PROVIDER_DIAGNOSTIC");
  fail = false;
  await page.getByRole("button", { name: "Refresh recovery events" }).click();
  await expect(page.getByText("Recovery is currently unavailable.", { exact: false })).toBeVisible();
});

test("different recovery actions receive different command identities", async ({ page }) => {
  await mockWorkspace(page);
  let events = [event("event-first-123456789"), event("event-second-123456789")];
  const keys: string[] = [];
  await page.route(`**${recoveryPath}?*`, (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ replayEnabled: true, reasons: reasonValues, events }) }));
  await page.route(`**${recoveryPath}/*/replay`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    events = events.slice(1);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "QUEUED" }) });
  });
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByRole("button", { name: "Review recovery events", exact: true }).click();
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Review retry", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Retry this accounting update?" });
    await dialog.getByLabel("What was corrected?").selectOption("PROVIDER_RECOVERED");
    await dialog.getByRole("button", { name: "Confirm and queue retry" }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test("manual-review-only events are visible above collapsed diagnostics", async ({ page }) => {
  await mockWorkspace(page);
  await page.route(`**${recoveryPath}?*`, (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ replayEnabled: true, reasons: reasonValues, events: [event("manual-event-123456789", false)] }) }));
  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("Accounting updates need review (1).")).toBeVisible();
  const open = page.getByRole("button", { name: "Review recovery events", exact: true });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.locator("#quickbooks-recovery")).toBeFocused();
  await expect(page.getByText("This update needs manual review.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review retry", exact: true })).toHaveCount(0);
});

test("a known connection rejection permits fresh review with a new reason and command", async ({ page }) => {
  await mockWorkspace(page);
  const keys: string[] = [];
  const submittedReasons: string[] = [];
  await page.route(`**${recoveryPath}/*/replay`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    submittedReasons.push(route.request().postDataJSON().reason);
    return route.fulfill({ status: keys.length === 1 ? 409 : 200, contentType: "application/json", body: JSON.stringify(keys.length === 1
      ? { error: "SECRET_PROVIDER_DIAGNOSTIC", code: "QUICKBOOKS_CONNECTION_REVIEW_REQUIRED" } : { outcome: "QUEUED" }) });
  });
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByRole("button", { name: "Review recovery events", exact: true }).click();
  const review = page.getByRole("button", { name: "Review retry", exact: true });
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Retry this accounting update?" });
  await dialog.getByLabel("What was corrected?").selectOption("PROVIDER_RECOVERED");
  await dialog.getByRole("button", { name: "Confirm and queue retry" }).click();
  await expect(dialog.getByText("This event or connection changed.", { exact: false })).toBeVisible();
  await expect(dialog).not.toContainText("SECRET_PROVIDER_DIAGNOSTIC");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Refresh recovery events" }).click();
  await expect(review).toBeEnabled();
  await review.click();
  await expect(dialog.getByLabel("What was corrected?")).toBeEnabled();
  await expect(dialog.getByLabel("What was corrected?")).toHaveValue("");
  await dialog.getByLabel("What was corrected?").selectOption("CONNECTION_REAUTHORIZED");
  await dialog.getByRole("button", { name: "Confirm and queue retry" }).click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  expect(submittedReasons).toEqual(["PROVIDER_RECOVERED", "CONNECTION_REAUTHORIZED"]);
});

test("an unstructured proxy 503 retains uncertain identity across close and reopen", async ({ page }) => {
  await mockWorkspace(page);
  const keys: string[] = [];
  await page.route(`**${recoveryPath}/*/replay`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    return route.fulfill({ status: keys.length === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(keys.length === 1
      ? { error: "Proxy unavailable" } : { outcome: "QUEUED" }) });
  });
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByRole("button", { name: "Review recovery events", exact: true }).click();
  const review = page.getByRole("button", { name: "Review retry", exact: true });
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Retry this accounting update?" });
  await dialog.getByLabel("What was corrected?").selectOption("PROVIDER_RECOVERED");
  await dialog.getByRole("button", { name: "Confirm and queue retry" }).click();
  await expect(dialog.getByText("We could not confirm whether recovery was queued.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await review.click();
  await expect(dialog.getByLabel("What was corrected?")).toBeDisabled();
  await expect(dialog.getByLabel("What was corrected?")).toHaveValue("PROVIDER_RECOVERED");
  await dialog.getByRole("button", { name: "Retry this request" }).click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("older replayable updates remain reachable behind more than 25 manual events", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mockWorkspace(page);
  const manual = Array.from({ length: 27 }, (_, index) => event(`manual-page-${index}`, false));
  const pages = [manual.slice(0, 25), [...manual.slice(25), event("older-replayable-event")]];
  let queued = false;
  await page.route(`**${recoveryPath}?*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      replayEnabled: true, reasons: reasonValues, total: queued ? 27 : 28,
      events: cursor ? (queued ? manual.slice(25) : pages[1]) : pages[0],
      hasMore: !cursor, nextCursor: cursor ? null : "cursor-next-page",
    }) });
  });
  await page.route(`**${recoveryPath}/*/replay`, (route) => {
    expect(route.request().url()).toContain("older-replayable-event");
    queued = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "QUEUED" }) });
  });
  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("Accounting updates need review (28).")).toBeVisible();
  await page.getByRole("button", { name: "Review recovery events", exact: true }).click();
  await expect(page.locator("#quickbooks-recovery li")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Review retry", exact: true })).toHaveCount(0);
  const next = page.getByRole("button", { name: "Next events", exact: true });
  expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await next.click();
  await expect(page.locator("#quickbooks-recovery li")).toHaveCount(3);
  await expect(page.getByText("Page 2: 3 of 28 events needing attention.")).toBeVisible();
  await page.getByRole("button", { name: "Previous events", exact: true }).click();
  await expect(page.locator("#quickbooks-recovery li")).toHaveCount(25);
  await next.click();
  await page.getByRole("button", { name: "Review retry", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Retry this accounting update?" });
  await dialog.getByLabel("What was corrected?").selectOption("PROVIDER_RECOVERED");
  await dialog.getByRole("button", { name: "Confirm and queue retry" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Accounting updates need review (27).")).toBeVisible();
  await expect(page.getByText("Page 1: 25 of 27 events needing attention.")).toBeVisible();
});

test("a removed pagination anchor refreshes page one without exposing cursor errors", async ({ page }) => {
  await mockWorkspace(page);
  let changed = false;
  await page.route(`**${recoveryPath}?*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor) {
      changed = true;
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
        error: "SECRET_CURSOR_DETAIL", code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID",
      }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      replayEnabled: true, reasons: reasonValues, total: changed ? 1 : 26, events: [event()],
      hasMore: !changed, nextCursor: changed ? null : "cursor-removed",
    }) });
  });
  await page.goto("/app/settings#admin-quickbooks");
  await page.getByRole("button", { name: "Review recovery events", exact: true }).click();
  await page.getByRole("button", { name: "Next events", exact: true }).click();
  await expect(page.getByText("The recovery list changed. Showing the first page with current events.")).toBeVisible();
  await expect(page.getByText("Accounting updates need review (1).")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SECRET_CURSOR_DETAIL");
  await expect(page.getByRole("button", { name: "Next events", exact: true })).toHaveCount(0);
});
