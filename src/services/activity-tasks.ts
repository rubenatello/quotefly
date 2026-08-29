import { createHash } from "node:crypto";
import {
  ActivityTaskEventType,
  ActivityTaskPriority,
  ActivityTaskStatus,
  ActivityTaskType,
  FollowUpOutcome,
  Prisma,
} from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { createCustomerActivityEvent, type ActivityActor } from "../lib/activity";
import {
  applyAutomatedFollowUpOutcome,
  lockCustomerForAutomatedFollowUpCompletion,
} from "./customer-follow-up";

export type ActivityTaskTransaction = Prisma.TransactionClient;

export class ActivityTaskServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const ActivityTaskPublicSelect = {
  id: true,
  customerId: true,
  quoteId: true,
  assignedTenantUserId: true,
  createdByTenantUserId: true,
  completedByTenantUserId: true,
  type: true,
  status: true,
  priority: true,
  origin: true,
  followUpOutcome: true,
  followUpSequenceId: true,
  followUpStepNumber: true,
  title: true,
  notes: true,
  dueAtUtc: true,
  completedAtUtc: true,
  canceledAtUtc: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAtUtc: true,
  customer: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
    },
  },
  quote: {
    select: {
      id: true,
      title: true,
      status: true,
      totalAmount: true,
    },
  },
  assignedTenantUser: {
    select: {
      id: true,
      role: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
        },
      },
    },
  },
} as const satisfies Prisma.ActivityTaskSelect;

export type ActivityTaskPublic = Prisma.ActivityTaskGetPayload<{
  select: typeof ActivityTaskPublicSelect;
}>;

type ActivityTaskCommand = Readonly<{
  operation: string;
  idempotencyKey: string;
  payload: unknown;
  requestId: string;
}>;

type ActivityTaskReplay = Readonly<{
  task: ActivityTaskPublic;
  duplicate: true;
}>;

type LockedMembership = Readonly<{
  id: string;
  role: string;
}>;

type LinkedActivityRecords = Readonly<{
  customer: {
    id: string;
    assignedTenantUserId: string | null;
  };
  quote: {
    id: string;
    assignedTenantUserId: string | null;
  } | null;
  assignee: LockedMembership;
}>;

const ACTIVE_TASK_STATUSES: ActivityTaskStatus[] = ["OPEN", "IN_PROGRESS"];

