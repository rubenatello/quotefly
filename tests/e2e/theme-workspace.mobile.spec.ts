import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { addSessionCookie, createCustomerViaApi, signUpViaApi } from "./helpers";

const captureDirectory = process.env.E2E_THEME_CAPTURE_DIR
  ? resolve(process.env.E2E_THEME_CAPTURE_DIR)
  : null;

async function captureThemeScreenshot(page: Page, name: string, fullPage = true) {
  if (!captureDirectory) return;
  mkdirSync(captureDirectory, { recursive: true });
  await page.screenshot({ path: resolve(captureDirectory, `${name}.png`), fullPage });
}

function parseRgb(value: string) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${value}.`);
  return channels;
}

function luminanceChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (value: string) => {
    const [red, green, blue] = parseRgb(value).map(luminanceChannel);
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectReadableControl(locator: Locator, minimum = 4.5) {
  const colors = await locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return { foreground: styles.color, background: styles.backgroundColor };
  });
  expect(
    contrastRatio(colors.foreground, colors.background),
    `${colors.foreground} should remain readable on ${colors.background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

test("workspace controls remain readable in light and dark themes", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "theme-mobile");
  await createCustomerViaApi(request, account, {
    fullName: "Theme Check Customer",
    phone: "555-013-8811",
    email: "theme-check@example.com",
  });
  await addSessionCookie(context, account);

  await page.goto("/app/customers");
  const customerPageHeading = page.getByRole("heading", { level: 1, name: "Customers", exact: true });
  await expect(customerPageHeading).toBeVisible({ timeout: 20_000 });
  await expect(customerPageHeading).toHaveClass(/sr-only/);
  await expect(page.locator("main h1")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  const addCustomer = page.getByRole("button", { name: "Add customer", exact: true }).first();
  await expectReadableControl(addCustomer);
  await captureThemeScreenshot(page, "light-mobile-customers");

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Theme Check Customer").filter({ visible: true })).toBeVisible();
  await expectReadableControl(addCustomer);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await captureThemeScreenshot(page, "dark-mobile-customers");

  const kodyLauncher = page.getByTestId("kody-launcher");
  await expectReadableControl(kodyLauncher);
  await kodyLauncher.click();
  const kodyPanel = page.getByTestId("kody-chat-panel");
  await expect(kodyPanel).toBeVisible();
  await expect(kodyLauncher).toHaveCount(0);
  const draftQuoteQuickAction = kodyPanel.getByTestId("kody-quick-draft_quote");
  await expect(draftQuoteQuickAction).toHaveCount(1);
  await expect(kodyPanel.getByText("Draft a quote from job notes", { exact: true })).toHaveCount(0);
  await expectReadableControl(draftQuoteQuickAction);
  await expectReadableControl(kodyPanel.getByTestId("kody-prompt"));
  await captureThemeScreenshot(page, "dark-mobile-kody", false);
  await kodyPanel.getByRole("button", { name: "Close Kody" }).click();
  await expect(kodyLauncher).toBeVisible();

  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toHaveClass(/sr-only/);
  await expect(page.locator("main h1")).toHaveCount(0);
  await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("aria-pressed", "true");
  await expectReadableControl(page.getByTestId("theme-option-dark"));
  await captureThemeScreenshot(page, "dark-mobile-settings");
  await page.getByTestId("theme-option-dark").scrollIntoViewIfNeeded();
  await captureThemeScreenshot(page, "dark-mobile-settings-appearance", false);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
  await expectReadableControl(page.getByRole("button", { name: "Add customer", exact: true }).first());
  await captureThemeScreenshot(page, "dark-desktop-customers");

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectReadableControl(page.getByRole("button", { name: "Add customer", exact: true }).first());
  await captureThemeScreenshot(page, "light-desktop-customers");
});
