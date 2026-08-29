import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("automatic follow-up settings stay usable at phone width with 44px controls", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "follow-up-settings-mobile");
  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route("**/v1/follow-up-settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        followUpSettings: {
          enabled: true,
          version: 1,
          updatedAtUtc: "2026-08-28T17:00:00.000Z",
          steps: [
            { stepNumber: 1, delayMinutes: 15, title: "Review the new customer", notes: null, priority: "HIGH" },
            { stepNumber: 2, delayMinutes: 1440, title: "Check in after one day", notes: null, priority: "NORMAL" },
          ],
        },
      }),
    });
  });

  await page.goto("/app/settings?section=follow-up");
  await expect(page.getByRole("heading", { name: "Automatic follow-up" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  const automaticSwitch = page.getByRole("switch", { name: "Automatically create follow-up tasks for new customers" });
  expect((await automaticSwitch.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.getByText("Edit schedule steps", { exact: true }).click();

  for (const control of [
    page.getByLabel("Time after intake").first(),
    page.getByLabel("Unit").first(),
    page.getByLabel("Task title").first(),
    page.getByRole("button", { name: "Move step 1 later" }),
    page.getByRole("button", { name: "Save schedule" }),
  ]) {
    expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
