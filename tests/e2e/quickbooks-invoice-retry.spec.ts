import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

test("a rejected QuickBooks publish requires fresh review and a distinct confirmed retry command on mobile", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
  await page.setViewportSize({ width: 390, height: 844 });
  const owner = await signUpViaApi(request, "qbo-explicit-retry");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Retry Review Customer", phone: "555-014-9981", email: "retry@example.com" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Reviewed repair" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, { headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" } })).status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, { headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `qbo-retry-fixture-${Date.now()}` }, data: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" } });
  expect(created.status()).toBe(201);
  const { invoice } = await created.json();
  let operation: object | null = null;
  let binding = "A".repeat(43);
  let billingEmail = "retry@example.com";
  const commands: Array<{ key: string; body: Record<string, unknown> }> = [];
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`, async (route) => {
    const options = route.request().postDataJSON();
    if (options.billingEmail) billingEmail = options.billingEmail;
    await route.fulfill({ json: { providerWorkflowsEnabled: true, preview: {
      invoice: { id: invoice.id, version: invoice.version, invoiceNumber: 1, status: "DRAFT", customerName: customer.fullName, currency: "USD", subtotalAmount: 150, taxAmount: 0, totalAmount: 150, dueAtUtc: "2026-10-01T17:00:00.000Z" },
      connection: { companyName: "Retry Sandbox", status: "CONNECTED" }, quickBooksCustomerName: "Reviewed customer", providerDocNumber: "QF-000001",
      lineItems: [{ description: quote.title, quantity: 1, unitPrice: 150, amount: 150, mapped: true, quickBooksItemName: "Reviewed service" }],
      blockers: [], ready: true, reviewBinding: binding, operation,
      billingEmail, paymentMethods: { ach: false, card: false },
    } } });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/publish`, async (route) => {
    commands.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (commands.length === 1) {
      operation = { status: "FAILED", retryAvailable: true, reconciliationAvailable: false, providerDocNumber: "QF-000001" };
      binding = "B".repeat(43);
      await route.fulfill({ status: 409, json: { error: "QuickBooks rejected this invoice.", code: "QUICKBOOKS_PUBLISH_FAILED", operation } });
    } else {
      operation = { status: "SUCCEEDED", retryAvailable: false, reconciliationAvailable: false, providerDocNumber: "QF-000001" };
      await route.fulfill({ status: 201, json: { operation, duplicate: false } });
    }
  });
  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  await panel.getByRole("button", { name: "Review QuickBooks draft", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish to QuickBooks", exact: true }).click();
  const retry = panel.getByRole("button", { name: "Review and retry rejected invoice", exact: true });
  await expect(retry).toBeVisible();
  await expect(panel.getByTestId("quickbooks-review-controls")).toBeEnabled();
  await panel.getByLabel("Customer billing email", { exact: true }).fill("reviewed@example.com");
  await expect(retry).toHaveCount(0);
  await panel.getByRole("button", { name: "Review payment choices", exact: true }).click();
  await expect(retry).toBeVisible();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await retry.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The previous attempt was rejected without a created invoice.");
  await page.keyboard.press("Escape");
  await expect(retry).toBeFocused();
  await retry.click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry reviewed invoice", exact: true }).click();
  await expect(panel).toContainText("Published once to QuickBooks as QF-000001.");
  expect(commands).toHaveLength(2);
  expect(commands[0].body.retryFailed).toBe(false);
  expect(commands[1].body).toMatchObject({ retryFailed: true, reviewBinding: "B".repeat(43), billingEmail: "reviewed@example.com" });
  expect(commands[1].key).not.toBe(commands[0].key);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  operation = { status: "FAILED", retryAvailable: false, reconciliationAvailable: false, providerDocNumber: "QF-000001" };
  await page.reload();
  await expect(panel).toContainText("QuickBooks rejected this invoice.");
  await expect(retry).toHaveCount(0);
  await expect(panel.getByTestId("quickbooks-review-controls")).toHaveCount(0);
  expect(commands).toHaveLength(2);
});
