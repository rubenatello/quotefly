import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

type JobPayload = {
  job: {
    id: string;
    version: number;
    assignedTenantUserId: string | null;
    accessInstructions: string | null;
    jobNumber: number;
    status: "UNSCHEDULED" | "SCHEDULED" | "DISPATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELED";
  };
};

async function getJob(request: APIRequestContext, cookieHeader: string, jobId: string) {
  const response = await request.get(`${apiBaseUrl}/v1/jobs/${jobId}`, {
    headers: { Cookie: cookieHeader },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as JobPayload;
}

test("accepted quotes create manageable jobs with mobile-safe assignment and member visibility", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));

  const owner = await signUpViaApi(request, "jobs-e2e");
  const member = await addWorkspaceMemberViaApi(request, owner, "Jobs Field Member");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Jobs Workflow Customer",
    phone: "555-014-7711",
    email: "jobs-workflow@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Jobs Workflow Roof Repair",
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
  const [acceptResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/v1/quotes/${quote.id}`),
    page.getByRole("button", { name: "Accept quote & create job", exact: true }).click(),
  ]);
  expect(acceptResponse.status()).toBe(200);
  const acceptedPayload = (await acceptResponse.json()) as { job: { id: string; jobNumber: number } };

  const jobReady = page.getByRole("status").filter({ hasText: /Job #\d+ is ready from this accepted quote\./ });
  await expect(jobReady).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("invoice-panel")).toContainText("Create a draft invoice from this accepted quote.");
  await expect(page.getByRole("button", { name: "Create draft invoice", exact: true })).toBeVisible();
  await page.reload();
  await expect(jobReady).toBeVisible({ timeout: 20_000 });
  await jobReady.getByRole("button", { name: "Book with Kody", exact: true }).click();
  const kodyPanel = page.getByTestId("kody-chat-panel");
  await expect(kodyPanel).toBeVisible();
  await expect(kodyPanel.getByTestId("kody-prompt")).toHaveValue(new RegExp(`find a QuoteFly schedule opening for Job #${acceptedPayload.job.jobNumber}`));
  const [assistantRequest] = await Promise.all([
    page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/v1/ai/assistant"),
    kodyPanel.getByTestId("kody-prompt").press("Enter"),
  ]);
  expect(assistantRequest.postDataJSON()).toMatchObject({
    tool: "PREPARE_BOOKING",
    context: { currentPage: "jobs", jobId: acceptedPayload.job.id, quoteId: quote.id },
  });
  await kodyPanel.getByRole("button", { name: "Close Kody", exact: true }).click();
  await jobReady.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/jobs\/[^/?#]+$/);
  const jobId = page.url().match(/\/app\/jobs\/([^/?#]+)/)?.[1];
  expect(jobId).toBeTruthy();

  const customerAssignment = await request.patch(`${apiBaseUrl}/v1/customers/${customer.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(customerAssignment.status()).toBe(200);
  const quoteAssignment = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(quoteAssignment.status()).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/jobs");
  await expect(page.getByText("Job list", { exact: true })).toBeVisible({ timeout: 20_000 });
  const jobCard = page.getByRole("article").filter({ hasText: "Jobs Workflow Roof Repair" });
  await expect(jobCard).toBeVisible();
  await jobCard.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page.getByText("Job #1", { exact: true })).toBeVisible();

  const assigneeSelect = page.getByLabel("Assignee", { exact: true });
  await expect(assigneeSelect).toContainText("Jobs Field Member");
  await assigneeSelect.selectOption(member.membershipId);
  await expect(page.getByText("Access instructions", { exact: true }).last()).toBeVisible();
  const instructions = () => page.getByRole("textbox", { name: "Access instructions", exact: true });
  await instructions().fill("Gate code 4321. Park on the right side of the driveway.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();

  await expect
    .poll(async () => (await getJob(request, owner.cookieHeader, jobId!)).job.assignedTenantUserId)
    .toBe(member.membershipId);

  await context.clearCookies();
  await addSessionCookie(context, member);
  await page.goto(`/app/quotes/${quote.id}`);
  const memberLinkedJob = page.getByRole("status").filter({ hasText: new RegExp(`Job #${acceptedPayload.job.jobNumber} is linked to this accepted quote\\.`) });
  await expect(memberLinkedJob).toBeVisible({ timeout: 20_000 });
  await expect(memberLinkedJob.getByRole("button", { name: "Book with Kody", exact: true })).toHaveCount(0);
  await expect(memberLinkedJob.getByRole("button", { name: "Open job", exact: true })).toBeVisible();

  await context.clearCookies();
  await addSessionCookie(context, owner);
  await page.goto(`/app/jobs/${jobId}`);
  await expect(page.getByText("Job #1", { exact: true })).toBeVisible({ timeout: 20_000 });

  const savedJob = (await getJob(request, owner.cookieHeader, jobId!)).job;
  const externalUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${jobId}`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      version: savedJob.version,
      accessInstructions: "Server latest instruction for stale reload.",
    },
  });
  expect(externalUpdate.status()).toBe(200);

  await instructions().fill("Local stale instruction that should not save.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload latest job", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest job", exact: true }).click();
  await expect(instructions()).toHaveValue("Server latest instruction for stale reload.");
  await instructions().fill("Final saved instruction after stale reload.");
  await page.getByRole("button", { name: "Save job", exact: true }).click();
  await expect
    .poll(async () => (await getJob(request, owner.cookieHeader, jobId!)).job.accessInstructions)
    .toBe("Final saved instruction after stale reload.");

  await expect(page.getByText("Schedule and dispatch", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add booking", exact: true }).click();
  await page.getByLabel("Start time", { exact: true }).fill("2026-08-24T09:00");
  await page.getByLabel("End time", { exact: true }).fill("2026-08-24T11:00");
  await page.getByLabel("Booking instructions", { exact: true }).fill("Crew arrival window confirmed with customer.");
  await page.getByRole("button", { name: "Create booking", exact: true }).click();
  await expect(page.getByText("Crew arrival window confirmed with customer.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(page.getByText("Dispatched", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Mark arrived", exact: true }).click();
  await expect(page.getByText("Arrived", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Complete visit", exact: true }).click();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await getJob(request, owner.cookieHeader, jobId!)).job.status).toBe("COMPLETED");

  await page.goto(`/app/quotes/${quote.id}`);
  const completedLinkedJob = page.getByRole("status").filter({ hasText: new RegExp(`Job #${acceptedPayload.job.jobNumber} is linked to this accepted quote\\.`) });
  await expect(completedLinkedJob).toBeVisible({ timeout: 20_000 });
  await expect(completedLinkedJob.getByRole("button", { name: "Book with Kody", exact: true })).toHaveCount(0);
  await completedLinkedJob.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${jobId}$`));

  const invoicePanel = page.getByTestId("invoice-panel");
  await expect(invoicePanel.getByLabel("Invoice due date", { exact: true })).toBeVisible();
  await invoicePanel.getByRole("button", { name: "Create draft invoice", exact: true }).click();
  const invoiceConfirmation = page.getByRole("dialog", { name: "Create this draft invoice?" });
  await expect(invoiceConfirmation).toContainText("does not send an invoice, charge the customer, or create anything in QuickBooks, Stripe, or Square");
  await invoiceConfirmation.getByRole("button", { name: "Create draft invoice", exact: true }).click();
  await expect(invoicePanel.getByText("Invoice #1", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(invoicePanel.getByText("Draft", { exact: true })).toBeVisible();
  await expect(invoicePanel.getByText("Payment pending", { exact: true })).toBeVisible();
  await expect(invoicePanel).toContainText("No payment or provider action has occurred.");

  await page.getByLabel("Note", { exact: true }).fill("Crew has materials staged and customer confirmed gate access.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByText("Note added.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Crew has materials staged and customer confirmed gate access.", { exact: true })).toBeVisible();

  const main = page.locator("main");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  for (const button of await main.getByRole("button").all()) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect((await assigneeSelect.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  let failedDetailRequests = 0;
  await page.route(`${apiBaseUrl}/v1/jobs/${jobId}`, async (route) => {
    failedDetailRequests += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Injected job detail failure" }),
    });
  });
  await page.goto(`/app/jobs/${jobId}`);
  await expect(page.getByText("Job could not be loaded.", { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(failedDetailRequests).toBeGreaterThanOrEqual(1);
  await page.unroute(`${apiBaseUrl}/v1/jobs/${jobId}`);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await context.clearCookies();
  await addSessionCookie(context, member);
  await page.goto(`/app/jobs/${jobId}`);
  await expect(page.locator("p").filter({ hasText: "Final saved instruction after stale reload." })).toBeVisible();
  await expect(page.getByTestId("invoice-panel").getByText("Invoice #1", { exact: true })).toBeVisible();
  await expect(page.getByText("Manage assignment", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save job", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Assignee", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create draft invoice", exact: true })).toHaveCount(0);
});

test("invoice panel ignores a late response after the selected quote changes", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));

  const owner = await signUpViaApi(request, "invoice-panel-race");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Invoice Panel Race Customer",
    phone: "555-014-7788",
    email: "invoice-panel-race@example.com",
  });
  const firstQuote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Slow first invoice source",
  });
  const secondQuote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Current second invoice source",
  });
  for (const quoteId of [firstQuote.id, secondQuote.id]) {
    const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quoteId}`, {
      headers: { Cookie: owner.cookieHeader },
      data: { status: "ACCEPTED" },
    });
    expect(accepted.status()).toBe(200);
  }
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": `invoice-panel-race-${Date.now()}`,
    },
    data: { sourceQuoteId: firstQuote.id },
  });
  expect(created.status()).toBe(201);
  const firstInvoice = (await created.json()) as { invoice: Record<string, unknown> };

  let markStarted!: () => void;
  let releaseFirst!: () => void;
  let markFulfilled!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const releaseFirstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstRequestFulfilled = new Promise<void>((resolve) => { markFulfilled = resolve; });
  await page.route("**/v1/invoices?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("sourceQuoteId") !== firstQuote.id) {
      await route.continue();
      return;
    }
    markStarted();
    await releaseFirstRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [firstInvoice.invoice],
        pagination: { limit: 1, offset: 0, total: 1 },
        scope: { mine: false },
      }),
    });
    markFulfilled();
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${firstQuote.id}`);
  await firstRequestStarted;
  await page.evaluate((quoteId) => {
    window.history.pushState({}, "", `/app/quotes/${quoteId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, secondQuote.id);
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${secondQuote.id}$`));
  await expect(page.getByTestId("quote-desk")).toContainText("Current second invoice source");
  const currentPanel = page.getByTestId("invoice-panel");
  await expect(currentPanel).toContainText("Create a draft invoice from this accepted quote.");

  releaseFirst();
  await firstRequestFulfilled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(currentPanel).toContainText("Create a draft invoice from this accepted quote.");
  await expect(currentPanel.getByText("Invoice #1", { exact: true })).toHaveCount(0);

  let markCreateStarted!: () => void;
  let releaseCreate!: () => void;
  let markCreateFulfilled!: () => void;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  const releaseCreateRequest = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const createFulfilled = new Promise<void>((resolve) => { markCreateFulfilled = resolve; });
  await page.route("**/v1/invoices", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    markCreateStarted();
    await releaseCreateRequest;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        duplicate: false,
        invoice: {
          ...firstInvoice.invoice,
          id: "stale-second-source-invoice",
          sourceQuoteId: secondQuote.id,
          invoiceNumber: 99,
        },
      }),
    });
    markCreateFulfilled();
  });

  await currentPanel.getByRole("button", { name: "Create draft invoice", exact: true }).click();
  await page.getByRole("dialog", { name: "Create this draft invoice?" })
    .getByRole("button", { name: "Create draft invoice", exact: true })
    .click();
  await createStarted;
  await page.evaluate((quoteId) => {
    window.history.pushState({}, "", `/app/quotes/${quoteId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, firstQuote.id);
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${firstQuote.id}$`));
  const firstPanel = page.getByTestId("invoice-panel");
  await expect(firstPanel.getByText("Invoice #1", { exact: true })).toBeVisible();

  releaseCreate();
  await createFulfilled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(firstPanel.getByText("Invoice #1", { exact: true })).toBeVisible();
  await expect(firstPanel.getByText("Invoice #99", { exact: true })).toHaveCount(0);
});

test("QuickBooks review uses mapped targets and recovers from a stale preview version", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
  await page.setViewportSize({ width: 320, height: 844 });

  const owner = await signUpViaApi(request, "quickbooks-review-version");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Very Long QuoteFly Customer Name That Must Remain Fully Reviewable On Mobile",
    phone: "555-014-7799",
    email: "quickbooks-review@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, {
    title: "UNBROKEN-SERVICE-SKU-THAT-MUST-WRAP-ON-A-NARROW-MOBILE-SCREEN-1234567890",
  });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": `quickbooks-review-invoice-${Date.now()}`,
    },
    data: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()) as { invoice: { id: string; version: number } };

  let previewVersion = invoice.invoice.version;
  const publishVersions: number[] = [];
  const publishBindings: string[] = [];
  let previewOperation: null | {
    status: "PROCESSING";
    providerDocNumber: string;
    reconciliationAvailable: boolean;
  } = null;
  let reconciliationCalls = 0;
  const previewResponse = () => ({
    providerWorkflowsEnabled: true,
    preview: {
      invoice: {
        id: invoice.invoice.id,
        invoiceNumber: 1,
        version: previewVersion,
        status: "DRAFT",
        customerName: customer.fullName,
        currency: "USD",
        subtotalAmount: 150,
        taxAmount: 0,
        totalAmount: 150,
        dueAtUtc: "2026-10-01T17:00:00.000Z",
      },
      connection: { companyName: "Acme Field Services QuickBooks", status: "CONNECTED" },
      quickBooksCustomerName: "Acme QB Customer Target",
      providerDocNumber: "QF-000001",
      lineItems: [{
        description: quote.title,
        quantity: 1,
        unitPrice: 150,
        amount: 150,
        mapped: true,
        quickBooksItemName: "QuickBooks Service Item Target With A Long Name",
      }],
      blockers: [],
      ready: true,
      reviewBinding: previewVersion === invoice.invoice.version ? "A".repeat(43) : "B".repeat(43),
      operation: previewOperation,
    },
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/sync-preview`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(previewResponse()) });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/publish`, async (route) => {
    const body = route.request().postDataJSON() as { invoiceVersion: number; reviewBinding: string };
    publishVersions.push(body.invoiceVersion);
    publishBindings.push(body.reviewBinding);
    if (publishVersions.length === 1) {
      previewVersion += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Synthetic raw backend prose must not render.",
          code: "INVOICE_VERSION_CONFLICT",
          currentVersion: previewVersion,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        duplicate: false,
        reconciliationRequired: false,
        operation: { status: "SUCCEEDED", providerDocNumber: "QF-000001", reconciliationAvailable: false },
      }),
    });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/reconcile`, async (route) => {
    reconciliationCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: false,
        operation: {
          status: "RECONCILIATION_REQUIRED",
          providerDocNumber: "QF-000001",
          reconciliationAvailable: true,
        },
      }),
    });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  await expect(panel.getByRole("button", { name: "Review QuickBooks draft" })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Review QuickBooks draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish this invoice to QuickBooks?" });
  await expect(dialog).toContainText("Acme Field Services QuickBooks");
  await expect(dialog).toContainText(customer.fullName);
  await expect(dialog).toContainText("QuickBooks: Acme QB Customer Target");
  await expect(dialog).toContainText("QuickBooks: QuickBooks Service Item Target With A Long Name");
  await expect(dialog).toContainText("1 × $150.00 each");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await dialog.getByRole("button", { name: "Publish to QuickBooks" }).click();
  await expect(panel).toContainText("This invoice changed after the review. Review the updated details before publishing.");
  await expect(panel).not.toContainText("Synthetic raw backend prose must not render.");
  await panel.getByRole("button", { name: "Review QuickBooks draft" }).click();
  await page.getByRole("dialog", { name: "Publish this invoice to QuickBooks?" })
    .getByRole("button", { name: "Publish to QuickBooks" })
    .click();
  await expect(panel.getByText("Published once to QuickBooks as QF-000001.", { exact: true })).toBeVisible();
  expect(publishVersions).toEqual([invoice.invoice.version, invoice.invoice.version + 1]);
  expect(publishBindings).toEqual(["A".repeat(43), "B".repeat(43)]);

  previewOperation = {
    status: "PROCESSING",
    providerDocNumber: "QF-000001",
    reconciliationAvailable: true,
  };
  await page.reload();
  await expect(panel.getByRole("button", { name: "Check QuickBooks" })).toBeVisible();
  await panel.getByRole("button", { name: "Check QuickBooks" }).click();
  await expect(panel).toContainText("QuoteFly could not confirm whether QuickBooks created the invoice. Do not publish again yet.");
  expect(reconciliationCalls).toBe(1);
  expect(publishVersions).toHaveLength(2);
});

