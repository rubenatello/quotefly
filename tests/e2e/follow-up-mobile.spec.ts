import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test("closed work uses authoritative Job status and navigation without mutating the quote", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "follow-up-job-authority");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Authoritative Job Customer",
    phone: "555-014-2213",
    email: "authoritative-job@example.com",
  });
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "Authoritative Job Roof Repair",
  });
  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 20_000 });
  const [acceptedResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/v1/quotes/${quote.id}`),
    page.getByRole("button", { name: "Accept quote & create job", exact: true }).click(),
  ]);
  expect(acceptedResponse.status()).toBe(200);
  expect(acceptedResponse.request().postDataJSON()).not.toHaveProperty("jobStatus");
  const acceptedPayload = (await acceptedResponse.json()) as { job: { id: string; jobNumber: number } };

  const quoteMutationBodies: unknown[] = [];
  const preNavigationJobRequests: string[] = [];
  page.on("request", (browserRequest) => {
    const pathname = new URL(browserRequest.url()).pathname;
    if (browserRequest.method() === "PATCH" && pathname === `/v1/quotes/${quote.id}`) {
      quoteMutationBodies.push(browserRequest.postDataJSON());
    }
    if (pathname.startsWith("/v1/jobs")) preNavigationJobRequests.push(pathname);
  });

  await page.goto("/app/follow-up");
  await expect(page.getByRole("heading", { level: 1, name: "Activity", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();
  await page.getByTestId("follow-up-queue-tabs").getByRole("button", { name: /Closed/ }).click();

  const row = page.getByTestId("follow-up-queue-row").filter({ hasText: customer.fullName });
  await expect(row).toBeVisible();
  await expect(row.getByText("Unscheduled", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(row.getByLabel(`Update job stage for ${customer.fullName}`)).toHaveCount(0);
  const openJob = row.getByRole("button", { name: `Open job ${acceptedPayload.job.jobNumber}`, exact: true });
  await expect(openJob).toBeVisible();
  expect((await openJob.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(preNavigationJobRequests).toEqual([]);
  expect(quoteMutationBodies).toEqual([]);

  await openJob.click();
  await expect(page).toHaveURL(`/app/jobs/${acceptedPayload.job.id}`);
  expect(quoteMutationBodies).toEqual([]);
});

test("closed work exposes a truthful disabled fallback when its Job projection is unavailable", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "follow-up-job-unavailable");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Unavailable Job Customer",
    phone: "555-014-2214",
    email: "unavailable-job@example.com",
  });
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "Unavailable Job Projection",
  });
  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept quote & create job", exact: true }).click();
  await expect(page.getByText(/Job #\d+ is ready/).filter({ visible: true })).toBeVisible();

  await page.route("**/v1/workspace/follow-up?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("queue") !== "closed") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as { items?: Array<{ customerId?: string; job?: unknown }> };
    for (const item of body.items ?? []) {
      if (item.customerId === customer.id) delete item.job;
    }
    await route.fulfill({ response, json: body });
  });

  const quoteMutations: string[] = [];
  page.on("request", (browserRequest) => {
    const pathname = new URL(browserRequest.url()).pathname;
    if (browserRequest.method() === "PATCH" && pathname === `/v1/quotes/${quote.id}`) {
      quoteMutations.push(pathname);
    }
  });

  await page.goto("/app/follow-up");
  await expect(page.getByRole("heading", { level: 1, name: "Activity", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();
  const closedTab = page.getByTestId("follow-up-queue-tabs").getByRole("button", { name: /Closed/ });
  await closedTab.focus();
  await expect(closedTab).toBeFocused();
  await closedTab.press("Enter");

  const row = page.getByTestId("follow-up-queue-row").filter({ hasText: customer.fullName });
  await expect(row).toBeVisible();
  const unavailable = row.getByRole("button", { name: "Job unavailable", exact: true });
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toBeDisabled();
  await expect(page).toHaveURL("/app/follow-up");
  expect(quoteMutations).toEqual([]);
});

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
