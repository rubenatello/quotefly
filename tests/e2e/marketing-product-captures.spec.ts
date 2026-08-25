import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const captureEnabled = process.env.UPDATE_MARKETING_PRODUCT_CAPTURES === "1";
const capturedAt = "2026-08-24T15:30:00.000Z";
const outputDirectory = resolve("web/public/images/product");
const stagingDirectory = resolve("test-results/marketing-product-captures");
const optimizer = resolve("scripts/optimize-product-captures.py");

function requiredLoopbackOrigin(value: string, label: string) {
  const parsed = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use an HTTP(S) loopback origin.`);
  }
  return parsed.origin;
}

const captureWebOrigin = requiredLoopbackOrigin(
  process.env.MARKETING_CAPTURE_WEB_ORIGIN
    || `http://127.0.0.1:${process.env.MARKETING_CAPTURE_WEB_PORT || "4193"}`,
  "MARKETING_CAPTURE_WEB_ORIGIN",
);
const captureApiOrigin = requiredLoopbackOrigin(
  process.env.MARKETING_CAPTURE_API_ORIGIN || "http://127.0.0.1:4194",
  "MARKETING_CAPTURE_API_ORIGIN",
);

const owner = {
  id: "membership-owner",
  tenantId: "tenant-cedar-stone",
  role: "owner",
  createdAt: "2026-01-10T18:00:00.000Z",
  capabilities: ["manageWorkspace", "viewAllWorkspaceRecords", "manageJobs", "manageInvoices"],
  assignments: { assignedCustomers: 0, assignedQuotes: 0 },
  user: {
    id: "user-jordan-ellis",
    email: "jordan@cedarstone.example",
    fullName: "Jordan Ellis",
    createdAt: "2026-01-10T18:00:00.000Z",
  },
};

const technicians = [
  {
    id: "membership-casey-morgan",
    tenantId: owner.tenantId,
    role: "member",
    createdAt: "2026-02-02T18:00:00.000Z",
    capabilities: ["viewAssignedWorkspaceRecords"],
    assignments: { assignedCustomers: 2, assignedQuotes: 2 },
    user: {
      id: "user-casey-morgan",
      email: "casey@cedarstone.example",
      fullName: "Casey Morgan",
      createdAt: "2026-02-02T18:00:00.000Z",
    },
  },
  {
    id: "membership-riley-chen",
    tenantId: owner.tenantId,
    role: "member",
    createdAt: "2026-03-05T18:00:00.000Z",
    capabilities: ["viewAssignedWorkspaceRecords"],
    assignments: { assignedCustomers: 1, assignedQuotes: 1 },
    user: {
      id: "user-riley-chen",
      email: "riley@cedarstone.example",
      fullName: "Riley Chen",
      createdAt: "2026-03-05T18:00:00.000Z",
    },
  },
] as const;

