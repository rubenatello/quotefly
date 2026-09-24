import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import type { Invoice, InvoiceTaxContextForm } from "../../web/src/lib/api";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

const address = {
  Line1: "100 Test Street",
  City: "Sacramento",
  CountrySubDivisionCode: "CA",
  PostalCode: "95814",
  Country: "US" as const,
};

async function seed(page: Page, request: APIRequestContext, context: Parameters<typeof addSessionCookie>[0]) {
  const owner = await signUpViaApi(request, "qbo-tax-navigation");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Synthetic navigation tax customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Synthetic navigation tax quote" });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);

  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": crypto.randomUUID() },
    data: { sourceQuoteId: quote.id },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()).invoice as Invoice;
  const lines = invoice.lineItems.filter((line) => line.sectionType === "INCLUDED");
  const form: InvoiceTaxContextForm = {
    invoice: {
      id: invoice.id,
      version: invoice.version,
      currency: "USD",
      subtotalAmount: String(invoice.subtotalAmount),
      taxAmount: String(invoice.taxAmount),
      totalAmount: String(invoice.totalAmount),
      lines: lines.map((line) => ({
        invoiceLineItemId: line.id,
        position: line.position,
        description: line.description,
        quantity: String(line.quantity),
        unitPrice: String(line.unitPrice),
        amount: String(line.lineTotal),
        mapping: { reviewed: true, displayName: "Synthetic service" },
      })),
    },
    currentContext: { revision: null, current: false, staleReason: null, decisions: null, confirmedAtUtc: null },
    suggestions: { origin: address, destination: null },
    expectedContextRevision: 0,
    sourceToken: "synthetic-navigation-form-token",
    sourceTokenExpiresAtUtc: new Date(Date.now() + 900_000).toISOString(),
    taxCalculationProven: false,
    publishingAuthorized: false,
  };

  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`, (route) => route.fulfill({
    json: {
      providerWorkflowsEnabled: true,
      preview: {
        invoice: { ...invoice, customerName: customer.fullName },
        connection: { companyName: "Synthetic tax sandbox", status: "CONNECTED" },
        customerMapping: { quickBooksCustomerId: "synthetic-customer", quickBooksDisplayName: "Synthetic customer", reviewedAtUtc: new Date().toISOString() },
        lineItems: lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: line.lineTotal,
          itemKey: line.description,
          mapped: true,
          quickBooksItemId: "synthetic-item",
          quickBooksItemName: "Synthetic service",
          reviewedAtUtc: new Date().toISOString(),
        })),
        quickBooksCustomerName: "Synthetic customer",
        providerDocNumber: "QF-SYNTHETIC",
        blockers: [],
        ready: true,
        reviewBinding: "A".repeat(43),
        operation: null,
        billingEmail: null,
        paymentMethods: { ach: false, card: false },
      },
    },
  }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/tax-context`, (route) => route.fulfill({ json: form }));
  await addSessionCookie(context, owner);
  return { invoice, quote };
}

async function openAndFillTaxContext(page: Page) {
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await section.getByLabel("Transaction date", { exact: true }).fill("2026-09-23");
  const destination = section.getByRole("group", { name: "Service or delivery address", exact: true });
  await destination.getByLabel("Street address", { exact: true }).fill("200 Example Avenue");
  await destination.getByLabel("City", { exact: true }).fill("Sacramento");
  await destination.getByLabel("State", { exact: true }).selectOption("CA");
  await destination.getByLabel("ZIP code", { exact: true }).fill("95814");
  for (const radio of await section.getByRole("radio", { name: "Taxable", exact: true }).all()) await radio.check();
  return section;
}

async function expectCancelledNavigation(page: Page, trigger: Locator, returnTarget: Locator, route: RegExp) {
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Discard unsaved tax details?" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(route);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(route);
  await expect(returnTarget).toBeFocused();
  await expect(page.getByTestId("invoice-tax-context").getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
});

