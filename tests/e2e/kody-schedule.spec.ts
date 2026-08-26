import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
  type E2eAccount,
} from "./helpers";

async function revealQuickPrompts(panel: Locator) {
  const prompts = panel.getByTestId("kody-quick-prompts");
  if (!(await prompts.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await prompts.locator(":scope > summary").click();
  }
  return prompts;
}

async function expectNoSeriousAccessibilityViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).flatMap((node) => node.target),
    }));
  expect(blocking, `${label} has serious or critical accessibility violations`).toEqual([]);
}

function scheduleResponse() {
  const results = Array.from({ length: 5 }, (_, index) => ({
    appointmentId: `appointment-${index + 1}`,
    appointmentVersion: 3,
    appointmentStatus: "SCHEDULED",
    startsAtUtc: `2026-08-${String(25 + index).padStart(2, "0")}T16:00:00.000Z`,
    endsAtUtc: `2026-08-${String(25 + index).padStart(2, "0")}T18:00:00.000Z`,
    timeZone: "America/Los_Angeles",
    jobId: `job-${index + 1}`,
    jobNumber: 4100 + index,
    jobStatus: "SCHEDULED",
    jobTitle: `HVAC tune-up ${index + 1}`,
    customerId: `customer-${index + 1}`,
    customerName: `Schedule Customer ${index + 1}`,
    assignedTenantUserId: `member-${index + 1}`,
    assigneeName: `Field Tech ${index + 1}`,
    serviceAddress: "must never render",
    appointmentInstructions: "must never render",
    customerPhone: "555-000-0000",
    internalCost: 999,
  }));
  return {
    assistant: {
      tool: "LIST_SCHEDULE",
      generatedAtUtc: "2026-08-22T18:00:00.000Z",
      policyVersion: "2026-08-22",
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer: "I found 5 active bookings assigned to you for today; open Schedule to see the rest.",
      results,
      citations: [{ key: "S1", label: "Visible active job schedule", sourceType: "JobAppointment + Job + Customer + TenantUser", classification: "C2_CUSTOMER_CONFIDENTIAL" }],
      actions: [{ type: "OPEN_SCHEDULE", label: "Open schedule", requiresConfirmation: false, payload: { range: "day", date: "2026-08-25", mine: true } }],
      auditEventId: "audit-kody-schedule-playwright",
      fieldsExcluded: ["service addresses", "appointment instructions", "customer phone numbers", "internal costs"],
      conversation: { mode: "NEW", acknowledgement: null, previousTool: null, currentTool: "LIST_SCHEDULE" },
      diagnostics: {
        requestedTool: "LIST_SCHEDULE",
        resolvedTool: "LIST_SCHEDULE",
        resultCount: 5,
        citationCount: 1,
        emptyReason: null,
        archivePolicy: "Only active visible bookings are included.",
        filters: { mine: true },
        answerMode: "DETERMINISTIC",
        model: null,
      },
    },
    usage: {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      monthlyCreditsUsed: 0,
      monthlyCreditsLimit: 770,
      monthlyCreditsRemaining: 770,
      monthlySpendUsedUsd: 0,
      monthlySpendLimitUsd: 1.25,
      monthlySpendRemainingUsd: 1.25,
      monthlySpendUsagePercent: 0,
      estimatedPromptCostUsd: 0,
      estimatedPromptsRemaining: 770,
      renewsAtUtc: "2026-09-01T00:00:00.000Z",
    },
  };
}

function nextSevenScheduleResponse() {
  const response = scheduleResponse();
  response.assistant.answer = "I found active bookings assigned to you for the next 7 days.";
  response.assistant.results = [
    {
      appointmentId: "appointment-next-seven",
      appointmentVersion: 3,
      appointmentStatus: "SCHEDULED",
      startsAtUtc: "2026-08-29T16:00:00.000Z",
      endsAtUtc: "2026-08-29T18:00:00.000Z",
      timeZone: "UTC",
      jobId: "job-next-seven",
      jobNumber: 4199,
      jobStatus: "SCHEDULED",
      jobTitle: "Weekend HVAC tune-up",
      customerId: "customer-next-seven",
      customerName: "Weekend Schedule Customer",
      assignedTenantUserId: "member-next-seven",
      assigneeName: "Field Tech",
    },
  ];
  response.assistant.actions = [{
    type: "OPEN_SCHEDULE",
    label: "Open schedule",
    requiresConfirmation: false,
    payload: { range: "next7", date: "2026-08-29", mine: true },
  }];
  return response;
}