const jobs = [
  {
    id: "job-1041",
    customerId: "customer-maya-bennett",
    sourceQuoteId: "quote-heat-pump",
    assignedTenantUserId: technicians[0].id,
    jobNumber: 1041,
    status: "SCHEDULED",
    title: "Heat pump seasonal service",
    scopeSnapshot: "Inspect, clean, and test the heat pump before the fall season.",
    serviceType: "HVAC",
    serviceAddressSnapshot: "184 Juniper Way, Riverton, CA 90018",
    accessInstructions: "Use the side gate. Equipment is behind the detached garage.",
    acceptedAtUtc: "2026-08-20T18:00:00.000Z",
    scheduledAtUtc: "2026-08-24T16:00:00.000Z",
    dispatchedAtUtc: null,
    startedAtUtc: null,
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 3,
    createdAt: "2026-08-20T18:00:00.000Z",
    updatedAt: "2026-08-23T17:00:00.000Z",
    customer: { id: "customer-maya-bennett", fullName: "Maya Bennett" },
    sourceQuote: { id: "quote-heat-pump", title: "Heat pump seasonal service", status: "ACCEPTED", totalAmount: 685 },
    assignedTenantUser: technicians[0],
  },
  {
    id: "job-1042",
    customerId: "customer-theo-navarro",
    sourceQuoteId: "quote-water-heater",
    assignedTenantUserId: technicians[1].id,
    jobNumber: 1042,
    status: "DISPATCHED",
    title: "Water heater replacement",
    scopeSnapshot: "Remove the existing unit and install a high-efficiency replacement.",
    serviceType: "PLUMBING",
    serviceAddressSnapshot: "72 Orchard Terrace, Riverton, CA 90018",
    accessInstructions: "Park in the rear alley and call from the gate.",
    acceptedAtUtc: "2026-08-19T19:00:00.000Z",
    scheduledAtUtc: "2026-08-24T19:00:00.000Z",
    dispatchedAtUtc: "2026-08-24T18:45:00.000Z",
    startedAtUtc: null,
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 4,
    createdAt: "2026-08-19T19:00:00.000Z",
    updatedAt: "2026-08-24T18:45:00.000Z",
    customer: { id: "customer-theo-navarro", fullName: "Theo Navarro" },
    sourceQuote: { id: "quote-water-heater", title: "Water heater replacement", status: "ACCEPTED", totalAmount: 2400 },
    assignedTenantUser: technicians[1],
  },
  {
    id: "job-1043",
    customerId: "customer-nora-patel",
    sourceQuoteId: "quote-flooring",
    assignedTenantUserId: technicians[0].id,
    jobNumber: 1043,
    status: "SCHEDULED",
    title: "Kitchen flooring installation",
    scopeSnapshot: "Remove damaged flooring and install the approved plank layout.",
    serviceType: "FLOORING",
    serviceAddressSnapshot: "419 Cypress Lane, Riverton, CA 90018",
    accessInstructions: "Materials are staged in the garage.",
    acceptedAtUtc: "2026-08-21T20:00:00.000Z",
    scheduledAtUtc: "2026-08-25T15:30:00.000Z",
    dispatchedAtUtc: null,
    startedAtUtc: null,
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 2,
    createdAt: "2026-08-21T20:00:00.000Z",
    updatedAt: "2026-08-23T20:00:00.000Z",
    customer: { id: "customer-nora-patel", fullName: "Nora Patel" },
    sourceQuote: { id: "quote-flooring", title: "Kitchen flooring installation", status: "ACCEPTED", totalAmount: 5100 },
    assignedTenantUser: technicians[0],
  },
] as const;

function appointment(jobIndex: number, overrides: Record<string, unknown> = {}) {
  const job = jobs[jobIndex]!;
  const assignedTenantUser = job.assignedTenantUser!;
  const windows = [
    ["2026-08-24T16:00:00.000Z", "2026-08-24T18:00:00.000Z"],
    ["2026-08-24T19:00:00.000Z", "2026-08-24T21:30:00.000Z"],
    ["2026-08-25T15:30:00.000Z", "2026-08-25T18:30:00.000Z"],
  ] as const;
  return {
    id: `appointment-${job.jobNumber}`,
    jobId: job.id,
    assignedTenantUserId: assignedTenantUser.id,
    createdByTenantUserId: owner.id,
    status: job.status === "DISPATCHED" ? "DISPATCHED" : "SCHEDULED",
    startsAtUtc: windows[jobIndex]![0],
    endsAtUtc: windows[jobIndex]![1],
    timeZone: "America/Los_Angeles",
    instructions: jobIndex === 0 ? "Complete the seasonal checklist and photograph the filter label." : "Review the approved scope before starting.",
    dispatchedAtUtc: job.status === "DISPATCHED" ? "2026-08-24T18:45:00.000Z" : null,
    arrivedAtUtc: null,
    completedAtUtc: null,
    canceledAtUtc: null,
    version: job.status === "DISPATCHED" ? 2 : 1,
    createdAt: "2026-08-23T17:00:00.000Z",
    updatedAt: "2026-08-23T17:00:00.000Z",
    assignedTenantUser,
    createdByTenantUser: owner,
    ...overrides,
  };
}

