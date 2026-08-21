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
    expect(blocked.json()).toMatchObject({ code: "ROLE_CHANGE_ACTIVE_TASK_CONFLICT", activeTaskCount: 1 });
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
    expect(demotionSecondResult.json()).toMatchObject({ code: "ROLE_CHANGE_ACTIVE_TASK_CONFLICT" });

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
          "id", "tenantId", "activityTaskId", "actorTenantUserId", "type", "requestId", "commandKeyHash", "commandPayloadHash"
        ) VALUES (
          ${`wrong-event-${Date.now()}`}, ${otherOwner.tenant.id}, ${otherTaskId}, ${otherMembership.id},
          'UPDATED'::"ActivityTaskEventType", 'wrong-tenant', ${"a".repeat(64)}, ${"b".repeat(64)}
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