function jobSearchResponse() {
  const response = scheduleResponse();
  return {
    ...response,
    assistant: {
      ...response.assistant,
      tool: "SEARCH_JOBS",
      answer: "I found 5 active Jobs matching Smith.",
      results: Array.from({ length: 5 }, (_, index) => ({
        jobId: `job-search-${index + 1}`,
        jobNumber: 5100 + index,
        jobTitle: `Smith service Job ${index + 1}`,
        customerName: `Smith Customer ${index + 1}`,
        status: "SCHEDULED",
      })),
      actions: Array.from({ length: 4 }, (_, index) => ({
        type: "OPEN_WORKSPACE_PAGE",
        label: "Open Job",
        requiresConfirmation: false,
        payload: { page: "jobs", jobId: `job-search-${index + 1}`, jobNumber: 5100 + index },
      })),
      diagnostics: {
        ...response.assistant.diagnostics,
        requestedTool: "AUTO",
        resolvedTool: "SEARCH_JOBS",
        resultCount: 5,
        filters: { resultsTruncated: true },
      },
      conversation: { mode: "NEW", acknowledgement: null, previousTool: null, currentTool: "SEARCH_JOBS" },
    },
  };
}

function invoiceSearchResponse(params: {
  invoiceId: string;
  invoiceNumber: number;
  jobId: string;
  jobNumber: number;
}) {
  const response = scheduleResponse();
  return {
    ...response,
    assistant: {
      ...response.assistant,
      tool: "LIST_INVOICES",
      answer: "Encontré 1 factura activa.",
      results: [{
        invoiceId: params.invoiceId,
        invoiceNumber: params.invoiceNumber,
        status: "OPEN",
        paymentStatus: "PENDING",
        title: "Reparación del techo",
        customerName: "Cliente Ejemplo",
        jobId: params.jobId,
        jobNumber: params.jobNumber,
        totalAmount: 1250,
        amountPaid: 250,
        balanceDue: 1000,
      }],
      actions: [{
        type: "OPEN_WORKSPACE_PAGE",
        label: "Open invoice",
        requiresConfirmation: false,
        payload: {
          page: "jobs",
          jobId: params.jobId,
          jobNumber: params.jobNumber,
          invoiceId: params.invoiceId,
          invoiceNumber: params.invoiceNumber,
        },
      }],
      diagnostics: {
        ...response.assistant.diagnostics,
        requestedTool: "LIST_INVOICES",
        resolvedTool: "LIST_INVOICES",
        resultCount: 1,
        filters: { resultsTruncated: false },
      },
      conversation: { mode: "NEW", acknowledgement: null, previousTool: null, currentTool: "LIST_INVOICES" },
    },
  };
}

type PreparedJob = {
  owner: E2eAccount;
  member: Awaited<ReturnType<typeof addWorkspaceMemberViaApi>>;
  customer: Awaited<ReturnType<typeof createCustomerViaApi>>;
  job: {
    id: string;
    jobNumber: number;
    title: string;
    customerId: string;
    sourceQuoteId: string;
    assignedTenantUserId: string;
  };
  timeZone: string;
};

type AppointmentSummary = {
  id: string;
  version: number;
  status: string;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  instructions: string | null;
};

