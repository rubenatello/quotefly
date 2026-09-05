import { expect, test, type Page } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  signUpViaApi,
} from "./helpers";

const quickBooksStatusPath = "/v1/integrations/quickbooks/status";

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

const workspaceManagedQuickBooksChecks = new Set([
  "CONNECTION_ACTIVE",
  "ACCOUNTING_SCOPE_GRANTED",
  "SETUP_CONFIRMED",
]);

function connectedQuickBooksStatus() {
  const passedChecks = new Set([
    "PROVIDER_CONFIGURED",
    "PROVIDER_WORKFLOWS_ENABLED",
    "CONNECTION_ACTIVE",
    "ENVIRONMENT_MATCHES",
    "ACCOUNTING_SCOPE_GRANTED",
    "CREDENTIALS_AVAILABLE",
    "REALM_BINDING_ACTIVE",
    "CDC_CURSOR_INITIALIZED",
  ]);
  return {
    enabled: true,
    configured: true,
    providerWorkflowsEnabled: true,
    oauthOnlyMode: true,
    webhookConfigured: false,
    canManage: true,
    environment: "sandbox",
    reconciliationWorker: null,
    releaseMatches: null,
    setup: {
      phase: "CONNECTION_VERIFIED",
      ready: false,
      confirmed: false,
      checklistVersion: "2026-08-28.v2",
      confirmedAtUtc: null,
      checks: quickBooksCheckKeys.map((key) => ({
        key,
        passed: passedChecks.has(key),
        managedBy: workspaceManagedQuickBooksChecks.has(key) ? "WORKSPACE" : "QUOTEFLY",
      })),
      capabilities: {
        canConnect: false,
        canReconnect: true,
        canConfirm: false,
        canDisconnect: true,
      },
      operations: {
        coreConnectionReady: false,
        hostedPaymentsReady: false,
        reconciliationReady: false,
        cdcRecoveryReady: false,
        allAccountingWorkflowsReady: false,
      },
    },
    connection: {
      environment: "sandbox",
      companyName: "QuoteFly Sandbox",
      status: "CONNECTED",
      connectedAtUtc: "2026-09-04T12:00:00.000Z",
      disconnectedAtUtc: null,
      lastTokenRefreshAtUtc: null,
      lastSyncAtUtc: null,
      lastWebhookAtUtc: null,
      counts: { customerMaps: 0, itemMaps: 0, invoiceSyncs: 0 },
    },
  };
}

function terminalQuickBooksStatus() {
  const status = connectedQuickBooksStatus();
  return {
    ...status,
    setup: {
      ...status.setup,
      phase: "ACTION_REQUIRED",
      checks: status.setup.checks.map((check) => check.key === "CONNECTION_ACTIVE" ? { ...check, passed: false } : check),
      capabilities: { canConnect: false, canReconnect: false, canConfirm: false, canDisconnect: false },
      operations: {
        coreConnectionReady: false,
        hostedPaymentsReady: false,
        reconciliationReady: false,
        cdcRecoveryReady: false,
        allAccountingWorkflowsReady: false,
      },
    },
    connection: { ...status.connection, status: "ERROR" },
  };
}

async function mockConnectedQuickBooksStatus(page: Page) {
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connectedQuickBooksStatus()),
    });
  });
}

async function lockWorkspaceForBilling(page: Page) {
  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.tenant.subscriptionStatus = "past_due";
    payload.tenant.subscriptionPlanCode = "starter";
    payload.tenant.trialStartsAtUtc = null;
    payload.tenant.trialEndsAtUtc = null;
    payload.tenant.subscriptionCurrentPeriodEndUtc = null;
    payload.tenant.effectivePlanCode = "starter";
    payload.tenant.effectivePlanName = "Basic";
    payload.tenant.isTrial = false;
    payload.tenant.entitlements = {
      ...payload.tenant.entitlements,
      planCode: "starter",
      planName: "Basic",
      isTrial: false,
      hasWorkspaceAccess: false,
      billingRequired: true,
      accessReason: "past_due",
    };
    await route.fulfill({ response, json: payload });
  });
}

test("locked mobile owners can recover failed payments through the billing portal", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-mobile-recovery");
  await addSessionCookie(context, account);
  await lockWorkspaceForBilling(page);

  let portalRequests = 0;
  await page.route("**/v1/billing/portal-session", async (route) => {
    portalRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "/support?billing=portal-test" }),
    });
  });

  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { name: "Update billing to unlock your workspace." })).toBeVisible();
  await expect(page.getByRole("button", { name: /start basic/i }).filter({ visible: true })).toHaveCount(0);
  const updateBilling = page.getByRole("button", { name: "Update Billing" }).filter({ visible: true });
  await expect(updateBilling).toBeVisible();
  await updateBilling.click();
  await expect(page).toHaveURL(/\/support\?billing=portal-test$/);
  expect(portalRequests).toBe(1);
});

test("billing-locked owners can disconnect QuickBooks from an arbitrary workspace route", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-qbo-disconnect");
  await addSessionCookie(context, account);
  await lockWorkspaceForBilling(page);
  await mockConnectedQuickBooksStatus(page);

  let disconnectRequests = 0;
  await page.route("**/v1/integrations/quickbooks/disconnect", async (route) => {
    disconnectRequests += 1;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ disconnected: true }),
    });
  });

  await page.goto("/app/customers");
  const disconnectButton = page.getByRole("button", { name: "Disconnect QuickBooks", exact: true });
  await expect(disconnectButton).toBeVisible();
  await disconnectButton.click();

  const dialog = page.getByRole("dialog", { name: "Disconnect QuickBooks?" });
  await expect(dialog).toContainText("Existing QuoteFly customers, quotes, jobs, invoices, mappings, and audit history will stay");
  await dialog.getByRole("button", { name: "Disconnect QuickBooks", exact: true }).click();

  await expect(page.getByText("QuickBooks access was revoked. QuoteFly data and audit history were kept, and the workspace remains billing-locked.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Update billing to unlock your workspace." })).toBeVisible();
  expect(disconnectRequests).toBe(1);
});

