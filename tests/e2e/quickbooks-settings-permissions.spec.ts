import { expect, test } from "@playwright/test";
import { addSessionCookie, addWorkspaceMemberViaApi, apiBaseUrl, signUpViaApi } from "./helpers";

const quickBooksStatusPath = "/v1/integrations/quickbooks/status";
const quickBooksConfirmationPath = "/v1/integrations/quickbooks/setup-confirmation";

const quickBooksCheckKeys = [
  "PROVIDER_CONFIGURED",
  "PROVIDER_WORKFLOWS_ENABLED",
  "ACCOUNTING_WORKFLOWS_ENABLED",
  "WEBHOOK_CONFIGURED",
  "HOSTED_PAYMENTS_ENABLED",
  "RECONCILIATION_WORKER_ENABLED",
  "RECONCILIATION_WORKER_HEALTHY",
  "CDC_WORKER_ENABLED",
  "CONNECTION_ACTIVE",
  "ENVIRONMENT_MATCHES",
  "ACCOUNTING_SCOPE_GRANTED",
  "CREDENTIALS_AVAILABLE",
  "REALM_BINDING_ACTIVE",
  "CDC_CURSOR_INITIALIZED",
  "SETUP_CONFIRMED",
] as const;

const workspaceCheckKeys = new Set(["CONNECTION_ACTIVE", "ACCOUNTING_SCOPE_GRANTED", "SETUP_CONFIRMED"]);
const optionalOperationCheckKeys = new Set([
  "WEBHOOK_CONFIGURED",
  "ACCOUNTING_WORKFLOWS_ENABLED",
  "HOSTED_PAYMENTS_ENABLED",
  "RECONCILIATION_WORKER_ENABLED",
  "RECONCILIATION_WORKER_HEALTHY",
  "CDC_WORKER_ENABLED",
  "SETUP_CONFIRMED",
]);

