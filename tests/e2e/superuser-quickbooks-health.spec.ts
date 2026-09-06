import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";
import { quickBooksHealthFixture } from "./quickbooks-health-fixture";

test("health check exposes a clear loading state before presenting fresh results", async ({ context, page, request }) => {
  test.slow();
  const account = await signUpViaApi(request, "qbo-health-loading", "superuser-e2e@example.com");
  await addSessionCookie(context, account);
  let releaseHealth!: () => void;
  const healthGate = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    await healthGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksHealthFixture()) });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByText(/checking the current QuickBooks operational snapshot/i)).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator("div[aria-busy=true]")).toBeVisible();
  releaseHealth();
  await expect(panel.getByText("OAuth connection checks are clear", { exact: true })).toBeVisible();
});

test("superuser sees honest OAuth-only health and a failed refresh clears the prior healthy state", async ({ context, page, request }) => {
  test.slow();
  const account = await signUpViaApi(request, "qbo-health-desktop", "superuser-e2e@example.com");
  await addSessionCookie(context, account);

  let failHealth = false;
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    if (failHealth) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "QUICKBOOKS_INTEGRATION_HEALTH_UNAVAILABLE",
          error: "QuickBooks integration health is temporarily unavailable.",
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksHealthFixture()) });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByRole("heading", { name: "QuickBooks integration health" })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("OAuth connection checks are clear", { exact: true })).toBeVisible();
  await expect(panel.getByText("OAuth only", { exact: true })).toBeVisible();
  await expect(panel.getByText(/does not certify accounting automation/i)).toBeVisible();
  await expect(panel.getByText("Owner alert receipt", { exact: true })).toBeVisible();
  await expect(panel.getByText("Not verified", { exact: true })).toBeVisible();
  await expect(panel.getByText("Worker signal sink", { exact: true })).toBeVisible();
  await expect(panel.getByText("Not required", { exact: true }).first()).toBeVisible();

  failHealth = true;
  const refresh = panel.getByRole("button", { name: "Refresh health", exact: true });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toContainText("Status unavailable");
  await expect(panel.getByText("OAuth connection checks are clear", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("No failures detected", { exact: true })).toHaveCount(0);
});

test("malformed health responses fail closed instead of presenting success", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "qbo-health-malformed", "superuser-e2e@example.com");
  await addSessionCookie(context, account);
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(quickBooksHealthFixture({ state: "excellent" })),
    });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByRole("alert")).toContainText("Status unavailable", { timeout: 15_000 });
  await expect(panel.getByText("Healthy", { exact: true })).toHaveCount(0);
});

for (const field of ["environment", "mode", "state"] as const) {
  test(`array-valued health ${field} is rejected without enum coercion`, async ({ context, page, request }) => {
    const account = await signUpViaApi(request, `qbo-health-array-${field}`, "superuser-e2e@example.com");
    await addSessionCookie(context, account);
    await page.route("**/v1/internal/control-plane/quickbooks-health", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(quickBooksHealthFixture({ [field]: [field === "state" ? "critical" : field === "mode" ? "oauth_only" : "sandbox"] })),
    }));
    await page.goto("/app/internal/admin");
    const panel = page.getByTestId("quickbooks-integration-health");
    await expect(panel.getByRole("alert")).toContainText("Status unavailable", { timeout: 15_000 });
    await expect(panel.getByText("No failures detected", { exact: true })).toHaveCount(0);
  });
}

test("clear accounting operations do not claim healthy before external alert delivery is verified", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "qbo-health-alert-gate", "superuser-e2e@example.com");
  await addSessionCookie(context, account);
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(quickBooksHealthFixture({
        mode: "accounting",
        automation: {
          providerActionsEnabled: true,
          hostedPaymentsEnabled: true,
          reconciliationEnabled: true,
          cdcEnabled: true,
          webhookConfigured: true,
        },
        monitors: {
          bearerConfigured: true,
          apiSignalSinkConfigured: true,
          workerSignalSinkConfigured: null,
          deliveryVerified: false,
        },
        worker: {
          required: true,
          status: "running",
          ready: true,
          lastObservedAtUtc: new Date().toISOString(),
          releaseMatches: true,
        },
      })),
    });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByText("Operations clear; alerting unverified", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Alerting unverified", { exact: true })).toBeVisible();
  await expect(panel.locator(".lucide-circle-check")).toHaveCount(0);
  await expect(panel.getByText("Not observable from API", { exact: true })).toBeVisible();
  await expect(panel.getByText(/source token is intentionally isolated from the API/i)).toBeVisible();
  await expect(panel.getByText("Healthy", { exact: true })).toHaveCount(0);
});

test("stale snapshots are identified and do not retain a green status", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "qbo-health-stale", "superuser-e2e@example.com");
  await addSessionCookie(context, account);
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(quickBooksHealthFixture({ observedAtUtc: "2026-01-01T00:00:00.000Z" })),
    });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByText("Refresh health status", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Snapshot stale", { exact: true })).toBeVisible();
  await expect(panel.getByText("No failures detected", { exact: true })).toHaveCount(0);
});

test("ordinary workspace users cannot reach or request platform integration health", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "qbo-health-member");
  await addSessionCookie(context, account);
  let healthRequestCount = 0;
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    healthRequestCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksHealthFixture()) });
  });

  await page.goto("/app/internal/admin");
  await expect(page).toHaveURL(/\/app\/settings$/);
  await expect(page.getByTestId("quickbooks-integration-health")).toHaveCount(0);
  expect(healthRequestCount).toBe(0);
});
