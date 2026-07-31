import { expect, test } from "@playwright/test";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

test("public navigation, services, legal pages, and consent work on mobile", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("qf_cookie_consent"));
  await page.reload();

  const consent = page.getByRole("complementary", { name: "Cookie preferences" });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Essential only" }).click();

  const menuButton = page.locator('button[aria-controls="mobile-primary-navigation"]');
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await page.locator("#mobile-primary-navigation").getByRole("link", { name: "Services", exact: true }).click();

  await expect(page).toHaveURL("/services");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/services"].heading })).toBeVisible();
  await expect(page.getByRole("img", { name: /customer management, estimate building/i })).toBeVisible();

  await page.goto("/solutions");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/solutions"].heading })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Trade solutions" })).toBeVisible();

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/privacy"].heading })).toBeVisible();
  await page.goto("/data-privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/data-privacy"].heading })).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
