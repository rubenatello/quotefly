import type { FastifyInstance } from "fastify";
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
    expect(deleteSecond.statusCode).toBe(204);
    const completedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completedJob.status).toBe("COMPLETED");
    expect(completedJob.scheduledAtUtc).toBeNull();
    expect(completedJob.completedAtUtc).not.toBeNull();
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
    expect(combinedEdit.statusCode).toBe(403);

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
