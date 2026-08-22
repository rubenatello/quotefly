import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

type JobPayload = {
  job: {
    id: string;
    version: number;
    assignedTenantUserId: string | null;
    accessInstructions: string | null;
    jobNumber: number;
  };
};

async function getJob(request: APIRequestContext, cookieHeader: string, jobId: string) {
  const response = await request.get(`${apiBaseUrl}/v1/jobs/${jobId}`, {
    headers: { Cookie: cookieHeader },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as JobPayload;
}

test("accepted quotes create manageable jobs with mobile-safe assignment and member visibility", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));

  const owner = await signUpViaApi(request, "jobs-e2e");
  const member = await addWorkspaceMemberViaApi(request, owner, "Jobs Field Member");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Jobs Workflow Customer",
    phone: "555-014-7711",
    email: "jobs-workflow@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Jobs Workflow Roof Repair",
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Accept quote & create job", exact: true }).click();

  const jobReady = page.getByRole("status").filter({ hasText: /Job #\d+ is ready from this accepted quote\./ });
  await expect(jobReady).toBeVisible({ timeout: 20_000 });
  await jobReady.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/jobs\/[^/?#]+$/);
  const jobId = page.url().match(/\/app\/jobs\/([^/?#]+)/)?.[1];
  expect(jobId).toBeTruthy();

  const customerAssignment = await request.patch(`${apiBaseUrl}/v1/customers/${customer.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(customerAssignment.status()).toBe(200);
  const quoteAssignment = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(quoteAssignment.status()).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/jobs");
  await expect(page.getByText("Job list", { exact: true })).toBeVisible({ timeout: 20_000 });
  const jobCard = page.getByRole("article").filter({ hasText: "Jobs Workflow Roof Repair" });
  await expect(jobCard).toBeVisible();
  await jobCard.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page.getByText("Job #1", { exact: true })).toBeVisible();

  const assigneeSelect = page.getByLabel("Assignee", { exact: true });
  await expect(assigneeSelect).toContainText("Jobs Field Member");
  await assigneeSelect.selectOption(member.membershipId);
  await expect(page.getByText("Access instructions", { exact: true }).last()).toBeVisible();
  const instructions = () => page.locator("main textarea").last();
  await instructions().fill("Gate code 4321. Park on the right side of the driveway.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();

  await expect
    .poll(async () => (await getJob(request, owner.cookieHeader, jobId!)).job.assignedTenantUserId)
    .toBe(member.membershipId);

  const savedJob = (await getJob(request, owner.cookieHeader, jobId!)).job;
  const externalUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${jobId}`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      version: savedJob.version,
      accessInstructions: "Server latest instruction for stale reload.",
    },
  });
  expect(externalUpdate.status()).toBe(200);

  await instructions().fill("Local stale instruction that should not save.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload latest job", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest job", exact: true }).click();
  await expect(instructions()).toHaveValue("Server latest instruction for stale reload.");
  await instructions().fill("Final saved instruction after stale reload.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect
    .poll(async () => (await getJob(request, owner.cookieHeader, jobId!)).job.accessInstructions)
    .toBe("Final saved instruction after stale reload.");

  await expect(page.getByText("Schedule and dispatch", { exact: true })).toBeVisible();
  await page.getByLabel("Start time", { exact: true }).fill("2026-08-24T09:00");
  await page.getByLabel("End time", { exact: true }).fill("2026-08-24T11:00");
  await page.getByLabel("Booking instructions", { exact: true }).fill("Crew arrival window confirmed with customer.");
  await page.getByRole("button", { name: "Create booking", exact: true }).click();
  await expect(page.getByText("Booking saved.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Crew arrival window confirmed with customer.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(page.getByText("Dispatched", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("Note", { exact: true }).fill("Crew has materials staged and customer confirmed gate access.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByText("Note added.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Crew has materials staged and customer confirmed gate access.", { exact: true })).toBeVisible();

  const main = page.locator("main");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  for (const button of await main.getByRole("button").all()) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect((await assigneeSelect.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  let failDetailOnce = true;
  await page.route(`${apiBaseUrl}/v1/jobs/${jobId}`, async (route) => {
    if (!failDetailOnce) {
      await route.continue();
      return;
    }
    failDetailOnce = false;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Injected job detail failure" }),
    });
  });
  await page.goto(`/app/jobs/${jobId}`);
  await expect(page.getByText("Job could not be loaded.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.unroute(`${apiBaseUrl}/v1/jobs/${jobId}`);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await context.clearCookies();
  await addSessionCookie(context, member);
  await page.goto("/app/jobs");
  const memberJobCard = page.getByRole("article").filter({ hasText: "Jobs Workflow Roof Repair" });
  await expect(memberJobCard).toBeVisible({ timeout: 20_000 });
  await memberJobCard.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();
  await expect(page.getByText("Manage assignment", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save job", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Assignee", { exact: true })).toHaveCount(0);
});
