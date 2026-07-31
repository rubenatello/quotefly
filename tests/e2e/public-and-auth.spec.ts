import { expect, test } from "@playwright/test";
import {
  expectNoFrontendJwtStorage,
  expectSessionCookieCleared,
  expectSessionCookiePresent,
  uniqueRunLabel,
} from "./helpers";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

test.describe("public site and session auth", () => {
  test("cookie preferences are explicit, synchronized, and reversible", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("qf_cookie_consent"));
    await page.reload();

    const preferences = page.getByRole("complementary", { name: "Cookie preferences" });
    await expect(preferences).toBeVisible();
    await preferences.getByRole("button", { name: "Essential only" }).click();
    await expect(preferences).toBeHidden();

    await page.goto("/cookies");
    await expect(page.getByText("Current setting:").locator("..")) .toContainText("Essential only");
    await page.getByRole("button", { name: "Accept analytics" }).click();
    await expect(page.getByText("Current setting:").locator("..")) .toContainText("Analytics accepted");

    const consent = await page.evaluate(() => JSON.parse(localStorage.getItem("qf_cookie_consent") ?? "null"));
    expect(consent).toMatchObject({ choice: "accepted", version: 1 });
    expect(Date.parse(consent.expiresAtUtc)).toBeGreaterThan(Date.now());

    await page.getByRole("button", { name: "Ask me again" }).click();
    await expect(preferences).toBeVisible();
  });

  test("public launch pages render and the auth modal opens", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/"].heading })).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: /contractor quoting software pricing/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Coming Soon" }).first()).toBeDisabled();

    await page.goto("/services");
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/services"].heading })).toBeVisible();

    await page.goto("/solutions");
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/solutions"].heading })).toBeVisible();

    await page.goto("/support");
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/support"].heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Email support" })).toHaveAttribute(
      "href",
      /^mailto:support@quotefly\.us\?subject=QuoteFly\+support\+request/,
    );
    await expect(page.getByRole("link", { name: "Email sales" })).toHaveAttribute(
      "href",
      /^mailto:info@quotefly\.us\?subject=QuoteFly\+sales\+inquiry/,
    );

    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: /handles personal data/i })).toBeVisible();

    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: /using quotefly/i })).toBeVisible();

    await page.goto("/cookies");
    await expect(page.getByRole("heading", { name: /cookies work on quotefly/i })).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: /start free trial/i }).first().click();
    await expect(page.getByRole("dialog", { name: /start free trial/i })).toBeVisible();
  });

  test("signup creates an HttpOnly cookie session, restores on reload, and logs out cleanly", async ({
    context,
    page,
  }) => {
    const label = uniqueRunLabel("ui-auth");

    await page.goto("/");
    await page.getByRole("button", { name: /start free trial/i }).first().click();

    const dialog = page.getByRole("dialog", { name: /start free trial/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Your Name").fill("Beta UI Owner");
    await dialog.getByLabel("Business Name").fill(`QuoteFly UI ${label}`);
    await dialog.getByLabel("Primary Trade").selectOption("ROOFING");
    await dialog.getByLabel("Email Address").fill(`${label}@example.com`);
    await dialog.getByLabel("Password").fill("TestPassword123!");
    await dialog.getByLabel(/I agree to the Terms of Service/i).check();
    await dialog.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/app\/customers/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });
    await expectSessionCookiePresent(context);
    await expectNoFrontendJwtStorage(page);

    await page.reload();
    await expect(page).toHaveURL(/\/app\/customers/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });

    await page.goto("/privacy");
    await expect(page).toHaveURL("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/privacy"].heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await page.getByRole("link", { name: "Dashboard" }).click();

    await page.getByRole("button", { name: /sign out/i }).first().click();
    await expectSessionCookieCleared(context);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: /start free trial/i }).first()).toBeVisible();
  });
});
