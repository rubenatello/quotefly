import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

type MemberSession = Session & { membershipId: string };

let app: FastifyInstance;
let remoteAddressSequence = 1;

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(label: string): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${label}-${unique}@example.com`,
      password: "TestPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} Services ${unique}`,
      primaryTrade: "CONSTRUCTION",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

async function addMember(owner: Session, label: string, role: "member" | "admin" = "member"): Promise<MemberSession> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName: label, role },
  });
  expect(created.statusCode).toBe(201);
  const membershipId = (created.json() as { member: { id: string } }).member.id;
  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/signin",
    remoteAddress: `198.51.100.${remoteAddressSequence++}`,
    payload: { email, password },
  });
  expect(signedIn.statusCode).toBe(200);
  return { ...(signedIn.json() as Omit<Session, "cookie">), cookie: cookieFrom(signedIn), membershipId };
}

async function createCustomer(session: Session, name: string, assignedTenantUserId?: string | null) {
  const suffix = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
  return prisma.customer.create({
    data: {
      tenantId: session.tenant.id,
      fullName: name,
      phone: suffix,
      phoneDigits: suffix,
      assignedTenantUserId,
    },
  });
}

async function createQuote(session: Session, customerId: string, title: string, assignedTenantUserId?: string | null) {
  return prisma.quote.create({
    data: {
      tenantId: session.tenant.id,
      customerId,
      assignedTenantUserId,
      serviceType: "CONSTRUCTION",
      status: "DRAFT",
      title,
      scopeText: `${title} accepted scope snapshot.`,
      internalCostSubtotal: 50,
      customerPriceSubtotal: 150,
      taxAmount: 0,
      totalAmount: 150,
    },
  });
}

async function acceptQuote(session: Session, quoteId: string) {
  const response = await app.inject({
    method: "PATCH",
    url: `/v1/quotes/${quoteId}`,
    headers: { cookie: session.cookie },
    payload: { status: "ACCEPTED" },
  });
  expect(response.statusCode).toBe(200);
  return response;
}

async function jobForQuote(tenantId: string, quoteId: string) {
  return prisma.job.findFirstOrThrow({
    where: { tenantId, sourceQuoteId: quoteId, deletedAtUtc: null },
    include: { events: true },
  });
}

