import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Invoice, InvoiceTaxContextForm } from "../../web/src/lib/api";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, createQuoteViaApi, signUpViaApi } from "./helpers";

const address = {
  Line1: "100 Test Street",
  City: "Sacramento",
  CountrySubDivisionCode: "CA",
  PostalCode: "95814",
  Country: "US" as const,
};

type JobFixture = {
  id: string;
  version: number;
  sourceQuoteId: string;
  accessInstructions: string | null;
};

async function getJob(request: APIRequestContext, cookieHeader: string, jobId: string): Promise<JobFixture> {
  const response = await request.get(`${apiBaseUrl}/v1/jobs/${jobId}`, { headers: { Cookie: cookieHeader } });
  expect(response.status()).toBe(200);
  return (await response.json()).job as JobFixture;
}

async function seed(page: Page, request: APIRequestContext, context: Parameters<typeof addSessionCookie>[0]) {
  const owner = await signUpViaApi(request, "qbo-tax-job-guard");
  const customer = await createCustomerViaApi(request, owner, { fullName: "Synthetic job tax review customer" });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Synthetic job tax review" });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);

  const jobsResponse = await request.get(`${apiBaseUrl}/v1/jobs?search=${encodeURIComponent(quote.title)}&limit=25&offset=0`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(jobsResponse.status()).toBe(200);
  const jobs = (await jobsResponse.json()) as { items: JobFixture[] };
  const job = jobs.items.find((item) => item.sourceQuoteId === quote.id);
  expect(job).toBeTruthy();
  if (!job) throw new Error("Accepted quote did not create a synthetic job");

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
    sourceToken: "synthetic-job-form-token",
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
  return { owner, quote, job, invoice };
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

async function exposeReloadLatestJob(page: Page, request: APIRequestContext, fixture: Awaited<ReturnType<typeof seed>>) {
  const currentJob = await getJob(request, fixture.owner.cookieHeader, fixture.job.id);
  const externalUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${currentJob.id}`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: { version: currentJob.version, accessInstructions: "Synthetic external job update." },
  });
  expect(externalUpdate.status()).toBe(200);
  await page.getByRole("textbox", { name: "Access instructions", exact: true }).fill("Synthetic stale job edit.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  const reload = page.getByRole("button", { name: "Reload latest job", exact: true });
  await expect(reload).toBeVisible();
  return reload;
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("qf_locale", "en-US"));
});

test("job tax save blocks sidebar and browser-back navigation until a failed save settles", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  let releaseSave: (() => void) | undefined;
  const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
  let saveStarted = false;
  await page.route(`**/v1/integrations/quickbooks/invoices/${fixture.invoice.id}/tax-context`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saveStarted = true;
    await saveHeld;
    return route.fulfill({ status: 500, json: { error: "Synthetic tax save failure." } });
  });

  await page.goto("/app/jobs");
  const jobCard = page.getByRole("article").filter({ hasText: fixture.quote.title });
  await expect(jobCard).toBeVisible();
  await jobCard.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  const section = await openAndFillTaxContext(page);
  const save = section.getByRole("button", { name: "Confirm tax details", exact: true });
  await save.click();
  await expect.poll(() => saveStarted).toBe(true);

  const sidebarCustomers = page.getByRole("button", { name: "Customers", exact: true });
  await sidebarCustomers.click();
  const savingDialog = page.getByRole("dialog", { name: "Saving tax details", exact: true });
  await expect(savingDialog).toBeVisible();
  await expect(savingDialog.getByRole("button", { name: "Saving tax details", exact: true })).toBeDisabled();
  await savingDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");

  const browserBack = page.goBack();
  await expect(savingDialog).toBeVisible();
  await expect(savingDialog.getByRole("button", { name: "Saving tax details", exact: true })).toBeDisabled();

  releaseSave?.();
  await expect(savingDialog).toBeHidden();
  await browserBack;
  await expect(save).toBeEnabled();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");
  await sidebarCustomers.click();
  const leaveDialog = page.getByRole("dialog", { name: "Discard unsaved tax details?", exact: true });
  await expect(leaveDialog).toBeVisible();
  await expect(leaveDialog.getByRole("button", { name: "Discard and leave", exact: true })).toBeEnabled();
  await leaveDialog.getByRole("button", { name: "Discard and leave", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/app/customers");
});

test("a transient job reload keeps pending tax details mounted", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  await page.goto(`/app/jobs/${fixture.job.id}`);
  const section = await openAndFillTaxContext(page);
  const reload = await exposeReloadLatestJob(page, request, fixture);
  let failRefresh = true;
  let releaseRetry!: () => void;
  const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route(`**/v1/jobs/${fixture.job.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (!failRefresh) { await heldRetry; return route.fallback(); }
    return route.fulfill({ status: 503, json: { error: "Synthetic transient job refresh failure." } });
  });

  await reload.click();
  const refreshError = page.getByTestId("job-refresh-error");
  await expect(refreshError.getByRole("alert")).toBeVisible();
  await expect(refreshError.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(section).toBeVisible();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");
  failRefresh = false;
  await refreshError.getByRole("button", { name: "Try again", exact: true }).click();
  try {
    await expect(page.getByRole("status").filter({ hasText: "Loading job" })).toBeVisible();
    await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  } finally { releaseRetry(); }
  await expect(refreshError).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Loading job" })).toBeHidden();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");
});

