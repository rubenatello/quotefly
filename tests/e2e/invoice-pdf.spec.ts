import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Invoice } from "../../web/src/lib/api";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

async function seedInvoice(request: APIRequestContext, prefix: string) {
  const owner = await signUpViaApi(request, prefix);
  const customer = await createCustomerViaApi(request, owner, { fullName: "PDF Invoice Customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Customer invoice PDF" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, { headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" } })).status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `invoice-pdf-${crypto.randomUUID()}` },
    data: { sourceQuoteId: quote.id },
  });
  expect(created.status()).toBe(201);
  const invoice = { ...(await created.json()).invoice, status: "OPEN" } as Invoice;
  return { owner, customer, quote, invoice };
}

type QuickBooksPreviewState = {
  paymentLinkAvailable: boolean;
  paymentMethods: { ach: boolean; card: boolean };
};

async function mockInvoice(
  page: Page,
  current: () => Invoice,
  quickBooksPreviewState: () => QuickBooksPreviewState = () => ({
    paymentLinkAvailable: true,
    paymentMethods: { ach: false, card: true },
  }),
) {
  await page.route("**/v1/invoices?**", route => route.fulfill({ json: {
    items: [current()], pagination: { limit: 10, offset: 0, total: 1 }, scope: { mine: false },
  } }));
  await page.route("**/v1/invoices/*", route => route.fulfill({ json: { invoice: current() } }));
  await page.route("**/v1/integrations/quickbooks/invoices/*/sync-preview", route => {
    const invoice = current();
    const quickBooks = quickBooksPreviewState();
    return route.fulfill({ json: { providerWorkflowsEnabled: true, preview: {
      invoice: { ...invoice, customerName: invoice.customer.fullName },
      connection: { companyName: "PDF Sandbox", status: "CONNECTED" },
      providerDocNumber: "QF-000001", lineItems: [], blockers: [], ready: true, reviewBinding: "A".repeat(43),
      operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001", ...quickBooks },
      billingEmail: "customer@example.com", paymentMethods: quickBooks.paymentMethods,
    } } });
  });
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
});