async function completeJobThroughAppointment(
  session: Session,
  jobId: string,
  assignedTenantUserId: string,
  startsAtUtc: string,
  endsAtUtc: string,
) {
  const created = await app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/appointments`,
    headers: { cookie: session.cookie },
    payload: {
      assignedTenantUserId,
      startsAtUtc,
      endsAtUtc,
      timeZone: "America/Los_Angeles",
    },
  });
  expect(created.statusCode).toBe(201);
  const appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;
  const dispatched = await app.inject({
    method: "PATCH",
    url: `/v1/jobs/${jobId}/appointments/${appointment.id}`,
    headers: { cookie: session.cookie },
    payload: { version: appointment.version, status: "DISPATCHED" },
  });
  expect(dispatched.statusCode).toBe(200);
  const dispatchedVersion = (dispatched.json() as { appointment: { version: number } }).appointment.version;
  const arrived = await app.inject({
    method: "PATCH",
    url: `/v1/jobs/${jobId}/appointments/${appointment.id}`,
    headers: { cookie: session.cookie },
    payload: { version: dispatchedVersion, status: "ARRIVED" },
  });
  expect(arrived.statusCode).toBe(200);
  const arrivedVersion = (arrived.json() as { appointment: { version: number } }).appointment.version;
  const completed = await app.inject({
    method: "PATCH",
    url: `/v1/jobs/${jobId}/appointments/${appointment.id}`,
    headers: { cookie: session.cookie },
    payload: { version: arrivedVersion, status: "COMPLETED" },
  });
  expect(completed.statusCode).toBe(200);
  return prisma.job.findUniqueOrThrow({ where: { id: jobId } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForAdvisoryLockWaiters(expectedMinimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock%'
    `);
    if (Number(rows[0]?.count ?? 0) >= expectedMinimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedMinimum} advisory lock waiter(s).`);
}

async function holdJobScheduleLock(tenantId: string, jobId: string, release: Promise<void>, onLocked: () => void) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT 1::int AS "locked"
      FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:job-schedule:${jobId}`}, 0))) acquired
    `);
    onLocked();
    await release;
  }, { maxWait: 5_000, timeout: 20_000 });
}

async function holdAppointmentAssigneeLock(
  tenantId: string,
  assignedTenantUserId: string,
  release: Promise<void>,
  onLocked: () => void,
) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT 1::int AS "locked"
      FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:job-appointment:${assignedTenantUserId}`}, 0))) acquired
    `);
    onLocked();
    await release;
  }, { maxWait: 5_000, timeout: 20_000 });
}

describe("jobs from accepted quotes", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("creates one unscheduled job when a quote is accepted and exposes a minimized jobs API projection", async () => {
    const owner = await signUp("jobs-acceptance");
    const customer = await createCustomer(owner, "Acceptance Customer");
    const quote = await createQuote(owner, customer.id, "Accepted patio cover");

    const acceptedResponses = await Promise.all([acceptQuote(owner, quote.id), acceptQuote(owner, quote.id)]);
    for (const response of acceptedResponses) {
      expect(response.json()).toMatchObject({
        quote: { id: quote.id, status: "ACCEPTED" },
        job: { jobNumber: 1 },
      });
    }

    expect(await prisma.job.count({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id } })).toBe(1);
    const job = await jobForQuote(owner.tenant.id, quote.id);
    expect(job).toMatchObject({
      customerId: customer.id,
      sourceQuoteId: quote.id,
      jobNumber: 1,
      status: "UNSCHEDULED",
      title: quote.title,
      scopeSnapshot: quote.scopeText,
    });
    expect(job.events).toHaveLength(1);
    expect(job.events[0]).toMatchObject({ type: "CREATED", actorTenantUserId: expect.any(String) });

    const list = await app.inject({
      method: "GET",
      url: "/v1/jobs?status=UNSCHEDULED",
      headers: { cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<Record<string, unknown>>; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: job.id,
      jobNumber: 1,
      status: "UNSCHEDULED",
      customer: { id: customer.id, fullName: customer.fullName },
      sourceQuote: { id: quote.id, title: quote.title, totalAmount: 150 },
    });
    expect(JSON.stringify(body.items[0])).not.toContain(customer.phone);
    expect(JSON.stringify(body.items[0])).not.toContain("email");
    expect(JSON.stringify(body.items[0])).not.toContain("tenantId");

    const blockedCommercialEdit = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { title: "Changed after job", customerPriceSubtotal: 999 },
    });
    expect(blockedCommercialEdit.statusCode).toBe(409);
    expect(blockedCommercialEdit.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });
    const unchangedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      select: { title: true, customerPriceSubtotal: true },
    });
    expect(unchangedQuote.title).toBe(quote.title);
    expect(Number(unchangedQuote.customerPriceSubtotal)).toBe(150);

    const sequence = await prisma.tenantSequence.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: owner.tenant.id, key: "job_number" } },
      select: { nextValue: true },
    });
    expect(sequence.nextValue).toBe(2);
  });

  test("ignores legacy job-status spoofing while preserving old quote clients", async () => {
    const owner = await signUp("jobs-legacy-compatibility");
    const customer = await createCustomer(owner, "Legacy Compatibility Customer");
    const quote = await createQuote(owner, customer.id, "Legacy compatible accepted work");
    await prisma.quoteLineItem.create({
      data: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        description: "Legacy-compatible line",
        sectionType: "INCLUDED",
        quantity: 1,
        unitCost: 50,
        unitPrice: 150,
      },
    });

    const currentClientSave = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}/sheet`,
      headers: { cookie: owner.cookie },
      payload: {
        quote: {
          serviceType: "CONSTRUCTION",
          status: "DRAFT",
          afterSaleFollowUpStatus: "NOT_READY",
          title: quote.title,
          scopeText: quote.scopeText,
          taxAmount: 0,
        },
        lineItems: [],
        newLineItems: [],
      },
    });
    expect(currentClientSave.statusCode).toBe(200);
    expect(currentClientSave.json()).toMatchObject({ quote: { jobStatus: "NOT_STARTED" }, job: null });

    const sheetAcceptance = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}/sheet`,
      headers: { cookie: owner.cookie },
      payload: {
        quote: {
          serviceType: "CONSTRUCTION",
          status: "ACCEPTED",
          jobStatus: "COMPLETED",
          afterSaleFollowUpStatus: "NOT_READY",
          title: quote.title,
          scopeText: quote.scopeText,
          taxAmount: 0,
        },
        lineItems: [],
        newLineItems: [],
      },
    });
    expect(sheetAcceptance.statusCode).toBe(200);
    const acceptedBody = sheetAcceptance.json() as { job: { id: string; jobNumber: number } };
    expect(acceptedBody).toMatchObject({
      quote: { status: "ACCEPTED", jobStatus: "NOT_STARTED", jobCompletedAtUtc: null },
      job: { jobNumber: 1 },
    });
    expect((await jobForQuote(owner.tenant.id, quote.id)).status).toBe("UNSCHEDULED");
    const reloadedQuote = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(reloadedQuote.statusCode).toBe(200);
    expect(reloadedQuote.json()).toMatchObject({
      quote: { acceptedJob: { id: acceptedBody.job.id, jobNumber: acceptedBody.job.jobNumber, status: "UNSCHEDULED" } },
    });

    const compatiblePatch = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { jobStatus: "IN_PROGRESS", afterSaleFollowUpStatus: "DUE" },
    });
    expect(compatiblePatch.statusCode).toBe(200);
    expect(compatiblePatch.json()).toMatchObject({
      quote: { jobStatus: "NOT_STARTED", jobCompletedAtUtc: null, afterSaleFollowUpStatus: "DUE" },
    });

    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { jobStatus: "COMPLETED" },
    });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ code: "QUOTE_JOB_STATUS_MOVED" });
    expect(await prisma.job.count({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id } })).toBe(1);
  });

  test("restores accepted commercial history without restoring operational state or duplicating its job", async () => {
    const owner = await signUp("jobs-accepted-restore");
    const customer = await createCustomer(owner, "Accepted Restore Customer");
    const quote = await createQuote(owner, customer.id, "Current commercial draft");
    const historicalCompletion = "2026-01-01T18:00:00.000Z";
    const revision = await prisma.quoteRevision.create({
      data: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        customerId: customer.id,
        version: 1,
        eventType: "UPDATED",
        changedFields: ["status", "title"],
        actorUserId: owner.user.id,
        actorEmail: owner.user.email,
        actorName: owner.user.fullName,
        title: "Historical accepted work",
        status: "ACCEPTED",
        customerPriceSubtotal: 150,
        totalAmount: 150,
        snapshot: {
          quote: {
            id: quote.id,
            title: "Historical accepted work",
            serviceType: "CONSTRUCTION",
            status: "ACCEPTED",
            jobStatus: "COMPLETED",
            afterSaleFollowUpStatus: "COMPLETED",
            scopeText: "Historical accepted commercial scope.",
            internalCostSubtotal: 50,
            customerPriceSubtotal: 150,
            taxAmount: 0,
            totalAmount: 150,
            documentLocale: "en-US",
            sentAtUtc: null,
            closedAtUtc: historicalCompletion,
            jobCompletedAtUtc: historicalCompletion,
            afterSaleFollowUpDueAtUtc: historicalCompletion,
            afterSaleFollowUpCompletedAtUtc: historicalCompletion,
          },
          customer: {
            id: customer.id,
            fullName: customer.fullName,
            email: customer.email,
            phone: customer.phone,
          },
          lineItems: [],
        },
      },
    });

    const restored = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/history/${revision.id}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      quote: {
        status: "ACCEPTED",
        title: "Historical accepted work",
        jobStatus: "NOT_STARTED",
        jobCompletedAtUtc: null,
        afterSaleFollowUpStatus: "NOT_READY",
        afterSaleFollowUpDueAtUtc: null,
      },
      job: { jobNumber: 1 },
    });
    expect(await prisma.job.count({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id } })).toBe(1);
    expect((await jobForQuote(owner.tenant.id, quote.id)).status).toBe("UNSCHEDULED");

    const repeatedRestore = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/history/${revision.id}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(repeatedRestore.statusCode).toBe(409);
    expect(repeatedRestore.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });
    expect(await prisma.job.count({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id } })).toBe(1);
  });

  test("opens after-sale follow-up on authoritative completion without overwriting manual completion", async () => {
    const owner = await signUp("jobs-after-sale-handoff");
    const member = await addMember(owner, "After Sale Field Member");
    const customer = await createCustomer(owner, "After Sale Customer", member.membershipId);
    const dueQuote = await createQuote(owner, customer.id, "After sale due work", member.membershipId);
    const completedQuote = await createQuote(owner, customer.id, "Manually completed follow-up work", member.membershipId);
    await acceptQuote(owner, dueQuote.id);
    await acceptQuote(owner, completedQuote.id);
    const dueJob = await jobForQuote(owner.tenant.id, dueQuote.id);
    const manuallyCompletedJob = await jobForQuote(owner.tenant.id, completedQuote.id);

    const completedDueJob = await completeJobThroughAppointment(
      owner,
      dueJob.id,
      member.membershipId,
      "2026-06-01T16:00:00.000Z",
      "2026-06-01T18:00:00.000Z",
    );
    expect(completedDueJob.status).toBe("COMPLETED");
    const dueSourceQuote = await prisma.quote.findUniqueOrThrow({ where: { id: dueQuote.id } });
    expect(dueSourceQuote.afterSaleFollowUpStatus).toBe("DUE");
    expect(dueSourceQuote.afterSaleFollowUpCompletedAtUtc).toBeNull();
    expect(dueSourceQuote.afterSaleFollowUpDueAtUtc?.getTime()).toBe(
      completedDueJob.completedAtUtc!.getTime() + 7 * 24 * 60 * 60 * 1000,
    );

    const manualDueAt = new Date("2026-06-05T17:00:00.000Z");
    const manualCompletedAt = new Date("2026-06-05T18:00:00.000Z");
    await prisma.quote.update({
      where: { id: completedQuote.id },
      data: {
        afterSaleFollowUpStatus: "COMPLETED",
        afterSaleFollowUpDueAtUtc: manualDueAt,
        afterSaleFollowUpCompletedAtUtc: manualCompletedAt,
      },
    });
    await completeJobThroughAppointment(
      owner,
      manuallyCompletedJob.id,
      member.membershipId,
      "2026-06-02T16:00:00.000Z",
      "2026-06-02T18:00:00.000Z",
    );
    const preserved = await prisma.quote.findUniqueOrThrow({ where: { id: completedQuote.id } });
    expect(preserved.afterSaleFollowUpStatus).toBe("COMPLETED");
    expect(preserved.afterSaleFollowUpDueAtUtc).toEqual(manualDueAt);
    expect(preserved.afterSaleFollowUpCompletedAtUtc).toEqual(manualCompletedAt);
  });

  test("serializes concurrent accepted quotes into unique tenant job numbers", async () => {
    const owner = await signUp("jobs-concurrent-numbering");
    const customer = await createCustomer(owner, "Concurrent Job Customer");
    const firstQuote = await createQuote(owner, customer.id, "First concurrent accepted work");
    const secondQuote = await createQuote(owner, customer.id, "Second concurrent accepted work");

    await Promise.all([acceptQuote(owner, firstQuote.id), acceptQuote(owner, secondQuote.id)]);

    const jobs = await prisma.job.findMany({
      where: { tenantId: owner.tenant.id },
      orderBy: { jobNumber: "asc" },
      include: { events: true },
    });
    expect(jobs.map((job) => job.jobNumber)).toEqual([1, 2]);
    expect(jobs.every((job) => job.events.length === 1)).toBe(true);
    const sequence = await prisma.tenantSequence.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: owner.tenant.id, key: "job_number" } },
      select: { nextValue: true },
    });
    expect(sequence.nextValue).toBe(3);
  });

  test("keeps member job visibility scoped to the assigned member and linked assigned records", async () => {
    const owner = await signUp("jobs-member-scope");
    const alpha = await addMember(owner, "Job Alpha Member");
    const beta = await addMember(owner, "Job Beta Member");

    const alphaCustomer = await createCustomer(owner, "Alpha Job Customer", alpha.membershipId);
    const alphaQuote = await createQuote(owner, alphaCustomer.id, "Alpha accepted work", alpha.membershipId);
    const betaCustomer = await createCustomer(owner, "Beta Job Customer", beta.membershipId);
    const betaQuote = await createQuote(owner, betaCustomer.id, "Beta accepted work", beta.membershipId);

    await acceptQuote(owner, alphaQuote.id);
    await acceptQuote(owner, betaQuote.id);
    const alphaJob = await jobForQuote(owner.tenant.id, alphaQuote.id);
    const betaJob = await jobForQuote(owner.tenant.id, betaQuote.id);

    const alphaList = await app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { cookie: alpha.cookie },
    });
    expect(alphaList.statusCode).toBe(200);
    const alphaItems = (alphaList.json() as { items: Array<{ id: string; title: string }> }).items;
    expect(alphaItems.map((job) => job.id)).toContain(alphaJob.id);
    expect(alphaItems.map((job) => job.id)).not.toContain(betaJob.id);
    expect(alphaList.body).not.toContain("Beta Job Customer");

    const forbiddenDetail = await app.inject({
      method: "GET",
      url: `/v1/jobs/${betaJob.id}`,
      headers: { cookie: alpha.cookie },
    });
    expect(forbiddenDetail.statusCode).toBe(404);
    expect(forbiddenDetail.json()).toMatchObject({ code: "JOB_NOT_FOUND" });
  });

  test("scopes workspace job summaries and active counts by tenant and member visibility", async () => {
    const owner = await signUp("jobs-workspace-scope");
    const alpha = await addMember(owner, "Workspace Job Alpha");
    const beta = await addMember(owner, "Workspace Job Beta");
    const otherOwner = await signUp("jobs-workspace-other");

    const alphaCustomer = await createCustomer(owner, "Workspace Alpha Customer", alpha.membershipId);
    const alphaQuote = await createQuote(owner, alphaCustomer.id, "Workspace Alpha Job", alpha.membershipId);
    const alphaDispatchedCustomer = await createCustomer(owner, "Workspace Alpha Dispatched Customer", alpha.membershipId);
    const alphaDispatchedQuote = await createQuote(
      owner,
      alphaDispatchedCustomer.id,
      "Workspace Alpha Dispatched Job",
      alpha.membershipId,
    );
    const betaCustomer = await createCustomer(owner, "Workspace Beta Customer", beta.membershipId);
    const betaQuote = await createQuote(owner, betaCustomer.id, "Workspace Beta Job", beta.membershipId);
    const otherCustomer = await createCustomer(otherOwner, "Cross Tenant Workspace Secret");
    const otherQuote = await createQuote(otherOwner, otherCustomer.id, "Cross Tenant Workspace Job");
    await acceptQuote(owner, alphaQuote.id);
    await acceptQuote(owner, alphaDispatchedQuote.id);
    await acceptQuote(owner, betaQuote.id);
    await acceptQuote(otherOwner, otherQuote.id);
    const alphaJob = await jobForQuote(owner.tenant.id, alphaQuote.id);
    const alphaDispatchedJob = await jobForQuote(owner.tenant.id, alphaDispatchedQuote.id);
    await prisma.job.update({ where: { id: alphaDispatchedJob.id }, data: { status: "DISPATCHED" } });
    // Simulate an old Quote row carrying stale compatibility data. Both the
    // flat and nested follow-up projections must remain authoritative Job data.
    await prisma.quote.update({ where: { id: alphaQuote.id }, data: { jobStatus: "COMPLETED" } });

    const alphaFollowUp = await app.inject({
      method: "GET",
      url: "/v1/workspace/follow-up?queue=closed",
      headers: { cookie: alpha.cookie },
    });
    expect(alphaFollowUp.statusCode).toBe(200);
    expect(alphaFollowUp.json()).toMatchObject({
      pagination: { total: 2 },
      items: [
        {
          customerId: alphaCustomer.id,
          quoteId: alphaQuote.id,
          jobStatus: "UNSCHEDULED",
          job: { id: alphaJob.id, jobNumber: alphaJob.jobNumber, status: "UNSCHEDULED" },
        },
        {
          customerId: alphaDispatchedCustomer.id,
          quoteId: alphaDispatchedQuote.id,
          jobStatus: "DISPATCHED",
          job: { id: alphaDispatchedJob.id, jobNumber: alphaDispatchedJob.jobNumber, status: "DISPATCHED" },
        },
      ],
    });
    expect(alphaFollowUp.body).not.toContain("Workspace Beta Customer");
    expect(alphaFollowUp.body).not.toContain("Cross Tenant Workspace Secret");

    const alphaOverview = await app.inject({
      method: "GET",
      url: "/v1/workspace/overview",
      headers: { cookie: alpha.cookie },
    });
    expect(alphaOverview.statusCode).toBe(200);
    expect(alphaOverview.json()).toMatchObject({ metrics: { activeJobs: 2 } });
    expect(alphaOverview.body).not.toContain("Workspace Beta Customer");
    expect(alphaOverview.body).not.toContain("Cross Tenant Workspace Secret");

    const ownerOverview = await app.inject({
      method: "GET",
      url: "/v1/workspace/overview",
      headers: { cookie: owner.cookie },
    });
    expect(ownerOverview.statusCode).toBe(200);
    expect(ownerOverview.json()).toMatchObject({ metrics: { activeJobs: 3 } });
    expect(ownerOverview.body).not.toContain("Cross Tenant Workspace Secret");
  });

  test("requires linked customer and quote assignment before assigning a member to a job", async () => {
    const owner = await signUp("jobs-assignment");
    const member = await addMember(owner, "Job Scope Member");
    const customer = await createCustomer(owner, "Unassigned Job Customer");
    const quote = await createQuote(owner, customer.id, "Unassigned accepted work");

    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const blocked = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: job.version, assignedTenantUserId: member.membershipId },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "JOB_ASSIGNEE_RECORD_SCOPE_MISMATCH" });

    await prisma.customer.update({ where: { id: customer.id }, data: { assignedTenantUserId: member.membershipId } });
    await prisma.quote.update({ where: { id: quote.id }, data: { assignedTenantUserId: member.membershipId } });

    const assigned = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: job.version, assignedTenantUserId: member.membershipId },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { job: { assignedTenantUserId: string; version: number } }).job).toMatchObject({
      assignedTenantUserId: member.membershipId,
      version: job.version + 1,
    });
  });

  test("active jobs block quote mutation bypasses and linked record retention", async () => {
    const owner = await signUp("jobs-boundary");
    const customer = await createCustomer(owner, "Boundary Job Customer");
    const quote = await createQuote(owner, customer.id, "Boundary accepted work");
    const lineItem = await prisma.quoteLineItem.create({
      data: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        description: "Boundary line",
        sectionType: "INCLUDED",
        quantity: 1,
        unitCost: 50,
        unitPrice: 150,
      },
    });

    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);
    expect(job.status).toBe("UNSCHEDULED");

    const blockedDecision = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/decision`,
      headers: { cookie: owner.cookie },
      payload: { decision: "send" },
    });
    expect(blockedDecision.statusCode).toBe(409);
    expect(blockedDecision.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedRestore = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/history/rev_missing/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(blockedRestore.statusCode).toBe(409);
    expect(blockedRestore.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedLineCreate = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/line-items`,
      headers: { cookie: owner.cookie },
      payload: {
        description: "New line after job",
        sectionType: "INCLUDED",
        quantity: 1,
        unitCost: 25,
        unitPrice: 75,
      },
    });
    expect(blockedLineCreate.statusCode).toBe(409);
    expect(blockedLineCreate.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedLineUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}/line-items/${lineItem.id}`,
      headers: { cookie: owner.cookie },
      payload: { unitPrice: 999 },
    });
    expect(blockedLineUpdate.statusCode).toBe(409);
    expect(blockedLineUpdate.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedLineDelete = await app.inject({
      method: "DELETE",
      url: `/v1/quotes/${quote.id}/line-items/${lineItem.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(blockedLineDelete.statusCode).toBe(409);
    expect(blockedLineDelete.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedSheetSave = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}/sheet`,
      headers: { cookie: owner.cookie },
      payload: {
        quote: {
          serviceType: "CONSTRUCTION",
          status: "ACCEPTED",
          jobStatus: "NOT_STARTED",
          afterSaleFollowUpStatus: "NOT_READY",
          title: "Boundary sheet rewrite",
          scopeText: "Attempted rewrite after job creation.",
          taxAmount: 0,
        },
        lineItems: [{
          id: lineItem.id,
          description: "Boundary line rewrite",
          sectionType: "INCLUDED",
          quantity: 1,
          unitCost: 50,
          unitPrice: 999,
        }],
        newLineItems: [],
      },
    });
    expect(blockedSheetSave.statusCode).toBe(409);
    expect(blockedSheetSave.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedSendConfirmation = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/confirm-send`,
      headers: { cookie: owner.cookie },
      payload: {
        channel: "COPY",
        body: "Sent message body",
        idempotencyKey: `jobs-boundary-${Date.now()}`,
      },
    });
    expect(blockedSendConfirmation.statusCode).toBe(409);
    expect(blockedSendConfirmation.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    for (const request of [
      { method: "POST" as const, url: `/v1/quotes/${quote.id}/archive` },
      { method: "DELETE" as const, url: `/v1/quotes/${quote.id}` },
      { method: "POST" as const, url: `/v1/customers/${customer.id}/archive` },
      { method: "DELETE" as const, url: `/v1/customers/${customer.id}` },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { cookie: owner.cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "ACTIVE_JOBS", activeJobCount: 1 });
    }

    const unchangedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      select: {
        status: true,
        archivedAtUtc: true,
        deletedAtUtc: true,
        totalAmount: true,
      },
    });
    expect(unchangedQuote.status).toBe("ACCEPTED");
    expect(unchangedQuote.archivedAtUtc).toBeNull();
    expect(unchangedQuote.deletedAtUtc).toBeNull();
    expect(Number(unchangedQuote.totalAmount)).toBe(150);
    expect(await prisma.quoteLineItem.count({ where: { quoteId: quote.id, deletedAtUtc: null } })).toBe(1);
    expect(await prisma.job.count({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id, deletedAtUtc: null } })).toBe(1);
  });

  test("completed retained jobs still lock their accepted source quote", async () => {
    const owner = await signUp("jobs-completed-boundary");
    const customer = await createCustomer(owner, "Completed Boundary Job Customer");
    const quote = await createQuote(owner, customer.id, "Completed accepted work");
    const lineItem = await prisma.quoteLineItem.create({
      data: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        description: "Completed boundary line",
        sectionType: "INCLUDED",
        quantity: 1,
        unitCost: 50,
        unitPrice: 150,
      },
    });

    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAtUtc: new Date(),
      },
    });

    const completedReload = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(completedReload.statusCode).toBe(200);
    expect(completedReload.json()).toMatchObject({
      quote: { acceptedJob: { id: job.id, jobNumber: job.jobNumber, status: "COMPLETED" } },
    });

    await prisma.job.update({ where: { id: job.id }, data: { status: "CANCELED", canceledAtUtc: new Date() } });
    const canceledReload = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(canceledReload.statusCode).toBe(200);
    expect(canceledReload.json()).toMatchObject({
      quote: { acceptedJob: { id: job.id, jobNumber: job.jobNumber, status: "CANCELED" } },
    });

    const blockedPatch = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { title: "Attempted completed job rewrite" },
    });
    expect(blockedPatch.statusCode).toBe(409);
    expect(blockedPatch.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const blockedLineUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}/line-items/${lineItem.id}`,
      headers: { cookie: owner.cookie },
      payload: { unitPrice: 999 },
    });
    expect(blockedLineUpdate.statusCode).toBe(409);
    expect(blockedLineUpdate.json()).toMatchObject({ code: "QUOTE_JOB_LOCKED" });

    const unchangedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      select: { title: true, totalAmount: true },
    });
    const unchangedLineItem = await prisma.quoteLineItem.findUniqueOrThrow({
      where: { id: lineItem.id },
      select: { unitPrice: true },
    });
    expect(unchangedQuote.title).toBe("Completed accepted work");
    expect(Number(unchangedQuote.totalAmount)).toBe(150);
    expect(Number(unchangedLineItem.unitPrice)).toBe(150);
  });

  test("active jobs participate in member removal and role-downgrade safeguards", async () => {
    const owner = await signUp("jobs-membership-safety");
    const member = await addMember(owner, "Assigned Job Member");
    const admin = await addMember(owner, "Assigned Job Admin", "admin");

    const memberCustomer = await createCustomer(owner, "Member Job Customer", member.membershipId);
    const memberQuote = await createQuote(owner, memberCustomer.id, "Member accepted work", member.membershipId);
    await acceptQuote(owner, memberQuote.id);
    const memberJob = await jobForQuote(owner.tenant.id, memberQuote.id);
    const memberAppointment = await app.inject({
      method: "POST",
      url: `/v1/jobs/${memberJob.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-04-07T16:00:00.000Z",
        endsAtUtc: "2026-04-07T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(memberAppointment.statusCode).toBe(201);

    const removal = await app.inject({
      method: "DELETE",
      url: `/v1/org/users/${member.membershipId}`,
      headers: { cookie: owner.cookie },
    });
    expect(removal.statusCode).toBe(409);
    expect(removal.json()).toMatchObject({
      code: "MEMBER_HAS_ACTIVE_ASSIGNMENTS",
      assignments: { customers: 1, quotes: 1, jobs: 1, appointments: 1 },
    });

    const adminCustomer = await createCustomer(owner, "Admin Job Customer");
    const adminQuote = await createQuote(owner, adminCustomer.id, "Admin accepted work", admin.membershipId);
    await acceptQuote(owner, adminQuote.id);
    const adminJob = await jobForQuote(owner.tenant.id, adminQuote.id);
    const adminAppointment = await app.inject({
      method: "POST",
      url: `/v1/jobs/${adminJob.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: admin.membershipId,
        startsAtUtc: "2026-04-08T16:00:00.000Z",
        endsAtUtc: "2026-04-08T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(adminAppointment.statusCode).toBe(201);

    const demotion = await app.inject({
      method: "PATCH",
      url: `/v1/org/users/${admin.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "member" },
    });
    expect(demotion.statusCode).toBe(409);
    expect(demotion.json()).toMatchObject({
      code: "ROLE_CHANGE_ACTIVE_WORK_CONFLICT",
      activeWorkCount: 2,
    });
  });

  test("books appointments with overlap protection and syncs job schedule state", async () => {
    const owner = await signUp("jobs-booking");
    const member = await addMember(owner, "Booking Field Member");
    const otherMember = await addMember(owner, "Other Booking Field Member");
    const customer = await createCustomer(owner, "Booking Customer", member.membershipId);
    const quote = await createQuote(owner, customer.id, "Booking roof repair", member.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);
    expect(job.status).toBe("UNSCHEDULED");

    const firstStart = "2026-04-06T16:00:00.000Z";
    const firstEnd = "2026-04-06T18:00:00.000Z";
    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: firstStart,
        endsAtUtc: firstEnd,
        timeZone: "America/Los_Angeles",
        instructions: "Use the side gate.",
      },
    });
    expect(created.statusCode).toBe(201);
    const appointment = (created.json() as { appointment: { id: string; version: number; status: string } }).appointment;
    expect(appointment).toMatchObject({ status: "SCHEDULED" });

    const scheduledJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(scheduledJob.status).toBe("SCHEDULED");
    expect(scheduledJob.scheduledAtUtc?.toISOString()).toBe(firstStart);

    const mismatchedAssignee = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: otherMember.membershipId,
        startsAtUtc: "2026-04-06T19:00:00.000Z",
        endsAtUtc: "2026-04-06T20:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(mismatchedAssignee.statusCode).toBe(409);
    expect(mismatchedAssignee.json()).toMatchObject({ code: "JOB_APPOINTMENT_ASSIGNEE_MISMATCH" });

    const blockedJobReassignment = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: scheduledJob.version, assignedTenantUserId: null },
    });
    expect(blockedJobReassignment.statusCode).toBe(409);
    expect(blockedJobReassignment.json()).toMatchObject({
      code: "JOB_ACTIVE_APPOINTMENTS_REASSIGN_CONFLICT",
      activeAppointmentCount: 1,
    });

    const overlapping = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-04-06T17:30:00.000Z",
        endsAtUtc: "2026-04-06T19:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toMatchObject({ code: "JOB_APPOINTMENT_OVERLAP" });

    const adjacent = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: firstEnd,
        endsAtUtc: "2026-04-06T19:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(adjacent.statusCode).toBe(201);
    const second = (adjacent.json() as { appointment: { id: string; version: number } }).appointment;

    await prisma.jobAppointment.createMany({
      data: Array.from({ length: 30 }, (_, index) => {
        const startsAtUtc = new Date(Date.UTC(2026, 3, 10 + index, 16, 0, 0));
        const endsAtUtc = new Date(Date.UTC(2026, 3, 10 + index, 17, 0, 0));
        return {
          tenantId: owner.tenant.id,
          jobId: job.id,
          assignedTenantUserId: member.membershipId,
          createdByTenantUserId: member.membershipId,
          startsAtUtc,
          endsAtUtc,
          timeZone: "America/Los_Angeles",
          status: "CANCELED" as const,
          canceledAtUtc: new Date("2026-04-06T19:01:00.000Z"),
        };
      }),
    });
    const paginatedAppointments = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/appointments?limit=25&offset=0`,
      headers: { cookie: owner.cookie },
    });
    expect(paginatedAppointments.statusCode).toBe(200);
    const paginatedAppointmentsBody = paginatedAppointments.json() as {
      items: Array<{ id: string }>;
      pagination: { total: number; limit: number };
    };
    expect(paginatedAppointmentsBody.items).toHaveLength(25);
    expect(paginatedAppointmentsBody.pagination).toMatchObject({ total: 32, limit: 25 });

    const invalidJump = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: appointment.version, status: "COMPLETED" },
    });
    expect(invalidJump.statusCode).toBe(409);
    expect(invalidJump.json()).toMatchObject({ code: "JOB_APPOINTMENT_INVALID_TRANSITION" });

    const dispatched = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: appointment.version, status: "DISPATCHED" },
    });
    expect(dispatched.statusCode).toBe(200);
    const dispatchedAppointment = (dispatched.json() as { appointment: { version: number; dispatchedAtUtc: string | null } }).appointment;
    expect(dispatchedAppointment.dispatchedAtUtc).toEqual(expect.any(String));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DISPATCHED");

    const arrived = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: dispatchedAppointment.version, status: "ARRIVED" },
    });
    expect(arrived.statusCode).toBe(200);
    const arrivedAppointment = (arrived.json() as { appointment: { version: number; arrivedAtUtc: string | null } }).appointment;
    expect(arrivedAppointment.arrivedAtUtc).toEqual(expect.any(String));
    const inProgressJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(inProgressJob.status).toBe("IN_PROGRESS");
    expect(inProgressJob.dispatchedAtUtc).not.toBeNull();
    expect(inProgressJob.startedAtUtc).not.toBeNull();

    const completed = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: arrivedAppointment.version, status: "COMPLETED" },
    });
    expect(completed.statusCode).toBe(200);
    const completedAppointment = (completed.json() as {
      appointment: { version: number; completedAtUtc: string | null };
    }).appointment;
    expect(completedAppointment.completedAtUtc).toEqual(expect.any(String));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SCHEDULED");

    const terminalRegression = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: completedAppointment.version, status: "DISPATCHED" },
    });
    expect(terminalRegression.statusCode).toBe(409);
    expect(terminalRegression.json()).toMatchObject({ code: "JOB_APPOINTMENT_INVALID_TRANSITION" });

    const deleteSecond = await app.inject({
      method: "DELETE",
      url: `/v1/jobs/${job.id}/appointments/${second.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: second.version },
    });
    expect(deleteSecond.statusCode).toBe(200);
    expect(deleteSecond.json()).toMatchObject({
      appointmentId: second.id,
      notificationReceipt: { kind: "CANCELED", createdCount: expect.any(Number) },
    });
    const completedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completedJob.status).toBe("COMPLETED");
    expect(completedJob.scheduledAtUtc).toBeNull();
    expect(completedJob.completedAtUtc).not.toBeNull();
  });

  test("requires explicit-offset appointment timestamps and returns a compact schedule projection", async () => {
    const owner = await signUp("jobs-schedule-contract");
    const member = await addMember(owner, "Schedule Contract Member");
    const customer = await createCustomer(owner, "Schedule Contract Customer", member.membershipId);
    const quote = await createQuote(owner, customer.id, "Schedule contract quote", member.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const offsetlessCreate = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-06-01T09:00:00",
        endsAtUtc: "2026-06-01T10:00:00",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(offsetlessCreate.statusCode).toBe(400);
    expect(await prisma.jobAppointment.count({ where: { tenantId: owner.tenant.id, jobId: job.id } })).toBe(0);

    const impossibleDateCreate = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-02-30T09:00:00-08:00",
        endsAtUtc: "2026-02-30T10:00:00-08:00",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(impossibleDateCreate.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-06-01T09:00:00-07:00",
        endsAtUtc: "2026-06-01T10:00:00-07:00",
        timeZone: "America/Los_Angeles",
        instructions: "Private dispatch instructions must not appear on the schedule board.",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdAppointment = (created.json() as {
      appointment: { id: string; startsAtUtc: string; endsAtUtc: string };
    }).appointment;
    expect(createdAppointment).toMatchObject({
      startsAtUtc: "2026-06-01T16:00:00.000Z",
      endsAtUtc: "2026-06-01T17:00:00.000Z",
    });

    const offsetlessSchedule = await app.inject({
      method: "GET",
      url: "/v1/jobs/schedule?fromUtc=2026-06-01T00%3A00%3A00&toUtc=2026-06-02T00%3A00%3A00",
      headers: { cookie: owner.cookie },
    });
    expect(offsetlessSchedule.statusCode).toBe(400);

    const scheduleQuery = new URLSearchParams({
      fromUtc: "2026-06-01T00:00:00-07:00",
      toUtc: "2026-06-02T00:00:00-07:00",
      limit: "25",
      offset: "0",
    });
    const schedule = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${scheduleQuery.toString()}`,
      headers: { cookie: owner.cookie },
    });
    expect(schedule.statusCode).toBe(200);
    const scheduleItem = (schedule.json() as { items: Array<Record<string, unknown>> }).items[0];
    expect(scheduleItem).toBeDefined();
    expect(Object.keys(scheduleItem ?? {}).sort()).toEqual([
      "assignedTenantUser",
      "assignedTenantUserId",
      "endsAtUtc",
      "id",
      "job",
      "jobId",
      "startsAtUtc",
      "status",
      "timeZone",
      "version",
    ].sort());
    expect(scheduleItem).toMatchObject({
      id: createdAppointment.id,
      startsAtUtc: "2026-06-01T16:00:00.000Z",
      endsAtUtc: "2026-06-01T17:00:00.000Z",
    });
    expect(scheduleItem).not.toHaveProperty("instructions");
    expect(scheduleItem).not.toHaveProperty("createdByTenantUserId");
    expect(scheduleItem).not.toHaveProperty("createdByTenantUser");
    expect(scheduleItem).not.toHaveProperty("dispatchedAtUtc");
    expect(scheduleItem).not.toHaveProperty("arrivedAtUtc");
    expect(scheduleItem).not.toHaveProperty("completedAtUtc");
    expect(scheduleItem).not.toHaveProperty("canceledAtUtc");
    expect(scheduleItem).not.toHaveProperty("createdAt");
    expect(scheduleItem).not.toHaveProperty("updatedAt");
  });

  test("keeps rescheduling atomic, scheduled-only, overlap-safe, and separate from status changes", async () => {
    const owner = await signUp("jobs-reschedule-contract");
    const member = await addMember(owner, "Reschedule Contract Member");
    const customer = await createCustomer(owner, "Reschedule Contract Customer", member.membershipId);
    const quote = await createQuote(owner, customer.id, "Reschedule contract quote", member.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-06-03T16:00:00.000Z",
        endsAtUtc: "2026-06-03T17:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(created.statusCode).toBe(201);
    const appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;

    const blocker = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-06-03T20:00:00.000Z",
        endsAtUtc: "2026-06-03T21:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(blocker.statusCode).toBe(201);

    const mixedStatusUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        status: "DISPATCHED",
        startsAtUtc: "2026-06-03T17:00:00.000Z",
        endsAtUtc: "2026-06-03T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(mixedStatusUpdate.statusCode).toBe(400);

    const incompleteReschedule = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        startsAtUtc: "2026-06-03T17:00:00.000Z",
        endsAtUtc: "2026-06-03T18:00:00.000Z",
      },
    });
    expect(incompleteReschedule.statusCode).toBe(400);

    const offsetlessReschedule = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        startsAtUtc: "2026-06-03T10:00:00",
        endsAtUtc: "2026-06-03T11:00:00",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(offsetlessReschedule.statusCode).toBe(400);

    const overlappingReschedule = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        startsAtUtc: "2026-06-03T20:30:00.000Z",
        endsAtUtc: "2026-06-03T21:30:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(overlappingReschedule.statusCode).toBe(409);
    expect(overlappingReschedule.json()).toMatchObject({ code: "JOB_APPOINTMENT_OVERLAP" });

    const concurrentReschedules = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
        headers: { cookie: owner.cookie },
        payload: {
          version: appointment.version,
          startsAtUtc: "2026-06-03T10:00:00-07:00",
          endsAtUtc: "2026-06-03T11:00:00-07:00",
          timeZone: "America/Los_Angeles",
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
        headers: { cookie: owner.cookie },
        payload: {
          version: appointment.version,
          startsAtUtc: "2026-06-03T11:00:00-07:00",
          endsAtUtc: "2026-06-03T12:00:00-07:00",
          timeZone: "America/Los_Angeles",
        },
      }),
    ]);
    expect(concurrentReschedules.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const staleReschedule = concurrentReschedules.find((response) => response.statusCode === 409);
    expect(staleReschedule?.json()).toMatchObject({ code: "JOB_APPOINTMENT_STALE_VERSION" });

    const current = await prisma.jobAppointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(current.version).toBe(2);
    expect([
      "2026-06-03T17:00:00.000Z",
      "2026-06-03T18:00:00.000Z",
    ]).toContain(current.startsAtUtc.toISOString());

    const dispatched = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: current.version, status: "DISPATCHED" },
    });
    expect(dispatched.statusCode).toBe(200);
    const dispatchedAppointment = (dispatched.json() as { appointment: { version: number } }).appointment;

    const forbiddenReschedule = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: dispatchedAppointment.version,
        startsAtUtc: "2026-06-04T09:00:00-07:00",
        endsAtUtc: "2026-06-04T10:00:00-07:00",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(forbiddenReschedule.statusCode).toBe(409);
    expect(forbiddenReschedule.json()).toMatchObject({
      code: "JOB_APPOINTMENT_RESCHEDULE_NOT_ALLOWED",
      currentStatus: "DISPATCHED",
    });
    const identicalForbiddenReschedule = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: dispatchedAppointment.version,
        startsAtUtc: current.startsAtUtc.toISOString(),
        endsAtUtc: current.endsAtUtc.toISOString(),
        timeZone: current.timeZone,
      },
    });
    expect(identicalForbiddenReschedule.statusCode).toBe(409);
    expect(identicalForbiddenReschedule.json()).toMatchObject({
      code: "JOB_APPOINTMENT_RESCHEDULE_NOT_ALLOWED",
      currentStatus: "DISPATCHED",
    });
    const unchanged = await prisma.jobAppointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(unchanged.startsAtUtc.toISOString()).toBe(current.startsAtUtc.toISOString());
    expect(unchanged.endsAtUtc.toISOString()).toBe(current.endsAtUtc.toISOString());
    expect(unchanged.status).toBe("DISPATCHED");
  });

  test("assigned members can only advance their own booking status", async () => {
    const owner = await signUp("jobs-member-dispatch");
    const member = await addMember(owner, "Member Dispatch Tech");
    const otherMember = await addMember(owner, "Other Dispatch Tech");
    const customer = await createCustomer(owner, "Member Dispatch Customer", member.membershipId);
    const quote = await createQuote(owner, customer.id, "Member dispatch quote", member.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-05-01T16:00:00.000Z",
        endsAtUtc: "2026-05-01T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(created.statusCode).toBe(201);
    const appointment = (created.json() as { appointment: { id: string; version: number; status: string } }).appointment;

    const sameStatus = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: { version: appointment.version, status: "SCHEDULED" },
    });
    expect(sameStatus.statusCode).toBe(409);
    expect(sameStatus.json()).toMatchObject({ code: "JOB_APPOINTMENT_INVALID_TRANSITION" });

    const canceled = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: { version: appointment.version, status: "CANCELED" },
    });
    expect(canceled.statusCode).toBe(403);

    const combinedEdit = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: {
        version: appointment.version,
        status: "DISPATCHED",
        instructions: "Trying to edit instructions from the field.",
      },
    });
    expect(combinedEdit.statusCode).toBe(400);

    const otherMemberAttempt = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: otherMember.cookie },
      payload: { version: appointment.version, status: "DISPATCHED" },
    });
    expect(otherMemberAttempt.statusCode).toBe(404);

    const invalidJump = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: { version: appointment.version, status: "COMPLETED" },
    });
    expect(invalidJump.statusCode).toBe(409);
    expect(invalidJump.json()).toMatchObject({ code: "JOB_APPOINTMENT_INVALID_TRANSITION" });

    const dispatched = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: { version: appointment.version, status: "DISPATCHED" },
    });
    expect(dispatched.statusCode).toBe(200);
    const dispatchedAppointment = (dispatched.json() as {
      appointment: { version: number; status: string; dispatchedAtUtc: string | null };
    }).appointment;
    expect(dispatchedAppointment.status).toBe("DISPATCHED");
    expect(dispatchedAppointment.dispatchedAtUtc).toEqual(expect.any(String));

    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: member.cookie },
      payload: { version: appointment.version, status: "ARRIVED" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "JOB_APPOINTMENT_STALE_VERSION" });
  });

  test("serializes appointment creation against job reassignment and completion", async () => {
    const owner = await signUp("jobs-booking-race");
    const member = await addMember(owner, "Race Booking Member");
    const admin = await addMember(owner, "Race Booking Admin", "admin");

    const reassignedCustomer = await createCustomer(owner, "Race Reassign Customer", member.membershipId);
    const reassignedQuote = await createQuote(owner, reassignedCustomer.id, "Race reassigned quote", member.membershipId);
    await acceptQuote(owner, reassignedQuote.id);
    const reassignedJob = await jobForQuote(owner.tenant.id, reassignedQuote.id);
    const reassignmentRelease = deferred();
    const reassignmentLocked = deferred();
    const reassignmentBlocker = holdJobScheduleLock(
      owner.tenant.id,
      reassignedJob.id,
      reassignmentRelease.promise,
      reassignmentLocked.resolve,
    );
    await reassignmentLocked.promise;

    const reassignment = app.inject({
      method: "PATCH",
      url: `/v1/jobs/${reassignedJob.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: reassignedJob.version, assignedTenantUserId: admin.membershipId },
    });
    await waitForAdvisoryLockWaiters(1);
    const staleBooking = app.inject({
      method: "POST",
      url: `/v1/jobs/${reassignedJob.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-04-09T16:00:00.000Z",
        endsAtUtc: "2026-04-09T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    await waitForAdvisoryLockWaiters(2);
    reassignmentRelease.resolve();
    const [reassignmentResponse, staleBookingResponse] = await Promise.all([reassignment, staleBooking]);
    await reassignmentBlocker;

    expect(reassignmentResponse.statusCode).toBe(200);
    expect(staleBookingResponse.statusCode).toBe(409);
    expect(staleBookingResponse.json()).toMatchObject({ code: "JOB_APPOINTMENT_ASSIGNEE_MISMATCH" });
    expect(await prisma.jobAppointment.count({ where: { tenantId: owner.tenant.id, jobId: reassignedJob.id } })).toBe(0);

    const completedCustomer = await createCustomer(owner, "Race Complete Customer", member.membershipId);
    const completedQuote = await createQuote(owner, completedCustomer.id, "Race completed quote", member.membershipId);
    await acceptQuote(owner, completedQuote.id);
    const completedJob = await jobForQuote(owner.tenant.id, completedQuote.id);
    const booked = await app.inject({
      method: "POST",
      url: `/v1/jobs/${completedJob.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-04-10T16:00:00.000Z",
        endsAtUtc: "2026-04-10T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(booked.statusCode).toBe(201);
    const bookedAppointment = (booked.json() as { appointment: { id: string; version: number } }).appointment;
    const dispatched = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${completedJob.id}/appointments/${bookedAppointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: bookedAppointment.version, status: "DISPATCHED" },
    });
    expect(dispatched.statusCode).toBe(200);
    const dispatchedAppointment = (dispatched.json() as { appointment: { version: number } }).appointment;
    const arrived = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${completedJob.id}/appointments/${bookedAppointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: dispatchedAppointment.version, status: "ARRIVED" },
    });
    expect(arrived.statusCode).toBe(200);
    const arrivedAppointment = (arrived.json() as { appointment: { version: number } }).appointment;

    const completionRelease = deferred();
    const completionLocked = deferred();
    const completionBlocker = holdJobScheduleLock(
      owner.tenant.id,
      completedJob.id,
      completionRelease.promise,
      completionLocked.resolve,
    );
    await completionLocked.promise;
    const completion = app.inject({
      method: "PATCH",
      url: `/v1/jobs/${completedJob.id}/appointments/${bookedAppointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: arrivedAppointment.version, status: "COMPLETED" },
    });
    await waitForAdvisoryLockWaiters(1);
    const postCompletionBooking = app.inject({
      method: "POST",
      url: `/v1/jobs/${completedJob.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc: "2026-04-11T16:00:00.000Z",
        endsAtUtc: "2026-04-11T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    await waitForAdvisoryLockWaiters(2);
    completionRelease.resolve();
    const [completionResponse, postCompletionBookingResponse] = await Promise.all([completion, postCompletionBooking]);
    await completionBlocker;

    expect(completionResponse.statusCode).toBe(200);
    expect(postCompletionBookingResponse.statusCode).toBe(409);
    expect(postCompletionBookingResponse.json()).toMatchObject({ code: "JOB_NOT_BOOKABLE" });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: completedJob.id } })).status).toBe("COMPLETED");
    expect(await prisma.jobAppointment.count({
      where: {
        tenantId: owner.tenant.id,
        jobId: completedJob.id,
        deletedAtUtc: null,
        status: { in: ["SCHEDULED", "DISPATCHED", "ARRIVED"] },
      },
    })).toBe(0);
  });

  test("serializes concurrent overlapping appointment creation for one assignee", async () => {
    const owner = await signUp("jobs-overlap-race");
    const member = await addMember(owner, "Overlap Race Member");
    const customer = await createCustomer(owner, "Overlap Race Customer", member.membershipId);
    const quote = await createQuote(owner, customer.id, "Overlap race quote", member.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/jobs/${job.id}/appointments`,
        headers: { cookie: owner.cookie },
        payload: {
          assignedTenantUserId: member.membershipId,
          startsAtUtc: "2026-04-12T16:00:00.000Z",
          endsAtUtc: "2026-04-12T18:00:00.000Z",
          timeZone: "America/Los_Angeles",
        },
      }),
      app.inject({
        method: "POST",
        url: `/v1/jobs/${job.id}/appointments`,
        headers: { cookie: owner.cookie },
        payload: {
          assignedTenantUserId: member.membershipId,
          startsAtUtc: "2026-04-12T17:00:00.000Z",
          endsAtUtc: "2026-04-12T19:00:00.000Z",
          timeZone: "America/Los_Angeles",
        },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json()).toMatchObject({ code: "JOB_APPOINTMENT_OVERLAP" });
    expect(await prisma.jobAppointment.count({
      where: {
        tenantId: owner.tenant.id,
        jobId: job.id,
        deletedAtUtc: null,
        status: { in: ["SCHEDULED", "DISPATCHED", "ARRIVED"] },
      },
    })).toBe(1);
  });

  test("schedule endpoint respects tenant and member assignment scope", async () => {
    const owner = await signUp("jobs-schedule");
    const alpha = await addMember(owner, "Schedule Alpha Member");
    const beta = await addMember(owner, "Schedule Beta Member");
    const otherOwner = await signUp("jobs-schedule-other");
    const customer = await createCustomer(owner, "Schedule Customer", alpha.membershipId);
    const quote = await createQuote(owner, customer.id, "Scheduled accepted work", alpha.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: owner.cookie },
      payload: {
        assignedTenantUserId: alpha.membershipId,
        startsAtUtc: "2026-04-13T16:00:00.000Z",
        endsAtUtc: "2026-04-13T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
        instructions: "Schedule endpoint scoped appointment.",
      },
    });
    expect(created.statusCode).toBe(201);
    const appointment = (created.json() as { appointment: { id: string } }).appointment;
    const query = new URLSearchParams({
      fromUtc: "2026-04-13T00:00:00.000Z",
      toUtc: "2026-04-14T00:00:00.000Z",
      limit: "25",
      offset: "0",
    });

    const ownerSchedule = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${query.toString()}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerSchedule.statusCode).toBe(200);
    expect((ownerSchedule.json() as { items: Array<{ id: string; job: { id: string } }>; pagination: { total: number } })).toMatchObject({
      items: [{ id: appointment.id, job: { id: job.id } }],
      pagination: { total: 1 },
    });

    const alphaSchedule = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${query.toString()}&mine=true`,
      headers: { cookie: alpha.cookie },
    });
    expect(alphaSchedule.statusCode).toBe(200);
    expect((alphaSchedule.json() as { items: Array<{ id: string }>; pagination: { total: number } })).toMatchObject({
      items: [{ id: appointment.id }],
      pagination: { total: 1 },
    });

    const betaSchedule = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${query.toString()}&mine=true`,
      headers: { cookie: beta.cookie },
    });
    expect(betaSchedule.statusCode).toBe(200);
    expect((betaSchedule.json() as { items: unknown[]; pagination: { total: number } })).toMatchObject({
      items: [],
      pagination: { total: 0 },
    });

    const ownerFilteredToBeta = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${query.toString()}&assignedTenantUserId=${encodeURIComponent(beta.membershipId)}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerFilteredToBeta.statusCode).toBe(200);
    expect((ownerFilteredToBeta.json() as { items: unknown[]; pagination: { total: number } })).toMatchObject({
      items: [],
      pagination: { total: 0 },
    });

    const otherTenantSchedule = await app.inject({
      method: "GET",
      url: `/v1/jobs/schedule?${query.toString()}`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(otherTenantSchedule.statusCode).toBe(200);
    expect((otherTenantSchedule.json() as { items: unknown[]; pagination: { total: number } })).toMatchObject({
      items: [],
      pagination: { total: 0 },
    });
  });

  test("job notes are tenant scoped and member-visible only through assigned jobs", async () => {
    const owner = await signUp("jobs-notes");
    const alpha = await addMember(owner, "Alpha Field Member");
    const beta = await addMember(owner, "Beta Field Member");
    const customer = await createCustomer(owner, "Notes Customer", alpha.membershipId);
    const quote = await createQuote(owner, customer.id, "Notes accepted work", alpha.membershipId);
    await acceptQuote(owner, quote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);

    const created = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.id}/notes`,
      headers: { cookie: alpha.cookie },
      payload: { body: "Customer prefers morning access through the alley." },
    });
    expect(created.statusCode).toBe(201);
    const note = (created.json() as { note: { id: string; body: string; createdByTenantUserId: string } }).note;
    expect(note).toMatchObject({
      body: "Customer prefers morning access through the alley.",
      createdByTenantUserId: alpha.membershipId,
    });

    const ownerList = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/notes`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerList.statusCode).toBe(200);
    expect((ownerList.json() as { items: Array<{ id: string }>; pagination: { total: number; limit: number } })).toMatchObject({
      pagination: { total: 1, limit: 25 },
    });
    expect((ownerList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([note.id]);

    await prisma.jobNote.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        tenantId: owner.tenant.id,
        jobId: job.id,
        createdByTenantUserId: alpha.membershipId,
        body: `Synthetic paginated note ${index + 1}`,
      })),
    });
    const paginatedNotes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/notes?limit=25&offset=0`,
      headers: { cookie: owner.cookie },
    });
    expect(paginatedNotes.statusCode).toBe(200);
    const paginatedNotesBody = paginatedNotes.json() as { items: Array<{ id: string }>; pagination: { total: number; limit: number } };
    expect(paginatedNotesBody.items).toHaveLength(25);
    expect(paginatedNotesBody.pagination).toMatchObject({ total: 31, limit: 25 });

    const betaList = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/notes`,
      headers: { cookie: beta.cookie },
    });
    expect(betaList.statusCode).toBe(404);

    const deleteResponses = await Promise.all([
      app.inject({
        method: "DELETE",
        url: `/v1/jobs/${job.id}/notes/${note.id}`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "DELETE",
        url: `/v1/jobs/${job.id}/notes/${note.id}`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect(deleteResponses.some((response) => response.statusCode === 204)).toBe(true);
    for (const response of deleteResponses) {
      expect([204, 404, 409]).toContain(response.statusCode);
    }
    expect(await prisma.jobNote.count({ where: { id: note.id, deletedAtUtc: null } })).toBe(0);
    expect(await prisma.jobEvent.count({ where: { tenantId: owner.tenant.id, jobId: job.id, type: "NOTE_DELETED" } })).toBe(1);
  });

  test("completed-job after-sale repair is idempotent and preserves manual or ineligible state", async () => {
    const owner = await signUp("jobs-after-sale-repair");
    const customer = await createCustomer(owner, "Repair Migration Customer");
    const eligibleQuote = await createQuote(owner, customer.id, "Eligible repair quote");
    const manualQuote = await createQuote(owner, customer.id, "Manual repair quote");
    const openQuote = await createQuote(owner, customer.id, "Open job repair quote");
    const rejectedQuote = await createQuote(owner, customer.id, "Rejected repair quote");
    const completedAtUtc = new Date("2026-07-01T18:00:00.000Z");
    const manualDueAtUtc = new Date("2026-07-02T18:00:00.000Z");
    const manualCompletedAtUtc = new Date("2026-07-03T18:00:00.000Z");

    await prisma.quote.update({ where: { id: eligibleQuote.id }, data: { status: "ACCEPTED" } });
    await prisma.quote.update({
      where: { id: manualQuote.id },
      data: {
        status: "ACCEPTED",
        afterSaleFollowUpStatus: "COMPLETED",
        afterSaleFollowUpDueAtUtc: manualDueAtUtc,
        afterSaleFollowUpCompletedAtUtc: manualCompletedAtUtc,
      },
    });
    await prisma.quote.update({ where: { id: openQuote.id }, data: { status: "ACCEPTED" } });
    await prisma.quote.update({ where: { id: rejectedQuote.id }, data: { status: "REJECTED" } });

    for (const [index, input] of [
      { quote: eligibleQuote, status: "COMPLETED" as const, completedAtUtc },
      { quote: manualQuote, status: "COMPLETED" as const, completedAtUtc },
      { quote: openQuote, status: "IN_PROGRESS" as const, completedAtUtc: null },
      { quote: rejectedQuote, status: "COMPLETED" as const, completedAtUtc },
    ].entries()) {
      await prisma.job.create({
        data: {
          tenantId: owner.tenant.id,
          customerId: customer.id,
          sourceQuoteId: input.quote.id,
          jobNumber: index + 1,
          status: input.status,
          title: input.quote.title,
          scopeSnapshot: input.quote.scopeText,
          serviceType: input.quote.serviceType,
          acceptedAtUtc: completedAtUtc,
          completedAtUtc: input.completedAtUtc,
        },
      });
    }

    const repairSql = readFileSync(
      new URL("../../prisma/migrations/20260822230000_repair_completed_job_after_sale/migration.sql", import.meta.url),
      "utf8",
    );
    await prisma.$executeRawUnsafe(repairSql);
    const firstEligible = await prisma.quote.findUniqueOrThrow({ where: { id: eligibleQuote.id } });
    expect(firstEligible.afterSaleFollowUpStatus).toBe("DUE");
    expect(firstEligible.afterSaleFollowUpDueAtUtc?.getTime()).toBe(
      completedAtUtc.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(firstEligible.afterSaleFollowUpCompletedAtUtc).toBeNull();

    await prisma.$executeRawUnsafe(repairSql);
    const [secondEligible, preservedManual, preservedOpen, preservedRejected] = await Promise.all([
      prisma.quote.findUniqueOrThrow({ where: { id: eligibleQuote.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: manualQuote.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: openQuote.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: rejectedQuote.id } }),
    ]);
    expect(secondEligible.afterSaleFollowUpDueAtUtc).toEqual(firstEligible.afterSaleFollowUpDueAtUtc);
    expect(preservedManual.afterSaleFollowUpStatus).toBe("COMPLETED");
    expect(preservedManual.afterSaleFollowUpDueAtUtc).toEqual(manualDueAtUtc);
    expect(preservedManual.afterSaleFollowUpCompletedAtUtc).toEqual(manualCompletedAtUtc);
    expect(preservedOpen.afterSaleFollowUpStatus).toBe("NOT_READY");
    expect(preservedRejected.afterSaleFollowUpStatus).toBe("NOT_READY");
  });

  test("runtime role enforces direct job tenant RLS and immutable event privileges", async () => {
    const owner = await signUp("jobs-runtime-rls");
    const otherOwner = await signUp("jobs-runtime-other");
    const customer = await createCustomer(owner, "Runtime Job Customer");
    const otherCustomer = await createCustomer(otherOwner, "Other Runtime Job Customer");
    const quote = await createQuote(owner, customer.id, "Runtime accepted work");
    const otherQuote = await createQuote(otherOwner, otherCustomer.id, "Other runtime accepted work");
    await acceptQuote(owner, quote.id);
    await acceptQuote(otherOwner, otherQuote.id);
    const job = await jobForQuote(owner.tenant.id, quote.id);
    const otherJob = await jobForQuote(otherOwner.tenant.id, otherQuote.id);
    const event = job.events[0]!;
    const actorTenantUserId = event.actorTenantUserId;
    const otherActorTenantUserId = otherJob.events[0]!.actorTenantUserId;
    const appointment = await prisma.jobAppointment.create({
      data: {
        tenantId: owner.tenant.id,
        jobId: job.id,
        assignedTenantUserId: actorTenantUserId,
        createdByTenantUserId: actorTenantUserId,
        startsAtUtc: new Date("2026-05-01T16:00:00.000Z"),
        endsAtUtc: new Date("2026-05-01T18:00:00.000Z"),
        timeZone: "America/Los_Angeles",
      },
    });
    const otherAppointment = await prisma.jobAppointment.create({
      data: {
        tenantId: otherOwner.tenant.id,
        jobId: otherJob.id,
        assignedTenantUserId: otherActorTenantUserId,
        createdByTenantUserId: otherActorTenantUserId,
        startsAtUtc: new Date("2026-05-01T16:00:00.000Z"),
        endsAtUtc: new Date("2026-05-01T18:00:00.000Z"),
        timeZone: "America/Los_Angeles",
      },
    });
    const note = await prisma.jobNote.create({
      data: {
        tenantId: owner.tenant.id,
        jobId: job.id,
        createdByTenantUserId: actorTenantUserId,
        body: "Runtime tenant-scoped job note.",
      },
    });
    await prisma.jobNote.create({
      data: {
        tenantId: otherOwner.tenant.id,
        jobId: otherJob.id,
        createdByTenantUserId: otherActorTenantUserId,
        body: "Other runtime tenant-scoped job note.",
      },
    });

    const noContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Job"`);
      const appointments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "JobAppointment"`);
      const notes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "JobNote"`);
      return { jobs, appointments, notes };
    });
    expect(noContext).toEqual({ jobs: [], appointments: [], notes: [] });

    const tenantA = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Job" ORDER BY "id"`);
      const appointments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "JobAppointment" ORDER BY "id"`);
      const notes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "JobNote" ORDER BY "id"`);
      const events = await tx.$queryRaw<Array<{ jobId: string }>>(Prisma.sql`SELECT "jobId" FROM "JobEvent" ORDER BY "jobId"`);
      const crossTenantUpdateCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "Job" SET "accessInstructions" = 'blocked' WHERE "id" = ${otherJob.id}
      `);
      const crossTenantAppointmentUpdateCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "JobAppointment" SET "instructions" = 'blocked' WHERE "id" = ${otherAppointment.id}
      `);
      const crossTenantNoteUpdateCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "JobNote" SET "body" = 'blocked' WHERE "jobId" = ${otherJob.id}
      `);
      return { jobs, appointments, notes, events, crossTenantUpdateCount, crossTenantAppointmentUpdateCount, crossTenantNoteUpdateCount };
    });
    expect(tenantA.jobs.map((row) => row.id)).toEqual([job.id]);
    expect(tenantA.appointments.map((row) => row.id)).toEqual([appointment.id]);
    expect(tenantA.notes.map((row) => row.id)).toEqual([note.id]);
    expect(tenantA.events.map((row) => row.jobId)).toEqual([job.id]);
    expect(tenantA.crossTenantUpdateCount).toBe(0);
    expect(tenantA.crossTenantAppointmentUpdateCount).toBe(0);
    expect(tenantA.crossTenantNoteUpdateCount).toBe(0);

    const tenantB = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${otherOwner.tenant.id}, true)`);
      const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Job" ORDER BY "id"`);
      const appointments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "JobAppointment" ORDER BY "id"`);
      return { jobs, appointments };
    });
    expect(tenantB.jobs.map((row) => row.id)).toEqual([otherJob.id]);
    expect(tenantB.appointments.map((row) => row.id)).toEqual([otherAppointment.id]);

    const guessed = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(guessed.statusCode).toBe(404);

    const guessedAppointments = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/appointments`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(guessedAppointments.statusCode).toBe(404);

    const guessedAppointmentMutation = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: otherOwner.cookie },
      payload: { version: 1, status: "DISPATCHED" },
    });
    expect(guessedAppointmentMutation.statusCode).toBe(404);

    const guessedNotes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/notes`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(guessedNotes.statusCode).toBe(404);

    const guessedNoteMutation = await app.inject({
      method: "DELETE",
      url: `/v1/jobs/${job.id}/notes/${note.id}`,
      headers: { cookie: otherOwner.cookie },
    });
    expect(guessedNoteMutation.statusCode).toBe(404);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "JobEvent" SET "requestId" = 'tampered' WHERE "id" = ${event.id}
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "Job" WHERE "id" = ${job.id}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "JobAppointment" WHERE "id" = ${appointment.id}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "JobNote" WHERE "id" = ${note.id}`);
    })).rejects.toThrow();
  });
});
