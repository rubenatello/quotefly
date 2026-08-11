import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("locked mobile owners can recover failed payments through the billing portal", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-mobile-recovery");
  await addSessionCookie(context, account);

  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.tenant.subscriptionStatus = "past_due";
    payload.tenant.subscriptionPlanCode = "starter";
    payload.tenant.trialStartsAtUtc = null;
    payload.tenant.trialEndsAtUtc = null;
    payload.tenant.subscriptionCurrentPeriodEndUtc = null;
    payload.tenant.effectivePlanCode = "starter";
    payload.tenant.effectivePlanName = "Basic";
    payload.tenant.isTrial = false;
    payload.tenant.entitlements = {
      ...payload.tenant.entitlements,
      planCode: "starter",
      planName: "Basic",
      isTrial: false,
      hasWorkspaceAccess: false,
      billingRequired: true,
      accessReason: "past_due",
    };
    await route.fulfill({ response, json: payload });
  });

  let portalRequests = 0;
  await page.route("**/v1/billing/portal-session", async (route) => {
    portalRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "/support?billing=portal-test" }),
    });
  });

  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { name: "Update billing to unlock your workspace." })).toBeVisible();
  await expect(page.getByRole("button", { name: /start basic/i }).filter({ visible: true })).toHaveCount(0);
  const updateBilling = page.getByRole("button", { name: "Update Billing" }).filter({ visible: true });
  await expect(updateBilling).toBeVisible();
  await updateBilling.click();
  await expect(page).toHaveURL(/\/support\?billing=portal-test$/);
  expect(portalRequests).toBe(1);
});
