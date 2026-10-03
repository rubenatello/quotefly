import { expect, test, type Page } from "@playwright/test";
import type { Invoice, InvoiceTaxContextForm } from "../../web/src/lib/api";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

const address = { Line1: "100 Test Street", City: "Sacramento", CountrySubDivisionCode: "CA", PostalCode: "95814", Country: "US" as const };
async function seed(page: Page, request: Parameters<typeof signUpViaApi>[0], context: Parameters<typeof addSessionCookie>[0]) {
  const owner = await signUpViaApi(request, "qbo-tax-form");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Synthetic tax review customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Synthetic tax review job" });
  expect((await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, { headers: { Cookie: owner.cookieHeader }, data: { status: "ACCEPTED" } })).status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, { headers: { Cookie: owner.cookieHeader, "Idempotency-Key": crypto.randomUUID() }, data: { sourceQuoteId: quote.id } });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()).invoice as Invoice;
  const lines = invoice.lineItems.filter(line => line.sectionType === "INCLUDED");
  let mappingVersion = 1;
  const form: InvoiceTaxContextForm = {
    invoice: { id: invoice.id, version: invoice.version, currency: "USD", subtotalAmount: String(invoice.subtotalAmount), taxAmount: String(invoice.taxAmount), totalAmount: String(invoice.totalAmount),
      lines: lines.map(line => ({ invoiceLineItemId: line.id, position: line.position, description: line.description, quantity: String(line.quantity), unitPrice: String(line.unitPrice), amount: String(line.lineTotal), mapping: { reviewed: true, displayName: "Test service" } })) },
    currentContext: { revision: null, current: false, staleReason: null, decisions: null, confirmedAtUtc: null },
    suggestions: { origin: address, destination: null }, expectedContextRevision: 0, sourceToken: "synthetic-form-token",
    sourceTokenExpiresAtUtc: new Date(Date.now() + 900_000).toISOString(), taxCalculationProven: false, publishingAuthorized: false,
  };
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`, route => route.fulfill({ json: { providerWorkflowsEnabled: true, preview: {
    invoice: { ...invoice, customerName: customer.fullName }, connection: { companyName: "Tax form sandbox", status: "CONNECTED" },
    customerMapping: { quickBooksCustomerId: "synthetic-customer", quickBooksDisplayName: "Test customer", reviewedAtUtc: new Date(mappingVersion * 1000).toISOString() },
    lineItems: lines.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, amount: line.lineTotal, itemKey: line.description,
      mapped: true, quickBooksItemId: "synthetic-item", quickBooksItemName: "Test service", reviewedAtUtc: new Date(mappingVersion * 1000).toISOString() })),
    quickBooksCustomerName: "Test customer", providerDocNumber: "QF-TEST", blockers: [], ready: true, reviewBinding: "A".repeat(43), operation: null,
    billingEmail: null, paymentMethods: { ach: false, card: false },
  } } }));
  await addSessionCookie(context, owner);
  return { owner, invoice, quote, form, changeMapping: () => { mappingVersion += 1; } };
}
async function fill(page: Page) {
  const section = page.getByTestId("invoice-tax-context");
  await section.getByLabel("Transaction date", { exact: true }).fill("2026-09-23");
  const destination = section.getByRole("group", { name: "Service or delivery address", exact: true });
  await destination.getByLabel("Street address", { exact: true }).fill("200 Example Avenue");
  await destination.getByLabel("City", { exact: true }).fill("Sacramento");
  await destination.getByLabel("State", { exact: true }).selectOption("CA");
  await destination.getByLabel("ZIP code", { exact: true }).fill("95814");
  for (const radio of await section.getByRole("radio", { name: "Taxable", exact: true }).all()) await radio.check();
}

test.beforeEach(async ({ context }) => { await context.addInitScript(() => { if (!localStorage.getItem("qf_locale")) localStorage.setItem("qf_locale", "en-US"); }); });

test("tax details require explicit decisions, focus invalid fields, and send only capture intent", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let submitted: Record<string, unknown> | null = null;
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: fixture.form });
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { context: { revision: 1, current: true, staleReason: null, confirmedAtUtc: new Date().toISOString() }, replayed: false, taxCalculationProven: false, publishingAuthorized: false } });
  });
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("");
  await expect(section.getByRole("radio").first()).not.toBeChecked();
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toBeFocused();
  await page.screenshot({ path: ".codex_tmp/tax-context-desktop-viewport-validation.png" });
  const state = section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("State", { exact: true });
  await expect(state).toHaveAttribute("aria-invalid", "true");
  await expect(state).toHaveAttribute("aria-describedby", /-error$/);
  await fill(page);
  await expect(page.getByRole("button", { name: "Review QuickBooks draft", exact: true })).toHaveCount(0);
  await section.screenshot({ path: ".codex_tmp/tax-context-desktop.png" });
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".codex_tmp/tax-context-desktop-viewport-actions.png" });
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect.poll(() => submitted !== null).toBe(true);
  expect(Object.keys(submitted!).sort()).toEqual(["commandKey", "destination", "expectedContextRevision", "lines", "origin", "sourceToken", "transactionDate"]);
  expect((submitted!.lines as Array<{ invoiceLineItemId: string }>).map(line => line.invoiceLineItemId)).toEqual(fixture.form.invoice.lines.map(line => line.invoiceLineItemId));
  await expect(page.getByText("Tax details saved. Tax has not been calculated and no QuickBooks invoice was created.")).toHaveCount(1);
});

test("stale tax review reload preserves edits and a failed request retains its command key", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  const commands: string[] = [];
  let postCount = 0;
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: fixture.form });
    postCount += 1; commands.push(route.request().postDataJSON().commandKey);
    await route.fulfill({ status: postCount === 1 ? 409 : 503, json: { error: "Review unavailable", code: postCount === 1 ? "QUICKBOOKS_TAX_FORM_CHANGED" : "QUICKBOOKS_OAUTH_ONLY_MODE" } });
  });
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await fill(page);
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect(section.getByRole("button", { name: "Confirm tax details", exact: true })).toBeDisabled();
  await section.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toBe(commands[0]);
  await section.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Discard unsaved tax details?" })).toBeVisible();
  await page.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(section.getByRole("button", { name: "Review tax details", exact: true })).toBeFocused();
});

test("mobile tax details keep controls usable and pause mapping changes while edited", async ({ page, request, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await seed(page, request, context);
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await fill(page);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  await expect(panel.getByRole("button", { name: "Review mapping", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("button", { name: "Confirm tax details", exact: true })).toBeEnabled();
  for (const button of await section.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await section.screenshot({ path: ".codex_tmp/tax-context-mobile.png" });
  await section.getByLabel("Transaction date", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".codex_tmp/tax-context-mobile-viewport-fields.png" });
  await section.getByRole("button", { name: "Reload review", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".codex_tmp/tax-context-mobile-viewport-actions.png" });
});

for (const change of ["mapping", "payment"] as const) {
  for (const alreadyOpen of [false, true]) test(`unreviewed ${change} changes pause ${alreadyOpen ? "open" : "closed"} tax details without losing values`, async ({ page, request, context }) => {
    const fixture = await seed(page, request, context);
    let taxPosts = 0;
    await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => {
      if (route.request().method() === "POST") taxPosts += 1;
      return route.fulfill({ json: fixture.form });
    });
    await page.goto(`/app/quotes/${fixture.quote.id}`);
    const panel = page.getByTestId("quickbooks-invoice-panel");
    const section = page.getByTestId("invoice-tax-context");
    const open = section.getByRole("button", { name: "Review tax details", exact: true });
    await expect(open).toBeEnabled();
    if (alreadyOpen) {
      await open.click();
      await expect(section.getByLabel("Transaction date", { exact: true })).toBeEnabled();
    }
    if (change === "mapping") {
      await panel.getByText("Enter a QuickBooks ID instead", { exact: true }).first().click();
      await panel.getByLabel("QuickBooks customer ID", { exact: true }).fill("unreviewed-customer");
    } else {
      await panel.getByLabel("Customer billing email", { exact: true }).fill("pending@example.test");
      await panel.getByLabel("Allow bank transfer (ACH)", { exact: true }).check();
      await panel.getByLabel("Allow card payment", { exact: true }).check();
    }
    await expect(panel.getByText("Review or reset your QuickBooks mapping and payment changes before editing tax details.", { exact: true })).toBeVisible();
    if (alreadyOpen) {
      await expect(section.getByRole("button", { name: "Confirm tax details", exact: true })).toBeDisabled();
      await expect(section.getByLabel("Transaction date", { exact: true })).toBeDisabled();
    } else await expect(open).toBeDisabled();
    if (change === "mapping") await expect(panel.getByLabel("QuickBooks customer ID", { exact: true })).toHaveValue("unreviewed-customer");
    else {
      await expect(panel.getByLabel("Customer billing email", { exact: true })).toHaveValue("pending@example.test");
      await expect(panel.getByLabel("Allow bank transfer (ACH)", { exact: true })).toBeChecked();
      await expect(panel.getByLabel("Allow card payment", { exact: true })).toBeChecked();
    }
    expect(taxPosts).toBe(0);
    if (change === "mapping" && !alreadyOpen) {
      await panel.getByText("Review or reset your QuickBooks mapping and payment changes before editing tax details.", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: ".codex_tmp/tax-qb-review-pending-desktop.png" });
    }
    await panel.getByRole("button", { name: "Reset changes", exact: true }).click();
    await expect(alreadyOpen ? section.getByLabel("Transaction date", { exact: true }) : open).toBeEnabled();
    expect(taxPosts).toBe(0);
  });
}

test("pending and saving tax details pause customer, item and payment edits until confirmation finishes", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let taxPosts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: fixture.form });
    taxPosts += 1;
    await held;
    return route.fulfill({ json: { context: { revision: 1, current: true, staleReason: null, confirmedAtUtc: new Date().toISOString() }, replayed: false, taxCalculationProven: false, publishingAuthorized: false } });
  });
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  const section = page.getByTestId("invoice-tax-context");
  await panel.getByText("Enter a QuickBooks ID instead", { exact: true }).first().click();
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await fill(page);
  const assertPaused = async () => {
    for (const control of await panel.getByTestId("quickbooks-mapping-controls").locator("input,button").all()) {
      await expect(control).toBeDisabled();
    }
    await expect(panel.getByLabel("QuickBooks customer ID", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("QuickBooks customer ID", { exact: true })).toHaveValue("synthetic-customer");
    await expect(panel.getByLabel("Customer billing email", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Allow bank transfer (ACH)", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Allow card payment", { exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Review mapping", exact: true })).toBeDisabled();
    await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  };
  await assertPaused();
  await panel.getByText("Save or discard your tax details before changing QuickBooks mappings or payment choices.", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".codex_tmp/tax-context-pending-desktop.png" });
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  try {
    await expect.poll(() => taxPosts).toBe(1);
    await assertPaused();
  } finally { release(); }
  await expect(panel.getByLabel("Customer billing email", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("QuickBooks customer ID", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("QuickBooks customer ID", { exact: true })).toHaveValue("synthetic-customer");
  expect(taxPosts).toBe(1);
});

for (const width of [390, 360]) test(`tax fields stay above fixed navigation at ${width}px`, async ({ page, request, context }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
  const fixture = await seed(page, request, context);
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toBeVisible();
  await expect(page.locator('.qf-mobile-action-dock')).toHaveCount(0);
  for (const control of await section.locator('input,select,button').all()) {
    if (await control.isDisabled()) continue;
    await control.focus();
    await expect.poll(() => control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element === hit || element.contains(hit);
    })).toBe(true);
  }
  await section.getByLabel("Transaction date", { exact: true }).focus();
  await page.screenshot({ path: `.codex_tmp/tax-context-mobile-${width}-focus.png` });
});

test("tax edits guard route navigation and browser unload without persisting private drafts", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await fill(page);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(true);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('200 Example Avenue');
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('synthetic-form-token');
  await page.locator(".qf-sidebar-nav-item").getByText("Customers", {exact:true}).click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved tax details?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue('2026-09-23');
  await page.locator(".qf-sidebar-nav-item").getByText("Customers", {exact:true}).click();
  await dialog.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/customers$/);
});

for (const status of [403, 404, 503]) test(`tax source ${status} uses fixed recoverable copy`, async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let failed = true;
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => failed
    ? route.fulfill({ status, json: { error: 'private-provider-error-do-not-display' } })
    : route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await expect(section.getByRole('button', { name: 'Reload review', exact: true })).toBeEnabled();
  await expect(section).not.toContainText('private-provider-error-do-not-display');
  await expect(section).toContainText(status === 403 ? 'active owner or admin' : status === 404 ? 'no longer available' : 'paused');
  failed = false;
  await section.getByRole('button', { name: 'Reload review', exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toBeVisible();
});

for (const mode of ['light', 'dark'] as const) test(`tax validation is readable in ${mode} mode with reduced motion`, async ({ page, request, context }) => {
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem('qf_theme_preference', theme); localStorage.setItem('qf_locale', locale);
  }, { theme: mode, locale: mode === 'dark' ? 'es-US' : 'en-US' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await seed(page, request, context);
  expect((await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: fixture.owner.cookieHeader }, data: { preferredLocale: mode === 'dark' ? 'es-US' : 'en-US' },
  })).status()).toBe(200);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async route => {
    await held; await route.fulfill({ json: fixture.form });
  });
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId('invoice-tax-context');
  await section.getByRole('button', { name: mode === 'dark' ? 'Revisar datos fiscales' : 'Review tax details', exact: true }).click();
  try {
    const spinner = section.locator('svg.animate-spin');
    await expect(spinner).toBeVisible();
    expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  } finally { release(); }
  const confirm = section.getByRole('button', { name: mode === 'dark' ? 'Confirmar datos fiscales' : 'Confirm tax details', exact: true });
  await confirm.click();
  const date = section.locator('input[type="date"]');
  await expect(date).toBeFocused();
  const errorId = await date.getAttribute('aria-describedby');
  expect(errorId).toBeTruthy();
  const contrast = await page.locator(`[id="${errorId}"]`).evaluate(element => {
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    let ancestor: Element | null = element;
    let background = [255, 255, 255];
    while (ancestor) {
      const parsed = channels(getComputedStyle(ancestor).backgroundColor);
      if (parsed.length === 3 || parsed[3] === 1) { background = parsed; break; }
      ancestor = ancestor.parentElement;
    }
    const a = luminance(channels(getComputedStyle(element).color)); const b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: `.codex_tmp/tax-context-${mode}-validation.png` });
});

test("notification handoff keeps tax edits and keyboard focus on cancellation", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  const now = new Date().toISOString();
  const notification = { id: 'synthetic-notification', appointmentId: 'synthetic-appointment', kind: 'BOOKED',
    templateKey: 'job_appointment_booked', templateVersion: 1, sourceVersion: 1, startsAtUtc: now, endsAtUtc: now,
    timeZone: 'America/Los_Angeles', deliveryStatus: 'AVAILABLE', deliveredAtUtc: null, readAtUtc: null, version: 1, createdAt: now, updatedAt: now,
    job: { id: fixture.invoice.job!.id, jobNumber: 1, title: 'Synthetic tax job', customer: { id: 'synthetic-customer', fullName: 'Synthetic customer' } } };
  await page.route('**/v1/notifications**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/summary')
    ? { unreadCount: 1, totalCount: 1, latestCreatedAtUtc: now }
    : { items: [notification], page: { limit: 25, hasMore: false, nextCursor: null } } }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId('invoice-tax-context');
  await section.getByRole('button', { name: 'Review tax details', exact: true }).click(); await fill(page);
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).filter({ visible: true });
  await bell.click();
  const center = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await center.getByRole('button', { name: 'Open job', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved tax details?' });
  await expect(dialog).toBeVisible(); await expect(center).toBeHidden();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${fixture.quote.id}$`));
  await expect(section.getByLabel('Transaction date', { exact: true })).toHaveValue('2026-09-23');
  await expect(bell).toBeFocused();
});

