import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

const desktopViewports = [
  { name: "desktop-1280", width: 1280, height: 900 },
  { name: "ultrawide-2560", width: 2560, height: 1080 },
  { name: "ultrawide-3397", width: 3397, height: 1335 },
] as const;

test("workspace fills standard and ultrawide viewports while preserving the mobile layout", async ({
  context,
  page,
  request,
}) => {
  const captureDirectory = process.env.E2E_CAPTURE_DIR;
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });

  const account = await signUpViaApi(request, "workspace-responsive");
  const customer = await createCustomerViaApi(request, account, { fullName: "Responsive Workspace Customer" });
  const quote = await createQuoteViaApi(request, account, customer.id, { title: "Responsive Workspace Quote" });
  await addSessionCookie(context, account);

  for (const viewport of desktopViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/app");
    await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });

    const geometry = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".qf-workspace-shell-grid");
      const sidebar = document.querySelector<HTMLElement>("[data-testid='workspace-sidebar']");
      const main = document.querySelector<HTMLElement>(".qf-workspace-main");
      const content = main?.firstElementChild as HTMLElement | null;
      const dashboard = document.querySelector<HTMLElement>("[data-testid='workspace-home']");
      if (!shell || !sidebar || !main || !content || !dashboard) throw new Error("Workspace geometry was unavailable.");

      const shellRect = shell.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const dashboardRect = dashboard.getBoundingClientRect();

      return {
        viewportWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellLeft: shellRect.left,
        shellRight: shellRect.right,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        contentLeft: contentRect.left,
        contentRight: contentRect.right,
        contentWidth: contentRect.width,
        dashboardWidth: dashboardRect.width,
      };
    });

    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.shellLeft).toBeLessThanOrEqual(1);
    expect(geometry.shellRight).toBeGreaterThanOrEqual(geometry.viewportWidth - 1);
    expect(geometry.sidebarLeft).toBeLessThanOrEqual(1);
    expect(geometry.mainLeft).toBeGreaterThanOrEqual(geometry.sidebarRight - 1);
    expect(geometry.mainRight).toBeGreaterThanOrEqual(geometry.viewportWidth - 1);
    expect(geometry.contentLeft).toBeGreaterThan(geometry.mainLeft);
    expect(geometry.contentRight).toBeLessThan(geometry.mainRight);
    expect(geometry.dashboardWidth).toBeGreaterThanOrEqual(geometry.contentWidth - 1);

    if (viewport.width >= 2560) {
      const availableWorkspaceWidth = geometry.viewportWidth - geometry.sidebarRight;
      expect(geometry.dashboardWidth / availableWorkspaceWidth).toBeGreaterThan(0.94);
    }

    if (captureDirectory) {
      await page.screenshot({
        path: path.join(captureDirectory, `workspace-${viewport.name}.png`),
        fullPage: true,
      });
    }
  }

  await page.goto("/app/quotes");
  await expect(page.getByText(quote.title, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const quoteBoardGeometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".qf-workspace-main > div");
    const quotePage = document.querySelector<HTMLElement>(".qf-workspace-main > div > .space-y-5");
    if (!content || !quotePage) throw new Error("Quote board geometry was unavailable.");
    const contentRect = content.getBoundingClientRect();
    const quotePageRect = quotePage.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      contentWidth: contentRect.width,
      quotePageWidth: quotePageRect.width,
    };
  });
  expect(quoteBoardGeometry.overflow).toBeLessThanOrEqual(1);
  expect(quoteBoardGeometry.quotePageWidth).toBeGreaterThanOrEqual(quoteBoardGeometry.contentWidth - 1);
  if (captureDirectory) {
    await page.screenshot({
      path: path.join(captureDirectory, "workspace-quotes-ultrawide-3397.png"),
      fullPage: true,
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  const openNavigationBox = await openNavigation.boundingBox();
  expect(openNavigationBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(openNavigationBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await openNavigation.click();
  const navigationDialog = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(navigationDialog).toBeVisible();
  await expect(navigationDialog.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(navigationDialog).toBeHidden();
  await expect(openNavigation).toBeFocused();

  if (captureDirectory) {
    await page.screenshot({
      path: path.join(captureDirectory, "workspace-mobile-390.png"),
      fullPage: true,
    });
  }
});