async function prepareAssignedJob(request: APIRequestContext, prefix: string): Promise<PreparedJob> {
  const owner = await signUpViaApi(request, prefix);
  const member = await addWorkspaceMemberViaApi(request, owner, `${prefix} Field Technician`);
  const customer = await createCustomerViaApi(request, owner, {
    fullName: `${prefix} Customer`,
    phone: `555-018-${Math.floor(1000 + Math.random() * 9000)}`,
    email: `${prefix.toLowerCase().replace(/[^a-z0-9]/g, "-")}@example.com`,
    assignedTenantUserId: member.membershipId,
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: `${prefix} Service Visit` });
  const quoteAssignment = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(quoteAssignment.status()).toBe(200);
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);

  const jobsResponse = await request.get(`${apiBaseUrl}/v1/jobs?search=${encodeURIComponent(`${prefix} Service Visit`)}&limit=25&offset=0`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(jobsResponse.status()).toBe(200);
  const jobsPayload = (await jobsResponse.json()) as {
    items: Array<PreparedJob["job"] & { version: number; assignedTenantUserId: string | null }>;
  };
  const createdJob = jobsPayload.items[0];
  expect(createdJob).toBeTruthy();
  if (createdJob.assignedTenantUserId !== member.membershipId) {
    const assigned = await request.patch(`${apiBaseUrl}/v1/jobs/${createdJob.id}`, {
      headers: { Cookie: owner.cookieHeader },
      data: { version: createdJob.version, assignedTenantUserId: member.membershipId },
    });
    expect(assigned.status()).toBe(200);
  }
  const jobResponse = await request.get(`${apiBaseUrl}/v1/jobs/${createdJob.id}`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(jobResponse.status()).toBe(200);
  const job = ((await jobResponse.json()) as { job: PreparedJob["job"] }).job;
  const sessionResponse = await request.get(`${apiBaseUrl}/v1/auth/me`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()) as { tenant: { timezone: string } };
  return { owner, member, customer, job, timeZone: session.tenant.timezone };
}

async function listAppointments(request: APIRequestContext, fixture: PreparedJob) {
  const response = await request.get(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments?limit=100&offset=0`, {
    headers: { Cookie: fixture.owner.cookieHeader },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    items: AppointmentSummary[];
    pagination: { total: number };
  };
}

function assistantActionResponse(
  tool: "PREPARE_BOOKING" | "PREPARE_DISPATCH",
  answer: string,
  action: { type: "OPEN_BOOKING_REVIEW" | "OPEN_DISPATCH_REVIEW"; label: string; payload: Record<string, unknown> },
) {
  return {
    assistant: {
      tool,
      generatedAtUtc: "2026-08-22T18:00:00.000Z",
      policyVersion: "2026-08-22",
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: [],
      citations: [{ key: "S1", label: "Authorized scheduled job", sourceType: "JobAppointment + Job + Customer", classification: "C2_CUSTOMER_CONFIDENTIAL" }],
      actions: [{ ...action, requiresConfirmation: false }],
      auditEventId: `audit-${tool.toLowerCase()}-playwright`,
      fieldsExcluded: ["service addresses", "appointment instructions", "customer contact details", "internal costs"],
      conversation: { mode: "NEW", acknowledgement: null, previousTool: null, currentTool: tool },
      diagnostics: {
        requestedTool: tool,
        resolvedTool: tool,
        resultCount: 0,
        citationCount: 1,
        emptyReason: null,
        archivePolicy: "Only active tenant-scoped jobs and bookings are eligible.",
        filters: {},
        answerMode: "DETERMINISTIC",
        model: null,
      },
    },
    usage: {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      monthlyCreditsUsed: 0,
      monthlyCreditsLimit: 770,
      monthlyCreditsRemaining: 770,
      monthlySpendUsedUsd: 0,
      monthlySpendLimitUsd: 1.25,
      monthlySpendRemainingUsd: 1.25,
      monthlySpendUsagePercent: 0,
      estimatedPromptCostUsd: 0,
      estimatedPromptsRemaining: 770,
      renewsAtUtc: "2026-09-01T00:00:00.000Z",
    },
  };
}

function bookingResponse(fixture: PreparedJob, overrides: Record<string, unknown> = {}) {
  return assistantActionResponse("PREPARE_BOOKING", "I prepared a booking time for review. Nothing has been created yet.", {
    type: "OPEN_BOOKING_REVIEW",
    label: "Review booking",
    payload: {
      mode: "CREATE",
      jobId: fixture.job.id,
      jobNumber: fixture.job.jobNumber,
      jobTitle: fixture.job.title,
      customerId: fixture.customer.id,
      customerName: fixture.customer.fullName,
      assignedTenantUserId: fixture.member.membershipId,
      assigneeName: `${fixture.member.user.fullName}`,
      startsAtUtc: "2026-08-28T16:00:00.000Z",
      endsAtUtc: "2026-08-28T18:00:00.000Z",
      timeZone: fixture.timeZone,
      serviceAddress: "forged address must be stripped",
      instructions: "forged instructions must be stripped",
      ...overrides,
    },
  });
}

function dispatchResponse(fixture: PreparedJob, appointment: AppointmentSummary) {
  return assistantActionResponse("PREPARE_DISPATCH", "Preparé esta visita para que revises el despacho. Todavía no cambié nada.", {
    type: "OPEN_DISPATCH_REVIEW",
    label: "Revisar despacho",
    payload: {
      jobId: fixture.job.id,
      jobNumber: fixture.job.jobNumber,
      jobTitle: fixture.job.title,
      customerId: fixture.customer.id,
      customerName: fixture.customer.fullName,
      appointmentId: appointment.id,
      appointmentVersion: appointment.version,
      expectedStatus: "SCHEDULED",
      startsAtUtc: appointment.startsAtUtc,
      endsAtUtc: appointment.endsAtUtc,
      timeZone: appointment.timeZone,
      assignedTenantUserId: fixture.member.membershipId,
      assigneeName: fixture.member.user.fullName,
      serviceAddress: "forged address must be stripped",
      instructions: "forged instructions must be stripped",
    },
  });
}

async function runQuickAction(page: Page, quickTestId: string, actionName: string) {
  if (!(await page.getByTestId("kody-chat-panel").isVisible())) {
    await page.getByTestId("kody-launcher").click();
  }
  const panel = page.getByTestId("kody-chat-panel");
  const prompts = await revealQuickPrompts(panel);
  await prompts.getByTestId(quickTestId).click();
  const promptInput = panel.getByTestId("kody-prompt");
  if ((await promptInput.inputValue()).trim()) {
    await promptInput.press("Enter");
  }
  const action = panel.getByRole("button", { name: actionName, exact: true }).last();
  await expect(action).toBeVisible();
  return { panel, action };
}

function localDateTimeInput(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

test("Kody prioritizes Jobs prompts and renders a compact tenant-time schedule without protected fields", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-schedule-cards");
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const requestBody = route.request().postDataJSON() as { tool?: string; context?: Record<string, unknown> };
    expect(requestBody.tool).toBe("LIST_SCHEDULE");
    expect(requestBody.context?.currentPage).toBe("jobs");
    expect(requestBody.context).not.toHaveProperty("tenantId");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse()) });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/jobs?view=schedule&range=day&date=2026-08-25&assignee=me");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  const prompts = await revealQuickPrompts(panel);
  const promptIds = await prompts.locator('button[data-testid^="kody-quick-"]').evaluateAll((buttons) =>
    buttons.slice(0, 3).map((button) => button.getAttribute("data-testid")),
  );
  expect(promptIds).toEqual([
    "kody-quick-list_schedule",
    "kody-quick-prepare_booking",
    "kody-quick-prepare_dispatch",
  ]);

  await panel.getByTestId("kody-quick-list_schedule").click();
  await expect(panel.getByText(/I found 5 active bookings/)).toBeVisible();
  const results = panel.getByTestId("kody-results");
  await results.locator(":scope > summary").click();
  await expect(results.getByTestId("kody-schedule-card")).toHaveCount(4);
  await expect(results.getByTestId("kody-results-count")).toContainText("Showing 4 of 5");
  const showMoreResults = results.getByTestId("kody-results-show-more");
  await expect(showMoreResults).toHaveAccessibleName("Show 1 more results");
  await showMoreResults.click();
  await expect(results.getByTestId("kody-schedule-card")).toHaveCount(5);
  await expect(results.getByTestId("kody-results-count")).toContainText("Showing 5 of 5");
  const firstCard = results.getByTestId("kody-schedule-card").first();
  await expect(firstCard).toContainText("Schedule Customer 1");
  await expect(firstCard).toContainText("#4100 · HVAC tune-up 1");
  await expect(firstCard).toContainText("Field Tech 1");
  await expect(firstCard).toContainText("America/Los_Angeles");
  await expect(firstCard).not.toContainText("2026-08-25T16:00:00.000Z");
  await expect(results).not.toContainText("must never render");
  await expect(results).not.toContainText("555-000-0000");
  await expect(results).not.toContainText("999");
  await expectNoSeriousAccessibilityViolations(page, "populated Kody schedule results");

  await panel.getByRole("button", { name: "Open schedule", exact: true }).click();
  await expect(page).toHaveURL(/view=schedule/);
  await expect(page).toHaveURL(/range=day/);
  await expect(page).toHaveURL(/date=2026-08-25/);
  await expect(page).toHaveURL(/assignee=me/);
  await expect(panel).toBeVisible();
});

test("Kody opens the exact rolling next-seven-day schedule window, including its weekend start", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-rolling-schedule");
  const requestedWindows: URL[] = [];
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nextSevenScheduleResponse()) });
  });
  await page.route(`${apiBaseUrl}/v1/jobs/schedule**`, async (route) => {
    requestedWindows.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], pagination: { total: 0, limit: 100, offset: 0 } }),
    });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/jobs?view=schedule&range=day&date=2026-08-29&assignee=me");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  const prompts = await revealQuickPrompts(panel);
  await prompts.getByTestId("kody-quick-list_schedule").click();
  await panel.getByRole("button", { name: "Open schedule", exact: true }).click();

  await expect(page).toHaveURL(/view=schedule/);
  await expect(page).toHaveURL(/range=next7/);
  await expect(page).toHaveURL(/date=2026-08-29/);
  await expect(page).toHaveURL(/assignee=me/);
  await expect.poll(() => requestedWindows.some((url) =>
    url.searchParams.get("fromUtc") === "2026-08-29T00:00:00.000Z"
    && url.searchParams.get("toUtc") === "2026-09-05T00:00:00.000Z",
  )).toBe(true);
  await expect(page.getByTestId("schedule-window")).toHaveText(/Aug 29.*Sep 4, 2026/);
  // An empty schedule intentionally renders the empty state instead of the
  // desktop time grid. The accessible seven-day date strip is still the
  // canonical proof that the rolling Saturday-through-Friday interval stayed
  // intact after the Kody handoff.
  await expect(page.getByRole("button", { name: "Sat 29 0 bookings", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Sun 30 0 bookings", exact: true })).toBeVisible();
});

test("Kody discloses and expands non-schedule results and actions", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-job-result-disclosure");
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobSearchResponse()) });
  });
  await addSessionCookie(context, account);
  await page.goto("/app/jobs");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  await panel.getByTestId("kody-prompt").fill("Find active Smith jobs");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText("I found 5 active Jobs matching Smith.")).toBeVisible();

  const results = panel.getByTestId("kody-results");
  await results.locator(":scope > summary").click();
  await expect(results.getByTestId("kody-results-count")).toHaveText("Showing the first 4 results. More matches exist; narrow your search.");
  await results.getByTestId("kody-results-show-more").click();
  await expect(results.getByText("Smith service Job 5")).toBeVisible();
  await expect(results.getByTestId("kody-results-count")).toHaveText("Showing the first 5 results. More matches exist; narrow your search.");

  await expect(panel.getByRole("button", { name: "Open job #5100", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open job #5101", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open job #5102", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Show 1 more actions" }).click();
  await expect(panel.getByRole("button", { name: "Open job #5103", exact: true })).toBeVisible();
});

test("Kody renders localized invoice facts and focuses the authorized invoice after handoff", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const fixture = await prepareAssignedJob(request, "Kody Invoice Focus");
  const createdResponse = await request.post(`${apiBaseUrl}/v1/invoices`, {
    headers: {
      Cookie: fixture.owner.cookieHeader,
      "Idempotency-Key": `kody-invoice-focus-${Date.now()}`,
    },
    data: {
      sourceQuoteId: fixture.job.sourceQuoteId,
      dueAtUtc: "2026-09-30T19:00:00.000Z",
    },
  });
  expect(createdResponse.status()).toBe(201);
  const invoice = (await createdResponse.json()) as { invoice: { id: string; invoiceNumber: number } };
  const localeResponse = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(localeResponse.status()).toBe(200);

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(invoiceSearchResponse({
      invoiceId: invoice.invoice.id,
      invoiceNumber: invoice.invoice.invoiceNumber,
      jobId: fixture.job.id,
      jobNumber: fixture.job.jobNumber,
    })),
  }));
  await addSessionCookie(context, fixture.owner);
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.goto("/app/jobs");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  await panel.getByTestId("kody-prompt").fill("Muéstrame mis facturas");
  await panel.getByTestId("kody-prompt").press("Enter");
  const results = panel.getByTestId("kody-results");
  await results.locator(":scope > summary").click();
  await expect(results).toContainText("Estado de factura");
  await expect(results).toContainText("Abierta");
  await expect(results).toContainText("Estado del pago");
  await expect(results).toContainText("Pago pendiente");
  await expect(results).toContainText("Total de la factura");
  await expect(results).toContainText("Monto pagado");
  await expect(results).toContainText("Saldo pendiente");
  await expect(results).not.toContainText("paymentStatus");

  const action = panel.getByRole("button", { name: `Abrir factura #${invoice.invoice.invoiceNumber}`, exact: true });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page).toHaveURL(new RegExp(`/app/jobs/${fixture.job.id}$`));
  const invoiceHeading = page.getByTestId("invoice-panel-heading");
  await expect(invoiceHeading).toHaveText(`Factura #${invoice.invoice.invoiceNumber}`);
  await expect(invoiceHeading).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page, "localized Kody invoice handoff");
});