for (const { mobile, kind } of [
  { mobile: false, kind: 'workspace' }, { mobile: true, kind: 'workspace' },
  { mobile: true, kind: 'booking' }, { mobile: true, kind: 'dispatch' },
]) test(`Kody navigation can be canceled without consuming its action or tax edits${mobile ? ' on mobile' : ''}${kind === 'workspace' ? '' : ` (${kind} review)`}`, async ({ page, request, context }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await seed(page, request, context);
  const reviewPayload = { mode: 'CREATE', jobId: fixture.invoice.jobId, jobNumber: 1, jobTitle: 'Synthetic tax review job',
    customerId: fixture.invoice.customerId, customerName: 'Synthetic tax review customer', assignedTenantUserId: 'synthetic-assignee',
    assigneeName: 'Synthetic owner', startsAtUtc: '2026-09-25T16:00:00.000Z', endsAtUtc: '2026-09-25T17:00:00.000Z',
    timeZone: 'America/Los_Angeles', appointmentId: 'synthetic-appointment', appointmentVersion: 1, expectedStatus: 'SCHEDULED' };
  const actionName = kind === 'workspace' ? 'Open page' : kind === 'booking' ? 'Review booking' : 'Review dispatch';
  await page.route('**/v1/ai/assistant', route => route.fulfill({ json: { assistant: {
    tool: 'SEARCH_JOBS', generatedAtUtc: new Date().toISOString(), policyVersion: '2026-08-22', maxClassification: 'C2_CUSTOMER_CONFIDENTIAL',
    answer: 'Open Customers to review customer records.', results: [], citations: [],
    actions: [{ type: kind === 'workspace' ? 'OPEN_WORKSPACE_PAGE' : kind === 'booking' ? 'OPEN_BOOKING_REVIEW' : 'OPEN_DISPATCH_REVIEW',
      label: actionName, requiresConfirmation: false, payload: kind === 'workspace' ? { page: 'customers' } : reviewPayload }],
    auditEventId: 'synthetic-navigation-test', fieldsExcluded: [],
    conversation: { mode: 'NEW', acknowledgement: null, previousTool: null, currentTool: 'SEARCH_JOBS' },
    diagnostics: { requestedTool: 'SEARCH_JOBS', resolvedTool: 'SEARCH_JOBS', resultCount: 0, citationCount: 0, emptyReason: null, archivePolicy: 'Active only', filters: {} },
  } } }));
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId('invoice-tax-context');
  await section.getByRole('button', { name: 'Review tax details', exact: true }).click(); await fill(page);
  const kodyTrigger = mobile ? page.getByRole('button', { name: 'Book with Kody', exact: true }) : page.getByTestId('kody-launcher');
  await kodyTrigger.click();
  const kody = page.getByTestId('kody-chat-panel');
  await kody.getByTestId('kody-prompt').fill('Open Customers');
  await kody.getByRole('button', { name: 'Send', exact: true }).click();
  const action = kody.getByRole('button', { name: actionName, exact: true });
  await action.click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved tax details?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${fixture.quote.id}$`));
  await expect(section.getByLabel('Transaction date', { exact: true })).toHaveValue('2026-09-23');
  if (mobile) {
    await expect(kody).toBeHidden();
    await expect(kodyTrigger).toBeFocused();
    await kodyTrigger.click();
  } else await expect(action).toBeFocused();
  await expect(action).toBeVisible();
  if (kind !== 'workspace') return;
  await action.click();
  await dialog.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/customers$/); await expect(dialog).toBeHidden();
});

test("a delayed checkout response cannot leave tax details entered after checkout started", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let releaseCheckout!: () => void;
  const heldCheckout = new Promise<void>(resolve => { releaseCheckout = resolve; });
  let checkoutRequests = 0;
  let checkoutNavigations = 0;
  await page.route('**/v1/billing/checkout-session', async route => {
    checkoutRequests += 1;
    await heldCheckout;
    await route.fulfill({ json: { checkoutUrl: `${page.url().split('/app/')[0]}/synthetic-checkout-destination` } });
  });
  await page.route('**/synthetic-checkout-destination', route => {
    checkoutNavigations += 1;
    return route.fulfill({ body: 'Unexpected checkout departure' });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, route => route.fulfill({ json: fixture.form }));
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const checkout = page.getByRole('button', { name: /Choose Basic/ });
  await checkout.click();
  await expect.poll(() => checkoutRequests).toBe(1);
  await expect(checkout).toHaveAttribute('aria-busy', 'true');
  const section = page.getByTestId('invoice-tax-context');
  await section.getByRole('button', { name: 'Review tax details', exact: true }).click();
  await fill(page);
  const response = page.waitForResponse('**/v1/billing/checkout-session');
  releaseCheckout();
  await response;
  await expect(checkout).not.toHaveAttribute('aria-busy', 'true');
  await expect(checkout).toBeDisabled();
  await expect(page.getByText('Save or discard your changes before choosing a plan.', { exact: true })).toBeVisible();
  await expect(section.getByLabel('Transaction date', { exact: true })).toHaveValue('2026-09-23');
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${fixture.quote.id}$`));
  expect(checkoutNavigations).toBe(0);
});