function normalizeRole(role: string): "owner" | "admin" | "member" {
  const normalized = role.trim().toLowerCase();
  return normalized === "owner" || normalized === "admin" ? normalized : "member";
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commandHashes(access: AccessContext, command: ActivityTaskCommand) {
  return {
    commandKeyHash: sha256(`${access.tenantUserId}:${command.operation}:${command.idempotencyKey}`),
    commandPayloadHash: sha256(JSON.stringify(canonicalize(command.payload))),
  };
}

async function lockCommand(
  transaction: ActivityTaskTransaction,
  commandKeyHash: string,
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${commandKeyHash}, 0))) acquired
  `);
}

async function lockActiveMembership(
  transaction: ActivityTaskTransaction,
  tenantId: string,
  tenantUserId: string,
): Promise<LockedMembership | null> {
  const rows = await transaction.$queryRaw<Array<LockedMembership>>(Prisma.sql`
    SELECT membership."id", membership."role"
    FROM "TenantUser" membership
    INNER JOIN "User" account ON account."id" = membership."userId"
    WHERE membership."id" = ${tenantUserId}
      AND membership."tenantId" = ${tenantId}
      AND membership."deletedAtUtc" IS NULL
      AND account."deletedAtUtc" IS NULL
    FOR UPDATE OF membership
  `);
  return rows[0] ?? null;
}

function memberTaskScope(access: AccessContext): Prisma.ActivityTaskWhereInput {
  if (hasCapability(access, "viewAllWorkspaceRecords")) return {};
  return {
    assignedTenantUserId: access.tenantUserId,
    customer: {
      assignedTenantUserId: access.tenantUserId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
    OR: [
      { quoteId: null },
      {
        quote: {
          assignedTenantUserId: access.tenantUserId,
          archivedAtUtc: null,
          deletedAtUtc: null,
        },
      },
    ],
  };
}

function activeLinkedRecordScope(): Prisma.ActivityTaskWhereInput {
  return {
    customer: { archivedAtUtc: null, deletedAtUtc: null },
    AND: [
      {
        OR: [
          { quoteId: null },
          { quote: { archivedAtUtc: null, deletedAtUtc: null } },
        ],
      },
    ],
  };
}

export function visibleActivityTaskWhere(access: AccessContext): Prisma.ActivityTaskWhereInput {
  return {
    tenantId: access.tenantId,
    deletedAtUtc: null,
    AND: [activeLinkedRecordScope(), memberTaskScope(access)],
  };
}

async function resolveLinkedActivityRecords(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    customerId: string;
    quoteId?: string | null;
    assignedTenantUserId: string;
  },
): Promise<LinkedActivityRecords> {
  const assignee = await lockActiveMembership(
    transaction,
    access.tenantId,
    input.assignedTenantUserId,
  );
  if (!assignee) {
    throw new ActivityTaskServiceError(404, "ACTIVITY_RELATION_NOT_FOUND", "Customer, quote, or assignee was not found.");
  }

  const customerAssignmentScope = hasCapability(access, "viewAllWorkspaceRecords")
    ? Prisma.empty
    : Prisma.sql`AND customer."assignedTenantUserId" = ${access.tenantUserId}`;
  const [customer] = await transaction.$queryRaw<
    Array<{ id: string; assignedTenantUserId: string | null }>
  >(Prisma.sql`
    SELECT customer.id, customer."assignedTenantUserId"
    FROM "Customer" AS customer
    WHERE customer.id = ${input.customerId}
      AND customer."tenantId" = ${access.tenantId}
      AND customer."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
      ${customerAssignmentScope}
    FOR UPDATE OF customer
  `);
  if (!customer) {
    throw new ActivityTaskServiceError(404, "ACTIVITY_RELATION_NOT_FOUND", "Customer, quote, or assignee was not found.");
  }

  const quoteAssignmentScope = hasCapability(access, "viewAllWorkspaceRecords")
    ? Prisma.empty
    : Prisma.sql`AND quote."assignedTenantUserId" = ${access.tenantUserId}`;
  const [quote] = input.quoteId
    ? await transaction.$queryRaw<Array<{ id: string; assignedTenantUserId: string | null }>>(
        Prisma.sql`
          SELECT quote.id, quote."assignedTenantUserId"
          FROM "Quote" AS quote
          WHERE quote.id = ${input.quoteId}
            AND quote."tenantId" = ${access.tenantId}
            AND quote."customerId" = ${customer.id}
            AND quote."archivedAtUtc" IS NULL
            AND quote."deletedAtUtc" IS NULL
            ${quoteAssignmentScope}
          FOR UPDATE OF quote
        `,
      )
    : [null];
  if (input.quoteId && !quote) {
    throw new ActivityTaskServiceError(404, "ACTIVITY_RELATION_NOT_FOUND", "Customer, quote, or assignee was not found.");
  }

  if (normalizeRole(assignee.role) === "member") {
    const recordAssignmentMatches =
      customer.assignedTenantUserId === assignee.id
      && (!quote || quote.assignedTenantUserId === assignee.id);
    if (!recordAssignmentMatches) {
      throw new ActivityTaskServiceError(
        409,
        "ACTIVITY_ASSIGNEE_RECORD_CONFLICT",
        "Assign the customer and quote to that member before assigning this task.",
      );
    }
  }

  return { customer, quote, assignee };
}

async function resolveReopenLinkedActivityRecords(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    customerId: string;
    quoteId?: string | null;
    assignedTenantUserId: string;
  },
): Promise<LinkedActivityRecords> {
  try {
    return await resolveLinkedActivityRecords(transaction, access, input);
  } catch (error) {
    const canRepairAssignment =
      hasCapability(access, "manageAssignments")
      && error instanceof ActivityTaskServiceError
      && (error.code === "ACTIVITY_RELATION_NOT_FOUND"
        || error.code === "ACTIVITY_ASSIGNEE_RECORD_CONFLICT");
    if (!canRepairAssignment) throw error;
  }

  const customer = await transaction.customer.findFirst({
    where: {
      id: input.customerId,
      tenantId: access.tenantId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
    select: { assignedTenantUserId: true },
  });
  const quote = input.quoteId
    ? await transaction.quote.findFirst({
        where: {
          id: input.quoteId,
          tenantId: access.tenantId,
          customerId: input.customerId,
          archivedAtUtc: null,
          deletedAtUtc: null,
        },
        select: { assignedTenantUserId: true },
      })
    : null;
  const replacementAssigneeId = customer?.assignedTenantUserId ?? null;
  const recordsShareAssignee =
    Boolean(replacementAssigneeId)
    && (!input.quoteId || quote?.assignedTenantUserId === replacementAssigneeId);
  if (!recordsShareAssignee || !replacementAssigneeId) {
    throw new ActivityTaskServiceError(
      409,
      "ACTIVITY_ASSIGNEE_RECORD_CONFLICT",
      "Assign the customer and linked quote to the same active team member before reopening this task.",
    );
  }

  try {
    return await resolveLinkedActivityRecords(transaction, access, {
      ...input,
      assignedTenantUserId: replacementAssigneeId,
    });
  } catch (error) {
    if (
      error instanceof ActivityTaskServiceError
      && (error.code === "ACTIVITY_RELATION_NOT_FOUND"
        || error.code === "ACTIVITY_ASSIGNEE_RECORD_CONFLICT")
    ) {
      throw new ActivityTaskServiceError(
        409,
        "ACTIVITY_ASSIGNEE_RECORD_CONFLICT",
        "Assign the customer and linked quote to the same active team member before reopening this task.",
      );
    }
    throw error;
  }
}

async function findCommandReplay(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  hashes: ReturnType<typeof commandHashes>,
  options: { allowDeleted?: boolean } = {},
): Promise<ActivityTaskReplay | null> {
  const event = await transaction.activityTaskEvent.findUnique({
    where: {
      tenantId_commandKeyHash: {
        tenantId: access.tenantId,
        commandKeyHash: hashes.commandKeyHash,
      },
    },
    select: {
      commandPayloadHash: true,
      activityTaskId: true,
    },
  });
  if (!event) return null;
  if (event.commandPayloadHash !== hashes.commandPayloadHash) {
    throw new ActivityTaskServiceError(
      409,
      "ACTIVITY_IDEMPOTENCY_CONFLICT",
      "That request key was already used for different task data.",
    );
  }
  const task = await transaction.activityTask.findFirst({
    where: options.allowDeleted
      ? { id: event.activityTaskId, tenantId: access.tenantId }
      : { id: event.activityTaskId, ...visibleActivityTaskWhere(access) },
    select: ActivityTaskPublicSelect,
  });
  if (!task) {
    throw new ActivityTaskServiceError(404, "ACTIVITY_NOT_FOUND", "Activity task not found.");
  }
  return { task, duplicate: true };
}

async function prepareCommand(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  command: ActivityTaskCommand,
  options: { allowDeleted?: boolean } = {},
) {
  const hashes = commandHashes(access, command);
  await lockCommand(transaction, hashes.commandKeyHash);
  const replay = await findCommandReplay(transaction, access, hashes, options);
  return { hashes, replay };
}

async function recordTaskEvent(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  command: ActivityTaskCommand,
  hashes: ReturnType<typeof commandHashes>,
  input: {
    task: ActivityTaskPublic;
    type: ActivityTaskEventType;
    fromStatus?: ActivityTaskStatus | null;
    toStatus?: ActivityTaskStatus | null;
    actor: ActivityActor;
  },
) {
  await transaction.activityTaskEvent.create({
    data: {
      tenantId: access.tenantId,
      activityTaskId: input.task.id,
      actorTenantUserId: access.tenantUserId,
      actorKind: "USER",
      type: input.type,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      requestId: command.requestId.slice(0, 191),
      commandKeyHash: hashes.commandKeyHash,
      commandPayloadHash: hashes.commandPayloadHash,
    },
  });

  const activityCopy: Record<ActivityTaskEventType, { title: string; detail: string }> = {
    CREATED: { title: "Activity task created", detail: `Created a ${input.task.type.toLowerCase().replaceAll("_", " ")} task.` },
    UPDATED: { title: "Activity task updated", detail: "Task assignment, timing, priority, type, or progress was updated." },
    COMPLETED: { title: "Activity task completed", detail: "The assigned task was completed." },
    REOPENED: { title: "Activity task reopened", detail: "The assigned task was reopened." },
    CANCELED: { title: "Activity task canceled", detail: "The assigned task was canceled." },
    DELETED: { title: "Activity task removed", detail: "The assigned task was removed from the active workspace." },
  };
  const copy = activityCopy[input.type];
  await createCustomerActivityEvent(transaction, {
    tenantId: access.tenantId,
    customerId: input.task.customerId,
    actor: input.actor,
    eventType: `ACTIVITY_TASK_${input.type}`,
    title: copy.title,
    detail: copy.detail,
  });
}

export async function listActivityTasks(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    mine: boolean;
    assignedTenantUserId?: string;
    status?: ActivityTaskStatus;
    statuses?: ActivityTaskStatus[];
    type?: ActivityTaskType;
    customerId?: string;
    quoteId?: string;
    search?: string;
    dueFromUtc?: Date;
    dueToUtc?: Date;
    limit: number;
    offset: number;
  },
) {
  const assignedTenantUserId = hasCapability(access, "viewAllWorkspaceRecords")
    ? input.mine
      ? access.tenantUserId
      : input.assignedTenantUserId
    : access.tenantUserId;
  const where: Prisma.ActivityTaskWhereInput = {
    ...visibleActivityTaskWhere(access),
    ...(assignedTenantUserId ? { assignedTenantUserId } : {}),
    ...(input.status
      ? { status: input.status }
      : input.statuses?.length
        ? { status: { in: input.statuses } }
        : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.quoteId ? { quoteId: input.quoteId } : {}),
    ...(input.dueFromUtc || input.dueToUtc
      ? {
          dueAtUtc: {
            ...(input.dueFromUtc ? { gte: input.dueFromUtc } : {}),
            ...(input.dueToUtc ? { lt: input.dueToUtc } : {}),
          },
        }
      : {}),
    ...(input.search
      ? {
          OR: [
            { title: { contains: input.search, mode: "insensitive" } },
            { customer: { fullName: { contains: input.search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    transaction.activityTask.findMany({
      where,
      orderBy: [{ dueAtUtc: "asc" }, { id: "asc" }],
      skip: input.offset,
      take: input.limit,
      select: ActivityTaskPublicSelect,
    }),
    transaction.activityTask.count({ where }),
  ]);
  return { items, total };
}

export async function summarizeActivityTasks(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  windows: {
    todayStartUtc: Date;
    tomorrowStartUtc: Date;
    upcomingEndUtc: Date;
    completedStartUtc: Date;
  },
  options: { mine: boolean },
) {
  const where = visibleActivityTaskWhere(access);
  const assignedWhere = !hasCapability(access, "viewAllWorkspaceRecords") || options.mine
    ? { assignedTenantUserId: access.tenantUserId }
    : {};
  const activeWhere: Prisma.ActivityTaskWhereInput = {
    ...where,
    ...assignedWhere,
    status: { in: ACTIVE_TASK_STATUSES },
  };
  const completedWhere: Prisma.ActivityTaskWhereInput = {
    ...where,
    ...assignedWhere,
    status: "COMPLETED",
    completedAtUtc: {
      gte: windows.completedStartUtc,
      lt: windows.tomorrowStartUtc,
    },
  };

  const [overdue, today, upcoming, completed, top] = await Promise.all([
    transaction.activityTask.count({
      where: { ...activeWhere, dueAtUtc: { lt: windows.todayStartUtc } },
    }),
    transaction.activityTask.count({
      where: {
        ...activeWhere,
        dueAtUtc: { gte: windows.todayStartUtc, lt: windows.tomorrowStartUtc },
      },
    }),
    transaction.activityTask.count({
      where: {
        ...activeWhere,
        dueAtUtc: { gte: windows.tomorrowStartUtc, lt: windows.upcomingEndUtc },
      },
    }),
    transaction.activityTask.count({ where: completedWhere }),
    transaction.activityTask.findMany({
      where: activeWhere,
      orderBy: [{ priority: "desc" }, { dueAtUtc: "asc" }, { id: "asc" }],
      take: 5,
      select: ActivityTaskPublicSelect,
    }),
  ]);

  return { overdue, today, upcoming, completed, top };
}

export type AssistantActivityTaskProjection = Readonly<{
  id: string;
  customerId: string;
  quoteId: string | null;
  version: number;
  type: ActivityTaskType;
  status: ActivityTaskStatus;
  priority: ActivityTaskPriority;
  title: string;
  dueAtUtc: Date;
  customer: { fullName: string };
  quote: { title: string } | null;
}>;

/**
 * Narrow AI-safe projection for Kody activity tools.
 *
 * This deliberately does not select task notes, customer phone/email,
 * assignee email, source keys, creator/completer IDs, tenant IDs, or any
 * internal authorization state. It must stay deterministic and provider-free.
 */
export async function summarizeAssistantActivityAgenda(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  windows: {
    todayStartUtc: Date;
    tomorrowStartUtc: Date;
    upcomingEndUtc: Date;
    completedStartUtc: Date;
  },
  options: {
    limit: number;
    prioritizeTodayOnly: boolean;
  },
) {
  const activeWhere: Prisma.ActivityTaskWhereInput = {
    ...visibleActivityTaskWhere(access),
    assignedTenantUserId: access.tenantUserId,
    status: { in: ACTIVE_TASK_STATUSES },
  };
  const prioritizedWhere: Prisma.ActivityTaskWhereInput = options.prioritizeTodayOnly
    ? { ...activeWhere, dueAtUtc: { lt: windows.tomorrowStartUtc } }
    : activeWhere;
  const completedWhere: Prisma.ActivityTaskWhereInput = {
    ...visibleActivityTaskWhere(access),
    assignedTenantUserId: access.tenantUserId,
    status: "COMPLETED",
    completedAtUtc: {
      gte: windows.completedStartUtc,
      lt: windows.tomorrowStartUtc,
    },
  };
  const assistantSelect = {
    id: true,
    customerId: true,
    quoteId: true,
    version: true,
    type: true,
    status: true,
    priority: true,
    title: true,
    dueAtUtc: true,
    customer: { select: { fullName: true } },
    quote: { select: { title: true } },
  } as const satisfies Prisma.ActivityTaskSelect;
  const listPrioritized = (where: Prisma.ActivityTaskWhereInput) =>
    transaction.activityTask.findMany({
      where,
      orderBy: [{ priority: "desc" }, { dueAtUtc: "asc" }, { id: "asc" }],
      take: options.limit + 1,
      select: assistantSelect,
    });
  const tasksPromise = options.prioritizeTodayOnly
    ? Promise.all([
        listPrioritized({ ...activeWhere, dueAtUtc: { lt: windows.todayStartUtc } }),
        listPrioritized({
          ...activeWhere,
          dueAtUtc: { gte: windows.todayStartUtc, lt: windows.tomorrowStartUtc },
        }),
      ]).then(([overdueTasks, todayTasks]) =>
        [...overdueTasks, ...todayTasks].slice(0, options.limit),
      )
    : transaction.activityTask.findMany({
        where: prioritizedWhere,
        orderBy: [{ dueAtUtc: "asc" }, { id: "asc" }],
        take: options.limit,
        select: assistantSelect,
      });

  const [overdue, today, upcoming, completed, activeTotal, matchingTotal, tasks] = await Promise.all([
    transaction.activityTask.count({
      where: { ...activeWhere, dueAtUtc: { lt: windows.todayStartUtc } },
    }),
    transaction.activityTask.count({
      where: {
        ...activeWhere,
        dueAtUtc: { gte: windows.todayStartUtc, lt: windows.tomorrowStartUtc },
      },
    }),
    transaction.activityTask.count({
      where: {
        ...activeWhere,
        dueAtUtc: { gte: windows.tomorrowStartUtc, lt: windows.upcomingEndUtc },
      },
    }),
    transaction.activityTask.count({ where: completedWhere }),
    transaction.activityTask.count({ where: activeWhere }),
    transaction.activityTask.count({ where: prioritizedWhere }),
    tasksPromise,
  ]);

  return {
    counts: { overdue, today, upcoming, completed },
    activeTotal,
    matchingTotal,
    tasks,
  };
}

export async function createActivityTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    customerId: string;
    quoteId?: string | null;
    assignedTenantUserId?: string;
    type: ActivityTaskType;
    priority: ActivityTaskPriority;
    title: string;
    notes?: string | null;
    dueAtUtc: Date;
    sourceKey?: string | null;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
): Promise<{ task: ActivityTaskPublic; duplicate: boolean }> {
  const { hashes, replay } = await prepareCommand(transaction, access, input.command);
  if (replay) return replay;

  const requestedAssignee = hasCapability(access, "manageAssignments")
    ? input.assignedTenantUserId ?? access.tenantUserId
    : access.tenantUserId;
  await resolveLinkedActivityRecords(transaction, access, {
    customerId: input.customerId,
    quoteId: input.quoteId,
    assignedTenantUserId: requestedAssignee,
  });

  const task = await transaction.activityTask.create({
    data: {
      tenantId: access.tenantId,
      customerId: input.customerId,
      quoteId: input.quoteId ?? null,
      assignedTenantUserId: requestedAssignee,
      createdByTenantUserId: access.tenantUserId,
      type: input.type,
      priority: input.priority,
      title: input.title.trim(),
      notes: input.notes?.trim() || null,
      dueAtUtc: input.dueAtUtc,
      sourceKey: input.sourceKey?.trim() || null,
    },
    select: ActivityTaskPublicSelect,
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.sourceKey) {
      throw new ActivityTaskServiceError(
        409,
        "ACTIVITY_SOURCE_ALREADY_EXISTS",
        "An active task already exists for that automated source.",
      );
    }
    throw error;
  });
  await recordTaskEvent(transaction, access, input.command, hashes, {
    task,
    type: "CREATED",
    fromStatus: null,
    toStatus: task.status,
    actor: input.actor,
  });
  return { task, duplicate: false };
}

async function getMutableTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  taskId: string,
): Promise<ActivityTaskPublic> {
  const task = await transaction.activityTask.findFirst({
    where: { id: taskId, ...visibleActivityTaskWhere(access) },
    select: ActivityTaskPublicSelect,
  });
  if (!task) {
    throw new ActivityTaskServiceError(404, "ACTIVITY_NOT_FOUND", "Activity task not found.");
  }
  return task;
}

async function updateTaskWithCommand(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    taskId: string;
    version: number;
    data: Prisma.ActivityTaskUncheckedUpdateManyInput;
    eventType: ActivityTaskEventType;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
) {
  const hashes = commandHashes(access, input.command);
  await lockCommand(transaction, hashes.commandKeyHash);
  const replay = await findCommandReplay(transaction, access, hashes);
  if (replay) return replay;

  const existing = await getMutableTask(transaction, access, input.taskId);
  if (existing.version !== input.version) {
    throw new ActivityTaskServiceError(
      409,
      "ACTIVITY_STALE_VERSION",
      "This task changed since you opened it. Refresh before saving again.",
      { currentVersion: existing.version },
    );
  }

  const result = await transaction.activityTask.updateMany({
    where: {
      id: existing.id,
      ...visibleActivityTaskWhere(access),
      version: input.version,
    },
    data: {
      ...input.data,
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) {
    throw new ActivityTaskServiceError(
      409,
      "ACTIVITY_STALE_VERSION",
      "This task changed since you opened it. Refresh before saving again.",
    );
  }

  const task = await transaction.activityTask.findUniqueOrThrow({
    where: { id_tenantId: { id: existing.id, tenantId: access.tenantId } },
    select: ActivityTaskPublicSelect,
  });
  await recordTaskEvent(transaction, access, input.command, hashes, {
    task,
    type: input.eventType,
    fromStatus: existing.status,
    toStatus: task.status,
    actor: input.actor,
  });
  return { task, duplicate: false };
}

export async function updateActivityTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    taskId: string;
    version: number;
    assignedTenantUserId?: string;
    type?: ActivityTaskType;
    priority?: ActivityTaskPriority;
    status?: Extract<ActivityTaskStatus, "OPEN" | "IN_PROGRESS" | "CANCELED">;
    title?: string;
    notes?: string | null;
    dueAtUtc?: Date;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
) {
  const prepared = await prepareCommand(transaction, access, input.command);
  if (prepared.replay) return prepared.replay;
  const existing = await getMutableTask(transaction, access, input.taskId);
  if (existing.status === "COMPLETED" || existing.status === "CANCELED") {
    throw new ActivityTaskServiceError(409, "ACTIVITY_REOPEN_REQUIRED", "Reopen this task before editing it.");
  }
  if (existing.origin === "AUTOMATED_CUSTOMER_FOLLOW_UP") {
    throw new ActivityTaskServiceError(
      409,
      "FOLLOW_UP_TASK_IMMUTABLE",
      "Automatic customer follow-up tasks cannot be edited. Complete the task with an explicit outcome instead.",
    );
  }
  if (input.status === "CANCELED" && !hasCapability(access, "manageAssignments")) {
    throw new ActivityTaskServiceError(403, "ACTIVITY_CANCEL_FORBIDDEN", "Only workspace owners and admins can cancel tasks.");
  }
  if (input.assignedTenantUserId && !hasCapability(access, "manageAssignments")) {
    throw new ActivityTaskServiceError(403, "ACTIVITY_ASSIGN_FORBIDDEN", "Only workspace owners and admins can reassign tasks.");
  }

  const nextAssignee = input.assignedTenantUserId ?? existing.assignedTenantUserId;
  if (input.assignedTenantUserId) {
    await resolveLinkedActivityRecords(transaction, access, {
      customerId: existing.customerId,
      quoteId: existing.quoteId,
      assignedTenantUserId: nextAssignee,
    });
  }
  const canceled = input.status === "CANCELED";
  return updateTaskWithCommand(transaction, access, {
    taskId: existing.id,
    version: input.version,
    data: {
      ...(input.assignedTenantUserId ? { assignedTenantUserId: nextAssignee } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      ...(input.dueAtUtc ? { dueAtUtc: input.dueAtUtc } : {}),
      ...(canceled ? { canceledAtUtc: new Date() } : {}),
    },
    eventType: canceled ? "CANCELED" : "UPDATED",
    actor: input.actor,
    command: input.command,
  });
}

export async function completeActivityTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    taskId: string;
    version: number;
    outcome?: FollowUpOutcome;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
) {
  const prepared = await prepareCommand(transaction, access, input.command);
  if (prepared.replay) return prepared.replay;
  const existing = await getMutableTask(transaction, access, input.taskId);
  if (existing.version !== input.version) {
    throw new ActivityTaskServiceError(409, "ACTIVITY_STALE_VERSION", "This task changed since you opened it. Refresh before saving again.");
  }
  if (existing.status === "COMPLETED") {
    throw new ActivityTaskServiceError(409, "ACTIVITY_ALREADY_COMPLETED", "This task is already completed.");
  }
  if (existing.status === "CANCELED") {
    throw new ActivityTaskServiceError(409, "ACTIVITY_REOPEN_REQUIRED", "Reopen this task before completing it.");
  }
  const automated = existing.origin === "AUTOMATED_CUSTOMER_FOLLOW_UP";
  if (automated && !input.outcome) {
    throw new ActivityTaskServiceError(
      422,
      "FOLLOW_UP_OUTCOME_REQUIRED",
      "Choose contacted, no response, or skipped before completing an automatic follow-up.",
    );
  }
  if (!automated && input.outcome) {
    throw new ActivityTaskServiceError(
      422,
      "FOLLOW_UP_OUTCOME_NOT_APPLICABLE",
      "A follow-up outcome can only be recorded on an automatic customer follow-up.",
    );
  }
  if (
    automated
    && !await lockCustomerForAutomatedFollowUpCompletion(transaction, {
      tenantId: access.tenantId,
      customerId: existing.customerId,
    })
  ) {
    throw new ActivityTaskServiceError(
      409,
      "FOLLOW_UP_CUSTOMER_TERMINAL",
      "This customer is won or lost, so the automatic follow-up can no longer be completed.",
    );
  }
  const occurredAtUtc = new Date();
  const result = await updateTaskWithCommand(transaction, access, {
    taskId: existing.id,
    version: input.version,
    data: {
      status: "COMPLETED",
      completedAtUtc: occurredAtUtc,
      completedByTenantUserId: access.tenantUserId,
      canceledAtUtc: null,
      ...(automated ? { followUpOutcome: input.outcome } : {}),
    },
    eventType: "COMPLETED",
    actor: input.actor,
    command: input.command,
  });
  if (
    automated
    && input.outcome
    && existing.followUpSequenceId
    && existing.followUpStepNumber
    && !result.duplicate
  ) {
    await applyAutomatedFollowUpOutcome(transaction, {
      tenantId: access.tenantId,
      customerId: existing.customerId,
      taskId: existing.id,
      sequenceId: existing.followUpSequenceId,
      stepNumber: existing.followUpStepNumber,
      outcome: input.outcome,
      occurredAtUtc,
    });
  }
  return result;
}

export async function reopenActivityTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    taskId: string;
    version: number;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
) {
  const prepared = await prepareCommand(transaction, access, input.command);
  if (prepared.replay) return prepared.replay;
  const existing = await getMutableTask(transaction, access, input.taskId);
  if (existing.version !== input.version) {
    throw new ActivityTaskServiceError(409, "ACTIVITY_STALE_VERSION", "This task changed since you opened it. Refresh before saving again.");
  }
  if (existing.status === "OPEN") {
    throw new ActivityTaskServiceError(409, "ACTIVITY_ALREADY_OPEN", "This task is already open.");
  }
  if (existing.status === "IN_PROGRESS") {
    throw new ActivityTaskServiceError(409, "ACTIVITY_ALREADY_ACTIVE", "This task is already in progress.");
  }
  if (existing.origin === "AUTOMATED_CUSTOMER_FOLLOW_UP") {
    throw new ActivityTaskServiceError(
      409,
      "FOLLOW_UP_REOPEN_FORBIDDEN",
      "Automatic follow-up outcomes are immutable. Create a new manual task if more work is needed.",
    );
  }
  if (existing.status === "CANCELED" && !hasCapability(access, "manageAssignments")) {
    throw new ActivityTaskServiceError(403, "ACTIVITY_REOPEN_FORBIDDEN", "Only workspace owners and admins can reopen canceled tasks.");
  }
  const linkedRecords = await resolveReopenLinkedActivityRecords(transaction, access, {
    customerId: existing.customerId,
    quoteId: existing.quoteId,
    assignedTenantUserId: existing.assignedTenantUserId,
  });
  return updateTaskWithCommand(transaction, access, {
    taskId: existing.id,
    version: input.version,
    data: {
      assignedTenantUserId: linkedRecords.assignee.id,
      status: "OPEN",
      completedAtUtc: null,
      completedByTenantUserId: null,
      canceledAtUtc: null,
    },
    eventType: "REOPENED",
    actor: input.actor,
    command: input.command,
  });
}

export async function deleteActivityTask(
  transaction: ActivityTaskTransaction,
  access: AccessContext,
  input: {
    taskId: string;
    version: number;
    actor: ActivityActor;
    command: ActivityTaskCommand;
  },
) {
  if (!hasCapability(access, "manageAssignments")) {
    throw new ActivityTaskServiceError(403, "ACTIVITY_DELETE_FORBIDDEN", "Only workspace owners and admins can remove tasks.");
  }
  const prepared = await prepareCommand(transaction, access, input.command, { allowDeleted: true });
  if (prepared.replay) return prepared.replay;
  const existing = await getMutableTask(transaction, access, input.taskId);
  if (existing.origin === "AUTOMATED_CUSTOMER_FOLLOW_UP") {
    throw new ActivityTaskServiceError(
      409,
      "FOLLOW_UP_DELETE_FORBIDDEN",
      "Automatic follow-up tasks cannot be removed. Complete the task with a follow-up outcome.",
    );
  }
  return updateTaskWithCommand(transaction, access, {
    taskId: input.taskId,
    version: input.version,
    data: { deletedAtUtc: new Date() },
    eventType: "DELETED",
    actor: input.actor,
    command: input.command,
  });
}
