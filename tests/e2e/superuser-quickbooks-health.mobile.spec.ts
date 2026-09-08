import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";
import { quickBooksHealthFixture } from "./quickbooks-health-fixture";

test("QuickBooks integration health remains usable without horizontal overflow on mobile", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "qbo-health-mobile", "superuser-e2e@example.com");
  await addSessionCookie(context, account);
  await page.route("**/v1/internal/control-plane/quickbooks-health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quickBooksHealthFixture()) });
  });

  await page.goto("/app/internal/admin");
  const panel = page.getByTestId("quickbooks-integration-health");
  await expect(panel.getByText("OAuth connection checks are clear", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole("heading", { name: "External alert readiness" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Operational queues" })).toBeVisible();

  const refresh = panel.getByRole("button", { name: "Refresh health", exact: true });
  expect((await refresh.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(panel.getByText("OAuth connection checks are clear", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="quickbooks-integration-health"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = accessibility.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({ id: violation.id, impact: violation.impact }));
  expect(blocking).toEqual([]);
});
