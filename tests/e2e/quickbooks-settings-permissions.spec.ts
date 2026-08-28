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
      checklistVersion: "2026-08-27.v1",
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

  await page.goto("/app/settings");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "QuickBooks setup is manager-only" })).toBeVisible();
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
      checklistVersion: "2026-08-27.v1",
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

  await page.goto("/app/settings");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm setup" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm setup" }).click();
  await expect(page.getByRole("dialog")).toContainText("Confirm this QuickBooks setup?");
  await page.getByRole("button", { name: "Confirm and enable sync" }).click();

  await expect(page.getByText("QuickBooks setup is confirmed and accounting workflows are ready.")).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  expect(confirmationRequests).toBe(1);
});

test("legacy or malformed QuickBooks status keeps Settings usable with a local retry error", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-malformed");
  await addSessionCookie(context, owner);

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    const { setup: _setup, ...legacyStatus } = quickBooksStatus();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(legacyStatus) });
  });

  await page.goto("/app/settings");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
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

  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Confirm setup" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