function quickBooksStatusFor(options: {
  confirmed?: boolean;
  configured?: boolean;
  providerWorkflowsEnabled?: boolean;
  oauthOnlyMode?: boolean;
  webhookConfigured?: boolean;
  hostedPaymentsEnabled?: boolean;
  reconciliationWorkerEnabled?: boolean;
  reconciliationWorkerHealthy?: boolean;
  cdcWorkerEnabled?: boolean;
  connection?: "CONNECTED" | "NEEDS_REAUTH" | "REVOCATION_PENDING" | "ERROR" | "DISCONNECTED" | null;
  connectionEnvironment?: "sandbox" | "production";
  accountingScopeGranted?: boolean;
  credentialsAvailable?: boolean;
  realmBindingActive?: boolean;
  cdcCursorInitialized?: boolean;
} = {}) {
  const configured = options.configured ?? true;
  const providerWorkflowsEnabled = options.providerWorkflowsEnabled ?? true;
  const oauthOnlyMode = options.oauthOnlyMode ?? false;
  const webhookConfigured = options.webhookConfigured ?? providerWorkflowsEnabled;
  const reconciliationWorkerEnabled = options.reconciliationWorkerEnabled
    ?? (providerWorkflowsEnabled && !oauthOnlyMode);
  const hostedPaymentsEnabled = options.hostedPaymentsEnabled ?? reconciliationWorkerEnabled;
  const reconciliationWorkerHealthy = options.reconciliationWorkerHealthy ?? reconciliationWorkerEnabled;
  const cdcWorkerEnabled = options.cdcWorkerEnabled ?? reconciliationWorkerEnabled;
  const connectionStatus = options.connection === undefined ? "CONNECTED" : options.connection;
  const hasConnection = connectionStatus !== null;
  const connected = connectionStatus === "CONNECTED";
  const connectionEnvironment = options.connectionEnvironment ?? "sandbox";
  const environmentMatches = hasConnection && connectionEnvironment === "sandbox";
  const accountingScopeGranted = options.accountingScopeGranted ?? hasConnection;
  const credentialsAvailable = options.credentialsAvailable ?? hasConnection;
  const realmBindingActive = options.realmBindingActive ?? hasConnection;
  const cdcCursorInitialized = options.cdcCursorInitialized ?? hasConnection;
  const confirmed = Boolean(options.confirmed && !oauthOnlyMode && connected);
  const checksByKey = {
    PROVIDER_CONFIGURED: configured,
    PROVIDER_WORKFLOWS_ENABLED: providerWorkflowsEnabled,
    ACCOUNTING_WORKFLOWS_ENABLED: !oauthOnlyMode,
    WEBHOOK_CONFIGURED: webhookConfigured,
    HOSTED_PAYMENTS_ENABLED: hostedPaymentsEnabled,
    RECONCILIATION_WORKER_ENABLED: reconciliationWorkerEnabled,
    RECONCILIATION_WORKER_HEALTHY: reconciliationWorkerHealthy,
    CDC_WORKER_ENABLED: cdcWorkerEnabled,
    CONNECTION_ACTIVE: connected,
    ENVIRONMENT_MATCHES: environmentMatches,
    ACCOUNTING_SCOPE_GRANTED: accountingScopeGranted,
    CREDENTIALS_AVAILABLE: credentialsAvailable,
    REALM_BINDING_ACTIVE: realmBindingActive,
    CDC_CURSOR_INITIALIZED: cdcCursorInitialized,
    SETUP_CONFIRMED: confirmed,
  } as const;
  const requiredChecksPassed = quickBooksCheckKeys
    .filter((key) => !optionalOperationCheckKeys.has(key))
    .every((key) => checksByKey[key]);
  const platformAvailable = configured && providerWorkflowsEnabled;
  const phase = !platformAvailable
    ? "UNAVAILABLE"
    : connectionStatus === null || connectionStatus === "DISCONNECTED"
      ? "NOT_CONNECTED"
      : !requiredChecksPassed
        ? "ACTION_REQUIRED"
        : oauthOnlyMode
          ? "CONNECTION_VERIFIED"
          : confirmed
            ? "CONFIRMED"
            : "READY_FOR_CONFIRMATION";
  const coreConnectionReady = requiredChecksPassed && confirmed && !oauthOnlyMode;
  const reconciliationReady = coreConnectionReady
    && webhookConfigured
    && reconciliationWorkerEnabled
    && reconciliationWorkerHealthy;

  return {
    enabled: configured && providerWorkflowsEnabled,
    configured,
    providerWorkflowsEnabled,
    oauthOnlyMode,
    webhookConfigured,
    canManage: true,
    environment: "sandbox",
    reconciliationWorker: reconciliationWorkerHealthy
      ? { status: "RUNNING", fresh: true, heartbeatAtUtc: "2026-08-27T11:00:00.000Z" }
      : null,
    releaseMatches: null,
    setup: {
      phase,
      ready: coreConnectionReady,
      confirmed,
      checklistVersion: "2026-08-28.v2",
      confirmedAtUtc: confirmed ? "2026-08-27T12:00:00.000Z" : null,
      checks: quickBooksCheckKeys.map((key) => ({
        key,
        passed: checksByKey[key],
        managedBy: workspaceCheckKeys.has(key) ? "WORKSPACE" : "QUOTEFLY",
      })),
      capabilities: {
        canConnect: platformAvailable && (connectionStatus === null || connectionStatus === "DISCONNECTED"),
        canReconnect: platformAvailable && (connectionStatus === "CONNECTED" || connectionStatus === "NEEDS_REAUTH"),
        canConfirm: requiredChecksPassed && !oauthOnlyMode,
        canDisconnect: connectionStatus === "CONNECTED" || connectionStatus === "NEEDS_REAUTH" || connectionStatus === "REVOCATION_PENDING",
      },
      operations: {
        coreConnectionReady,
        hostedPaymentsReady: reconciliationReady && hostedPaymentsEnabled,
        reconciliationReady,
        cdcRecoveryReady: reconciliationReady && cdcWorkerEnabled,
        allAccountingWorkflowsReady: reconciliationReady && hostedPaymentsEnabled && cdcWorkerEnabled,
      },
    },
    connection: connectionStatus === null ? null : {
      environment: connectionEnvironment,
      companyName: "QuoteFly Test Company",
      status: connectionStatus,
      connectedAtUtc: "2026-08-27T11:00:00.000Z",
      disconnectedAtUtc: null,
      lastTokenRefreshAtUtc: null,
      lastSyncAtUtc: null,
      lastWebhookAtUtc: null,
      counts: { customerMaps: 0, itemMaps: 0, invoiceSyncs: 0 },
    },
  };
}