test("billing-locked QuickBooks disconnect reports durable revocation retry", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-qbo-revocation-pending");
  await addSessionCookie(context, account);
  await lockWorkspaceForBilling(page);

  let statusRequests = 0;
  let allowStatusRetry = false;
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    statusRequests += 1;
    if (!allowStatusRetry) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "private" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connectedQuickBooksStatus()),
    });
  });

  await page.route("**/v1/integrations/quickbooks/disconnect", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ disconnected: false, revocationPending: true }),
    });
  });

  await page.goto("/app/settings");
  await expect(page.getByText("QuoteFly could not complete this action right now. Try again in a moment.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect QuickBooks", exact: true })).toHaveCount(0);
  allowStatusRetry = true;
  await page.getByRole("button", { name: "Retry QuickBooks status" }).click();
  await page.getByRole("button", { name: "Disconnect QuickBooks", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect QuickBooks", exact: true }).click();

  await expect(page.getByText("QuoteFly stopped QuickBooks automation, but secure provider revocation is still being retried. QuoteFly data and audit history were kept.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Update billing to unlock your workspace." })).toBeVisible();
  expect(statusRequests).toBeGreaterThanOrEqual(2);
});

test("canceling a billing-locked QuickBooks disconnect restores focus and sends no request", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-qbo-disconnect-cancel");
  await addSessionCookie(context, account);
  await lockWorkspaceForBilling(page);
  await mockConnectedQuickBooksStatus(page);

  let disconnectRequests = 0;
  await page.route("**/v1/integrations/quickbooks/disconnect", async (route) => {
    disconnectRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ disconnected: true }) });
  });

  await page.goto("/app/quotes");
  const disconnectButton = page.getByRole("button", { name: "Disconnect QuickBooks", exact: true });
  await disconnectButton.click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toHaveCount(0);
  await expect(disconnectButton).toBeFocused();
  expect(disconnectRequests).toBe(0);
});

test("Spanish 320px billing recovery keeps QuickBooks revocation localized and retryable", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-qbo-spanish-retry");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 320, height: 844 });
  await lockWorkspaceForBilling(page);
  await mockConnectedQuickBooksStatus(page);

  const rawProviderError = "Raw Intuit credential failure must stay private";
  let disconnectRequests = 0;
  await page.route("**/v1/integrations/quickbooks/disconnect", async (route) => {
    disconnectRequests += 1;
    if (disconnectRequests === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ disconnected: true, revocationPending: true, error: rawProviderError }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ disconnected: true }),
    });
  });

  await page.goto("/app/customers");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  const disconnectButton = page.getByRole("button", { name: "Desconectar QuickBooks", exact: true });
  const buttonBox = await disconnectButton.boundingBox();
  expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const initialWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(initialWidths.scroll).toBeLessThanOrEqual(initialWidths.client);

  await disconnectButton.click();
  const dialog = page.getByRole("dialog", { name: "¿Desconectar QuickBooks?" });
  await dialog.getByRole("button", { name: "Desconectar QuickBooks", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("No se pudo desconectar QuickBooks.");
  await expect(page.getByText(rawProviderError, { exact: false })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Desconectar QuickBooks", exact: true }).click();
  await expect(page.getByText("Se revocó el acceso a QuickBooks. Los datos y el historial de auditoría de QuoteFly se conservaron, y el espacio sigue bloqueado por pago.")).toBeVisible();
  expect(disconnectRequests).toBe(2);
});

test("billing-locked members cannot invoke QuickBooks disconnect", async ({
  context,
  page,
  request,
}) => {
  const owner = await signUpViaApi(request, "billing-qbo-member-owner");
  const member = await addWorkspaceMemberViaApi(request, owner, "Billing Locked Member");
  await addSessionCookie(context, member);
  await lockWorkspaceForBilling(page);

  let disconnectRequests = 0;
  let statusRequests = 0;
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === `${apiBaseUrl}/v1/integrations/quickbooks/disconnect`) {
      disconnectRequests += 1;
    }
    if (browserRequest.url() === `${apiBaseUrl}${quickBooksStatusPath}`) {
      statusRequests += 1;
    }
  });

  await page.goto("/app/customers");
  await expect(page.getByRole("button", { name: "Disconnect QuickBooks", exact: true })).toHaveCount(0);
  await expect(page.getByText("Only a workspace owner or admin can disconnect QuickBooks while billing is locked.")).toBeVisible();
  expect(disconnectRequests).toBe(0);
  expect(statusRequests).toBe(0);
});

test("billing-locked terminal QuickBooks errors show support guidance with no mutation action", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "billing-qbo-terminal-error");
  await addSessionCookie(context, account);
  await lockWorkspaceForBilling(page);
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(terminalQuickBooksStatus()) });
  });

  let mutationRequests = 0;
  page.on("request", (browserRequest) => {
    if (/\/v1\/integrations\/quickbooks\/(connect|disconnect)/.test(browserRequest.url())) mutationRequests += 1;
  });

  await page.goto("/app/customers");
  await expect(page.getByText("QuickBooks is in a terminal recovery state. Contact QuoteFly support; reconnect and disconnect are unavailable to protect accounting records and credentials.")).toBeVisible();
  await expect(page.getByRole("button", { name: /connect|reconnect|disconnect quickbooks/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Update billing to unlock your workspace." })).toBeVisible();
  expect(mutationRequests).toBe(0);
});
