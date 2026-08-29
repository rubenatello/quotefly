import { expect, test } from "@playwright/test";
import { addSessionCookie, addWorkspaceMemberViaApi, signUpViaApi } from "./helpers";

const settingsPath = "/v1/follow-up-settings";

function followUpSettings(version = 3) {
  return {
    followUpSettings: {
      enabled: true,
      version,
      updatedAtUtc: "2026-08-28T17:00:00.000Z",
      steps: [
        { stepNumber: 1, delayMinutes: 15, title: "Review the new customer", notes: null, priority: "HIGH" },
        { stepNumber: 2, delayMinutes: 1440, title: "Check in after one day", notes: null, priority: "NORMAL" },
        { stepNumber: 3, delayMinutes: 4320, title: "Make the three-day follow-up", notes: null, priority: "NORMAL" },
      ],
    },
  };
}

test("owners edit and save a friendly automatic follow-up cadence with ordered versioned steps", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "follow-up-settings-owner");
  await addSessionCookie(context, owner);

  let current = followUpSettings();
  let savedBody: Record<string, unknown> | null = null;
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "PATCH") {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      const body = savedBody as {
        enabled: boolean;
        steps: Array<{ stepNumber: number; delayMinutes: number; title: string; notes: string | null; priority: string }>;
      };
      current = {
        followUpSettings: {
          enabled: body.enabled,
          version: 4,
          updatedAtUtc: "2026-08-28T18:00:00.000Z",
          steps: body.steps,
        },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) });
  });

  await page.goto("/app/settings?section=follow-up");
  const settingsNav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(settingsNav.getByRole("button", { name: "Follow-up" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Automatic follow-up" })).toBeVisible();
  await expect(page.getByText("15 minutes · 1 day · 3 days", { exact: true })).toBeVisible();
  await expect(page.getByText(/Changes apply only to customers added after you save/)).toBeVisible();

  await page.getByText("Edit schedule steps", { exact: true }).click();
  const taskTitles = page.getByLabel("Task title");
  await expect(taskTitles).toHaveCount(3);
  await expect(page.getByLabel("Time after intake").nth(1)).toHaveValue("1");
  await expect(page.getByLabel("Unit").nth(1)).toHaveValue("days");

  await taskTitles.nth(1).fill("Call after the first day");
  await page.getByRole("button", { name: "Move step 2 earlier" }).click();
  await expect(taskTitles.first()).toHaveValue("Call after the first day");
  await expect(page.getByLabel("Time after intake").first()).toHaveValue("15");
  await expect(page.getByLabel("Unit").first()).toHaveValue("minutes");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();

  await settingsNav.getByRole("button", { name: "General" }).click();
  const leaveDialog = page.getByRole("dialog", { name: "Discard unsaved follow-up changes?" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/section=follow-up/);
  await expect(taskTitles.first()).toHaveValue("Call after the first day");

  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText(/Automatic follow-up settings saved/)).toBeVisible();
  expect(savedBody).toMatchObject({
    version: 3,
    enabled: true,
    steps: [
      { stepNumber: 1, delayMinutes: 15, title: "Call after the first day", priority: "NORMAL" },
      { stepNumber: 2, delayMinutes: 1440, title: "Review the new customer", priority: "HIGH" },
      { stepNumber: 3, delayMinutes: 4320 },
    ],
  });
});

test("stale settings preserve local edits until the owner explicitly reloads", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "follow-up-settings-stale");
  await addSessionCookie(context, owner);

  let getVersion = 3;
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "PATCH") {
      getVersion = 4;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "conflict", code: "FOLLOW_UP_SETTINGS_STALE_VERSION", currentVersion: 4 }),
      });
      return;
    }
    const response = followUpSettings(getVersion);
    if (getVersion === 4) response.followUpSettings.steps[0]!.title = "Latest server follow-up";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });

  await page.goto("/app/settings?section=follow-up");
  await page.getByText("Edit schedule steps", { exact: true }).click();
  const firstTitle = page.getByLabel("Task title").first();
  await firstTitle.fill("My local follow-up edit");
  await page.getByRole("button", { name: "Save schedule" }).click();

  await expect(page.getByText(/Someone updated this schedule after you opened it/)).toBeVisible();
  await expect(firstTitle).toHaveValue("My local follow-up edit");
  await page.getByRole("button", { name: "Reload latest settings" }).click();
  await expect(firstTitle).toHaveValue("Latest server follow-up");
});

test("members can review the schedule but cannot change it", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "follow-up-settings-member");
  const member = await addWorkspaceMemberViaApi(request, owner, "Follow-up Read-only Member");
  await addSessionCookie(context, member);

  let patchRequests = 0;
  await page.route(`**${settingsPath}`, async (route) => {
    if (route.request().method() === "PATCH") patchRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(followUpSettings()) });
  });

  await page.goto("/app/settings?section=follow-up");
  await expect(page.getByText(/You can review this customer-care schedule/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "Automatically create follow-up tasks for new customers" })).toBeDisabled();
  await page.getByText("Edit schedule steps", { exact: true }).click();
  await expect(page.getByLabel("Task title").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save schedule" })).toHaveCount(0);
  expect(patchRequests).toBe(0);
});