function quickBooksStatus(confirmed = false) {
  return quickBooksStatusFor({ confirmed });
}

function quickBooksConnectionOnlyStatus() {
  return quickBooksStatusFor({ oauthOnlyMode: true });
}

function quickBooksDegradedConnectionOnlyStatus() {
  return quickBooksStatusFor({
    oauthOnlyMode: true,
    connectionEnvironment: "production",
    credentialsAvailable: false,
    realmBindingActive: false,
    cdcCursorInitialized: false,
  });
}

function quickBooksImpossibleConnectionOnlyStatus() {
  return quickBooksStatusFor({ oauthOnlyMode: true, configured: false, providerWorkflowsEnabled: false });
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

test("terminal QuickBooks errors show support guidance with no lifecycle actions", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-terminal-error");
  await addSessionCookie(context, owner);
  const terminal = quickBooksStatusFor({ connection: "ERROR" });
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(terminal) });
  });

  let mutations = 0;
  page.on("request", (browserRequest) => {
    if (/\/v1\/integrations\/quickbooks\/(connect|disconnect)/.test(browserRequest.url())) mutations += 1;
  });
  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuickBooks connection requires QuoteFly support")).toBeVisible();
  await expect(page.getByRole("button", { name: /connect quickbooks|reconnect quickbooks|disconnect/i })).toHaveCount(0);
  expect(mutations).toBe(0);
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

for (const [name, invalidStatus] of [
  [
    "READY_FOR_CONFIRMATION without a connection",
    { ...quickBooksStatus(), connection: null },
  ],
  [
    "CONFIRMED with a reauthorization-required connection",
    { ...quickBooksStatus(true), connection: { ...quickBooksStatus(true).connection!, status: "NEEDS_REAUTH" } },
  ],
] as const) {
  test(`contradictory ${name} fails closed without a configuration claim`, async ({ context, page, request }) => {
    const owner = await signUpViaApi(request, `quickbooks-settings-contradictory-${name.slice(0, 12)}`);
    await addSessionCookie(context, owner);
    await page.route(`**${quickBooksStatusPath}`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(invalidStatus) });
    });

    await page.goto("/app/settings#admin-quickbooks");
    await expect(page.getByRole("alert")).toHaveText("QuickBooks readiness could not be loaded.");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm setup" })).toHaveCount(0);
    await expect(page.getByText("Confirmed", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "QuoteFly Test Company" })).toHaveCount(0);
  });
}

test("QuoteFly-managed unavailable setup explains responsibility before a company is connected", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-unavailable");
  await addSessionCookie(context, owner);
  const unavailable = quickBooksStatusFor({
    configured: false,
    providerWorkflowsEnabled: false,
    connection: null,
  });

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
  const preConnection = quickBooksStatusFor({
    oauthOnlyMode: true,
    webhookConfigured: false,
    connection: null,
  });

  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preConnection) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuoteFly-managed QuickBooks setup needs attention", { exact: true })).toHaveCount(0);
  await page.getByText("Setup checks & diagnostics", { exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Provider-backed accounting actions enabled" })).toContainText("Intentionally disabled as a staging safeguard");
  await expect(page.getByRole("listitem").filter({ hasText: "Webhook verifier configured; signed delivery test pending" })).toContainText("Intentionally disabled as a staging safeguard");
});

test("connected guidance retains downstream QuoteFly-managed readiness failures", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-connected-scope");
  await addSessionCookie(context, owner);
  const connected = quickBooksStatusFor({ realmBindingActive: false });

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

test("impossible OAuth-only unavailable provider state fails closed on mobile", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-oauth-only-unavailable-mobile");
  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksImpossibleConnectionOnlyStatus()) });
  });

  await page.goto("/app/settings#admin-quickbooks");
  await expect(page.getByText("QuickBooks connection verified for staging", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("QuickBooks readiness could not be loaded.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect quickbooks|reconnect quickbooks|disconnect|confirm setup/i })).toHaveCount(0);
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
