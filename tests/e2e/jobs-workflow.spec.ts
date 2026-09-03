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

test("invoice panel distinguishes a current partial payment from a payment reversal", async ({
  context,
  page,
  request,
}) => {
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
  const owner = await signUpViaApi(request, "invoice-payment-display");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Invoice Payment Display Customer",
    email: "invoice-payment-display@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, {
    title: "Invoice payment display workflow",
  });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": `invoice-payment-display-${Date.now()}`,
    },
    data: { sourceQuoteId: quote.id },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()) as { invoice: Record<string, unknown> };
  let display: "partial" | "reversed" = "partial";
  await page.route("**/v1/invoices?**", async (route) => {
    const renderedInvoice = display === "partial"
      ? {
          ...invoice.invoice,
          paymentStatus: "PARTIALLY_PAID",
          hasReversedPayment: true,
          amountPaid: 125,
          balanceDue: 375,
        }
      : {
          ...invoice.invoice,
          paymentStatus: "PENDING",
          hasReversedPayment: true,
          amountPaid: 0,
          balanceDue: 500,
        };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [renderedInvoice], total: 1, limit: 1, offset: 0 }),
    });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("invoice-panel");
  await expect(panel.getByText("Partially paid", { exact: true })).toBeVisible();
  await expect(panel.getByText("Payment reversed", { exact: true })).toHaveCount(0);

  display = "reversed";
  await page.reload();
  await expect(panel.getByText("Payment reversed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Partially paid", { exact: true })).toHaveCount(0);
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
    status: "PROCESSING" | "SUCCEEDED" | "RECONCILIATION_REQUIRED";
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
    previewOperation = {
      status: "RECONCILIATION_REQUIRED",
      providerDocNumber: "QF-000001",
      reconciliationAvailable: true,
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        duplicate: false,
        reconciliationRequired: true,
        operation: previewOperation,
      }),
    });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/reconcile`, async (route) => {
    reconciliationCalls += 1;
    previewOperation = {
      status: "RECONCILIATION_REQUIRED",
      providerDocNumber: "QF-000001",
      reconciliationAvailable: true,
    };
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
  await expect(panel).toContainText("QuoteFly could not confirm whether QuickBooks created the invoice. Do not publish again yet.");
  await expect(panel.getByRole("button", { name: "Check QuickBooks" })).toBeVisible();
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

test("a delayed QuickBooks mapping review cannot replace or publish a newly active invoice", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));

  const owner = await signUpViaApi(request, "quickbooks-mapping-source-fence");
  const firstCustomer = await createCustomerViaApi(request, owner, {
    fullName: "Deferred Mapping Customer A",
    phone: "555-014-7801",
    email: "deferred-mapping-a@example.com",
  });
  const secondCustomer = await createCustomerViaApi(request, owner, {
    fullName: "Current Mapping Customer B",
    phone: "555-014-7802",
    email: "current-mapping-b@example.com",
  });
  const firstQuote = await createQuoteViaApi(request, owner, firstCustomer.id, { title: "Deferred mapping work A" });
  const secondQuote = await createQuoteViaApi(request, owner, secondCustomer.id, { title: "Current mapping work B" });

  for (const quoteId of [firstQuote.id, secondQuote.id]) {
    const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quoteId}`, {
      headers: { Cookie: owner.cookieHeader },
      data: { status: "ACCEPTED" },
    });
    expect(accepted.status()).toBe(200);
  }

  const createInvoice = async (quoteId: string, suffix: string) => {
    const response = await request.post(`${apiBaseUrl}/v1/invoices`, {
      headers: {
        Cookie: owner.cookieHeader,
        "Idempotency-Key": `quickbooks-mapping-fence-${suffix}-${Date.now()}`,
      },
      data: { sourceQuoteId: quoteId, dueAtUtc: "2026-10-01T17:00:00.000Z" },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as { invoice: { id: string; version: number; invoiceNumber: number } };
  };
  const firstInvoice = await createInvoice(firstQuote.id, "a");
  const secondInvoice = await createInvoice(secondQuote.id, "b");

  const previewFor = (params: {
    invoice: typeof firstInvoice.invoice;
    customerName: string;
    lineDescription: string;
    ready: boolean;
  }) => ({
    providerWorkflowsEnabled: true,
    preview: {
      invoice: {
        id: params.invoice.id,
        invoiceNumber: params.invoice.invoiceNumber,
        version: params.invoice.version,
        status: "DRAFT",
        customerName: params.customerName,
        currency: "USD",
        subtotalAmount: 150,
        taxAmount: 0,
        totalAmount: 150,
        dueAtUtc: "2026-10-01T17:00:00.000Z",
      },
      connection: { companyName: "Mapping Fence QuickBooks", status: "CONNECTED" },
      billingEmail: null,
      paymentMethods: { ach: false, card: false },
      customerMapping: params.ready ? {
        quickBooksCustomerId: "qb-customer-b",
        quickBooksDisplayName: params.customerName,
        reviewedAtUtc: "2026-08-27T12:00:00.000Z",
      } : null,
      quickBooksCustomerName: params.ready ? params.customerName : null,
      providerDocNumber: `QF-${String(params.invoice.invoiceNumber).padStart(6, "0")}`,
      lineItems: [{
        description: params.lineDescription,
        quantity: 1,
        unitPrice: 150,
        amount: 150,
        itemKey: `item-${params.invoice.id}`,
        mapped: true,
        quickBooksItemId: "qb-service-item",
        quickBooksItemName: "Service item",
        reviewedAtUtc: "2026-08-27T12:00:00.000Z",
      }],
      blockers: params.ready ? [] : ["QUICKBOOKS_CUSTOMER_MAPPING_REQUIRED"],
      ready: params.ready,
      reviewBinding: params.ready ? "B".repeat(43) : null,
      operation: null,
    },
  });

  await page.route(`**/v1/integrations/quickbooks/invoices/${firstInvoice.invoice.id}/sync-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(previewFor({
        invoice: firstInvoice.invoice,
        customerName: firstCustomer.fullName,
        lineDescription: firstQuote.title,
        ready: false,
      })),
    });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${secondInvoice.invoice.id}/sync-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(previewFor({
        invoice: secondInvoice.invoice,
        customerName: secondCustomer.fullName,
        lineDescription: secondQuote.title,
        ready: true,
      })),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/customers/search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{
          quickBooksCustomerId: "qb-customer-a",
          displayName: "QuickBooks Customer A",
          email: "qb-a@example.com",
        }],
      }),
    });
  });

  let releaseReview!: () => void;
  const reviewRelease = new Promise<void>((resolve) => { releaseReview = resolve; });
  let markReviewStarted!: () => void;
  const reviewStarted = new Promise<void>((resolve) => { markReviewStarted = resolve; });
  await page.route("**/v1/integrations/quickbooks/mappings/customer/review", async (route) => {
    markReviewStarted();
    await reviewRelease;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mapping: {
          customerId: firstCustomer.id,
          quickBooksCustomerId: "qb-customer-a",
          quickBooksDisplayName: "QuickBooks Customer A",
          reviewedAtUtc: "2026-08-27T12:00:00.000Z",
          reviewVersion: 1,
        },
      }),
    });
  });

  let firstPublishCalls = 0;
  let secondPublishCalls = 0;
  await page.route(`**/v1/integrations/quickbooks/invoices/${firstInvoice.invoice.id}/publish`, async (route) => {
    firstPublishCalls += 1;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "stale" }) });
  });
  await page.route(`**/v1/integrations/quickbooks/invoices/${secondInvoice.invoice.id}/publish`, async (route) => {
    secondPublishCalls += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        operation: { status: "SUCCEEDED", providerDocNumber: "QF-B", reconciliationAvailable: false },
      }),
    });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${firstQuote.id}`);
  const firstPanel = page.getByTestId("quickbooks-invoice-panel");
  const customerSearchButton = firstPanel.getByRole("button", { name: "Search", exact: true }).first();
  await expect(customerSearchButton).toBeVisible({ timeout: 30_000 });
  await customerSearchButton.click();
  await firstPanel.getByRole("button", { name: /QuickBooks Customer A/ }).click();
  await firstPanel.getByRole("button", { name: "Review mapping", exact: true }).first().click();
  await reviewStarted;

  await page.evaluate((quoteId) => {
    window.history.pushState({}, "", `/app/quotes/${quoteId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, secondQuote.id);
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${secondQuote.id}$`));
  const secondPanel = page.getByTestId("quickbooks-invoice-panel");
  await expect(secondPanel.getByRole("button", { name: "Review QuickBooks draft" })).toBeVisible({ timeout: 30_000 });

  releaseReview();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await secondPanel.getByRole("button", { name: "Review QuickBooks draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish this invoice to QuickBooks?" });
  await expect(dialog).toContainText(secondCustomer.fullName);
  await expect(dialog).not.toContainText(firstCustomer.fullName);
  await dialog.getByRole("button", { name: "Publish to QuickBooks" }).click();
  await expect.poll(() => secondPublishCalls).toBe(1);
  expect(firstPublishCalls).toBe(0);
});

test("QuickBooks customer and item reviews refresh a no-email invoice for offline publish", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));

  const owner = await signUpViaApi(request, "quickbooks-no-email-mapping-refresh");
  const customerResponse = await request.post(`${apiBaseUrl}/v1/customers`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      fullName: "No Email Mapping Customer",
      phone: "555-014-7803",
    },
  });
  expect(customerResponse.status()).toBe(201);
  const customer = (await customerResponse.json()) as {
    customer: { id: string; fullName: string; email: string | null };
  };
  expect(customer.customer.email).toBeNull();
  const quote = await createQuoteViaApi(request, owner, customer.customer.id, {
    title: "No email mapping service",
  });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": `quickbooks-no-email-mapping-${Date.now()}`,
    },
    data: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()) as {
    invoice: { id: string; version: number; invoiceNumber: number };
  };

  let customerReviewed = false;
  const itemMappings = [
    { itemKey: `${quote.title.toLowerCase()}-first`, description: `${quote.title} first`, quickBooksItemId: "qb-no-email-item-first", quickBooksItemName: "QuickBooks no-email service first" },
    { itemKey: `${quote.title.toLowerCase()}-second`, description: `${quote.title} second`, quickBooksItemId: "qb-no-email-item-second", quickBooksItemName: "QuickBooks no-email service second" },
  ];
  const reviewedItemKeys = new Set<string>();
  const previewBodies: Array<Record<string, unknown>> = [];
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/sync-preview`, async (route) => {
    previewBodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    const blockers = [
      ...(!customerReviewed ? ["QUICKBOOKS_CUSTOMER_MAPPING_REQUIRED"] : []),
      ...(reviewedItemKeys.size !== itemMappings.length ? ["QUICKBOOKS_ITEM_MAPPING_REQUIRED"] : []),
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerWorkflowsEnabled: true,
        preview: {
          invoice: {
            id: invoice.invoice.id,
            invoiceNumber: invoice.invoice.invoiceNumber,
            version: invoice.invoice.version,
            status: "DRAFT",
            customerName: customer.customer.fullName,
            currency: "USD",
            subtotalAmount: 150,
            taxAmount: 0,
            totalAmount: 150,
            dueAtUtc: "2026-10-01T17:00:00.000Z",
          },
          connection: { companyName: "No Email QuickBooks", status: "CONNECTED" },
          billingEmail: null,
          paymentMethods: { ach: false, card: false },
          customerMapping: customerReviewed ? {
            quickBooksCustomerId: "qb-no-email-customer",
            quickBooksDisplayName: "QuickBooks no-email customer",
            reviewedAtUtc: "2026-08-27T12:00:00.000Z",
          } : null,
          quickBooksCustomerName: customerReviewed ? "QuickBooks no-email customer" : null,
          providerDocNumber: `QF-${String(invoice.invoice.invoiceNumber).padStart(6, "0")}`,
          lineItems: itemMappings.map((item) => {
            const reviewed = reviewedItemKeys.has(item.itemKey);
            return {
              description: item.description,
              quantity: 1,
              unitPrice: 75,
              amount: 75,
              itemKey: item.itemKey,
              mapped: reviewed,
              quickBooksItemId: reviewed ? item.quickBooksItemId : null,
              quickBooksItemName: reviewed ? item.quickBooksItemName : null,
              reviewedAtUtc: reviewed ? "2026-08-27T12:00:00.000Z" : null,
            };
          }),
          blockers,
          ready: blockers.length === 0,
          reviewBinding: blockers.length === 0 ? "N".repeat(43) : null,
          operation: null,
        },
      }),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/customers/search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{
          quickBooksCustomerId: "qb-no-email-customer",
          displayName: "QuickBooks no-email customer",
          email: null,
        }],
      }),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/items/search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: itemMappings.map((item) => ({
          quickBooksItemId: item.quickBooksItemId,
          name: item.quickBooksItemName,
          type: "Service",
        })),
      }),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/customer/review", async (route) => {
    customerReviewed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mapping: {
          customerId: customer.customer.id,
          quickBooksCustomerId: "qb-no-email-customer",
          quickBooksDisplayName: "QuickBooks no-email customer",
          reviewedAtUtc: "2026-08-27T12:00:00.000Z",
          reviewVersion: 1,
        },
      }),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/item/review", async (route) => {
    const body = route.request().postDataJSON() as { itemKey: string; quickBooksItemId: string };
    reviewedItemKeys.add(body.itemKey);
    const item = itemMappings.find((candidate) => candidate.itemKey === body.itemKey);
    expect(item).toBeDefined();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mapping: {
          itemKey: body.itemKey,
          quickBooksItemId: body.quickBooksItemId,
          quickBooksItemName: item?.quickBooksItemName,
          workPresetId: null,
          reviewedAtUtc: "2026-08-27T12:00:00.000Z",
          reviewVersion: 1,
        },
      }),
    });
  });
  let publishBody: null | Record<string, unknown> = null;
  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/publish`, async (route) => {
    publishBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        operation: { status: "SUCCEEDED", providerDocNumber: "QF-OFFLINE", reconciliationAvailable: false },
      }),
    });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  const customerSearchButton = panel.getByRole("button", { name: "Search", exact: true });
  const firstItemDetails = panel.locator("details").filter({ hasText: itemMappings[0].description }).first();
  const secondItemDetails = panel.locator("details").filter({ hasText: itemMappings[1].description }).first();
  const firstItemSearchButton = firstItemDetails.getByRole("button", { name: `Search QuickBooks items for ${itemMappings[0].description}`, exact: true });
  const secondItemSearchButton = secondItemDetails.getByRole("button", { name: `Search QuickBooks items for ${itemMappings[1].description}`, exact: true });
  await expect(customerSearchButton).toBeVisible({ timeout: 30_000 });
  await expect(firstItemSearchButton).toBeVisible();
  await expect(secondItemSearchButton).toBeVisible();
  await expect(panel.getByText(/^invoices\.quickBooks\./)).toHaveCount(0);
  await expect(panel.locator('[aria-label^="invoices.quickBooks."]')).toHaveCount(0);
  await customerSearchButton.click();
  await panel.getByRole("button", { name: /QuickBooks no-email customer/ }).click();
  await panel.getByRole("button", { name: "Review mapping", exact: true }).first().click();
  await expect.poll(() => previewBodies.length).toBeGreaterThanOrEqual(2);

  await firstItemSearchButton.click();
  await firstItemDetails.getByRole("button").filter({ hasText: itemMappings[0].quickBooksItemName }).click();
  await secondItemSearchButton.click();
  const secondSelection = secondItemDetails.getByRole("button").filter({ hasText: itemMappings[1].quickBooksItemName });
  await secondSelection.click();
  const firstReviewButton = firstItemDetails.getByRole("button", { name: `Review item mapping for ${itemMappings[0].description}`, exact: true });
  await firstReviewButton.click();
  await expect(firstItemDetails.locator(":scope > summary")).toBeFocused();
  await expect(secondSelection).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("Review or reset these changes before opening the final QuickBooks draft.")).toBeVisible();
  await secondItemDetails.getByRole("button", { name: `Review item mapping for ${itemMappings[1].description}`, exact: true }).click();
  await expect(panel.getByRole("button", { name: "Review QuickBooks draft" })).toBeVisible();

  const reviewedRefreshBodies = previewBodies.filter((body) => Object.hasOwn(body, "billingEmail"));
  expect(reviewedRefreshBodies).toHaveLength(3);
  expect(reviewedRefreshBodies).toEqual([
    { billingEmail: null, allowOnlineAchPayment: false, allowOnlineCardPayment: false },
    { billingEmail: null, allowOnlineAchPayment: false, allowOnlineCardPayment: false },
    { billingEmail: null, allowOnlineAchPayment: false, allowOnlineCardPayment: false },
  ]);

  await panel.getByRole("button", { name: "Review QuickBooks draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish this invoice to QuickBooks?" });
  await expect(dialog).toContainText("None selected");
  await dialog.getByRole("button", { name: "Publish to QuickBooks" }).click();
  await expect.poll(() => publishBody).toMatchObject({
    billingEmail: null,
    allowOnlineAchPayment: false,
    allowOnlineCardPayment: false,
  });
});