test("stopping Kody preserves the prompt and ignores a late response", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-cancel-late-result");
  const attempts: Array<{ key: string; body: unknown }> = [];
  let releaseAssistantResponse!: () => void;
  let markResponseAttempted!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseAssistantResponse = resolve;
  });
  const responseAttempted = new Promise<void>((resolve) => {
    markResponseAttempted = resolve;
  });
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    attempts.push({
      key: route.request().headers()["idempotency-key"] ?? "",
      body: route.request().postDataJSON(),
    });
    const attempt = attempts.length;
    if (attempt === 1) await responseGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse()) }).catch(() => undefined);
    if (attempt === 1) markResponseAttempted();
  });
  await addSessionCookie(context, account);
  await page.goto("/app/jobs");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  const prompt = "Find the Smith job without losing this request";
  await panel.getByTestId("kody-prompt").fill(prompt);
  const assistantRequestStarted = page.waitForRequest((browserRequest) =>
    browserRequest.method() === "POST" && browserRequest.url() === `${apiBaseUrl}/v1/ai/assistant`,
  );
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await assistantRequestStarted;
  await expect(panel.getByTestId("kody-cancel-request")).toBeVisible();
  await panel.getByTestId("kody-cancel-request").click();
  await expect(panel.getByTestId("kody-prompt")).toHaveValue(prompt);
  await expect(panel.getByText(/Kody stopped.*request is still here/i)).toBeVisible();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText(/I found 5 active bookings/)).toBeVisible();
  await expect(panel.getByText(prompt, { exact: true })).toHaveCount(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[1].key).toBe(attempts[0].key);
  expect(attempts[1].body).toEqual(attempts[0].body);
  releaseAssistantResponse();
  await responseAttempted;
  await expect(panel.getByText(/I found 5 active bookings/)).toHaveCount(1);

  await panel.getByTestId("kody-prompt").fill("Find a different Johnson job");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2].key).not.toBe(attempts[1].key);
  expect(attempts[2].body).not.toEqual(attempts[1].body);
});

