import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

test("an authenticated user can export a selected quote to QuickBooks CSV with the chosen due days", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "quickbooks-csv-export");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "QuickBooks CSV Customer",
  });
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "QuickBooks CSV Roof Repair",
  });

  await addSessionCookie(context, account);
  await page.goto("/app/quotes");

  const visibleQuoteTitle = page.getByText(quote.title, { exact: true }).filter({ visible: true });
  await expect(visibleQuoteTitle).toBeVisible({ timeout: 30_000 });

  const exportButton = page.getByRole("button", { name: "Export QuickBooks CSV", exact: true });
  await expect(exportButton).toBeDisabled();
  await expect(page.getByText("Select all eligible quotes on this page for QuickBooks CSV export", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Invoice due in days", { exact: true })).toBeVisible();
  await expect(page.getByText("0 quotes selected", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/quotes\.quickBooksCsv|\{\{count\}\}/);

  const quoteRow = visibleQuoteTitle.locator(
    "xpath=ancestor::div[.//input[@type='checkbox']][1]",
  );
  const quoteCheckbox = quoteRow.getByRole("checkbox");
  await quoteCheckbox.check();
  await expect(quoteCheckbox).toBeChecked();
  await expect(page.getByText("1 quote selected", { exact: true })).toBeVisible();
  await expect(exportButton).toBeEnabled();

  const dueDaysInput = page.locator("#quickbooks-csv-due-days");
  await dueDaysInput.fill("30");
  await expect(dueDaysInput).toHaveValue("30");

  const exportRequestPromise = page.waitForRequest((browserRequest) => {
    return (
      browserRequest.method() === "POST" &&
      browserRequest.url() === `${apiBaseUrl}/v1/quotes/invoices/export-csv`
    );
  });
  const downloadPromise = page.waitForEvent("download");

  await exportButton.click();

  const [exportRequest, download] = await Promise.all([
    exportRequestPromise,
    downloadPromise,
  ]);

  expect(exportRequest.postDataJSON()).toEqual({
    quoteIds: [quote.id],
    dueInDays: 30,
  });
  expect(download.suggestedFilename()).toMatch(/^quotefly-quickbooks-invoices-\d{4}-\d{2}-\d{2}\.csv$/);

  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const csv = await readFile(downloadedPath!, "utf8");
  expect(csv).toContain("Txn Type,Doc Number,Customer");
  expect(csv).toContain(customer.fullName);
  expect(csv).toContain(quote.title);
});

test("the QuickBooks CSV controls stay localized and usable at 320px in Spanish", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "quickbooks-csv-export-spanish");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Cliente CSV de QuickBooks",
  });
  await createQuoteViaApi(request, account, customer.id, {
    title: "Reparación CSV de QuickBooks",
  });

  const localeResponse = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(localeResponse.ok()).toBeTruthy();

  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/app/quotes");

  await expect(page.getByRole("button", { name: "Exportar CSV de QuickBooks", exact: true })).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByText("Seleccionar todas las cotizaciones elegibles de esta página para exportar CSV de QuickBooks", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Vencimiento de factura (días)", { exact: true })).toBeVisible();
  await expect(page.getByText("0 cotizaciones seleccionadas", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/quotes\.quickBooksCsv|\{\{count\}\}/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
