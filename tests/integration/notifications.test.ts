import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { getDataClassificationCatalog } from "../../src/lib/data-governance-catalog";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import { setAiProviderGatewayTestHooks } from "../../src/services/ai-provider-gateway";
import {
  enqueueAppointmentNotifications,
  markAllNotificationsRead,
} from "../../src/services/notification-outbox";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

type MemberSession = Session & { membershipId: string };

let app: FastifyInstance;
let remoteAddressSequence = 80;

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

async function addMember(owner: Session, label: string): Promise<MemberSession> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${label}-${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName: label, role: "member" },
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

async function createAssignedJob(owner: Session, assigneeId: string, label: string) {
  const suffix = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
  const customer = await prisma.customer.create({
    data: {
      tenantId: owner.tenant.id,
      fullName: `${label} Customer`,
      email: `${label.toLowerCase()}@private.example`,
      phone: suffix,
      phoneDigits: suffix,
      notes: "PRIVATE CUSTOMER NOTES MUST NOT ENTER NOTIFICATIONS",
      assignedTenantUserId: assigneeId,
    },
  });
  const quote = await prisma.quote.create({
    data: {
      tenantId: owner.tenant.id,
      customerId: customer.id,
      assignedTenantUserId: assigneeId,
      serviceType: "CONSTRUCTION",
      status: "DRAFT",
      title: `${label} Roof Repair`,
      scopeText: "PRIVATE SCOPE MUST NOT ENTER NOTIFICATIONS",
      internalCostSubtotal: 50,
      customerPriceSubtotal: 150,
      taxAmount: 0,
      totalAmount: 150,
    },
  });
  const accepted = await app.inject({
    method: "PATCH",
    url: `/v1/quotes/${quote.id}`,
    headers: { cookie: owner.cookie },
    payload: { status: "ACCEPTED" },
  });
  expect(accepted.statusCode).toBe(200);
  const job = await prisma.job.findFirstOrThrow({ where: { tenantId: owner.tenant.id, sourceQuoteId: quote.id } });
  return { customer, quote, job };
}

