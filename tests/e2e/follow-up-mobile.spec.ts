import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test("activity queue stays readable and actionable at phone width", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "follow-up-mobile");
  const unquotedCustomer = await createCustomerViaApi(request, account, {
    fullName: "Mobile Garden Lead",
    phone: "555-014-2211",
    email: "mobile-garden-lead@example.com",
  });
  const quotedCustomer = await createCustomerViaApi(request, account, {
    fullName: "Mobile Fence Customer",
    phone: "555-014-2212",
    email: "mobile-fence-customer@example.com",
  });
  await createQuoteViaApi(request, account, quotedCustomer.id, {
    title: "Backyard Fence Draft",
  });
  await addSessionCookie(context, account);

  await page.goto("/app/follow-up");
  await expect(page.getByRole("heading", { level: 1, name: "Activity", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "My work tasks" })).toBeVisible();
  await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();

  const metrics = page.getByTestId("follow-up-metric");
  await expect(metrics).toHaveCount(4);
  const metricBoxes = await metrics.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(Math.abs(metricBoxes[0].y - metricBoxes[1].y)).toBeLessThanOrEqual(1);
  expect(metricBoxes[1].x).toBeGreaterThan(metricBoxes[0].x);
  expect(metricBoxes[2].y).toBeGreaterThan(metricBoxes[0].y);

  const tabs = page.getByTestId("follow-up-queue-tabs");
  await expect(tabs.getByRole("button")).toHaveCount(5);
  await expect.poll(() => tabs.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  for (const tab of await tabs.getByRole("button").all()) {
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  const queue = page.getByTestId("follow-up-queue");
  await expect(queue.getByText(unquotedCustomer.fullName, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(queue.getByText(quotedCustomer.fullName, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(queue.getByRole("link", { name: `Call ${unquotedCustomer.fullName}` })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Draft first quote", exact: true })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Open quote", exact: true })).toBeVisible();
  await queue.getByTestId("follow-up-queue-row").filter({ hasText: unquotedCustomer.fullName }).getByText("Details and status", { exact: true }).click();
  await expect(queue.getByLabel(`Update follow-up for ${unquotedCustomer.fullName}`).filter({ visible: true })).toBeVisible();
  await expect.poll(() => queue.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  const captureDirectory = process.env.E2E_FOLLOW_UP_CAPTURE_DIR;
  if (captureDirectory) {
    await mkdir(resolve(captureDirectory), { recursive: true });
    await page.screenshot({ path: resolve(captureDirectory, "follow-up-mobile-light.png"), fullPage: true });
  }

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();
  await expect(queue.getByText(unquotedCustomer.fullName, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  if (captureDirectory) {
    await page.screenshot({ path: resolve(captureDirectory, "follow-up-mobile-dark.png"), fullPage: true });
  }
});