test("a lost successful tax-save response keeps its command identity after revision advances", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  const submissions: Array<{ commandKey: string; expectedContextRevision: number }> = [];
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: fixture.form });
    const body = route.request().postDataJSON();
    submissions.push(body);
    if (submissions.length === 1) {
      fixture.form.expectedContextRevision = 1;
      fixture.form.sourceToken = "synthetic-reissued-form-token";
      fixture.form.currentContext = { revision: 1, current: true, staleReason: null, confirmedAtUtc: new Date().toISOString(),
        decisions: { transactionDate: body.transactionDate, origin: body.origin, destination: body.destination, lines: body.lines } };
      return route.fulfill({ status: 503, json: { error: "Response unavailable" } });
    }
    await route.fulfill({ json: { context: { revision: 1, current: true, staleReason: null, confirmedAtUtc: new Date().toISOString() }, replayed: true, taxCalculationProven: false, publishingAuthorized: false } });
  });
  await page.goto(`/app/quotes/${fixture.quote.id}`);
  const section = page.getByTestId("invoice-tax-context");
  await section.getByRole("button", { name: "Review tax details", exact: true }).click();
  await fill(page);
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await section.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(section.getByRole("button", { name: "Confirm tax details", exact: true })).toBeEnabled();
  await section.getByRole("button", { name: "Confirm tax details", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions.map(entry => entry.expectedContextRevision)).toEqual([0, 1]);
  expect(submissions[1].commandKey).toBe(submissions[0].commandKey);
  await expect(page.getByText("Tax details saved. Tax has not been calculated and no QuickBooks invoice was created.")).toBeVisible();
});