const appointments = jobs.map((_, index) => appointment(index));
const schedule = appointments.map((item, index) => ({
  id: item.id,
  jobId: item.jobId,
  assignedTenantUserId: item.assignedTenantUserId,
  status: item.status,
  startsAtUtc: item.startsAtUtc,
  endsAtUtc: item.endsAtUtc,
  timeZone: item.timeZone,
  version: item.version,
  assignedTenantUser: item.assignedTenantUser,
  job: {
    id: jobs[index]!.id,
    jobNumber: jobs[index]!.jobNumber,
    status: jobs[index]!.status,
    title: jobs[index]!.title,
    serviceAddressSnapshot: jobs[index]!.serviceAddressSnapshot,
    customer: jobs[index]!.customer,
    sourceQuote: { id: jobs[index]!.sourceQuote.id, title: jobs[index]!.sourceQuote.title },
  },
}));

const activityTasks = [
  {
    id: "activity-access",
    customerId: jobs[0].customer.id,
    quoteId: jobs[0].sourceQuote.id,
    assignedTenantUserId: technicians[0].id,
    createdByTenantUserId: owner.id,
    completedByTenantUserId: null,
    type: "FOLLOW_UP",
    status: "OPEN",
    priority: "URGENT",
    title: "Confirm access for today's heat pump service",
    notes: "Side gate instructions are on the job.",
    dueAtUtc: "2026-08-24T15:45:00.000Z",
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 1,
    createdAt: "2026-08-23T17:00:00.000Z",
    updatedAt: "2026-08-23T17:00:00.000Z",
    customer: jobs[0].customer,
    quote: jobs[0].sourceQuote,
    assignedTenantUser: technicians[0],
  },
  {
    id: "activity-scope",
    customerId: jobs[2].customer.id,
    quoteId: jobs[2].sourceQuote.id,
    assignedTenantUserId: owner.id,
    createdByTenantUserId: owner.id,
    completedByTenantUserId: null,
    type: "PREPARE_QUOTE",
    status: "OPEN",
    priority: "HIGH",
    title: "Review approved flooring scope with the crew",
    notes: "Confirm material staging and the doorway transition detail.",
    dueAtUtc: "2026-08-24T17:00:00.000Z",
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 1,
    createdAt: "2026-08-23T17:30:00.000Z",
    updatedAt: "2026-08-23T17:30:00.000Z",
    customer: jobs[2].customer,
    quote: jobs[2].sourceQuote,
    assignedTenantUser: owner,
  },
  {
    id: "activity-check-in",
    customerId: jobs[1].customer.id,
    quoteId: jobs[1].sourceQuote.id,
    assignedTenantUserId: owner.id,
    createdByTenantUserId: owner.id,
    completedByTenantUserId: null,
    type: "CHECK_IN",
    status: "OPEN",
    priority: "NORMAL",
    title: "Check in after the water heater installation",
    notes: null,
    dueAtUtc: "2026-08-25T20:00:00.000Z",
    completedAtUtc: null,
    canceledAtUtc: null,
    version: 1,
    createdAt: "2026-08-23T18:00:00.000Z",
    updatedAt: "2026-08-23T18:00:00.000Z",
    customer: jobs[1].customer,
    quote: jobs[1].sourceQuote,
    assignedTenantUser: owner,
  },
] as const;

