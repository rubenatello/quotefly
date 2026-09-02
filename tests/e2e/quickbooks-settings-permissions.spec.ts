import { expect, test } from "@playwright/test";
import { addSessionCookie, addWorkspaceMemberViaApi, apiBaseUrl, signUpViaApi } from "./helpers";

const quickBooksStatusPath = "/v1/integrations/quickbooks/status";
const quickBooksConfirmationPath = "/v1/integrations/quickbooks/setup-confirmation";

function quickBooksStatus(confirmed = false) {
  return {
    enabled: true,
    configured: true,
    providerWorkflowsEnabled: true,
    webhookConfigured: true,
    canManage: true,
    environment: "sandbox",
    setup: {
      phase: confirmed ? "CONFIRMED" : "READY_FOR_CONFIRMATION",
      ready: confirmed,
      confirmed,
      checklistVersion: "2026-08-28.v2",
      confirmedAtUtc: confirmed ? "2026-08-27T12:00:00.000Z" : null,
      checks: [
        { key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" },
        { key: "CONNECTION_ACTIVE", passed: true, managedBy: "WORKSPACE" },
        { key: "SETUP_CONFIRMED", passed: confirmed, managedBy: "WORKSPACE" },
      ],
      capabilities: {
        canConnect: false,
        canReconnect: false,
        canConfirm: !confirmed,
        canDisconnect: true,
      },
      operations: {
        coreConnectionReady: confirmed,
        hostedPaymentsReady: confirmed,
        reconciliationReady: confirmed,
        cdcRecoveryReady: confirmed,
        allAccountingWorkflowsReady: confirmed,
      },
    },
    connection: {
      environment: "sandbox",
      companyName: "QuoteFly Test Company",
      status: "CONNECTED",
      connectedAtUtc: "2026-08-27T11:00:00.000Z",
      lastSyncAtUtc: null,
      lastWebhookAtUtc: null,
      counts: { customerMaps: 0, itemMaps: 0, invoiceSyncs: 0 },
    },
  };
}

test("members can open Settings without requesting private QuickBooks status", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-member");
  const member = await addWorkspaceMemberViaApi(request, owner, "QuickBooks Settings Member");
  await addSessionCookie(context, member);

  let quickBooksStatusRequests = 0;
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === `${apiBaseUrl}${quickBooksStatusPath}`) quickBooksStatusRequests += 1;
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("heading", { name: "QuickBooks setup is manager-only" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(quickBooksStatusRequests).toBe(0);
});

test("owners see setup readiness and can confirm the connected QuickBooks company", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-owner");
  await addSessionCookie(context, owner);

  let confirmed = false;
  let confirmationRequests = 0;
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksStatus(confirmed)) });
  });
  await page.route(`**${quickBooksConfirmationPath}`, async (route) => {
    confirmationRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      checklistVersion: "2026-08-28.v2",
      companyConfirmed: true,
      reviewResponsibilityConfirmed: true,
    });
    confirmed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ confirmed: true, idempotent: false, setup: quickBooksStatus(true).setup }),
    });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm setup" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm setup" }).click();
  await expect(page.getByRole("dialog")).toContainText("Confirm this QuickBooks setup?");
  await page.getByRole("button", { name: "Confirm company setup" }).click();

  await expect(page.getByText("The QuickBooks company connection is confirmed. Review accounting capability status before publishing.")).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Invoice links and payments" })).toContainText("Configured");
  expect(confirmationRequests).toBe(1);
});

test("OAuth callback returns to QuickBooks settings and preserves the connection notice", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-oauth-return-owner");
  await addSessionCookie(context, owner);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksStatus()) });
  });

  await page.goto("/app/settings?integrations=quickbooks_connected#admin-quickbooks");

  await expect(page.getByText("QuickBooks connected successfully.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings#admin-quickbooks$/);
});

test("legacy or malformed QuickBooks status keeps Settings usable with a local retry error", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-malformed");
  await addSessionCookie(context, owner);

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    const { setup: _setup, ...legacyStatus } = quickBooksStatus();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(legacyStatus) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("alert")).toHaveText("QuickBooks readiness could not be loaded.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("QuickBooks setup remains usable at a narrow mobile viewport", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-mobile");
  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Confirm setup" })).toBeVisible();
  await page.getByRole("button", { name: "Setup guide" }).click();
  const guide = page.getByRole("dialog", { name: "Set up QuickBooks Online" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("heading", { name: "Follow these steps" })).toBeVisible();
  await expect(guide.getByText("Keep the first test out of live books")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(page.getByRole("button", { name: "Setup guide" })).toBeFocused();
});

test("QuickBooks setup guide explains sandbox-first connection and preserves keyboard focus", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-guide");
  await addSessionCookie(context, owner);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  const trigger = page.getByRole("button", { name: "Setup guide" });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.focus();
  await page.keyboard.press("Enter");

  const guide = page.getByRole("dialog", { name: "Set up QuickBooks Online" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Recommended for your first test.");
  await expect(guide).toContainText("Intuit Developer sandbox company");
  await expect(guide).toContainText("Check advanced workflow readiness");
  await expect(guide.getByRole("listitem")).toHaveCount(5);

  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Settings categories show one focused panel and preserve category routes", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "settings-categories-owner");
  await addSessionCookie(context, owner);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksStatus()) });
  });

  await page.goto("/app/settings");
  const settingsNav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(settingsNav.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeHidden();

  await settingsNav.getByRole("button", { name: "Billing" }).click();
  await expect(page).toHaveURL(/\/app\/settings\?section=billing$/);
  await expect(page.getByRole("heading", { name: "Current plan" })).toBeVisible();
  await expect(page.getByText("For solo operators and small crews that need clean quoting fast.")).toBeHidden();
  await page.getByText("Compare available plans", { exact: true }).click();
  await expect(page.getByText("For solo operators and small crews that need clean quoting fast.")).toBeVisible();

  await settingsNav.getByRole("button", { name: "QuickBooks" }).click();
  await expect(page).toHaveURL(/\/app\/settings#admin-quickbooks$/);
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible();
  await expect(page.getByText("Setup readiness", { exact: true })).toBeHidden();
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByText("Setup readiness", { exact: true })).toBeVisible();

  await settingsNav.getByRole("button", { name: "Team" }).click();
  await expect(page).toHaveURL(/\/app\/settings\/users$/);
  await expect(page.locator("#admin-team").getByRole("heading", { name: "Team", exact: true })).toBeVisible();
});
