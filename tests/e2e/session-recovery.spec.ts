import { expect, test, type Page } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

async function readSessionPayload(page: Page, cookieHeader: string) {
  const response = await page.request.get(`${apiBaseUrl}/v1/auth/me`, {
    headers: { Cookie: cookieHeader },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

test.describe("session recovery", () => {
  for (const publicRoute of [
    { path: "/", heading: "Contractor quoting software and estimating software built for field teams" },
    { path: "/pricing", heading: "Contractor quoting software pricing" },
    { path: "/support", heading: "Support" },
  ]) {
    test(`keeps ${publicRoute.path} available when the session API is degraded`, async ({ page }) => {
      await page.route("**/v1/auth/me", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal provider detail" }),
        }),
      );

      await page.goto(publicRoute.path);
      await expect(page.getByRole("heading", { level: 1, name: publicRoute.heading })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${publicRoute.path === "/" ? "/" : publicRoute.path}$`));
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
      await expect(page.getByText("internal provider detail")).toHaveCount(0);
    });
  }

  test("keeps an app URL while auth is delayed", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "session-delay");
    const sessionPayload = await readSessionPayload(page, account.cookieHeader);
    await addSessionCookie(context, account);

    await page.route("**/v1/auth/me", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionPayload) });
    });

    await page.goto("/app/customers?resume=delayed");
    await expect(page.getByRole("status")).toContainText("Restoring your session");
    await expect(page).toHaveURL(/\/app\/customers\?resume=delayed$/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/customers\?resume=delayed$/);
  });

  test("offers offline-aware retry after a transient failure and resumes the intended app route", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "session-retry");
    const sessionPayload = await readSessionPayload(page, account.cookieHeader);
    await addSessionCookie(context, account);
    let attempts = 0;

    await page.route("**/v1/auth/me", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "provider detail" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionPayload) });
    });

    await page.goto("/app/customers?resume=retry");
    const recoveryStatus = page.getByRole("status");
    await expect(recoveryStatus).toContainText("Your workspace is still here");
    await expect(recoveryStatus).not.toContainText("provider detail");
    await expect(page).toHaveURL(/\/app\/customers\?resume=retry$/);

    await context.setOffline(true);
    await expect(recoveryStatus).toContainText("You're offline");
    await context.setOffline(false);
    await expect(recoveryStatus).toContainText("You're online");

    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await retry.click();

    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/customers\?resume=retry$/);
  });

  test("a definitive 401 clears cached identity and redirects out of the app", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("qf_tenant_id", "cached-tenant");
      localStorage.setItem("qf_full_name", "Cached User");
    });
    await page.route("**/v1/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );

    await page.goto("/app/customers");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: /start free trial/i }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("qf_tenant_id"))).toBeNull();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("qf_full_name"))).toBeNull();
  });

  test("post-signin hydration failure uses recovery instead of a partial workspace session", async ({ page, request }) => {
    const account = await signUpViaApi(request, "post-signin-retry");
    const sessionPayload = await readSessionPayload(page, account.cookieHeader);
    let sessionChecks = 0;

    await page.route("**/v1/auth/me", async (route) => {
      sessionChecks += 1;
      if (sessionChecks === 1) {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) });
        return;
      }
      if (sessionChecks === 2) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "internal provider response" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionPayload) });
    });
    await page.route("**/v1/auth/signin", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: account.user, tenant: account.tenant }),
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Sign In", exact: true }).first().click();
    const signInDialog = page.getByRole("dialog");
    await signInDialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await signInDialog.getByLabel("Email Address").fill(account.email);
    await signInDialog.getByLabel("Password").fill(account.password);
    await signInDialog.getByRole("button", { name: "Sign In", exact: true }).click();

    await expect(page.getByRole("status")).toContainText("Your workspace is still here");
    await expect(page.getByRole("status")).not.toContainText("internal provider response");
    await expect(page).not.toHaveURL(/\/app\/setup$/);

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/customers$/);
  });
});
