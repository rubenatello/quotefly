import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { addSessionCookie, createCustomerViaApi, signUpViaApi } from "./helpers";

const captureDirectory = process.env.E2E_THEME_CAPTURE_DIR
  ? resolve(process.env.E2E_THEME_CAPTURE_DIR)
  : null;

const KODY_QUICK_PROMPT_TEST_IDS = [
  "kody-quick-prioritize_my_day",
  "kody-quick-list_my_activities",
  "kody-quick-draft_customer",
  "kody-quick-draft_quote",
  "kody-quick-prepare_quote_send",
  "kody-quick-draft_product",
  "kody-quick-search_customers",
  "kody-quick-search_products",
  "kody-quick-summarize_pipeline",
  "kody-quick-follow_up_queue",
  "kody-quick-rank_profitable_jobs",
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

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

async function expectKodyShell(page: Page, panel: Locator) {
  const header = panel.getByTestId("kody-header");
  await expect(header).toBeVisible();
  await expectReadableControl(header);
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  for (const button of await header.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
}

async function expectKodyPromptLabels(panel: Locator) {
  const prompts = panel.getByTestId("kody-quick-prompts");
  await prompts.locator(":scope > summary").click();
  const morePrompts = prompts.locator("details");
  await morePrompts.locator(":scope > summary").click();
  const buttons = prompts.locator('button[data-testid^="kody-quick-"]');
  await expect(buttons).toHaveCount(KODY_QUICK_PROMPT_TEST_IDS.length);
  for (const testId of KODY_QUICK_PROMPT_TEST_IDS) {
    await expect(panel.getByTestId(testId)).toHaveCount(1);
  }
  for (const button of await buttons.all()) {
    await expect(button).toBeVisible();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await prompts.locator(":scope > summary").click();
}

async function expectQuoteFlyOrangePalette(page: Page) {
  const colors = await page.evaluate(() => {
    const rootStyles = getComputedStyle(document.documentElement);
    const resolvePair = (foreground: string, background: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${foreground})`;
      probe.style.backgroundColor = `var(${background})`;
      document.body.appendChild(probe);
      const styles = getComputedStyle(probe);
      const pair = { foreground: styles.color, background: styles.backgroundColor };
      probe.remove();
      return pair;
    };

    return {
      brandOrange: rootStyles.getPropertyValue("--qf-brand-orange").trim().toLowerCase(),
      action: resolvePair("--qf-action-secondary-text", "--qf-action-secondary"),
      actionHover: resolvePair("--qf-action-secondary-text", "--qf-action-secondary-hover"),
      actionActive: resolvePair("--qf-action-secondary-text", "--qf-action-secondary-active"),
      accentText: resolvePair("--qf-brand-orange-text", "--qf-panel"),
    };
  });

  expect(colors.brandOrange).toBe("#f96928");
  expect(contrastRatio(colors.action.foreground, colors.action.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.actionHover.foreground, colors.actionHover.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.actionActive.foreground, colors.actionActive.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.accentText.foreground, colors.accentText.background)).toBeGreaterThanOrEqual(4.5);
}

test("workspace controls remain readable in light and dark themes", async ({ context, page, request }) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "theme-mobile");
  await createCustomerViaApi(request, account, {
    fullName: "Theme Check Customer",
    phone: "555-013-8811",
    email: "theme-check@example.com",
  });
  await addSessionCookie(context, account);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/customers");
  const customerPageHeading = page.getByRole("heading", { level: 1, name: "Customers", exact: true });
  await expect(customerPageHeading).toBeVisible({ timeout: 20_000 });
  await expect(customerPageHeading).toHaveClass(/sr-only/);
  await expect(page.locator("main h1")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  const addCustomer = page.getByRole("button", { name: "Add customer", exact: true }).first();
  await expectReadableControl(addCustomer);
  await expectQuoteFlyOrangePalette(page);
  await captureThemeScreenshot(page, "light-mobile-customers");

  const lightKodyLauncher = page.getByTestId("kody-launcher");
  await lightKodyLauncher.click();
  const lightKodyPanel = page.getByTestId("kody-chat-panel");
  await expectKodyShell(page, lightKodyPanel);
  await captureThemeScreenshot(page, "light-mobile-kody", false);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectKodyShell(page, lightKodyPanel);
  await captureThemeScreenshot(page, "light-compact-kody", false);
  await page.setViewportSize({ width: 320, height: 800 });
  await expectKodyShell(page, lightKodyPanel);
  await expectKodyPromptLabels(lightKodyPanel);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expectKodyShell(page, lightKodyPanel);
  await captureThemeScreenshot(page, "light-tablet-kody", false);
  await lightKodyPanel.getByRole("button", { name: "Close Kody" }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Theme Check Customer").filter({ visible: true })).toBeVisible();
  await expectReadableControl(addCustomer);
  await expectQuoteFlyOrangePalette(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await captureThemeScreenshot(page, "dark-mobile-customers");

  const kodyLauncher = page.getByTestId("kody-launcher");
  await expectReadableControl(kodyLauncher);
  await kodyLauncher.click();
  const kodyPanel = page.getByTestId("kody-chat-panel");
  await expect(kodyPanel).toBeVisible();
  await expectKodyShell(page, kodyPanel);
  await expect(kodyLauncher).toHaveCount(0);
  const quickPrompts = kodyPanel.getByTestId("kody-quick-prompts");
  await quickPrompts.locator(":scope > summary").click();
  const draftQuoteQuickAction = kodyPanel.getByTestId("kody-quick-draft_quote");
  await expect(draftQuoteQuickAction).toHaveCount(1);
  await expect(kodyPanel.getByText("Draft a quote from job notes", { exact: true })).toHaveCount(0);
  await expectReadableControl(draftQuoteQuickAction);
  await draftQuoteQuickAction.click();
  await expect.poll(() => quickPrompts.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expectReadableControl(kodyPanel.getByTestId("kody-prompt"));
  await expectReadableControl(kodyPanel.getByRole("button", { name: "Send", exact: true }));
  await captureThemeScreenshot(page, "dark-mobile-kody", false);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectKodyShell(page, kodyPanel);
  await captureThemeScreenshot(page, "dark-compact-kody", false);
  await page.setViewportSize({ width: 320, height: 800 });
  await expectKodyShell(page, kodyPanel);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expectKodyShell(page, kodyPanel);
  await captureThemeScreenshot(page, "dark-tablet-kody", false);
  await kodyPanel.getByRole("button", { name: "Close Kody" }).click();
  await expect(kodyLauncher).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toHaveClass(/sr-only/);
  await expect(page.locator("main h1")).toHaveCount(0);
  await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("aria-pressed", "true");
  await expectReadableControl(page.getByTestId("theme-option-dark"));
  await captureThemeScreenshot(page, "dark-mobile-settings");
  await page.getByTestId("theme-option-dark").scrollIntoViewIfNeeded();
  await captureThemeScreenshot(page, "dark-mobile-settings-appearance", false);

  await page.goto("/app/settings/users");
  await expect(page.getByText(/seat allowance/i).first()).toBeVisible();
  await expect(page.getByText(/of \d+ seats in use/i).first()).toBeVisible();
  const roleGuide = page.locator("details").filter({ hasText: "Compare role permissions" });
  await expect(roleGuide).toBeVisible();
  await expect.poll(() => roleGuide.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await roleGuide.locator("summary").click();
  await expect.poll(() => roleGuide.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await expect(roleGuide.getByText("Member", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await captureThemeScreenshot(page, "dark-mobile-team");

  await page.goto("/app/branding");
  await expect(page.getByRole("heading", { name: "Build your quote look in three steps" })).toBeVisible();
  const quotePresetButtons = page.getByRole("button", { name: /Use .* quote preset/ });
  await expect(quotePresetButtons).toHaveCount(3);
  for (const presetButton of await quotePresetButtons.all()) {
    expect((await presetButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await quotePresetButtons.nth(1).click();
  await expect(quotePresetButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save brand", exact: true }).click();
  await expect(page.getByRole("button", { name: "Brand saved", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await captureThemeScreenshot(page, "dark-mobile-branding");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
  await expectReadableControl(page.getByRole("button", { name: "Add customer", exact: true }).first());
  await captureThemeScreenshot(page, "dark-desktop-customers");
  await page.getByTestId("kody-launcher").click();
  await expectKodyShell(page, page.getByTestId("kody-chat-panel"));
  await captureThemeScreenshot(page, "dark-desktop-kody", false);
  await page.getByTestId("kody-chat-panel").getByRole("button", { name: "Close Kody" }).click();

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectReadableControl(page.getByRole("button", { name: "Add customer", exact: true }).first());
  await captureThemeScreenshot(page, "light-desktop-customers");
  await page.getByTestId("kody-launcher").click();
  await expectKodyShell(page, page.getByTestId("kody-chat-panel"));
  await captureThemeScreenshot(page, "light-desktop-kody", false);
});