async function book(owner: Session, jobId: string, assigneeId: string, day: number) {
  return app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/appointments`,
    headers: { cookie: owner.cookie },
    payload: {
      assignedTenantUserId: assigneeId,
      startsAtUtc: `2026-09-${String(day).padStart(2, "0")}T16:00:00.000Z`,
      endsAtUtc: `2026-09-${String(day).padStart(2, "0")}T18:00:00.000Z`,
      timeZone: "America/Los_Angeles",
      instructions: "PRIVATE GATE CODE 9090 MUST NOT ENTER NOTIFICATIONS",
    },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForAdvisoryLockWaiter() {
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
    if (Number(rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a notification advisory lock waiter.");
}

function hashFixture(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("durable in-app appointment notifications", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    setAiProviderGatewayTestHooks(null);
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(() => setAiProviderGatewayTestHooks(null));

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("creates every lifecycle kind atomically for deterministic recipients without provider or sensitive content", async () => {
    let providerCalls = 0;
    setAiProviderGatewayTestHooks({
      chatCompletion: async () => {
        providerCalls += 1;
        throw new Error("Notification mutations must not call OpenAI.");
      },
      embeddings: async () => {
        providerCalls += 1;
        throw new Error("Notification mutations must not call OpenAI.");
      },
    });
    const owner = await signUp("notify-lifecycle");
    const tech = await addMember(owner, "notify-tech");
    const { job } = await createAssignedJob(owner, tech.membershipId, "Lifecycle");

    const created = await book(owner, job.id, tech.membershipId, 10);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      notificationReceipt: { kind: "BOOKED", createdCount: 1 },
    });
    let appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;

    const rescheduled = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        startsAtUtc: "2026-09-11T16:00:00.000Z",
        endsAtUtc: "2026-09-11T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(rescheduled.statusCode).toBe(200);
    expect(rescheduled.json()).toMatchObject({ notificationReceipt: { kind: "RESCHEDULED", createdCount: 1 } });
    appointment = (rescheduled.json() as { appointment: { id: string; version: number } }).appointment;

    for (const status of ["DISPATCHED", "ARRIVED", "COMPLETED"] as const) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
        headers: { cookie: tech.cookie },
        payload: { version: appointment.version, status },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ notificationReceipt: { kind: status, createdCount: 1 } });
      appointment = (response.json() as { appointment: { id: string; version: number } }).appointment;
    }

    const second = await createAssignedJob(owner, tech.membershipId, "Cancel");
    const bookedForCancel = await book(owner, second.job.id, tech.membershipId, 15);
    const canceledAppointment = (bookedForCancel.json() as { appointment: { id: string; version: number } }).appointment;
    const canceled = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${second.job.id}/appointments/${canceledAppointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: canceledAppointment.version, status: "CANCELED" },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ notificationReceipt: { kind: "CANCELED", createdCount: 1 } });

    const third = await createAssignedJob(owner, tech.membershipId, "Delete");
    const bookedForDelete = await book(owner, third.job.id, tech.membershipId, 20);
    const deleteAppointment = (bookedForDelete.json() as { appointment: { id: string; version: number } }).appointment;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/jobs/${third.job.id}/appointments/${deleteAppointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: deleteAppointment.version },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      appointmentId: deleteAppointment.id,
      notificationReceipt: { kind: "CANCELED", createdCount: 1 },
    });

    const kinds = await prisma.notificationOutbox.findMany({
      where: { tenantId: owner.tenant.id },
      select: { kind: true },
    });
    expect(new Set(kinds.map((row) => row.kind))).toEqual(new Set([
      "BOOKED", "RESCHEDULED", "DISPATCHED", "ARRIVED", "COMPLETED", "CANCELED",
    ]));
    expect(providerCalls).toBe(0);

    const techList = await app.inject({
      method: "GET",
      url: "/v1/notifications?filter=all&limit=100",
      headers: { cookie: tech.cookie },
    });
    expect(techList.statusCode).toBe(200);
    expect(techList.headers["cache-control"]).toBe("private, no-store");
    const serialized = JSON.stringify(techList.json());
    expect(serialized).not.toContain("PRIVATE GATE CODE");
    expect(serialized).not.toContain("PRIVATE SCOPE");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("dedupeKeyHash");
    expect(serialized).not.toContain("payloadHash");
    expect(serialized).not.toContain(owner.tenant.id);
  });

  test("treats identical manager appointment edits as write-free no-ops", async () => {
    const owner = await signUp("notify-noop");
    const tech = await addMember(owner, "noop-tech");
    const outsider = await signUp("notify-noop-outsider");
    const { job } = await createAssignedJob(owner, tech.membershipId, "Noop");
    const created = await book(owner, job.id, tech.membershipId, 10);
    expect(created.statusCode).toBe(201);
    const appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;

    const beforeAppointment = await prisma.jobAppointment.findUniqueOrThrow({ where: { id: appointment.id } });
    const beforeJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const beforeCounts = {
      events: await prisma.jobEvent.count({ where: { tenantId: owner.tenant.id, jobId: job.id } }),
      notifications: await prisma.notificationOutbox.count({ where: { tenantId: owner.tenant.id, jobId: job.id } }),
    };

    const identicalDetails = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        assignedTenantUserId: tech.membershipId,
        // Different offsets represent the exact persisted instants.
        startsAtUtc: "2026-09-10T09:00:00.000-07:00",
        endsAtUtc: "2026-09-10T11:00:00.000-07:00",
        timeZone: "  America/Los_Angeles  ",
        instructions: "  PRIVATE GATE CODE 9090 MUST NOT ENTER NOTIFICATIONS  ",
      },
    });
    expect(identicalDetails.statusCode).toBe(200);
    expect(identicalDetails.json()).toMatchObject({
      appointment: {
        id: appointment.id,
        version: appointment.version,
        updatedAt: beforeAppointment.updatedAt.toISOString(),
      },
      notificationReceipt: null,
    });

    const identicalStatus = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: appointment.version, status: "SCHEDULED" },
    });
    expect(identicalStatus.statusCode).toBe(200);
    expect(identicalStatus.json()).toMatchObject({
      appointment: { id: appointment.id, version: appointment.version },
      notificationReceipt: null,
    });

    const assertWriteFree = async () => {
      expect(await prisma.jobAppointment.findUniqueOrThrow({ where: { id: appointment.id } })).toEqual(beforeAppointment);
      expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(beforeJob);
      expect(await prisma.jobEvent.count({ where: { tenantId: owner.tenant.id, jobId: job.id } })).toBe(beforeCounts.events);
      expect(await prisma.notificationOutbox.count({ where: { tenantId: owner.tenant.id, jobId: job.id } })).toBe(
        beforeCounts.notifications,
      );
    };

    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: { version: appointment.version + 1, status: "SCHEDULED" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "JOB_APPOINTMENT_STALE_VERSION" });
    await assertWriteFree();

    const memberManagerOnlyField = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: tech.cookie },
      payload: { version: appointment.version, assignedTenantUserId: tech.membershipId },
    });
    expect(memberManagerOnlyField.statusCode).toBe(403);
    expect(memberManagerOnlyField.json()).toMatchObject({ code: "JOB_FORBIDDEN" });
    await assertWriteFree();

    const crossTenant = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: outsider.cookie },
      payload: { version: appointment.version, status: "SCHEDULED" },
    });
    expect(crossTenant.statusCode).toBe(404);
    await assertWriteFree();

    await assertWriteFree();
  });

  test("enforces recipient visibility, keyset pagination, read idempotency, and read-all cutoff semantics", async () => {
    const owner = await signUp("notify-inbox");
    const tech = await addMember(owner, "inbox-tech");
    const outsider = await signUp("notify-outsider");
    const { customer, job } = await createAssignedJob(owner, tech.membershipId, "Inbox");
    const created = await book(owner, job.id, tech.membershipId, 10);
    const appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;
    const rescheduled = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        version: appointment.version,
        startsAtUtc: "2026-09-11T16:00:00.000Z",
        endsAtUtc: "2026-09-11T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    });
    expect(rescheduled.statusCode).toBe(200);

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/notifications?filter=all&limit=1",
      headers: { cookie: tech.cookie },
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as {
      items: Array<{ id: string; deliveryStatus: string; readAtUtc: string | null; version: number }>;
      page: { hasMore: boolean; nextCursor: string };
    };
    expect(firstBody.page.hasMore).toBe(true);
    expect(firstBody.items[0]).toMatchObject({ deliveryStatus: "AVAILABLE", readAtUtc: null, version: 1 });
    expect(await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: firstBody.items[0]!.id },
      select: { deliveryStatus: true, deliveredAtUtc: true, readAtUtc: true, version: true },
    })).toEqual({ deliveryStatus: "AVAILABLE", deliveredAtUtc: null, readAtUtc: null, version: 1 });
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/notifications?filter=all&limit=1&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
      headers: { cookie: tech.cookie },
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { items: Array<{ id: string }> };
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);

    for (const session of [owner, outsider]) {
      const denied = await app.inject({
        method: "POST",
        url: `/v1/notifications/${firstBody.items[0]!.id}/read`,
        headers: { cookie: session.cookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({ error: "Notification not found.", code: "NOTIFICATION_NOT_FOUND" });
    }

    const readOnce = await app.inject({
      method: "POST",
      url: `/v1/notifications/${firstBody.items[0]!.id}/read`,
      headers: { cookie: tech.cookie },
    });
    expect(readOnce.statusCode).toBe(200);
    const readNotification = (readOnce.json() as { notification: { version: number; readAtUtc: string } }).notification;
    const readAgain = await app.inject({
      method: "POST",
      url: `/v1/notifications/${firstBody.items[0]!.id}/read`,
      headers: { cookie: tech.cookie },
    });
    expect(readAgain.statusCode).toBe(200);
    expect(readAgain.json()).toMatchObject({ notification: readNotification });

    const readAll = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: { cookie: tech.cookie },
    });
    expect(readAll.statusCode).toBe(200);
    expect(readAll.json()).toMatchObject({ updatedCount: 1, cutoffAtUtc: expect.any(String) });
    const summary = await app.inject({ method: "GET", url: "/v1/notifications/summary", headers: { cookie: tech.cookie } });
    expect(summary.json()).toMatchObject({ unreadCount: 0, totalCount: 2 });

    await prisma.customer.update({ where: { id: customer.id }, data: { assignedTenantUserId: null } });
    const hiddenSummary = await app.inject({ method: "GET", url: "/v1/notifications/summary", headers: { cookie: tech.cookie } });
    expect(hiddenSummary.json()).toMatchObject({ unreadCount: 0, totalCount: 0 });
    const hiddenRead = await app.inject({
      method: "POST",
      url: `/v1/notifications/${firstBody.items[0]!.id}/read`,
      headers: { cookie: tech.cookie },
    });
    expect(hiddenRead.statusCode).toBe(404);
  });

  test("serializes read-all with notification producers in both commit orders", async () => {
    const owner = await signUp("notify-cutoff-race");
    const tech = await addMember(owner, "cutoff-race-tech");
    const { job } = await createAssignedJob(owner, tech.membershipId, "CutoffRace");
    const booked = await book(owner, job.id, tech.membershipId, 10);
    expect(booked.statusCode).toBe(201);
    const appointment = await prisma.jobAppointment.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, jobId: job.id },
    });
    const ownerMembership = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id, deletedAtUtc: null },
    });
    const access: AccessContext = Object.freeze({
      tenantId: owner.tenant.id,
      tenantUserId: tech.membershipId,
      userId: tech.user.id,
      role: "member",
      capabilities: capabilitiesForRole("member"),
      requestId: "notification-cutoff-race",
    });
    const createSourceEvent = (label: string) => prisma.jobEvent.create({
      data: {
        tenantId: owner.tenant.id,
        jobId: job.id,
        actorTenantUserId: ownerMembership.id,
        type: "APPOINTMENT_UPDATED",
        fromStatus: job.status,
        toStatus: job.status,
        requestId: `notification-cutoff-${label}`,
        commandKeyHash: hashFixture(`notification-cutoff-key:${label}`),
        commandPayloadHash: hashFixture(`notification-cutoff-payload:${label}`),
      },
    });

    const cleared = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: { cookie: tech.cookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ updatedCount: 1 });

    const producerFirstEvent = await createSourceEvent("producer-first");
    const producerInserted = deferred();
    const releaseProducer = deferred();
    const producerFirst = withTenantRlsContext(prisma, owner.tenant.id, async (transaction) => {
      const count = await enqueueAppointmentNotifications(transaction, {
        tenantId: owner.tenant.id,
        actorTenantUserId: ownerMembership.id,
        sourceJobEventId: producerFirstEvent.id,
        kind: "RESCHEDULED",
        appointment,
      });
      producerInserted.resolve();
      await releaseProducer.promise;
      return count;
    }, { maxWait: 5_000, timeout: 20_000 });
    await producerInserted.promise;
    const readAfterProducer = withTenantRlsContext(
      prisma,
      owner.tenant.id,
      (transaction) => markAllNotificationsRead(transaction, access),
      { maxWait: 5_000, timeout: 20_000 },
    );
    await waitForAdvisoryLockWaiter();
    releaseProducer.resolve();
    const [producerFirstCount, producerFirstRead] = await Promise.all([producerFirst, readAfterProducer]);
    expect(producerFirstCount).toBe(1);
    expect(producerFirstRead.updatedCount).toBe(1);
    const includedRow = await prisma.notificationOutbox.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        sourceJobEventId: producerFirstEvent.id,
        recipientTenantUserId: tech.membershipId,
      },
    });
    expect(includedRow.readAtUtc).toEqual(producerFirstRead.cutoffAtUtc);

    const readAllOwnsLock = deferred();
    const releaseReadAll = deferred();
    const producerTransactionStarted = deferred();
    const allowProducerEnqueue = deferred();
    const readerFirstEvent = await createSourceEvent("reader-first");
    const readerSecondProducer = withTenantRlsContext(prisma, owner.tenant.id, async (transaction) => {
      const startedRows = await transaction.$queryRaw<Array<{ startedAtUtc: Date }>>(Prisma.sql`
        SELECT transaction_timestamp() AS "startedAtUtc"
      `);
      producerTransactionStarted.resolve();
      await allowProducerEnqueue.promise;
      const count = await enqueueAppointmentNotifications(transaction, {
        tenantId: owner.tenant.id,
        actorTenantUserId: ownerMembership.id,
        sourceJobEventId: readerFirstEvent.id,
        kind: "DISPATCHED",
        appointment,
      });
      return { count, startedAtUtc: startedRows[0]!.startedAtUtc };
    }, { maxWait: 5_000, timeout: 20_000 });

    await producerTransactionStarted.promise;
    const readerFirst = withTenantRlsContext(prisma, owner.tenant.id, async (transaction) => {
      const result = await markAllNotificationsRead(transaction, access);
      readAllOwnsLock.resolve();
      await releaseReadAll.promise;
      return result;
    }, { maxWait: 5_000, timeout: 20_000 });
    await readAllOwnsLock.promise;
    allowProducerEnqueue.resolve();
    await waitForAdvisoryLockWaiter();
    releaseReadAll.resolve();
    const [readerFirstResult, readerSecondProducerResult] = await Promise.all([readerFirst, readerSecondProducer]);
    expect(readerFirstResult.updatedCount).toBe(0);
    expect(readerSecondProducerResult.count).toBe(1);
    expect(readerSecondProducerResult.startedAtUtc.getTime()).toBeLessThanOrEqual(readerFirstResult.cutoffAtUtc.getTime());
    const excludedRow = await prisma.notificationOutbox.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        sourceJobEventId: readerFirstEvent.id,
        recipientTenantUserId: tech.membershipId,
      },
    });
    expect(excludedRow).toMatchObject({ deliveryStatus: "AVAILABLE", deliveredAtUtc: null, readAtUtc: null });
  });

  test("excludes an active original creator who no longer has current job visibility", async () => {
    const owner = await signUp("notify-creator-scope");
    const tech = await addMember(owner, "creator-scope-tech");
    const { job } = await createAssignedJob(owner, tech.membershipId, "CreatorScope");
    const created = await book(owner, job.id, tech.membershipId, 10);
    const appointment = (created.json() as { appointment: { id: string; version: number } }).appointment;
    const ownerMembership = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id },
    });
    await prisma.tenantUser.update({ where: { id: ownerMembership.id }, data: { role: "member" } });

    const dispatched = await app.inject({
      method: "PATCH",
      url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
      headers: { cookie: tech.cookie },
      payload: { version: appointment.version, status: "DISPATCHED" },
    });
    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({
      notificationReceipt: { kind: "DISPATCHED", createdCount: 0 },
    });
    expect(await prisma.notificationOutbox.count({
      where: { tenantId: owner.tenant.id, kind: "DISPATCHED", recipientTenantUserId: ownerMembership.id },
    })).toBe(0);
  });

  test("rolls back appointment and event writes when notification persistence fails, and deduplicates replay", async () => {
    const owner = await signUp("notify-atomic");
    const tech = await addMember(owner, "atomic-tech");
    const { job } = await createAssignedJob(owner, tech.membershipId, "Atomic");

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION quotefly_test_reject_notification()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'intentional notification test failure';
      END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "NotificationOutbox_test_reject"
      BEFORE INSERT ON "NotificationOutbox"
      FOR EACH ROW EXECUTE FUNCTION quotefly_test_reject_notification()
    `);
    try {
      const failed = await book(owner, job.id, tech.membershipId, 10);
      expect(failed.statusCode).toBe(500);
      expect(await prisma.jobAppointment.count({ where: { tenantId: owner.tenant.id, jobId: job.id } })).toBe(0);
      expect(await prisma.jobEvent.count({ where: { tenantId: owner.tenant.id, jobId: job.id, type: "APPOINTMENT_CREATED" } })).toBe(0);
      expect(await prisma.notificationOutbox.count({ where: { tenantId: owner.tenant.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "NotificationOutbox_test_reject" ON "NotificationOutbox"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS quotefly_test_reject_notification()`);
    }

    const successful = await book(owner, job.id, tech.membershipId, 10);
    expect(successful.statusCode).toBe(201);
    const appointment = await prisma.jobAppointment.findFirstOrThrow({ where: { tenantId: owner.tenant.id, jobId: job.id } });
    const event = await prisma.jobEvent.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, jobId: job.id, type: "APPOINTMENT_CREATED" },
    });
    const ownerMembership = await prisma.tenantUser.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, userId: owner.user.id },
    });
    const replayCount = await withTenantRlsContext(prisma, owner.tenant.id, (transaction) =>
      enqueueAppointmentNotifications(transaction, {
        tenantId: owner.tenant.id,
        actorTenantUserId: ownerMembership.id,
        sourceJobEventId: event.id,
        kind: "BOOKED",
        appointment,
      }),
    );
    expect(replayCount).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { tenantId: owner.tenant.id } })).toBe(1);

    const raced = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
        headers: { cookie: tech.cookie },
        payload: { version: appointment.version, status: "DISPATCHED" },
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}/appointments/${appointment.id}`,
        headers: { cookie: tech.cookie },
        payload: { version: appointment.version, status: "DISPATCHED" },
      }),
    ]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.notificationOutbox.count({
      where: { tenantId: owner.tenant.id, appointmentId: appointment.id, kind: "DISPATCHED" },
    })).toBe(1);
  });

  test("database identity, runtime grants, forced RLS, composite tenant/job links, and RAG exclusion fail closed", async () => {
    const owner = await signUp("notify-boundary");
    const tech = await addMember(owner, "boundary-tech");
    const first = await createAssignedJob(owner, tech.membershipId, "BoundaryA");
    const second = await createAssignedJob(owner, tech.membershipId, "BoundaryB");
    await book(owner, first.job.id, tech.membershipId, 10);
    await book(owner, second.job.id, tech.membershipId, 15);
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { tenantId: owner.tenant.id } });
    const otherAppointment = await prisma.jobAppointment.findFirstOrThrow({ where: { jobId: { not: row.jobId } } });

    await expect(withTenantRlsContext(prisma, owner.tenant.id, (transaction) =>
      transaction.notificationOutbox.update({
        where: { id: row.id },
        data: { appointmentId: otherAppointment.id },
      }),
    )).rejects.toBeTruthy();
    await expect(withTenantRlsContext(prisma, owner.tenant.id, (transaction) => transaction.$executeRaw(Prisma.sql`
      UPDATE "NotificationOutbox" SET "templateKey" = 'tampered' WHERE "id" = ${row.id}
    `))).rejects.toBeTruthy();
    const markedRead = await app.inject({
      method: "POST",
      url: `/v1/notifications/${row.id}/read`,
      headers: { cookie: tech.cookie },
    });
    expect(markedRead.statusCode).toBe(200);
    await expect(withTenantRlsContext(prisma, owner.tenant.id, (transaction) => transaction.$executeRaw(Prisma.sql`
      UPDATE "NotificationOutbox"
      SET "deliveryStatus" = 'AVAILABLE',
          "deliveredAtUtc" = NULL,
          "readAtUtc" = NULL,
          "version" = "version" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${row.id}
    `))).rejects.toBeTruthy();

    const rls = await prisma.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>(Prisma.sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'NotificationOutbox'
    `);
    expect(rls).toEqual([{ enabled: true, forced: true }]);
    const privileges = await prisma.$queryRaw<Array<{
      canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean; canTruncate: boolean;
    }>>(Prisma.sql`
      SELECT
        has_table_privilege('quotefly_runtime', '"NotificationOutbox"', 'SELECT') AS "canSelect",
        has_table_privilege('quotefly_runtime', '"NotificationOutbox"', 'INSERT') AS "canInsert",
        has_table_privilege('quotefly_runtime', '"NotificationOutbox"', 'UPDATE') AS "canUpdate",
        has_table_privilege('quotefly_runtime', '"NotificationOutbox"', 'DELETE') AS "canDelete",
        has_table_privilege('quotefly_runtime', '"NotificationOutbox"', 'TRUNCATE') AS "canTruncate"
    `);
    expect(privileges).toEqual([{ canSelect: true, canInsert: true, canUpdate: true, canDelete: false, canTruncate: false }]);

    const catalog = getDataClassificationCatalog();
    const model = catalog.models.find((entry) => entry.model === "NotificationOutbox");
    expect(model?.reviewStatus).toBe("REVIEWED");
    expect(model?.fields.every((field) => field.ragStatus === "EXCLUDED")).toBe(true);
    expect(model?.fields.find((field) => field.field === "startsAtUtc")?.classification).toBe("C2_CUSTOMER_CONFIDENTIAL");
    expect(model?.fields.find((field) => field.field === "dedupeKeyHash")?.classification).toBe("C4_RESTRICTED");
  });
});