test("Kody reuses the exact request identity after ambiguous 503 and 409 responses", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-ambiguous-retry");
  const attempts: Array<{ key: string; body: unknown }> = [];
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    attempts.push({
      key: route.request().headers()["idempotency-key"] ?? "",
      body: route.request().postDataJSON(),
    });
    const attempt = attempts.length;
    if (attempt === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
      return;
    }
    if (attempt === 3) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Still processing" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse()) });
  });
  await addSessionCookie(context, account);
  await page.goto("/app/jobs");
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");

  await panel.getByTestId("kody-prompt").fill("Retry this exact 503 request");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByLabel("Kody conversation", { exact: true }).getByText(/temporarily unavailable/i)).toBeVisible();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(panel.getByText("Retry this exact 503 request", { exact: true })).toHaveCount(1);

  await panel.getByTestId("kody-prompt").fill("Retry this exact 409 request");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByLabel("Kody conversation", { exact: true }).getByText(/already in progress/i)).toBeVisible();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(4);
  expect(attempts[3]).toEqual(attempts[2]);
  await expect(panel.getByText("Retry this exact 409 request", { exact: true })).toHaveCount(1);
  expect(attempts[2].key).not.toBe(attempts[1].key);
  expect(attempts[2].body).not.toEqual(attempts[1].body);
});

