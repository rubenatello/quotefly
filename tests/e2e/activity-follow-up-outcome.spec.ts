import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("automatic follow-up tasks require an explicit outcome and cannot be edited, reopened, or removed", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const owner = await signUpViaApi(request, "automatic-follow-up-outcome");
  await addSessionCookie(context, owner);

  const task = {
    id: "11111111-1111-4111-8111-111111111111",
    customerId: "22222222-2222-4222-8222-222222222222",
    quoteId: null,
    assignedTenantUserId: "33333333-3333-4333-8333-333333333333",
    createdByTenantUserId: null,
    completedByTenantUserId: null,
    type: "FOLLOW_UP",
    status: "OPEN",
    priority: "HIGH",
    origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
    followUpOutcome: null,
    followUpSequenceId: "44444444-4444-4444-8444-444444444444",
    followUpStepNumber: 1,
    title: "Review the new customer",
    notes: null,
    dueAtUtc: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customer: { id: "22222222-2222-4222-8222-222222222222", fullName: "Automatic Follow-up Customer" },
    quote: null,
    assignedTenantUser: {
      id: "33333333-3333-4333-8333-333333333333",
      role: "owner",
      user: { id: owner.user.id, fullName: owner.user.fullName, email: owner.user.email },
    },
  };
  let active = true;
  let completeBody: Record<string, unknown> | null = null;

  await page.route("**/v1/activities**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST" && url.pathname === `/v1/activities/${task.id}/complete`) {
      completeBody = route.request().postDataJSON() as Record<string, unknown>;
      active = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          task: {
            ...task,
            status: "COMPLETED",
            followUpOutcome: "NO_RESPONSE",
            completedAtUtc: new Date().toISOString(),
            version: 2,
          },
          duplicate: false,
        }),
      });
      return;
    }
    if (url.pathname === "/v1/activities/summary") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAtUtc: new Date().toISOString(),
          timezone: "America/Los_Angeles",
          windows: {
            todayStartUtc: new Date().toISOString(),
            tomorrowStartUtc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            upcomingEndUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            completedStartUtc: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          },
          counts: { overdue: 0, today: active ? 1 : 0, upcoming: 0, completed: active ? 0 : 1 },
          top: active ? [task] : [],
        }),
      });
      return;
    }
    if (url.pathname === "/v1/activities") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: active ? [task] : [], pagination: { limit: 25, offset: 0, total: active ? 1 : 0 }, scope: { mine: true } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/app/follow-up");
  const row = page.getByRole("region", { name: "My work tasks" }).getByRole("article").filter({ hasText: task.title });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText("Automatic follow-up", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);

  await row.getByRole("button", { name: "Complete", exact: true }).click();
  const outcomeDialog = page.getByRole("dialog", { name: "How did this follow-up go?" });
  await expect(outcomeDialog).toBeVisible();
  await expect(outcomeDialog).toContainText("Automatic Follow-up Customer");
  await outcomeDialog.getByRole("button", { name: /No response/ }).click();

  await expect(page.getByText("Follow-up attempt recorded", { exact: true })).toBeVisible();
  expect(completeBody).toEqual({ version: 1, outcome: "NO_RESPONSE" });
  await expect(row).toBeHidden();
});