const invoice = {
  id: "invoice-1042",
  customerId: jobs[1].customer.id,
  jobId: jobs[1].id,
  sourceQuoteId: jobs[1].sourceQuote.id,
  invoiceNumber: 1042,
  status: "DRAFT",
  paymentStatus: "PENDING",
  titleSnapshot: jobs[1].title,
  documentLocale: "en-US",
  currency: "USD",
  subtotalAmount: 2250,
  taxAmount: 150,
  totalAmount: 2400,
  amountPaid: 0,
  balanceDue: 2400,
  issuedAtUtc: null,
  dueAtUtc: "2026-09-23T19:00:00.000Z",
  sentAtUtc: null,
  paidAtUtc: null,
  voidedAtUtc: null,
  version: 1,
  createdAt: "2026-08-23T19:00:00.000Z",
  updatedAt: "2026-08-23T19:00:00.000Z",
  customer: jobs[1].customer,
  job: { id: jobs[1].id, jobNumber: jobs[1].jobNumber, status: jobs[1].status, title: jobs[1].title },
  sourceQuote: jobs[1].sourceQuote,
};

const notifications = [
  { id: "notification-dispatched", kind: "DISPATCHED", appointmentId: appointments[1]!.id, jobIndex: 1, createdAt: "2026-08-24T18:45:00.000Z" },
  { id: "notification-booked", kind: "BOOKED", appointmentId: appointments[0]!.id, jobIndex: 0, createdAt: "2026-08-23T17:00:00.000Z" },
  { id: "notification-rescheduled", kind: "RESCHEDULED", appointmentId: appointments[2]!.id, jobIndex: 2, createdAt: "2026-08-23T16:00:00.000Z" },
].map((item, index) => ({
  id: item.id,
  kind: item.kind,
  appointmentId: item.appointmentId,
  templateKey: `job_appointment_${item.kind.toLowerCase()}`,
  templateVersion: 1,
  sourceVersion: index + 1,
  startsAtUtc: appointments[item.jobIndex]!.startsAtUtc,
  endsAtUtc: appointments[item.jobIndex]!.endsAtUtc,
  timeZone: "America/Los_Angeles",
  deliveryStatus: "AVAILABLE",
  deliveredAtUtc: null,
  readAtUtc: index === 2 ? "2026-08-23T18:00:00.000Z" : null,
  version: 1,
  createdAt: item.createdAt,
  updatedAt: item.createdAt,
  job: {
    id: jobs[item.jobIndex]!.id,
    jobNumber: jobs[item.jobIndex]!.jobNumber,
    title: jobs[item.jobIndex]!.title,
    customer: jobs[item.jobIndex]!.customer,
  },
}));

const overview = {
  generatedAtUtc: capturedAt,
  metrics: {
    activeCustomers: 18,
    unquotedLeads: 3,
    needsFollowUp: 4,
    activeQuotes: 7,
    openPipelineRevenue: 12860,
    acceptedRevenue: 8185,
    activeJobs: 3,
    afterSaleDue: 1,
  },
  quoteStatusCounts: { DRAFT: 2, READY_FOR_REVIEW: 1, SENT_TO_CUSTOMER: 4, ACCEPTED: 3, REJECTED: 1 },
  attention: [],
  recentCustomers: jobs.map((job) => ({
    id: job.customer.id,
    fullName: job.customer.fullName,
    followUpStatus: "WON",
    createdAt: job.createdAt,
    latestQuote: { ...job.sourceQuote, updatedAt: job.updatedAt },
  })),
  recentQuotes: jobs.map((job) => ({
    ...job.sourceQuote,
    updatedAt: job.updatedAt,
    customer: job.customer,
  })),
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": captureWebOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,idempotency-key",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  });
}

