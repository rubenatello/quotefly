import { expect, test } from "@playwright/test";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

test("public navigation, services, legal pages, and consent work on mobile", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("qf_cookie_consent"));
  await page.reload();

  const consent = page.getByRole("complementary", { name: "Cookie preferences" });
  await expect(consent).toBeVisible();
  const essentialButtonBox = await consent.getByRole("button", { name: "Essential only" }).boundingBox();
  const analyticsButtonBox = await consent.getByRole("button", { name: "Accept analytics" }).boundingBox();
  expect(Math.abs((essentialButtonBox?.y ?? 0) - (analyticsButtonBox?.y ?? 0))).toBeLessThanOrEqual(2);
  await consent.getByRole("button", { name: "Essential only" }).click();

  const demoView = page.getByRole("group", { name: "Quote demo view" });
  await demoView.scrollIntoViewIfNeeded();
  await demoView.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("Quote preview", { exact: true })).toBeVisible();
  await demoView.getByRole("button", { name: "Edit quote", exact: true }).click();
  await expect(page.getByText("Editable quote sheet", { exact: true })).toBeVisible();

  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(landingOverflow).toBeLessThanOrEqual(1);

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
  await expect(page.getByRole("img", { name: /residential construction worker framing/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /quoting headaches do not/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "HVAC", exact: true })).toBeVisible();

  const fieldImage = page.getByRole("img", { name: /contractor inspecting field equipment/i });
  await fieldImage.scrollIntoViewIfNeeded();
  await expect(fieldImage).toBeVisible();
  expect(await fieldImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1600);
  await expect(page.getByRole("img", { name: /carpenter measuring and marking/i })).toBeVisible();

  const solutionsOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(solutionsOverflow).toBeLessThanOrEqual(1);

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/privacy"].heading })).toBeVisible();
  await page.goto("/data-privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/data-privacy"].heading })).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
