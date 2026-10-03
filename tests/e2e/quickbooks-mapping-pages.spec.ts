import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

async function seed(request: APIRequestContext, page: Page) {
  const owner = await signUpViaApi(request, "qbo-mapping-pages");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Mapping Customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Mapping repair" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" },
  })).status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `mapping-pages-${crypto.randomUUID()}` },
    data: { sourceQuoteId: quote.id },
  });
  expect(created.status()).toBe(201);
  const { invoice } = await created.json();
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`, (route) => route.fulfill({ json: {
    providerWorkflowsEnabled: true,
    preview: {
      invoice: { ...invoice, customerName: customer.fullName },
      connection: { companyName: "Mapping Sandbox", status: "CONNECTED" },
      lineItems: [{ itemKey: "repair", description: "Mapping repair", quantity: 1, unitPrice: 150, amount: 150, mapped: false }],
      blockers: ["Customer mapping needs review"], ready: false, operation: null,
      reviewBinding: "A".repeat(43), billingEmail: "customer@example.com", paymentMethods: { ach: false, card: false },
    },
  } }));
  return { owner, quote, invoice };
}

function resultPage(kind: "customers" | "items", startPosition: number, query = "Match") {
  const candidates = Array.from({ length: startPosition === 31 ? 1 : 10 }, (_, index) => {
    const id = startPosition + index;
    return kind === "customers"
      ? { quickBooksCustomerId: `customer-${id}`, displayName: `${query} ${id}`, email: null }
      : { quickBooksItemId: `item-${id}`, name: `${query} ${id}`, type: "Service" };
  });
  return { candidates, page: { startPosition, limit: 10, hasMore: startPosition < 31, nextStartPosition: startPosition < 31 ? startPosition + 10 : null } };
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
  await page.setViewportSize({ width: 390, height: 844 });
});

test("customer and item mappings beyond the first 25 matches remain reachable and require canonical review on mobile", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const { owner, quote } = await seed(request, page);
  const reviewed: Array<Record<string, unknown>> = [];
  for (const kind of ["customers", "items"] as const) {
    await page.route(`**/v1/integrations/quickbooks/mappings/${kind}/search`, (route) => {
      const body = route.request().postDataJSON();
      expect(body.limit).toBe(10);
      return route.fulfill({ json: resultPage(kind, body.startPosition) });
    });
  }
  await page.route("**/v1/integrations/quickbooks/mappings/*/review", (route) => {
    reviewed.push(route.request().postDataJSON());
    return route.fulfill({ json: { reviewed: true } });
  });
  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  for (const kind of ["customers", "items"] as const) {
    const label = kind === "customers" ? "Customer matches" : "Item matches for Mapping repair";
    const input = panel.getByLabel(kind === "customers" ? "Search QuickBooks customers" : "Search QuickBooks products and services", { exact: true });
    await input.fill("Match");
    await input.press("Enter");
    const list = panel.getByRole("list", { name: label, exact: true });
    await expect(list.getByRole("button")).toHaveCount(10);
    const next = panel.getByRole("button", { name: `Next ${label}`, exact: true });
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const start of [11, 21, 31]) {
      await next.click();
      await expect(list.getByRole("button").first()).toContainText(`Match ${start}`);
      await expect(list).toBeFocused();
      await expect(list.getByRole("button")).toHaveCount(start === 31 ? 1 : 10);
    }
    await expect(next).toBeDisabled();
    await list.getByRole("button").click();
    await expect(list.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(reviewed).toHaveLength(kind === "customers" ? 0 : 1);
    if (kind === "customers") await panel.getByRole("button", { name: "Review mapping", exact: true }).click();
    else await panel.getByRole("button", { name: "Review item mapping for Mapping repair", exact: true }).click();
    await expect.poll(() => reviewed.length).toBe(kind === "customers" ? 1 : 2);
    await expect(list).toHaveCount(0);
  }
  expect(reviewed[0]).toMatchObject({ quickBooksCustomerId: "customer-31" });
  expect(reviewed[1]).toMatchObject({ quickBooksItemId: "item-31", itemKey: "repair" });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

for (const kind of ["customers", "items"] as const) {
  test(`changing the ${kind} search fences a delayed next page`, async ({ context, page, request }) => {
    test.setTimeout(120_000);
    const { owner, quote } = await seed(request, page);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    await page.route(`**/v1/integrations/quickbooks/mappings/${kind}/search`, async (route) => {
      const body = route.request().postDataJSON();
      if (body.startPosition === 11) { started(); await held; }
      await route.fulfill({ json: resultPage(kind, body.startPosition, body.query) });
    });
    await addSessionCookie(context, owner);
    await page.goto(`/app/quotes/${quote.id}`);
    const panel = page.getByTestId("quickbooks-invoice-panel");
    const input = panel.getByLabel(kind === "customers" ? "Search QuickBooks customers" : "Search QuickBooks products and services", { exact: true });
    const label = kind === "customers" ? "Customer matches" : "Item matches for Mapping repair";
    const list = panel.getByRole("list", { name: label, exact: true });
    await input.fill("Old");
    await input.press("Enter");
    await panel.getByRole("button", { name: `Next ${label}`, exact: true }).click();
    await began;
    await input.fill("New");
    await expect(list).toHaveCount(0);
    await input.press("Enter");
    await expect(list.getByRole("button").first()).toContainText("New 1");
    const completed = page.waitForResponse((response) => response.url().includes(`/mappings/${kind}/search`) && response.request().postDataJSON().startPosition === 11);
    release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(list.getByRole("button").first()).toContainText("New 1");
    await expect(list).not.toContainText("Old");
    await expect(input).toBeFocused();
  });
}

test("failed mapping pagination retains the current page for retry and supports previous matches", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const { owner, quote } = await seed(request, page);
  let failNext = true;
  await page.route("**/v1/integrations/quickbooks/mappings/customers/search", (route) => {
    const { startPosition } = route.request().postDataJSON();
    if (startPosition === 11 && failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    }
    return route.fulfill({ json: resultPage("customers", startPosition) });
  });
  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  await panel.getByLabel("Search QuickBooks customers", { exact: true }).press("Enter");
  const list = panel.getByRole("list", { name: "Customer matches", exact: true });
  const next = panel.getByRole("button", { name: "Next Customer matches", exact: true });
  await next.click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(list.getByRole("button").first()).toContainText("Match 1");
  await expect(next).toBeEnabled();
  await next.click();
  await expect(list.getByRole("button").first()).toContainText("Match 11");
  await panel.getByRole("button", { name: "Previous Customer matches", exact: true }).click();
  await expect(list.getByRole("button").first()).toContainText("Match 1");
  await expect(list).toBeFocused();
});

test("a secure payment-link fetch also refreshes canonical payment totals and invoice badges", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const seeded = await seed(request, page);
  let current = { ...seeded.invoice, status: "OPEN" };
  await page.route(`**/v1/invoices/${current.id}`, (route) => route.fulfill({ json: { invoice: current } }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${current.id}/sync-preview`, (route) => route.fulfill({ json: {
    providerWorkflowsEnabled: true, preview: {
      invoice: { ...current, customerName: "Mapping Customer" },
      connection: { companyName: "Mapping Sandbox", status: "CONNECTED" }, lineItems: [], blockers: [], ready: true,
      operation: { status: "SUCCEEDED", paymentLinkAvailable: true, providerDocNumber: "QF-000001" },
    },
  } }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${current.id}/payment-link`, (route) => {
    current = { ...current, version: current.version + 1, status: "PAID", paymentStatus: "SUCCEEDED", amountPaid: Number(current.totalAmount), balanceDue: 0 };
    return route.fulfill({ json: { invoiceId: current.id, hostedPaymentUrl: "https://connect.intuit.com/portal/fixture", paymentStatus: "SUCCEEDED", balanceDue: 0 } });
  });
  await addSessionCookie(context, seeded.owner);
  await page.goto(`/app/quotes/${seeded.quote.id}`);
  const panel = page.getByTestId("invoice-panel");
  await expect(panel.getByText("Open", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Get secure payment page", exact: true }).click();
  await expect(panel.getByText("Paid", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Balance due", { exact: true }).locator("..")).toContainText("$0.00");
  await expect(panel.getByRole("link", { name: "Open secure QuickBooks payment page", exact: true })).toHaveAttribute("href", "https://connect.intuit.com/portal/fixture");
});

test("mapping pages handle legacy responses, empty live pages, and the bounded search limit", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const { owner, quote } = await seed(request, page);
  await page.route("**/v1/integrations/quickbooks/mappings/customers/search", (route) => {
    const { query, startPosition } = route.request().postDataJSON();
    const response = resultPage("customers", startPosition);
    if (query === "Legacy") return route.fulfill({ json: { candidates: response.candidates } });
    if (query === "Bounded") return route.fulfill({ json: { ...response, page: { startPosition: 1_000_000, limit: 10, hasMore: true, nextStartPosition: null } } });
    if (startPosition === 11) return route.fulfill({ json: { candidates: [], page: { startPosition, limit: 10, hasMore: false, nextStartPosition: null } } });
    return route.fulfill({ json: response });
  });
  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  const input = panel.getByLabel("Search QuickBooks customers", { exact: true });
  const next = panel.getByRole("button", { name: "Next Customer matches", exact: true });
  await input.fill("Legacy");
  await input.press("Enter");
  await expect(next).toBeDisabled();
  await input.fill("Live");
  await input.press("Enter");
  await next.click();
  await expect(panel.getByText("No customer matches on this page", { exact: true }).last()).toBeVisible();
  await expect(panel.getByRole("group", { name: "Pages for Customer matches", exact: true })).toBeFocused();
  await input.fill("Bounded");
  await input.press("Enter");
  await expect(panel.getByText("More matches exist. Enter a more specific name to narrow this search.", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
});
