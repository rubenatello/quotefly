import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

async function expectNoSeriousAccessibilityViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).flatMap((node) => node.target),
    }));
  expect(blocking, `${label} has serious or critical accessibility violations`).toEqual([]);
}

test("core workspace routes have no serious accessibility violations", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const account = await signUpViaApi(request, "accessibility-core");
  const customer = await createCustomerViaApi(request, account, { fullName: "Accessible Customer" });
  const quote = await createQuoteViaApi(request, account, customer.id, { title: "Accessible Quote" });
  await addSessionCookie(context, account);

  const routes: Array<{ path: string; ready: () => ReturnType<Page["locator"]> }> = [
    { path: "/app", ready: () => page.getByTestId("workspace-home") },
    { path: "/app/customers", ready: () => page.getByText("Accessible Customer").filter({ visible: true }).first() },
    { path: "/app/quotes", ready: () => page.getByText("Accessible Quote").filter({ visible: true }).first() },
    { path: "/app/products", ready: () => page.getByRole("button", { name: /add product/i }).first() },
    { path: "/app/follow-up", ready: () => page.getByTestId("follow-up-metrics") },
    { path: "/app/analytics", ready: () => page.getByRole("heading", { name: "Analytics", exact: true }) },
    { path: "/app/settings", ready: () => page.getByTestId("theme-option-system") },
    { path: "/app/branding", ready: () => page.getByRole("heading", { name: "Build your quote look in three steps" }) },
    { path: "/app/build", ready: () => page.getByTestId("quote-builder") },
    { path: `/app/quotes/${quote.id}`, ready: () => page.getByTestId("quote-desk") },
  ];

  const selectedRoutes = process.env.E2E_A11Y_PATH
    ? routes.filter((route) => route.path === process.env.E2E_A11Y_PATH)
    : routes;
  expect(selectedRoutes.length, "E2E_A11Y_PATH must match a configured accessibility route").toBeGreaterThan(0);
  for (const route of selectedRoutes) {
    await page.goto(route.path);
    await expect(route.ready()).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousAccessibilityViolations(page, route.path);
  }
});

test("dark mobile Kody panel is readable and accessible without page overflow", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "accessibility-kody");
  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  await expect(panel).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAccessibilityViolations(page, "dark mobile Kody panel");
});

test("dashboard Kody triggers stay distinct, legible, and visually prominent", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "accessibility-kody-dashboard");
  await addSessionCookie(context, account);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 30_000 });

  const dashboardAction = page.getByRole("button", { name: "Plan with Kody", exact: true });
  await expect(dashboardAction).toBeVisible();
  await expect(dashboardAction).toHaveCSS("background-color", "rgb(11, 18, 32)");
  await expect(dashboardAction).toHaveCSS("color", "rgb(248, 250, 252)");

  const actionMascot = dashboardAction.locator('img[src="/images/kody/kody-ai.png"]');
  await expect(actionMascot).toBeVisible();
  expect((await actionMascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(22);

  const launcher = page.getByTestId("kody-launcher");
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveCSS("background-color", "rgb(11, 18, 32)");
  await expect(launcher).toHaveCSS("color", "rgb(248, 250, 252)");
  expect((await launcher.locator('img[src="/images/kody/kody-ai.png"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(34);
});
