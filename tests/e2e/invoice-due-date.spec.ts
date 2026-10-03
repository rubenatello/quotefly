import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

test("draft due-date repair handles cancel, stale state, errors, and success on mobile", async ({ context, page, request }) => {
  test.setTimeout(180_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
  await page.setViewportSize({ width: 390, height: 844 });
  const owner = await signUpViaApi(request, "invoice-due-editor");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Due Date Customer", phone: "555-014-9982" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Due date repair" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, { headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" } })).status()).toBe(200);
  const initialDue = new Date(Date.now() + 30 * 86_400_000); initialDue.setUTCHours(5, 17, 0, 0);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, { headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `due-editor-fixture-${Date.now()}` }, data: { sourceQuoteId: quote.id, dueAtUtc: initialDue.toISOString() } });
  expect(created.status()).toBe(201);
  let { invoice } = await created.json();
  let previewCalls = 0;
  let previewVersion = 0;
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`, async route => {
    previewCalls++; previewVersion = invoice.version;
    await route.fulfill({ json: { providerWorkflowsEnabled: false, preview: {
      invoice: { id: invoice.id, version: invoice.version, invoiceNumber: 1, status: "DRAFT", customerName: customer.fullName, currency: "USD", subtotalAmount: 150, taxAmount: 0, totalAmount: 150, dueAtUtc: invoice.dueAtUtc },
      connection: null, providerDocNumber: "QF-000001", lineItems: [], blockers: [], ready: false, reviewBinding: null, operation: null,
      billingEmail: null, paymentMethods: { ach: false, card: false },
    } } });
  });
  const commands: Array<{ key: string; body: { invoiceVersion: number; dueAtUtc: string } }> = [];
  await page.route(`**/v1/invoices/${invoice.id}/due-date`, async route => {
    commands.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (commands.length === 1) return route.fulfill({ status: 409, json: { code: "INVOICE_VERSION_CHANGED", error: "Stale invoice" } });
    if (commands.length === 2) return route.fulfill({ status: 503, json: { error: "Temporary failure" } });
    const response = await route.fetch();
    const result = await response.json(); invoice = result.invoice;
    return route.fulfill({ response, json: result });
  });
  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const edit = page.getByRole("button", { name: "Change due date", exact: true });
  await expect(edit).toBeEnabled({ timeout: 60_000 });
  expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Change due date" });
  const date = dialog.getByLabel("Invoice due date", { exact: true });
  const save = dialog.getByRole("button", { name: "Save due date", exact: true });
  await expect(save).toBeDisabled(); // Existing non-noon timestamp is unchanged in this calendar-date UI.
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused(); expect(commands).toHaveLength(0);
  await edit.click();
  const nextDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  await date.fill(nextDate);
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await dialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: ".codex_tmp/invoice-due-editor-mobile.png", fullPage: true });
  await save.click();
  await expect(dialog).toContainText("This invoice changed. Reload it");
  await dialog.getByRole("button", { name: "Reload invoice", exact: true }).click();
  await expect(edit).toBeEnabled();
  await edit.click(); await date.fill(nextDate); await save.click();
  await expect(dialog).toContainText("QuoteFly could not complete this action right now. Try again in a moment.");
  const beforeCancel = previewCalls;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => previewCalls).toBeGreaterThan(beforeCancel);
  await expect(edit).toBeEnabled(); await edit.click(); await date.fill(nextDate); await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Invoice due date updated. Review accounting details again before publishing.")).toBeVisible();
  await expect.poll(() => previewVersion).toBe(2);
  expect(commands).toHaveLength(3);
  expect(commands[2].key).toBe(commands[1].key);
  expect(commands[2].body.invoiceVersion).toBe(1);
  expect(invoice.dueAtUtc).toBe(commands[2].body.dueAtUtc);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(edit).toBeEnabled(); await edit.click();
  await page.screenshot({ path: ".codex_tmp/invoice-due-editor-desktop.png", fullPage: true });
  await expect(save).toBeDisabled();

  let canceledInvoiceResponseApplied = false;
  await page.route(new RegExp(`/v1/invoices\\?[^#]*sourceQuoteId=${quote.id}`), async route => {
    const response = await route.fetch();
    const payload = await response.json() as { items: Array<{ id: string; job: { status: string } }> };
    const targetInvoice = payload.items.find((item) => item.id === invoice.id);
    if (targetInvoice) {
      targetInvoice.job.status = "CANCELED";
      canceledInvoiceResponseApplied = true;
    }
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.reload();
  await expect.poll(() => canceledInvoiceResponseApplied).toBe(true);
  await expect(page.getByTestId("quickbooks-invoice-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change due date", exact: true })).toHaveCount(0);
});