async function installProductCaptureApi(page: Page) {
  const unhandled = new Set<string>();
  const unexpectedExternal = new Set<string>();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (url.origin === captureWebOrigin) return route.continue();
    if (url.origin !== captureApiOrigin || !path.startsWith("/v1/")) {
      unexpectedExternal.add(`${request.method()} ${url.origin}${path}`);
      return route.abort("blockedbyclient");
    }

    if (request.method() === "OPTIONS") return json(route, {}, 204);
    if (path === "/v1/auth/me") {
      return json(route, {
        user: { ...owner.user, preferredLocale: "en-US" },
        tenant: {
          id: owner.tenantId,
          name: "Cedar & Stone Home Services",
          slug: "cedar-stone-home-services",
          timezone: "America/Los_Angeles",
          primaryTrade: "HVAC",
          onboardingCompletedAtUtc: "2026-01-10T18:30:00.000Z",
          subscriptionStatus: "active",
          subscriptionPlanCode: "starter",
          subscriptionCurrentPeriodEndUtc: "2026-09-15T07:00:00.000Z",
          effectivePlanCode: "starter",
          effectivePlanName: "Basic",
          isTrial: false,
          entitlements: {
            planCode: "starter",
            planName: "Basic",
            seatPlanCode: "starter",
            seatPlanName: "Basic",
            isTrial: false,
            hasWorkspaceAccess: true,
            billingRequired: false,
            accessReason: "paid",
            limits: { quotesPerMonth: 600, aiQuotesPerMonth: 770, aiSpendUsdPerMonth: 1.25, teamMembers: 7, quoteHistoryDays: 30 },
            features: { quoteVersionHistory: true, communicationLog: false, advancedAnalytics: false, multiTrade: false, apiAccess: false, auditLogs: false, aiAutomation: true },
          },
          usage: {
            periodStartUtc: "2026-08-15T07:00:00.000Z",
            periodEndUtc: "2026-09-15T07:00:00.000Z",
            periodSource: "PAID_SUBSCRIPTION",
            monthlyQuoteCount: 12,
            monthlyAiQuoteCount: 4,
            monthlyAiSpendUsd: 0.18,
            monthlyAiSpendLimitUsd: 1.25,
            monthlyAiSpendRemainingUsd: 1.07,
            monthlyAiSpendUsagePercent: 14.4,
            monthlyAiLimitReached: false,
            limitReached: false,
          },
        },
        role: "owner",
        isSuperuser: false,
      });
    }
    if (path === "/v1/notifications/summary") {
      return json(route, { unreadCount: 2, totalCount: notifications.length, latestCreatedAtUtc: notifications[0]!.createdAt });
    }
    if (path === "/v1/notifications") {
      return json(route, { items: notifications, page: { limit: 25, hasMore: false, nextCursor: null } });
    }
    if (path === "/v1/workspace/overview") return json(route, overview);
    if (path === "/v1/activities/summary") {
      return json(route, {
        generatedAtUtc: capturedAt,
        timezone: "America/Los_Angeles",
        windows: {
          todayStartUtc: "2026-08-24T07:00:00.000Z",
          tomorrowStartUtc: "2026-08-25T07:00:00.000Z",
          upcomingEndUtc: "2026-09-01T07:00:00.000Z",
          completedStartUtc: "2026-08-17T07:00:00.000Z",
        },
        counts: { overdue: 0, today: 2, upcoming: 1, completed: 5 },
        top: activityTasks,
      });
    }
    if (path === "/v1/activities") {
      return json(route, { items: activityTasks, pagination: { limit: 25, offset: 0, total: activityTasks.length }, scope: { mine: true } });
    }
    if (path === "/v1/org/users") {
      return json(route, { members: [owner, ...technicians], pagination: { limit: 100, offset: 0, total: 3 } });
    }
    if (path === "/v1/jobs/schedule") {
      return json(route, { items: schedule, pagination: { limit: 100, offset: 0, total: schedule.length } });
    }
    if (path === "/v1/jobs") {
      return json(route, { items: jobs, pagination: { limit: 25, offset: 0, total: jobs.length }, scope: { mine: false } });
    }
    const appointmentsMatch = path.match(/^\/v1\/jobs\/([^/]+)\/appointments$/);
    if (appointmentsMatch) {
      const items = appointments.filter((item) => item.jobId === appointmentsMatch[1]);
      return json(route, { items, pagination: { limit: 25, offset: 0, total: items.length } });
    }
    const notesMatch = path.match(/^\/v1\/jobs\/([^/]+)\/notes$/);
    if (notesMatch) {
      const job = jobs.find((item) => item.id === notesMatch[1]);
      const items = job ? [{
        id: `note-${job.jobNumber}`,
        jobId: job.id,
        createdByTenantUserId: owner.id,
        body: "Crew confirmed materials, arrival window, and access details.",
        createdAt: "2026-08-23T19:30:00.000Z",
        createdByTenantUser: owner,
      }] : [];
      return json(route, { items, pagination: { limit: 25, offset: 0, total: items.length } });
    }
    const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const job = jobs.find((item) => item.id === jobMatch[1]);
      return job ? json(route, { job }) : json(route, { error: "Job not found" }, 404);
    }
    if (path === "/v1/invoices") {
      return json(route, {
        items: url.searchParams.get("jobId") === jobs[1].id ? [invoice] : [],
        pagination: { limit: 1, offset: 0, total: url.searchParams.get("jobId") === jobs[1].id ? 1 : 0 },
        scope: { mine: false },
      });
    }
    if (path === `/v1/integrations/quickbooks/invoices/${invoice.id}/sync-preview`) {
      return json(route, {
        providerWorkflowsEnabled: false,
        preview: {
          invoice: {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            version: invoice.version,
            status: invoice.status,
            customerName: jobs[1].customer.fullName,
            currency: invoice.currency,
            subtotalAmount: invoice.subtotalAmount,
            taxAmount: invoice.taxAmount,
            totalAmount: invoice.totalAmount,
            dueAtUtc: invoice.dueAtUtc,
          },
          connection: null,
          quickBooksCustomerName: null,
          providerDocNumber: "QF-001042",
          lineItems: [{
            description: jobs[1].title,
            quantity: 1,
            unitPrice: invoice.subtotalAmount,
            amount: invoice.subtotalAmount,
            mapped: false,
            quickBooksItemName: null,
          }],
          blockers: ["QUICKBOOKS_NOT_CONNECTED"],
          ready: false,
          reviewBinding: null,
          operation: null,
        },
      });
    }
    if (path === "/v1/ai/assistant") {
      return json(route, {
        assistant: {
          tool: "LIST_SCHEDULE",
          generatedAtUtc: capturedAt,
          policyVersion: "2026-08-12",
          maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
          answer: "I found three scheduled visits across the field team. Review the timing and assignees below before making any changes.",
          results: schedule.map((item) => ({
            appointmentId: item.id,
            jobNumber: item.job.jobNumber,
            customerName: item.job.customer.fullName,
            jobTitle: item.job.title,
            startsAtUtc: item.startsAtUtc,
            endsAtUtc: item.endsAtUtc,
            timeZone: item.timeZone,
            assigneeName: item.assignedTenantUser.user.fullName,
            appointmentStatus: item.status,
          })),
          citations: [],
          actions: [],
          auditEventId: "audit-marketing-schedule-review",
          fieldsExcluded: ["contact details", "access instructions", "internal costs", "margins"],
          conversation: { mode: "NEW", acknowledgement: null, previousTool: null, currentTool: "LIST_SCHEDULE" },
          diagnostics: {
            requestedTool: "AUTO",
            resolvedTool: "LIST_SCHEDULE",
            resultCount: schedule.length,
            citationCount: 0,
            emptyReason: null,
            archivePolicy: "Only active, tenant-scoped appointments are included.",
            filters: { fromUtc: "2026-08-24T07:00:00.000Z", toUtc: "2026-08-26T07:00:00.000Z", mine: false },
            answerMode: "DETERMINISTIC",
            model: null,
          },
        },
        usage: {
          consumedCredits: 0,
          consumedSpendUsd: 0,
          monthlyCreditsUsed: 4,
          monthlyCreditsLimit: 770,
          monthlyCreditsRemaining: 766,
          monthlySpendUsedUsd: 0.18,
          monthlySpendLimitUsd: 1.25,
          monthlySpendRemainingUsd: 1.07,
          monthlySpendUsagePercent: 14.4,
          estimatedPromptsRemaining: 660,
          renewsAtUtc: "2026-09-15T07:00:00.000Z",
        },
      });
    }

    unhandled.add(`${request.method()} ${path}`);
    return json(route, { error: "Unhandled marketing capture request" }, 404);
  });
  return { unhandled, unexpectedExternal };
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(150);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