test("Kody booking review is a zero-write mobile handoff, then the normal form creates exactly one booking", async ({ context, page, request }) => {
  test.setTimeout(180_000);
  const fixture = await prepareAssignedJob(request, "Kody Booking");
  expect((await listAppointments(request, fixture)).pagination.total).toBe(0);
  let mockedResponse = bookingResponse(fixture);
  const bookingPosts: Array<Record<string, unknown>> = [];

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const requestBody = route.request().postDataJSON() as { tool?: string; context?: Record<string, unknown> };
    expect(requestBody.tool).toBe("PREPARE_BOOKING");
    expect(requestBody.context?.currentPage).toBe("jobs");
    expect(requestBody.context).not.toHaveProperty("tenantId");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockedResponse) });
  });
  page.on("request", (browserRequest) => {
    if (browserRequest.method() === "POST" && browserRequest.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments`) {
      bookingPosts.push(browserRequest.postDataJSON() as Record<string, unknown>);
    }
  });

  await addSessionCookie(context, fixture.owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/jobs?view=jobs");
  const firstHandoff = await runQuickAction(page, "kody-quick-prepare_booking", "Review booking");
  const authorizedJobRefetch = page.waitForResponse((response) =>
    response.request().method() === "GET" && response.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}`,
  );
  await firstHandoff.action.click();
  expect((await authorizedJobRefetch).status()).toBe(200);
  await expect(firstHandoff.panel).toBeHidden();

  const bookingForm = page.getByTestId("job-booking-form");
  await expect(bookingForm).toBeVisible();
  await expect(bookingForm.getByText("Kody prefilled only the proposed time.")).toBeVisible();
  await expect(bookingForm.getByLabel("Start time", { exact: true })).toHaveValue(localDateTimeInput("2026-08-28T16:00:00.000Z", fixture.timeZone));
  await expect(bookingForm.getByLabel("End time", { exact: true })).toHaveValue(localDateTimeInput("2026-08-28T18:00:00.000Z", fixture.timeZone));
  await expect(bookingForm.getByLabel("Start time", { exact: true })).toBeFocused();
  expect(bookingPosts).toHaveLength(0);
  await expectNoSeriousAccessibilityViolations(page, "mobile Kody booking review handoff");

  await page.getByRole("button", { name: "Hide booking form", exact: true }).click();
  await expect(bookingForm).toBeHidden();
  expect(bookingPosts).toHaveLength(0);
  expect((await listAppointments(request, fixture)).pagination.total).toBe(0);

  await page.goto("/app/jobs?view=jobs");
  const secondHandoff = await runQuickAction(page, "kody-quick-prepare_booking", "Review booking");
  await secondHandoff.action.click();
  await expect(bookingForm).toBeVisible();
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments`,
  );
  await bookingForm.getByRole("button", { name: "Create booking", exact: true }).click();
  expect((await createResponse).status()).toBe(201);
  expect(bookingPosts).toHaveLength(1);
  expect(bookingPosts[0]).toEqual({
    assignedTenantUserId: fixture.member.membershipId,
    startsAtUtc: "2026-08-28T16:00:00.000Z",
    endsAtUtc: "2026-08-28T18:00:00.000Z",
    timeZone: fixture.timeZone,
    instructions: null,
  });
  await page.getByTestId("kody-launcher").click();
  await expect(page.getByTestId("kody-chat-panel").getByText(new RegExp(`Job #${fixture.job.jobNumber}.*is booked`))).toBeVisible();
  await page.getByRole("button", { name: "Close Kody", exact: true }).click();
  expect((await listAppointments(request, fixture)).pagination.total).toBe(1);

  mockedResponse = bookingResponse(fixture, {
    customerId: "forged-customer-id",
    assignedTenantUserId: "forged-assignee-id",
  });
  await page.goto("/app/jobs?view=jobs");
  const forgedHandoff = await runQuickAction(page, "kody-quick-prepare_booking", "Review booking");
  await forgedHandoff.action.click();
  await expect(page.getByText("This job or booking changed after Kody prepared the review.")).toBeVisible();
  await expect(bookingForm).toBeHidden();
  expect(bookingPosts).toHaveLength(1);
  expect((await listAppointments(request, fixture)).pagination.total).toBe(1);
});

