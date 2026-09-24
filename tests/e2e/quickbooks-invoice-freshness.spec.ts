import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Invoice, QuickBooksInvoiceOperation } from "../../web/src/lib/api";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

async function seedInvoice(request: APIRequestContext, prefix: string) {
  const owner = await signUpViaApi(request, prefix);
  const customer = await createCustomerViaApi(request, owner, { fullName: "Canonical Invoice Customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Canonical invoice repair" });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `invoice-freshness-${crypto.randomUUID()}` },
    data: { sourceQuoteId: quote.id },
  });
  expect(created.status()).toBe(201);
  return { owner, customer, quote, invoice: (await created.json()).invoice as Invoice };
}

function operation(status: QuickBooksInvoiceOperation["status"]): QuickBooksInvoiceOperation {
  return { status, providerDocNumber: "QF-000001", reconciliationAvailable: status === "RECONCILIATION_REQUIRED", retryAvailable: false };
}

async function previewRoute(page: Page, current: () => Invoice, state: () => QuickBooksInvoiceOperation | null) {
  const id = current().id;
  await page.route(`**/v1/integrations/quickbooks/invoices/${id}/sync-preview`, async (route) => {
    const invoice = current();
    await route.fulfill({ json: { providerWorkflowsEnabled: true, preview: {
      invoice: { ...invoice, customerName: invoice.customer.fullName },
      connection: { companyName: "Canonical Sandbox", status: "CONNECTED" },
      quickBooksCustomerName: invoice.customer.fullName, providerDocNumber: "QF-000001",
      lineItems: [{ description: invoice.titleSnapshot, quantity: 1, unitPrice: invoice.totalAmount, amount: invoice.totalAmount, mapped: true, quickBooksItemName: "Service" }],
      blockers: [], ready: true, reviewBinding: "A".repeat(43), operation: state(),
      billingEmail: "customer@example.com", paymentMethods: { ach: false, card: false },
    } } });
  });
}

async function expectBalance(page: Page, amount: number) {
  await expect(page.getByTestId("invoice-panel").getByText("Balance due", { exact: true }).locator("..")).toContainText(
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount),
  );
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
});

for (const paid of [false, true]) {
  test(`QuickBooks reconciliation refreshes the canonical ${paid ? "paid" : "partial"} balance and badges without navigation`, async ({ context, page, request }) => {
    test.setTimeout(90_000);
    const seeded = await seedInvoice(request, `qbo-fresh-${paid ? "paid" : "partial"}`);
    let current = seeded.invoice;
    let state = operation("RECONCILIATION_REQUIRED");
    await previewRoute(page, () => current, () => state);
    await page.route(`**/v1/invoices/${current.id}`, (route) => route.fulfill({ json: { invoice: current } }));
    await page.route(`**/v1/integrations/quickbooks/invoices/${current.id}/reconcile`, async (route) => {
      current = { ...current, version: current.version + 1, status: paid ? "PAID" : "OPEN", paymentStatus: paid ? "SUCCEEDED" : "PENDING",
        amountPaid: paid ? Number(current.totalAmount) : 50, balanceDue: paid ? 0 : Number(current.totalAmount) - 50 };
      state = operation("SUCCEEDED");
      await route.fulfill({ json: { operation: state } });
    });
    await addSessionCookie(context, seeded.owner);
    await page.goto(`/app/quotes/${seeded.quote.id}`);
    await expectBalance(page, Number(current.totalAmount));
    await page.getByTestId("quickbooks-invoice-panel").getByRole("button", { name: "Check QuickBooks", exact: true }).click();
    await expectBalance(page, paid ? 0 : Number(current.totalAmount) - 50);
    await expect(page.getByTestId("invoice-panel").getByText(paid ? "Paid" : "Partially paid", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("invoice-panel").getByText(paid ? "Paid" : "Open", { exact: true }).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/quotes/${seeded.quote.id}$`));
  });
}

test("publish and status refresh read canonical invoice state instead of deriving it from provider operation success", async ({ context, page, request }) => {
  test.setTimeout(90_000);
  const seeded = await seedInvoice(request, "qbo-fresh-publish");
  let current = seeded.invoice;
  let state: QuickBooksInvoiceOperation | null = null;
  await previewRoute(page, () => current, () => state);
  await page.route(`**/v1/invoices/${current.id}`, (route) => route.fulfill({ json: { invoice: current } }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${current.id}/publish`, async (route) => {
    current = { ...current, version: current.version + 1, status: "OPEN" };
    state = operation("PROCESSING");
    await route.fulfill({ status: 202, json: { operation: state, duplicate: false } });
  });
  await addSessionCookie(context, seeded.owner);
  await page.goto(`/app/quotes/${seeded.quote.id}`);
  const panel = page.getByTestId("invoice-panel");
  await panel.getByRole("button", { name: "Review QuickBooks draft", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish to QuickBooks", exact: true }).click();
  await expect(panel.getByText("Open", { exact: true })).toBeVisible();
  await expectBalance(page, Number(current.totalAmount));
  current = { ...current, version: current.version + 1, status: "PAID", paymentStatus: "SUCCEEDED", amountPaid: Number(current.totalAmount), balanceDue: 0 };
  state = operation("SUCCEEDED");
  await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expectBalance(page, 0);
  await expect(panel.getByText("Paid", { exact: true }).first()).toBeVisible();
});

test("a delayed canonical invoice refresh cannot replace a newly selected invoice", async ({ context, page, request }) => {
  test.setTimeout(90_000);
  const seeded = await seedInvoice(request, "qbo-fresh-switch");
  const otherQuote = await createQuoteViaApi(request, seeded.owner, seeded.customer.id, { title: "Current second invoice" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${otherQuote.id}`, {
    headers: { Cookie: seeded.owner.cookieHeader }, data: { status: "ACCEPTED" },
  })).status()).toBe(200);
  const other = { ...seeded.invoice, id: "other-invoice", sourceQuoteId: otherQuote.id, invoiceNumber: 88, totalAmount: 275, balanceDue: 275 };
  await previewRoute(page, () => seeded.invoice, () => operation("SUCCEEDED"));
  await previewRoute(page, () => other, () => operation("SUCCEEDED"));
  await page.route("**/v1/invoices?**", async (route) => {
    const selected = new URL(route.request().url()).searchParams.get("sourceQuoteId") === otherQuote.id ? other : seeded.invoice;
    await route.fulfill({ json: { items: [selected], pagination: { limit: 1, offset: 0, total: 1 } } });
  });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/v1/invoices/${seeded.invoice.id}`, async (route) => {
    started();
    await gate;
    await route.fulfill({ json: { invoice: { ...seeded.invoice, version: 500, status: "PAID", paymentStatus: "SUCCEEDED", balanceDue: 0 } } });
  });
  await page.route(`**/v1/invoices/${other.id}`, (route) => route.fulfill({ json: { invoice: other } }));
  await addSessionCookie(context, seeded.owner);
  await page.goto(`/app/quotes/${seeded.quote.id}`);
  await requestStarted;
  await page.evaluate((id) => {
    history.pushState({}, "", `/app/quotes/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, otherQuote.id);
  await expect(page.getByTestId("invoice-panel-heading")).toContainText("Invoice #88");
  await expectBalance(page, 275);
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/v1/invoices/${seeded.invoice.id}`);
  release();
  await oldResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("invoice-panel-heading")).toContainText("Invoice #88");
  await expectBalance(page, 275);
  await expect(page.getByTestId("invoice-panel").getByText("Paid", { exact: true })).toHaveCount(0);
});