type CaptureBudgets = {
  v1: number;
  v2: number;
};

const desktopCaptureBudgets: CaptureBudgets = { v1: 225_000, v2: 600_000 };
const mobileCaptureBudgets: CaptureBudgets = { v1: 95_000, v2: 260_000 };

async function writeCapture(page: Page, name: string, budgets: CaptureBudgets) {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    const planLabels = page.getByText("Basic", { exact: true });
    const visiblePlanLabels = await planLabels.count().then(async (count) => {
      let visible = 0;
      for (let index = 0; index < count; index += 1) {
        if (await planLabels.nth(index).isVisible()) visible += 1;
      }
      return visible;
    });
    expect(visiblePlanLabels, "Desktop product captures must visibly show the sellable Basic plan.").toBeGreaterThan(0);
  }
  const pngPath = resolve(stagingDirectory, `${name}-dpr2.png`);
  const v1WebpPath = resolve(outputDirectory, `${name}-v1.webp`);
  const v2WebpPath = resolve(outputDirectory, `${name}-v2.webp`);
  await page.screenshot({ path: pngPath, fullPage: false, animations: "disabled" });
  const result = spawnSync(
    process.env.PYTHON || "python",
    [
      optimizer,
      pngPath,
      v1WebpPath,
      v2WebpPath,
      "--v1-max-bytes",
      String(budgets.v1),
      "--v2-max-bytes",
      String(budgets.v2),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

async function showKodyScheduleReview(page: Page, expandResults: boolean) {
  await page.goto("/app/jobs?view=schedule&range=day&date=2026-08-24&assignee=all");
  await expect(page.getByText("Today and upcoming work", { exact: true })).toBeVisible();
  await page.getByTestId("kody-launcher").click();
  const panel = page.getByTestId("kody-chat-panel");
  await panel.getByTestId("kody-prompt").fill("Show today's schedule for the field team");
  await panel.getByRole("button", { name: "Send", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(panel.getByText("I found three scheduled visits", { exact: false })).toBeVisible();
  const results = panel.getByTestId("kody-results");
  await expect(results.getByText("View 3 results", { exact: true })).toBeVisible();
  if (expandResults) {
    await results.locator(":scope > summary").evaluate((summary) => (summary as HTMLElement).click());
    await expect(panel.getByTestId("kody-schedule-card").first()).toBeVisible();
  }
}

async function showNotifications(page: Page) {
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.locator('button[aria-label="Notifications, 2 unread"]:visible').click();
  await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
}

async function expectLocalizedQuickBooksBlocker(invoicePanel: Locator) {
  const quickBooksPanel = invoicePanel.getByTestId("quickbooks-invoice-panel");
  await expect(quickBooksPanel).toContainText("Connect QuickBooks in workspace settings.");
  await expect(quickBooksPanel).not.toContainText("invoices.quickBooks");
}

test.skip(!captureEnabled, "Set UPDATE_MARKETING_PRODUCT_CAPTURES=1 to regenerate checked-in product images.");

test("regenerates sanitized product-proof captures from deterministic QuoteFly UI", async ({ page }) => {
  test.setTimeout(240_000);
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const { unhandled, unexpectedExternal } = await installProductCaptureApi(page);
  await page.clock.setFixedTime(capturedAt);
  await page.addInitScript(() => {
    window.localStorage.setItem("qf_locale", "en-US");
    window.localStorage.setItem("qf_theme_preference", "light");
    window.localStorage.setItem("qf_sidebar_collapsed", "false");
    window.localStorage.setItem("qf_cookie_consent", JSON.stringify({
      choice: "essential",
      version: 1,
      updatedAtUtc: "2026-08-24T15:30:00.000Z",
      expiresAtUtc: "2099-01-01T00:00:00.000Z",
    }));
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await settle(page);
  await writeCapture(page, "activity-my-day-desktop", desktopCaptureBudgets);

  await page.goto("/app/jobs?view=schedule&range=day&date=2026-08-24&assignee=all");
  await expect(page.getByText("Today and upcoming work", { exact: true })).toBeVisible();
  await settle(page);
  await writeCapture(page, "jobs-schedule-desktop", desktopCaptureBudgets);

  await page.goto(`/app/jobs/${jobs[0].id}`);
  await expect(page.getByText("Job #1041", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await writeCapture(page, "job-detail-desktop", desktopCaptureBudgets);

  await showKodyScheduleReview(page, true);
  await settle(page);
  await writeCapture(page, "kody-review-desktop", desktopCaptureBudgets);

  await page.goto(`/app/jobs/${jobs[1].id}`);
  const invoicePanel = page.getByTestId("invoice-panel");
  await expect(invoicePanel.getByText("Invoice #1042", { exact: true })).toBeVisible();
  await invoicePanel.scrollIntoViewIfNeeded();
  await expectLocalizedQuickBooksBlocker(invoicePanel);
  await settle(page);
  await writeCapture(page, "internal-invoice-desktop", desktopCaptureBudgets);

  await showNotifications(page);
  await settle(page);
  await writeCapture(page, "notification-center-desktop", desktopCaptureBudgets);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" }).getByText("Basic", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeHidden();
  await settle(page);
  await writeCapture(page, "activity-my-day-mobile", mobileCaptureBudgets);

  await page.goto("/app/jobs?view=schedule&range=day&date=2026-08-24&assignee=all");
  await expect(page.getByText("Today and upcoming work", { exact: true })).toBeVisible();
  const firstMobileVisit = page.locator("article:visible").filter({ hasText: "Maya Bennett" }).first();
  await expect(firstMobileVisit).toBeVisible();
  await firstMobileVisit.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -180));
  await settle(page);
  await writeCapture(page, "jobs-schedule-mobile", mobileCaptureBudgets);

  await page.goto(`/app/jobs/${jobs[0].id}`);
  await expect(page.getByText("Job #1041", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 115));
  await settle(page);
  await writeCapture(page, "job-detail-mobile", mobileCaptureBudgets);

  await showKodyScheduleReview(page, true);
  const mobileScheduleWindow = page.getByTestId("kody-schedule-card").first().locator("dd").first();
  const mobileScheduleWindowBox = await mobileScheduleWindow.boundingBox();
  expect(mobileScheduleWindowBox?.width ?? 0).toBeGreaterThan(180);
  expect(mobileScheduleWindowBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(96);
  await settle(page);
  await writeCapture(page, "kody-review-mobile", mobileCaptureBudgets);

  await page.goto(`/app/jobs/${jobs[1].id}`);
  const mobileInvoicePanel = page.getByTestId("invoice-panel");
  await expect(mobileInvoicePanel.getByText("Invoice #1042", { exact: true })).toBeVisible();
  await mobileInvoicePanel.scrollIntoViewIfNeeded();
  await expectLocalizedQuickBooksBlocker(mobileInvoicePanel);
  await settle(page);
  await writeCapture(page, "internal-invoice-mobile", mobileCaptureBudgets);

  await showNotifications(page);
  await settle(page);
  await writeCapture(page, "notification-center-mobile", mobileCaptureBudgets);

  expect([...unhandled]).toEqual([]);
  expect([...unexpectedExternal], "Capture generation must not request any unexpected external origin.").toEqual([]);
});