test("QuickBooks blocker actions remain usable in Spanish at 320px", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.setViewportSize({ width: 320, height: 844 });

  const owner = await signUpViaApi(request, "quickbooks-spanish-mobile");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: owner.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Cliente de QuoteFly con un nombre largo para revisar en móvil",
    phone: "555-014-7800",
    email: "quickbooks-spanish-mobile@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Servicio que necesita una asignación de QuickBooks antes de publicarse",
  });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": `quickbooks-spanish-mobile-${Date.now()}`,
    },
    data: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()) as { invoice: { id: string; version: number } };

  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/sync-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerWorkflowsEnabled: true,
        preview: {
          invoice: {
            id: invoice.invoice.id,
            invoiceNumber: 1,
            version: invoice.invoice.version,
            status: "DRAFT",
            customerName: customer.fullName,
            currency: "USD",
            subtotalAmount: 150,
            taxAmount: 0,
            totalAmount: 150,
            dueAtUtc: "2026-10-01T17:00:00.000Z",
          },
          connection: { companyName: "Empresa de servicios de campo", status: "CONNECTED" },
          quickBooksCustomerName: null,
          providerDocNumber: "QF-000001",
          lineItems: [{
            description: quote.title,
            quantity: 1,
            unitPrice: 150,
            amount: 150,
            mapped: false,
            quickBooksItemName: null,
          }],
          blockers: ["QUICKBOOKS_CUSTOMER_MAPPING_REQUIRED", "QUICKBOOKS_ITEM_MAPPING_REQUIRED"],
          ready: false,
          reviewBinding: null,
          operation: null,
        },
      }),
    });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  const panel = page.getByTestId("quickbooks-invoice-panel");
  const settingsButton = panel.getByRole("button", { name: "Abrir configuración de QuickBooks" });
  await expect(settingsButton).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Vincula este cliente con un cliente existente de QuickBooks.");
  await expect(panel).toContainText("Vincula cada partida con un artículo existente de QuickBooks.");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await settingsButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});