test("canceling a Kody reschedule handoff restores focus to the persistent Kody launcher", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const fixture = await prepareAssignedJob(request, "Kody Reschedule Return");
  const created = await request.post(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: {
      assignedTenantUserId: fixture.member.membershipId,
      startsAtUtc: "2026-08-28T16:00:00.000Z",
      endsAtUtc: "2026-08-28T18:00:00.000Z",
      timeZone: fixture.timeZone,
      instructions: "Bring filter sizes",
    },
  });
  expect(created.status()).toBe(201);
  const appointment = ((await created.json()) as { appointment: AppointmentSummary }).appointment;
  const response = bookingResponse(fixture, {
    mode: "RESCHEDULE",
    appointmentId: appointment.id,
    appointmentVersion: appointment.version,
    expectedStatus: "SCHEDULED",
    startsAtUtc: "2026-08-29T16:00:00.000Z",
    endsAtUtc: "2026-08-29T18:00:00.000Z",
  });
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(response),
  }));
  await addSessionCookie(context, fixture.owner);
  await page.goto(`/app/jobs/${fixture.job.id}`);
  const handoff = await runQuickAction(page, "kody-quick-prepare_booking", "Review booking");
  await handoff.action.click();
  const dialog = page.getByRole("dialog", { name: "Review reschedule" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("kody-launcher")).toBeFocused();

  // Kody can propose a different time, but accepting an edited proposal that
  // matches the current booking must not publish a reschedule outcome.
  await page.evaluate(() => {
    (window as Window & { __kodyRescheduleOutcomes?: number }).__kodyRescheduleOutcomes = 0;
    window.addEventListener("quotefly:kody-outcome", (event) => {
      if ((event as CustomEvent<{ type?: string }>).detail?.type === "BOOKING_RESCHEDULED") {
        (window as Window & { __kodyRescheduleOutcomes?: number }).__kodyRescheduleOutcomes! += 1;
      }
    });
  });
  const retry = await runQuickAction(page, "kody-quick-prepare_booking", "Review booking");
  await retry.action.click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Start time", { exact: true }).fill(localDateTimeInput(appointment.startsAtUtc, fixture.timeZone));
  await dialog.getByLabel("End time", { exact: true }).fill(localDateTimeInput(appointment.endsAtUtc, fixture.timeZone));
  const noOpResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`),
  );
  await dialog.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
  const noOpPayload = await (await noOpResponse).json() as { notificationReceipt: null };
  expect(noOpPayload.notificationReceipt).toBeNull();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "No changes were made." })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __kodyRescheduleOutcomes?: number }).__kodyRescheduleOutcomes,
  )).toBe(0);
  await expect(page.getByTestId("kody-launcher")).toBeFocused();
});

test("Kody dispatch review refetches current data and preserves the desktop review across stale and forbidden failures", async ({ context, page, request }) => {
  test.setTimeout(180_000);
  const fixture = await prepareAssignedJob(request, "Kody Dispatch");
  const createdResponse = await request.post(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: {
      assignedTenantUserId: fixture.member.membershipId,
      startsAtUtc: "2026-08-29T16:00:00.000Z",
      endsAtUtc: "2026-08-29T18:00:00.000Z",
      timeZone: fixture.timeZone,
      instructions: "Use the authorized west driveway.",
    },
  });
  expect(createdResponse.status()).toBe(201);
  let appointment = ((await createdResponse.json()) as { appointment: AppointmentSummary }).appointment;
  const localeResponse = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(localeResponse.status()).toBe(200);

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const requestBody = route.request().postDataJSON() as { tool?: string; context?: Record<string, unknown> };
    expect(requestBody.tool).toBe("PREPARE_DISPATCH");
    expect(requestBody.context?.currentPage).toBe("jobs");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dispatchResponse(fixture, appointment)) });
  });

  await addSessionCookie(context, fixture.owner);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/jobs?view=jobs");
  await page.evaluate(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.reload();

  const openDispatchReview = async () => {
    await page.goto("/app/jobs?view=jobs");
    const handoff = await runQuickAction(page, "kody-quick-prepare_dispatch", "Revisar despacho");
    const appointmentRefetch = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().startsWith(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments?`),
    );
    await handoff.action.click();
    expect((await appointmentRefetch).status()).toBe(200);
    const dialog = page.getByRole("dialog", { name: `¿Despachar a ${fixture.customer.fullName}?` });
    await expect(dialog).toBeVisible();
    await expect(handoff.panel).toBeHidden();
    return dialog;
  };

  let dialog = await openDispatchReview();
  const review = dialog.getByTestId("kody-dispatch-review");
  await expect(review).toContainText(fixture.member.user.fullName);
  await expect(review).toContainText("Use the authorized west driveway.");
  await expect(dialog).toContainText("Todavía no cambió nada ni existe una actualización dentro de la app");
  await expect(dialog).toContainText("no enviará correos electrónicos ni mensajes de texto");
  await expectNoSeriousAccessibilityViolations(page, "desktop Spanish Kody dispatch review");
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await listAppointments(request, fixture)).items[0]?.status).toBe("SCHEDULED");

  dialog = await openDispatchReview();
  const concurrentUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`, {
    headers: { Cookie: fixture.owner.cookieHeader },
    data: {
      version: appointment.version,
      startsAtUtc: "2026-08-29T16:15:00.000Z",
      endsAtUtc: "2026-08-29T18:15:00.000Z",
      timeZone: fixture.timeZone,
    },
  });
  expect(concurrentUpdate.status()).toBe(200);
  appointment = ((await concurrentUpdate.json()) as { appointment: AppointmentSummary }).appointment;

  const staleResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`,
  );
  await dialog.getByRole("button", { name: "Confirmar despacho", exact: true }).click();
  expect((await staleResponse).status()).toBe(409);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cargar la visita actualizada", exact: true })).toBeVisible();
  await expect(page.getByText("Visita despachada.", { exact: true })).toHaveCount(0);

  const reloadResponse = page.waitForResponse((response) =>
    response.request().method() === "GET"
    && response.url().startsWith(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments?`),
  );
  await dialog.getByRole("button", { name: "Cargar la visita actualizada", exact: true }).click();
  expect((await reloadResponse).status()).toBe(200);
  await page.route(`${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "You no longer have permission to dispatch this booking." }),
    });
  }, { times: 1 });
  await dialog.getByRole("button", { name: "Confirmar despacho", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No tienes permiso para completar esta acción.", { exact: true })).toBeVisible();
  await expect(page.getByText("Visita despachada.", { exact: true })).toHaveCount(0);
  expect((await listAppointments(request, fixture)).items[0]?.status).toBe("SCHEDULED");
  await expectNoSeriousAccessibilityViolations(page, "desktop Spanish Kody dispatch permission error");

  const successfulPatches: Array<Record<string, unknown>> = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.method() === "PATCH" && browserRequest.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`) {
      successfulPatches.push(browserRequest.postDataJSON() as Record<string, unknown>);
    }
  });
  const successResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url() === `${apiBaseUrl}/v1/jobs/${fixture.job.id}/appointments/${appointment.id}`
    && response.status() === 200,
  );
  await dialog.getByRole("button", { name: "Confirmar despacho", exact: true }).click();
  expect((await successResponse).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(successfulPatches).toEqual([{ version: appointment.version, status: "DISPATCHED" }]);
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  await expect(panel.getByText(new RegExp(`trabajo #${fixture.job.jobNumber}.*ahora está despachado`))).toBeVisible();
  await expect(panel.getByText(/Hay una actualización disponible dentro de la app/)).toBeVisible();
  await expect(panel.getByText(/No se envió ningún correo electrónico ni mensaje de texto/)).toBeVisible();
  expect((await listAppointments(request, fixture)).items[0]?.status).toBe("DISPATCHED");
});