test("QuickBooks review guards navigation and announces a failed customer search once", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
  const owner = await signUpViaApi(request, "quickbooks-review-navigation-guard");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "QuickBooks review guard customer",
    phone: "555-014-7811",
    email: "quickbooks-review-guard@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "QuickBooks review guard work" });
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);
  const created = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": `quickbooks-review-guard-${Date.now()}` },
    data: { sourceQuoteId: quote.id, dueAtUtc: "2026-10-01T17:00:00.000Z" },
  });
  expect(created.status()).toBe(201);
  const invoice = (await created.json()) as { invoice: { id: string; version: number; invoiceNumber: number } };

  await page.route(`**/v1/integrations/quickbooks/invoices/${invoice.invoice.id}/sync-preview`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerWorkflowsEnabled: true,
        preview: {
          invoice: { id: invoice.invoice.id, invoiceNumber: invoice.invoice.invoiceNumber, version: invoice.invoice.version, status: "DRAFT", customerName: customer.fullName, currency: "USD", subtotalAmount: 150, taxAmount: 0, totalAmount: 150, dueAtUtc: "2026-10-01T17:00:00.000Z" },
          connection: { companyName: "Review guard QuickBooks", status: "CONNECTED" },
          billingEmail: customer.email,
          paymentMethods: { ach: false, card: false },
          customerMapping: null,
          quickBooksCustomerName: null,
          providerDocNumber: "QF-REVIEW-GUARD",
          lineItems: [{ description: quote.title, quantity: 1, unitPrice: 150, amount: 150, itemKey: quote.title.toLowerCase(), mapped: false, quickBooksItemId: null, quickBooksItemName: null, reviewedAtUtc: null }],
          blockers: ["QUICKBOOKS_CUSTOMER_MAPPING_REQUIRED", "QUICKBOOKS_ITEM_MAPPING_REQUIRED"],
          ready: false,
          reviewBinding: null,
          operation: null,
        },
      }),
    });
  });
  await page.route("**/v1/integrations/quickbooks/mappings/customers/search", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
  });

  await addSessionCookie(context, owner);
  await page.goto(`/app/quotes/${quote.id}`);
  const panel = page.getByTestId("quickbooks-invoice-panel");
  const customerSearch = panel.getByLabel("Search QuickBooks customers");
  await expect(customerSearch).toBeVisible({ timeout: 60_000 });
  await customerSearch.fill("Acme");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const searchError = "QuickBooks search could not be completed. Try again.";
  await expect(panel.getByRole("alert")).toHaveText(searchError);
  await expect(panel.locator("p.sr-only[aria-live='polite']").first()).not.toContainText(searchError);

  const customerFallback = panel.locator("details").first();
  await customerFallback.locator(":scope > summary").click();
  const customerId = panel.getByLabel("QuickBooks customer ID");
  await customerId.fill("qb-review-guard-customer");
  await panel.getByRole("button", { name: "Open QuickBooks settings" }).click();
  const leaveDialog = page.getByRole("dialog", { name: "Leave QuickBooks review?" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(customerId).toHaveValue("qb-review-guard-customer");

  await panel.getByRole("button", { name: "Open QuickBooks settings" }).click();
  await page.getByRole("dialog", { name: "Leave QuickBooks review?" }).getByRole("button", { name: "Leave review" }).click();
  await expect(page).toHaveURL(/\/app\/settings#admin-quickbooks$/);
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
