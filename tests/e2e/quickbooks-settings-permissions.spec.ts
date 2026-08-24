import { expect, test } from "@playwright/test";
import { addSessionCookie, addWorkspaceMemberViaApi, apiBaseUrl, signUpViaApi } from "./helpers";

const quickBooksStatusPath = "/v1/integrations/quickbooks/status";

test("members can open Settings without requesting private QuickBooks status", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-member");
  const member = await addWorkspaceMemberViaApi(request, owner, "QuickBooks Settings Member");
  await addSessionCookie(context, member);

  let quickBooksStatusRequests = 0;
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === `${apiBaseUrl}${quickBooksStatusPath}`) {
      quickBooksStatusRequests += 1;
    }
  });

  await page.goto("/app/settings");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("QuickBooks foundation status is available to workspace owners and admins.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(quickBooksStatusRequests).toBe(0);
});

test("managers retain QuickBooks status and can see a paused provider workflow", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "quickbooks-settings-manager");
  await addSessionCookie(context, owner);

  let quickBooksStatusRequests = 0;
  await page.route(`**${quickBooksStatusPath}`, async (route) => {
    quickBooksStatusRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: false,
        configured: true,
        providerWorkflowsEnabled: false,
        webhookConfigured: false,
        canManage: true,
        environment: "sandbox",
        redirectUri: "http://127.0.0.1:4100/v1/integrations/quickbooks/callback",
        webhookUrl: "",
        connection: null,
      }),
    });
  });

  await page.goto("/app/settings");
  await expect(page.getByTestId("theme-option-system")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Internal foundation status: configured, with provider workflows paused."),
  ).toBeVisible();
  expect(quickBooksStatusRequests).toBeGreaterThan(0);
});
