import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("checkout return waits for verified billing state before confirming activation", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "billing-return");
  await addSessionCookie(context, account);
  let authChecks = 0;

  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    authChecks += 1;

    if (authChecks === 1) {
      payload.tenant.subscriptionStatus = "trialing";
      payload.tenant.subscriptionPlanCode = null;
      payload.tenant.trialEndsAtUtc = "2020-01-01T00:00:00.000Z";
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
        accessReason: "payment_required",
      };
    } else {
      payload.tenant.subscriptionStatus = "active";
      payload.tenant.subscriptionPlanCode = "starter";
      payload.tenant.trialStartsAtUtc = null;
      payload.tenant.trialEndsAtUtc = null;
      payload.tenant.subscriptionCurrentPeriodEndUtc = "2099-01-01T00:00:00.000Z";
      payload.tenant.effectivePlanCode = "starter";
      payload.tenant.effectivePlanName = "Basic";
      payload.tenant.isTrial = false;
      payload.tenant.entitlements = {
        ...payload.tenant.entitlements,
        planCode: "starter",
        planName: "Basic",
        isTrial: false,
        hasWorkspaceAccess: true,
        billingRequired: false,
        accessReason: "paid",
      };
    }

    await route.fulfill({ response, json: payload });
  });

  await page.goto("/app/settings?billing=success&session_id=cs_test_return");
  await expect(page.getByText("Basic billing is active. Your workspace subscription is confirmed.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/app\/settings$/);
  expect(authChecks).toBeGreaterThanOrEqual(2);
});
