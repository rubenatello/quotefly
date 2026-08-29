import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { seedCustomerFollowUpSchedule } from "../../src/services/customer-follow-up";
import { applyQuoteCustomerLifecycle } from "../../src/services/customer-lifecycle";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

let testRemoteAddressSequence = 1;

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

async function addMember(owner: Session, label: string, role: "member" | "admin" = "member") {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const emailLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const email = `${emailLabel}-${unique}@example.com`;
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
    remoteAddress: `198.51.100.${testRemoteAddressSequence++}`,
    payload: { email, password },
  });
  expect(signedIn.statusCode).toBe(200);
  return {
    ...(signedIn.json() as Omit<Session, "cookie">),
    cookie: cookieFrom(signedIn),
    membershipId,
  };
}

async function ownerMembership(session: Session) {
  return prisma.tenantUser.findFirstOrThrow({
    where: { tenantId: session.tenant.id, userId: session.user.id, deletedAtUtc: null },
    select: { id: true },
  });
}

async function createCustomer(session: Session, name: string, assignedTenantUserId?: string) {
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

function taskPayload(customerId: string, title = "Call customer about the estimate") {
  return {
    customerId,
    type: "FOLLOW_UP",
    priority: "NORMAL",
    title,
    notes: "Confirm the requested work and next step.",
    dueAtUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForMembershipLockWaiters(expectedMinimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FOR UPDATE OF membership%'
    `);
    if (Number(rows[0]?.count ?? 0) >= expectedMinimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedMinimum} membership lock waiter(s).`);
}

async function waitForRecordLockWaiters(recordAlias: "customer" | "quote", expectedMinimum: number) {
  const deadline = Date.now() + 5_000;
  const lockClause = `%FOR UPDATE OF ${recordAlias}%`;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE ${lockClause}
    `);
    if (Number(rows[0]?.count ?? 0) >= expectedMinimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedMinimum} ${recordAlias} lock waiter(s).`);
}

async function raceAssignmentAgainstMemberRemoval(input: {
  owner: Session;
  membershipId: string;
  assign: () => ReturnType<FastifyInstance["inject"]>;
  expectedAssignmentStatus: number;
  expectedAssignmentKind: "customers" | "quotes";
}) {
  const lockReady = deferred();
  const releaseLock = deferred();
  const blocker = prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT membership."id"
      FROM "TenantUser" membership
      WHERE membership."id" = ${input.membershipId}
        AND membership."tenantId" = ${input.owner.tenant.id}
      FOR UPDATE OF membership
    `);
    lockReady.resolve();
    await releaseLock.promise;
  }, { maxWait: 5_000, timeout: 15_000 });

  await lockReady.promise;
  const assignmentPromise = input.assign();
  await waitForMembershipLockWaiters(1);
  const removalPromise = app.inject({
    method: "DELETE",
    url: `/v1/org/users/${input.membershipId}`,
    headers: { cookie: input.owner.cookie },
    payload: {},
  });
  await waitForMembershipLockWaiters(2);
  releaseLock.resolve();

  const [assignment, removal] = await Promise.all([assignmentPromise, removalPromise]);
  await blocker;
  expect(assignment.statusCode).toBe(input.expectedAssignmentStatus);
  expect(removal.statusCode).toBe(409);
  expect(removal.json()).toMatchObject({
    code: "MEMBER_HAS_ACTIVE_ASSIGNMENTS",
    assignments: { [input.expectedAssignmentKind]: 1 },
  });
  const membership = await prisma.tenantUser.findUniqueOrThrow({
    where: { id: input.membershipId },
    select: { deletedAtUtc: true },
  });
  expect(membership.deletedAtUtc).toBeNull();
  return assignment;
}

let app: FastifyInstance;

describe("activity task workflows", () => {
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

  test("versions settings and atomically schedules new customers with explicit follow-up outcomes", async () => {
    const owner = await signUp("automatic-follow-up");
    const member = await addMember(owner, "Automatic Follow-up Member");

    const initialSettings = await app.inject({
      method: "GET",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
    });
    expect(initialSettings.statusCode).toBe(200);
    expect(initialSettings.json()).toMatchObject({
      followUpSettings: {
        enabled: true,
        version: 0,
        steps: [
          { stepNumber: 1, delayMinutes: 15, priority: "HIGH" },
          { stepNumber: 2, delayMinutes: 1440, priority: "NORMAL" },
          { stepNumber: 3, delayMinutes: 4320, priority: "NORMAL" },
          { stepNumber: 4, delayMinutes: 10080, priority: "HIGH" },
        ],
      },
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
      payload: { version: 0, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ followUpSettings: { enabled: false, version: 1 } });

    const stale = await app.inject({
      method: "PATCH",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
      payload: { version: 0, enabled: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "FOLLOW_UP_SETTINGS_STALE_VERSION", currentVersion: 1 });

    const disabledCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Disabled Schedule Customer", phone: "555-101-1001" },
    });
    expect(disabledCustomer.statusCode).toBe(201);
    const disabledCustomerId = (disabledCustomer.json() as { customer: { id: string } }).customer.id;
    expect(await prisma.customerFollowUpSequence.count({ where: { customerId: disabledCustomerId } })).toBe(0);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
      payload: { version: 1, enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ followUpSettings: { enabled: true, version: 2 } });

    const created = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Scheduled Customer", phone: "555-101-1002", assignedTenantUserId: member.membershipId },
    });
    expect(created.statusCode).toBe(201);
    const customerId = (created.json() as { customer: { id: string } }).customer.id;
    const sequence = await prisma.customerFollowUpSequence.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, customerId },
      include: { tasks: { orderBy: { followUpStepNumber: "asc" } } },
    });
    expect(sequence.templateVersion).toBe(2);
    expect(sequence.tasks).toHaveLength(4);
    expect(sequence.tasks.every((task) => task.origin === "AUTOMATED_CUSTOMER_FOLLOW_UP")).toBe(true);
    expect(sequence.tasks.map((task) => task.assignedTenantUserId)).toEqual(Array(4).fill(member.membershipId));

    const firstBeforeMemberEdit = sequence.tasks[0]!;
    const blockedMemberEdit = await app.inject({
      method: "PATCH",
      url: `/v1/activities/${firstBeforeMemberEdit.id}`,
      headers: { cookie: member.cookie, "idempotency-key": "automatic-follow-up-member-edit-0001" },
      payload: {
        version: firstBeforeMemberEdit.version,
        title: "Hide this required follow-up",
        notes: "Move it out of the queue",
        priority: "LOW",
        dueAtUtc: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
    expect(blockedMemberEdit.statusCode).toBe(409);
    expect(blockedMemberEdit.json()).toMatchObject({ code: "FOLLOW_UP_TASK_IMMUTABLE" });
    expect(await prisma.activityTask.findUniqueOrThrow({ where: { id: firstBeforeMemberEdit.id } })).toMatchObject({
      version: firstBeforeMemberEdit.version,
      title: firstBeforeMemberEdit.title,
      notes: firstBeforeMemberEdit.notes,
      priority: firstBeforeMemberEdit.priority,
      dueAtUtc: firstBeforeMemberEdit.dueAtUtc,
    });

    const systemEvents = await prisma.activityTaskEvent.findMany({
      where: { activityTaskId: { in: sequence.tasks.map((task) => task.id) } },
    });
    expect(systemEvents).toHaveLength(4);
    expect(systemEvents.every((event) => event.actorKind === "SYSTEM" && event.actorTenantUserId === null)).toBe(true);

    const reused = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: {
        fullName: "Scheduled Customer",
        phone: "555-101-1002",
        duplicateAction: "use_existing",
        duplicateCustomerId: customerId,
      },
    });
    expect(reused.statusCode).toBe(200);
    expect(await prisma.customerFollowUpSequence.count({ where: { customerId } })).toBe(1);

    const skippedCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Skipped Follow-up Customer", phone: "555-101-1003" },
    });
    expect(skippedCustomer.statusCode).toBe(201);
    const skippedCustomerId = (skippedCustomer.json() as { customer: { id: string } }).customer.id;
    const skippedSequence = await prisma.customerFollowUpSequence.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, customerId: skippedCustomerId },
      include: { tasks: { orderBy: { followUpStepNumber: "asc" } } },
    });
    const skipped = await app.inject({
      method: "POST",
      url: `/v1/activities/${skippedSequence.tasks[0]!.id}/complete`,
      headers: { cookie: owner.cookie, "idempotency-key": "automatic-follow-up-skipped-0001" },
      payload: { version: skippedSequence.tasks[0]!.version, outcome: "SKIPPED" },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({ task: { status: "COMPLETED", followUpOutcome: "SKIPPED" } });
    const skippedCustomerRecord = await prisma.customer.findUniqueOrThrow({ where: { id: skippedCustomerId } });
    expect(skippedCustomerRecord.lastFollowUpAttemptAtUtc).toBeNull();
    expect(skippedCustomerRecord.lastSuccessfulContactAtUtc).toBeNull();
    const skippedSequenceAfter = await prisma.customerFollowUpSequence.findUniqueOrThrow({
      where: { id: skippedSequence.id },
      include: { tasks: true },
    });
    expect(skippedSequenceAfter.status).toBe("ACTIVE");
    expect(skippedSequenceAfter.tasks.filter((task) => task.status === "OPEN")).toHaveLength(3);

    const first = sequence.tasks[0]!;
    const missingOutcome = await app.inject({
      method: "POST",
      url: `/v1/activities/${first.id}/complete`,
      headers: { cookie: owner.cookie, "idempotency-key": "automatic-follow-up-missing-outcome-01" },
      payload: { version: first.version },
    });
    expect(missingOutcome.statusCode).toBe(422);
    expect(missingOutcome.json()).toMatchObject({ code: "FOLLOW_UP_OUTCOME_REQUIRED" });

    const noResponse = await app.inject({
      method: "POST",
      url: `/v1/activities/${first.id}/complete`,
      headers: { cookie: owner.cookie, "idempotency-key": "automatic-follow-up-no-response-0001" },
      payload: { version: first.version, outcome: "NO_RESPONSE" },
    });
    expect(noResponse.statusCode).toBe(200);
    expect(noResponse.json()).toMatchObject({ task: { status: "COMPLETED", followUpOutcome: "NO_RESPONSE" } });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).lastFollowUpAttemptAtUtc).not.toBeNull();

    const second = sequence.tasks[1]!;
    const contacted = await app.inject({
      method: "POST",
      url: `/v1/activities/${second.id}/complete`,
      headers: { cookie: owner.cookie, "idempotency-key": "automatic-follow-up-contacted-0001" },
      payload: { version: second.version, outcome: "CONTACTED" },
    });
    expect(contacted.statusCode).toBe(200);
    const finalSequence = await prisma.customerFollowUpSequence.findUniqueOrThrow({
      where: { id: sequence.id },
      include: { tasks: { orderBy: { followUpStepNumber: "asc" } } },
    });
    expect(finalSequence.status).toBe("COMPLETED");
    expect(finalSequence.tasks.map((task) => task.status)).toEqual(["COMPLETED", "COMPLETED", "CANCELED", "CANCELED"]);
    const finalCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(finalCustomer.followUpStatus).toBe("FOLLOWED_UP");
    expect(finalCustomer.lastSuccessfulContactAtUtc).not.toBeNull();
  });

  test("serializes automatic follow-up completion against marking the customer lost", async () => {
    const owner = await signUp("follow-up-completion-loss-race");
    const created = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Follow-up Loss Race Customer", phone: "555-201-3099" },
    });
    expect(created.statusCode).toBe(201);
    const customer = (created.json() as {
      customer: { id: string; lifecycleVersion: number };
    }).customer;
    const task = await prisma.activityTask.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        customerId: customer.id,
        origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
        status: "OPEN",
      },
      orderBy: { followUpStepNumber: "asc" },
    });

    const [completion, loss] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/activities/${task.id}/complete`,
        headers: {
          cookie: owner.cookie,
          "idempotency-key": "follow-up-completion-loss-race-0001",
        },
        payload: { version: task.version, outcome: "CONTACTED" },
      }),
      app.inject({
        method: "POST",
        url: `/v1/customers/${customer.id}/mark-lost`,
        headers: { cookie: owner.cookie },
        payload: {
          reason: "NO_RESPONSE",
          expectedVersion: customer.lifecycleVersion,
        },
      }),
    ]);

    expect([completion.statusCode, loss.statusCode].sort()).toEqual([200, 409]);
    const storedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    const storedTask = await prisma.activityTask.findUniqueOrThrow({ where: { id: task.id } });
    if (loss.statusCode === 200) {
      expect(completion.json()).toMatchObject({
        code: expect.stringMatching(/^(FOLLOW_UP_CUSTOMER_TERMINAL|ACTIVITY_REOPEN_REQUIRED)$/),
      });
      expect(storedCustomer.followUpStatus).toBe("LOST");
      expect(storedTask.status).toBe("CANCELED");
    } else {
      expect(loss.json()).toMatchObject({ code: "CUSTOMER_LIFECYCLE_STALE_VERSION" });
      expect(storedCustomer.followUpStatus).toBe("FOLLOWED_UP");
      expect(storedTask.status).toBe("COMPLETED");
    }
  });

  test("records a structured customer loss atomically and reopens with an optional fresh sequence", async () => {
    const owner = await signUp("customer-loss-lifecycle");
    const otherOwner = await signUp("customer-loss-other-tenant");
    const ownerActor = await ownerMembership(owner);
    const created = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Structured Loss Customer", phone: "555-201-3001" },
    });
    expect(created.statusCode).toBe(201);
    const createdCustomer = (created.json() as { customer: { id: string; lifecycleVersion: number } }).customer;
    const originalSequence = await prisma.customerFollowUpSequence.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, customerId: createdCustomer.id, status: "ACTIVE" },
      include: { tasks: true },
    });
    expect(originalSequence.tasks).toHaveLength(4);

    const manualTask = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "customer-loss-manual-task-0001" },
      payload: taskPayload(createdCustomer.id, "Review retained paperwork"),
    });
    expect(manualTask.statusCode).toBe(201);
    const manualTaskId = (manualTask.json() as { task: { id: string } }).task.id;

    const otherWithoutNotes = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: { reason: "OTHER", expectedVersion: createdCustomer.lifecycleVersion },
    });
    expect(otherWithoutNotes.statusCode).toBe(400);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: { reason: "PRICE", expectedVersion: createdCustomer.lifecycleVersion + 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CUSTOMER_LIFECYCLE_STALE_VERSION" });

    const crossTenant = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/mark-lost`,
      headers: { cookie: otherOwner.cookie },
      payload: { reason: "PRICE", expectedVersion: createdCustomer.lifecycleVersion },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: "CUSTOMER_NOT_FOUND" });

    const sensitiveNotes = "Customer selected a lower-priced local competitor.";
    const lost = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: {
        reason: "PRICE",
        notes: sensitiveNotes,
        expectedVersion: createdCustomer.lifecycleVersion,
      },
    });
    expect(lost.statusCode).toBe(200);
    const lostBody = lost.json() as {
      customer: { lifecycleVersion: number; followUpStatus: string; lostReason: string; lostReasonNotes: string; lostAtUtc: string; lostByTenantUserId: string };
      canceledAutomaticTaskCount: number;
      openManualTaskCount: number;
    };
    expect(lostBody).toMatchObject({
      customer: {
        lifecycleVersion: createdCustomer.lifecycleVersion + 1,
        followUpStatus: "LOST",
        lostReason: "PRICE",
        lostReasonNotes: sensitiveNotes,
        lostByTenantUserId: ownerActor.id,
      },
      canceledAutomaticTaskCount: 4,
      openManualTaskCount: 1,
    });
    expect(lostBody.customer.lostAtUtc).toEqual(expect.any(String));

    const [lostCustomerList, lostCustomerDetail, lostCustomerActivity] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/customers?stage=LOST",
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "GET",
        url: `/v1/customers/${createdCustomer.id}`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "GET",
        url: `/v1/customers/${createdCustomer.id}/activity`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect(lostCustomerList.statusCode).toBe(200);
    expect(lostCustomerList.headers["cache-control"]).toBe("private, no-store");
    const listedLostCustomer = (lostCustomerList.json() as {
      customers: Array<Record<string, unknown>>;
    }).customers.find((customer) => customer.id === createdCustomer.id);
    expect(listedLostCustomer).toBeDefined();
    expect(listedLostCustomer).not.toHaveProperty("lostReasonNotes");
    expect(lostCustomerDetail.statusCode).toBe(200);
    expect(lostCustomerDetail.headers["cache-control"]).toBe("private, no-store");
    expect(lostCustomerDetail.json()).toMatchObject({
      customer: { id: createdCustomer.id, lostReasonNotes: sensitiveNotes },
    });
    expect(lostCustomerActivity.statusCode).toBe(200);
    expect(lostCustomerActivity.headers["cache-control"]).toBe("private, no-store");

    const [sequenceAfterLoss, manualAfterLoss, lossActivity] = await Promise.all([
      prisma.customerFollowUpSequence.findUniqueOrThrow({
        where: { id: originalSequence.id },
        include: { tasks: true },
      }),
      prisma.activityTask.findUniqueOrThrow({ where: { id: manualTaskId } }),
      prisma.customerActivityEvent.findFirstOrThrow({
        where: { tenantId: owner.tenant.id, customerId: createdCustomer.id, eventType: "CUSTOMER_LOST" },
      }),
    ]);
    expect(sequenceAfterLoss.status).toBe("CANCELED");
    expect(sequenceAfterLoss.tasks.every((task) => task.status === "CANCELED")).toBe(true);
    expect(manualAfterLoss).toMatchObject({ origin: "MANUAL", status: "OPEN" });
    expect(lossActivity).toMatchObject({
      detail: "Reason: Price.",
      metadata: expect.objectContaining({ reason: "PRICE", hasNotes: true, openManualTaskCount: 1 }),
    });
    expect(JSON.stringify(lossActivity)).not.toContain(sensitiveNotes);

    const quoteWhileLost = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { cookie: owner.cookie, "idempotency-key": "customer-loss-quote-block-0001" },
      payload: {
        customerId: createdCustomer.id,
        serviceType: "CONSTRUCTION",
        title: "Quote that must not be created",
        scopeText: "Lifecycle guard must reject this draft atomically.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
      },
    });
    expect(quoteWhileLost.statusCode).toBe(409);
    expect(quoteWhileLost.json()).toMatchObject({ code: "CUSTOMER_REOPEN_REQUIRED" });
    expect(await prisma.quote.count({
      where: { tenantId: owner.tenant.id, customerId: createdCustomer.id },
    })).toBe(0);

    const bypass = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${createdCustomer.id}`,
      headers: { cookie: owner.cookie },
      payload: { followUpStatus: "NEEDS_FOLLOW_UP" },
    });
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json()).toMatchObject({ code: "CUSTOMER_LIFECYCLE_COMMAND_REQUIRED" });

    await expect(prisma.$transaction((tx) => seedCustomerFollowUpSchedule(tx, {
      tenantId: owner.tenant.id,
      customerId: createdCustomer.id,
      createdByTenantUserId: ownerActor.id,
    }))).rejects.toMatchObject({ code: "FOLLOW_UP_CUSTOMER_TERMINAL" });

    const reopenedWithoutSchedule = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/reopen`,
      headers: { cookie: owner.cookie },
      payload: { startFollowUpSequence: false, expectedVersion: lostBody.customer.lifecycleVersion },
    });
    expect(reopenedWithoutSchedule.statusCode).toBe(200);
    const reopenedCustomer = (reopenedWithoutSchedule.json() as {
      customer: { lifecycleVersion: number; followUpStatus: string; lostReason: null; lostReasonNotes: null; lostAtUtc: null; reopenedAtUtc: string };
      startedFollowUpSequence: boolean;
      createdAutomaticTaskCount: number;
    });
    expect(reopenedCustomer).toMatchObject({
      customer: {
        lifecycleVersion: lostBody.customer.lifecycleVersion + 1,
        followUpStatus: "NEEDS_FOLLOW_UP",
        lostReason: null,
        lostReasonNotes: null,
        lostAtUtc: null,
      },
      startedFollowUpSequence: false,
      createdAutomaticTaskCount: 0,
    });
    expect(reopenedCustomer.customer.reopenedAtUtc).toEqual(expect.any(String));

    const lostAgain = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: { reason: "TIMING", expectedVersion: reopenedCustomer.customer.lifecycleVersion },
    });
    expect(lostAgain.statusCode).toBe(200);
    const lostAgainVersion = (lostAgain.json() as { customer: { lifecycleVersion: number } }).customer.lifecycleVersion;
    const historicalDraft = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: createdCustomer.id,
        serviceType: "CONSTRUCTION",
        status: "DRAFT",
        title: "Existing quote while customer is lost",
        scopeText: "This quote cannot be accepted until the customer is reopened.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
        totalAmount: 200,
      },
    });
    const acceptWhileLost = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${historicalDraft.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "ACCEPTED" },
    });
    expect(acceptWhileLost.statusCode).toBe(409);
    expect(acceptWhileLost.json()).toMatchObject({ code: "CUSTOMER_REOPEN_REQUIRED" });
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: historicalDraft.id } })).toMatchObject({ status: "DRAFT" });
    expect(await prisma.job.count({ where: { sourceQuoteId: historicalDraft.id } })).toBe(0);

    const reopenedWithSchedule = await app.inject({
      method: "POST",
      url: `/v1/customers/${createdCustomer.id}/reopen`,
      headers: { cookie: owner.cookie },
      payload: { startFollowUpSequence: true, expectedVersion: lostAgainVersion },
    });
    expect(reopenedWithSchedule.statusCode).toBe(200);
    expect(reopenedWithSchedule.json()).toMatchObject({
      startedFollowUpSequence: true,
      createdAutomaticTaskCount: 4,
      openManualTaskCount: 1,
    });
    const allSequences = await prisma.customerFollowUpSequence.findMany({
      where: { tenantId: owner.tenant.id, customerId: createdCustomer.id },
      include: { tasks: true },
      orderBy: { createdAt: "asc" },
    });
    expect(allSequences).toHaveLength(2);
    expect(new Set(allSequences.flatMap((sequence) => sequence.tasks.map((task) => task.sourceKey))).size).toBe(8);

    const rejectCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Rejected Quote Customer", phone: "555-201-3002" },
    });
    expect(rejectCustomer.statusCode).toBe(201);
    const rejectCustomerId = (rejectCustomer.json() as { customer: { id: string } }).customer.id;
    const rejectedManualTask = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "customer-rejection-manual-task-0001" },
      payload: taskPayload(rejectCustomerId, "Review rejected quote manually"),
    });
    expect(rejectedManualTask.statusCode).toBe(201);
    const rejectedManualTaskId = (rejectedManualTask.json() as { task: { id: string } }).task.id;
    const rejectedLifecycle = await prisma.$transaction((tx) => applyQuoteCustomerLifecycle(tx, {
      tenantId: owner.tenant.id,
      customerId: rejectCustomerId,
      quoteStatus: "REJECTED",
    }));
    expect(rejectedLifecycle).toMatchObject({
      customerStatusChanged: false,
      canceledAutomaticTaskCount: 4,
    });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: rejectCustomerId } })).toMatchObject({
      followUpStatus: "NEEDS_FOLLOW_UP",
      lostReason: null,
      lostAtUtc: null,
    });
    expect(await prisma.customerFollowUpSequence.findFirstOrThrow({ where: { customerId: rejectCustomerId } })).toMatchObject({
      status: "CANCELED",
      cancellationReason: "QUOTE_REJECTED",
    });
    expect(await prisma.activityTask.count({
      where: {
        tenantId: owner.tenant.id,
        customerId: rejectCustomerId,
        origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
        status: "OPEN",
      },
    })).toBe(0);
    expect(await prisma.activityTask.findUniqueOrThrow({ where: { id: rejectedManualTaskId } })).toMatchObject({
      origin: "MANUAL",
      status: "OPEN",
    });

    const automationDisabledCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Disabled Reopen Automation Customer", phone: "555-201-3003" },
    });
    expect(automationDisabledCustomer.statusCode).toBe(201);
    const automationDisabledRecord = (automationDisabledCustomer.json() as {
      customer: { id: string; lifecycleVersion: number };
    }).customer;
    const automationDisabledLoss = await app.inject({
      method: "POST",
      url: `/v1/customers/${automationDisabledRecord.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: { reason: "NO_RESPONSE", expectedVersion: automationDisabledRecord.lifecycleVersion },
    });
    expect(automationDisabledLoss.statusCode).toBe(200);
    const automationDisabledLossVersion = (automationDisabledLoss.json() as {
      customer: { lifecycleVersion: number };
    }).customer.lifecycleVersion;
    const currentSettings = await app.inject({
      method: "GET",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
    });
    expect(currentSettings.statusCode).toBe(200);
    const currentSettingsVersion = (currentSettings.json() as {
      followUpSettings: { version: number };
    }).followUpSettings.version;
    const disabledSettings = await app.inject({
      method: "PATCH",
      url: "/v1/follow-up-settings",
      headers: { cookie: owner.cookie },
      payload: { version: currentSettingsVersion, enabled: false },
    });
    expect(disabledSettings.statusCode).toBe(200);
    const requestedAutomationReopen = await app.inject({
      method: "POST",
      url: `/v1/customers/${automationDisabledRecord.id}/reopen`,
      headers: { cookie: owner.cookie },
      payload: { startFollowUpSequence: true, expectedVersion: automationDisabledLossVersion },
    });
    expect(requestedAutomationReopen.statusCode).toBe(200);
    expect(requestedAutomationReopen.json()).toMatchObject({
      startedFollowUpSequence: false,
      createdAutomaticTaskCount: 0,
    });
    const disabledReopenActivity = await prisma.customerActivityEvent.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        customerId: automationDisabledRecord.id,
        eventType: "CUSTOMER_REOPENED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(disabledReopenActivity).toMatchObject({
      detail: expect.stringContaining("without starting a new follow-up sequence"),
      metadata: expect.objectContaining({
        followUpSequenceRequested: true,
        startedFollowUpSequence: false,
        createdAutomaticTaskCount: 0,
      }),
    });

    const activeJobCustomer = await createCustomer(owner, "Active Job Customer");
    const activeJobQuote = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: activeJobCustomer.id,
        serviceType: "CONSTRUCTION",
        status: "ACCEPTED",
        title: "Active construction job",
        scopeText: "Active work must be completed before customer loss.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
        totalAmount: 200,
      },
    });
    await prisma.job.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: activeJobCustomer.id,
        sourceQuoteId: activeJobQuote.id,
        jobNumber: 1,
        status: "IN_PROGRESS",
        title: activeJobQuote.title,
        scopeSnapshot: activeJobQuote.scopeText,
        serviceType: activeJobQuote.serviceType,
        acceptedAtUtc: new Date(),
      },
    });
    const activeJobBlocked = await app.inject({
      method: "POST",
      url: `/v1/customers/${activeJobCustomer.id}/mark-lost`,
      headers: { cookie: owner.cookie },
      payload: { reason: "CUSTOMER_CANCELED", expectedVersion: activeJobCustomer.lifecycleVersion },
    });
    expect(activeJobBlocked.statusCode).toBe(409);
    expect(activeJobBlocked.json()).toMatchObject({ code: "CUSTOMER_HAS_ACTIVE_JOBS" });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: activeJobCustomer.id } })).toMatchObject({
      followUpStatus: "NEEDS_FOLLOW_UP",
      lostReason: null,
    });
  });

  test("permits browser idempotency preflight and enforces replay, payload, and CAS semantics", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/activities",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]?.toLowerCase()).toContain("idempotency-key");

    const owner = await signUp("activity-idempotency");
    const customer = await createCustomer(owner, "Activity Customer");
    const key = "activity-create-idempotency-0001";
    const payload = taskPayload(customer.id);
    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { task: { id: string; version: number }; duplicate: boolean };
    expect(createdBody.duplicate).toBe(false);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { duplicate: boolean }).duplicate).toBe(true);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": key },
      payload: { ...payload, title: "Different task" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "ACTIVITY_IDEMPOTENCY_CONFLICT" });

    const concurrent = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/activities/${createdBody.task.id}/complete`,
        headers: { cookie: owner.cookie, "idempotency-key": "complete-concurrent-request-0001" },
        payload: { version: createdBody.task.version },
      }),
      app.inject({
        method: "POST",
        url: `/v1/activities/${createdBody.task.id}/complete`,
        headers: { cookie: owner.cookie, "idempotency-key": "complete-concurrent-request-0002" },
        payload: { version: createdBody.task.version },
      }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.activityTaskEvent.count({
      where: { tenantId: owner.tenant.id, activityTaskId: createdBody.task.id, type: "COMPLETED" },
    })).toBe(1);
  });

  test("keeps members inside current assignments and blocks replay after reassignment", async () => {
    const owner = await signUp("activity-assignment");
    const memberA = await addMember(owner, "Field Member A");
    const memberB = await addMember(owner, "Field Member B");
    const customer = await createCustomer(owner, "Assigned Activity Customer", memberA.membershipId);
    const key = "member-task-create-replay-0001";
    const payload = taskPayload(customer.id, "Member A follow-up");

    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: memberA.cookie, "idempotency-key": key },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const task = (created.json() as { task: { id: string; version: number } }).task;

    const assignCustomer = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { assignedTenantUserId: memberB.membershipId },
    });
    expect(assignCustomer.statusCode).toBe(200);
    const assignTask = await app.inject({
      method: "PATCH",
      url: `/v1/activities/${task.id}`,
      headers: { cookie: owner.cookie, "idempotency-key": "owner-reassign-task-command-0001" },
      payload: { version: task.version, assignedTenantUserId: memberB.membershipId },
    });
    expect(assignTask.statusCode).toBe(200);

    const staleReplay = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: memberA.cookie, "idempotency-key": key },
      payload,
    });
    expect(staleReplay.statusCode).toBe(404);
    expect(staleReplay.body).not.toContain("Member B");
    expect(staleReplay.body).not.toContain("Assigned Activity Customer");

    const memberAList = await app.inject({ method: "GET", url: "/v1/activities", headers: { cookie: memberA.cookie } });
    const memberBList = await app.inject({ method: "GET", url: "/v1/activities", headers: { cookie: memberB.cookie } });
    expect((memberAList.json() as { items: unknown[]; scope: { mine: boolean } }).items).toHaveLength(0);
    expect((memberAList.json() as { scope: { mine: boolean } }).scope.mine).toBe(true);
    expect((memberBList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([task.id]);

    const removal = await app.inject({
      method: "DELETE",
      url: `/v1/org/users/${memberB.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(removal.statusCode).toBe(409);
    expect(removal.json()).toMatchObject({
      code: "MEMBER_HAS_ACTIVE_ASSIGNMENTS",
      assignments: { activities: 1 },
    });
  });

  test("reopens work under the linked record's active assignee after member removal", async () => {
    const owner = await signUp("activity-reopen-assignee");
    const ownerTenantUser = await ownerMembership(owner);
    const member = await addMember(owner, "Former Field Member");
    const customer = await createCustomer(owner, "Reopen Assignment Customer", member.membershipId);

    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: member.cookie, "idempotency-key": "removed-assignee-create-0001" },
      payload: taskPayload(customer.id, "Completed task for former member"),
    });
    expect(created.statusCode).toBe(201);
    const task = (created.json() as { task: { id: string; version: number } }).task;

    const completed = await app.inject({
      method: "POST",
      url: `/v1/activities/${task.id}/complete`,
      headers: { cookie: member.cookie, "idempotency-key": "removed-assignee-complete-0001" },
      payload: { version: task.version },
    });
    expect(completed.statusCode).toBe(200);
    const completedTask = (completed.json() as { task: { version: number } }).task;

    const reassignCustomer = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { assignedTenantUserId: ownerTenantUser.id },
    });
    expect(reassignCustomer.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/org/users/${member.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(204);

    const reopen = await app.inject({
      method: "POST",
      url: `/v1/activities/${task.id}/reopen`,
      headers: { cookie: owner.cookie, "idempotency-key": "removed-assignee-reopen-0001" },
      payload: { version: completedTask.version },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toMatchObject({
      task: {
        status: "OPEN",
        assignedTenantUserId: ownerTenantUser.id,
      },
    });
  });

  test("reopens completed work under the member who now owns its linked records", async () => {
    const owner = await signUp("activity-reopen-linked-owner");
    const memberA = await addMember(owner, "Original Task Owner");
    const memberB = await addMember(owner, "Current Record Owner");
    const customer = await createCustomer(owner, "Reassigned Activity Customer", memberA.membershipId);

    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: memberA.cookie, "idempotency-key": "reassigned-reopen-create-0001" },
      payload: taskPayload(customer.id, "Follow up after reassignment"),
    });
    expect(created.statusCode).toBe(201);
    const task = (created.json() as { task: { id: string; version: number } }).task;

    const completed = await app.inject({
      method: "POST",
      url: `/v1/activities/${task.id}/complete`,
      headers: { cookie: memberA.cookie, "idempotency-key": "reassigned-reopen-complete-0001" },
      payload: { version: task.version },
    });
    expect(completed.statusCode).toBe(200);
    const completedTask = (completed.json() as { task: { version: number } }).task;

    const reassigned = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { assignedTenantUserId: memberB.membershipId },
    });
    expect(reassigned.statusCode).toBe(200);

    const reopened = await app.inject({
      method: "POST",
      url: `/v1/activities/${task.id}/reopen`,
      headers: { cookie: owner.cookie, "idempotency-key": "reassigned-reopen-command-0001" },
      payload: { version: completedTask.version },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({
      task: {
        status: "OPEN",
        assignedTenantUserId: memberB.membershipId,
      },
    });

    const memberAList = await app.inject({
      method: "GET",
      url: "/v1/activities",
      headers: { cookie: memberA.cookie },
    });
    const memberBList = await app.inject({
      method: "GET",
      url: "/v1/activities",
      headers: { cookie: memberB.cookie },
    });
    expect((memberAList.json() as { items: Array<{ id: string }> }).items).toHaveLength(0);
    expect((memberBList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(task.id);
  });

  test("serializes customer and quote assignment writes ahead of member removal", async () => {
    const owner = await signUp("assignment-removal-race");

    const customerCreateMember = await addMember(owner, "Customer Create Race Member");
    const createPhone = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
    await raceAssignmentAgainstMemberRemoval({
      owner,
      membershipId: customerCreateMember.membershipId,
      expectedAssignmentStatus: 201,
      expectedAssignmentKind: "customers",
      assign: () => app.inject({
        method: "POST",
        url: "/v1/customers",
        headers: { cookie: owner.cookie },
        payload: {
          fullName: "Customer Create Race",
          phone: createPhone,
          assignedTenantUserId: customerCreateMember.membershipId,
        },
      }),
    });

    const customerUpdateMember = await addMember(owner, "Customer Update Race Member");
    const updateCustomer = await createCustomer(owner, "Customer Update Race");
    await raceAssignmentAgainstMemberRemoval({
      owner,
      membershipId: customerUpdateMember.membershipId,
      expectedAssignmentStatus: 200,
      expectedAssignmentKind: "customers",
      assign: () => app.inject({
        method: "PATCH",
        url: `/v1/customers/${updateCustomer.id}`,
        headers: { cookie: owner.cookie },
        payload: { assignedTenantUserId: customerUpdateMember.membershipId },
      }),
    });

    const quoteCreateMember = await addMember(owner, "Quote Create Race Member");
    const quoteCreateCustomer = await createCustomer(owner, "Quote Create Race Customer");
    await raceAssignmentAgainstMemberRemoval({
      owner,
      membershipId: quoteCreateMember.membershipId,
      expectedAssignmentStatus: 201,
      expectedAssignmentKind: "quotes",
      assign: () => app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { cookie: owner.cookie },
        payload: {
          customerId: quoteCreateCustomer.id,
          assignedTenantUserId: quoteCreateMember.membershipId,
          serviceType: "CONSTRUCTION",
          title: "Quote create assignment race",
          scopeText: "Validate serialized quote assignment.",
          internalCostSubtotal: 50,
          customerPriceSubtotal: 100,
          taxAmount: 0,
          lineItems: [{
            description: "Serialized labor",
            quantity: 1,
            unitCost: 50,
            unitPrice: 100,
          }],
        },
      }),
    });

    const quoteUpdateMember = await addMember(owner, "Quote Update Race Member");
    const quoteUpdateCustomer = await createCustomer(owner, "Quote Update Race Customer");
    const updateQuote = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: quoteUpdateCustomer.id,
        serviceType: "CONSTRUCTION",
        title: "Quote update assignment race",
        scopeText: "Validate serialized quote reassignment.",
        internalCostSubtotal: 25,
        customerPriceSubtotal: 75,
        taxAmount: 0,
        totalAmount: 75,
      },
    });
    await raceAssignmentAgainstMemberRemoval({
      owner,
      membershipId: quoteUpdateMember.membershipId,
      expectedAssignmentStatus: 200,
      expectedAssignmentKind: "quotes",
      assign: () => app.inject({
        method: "PATCH",
        url: `/v1/quotes/${updateQuote.id}`,
        headers: { cookie: owner.cookie },
        payload: { assignedTenantUserId: quoteUpdateMember.membershipId },
      }),
    });

    const removalFirstMember = await addMember(owner, "Removal First Race Member");
    const lockReady = deferred();
    const releaseLock = deferred();
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT membership."id"
        FROM "TenantUser" membership
        WHERE membership."id" = ${removalFirstMember.membershipId}
          AND membership."tenantId" = ${owner.tenant.id}
        FOR UPDATE OF membership
      `);
      lockReady.resolve();
      await releaseLock.promise;
    }, { maxWait: 5_000, timeout: 15_000 });
    await lockReady.promise;

    const removalPromise = app.inject({
      method: "DELETE",
      url: `/v1/org/users/${removalFirstMember.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    await waitForMembershipLockWaiters(1);
    const removalFirstPhone = Math.random().toString().slice(2, 12).padEnd(10, "0").slice(0, 10);
    const assignmentPromise = app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: {
        fullName: "Removal First Must Not Persist",
        phone: removalFirstPhone,
        assignedTenantUserId: removalFirstMember.membershipId,
      },
    });
    await waitForMembershipLockWaiters(2);
    releaseLock.resolve();

    const [removal, assignment] = await Promise.all([removalPromise, assignmentPromise]);
    await blocker;
    expect(removal.statusCode).toBe(204);
    expect(assignment.statusCode).toBe(409);
    expect(assignment.json()).toMatchObject({ code: "ASSIGNEE_INACTIVE" });
    expect(await prisma.customer.count({
      where: { tenantId: owner.tenant.id, phoneDigits: removalFirstPhone },
    })).toBe(0);

    const mergeTarget = await createCustomer(owner, "Inactive Merge Target");
    const mergeBefore = await prisma.customer.findUniqueOrThrow({ where: { id: mergeTarget.id } });
    const inactiveMerge = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: {
        fullName: "Inactive Merge Must Not Persist",
        phone: mergeTarget.phone,
        assignedTenantUserId: removalFirstMember.membershipId,
        duplicateAction: "merge",
        duplicateCustomerId: mergeTarget.id,
      },
    });
    expect(inactiveMerge.statusCode).toBe(403);
    const mergeAfter = await prisma.customer.findUniqueOrThrow({ where: { id: mergeTarget.id } });
    expect(mergeAfter.fullName).toBe(mergeBefore.fullName);
    expect(mergeAfter.assignedTenantUserId).toBeNull();
  });

  test("blocks customer and quote retention changes until linked active tasks are resolved", async () => {
    const owner = await signUp("activity-retention-policy");
    const member = await addMember(owner, "Retention Task Member");
    const restoredCustomerIds: string[] = [];
    const activeQuoteCustomerIds: string[] = [];

    for (const operation of ["archive", "delete"] as const) {
      const customer = await createCustomer(owner, `Customer ${operation} task`, member.membershipId);
      const created = await app.inject({
        method: "POST",
        url: "/v1/activities",
        headers: { cookie: member.cookie, "idempotency-key": `customer-${operation}-task-create-0001` },
        payload: taskPayload(customer.id, `Resolve before customer ${operation}`),
      });
      expect(created.statusCode).toBe(201);
      const task = (created.json() as { task: { id: string; version: number } }).task;

      const blocked = await app.inject({
        method: operation === "archive" ? "POST" : "DELETE",
        url: operation === "archive" ? `/v1/customers/${customer.id}/archive` : `/v1/customers/${customer.id}`,
        headers: { cookie: owner.cookie },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: "ACTIVE_ACTIVITY_TASKS", activeTaskCount: 1 });

      const completed = await app.inject({
        method: "POST",
        url: `/v1/activities/${task.id}/complete`,
        headers: { cookie: member.cookie, "idempotency-key": `customer-${operation}-task-complete-0001` },
        payload: { version: task.version },
      });
      expect(completed.statusCode).toBe(200);
      const changed = await app.inject({
        method: operation === "archive" ? "POST" : "DELETE",
        url: operation === "archive" ? `/v1/customers/${customer.id}/archive` : `/v1/customers/${customer.id}`,
        headers: { cookie: owner.cookie },
      });
      expect(changed.statusCode).toBe(204);

      const restored = await app.inject({
        method: "POST",
        url: `/v1/customers/${customer.id}/restore`,
        headers: { cookie: owner.cookie },
      });
      expect(restored.statusCode).toBe(200);
      restoredCustomerIds.push(customer.id);
      const completedList = await app.inject({
        method: "GET",
        url: `/v1/activities?status=COMPLETED&customerId=${customer.id}`,
        headers: { cookie: member.cookie },
      });
      expect((completedList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(task.id);
    }

    for (const operation of ["archive", "delete"] as const) {
      const customer = await createCustomer(owner, `Quote ${operation} task customer`, member.membershipId);
      activeQuoteCustomerIds.push(customer.id);
      const quote = await prisma.quote.create({
        data: {
          tenantId: owner.tenant.id,
          customerId: customer.id,
          assignedTenantUserId: member.membershipId,
          serviceType: "CONSTRUCTION",
          title: `Quote ${operation} task`,
          scopeText: `Resolve task before quote ${operation}.`,
          internalCostSubtotal: 25,
          customerPriceSubtotal: 75,
          taxAmount: 0,
          totalAmount: 75,
        },
      });
      const created = await app.inject({
        method: "POST",
        url: "/v1/activities",
        headers: { cookie: member.cookie, "idempotency-key": `quote-${operation}-task-create-0001` },
        payload: { ...taskPayload(customer.id, `Resolve before quote ${operation}`), quoteId: quote.id },
      });
      expect(created.statusCode).toBe(201);
      const task = (created.json() as { task: { id: string; version: number } }).task;

      const blocked = await app.inject({
        method: operation === "archive" ? "POST" : "DELETE",
        url: operation === "archive" ? `/v1/quotes/${quote.id}/archive` : `/v1/quotes/${quote.id}`,
        headers: { cookie: owner.cookie },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: "ACTIVE_ACTIVITY_TASKS", activeTaskCount: 1 });

      const completed = await app.inject({
        method: "POST",
        url: `/v1/activities/${task.id}/complete`,
        headers: { cookie: member.cookie, "idempotency-key": `quote-${operation}-task-complete-0001` },
        payload: { version: task.version },
      });
      expect(completed.statusCode).toBe(200);
      const changed = await app.inject({
        method: operation === "archive" ? "POST" : "DELETE",
        url: operation === "archive" ? `/v1/quotes/${quote.id}/archive` : `/v1/quotes/${quote.id}`,
        headers: { cookie: owner.cookie },
      });
      expect(changed.statusCode).toBe(204);
    }

    for (const customerId of [...restoredCustomerIds, ...activeQuoteCustomerIds]) {
      const unassigned = await app.inject({
        method: "PATCH",
        url: `/v1/customers/${customerId}`,
        headers: { cookie: owner.cookie },
        payload: { assignedTenantUserId: null },
      });
      expect(unassigned.statusCode).toBe(200);
    }
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/org/users/${member.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(204);
  });

  test("serializes task creation behind customer and quote retention changes", async () => {
    const owner = await signUp("activity-retention-race");

    const customer = await createCustomer(owner, "Customer retention race");
    const customerLockReady = deferred();
    const releaseCustomerLock = deferred();
    const customerBlocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT customer.id FROM "Customer" customer
        WHERE customer.id = ${customer.id} AND customer."tenantId" = ${owner.tenant.id}
        FOR UPDATE OF customer
      `);
      customerLockReady.resolve();
      await releaseCustomerLock.promise;
    }, { maxWait: 5_000, timeout: 15_000 });
    await customerLockReady.promise;
    const archiveCustomer = app.inject({
      method: "POST",
      url: `/v1/customers/${customer.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    await waitForRecordLockWaiters("customer", 1);
    const createCustomerTask = app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "retention-customer-race-task-0001" },
      payload: taskPayload(customer.id, "Must not outlive archived customer"),
    });
    await waitForRecordLockWaiters("customer", 2);
    releaseCustomerLock.resolve();
    const [customerArchiveResult, customerTaskResult] = await Promise.all([archiveCustomer, createCustomerTask]);
    await customerBlocker;
    expect(customerArchiveResult.statusCode).toBe(204);
    expect(customerTaskResult.statusCode).toBe(404);
    expect(await prisma.activityTask.count({
      where: { tenantId: owner.tenant.id, title: "Must not outlive archived customer" },
    })).toBe(0);

    const quoteCustomer = await createCustomer(owner, "Quote retention race customer");
    const quote = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: quoteCustomer.id,
        serviceType: "CONSTRUCTION",
        title: "Quote retention race",
        scopeText: "Validate quote retention serialization.",
        internalCostSubtotal: 25,
        customerPriceSubtotal: 75,
        taxAmount: 0,
        totalAmount: 75,
      },
    });
    const quoteLockReady = deferred();
    const releaseQuoteLock = deferred();
    const quoteBlocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT quote.id FROM "Quote" quote
        WHERE quote.id = ${quote.id} AND quote."tenantId" = ${owner.tenant.id}
        FOR UPDATE OF quote
      `);
      quoteLockReady.resolve();
      await releaseQuoteLock.promise;
    }, { maxWait: 5_000, timeout: 15_000 });
    await quoteLockReady.promise;
    const archiveQuote = app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    await waitForRecordLockWaiters("quote", 1);
    const createQuoteTask = app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "retention-quote-race-task-0001" },
      payload: { ...taskPayload(quoteCustomer.id, "Must not outlive archived quote"), quoteId: quote.id },
    });
    await waitForRecordLockWaiters("customer", 1);
    releaseQuoteLock.resolve();
    const [quoteArchiveResult, quoteTaskResult] = await Promise.all([archiveQuote, createQuoteTask]);
    await quoteBlocker;
    expect(quoteArchiveResult.statusCode).toBe(204);
    expect(quoteTaskResult.statusCode).toBe(404);
    expect(await prisma.activityTask.count({
      where: { tenantId: owner.tenant.id, title: "Must not outlive archived quote" },
    })).toBe(0);
  });

  test("keeps admin-to-member role changes aligned with active task visibility under concurrency", async () => {
    const owner = await signUp("activity-role-change");
    const admin = await addMember(owner, "Task Admin", "admin");
    const customer = await createCustomer(owner, "Admin Task Customer");
    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "admin-task-create-0001" },
      payload: {
        ...taskPayload(customer.id, "Admin task before demotion"),
        assignedTenantUserId: admin.membershipId,
      },
    });
    expect(created.statusCode).toBe(201);

    const blocked = await app.inject({
      method: "PATCH",
      url: `/v1/org/users/${admin.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "member" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "ROLE_CHANGE_ACTIVE_WORK_CONFLICT", activeWorkCount: 1 });
    expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: admin.membershipId } })).role).toBe("admin");

    const alignedCustomer = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { assignedTenantUserId: admin.membershipId },
    });
    expect(alignedCustomer.statusCode).toBe(200);
    const demoted = await app.inject({
      method: "PATCH",
      url: `/v1/org/users/${admin.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "member" },
    });
    expect(demoted.statusCode).toBe(200);
    const memberList = await app.inject({ method: "GET", url: "/v1/activities", headers: { cookie: admin.cookie } });
    expect((memberList.json() as { items: Array<{ title: string }> }).items.map((item) => item.title)).toContain("Admin task before demotion");

    const assignmentFirstAdmin = await addMember(owner, "Assignment First Admin", "admin");
    const assignmentFirstCustomer = await createCustomer(owner, "Assignment First Role Customer");
    const firstLockReady = deferred();
    const firstRelease = deferred();
    const firstBlocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT membership."id" FROM "TenantUser" membership
        WHERE membership."id" = ${assignmentFirstAdmin.membershipId}
          AND membership."tenantId" = ${owner.tenant.id}
        FOR UPDATE OF membership
      `);
      firstLockReady.resolve();
      await firstRelease.promise;
    }, { maxWait: 5_000, timeout: 15_000 });
    await firstLockReady.promise;
    const taskFirst = app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "assignment-first-role-task-0001" },
      payload: {
        ...taskPayload(assignmentFirstCustomer.id, "Assignment wins before demotion"),
        assignedTenantUserId: assignmentFirstAdmin.membershipId,
      },
    });
    await waitForMembershipLockWaiters(1);
    const demotionSecond = app.inject({
      method: "PATCH",
      url: `/v1/org/users/${assignmentFirstAdmin.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "member" },
    });
    await waitForMembershipLockWaiters(2);
    firstRelease.resolve();
    const [taskFirstResult, demotionSecondResult] = await Promise.all([taskFirst, demotionSecond]);
    await firstBlocker;
    expect(taskFirstResult.statusCode).toBe(201);
    expect(demotionSecondResult.statusCode).toBe(409);
    expect(demotionSecondResult.json()).toMatchObject({ code: "ROLE_CHANGE_ACTIVE_WORK_CONFLICT" });

    const demotionFirstAdmin = await addMember(owner, "Demotion First Admin", "admin");
    const demotionFirstCustomer = await createCustomer(owner, "Demotion First Role Customer");
    const secondLockReady = deferred();
    const secondRelease = deferred();
    const secondBlocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT membership."id" FROM "TenantUser" membership
        WHERE membership."id" = ${demotionFirstAdmin.membershipId}
          AND membership."tenantId" = ${owner.tenant.id}
        FOR UPDATE OF membership
      `);
      secondLockReady.resolve();
      await secondRelease.promise;
    }, { maxWait: 5_000, timeout: 15_000 });
    await secondLockReady.promise;
    const demotionFirst = app.inject({
      method: "PATCH",
      url: `/v1/org/users/${demotionFirstAdmin.membershipId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "member" },
    });
    await waitForMembershipLockWaiters(1);
    const taskSecond = app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "demotion-first-role-task-0001" },
      payload: {
        ...taskPayload(demotionFirstCustomer.id, "Demotion wins before assignment"),
        assignedTenantUserId: demotionFirstAdmin.membershipId,
      },
    });
    await waitForMembershipLockWaiters(2);
    secondRelease.resolve();
    const [demotionFirstResult, taskSecondResult] = await Promise.all([demotionFirst, taskSecond]);
    await secondBlocker;
    expect(demotionFirstResult.statusCode).toBe(200);
    expect(taskSecondResult.statusCode).toBe(409);
    expect(taskSecondResult.json()).toMatchObject({ code: "ACTIVITY_ASSIGNEE_RECORD_CONFLICT" });
    expect(await prisma.activityTask.count({
      where: { tenantId: owner.tenant.id, title: "Demotion wins before assignment" },
    })).toBe(0);
  });

  test("enforces quote/customer consistency, cross-tenant denial, and bounded pagination", async () => {
    const owner = await signUp("activity-pagination");
    const otherOwner = await signUp("activity-other-tenant");
    const membership = await ownerMembership(owner);
    const customer = await createCustomer(owner, "Pagination Customer");
    const otherCustomer = await createCustomer(owner, "Different Quote Customer");
    const quote = await prisma.quote.create({
      data: {
        tenantId: owner.tenant.id,
        customerId: otherCustomer.id,
        serviceType: "CONSTRUCTION",
        title: "Other customer quote",
        scopeText: "Test scope",
        internalCostSubtotal: 10,
        customerPriceSubtotal: 20,
        taxAmount: 0,
        totalAmount: 20,
      },
    });
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "quote-customer-mismatch-0001" },
      payload: { ...taskPayload(customer.id), quoteId: quote.id },
    });
    expect(mismatch.statusCode).toBe(404);

    const now = Date.now();
    await prisma.activityTask.createMany({
      data: Array.from({ length: 26 }, (_, index) => ({
        tenantId: owner.tenant.id,
        customerId: customer.id,
        assignedTenantUserId: membership.id,
        createdByTenantUserId: membership.id,
        type: "CUSTOM" as const,
        priority: "NORMAL" as const,
        title: `Paged task ${String(index).padStart(2, "0")}`,
        dueAtUtc: new Date(now + index * 60_000),
      })),
    });

    const page25 = await app.inject({ method: "GET", url: "/v1/activities?limit=25&offset=0", headers: { cookie: owner.cookie } });
    const page2 = await app.inject({ method: "GET", url: "/v1/activities?limit=25&offset=25", headers: { cookie: owner.cookie } });
    const page100 = await app.inject({ method: "GET", url: "/v1/activities?limit=100&offset=0", headers: { cookie: owner.cookie } });
    expect(page25.statusCode).toBe(200);
    expect((page25.json() as { items: unknown[]; pagination: { total: number } }).items).toHaveLength(25);
    expect((page25.json() as { pagination: { total: number } }).pagination.total).toBe(26);
    expect((page2.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((page100.json() as { items: unknown[] }).items).toHaveLength(26);

    const firstTask = (page25.json() as { items: Array<{ id: string; version: number }> }).items[0]!;
    const guessedMutation = await app.inject({
      method: "POST",
      url: `/v1/activities/${firstTask.id}/complete`,
      headers: { cookie: otherOwner.cookie, "idempotency-key": "cross-tenant-guessed-task-0001" },
      payload: { version: firstTask.version },
    });
    expect(guessedMutation.statusCode).toBe(404);
  });

  test("runtime role isolates normalized follow-up templates, steps, and customer sequences", async () => {
    const owner = await signUp("follow-up-runtime-privileges");
    const otherOwner = await signUp("follow-up-runtime-other");

    const ownerCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: owner.cookie },
      payload: { fullName: "Runtime Scheduled Customer", phone: "555-808-0101" },
    });
    const otherCustomer = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: { cookie: otherOwner.cookie },
      payload: { fullName: "Other Runtime Scheduled Customer", phone: "555-808-0102" },
    });
    expect(ownerCustomer.statusCode).toBe(201);
    expect(otherCustomer.statusCode).toBe(201);

    const ownerTemplate = await prisma.followUpTemplate.findFirstOrThrow({
      where: { tenantId: owner.tenant.id, isDefault: true },
      include: { steps: true },
    });
    const otherTemplate = await prisma.followUpTemplate.findFirstOrThrow({
      where: { tenantId: otherOwner.tenant.id, isDefault: true },
    });
    const ownerSequence = await prisma.customerFollowUpSequence.findFirstOrThrow({
      where: { tenantId: owner.tenant.id },
    });
    const otherSequence = await prisma.customerFollowUpSequence.findFirstOrThrow({
      where: { tenantId: otherOwner.tenant.id },
    });

    const noContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      const templates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "FollowUpTemplate"`);
      const steps = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "FollowUpTemplateStep"`);
      const sequences = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "CustomerFollowUpSequence"`);
      return { templates, steps, sequences };
    });
    expect(noContext).toEqual({ templates: [], steps: [], sequences: [] });

    const tenantRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      const templates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "FollowUpTemplate" ORDER BY "id"`);
      const steps = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "FollowUpTemplateStep" ORDER BY "id"`);
      const sequences = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "CustomerFollowUpSequence" ORDER BY "id"`);
      const crossTenantUpdateCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "FollowUpTemplate" SET "enabled" = false WHERE "id" = ${otherTemplate.id}
      `);
      return { templates, steps, sequences, crossTenantUpdateCount };
    });
    expect(tenantRows.templates.map((row) => row.id)).toEqual([ownerTemplate.id]);
    expect(tenantRows.steps.map((row) => row.id).sort()).toEqual(ownerTemplate.steps.map((step) => step.id).sort());
    expect(tenantRows.sequences.map((row) => row.id)).toEqual([ownerSequence.id]);
    expect(tenantRows.crossTenantUpdateCount).toBe(0);
    expect(tenantRows.templates.map((row) => row.id)).not.toContain(otherTemplate.id);
    expect(tenantRows.sequences.map((row) => row.id)).not.toContain(otherSequence.id);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "FollowUpTemplate" (
          "id", "tenantId", "version", "enabled", "isDefault", "retiredAtUtc", "createdAt", "updatedAt"
        ) VALUES (
          ${`wrong-follow-up-template-${Date.now()}`}, ${otherOwner.tenant.id}, 99, true, false, NOW(), NOW(), NOW()
        )
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "FollowUpTemplateStep" WHERE "id" = ${ownerTemplate.steps[0]!.id}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "CustomerFollowUpSequence" WHERE "id" = ${ownerSequence.id}`);
    })).rejects.toThrow();
  });

  test("runtime role enforces direct tenant RLS and immutable event privileges", async () => {
    const owner = await signUp("activity-runtime-privileges");
    const otherOwner = await signUp("activity-runtime-other");
    const customer = await createCustomer(owner, "Runtime Privilege Customer");
    const otherCustomer = await createCustomer(otherOwner, "Other Runtime Customer");
    const created = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: owner.cookie, "idempotency-key": "runtime-privilege-task-0001" },
      payload: taskPayload(customer.id),
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { task: { id: string } }).task.id;
    const event = await prisma.activityTaskEvent.findFirstOrThrow({ where: { activityTaskId: taskId } });
    const otherCreated = await app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: { cookie: otherOwner.cookie, "idempotency-key": "runtime-other-task-0001" },
      payload: taskPayload(otherCustomer.id, "Other tenant task"),
    });
    expect(otherCreated.statusCode).toBe(201);
    const otherTaskId = (otherCreated.json() as { task: { id: string } }).task.id;
    const otherMembership = await ownerMembership(otherOwner);

    const noContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "ActivityTask"`);
    });
    expect(noContext).toEqual([]);

    const tenantA = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      const tasks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "ActivityTask" ORDER BY "id"`);
      const events = await tx.$queryRaw<Array<{ activityTaskId: string }>>(Prisma.sql`SELECT "activityTaskId" FROM "ActivityTaskEvent" ORDER BY "activityTaskId"`);
      const crossTenantUpdateCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "ActivityTask" SET "title" = 'blocked' WHERE "id" = ${otherTaskId}
      `);
      return { tasks, events, crossTenantUpdateCount };
    });
    expect(tenantA.tasks.map((row) => row.id)).toEqual([taskId]);
    expect(tenantA.events.map((row) => row.activityTaskId)).toEqual([taskId]);
    expect(tenantA.crossTenantUpdateCount).toBe(0);

    const compatibilityEventId = `compat-event-${Date.now()}`;
    const compatibilityActorKind = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      return tx.$queryRaw<Array<{ actorKind: string }>>(Prisma.sql`
        INSERT INTO "ActivityTaskEvent" (
          "id", "tenantId", "activityTaskId", "actorTenantUserId", "type", "requestId", "commandKeyHash", "commandPayloadHash"
        ) VALUES (
          ${compatibilityEventId}, ${owner.tenant.id}, ${taskId}, ${event.actorTenantUserId},
          'UPDATED'::"ActivityTaskEventType", 'rolling-deploy-compatibility', ${"c".repeat(64)}, ${"d".repeat(64)}
        )
        RETURNING "actorKind"::text AS "actorKind"
      `);
    });
    expect(compatibilityActorKind).toEqual([{ actorKind: "USER" }]);

    const tenantB = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${otherOwner.tenant.id}, true)`);
      return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "ActivityTask" ORDER BY "id"`);
    });
    expect(tenantB.map((row) => row.id)).toEqual([otherTaskId]);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ActivityTask" (
          "id", "tenantId", "customerId", "assignedTenantUserId", "createdByTenantUserId", "type", "title", "dueAtUtc"
        ) VALUES (
          ${`wrong-tenant-${Date.now()}`}, ${otherOwner.tenant.id}, ${otherCustomer.id}, ${otherMembership.id}, ${otherMembership.id},
          'CUSTOM'::"ActivityTaskType", 'Blocked cross-tenant insert', NOW()
        )
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ActivityTaskEvent" (
          "id", "tenantId", "activityTaskId", "actorTenantUserId", "actorKind", "type", "requestId", "commandKeyHash", "commandPayloadHash"
        ) VALUES (
          ${`wrong-event-${Date.now()}`}, ${otherOwner.tenant.id}, ${otherTaskId}, ${otherMembership.id},
          'USER'::"ActivityActorKind", 'UPDATED'::"ActivityTaskEventType", 'wrong-tenant', ${"a".repeat(64)}, ${"b".repeat(64)}
        )
      `);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`UPDATE "ActivityTaskEvent" SET "requestId" = 'tampered' WHERE "id" = ${event.id}`);
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${owner.tenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "ActivityTask" WHERE "id" = ${taskId}`);
    })).rejects.toThrow();
  });
});
