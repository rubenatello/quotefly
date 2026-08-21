import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

test("a failed customer load cannot masquerade as an empty workspace", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "customer-load-recovery");
  await addSessionCookie(context, account);

  let pageListRequests = 0;
  let allowCustomerListSuccess = false;
  await page.route(/\/v1\/customers(?:\?|$)/, async (route) => {
    if (!route.request().url().includes("limit=25")) {
      await route.continue();
      return;
    }
    pageListRequests += 1;
    if (!allowCustomerListSuccess) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Customer list is temporarily unavailable." }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Customers could not be loaded.", { exact: true })).toBeVisible();
  await expect(page.getByText("QuoteFly could not complete this action right now. Try again in a moment.", { exact: true })).toBeVisible();
  await expect(page.getByText("Customer list is temporarily unavailable.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Add your first customer", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add customer", exact: true }).first()).toBeDisabled();

  allowCustomerListSuccess = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("No customers yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Add your first customer to begin the quoting workflow.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add customer", exact: true }).first()).toBeEnabled();
  expect(pageListRequests).toBeGreaterThanOrEqual(2);
});
