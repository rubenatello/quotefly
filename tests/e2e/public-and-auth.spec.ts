import { expect, test } from "@playwright/test";
import {
  expectNoFrontendJwtStorage,
  expectSessionCookieCleared,
  expectSessionCookiePresent,
  uniqueRunLabel,
} from "./helpers";

test.describe("public site and session auth", () => {
  test("public launch pages render and the auth modal opens", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /contractor quoting software/i })).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: /contractor quoting software pricing/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Coming Soon" }).first()).toBeDisabled();

    await page.goto("/support");
    await expect(page.getByRole("heading", { level: 1, name: "Support", exact: true })).toBeVisible();

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
    await dialog.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/app\/customers/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });
    await expectSessionCookiePresent(context);
    await expectNoFrontendJwtStorage(page);

    await page.reload();
    await expect(page).toHaveURL(/\/app\/customers/);
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /sign out/i }).first().click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: /start free trial/i }).first()).toBeVisible();
    await expectSessionCookieCleared(context);
  });
});