test("tax edits guard workspace buttons and preserve focus until a single confirmed leave", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let logoutRequests = 0;
  await page.route("**/v1/auth/logout", (route) => {
    logoutRequests += 1;
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/app/quotes/${fixture.quote.id}`);
  await openAndFillTaxContext(page);
  const quoteRoute = new RegExp(`/app/quotes/${fixture.quote.id}$`);

  const commandTrigger = page.getByRole("button", { name: "Search or jump", exact: true });
  await commandTrigger.click();
  const commandCustomer = page.locator("[cmdk-item]").filter({ hasText: "Customers" });
  await expectCancelledNavigation(page, commandCustomer, commandTrigger, quoteRoute);

  const headerQuickQuote = page.getByRole("group", { name: "Quick commands", exact: true }).getByRole("button", { name: "New quote", exact: true });
  await expectCancelledNavigation(page, headerQuickQuote, headerQuickQuote, quoteRoute);

  const acceptedJob = page.getByRole("button", { name: "Open job", exact: true });
  await expectCancelledNavigation(page, acceptedJob, acceptedJob, quoteRoute);

  const profileMenu = page.getByRole("button", { name: /Beta Test Owner/ });
  await profileMenu.click();
  const signOut = page.getByRole("menuitem", { name: "Sign out", exact: true });
  await expectCancelledNavigation(page, signOut, profileMenu, quoteRoute);
  expect(logoutRequests).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCustomers = page.getByTestId("mobile-tab-customers");
  await expectCancelledNavigation(page, mobileCustomers, mobileCustomers, quoteRoute);

  const mobileMenu = page.getByRole("button", { name: "Open navigation", exact: true });
  await mobileMenu.click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation", exact: true });
  await expect(drawer).toBeVisible();
  await expectCancelledNavigation(page, drawer.getByRole("button", { name: "Customers", exact: true }), mobileMenu, quoteRoute);

  await page.getByTestId("mobile-quick-quote").click();
  const leaveDialog = page.getByRole("dialog", { name: "Discard unsaved tax details?" });
  await leaveDialog.getByRole("button", { name: "Discard and leave", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/build$/);
});

test("trial checkout stays disabled while tax details are pending and never starts checkout", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let checkoutRequests = 0;
  await page.route("**/v1/billing/checkout-session", (route) => {
    checkoutRequests += 1;
    return route.fulfill({ status: 500, json: { error: "Checkout must not start while tax details are pending." } });
  });

  await page.goto(`/app/quotes/${fixture.quote.id}`);
  await openAndFillTaxContext(page);

  const checkout = page.getByRole("button", { name: /Choose Basic/ });
  await expect(checkout).toBeDisabled();
  await expect(page.getByText("Save or discard your changes before choosing a plan.", { exact: true })).toBeVisible();
  expect(checkoutRequests).toBe(0);
});

test("PDF preview stays unavailable while tax details are pending", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let pdfRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/v1/quotes/${fixture.quote.id}/pdf`) pdfRequests += 1;
  });

  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = await openAndFillTaxContext(page);
  const preview = page.getByRole("button", { name: "Preview generated PDF", exact: true });
  await expect(preview).toBeDisabled();
  await expect(page.getByText("Save or discard tax details before previewing the PDF.", { exact: true })).toBeVisible();
  await preview.evaluate((button) => button.click());
  expect(pdfRequests).toBe(0);

  await section.getByRole("button", { name: "Close", exact: true }).click();
  const discardDialog = page.getByRole("dialog", { name: "Discard unsaved tax details?", exact: true });
  await discardDialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(preview).toBeEnabled();
});

test("a transient quote refresh keeps private tax details mounted and retryable", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  const quoteGetFailure = (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 503, json: { error: "Synthetic quote refresh failure." } });
  };

  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = await openAndFillTaxContext(page);
  await page.route(`**/v1/quotes/${fixture.quote.id}`, quoteGetFailure);

  const assignments = page.getByLabel("Assigned to", { exact: true });
  let assignment: Locator | null = null;
  for (let index = 0; index < await assignments.count(); index += 1) {
    if (await assignments.nth(index).isVisible()) {
      assignment = assignments.nth(index);
      break;
    }
  }
  if (!assignment) throw new Error("Expected a visible quote assignment control.");
  await assignment.selectOption({ index: 1 });

  await expect(page.getByText("Quote did not load", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry quote", exact: true })).toBeVisible();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");

  await page.unroute(`**/v1/quotes/${fixture.quote.id}`, quoteGetFailure);
  await page.getByRole("button", { name: "Retry quote", exact: true }).click();
  await expect(page.getByText("Quote did not load", { exact: true })).toBeHidden();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
});

for (const retention of [
  { action: "archive" as const, button: "Archive", dialog: "Archive quote" },
  { action: "delete" as const, button: "Delete", dialog: "Delete quote" },
]) {
  test(`retention ${retention.action} confirms tax discard in one dialog before mutating the quote`, async ({ page, request, context }) => {
    const fixture = await seed(page, request, context);
    let archiveRequests = 0;
    let deleteRequests = 0;
    await page.route(`**/v1/quotes/${fixture.quote.id}/archive`, (route) => {
      if (route.request().method() === "POST") archiveRequests += 1;
      return route.fulfill({ status: 204 });
    });
    await page.route(`**/v1/quotes/${fixture.quote.id}`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deleteRequests += 1;
      return route.fulfill({ status: 204 });
    });

    await page.goto(`/app/quotes/${fixture.quote.id}`);
    const section = await openAndFillTaxContext(page);
    const trigger = page.getByRole("button", { name: retention.button, exact: true });

    await trigger.click();
    const retentionDialog = page.getByRole("dialog", { name: retention.dialog, exact: true });
    await expect(retentionDialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await retentionDialog.getByRole("button", { name: retention.dialog, exact: true }).click();

    const leaveDialog = page.getByRole("dialog", { name: "Discard unsaved tax details?", exact: true });
    await expect(leaveDialog).toBeVisible();
    await expect(retentionDialog).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await leaveDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(archiveRequests).toBe(0);
    expect(deleteRequests).toBe(0);
    await expect(trigger).toBeFocused();
    await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
    await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");

    await trigger.click();
    await page.getByRole("dialog", { name: retention.dialog, exact: true }).getByRole("button", { name: retention.dialog, exact: true }).click();
    await expect(leaveDialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await leaveDialog.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await expect.poll(() => retention.action === "archive" ? archiveRequests : deleteRequests).toBe(1);
    expect(retention.action === "archive" ? deleteRequests : archiveRequests).toBe(0);
    await expect(page).toHaveURL((url) => url.pathname === "/app/quotes");
  });
}
