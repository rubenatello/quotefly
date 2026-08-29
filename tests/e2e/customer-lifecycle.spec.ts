import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  signUpViaApi,
} from "./helpers";

test("customer loss and reopen lifecycle stays clear on desktop and mobile", async ({ context, page, request }) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "customer-lifecycle");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Lifecycle Review Customer",
    phone: "555-017-2201",
  });
  const manualTask = await request.post(`${apiBaseUrl}/v1/activities`, {
    headers: {
      Cookie: account.cookieHeader,
      "Idempotency-Key": "customer-lifecycle-e2e-manual-task",
    },
    data: {
      customerId: customer.id,
      type: "FOLLOW_UP",
      priority: "NORMAL",
      title: "Review the final customer conversation",
      dueAtUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  expect(manualTask.status()).toBe(201);

  await addSessionCookie(context, account);
  await page.goto("/app/customers");
  await page.getByRole("button", { name: `Open ${customer.fullName} details`, exact: true }).click();
  const customerDialog = page.getByRole("dialog", { name: "Customer details", exact: true });
  await expect(customerDialog).toBeVisible();

  await customerDialog.getByRole("button", { name: "Mark lost", exact: true }).click();
  const lossDialog = page.getByRole("dialog", { name: "Mark customer lost", exact: true });
  await expect(lossDialog.getByText("1 manual task will remain open for review.", { exact: true })).toBeVisible();
  const markLost = lossDialog.getByRole("button", { name: "Mark lost and keep manual tasks", exact: true });
  await expect(markLost).toBeDisabled();
  await lossDialog.getByLabel("Lost reason", { exact: true }).selectOption("OTHER");
  await expect(lossDialog.getByText("A short note is required when the reason is Other.", { exact: true })).toBeVisible();
  await expect(markLost).toBeDisabled();
  await lossDialog.getByLabel("Loss notes (optional)", { exact: true }).fill("The project is paused until next season.");
  await expect(markLost).toBeEnabled();
  const lossAccessibility = await new AxeBuilder({ page }).include(".customer-lifecycle-dialog").analyze();
  expect(lossAccessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
  await markLost.click();

  await expect(lossDialog).toBeHidden();
  await expect(customerDialog.getByText("Closed lost", { exact: true })).toBeVisible();
  await expect(customerDialog.getByText("The project is paused until next season.", { exact: true })).toBeVisible();
  const lostQuoteButtons = customerDialog.getByRole("button", { name: "New quote", exact: true });
  await expect(lostQuoteButtons).toHaveCount(2);
  for (const button of await lostQuoteButtons.all()) await expect(button).toBeDisabled();

  const settingsResponse = await request.get(`${apiBaseUrl}/v1/follow-up-settings`, {
    headers: { Cookie: account.cookieHeader },
  });
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { followUpSettings: { version: number } };
  const disableResponse = await request.patch(`${apiBaseUrl}/v1/follow-up-settings`, {
    headers: { Cookie: account.cookieHeader },
    data: { version: settings.followUpSettings.version, enabled: false },
  });
  expect(disableResponse.status()).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await customerDialog.getByRole("button", { name: "Reopen customer", exact: true }).first().click();
  const reopenDialog = page.getByRole("dialog", { name: "Reopen customer", exact: true });
  const automatedChoice = reopenDialog.getByRole("radio", { name: /Yes, start a fresh sequence/i });
  await expect(automatedChoice).toBeDisabled();
  await expect(reopenDialog.getByText(/Automatic follow-up is disabled for this workspace/i)).toBeVisible();
  await expect(reopenDialog.getByRole("link", { name: "Open follow-up settings", exact: true })).toBeVisible();
  const reopen = reopenDialog.getByRole("button", { name: "Reopen customer", exact: true });
  await expect(reopen).toBeDisabled();
  await reopenDialog.getByRole("radio", { name: /No, reopen without automatic tasks/i }).check();
  await expect(reopen).toBeEnabled();
  const reopenAccessibility = await new AxeBuilder({ page }).include(".customer-lifecycle-dialog").analyze();
  expect(reopenAccessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
  await reopen.click();

  await expect(reopenDialog).toBeHidden();
  await expect(customerDialog.getByText("Closed lost", { exact: true })).toBeHidden();
  const reopenedQuoteButtons = customerDialog.getByRole("button", { name: "New quote", exact: true });
  await expect(reopenedQuoteButtons).toHaveCount(2);
  for (const button of await reopenedQuoteButtons.all()) await expect(button).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
});