for (const status of [401, 403, 404]) {
  test(`a ${status} job reload clears pending private tax details`, async ({ page, request, context }) => {
    const fixture = await seed(page, request, context);
    await page.goto(`/app/jobs/${fixture.job.id}`);
    const section = await openAndFillTaxContext(page);
    const reload = await exposeReloadLatestJob(page, request, fixture);
    await page.route(`**/v1/jobs/${fixture.job.id}`, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ status, json: { error: "Synthetic unavailable job." } });
    });

    await reload.click();
    if (status !== 401) await expect(page.getByText("Job could not be loaded.", { exact: true })).toBeVisible();
    await expect(section).toBeHidden();
    await expect(page.getByLabel("Transaction date", { exact: true })).toHaveCount(0);
  });
}

test("job tax edits survive job version refreshes and guarded button navigation", async ({ page, request, context }) => {
  const fixture = await seed(page, request, context);
  await page.goto(`/app/jobs/${fixture.job.id}`);
  await expect(page.getByTestId("invoice-panel")).toBeVisible();
  const section = await openAndFillTaxContext(page);

  const accessInstructions = page.getByRole("textbox", { name: "Access instructions", exact: true });
  await accessInstructions.fill("Saved job update while tax details are pending.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");

  const currentJob = await getJob(request, fixture.owner.cookieHeader, fixture.job.id);
  const externalUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${currentJob.id}`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: { version: currentJob.version, accessInstructions: "Synthetic stale version update." },
  });
  expect(externalUpdate.status()).toBe(200);
  await accessInstructions.fill("This triggers the stale version path.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await page.getByRole("button", { name: "Reload latest job", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");
  await expect(section.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("200 Example Avenue");

  await page.getByRole("button", { name: "Back to jobs", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard unsaved tax details?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");

  await page.getByRole("button", { name: "Open quote", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");

  await page.getByRole("button", { name: "Back to jobs", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard and leave", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/app/jobs");
});

for (const viewport of [null, { width: 390, height: 844 }] as const) test(`job tax edits cancel browser back, prevent unload, and never persist private draft data${viewport ? " on mobile" : ""}`, async ({ page, request, context }) => {
  if (viewport) await page.setViewportSize(viewport);
  const fixture = await seed(page, request, context);
  await page.goto("/app/jobs");
  const jobCard = page.getByRole("article").filter({ hasText: fixture.quote.title });
  await expect(jobCard).toBeVisible();
  await jobCard.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  const section = await openAndFillTaxContext(page);

  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain("200 Example Avenue");
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain("synthetic-job-form-token");

  const prompt = page.waitForEvent("dialog");
  const back = page.goBack();
  const browserDialog = await prompt;
  expect(browserDialog.message()).toBe("You have unsaved tax details. Leave and discard them?");
  await browserDialog.dismiss();
  await back;
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  await expect(section.getByLabel("Transaction date", { exact: true })).toHaveValue("2026-09-23");

  const approvedPrompt = page.waitForEvent("dialog");
  const approvedBack = page.goBack();
  const approvedDialog = await approvedPrompt;
  expect(approvedDialog.message()).toBe("You have unsaved tax details. Leave and discard them?");
  await approvedDialog.accept();
  await approvedBack;
  await expect(page).toHaveURL((url) => url.pathname === "/app/jobs");

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  const freshSection = page.getByTestId("invoice-tax-context");
  await freshSection.getByRole("button", { name: "Review tax details", exact: true }).click();
  await expect(freshSection.getByLabel("Transaction date", { exact: true })).toHaveValue("");
  await expect(freshSection.getByRole("group", { name: "Service or delivery address", exact: true }).getByLabel("Street address", { exact: true })).toHaveValue("");
});