test("invoice PDF downloads keep payment choice explicit and surface safe failures on mobile and desktop", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const seeded = await seedInvoice(request, "invoice-pdf-download");
  let current = seeded.invoice;
  let quickBooks = { paymentLinkAvailable: true, paymentMethods: { ach: false, card: true } };
  await mockInvoice(page, () => current, () => quickBooks);
  const choices: string[] = [];
  let rejection: { status: number; code: string } | null = null;
  let holdNext = false;
  let releaseBusyDownload!: () => void;
  let startedBusyDownload!: () => void;
  const busyDownloadHeld = new Promise<void>(resolve => { releaseBusyDownload = resolve; });
  const busyDownloadStarted = new Promise<void>(resolve => { startedBusyDownload = resolve; });
  await page.route(`**/v1/invoices/${current.id}/pdf?**`, async route => {
    choices.push(new URL(route.request().url()).searchParams.get("includeQuickBooksPayment") ?? "missing");
    if (rejection) return route.fulfill({ status: rejection.status, json: { code: rejection.code, error: "RAW_PROVIDER_SENTINEL" } });
    if (holdNext) {
      startedBusyDownload();
      await busyDownloadHeld;
      holdNext = false;
    }
    return route.fulfill({ contentType: "application/pdf", body: Buffer.from("%PDF-1.4\nsynthetic-browser-download-fixture\n%%EOF") });
  });
  await addSessionCookie(context, seeded.owner);
  await page.goto(`/app/quotes/${seeded.quote.id}`);
  const panel = page.getByTestId("invoice-panel");
  const plain = panel.getByRole("button", { name: "Download without payment link", exact: true });
  const payment = panel.getByRole("button", { name: "Download invoice with Pay button", exact: true });
  await expect(plain).toBeEnabled({ timeout: 60_000 });
  await expect(payment).toBeEnabled();
  expect((await plain.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await payment.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await payment.evaluate(button => button.parentElement?.firstElementChild === button)).toBe(true);
  let download = page.waitForEvent("download");
  await payment.click();
  expect((await download).suggestedFilename()).toBe(`invoice-${current.invoiceNumber}.pdf`);
  download = page.waitForEvent("download");
  await plain.click();
  expect((await download).suggestedFilename()).toBe(`invoice-${current.invoiceNumber}.pdf`);
  expect(choices).toEqual(["true", "false"]);

  holdNext = true;
  download = page.waitForEvent("download");
  await payment.click();
  await busyDownloadStarted;
  await expect(payment).toHaveAttribute("aria-busy", "true");
  await expect(payment).toBeDisabled();
  await expect(plain).toBeDisabled();
  await panel.screenshot({ path: ".codex_tmp/invoice-pdf-actions-busy-light.png" });
  releaseBusyDownload();
  await download;
  await expect(payment).toBeEnabled();
  await expect(payment).toBeFocused();

  rejection = { status: 409, code: "QUICKBOOKS_INVOICE_LINK_UNAVAILABLE" };
  await payment.click();
  await expect(panel.getByRole("alert").first()).toBeVisible();
  await expect(panel.getByRole("alert").first()).toContainText("QuickBooks does not have a payment link for this invoice. Refresh QuickBooks status or download the invoice without a payment link.");
  await expect(page.getByText("RAW_PROVIDER_SENTINEL", { exact: true })).toHaveCount(0);
  await expect(payment).toBeEnabled();
  await expect(payment).toBeFocused();
  await panel.screenshot({ path: ".codex_tmp/invoice-pdf-actions-error-light.png" });
  rejection = { status: 422, code: "INVOICE_PDF_UNAVAILABLE" };
  await plain.click();
  await expect(panel.getByRole("alert").first()).toContainText("This invoice PDF is not available right now. Refresh the invoice and try again after checking its current status.");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ colorScheme: "dark" });
  await panel.screenshot({ path: ".codex_tmp/invoice-pdf-actions-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await plain.focus();
  await expect(plain).toBeFocused();
  await panel.screenshot({ path: ".codex_tmp/invoice-pdf-actions-desktop.png" });
  // A method alone cannot offer a payment PDF without the canonical link.
  quickBooks = { paymentLinkAvailable: false, paymentMethods: { ach: false, card: true } };
  await page.reload();
  await expect(plain).toBeEnabled();
  await expect(payment).toHaveCount(0);
  // A current canonical paid state must remove customer payment delivery.
  current = { ...current, status: "PAID", paymentStatus: "SUCCEEDED", balanceDue: 0 };
  await page.reload();
  await expect(plain).toBeEnabled();
  await expect(payment).toHaveCount(0);
});

test("a delayed PDF response cannot download a previously selected invoice", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const seeded = await seedInvoice(request, "invoice-pdf-stale");
  const secondQuote = await createQuoteViaApi(request, seeded.owner, seeded.customer.id, { title: "Second invoice PDF" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${secondQuote.id}`, { headers: { Cookie: seeded.owner.cookieHeader }, data: { status: "ACCEPTED" } })).status()).toBe(200);
  let current = seeded.invoice;
  await mockInvoice(page, () => current);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/v1/invoices/${current.id}/pdf?**`, async route => {
    started(); await held;
    await route.fulfill({ contentType: "application/pdf", body: Buffer.from("%PDF-1.4\nsynthetic-stale-fixture\n%%EOF") });
  });
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  await addSessionCookie(context, seeded.owner);
  await page.goto(`/app/quotes/${seeded.quote.id}`);
  await page.getByRole("button", { name: "Download without payment link", exact: true }).click();
  await requested;
  current = { ...seeded.invoice, id: "current-second-invoice", invoiceNumber: 88, sourceQuoteId: secondQuote.id };
  await page.evaluate(id => {
    history.pushState({}, "", `/app/quotes/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, secondQuote.id);
  await expect(page.getByTestId("invoice-panel-heading")).toContainText("Invoice #88");
  const response = page.waitForResponse(res => new URL(res.url()).pathname === `/v1/invoices/${seeded.invoice.id}/pdf`);
  release(); await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(downloads).toEqual([]);
  await expect(page.getByRole("button", { name: "Download without payment link", exact: true })).toBeEnabled();
});
