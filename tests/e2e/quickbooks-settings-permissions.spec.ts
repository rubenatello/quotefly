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

function quickBooksConnectionOnlyStatus() {
  const status = quickBooksStatus();
  return {
    ...status,
    oauthOnlyMode: true,
    setup: {
      ...status.setup,
      phase: "CONNECTION_VERIFIED",
      checks: [
        { key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" },
        { key: "PROVIDER_WORKFLOWS_ENABLED", passed: true, managedBy: "QUOTEFLY" },
        { key: "ACCOUNTING_WORKFLOWS_ENABLED", passed: false, managedBy: "QUOTEFLY" },
        { key: "WEBHOOK_CONFIGURED", passed: false, managedBy: "QUOTEFLY" },
        { key: "CONNECTION_ACTIVE", passed: true, managedBy: "WORKSPACE" },
        { key: "ENVIRONMENT_MATCHES", passed: true, managedBy: "QUOTEFLY" },
        { key: "ACCOUNTING_SCOPE_GRANTED", passed: true, managedBy: "WORKSPACE" },
        { key: "CREDENTIALS_AVAILABLE", passed: true, managedBy: "QUOTEFLY" },
        { key: "REALM_BINDING_ACTIVE", passed: true, managedBy: "QUOTEFLY" },
        { key: "CDC_CURSOR_INITIALIZED", passed: true, managedBy: "QUOTEFLY" },
        { key: "SETUP_CONFIRMED", passed: false, managedBy: "WORKSPACE" },
      ],
      capabilities: { ...status.setup.capabilities, canConfirm: false },
      operations: {
        coreConnectionReady: false,
        hostedPaymentsReady: false,
        reconciliationReady: false,
        cdcRecoveryReady: false,
        allAccountingWorkflowsReady: false,
      },
    },
  };
}

function quickBooksDegradedConnectionOnlyStatus() {
  const status = quickBooksConnectionOnlyStatus();
  return {
    ...status,
    setup: {
      ...status.setup,
      phase: "ACTION_REQUIRED",
      checks: [
        { key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" },
        { key: "ACCOUNTING_WORKFLOWS_ENABLED", passed: false, managedBy: "QUOTEFLY" },
        { key: "ENVIRONMENT_MATCHES", passed: false, managedBy: "QUOTEFLY" },
        { key: "CREDENTIALS_AVAILABLE", passed: false, managedBy: "QUOTEFLY" },
        { key: "REALM_BINDING_ACTIVE", passed: false, managedBy: "QUOTEFLY" },
        { key: "CDC_CURSOR_INITIALIZED", passed: false, managedBy: "QUOTEFLY" },
        { key: "CONNECTION_ACTIVE", passed: true, managedBy: "WORKSPACE" },
        { key: "SETUP_CONFIRMED", passed: false, managedBy: "WORKSPACE" },
      ],
    },
  };
}

function quickBooksUnavailableConnectionOnlyStatus() {
  const status = quickBooksConnectionOnlyStatus();
  return {
    ...status,
    setup: {
      ...status.setup,
      phase: "UNAVAILABLE",
      checks: [
        { key: "PROVIDER_CONFIGURED", passed: false, managedBy: "QUOTEFLY" },
        { key: "PROVIDER_WORKFLOWS_ENABLED", passed: false, managedBy: "QUOTEFLY" },
        { key: "CONNECTION_ACTIVE", passed: true, managedBy: "WORKSPACE" },
        { key: "SETUP_CONFIRMED", passed: false, managedBy: "WORKSPACE" },
      ],
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

test("QuoteFly-managed unavailable setup explains responsibility before a company is connected", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-unavailable");
  await addSessionCookie(context, owner);
  const unavailable = quickBooksStatus();
  unavailable.setup.phase = "UNAVAILABLE";
  unavailable.connection = null;
  unavailable.setup.checks = [
    { key: "PROVIDER_CONFIGURED", passed: false, managedBy: "QUOTEFLY" },
  ];
  unavailable.setup.capabilities = {
    canConnect: false,
    canReconnect: false,
    canConfirm: false,
    canDisconnect: false,
  };

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unavailable) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  const alert = page.getByRole("status").filter({ hasText: "QuoteFly-managed QuickBooks setup needs attention" });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText("No QuickBooks changes were made.");
  await expect(alert).toContainText("contact QuoteFly support");
});

test("pre-connection guidance ignores downstream platform checks while diagnostics retain them", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-preconnection-scope");
  await addSessionCookie(context, owner);
  const preConnection = quickBooksStatus();
  preConnection.setup.phase = "NOT_CONNECTED";
  preConnection.connection = null;
  preConnection.setup.checks = [
    { key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" },
    { key: "PROVIDER_WORKFLOWS_ENABLED", passed: true, managedBy: "QUOTEFLY" },
    { key: "ACCOUNTING_WORKFLOWS_ENABLED", passed: false, managedBy: "QUOTEFLY" },
    { key: "WEBHOOK_CONFIGURED", passed: false, managedBy: "QUOTEFLY" },
  ];
  preConnection.setup.capabilities = {
    canConnect: true,
    canReconnect: false,
    canConfirm: false,
    canDisconnect: false,
  };

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preConnection) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuoteFly-managed QuickBooks setup needs attention", { exact: true })).toHaveCount(0);
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Provider-backed accounting actions enabled" })).toContainText("QuoteFly manages this check.");
  await expect(page.getByRole("listitem").filter({ hasText: "Webhook verifier configured; signed delivery test pending" })).toContainText("QuoteFly manages this check.");
});

test("connected guidance retains downstream QuoteFly-managed readiness failures", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-connected-scope");
  await addSessionCookie(context, owner);
  const connected = quickBooksStatus();
  connected.setup.phase = "ACTION_REQUIRED";
  connected.setup.checks = [
    { key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" },
    { key: "ACCOUNTING_WORKFLOWS_ENABLED", passed: false, managedBy: "QUOTEFLY" },
  ];

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connected) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuickBooks is connected, but automation is not ready yet", { exact: true })).toBeVisible();
});

test("connection-only validation clearly labels intentionally disabled accounting safeguards", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-oauth-only");
  await addSessionCookie(context, owner);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksConnectionOnlyStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("Connection verified", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("QuickBooks connection verified for staging", { exact: true })).toBeVisible();
  await expect(page.getByText("will not become available by waiting")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm setup" })).toHaveCount(0);
  await expect(page.getByText("Finish these workspace setup items", { exact: true })).toHaveCount(0);
  await expect(page.getByText("QuickBooks is connected, but automation is not ready yet", { exact: true })).toHaveCount(0);

  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Provider-backed accounting actions enabled" })).toContainText("Intentionally disabled as a staging safeguard");
  await expect(page.getByRole("listitem").filter({ hasText: "Accounting setup confirmation" })).toContainText("Intentionally disabled");
  await expect(page.getByRole("listitem").filter({ hasText: "Company connection" })).toHaveCount(0);
});

test("OAuth-only connection-integrity failures remain visible and never claim verification", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-oauth-only-degraded");
  await addSessionCookie(context, owner);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksDegradedConnectionOnlyStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuickBooks connection verified for staging", { exact: true })).toHaveCount(0);
  await expect(page.getByText("QuickBooks connection needs attention", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Do not wait or change anything in QuickBooks.", { exact: false })).toBeVisible();
  await expect(page.getByText("QuickBooks is connected, but automation is not ready yet", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm setup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /publish|invoice|payment/i })).toHaveCount(0);
  for (const label of [
    "Sandbox or production environment matches",
    "Encrypted credentials available",
    "Company binding active",
    "Change-recovery cursor initialized",
  ]) {
    await expect(page.getByRole("status").filter({ hasText: label })).toBeVisible();
  }

  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  const setupReadiness = page.getByRole("region", { name: "Setup readiness" });
  for (const label of [
    "Sandbox or production environment matches",
    "Encrypted credentials available",
    "Company binding active",
    "Change-recovery cursor initialized",
  ]) {
    await expect(setupReadiness.getByRole("listitem").filter({ hasText: label })).toContainText("QuoteFly manages this check.");
  }
  await expect(page.getByRole("listitem").filter({ hasText: "Provider-backed accounting actions enabled" }))
    .toContainText("Intentionally disabled as a staging safeguard");
});

test("OAuth-only unavailable provider state uses integrity attention on mobile instead of waiting copy", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-oauth-only-unavailable-mobile");
  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksUnavailableConnectionOnlyStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuickBooks connection verified for staging", { exact: true })).toHaveCount(0);
  await expect(page.getByText("QuickBooks connection needs attention", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("QuickBooks is connected, but automation is not ready yet", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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

test("connection-only setup guide remains usable on mobile without confirmation or publishing steps", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-oauth-only-mobile");
  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksConnectionOnlyStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByRole("button", { name: "Confirm setup" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Setup guide" });
  await trigger.click();
  const guide = page.getByRole("dialog", { name: "Set up QuickBooks Online" });
  await expect(guide).toContainText("Verify callback replay protection");
  await expect(guide).toContainText("Disconnect and verify revocation");
  await expect(guide).not.toContainText("Confirm the workspace setup");
  await expect(guide).not.toContainText("publish one reviewed test invoice");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
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
