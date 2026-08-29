import { createHash } from "node:crypto";
import {
  ActivityTaskPriority,
  FollowUpOutcome,
  Prisma,
  type CustomerFollowUpSequenceStatus,
} from "@prisma/client";
import { enqueueAiIndexJob } from "../lib/ai-index-jobs";

export type FollowUpTransaction = Prisma.TransactionClient;

export const DEFAULT_FOLLOW_UP_STEPS = [
  { stepNumber: 1, delayMinutes: 15, title: "Welcome and confirm the request", notes: "Confirm what the customer needs and the best next step.", priority: "HIGH" },
  { stepNumber: 2, delayMinutes: 24 * 60, title: "Follow up on the request", notes: "Check whether the customer has questions or is ready for a quote.", priority: "NORMAL" },
  { stepNumber: 3, delayMinutes: 3 * 24 * 60, title: "Keep the conversation moving", notes: "Offer a clear next action and confirm timing.", priority: "NORMAL" },
  { stepNumber: 4, delayMinutes: 7 * 24 * 60, title: "Final follow-up review", notes: "Make one final contact attempt or decide the appropriate next action.", priority: "HIGH" },
] as const satisfies ReadonlyArray<{
  stepNumber: number;
  delayMinutes: number;
  title: string;
  notes: string;
  priority: ActivityTaskPriority;
}>;

export class CustomerFollowUpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export type FollowUpSettingsStep = Readonly<{
  stepNumber: number;
  delayMinutes: number;
  title: string;
  notes: string | null;
  priority: ActivityTaskPriority;
}>;

export type FollowUpSettings = Readonly<{
  enabled: boolean;
  version: number;
  updatedAtUtc: Date;
  steps: readonly FollowUpSettingsStep[];
}>;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function lockTenantTemplate(transaction: FollowUpTransaction, tenantId: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`follow-up-template:${tenantId}`}, 0))) acquired
  `);
}

async function currentTemplate(transaction: FollowUpTransaction, tenantId: string) {
  return transaction.followUpTemplate.findFirst({
    where: { tenantId, isDefault: true, retiredAtUtc: null },
    orderBy: [{ version: "desc" }, { id: "desc" }],
    include: { steps: { orderBy: [{ stepNumber: "asc" }, { id: "asc" }] } },
  });
}

function projectTemplate(template: NonNullable<Awaited<ReturnType<typeof currentTemplate>>>): FollowUpSettings {
  return {
    enabled: template.enabled,
    version: template.version,
    updatedAtUtc: template.updatedAt,
    steps: template.steps.map((step) => ({
      stepNumber: step.stepNumber,
      delayMinutes: step.delayMinutes,
      title: step.title,
      notes: step.notes,
      priority: step.priority,
    })),
  };
}

export async function getFollowUpSettings(
  transaction: FollowUpTransaction,
  tenantId: string,
): Promise<FollowUpSettings> {
  const template = await currentTemplate(transaction, tenantId);
  if (template) return projectTemplate(template);
  return {
    enabled: true,
    version: 0,
    updatedAtUtc: new Date(0),
    steps: DEFAULT_FOLLOW_UP_STEPS.map((step) => ({ ...step })),
  };
}

async function createTemplateVersion(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    version: number;
    enabled: boolean;
    steps: readonly FollowUpSettingsStep[];
  },
) {
  const template = await transaction.followUpTemplate.create({
    data: {
      tenantId: input.tenantId,
      version: input.version,
      enabled: input.enabled,
      isDefault: true,
    },
    select: { id: true },
  });
  await transaction.followUpTemplateStep.createMany({
    data: input.steps.map((step) => ({
      tenantId: input.tenantId,
      templateId: template.id,
      stepNumber: step.stepNumber,
      delayMinutes: step.delayMinutes,
      title: step.title.trim(),
      notes: step.notes?.trim() || null,
      priority: step.priority,
    })),
  });
  return transaction.followUpTemplate.findUniqueOrThrow({
    where: { id_tenantId: { id: template.id, tenantId: input.tenantId } },
    include: { steps: { orderBy: [{ stepNumber: "asc" }, { id: "asc" }] } },
  });
}

export async function updateFollowUpSettings(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    expectedVersion: number;
    enabled?: boolean;
    steps?: readonly FollowUpSettingsStep[];
  },
): Promise<FollowUpSettings> {
  await lockTenantTemplate(transaction, input.tenantId);
  const existing = await currentTemplate(transaction, input.tenantId);
  const currentVersion = existing?.version ?? 0;
  if (input.expectedVersion !== currentVersion) {
    throw new CustomerFollowUpError(
      409,
      "FOLLOW_UP_SETTINGS_STALE_VERSION",
      "Follow-up settings changed since you opened them. Refresh before saving again.",
      { currentVersion },
    );
  }
  const previous = existing ? projectTemplate(existing) : await getFollowUpSettings(transaction, input.tenantId);
  if (existing) {
    await transaction.followUpTemplate.update({
      where: { id_tenantId: { id: existing.id, tenantId: input.tenantId } },
      data: { isDefault: false, retiredAtUtc: new Date() },
    });
  }
  const created = await createTemplateVersion(transaction, {
    tenantId: input.tenantId,
    version: currentVersion + 1,
    enabled: input.enabled ?? previous.enabled,
    steps: input.steps ?? previous.steps,
  });
  return projectTemplate(created);
}

async function ensureDefaultTemplate(transaction: FollowUpTransaction, tenantId: string) {
  await lockTenantTemplate(transaction, tenantId);
  const existing = await currentTemplate(transaction, tenantId);
  if (existing) return existing;
  return createTemplateVersion(transaction, {
    tenantId,
    version: 1,
    enabled: true,
    steps: DEFAULT_FOLLOW_UP_STEPS.map((step) => ({ ...step })),
  });
}

async function resolveScheduleAssignee(
  transaction: FollowUpTransaction,
  tenantId: string,
  requestedTenantUserId?: string | null,
) {
  if (requestedTenantUserId) {
    const requested = await transaction.tenantUser.findFirst({
      where: {
        id: requestedTenantUserId,
        tenantId,
        deletedAtUtc: null,
        user: { deletedAtUtc: null },
      },
      select: { id: true },
    });
    if (requested) return requested.id;
  }
  const fallback = await transaction.tenantUser.findFirst({
    where: {
      tenantId,
      role: { in: ["owner", "admin"] },
      deletedAtUtc: null,
      user: { deletedAtUtc: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!fallback) {
    throw new CustomerFollowUpError(
      409,
      "FOLLOW_UP_ASSIGNEE_UNAVAILABLE",
      "An active workspace member is required before a follow-up schedule can be created.",
    );
  }
  return fallback.id;
}

async function createSystemTaskEvent(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    taskId: string;
    type: "CREATED" | "CANCELED";
    fromStatus: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELED" | null;
    toStatus: "OPEN" | "CANCELED";
    source: string;
  },
) {
  const commandKeyHash = hash(`${input.tenantId}:${input.taskId}:${input.type}:${input.source}`);
  await transaction.activityTaskEvent.create({
    data: {
      tenantId: input.tenantId,
      activityTaskId: input.taskId,
      actorTenantUserId: null,
      actorKind: "SYSTEM",
      type: input.type,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      requestId: input.source.slice(0, 191),
      commandKeyHash,
      commandPayloadHash: hash(`${input.taskId}:${input.fromStatus ?? "none"}:${input.toStatus}`),
    },
  });
}

export async function seedCustomerFollowUpSchedule(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string | null;
    createdByTenantUserId?: string | null;
    startedAtUtc?: Date;
  },
) {
  const template = await ensureDefaultTemplate(transaction, input.tenantId);
  if (!template.enabled || template.steps.length === 0) return null;

  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`customer-follow-up:${input.tenantId}:${input.customerId}`}, 0))) acquired
  `);
  const customer = await transaction.customer.findFirst({
    where: {
      id: input.customerId,
      tenantId: input.tenantId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
    select: { id: true, createdAt: true, assignedTenantUserId: true, followUpStatus: true },
  });
  if (!customer) {
    throw new CustomerFollowUpError(404, "FOLLOW_UP_CUSTOMER_NOT_FOUND", "Customer not found for follow-up scheduling.");
  }
  if (isTerminalCustomerFollowUpStatus(customer.followUpStatus)) {
    throw new CustomerFollowUpError(
      409,
      "FOLLOW_UP_CUSTOMER_TERMINAL",
      "Won or lost customers must be reopened before a follow-up schedule can be created.",
    );
  }
  const existing = await transaction.customerFollowUpSequence.findFirst({
    where: { tenantId: input.tenantId, customerId: input.customerId, status: "ACTIVE" },
    include: { tasks: { orderBy: [{ followUpStepNumber: "asc" }] } },
  });
  if (existing) return existing;
  const assigneeId = await resolveScheduleAssignee(
    transaction,
    input.tenantId,
    input.assignedTenantUserId ?? customer.assignedTenantUserId,
  );
  const startedAtUtc = input.startedAtUtc ?? customer.createdAt;
  const sequence = await transaction.customerFollowUpSequence.create({
    data: {
      tenantId: input.tenantId,
      customerId: customer.id,
      templateId: template.id,
      templateVersion: template.version,
      startedAtUtc,
    },
  });

  for (const step of template.steps) {
    const task = await transaction.activityTask.create({
      data: {
        tenantId: input.tenantId,
        customerId: customer.id,
        assignedTenantUserId: assigneeId,
        createdByTenantUserId: input.createdByTenantUserId ?? null,
        type: "FOLLOW_UP",
        priority: step.priority,
        origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
        followUpSequenceId: sequence.id,
        followUpStepNumber: step.stepNumber,
        title: step.title,
        notes: step.notes,
        dueAtUtc: new Date(startedAtUtc.getTime() + step.delayMinutes * 60_000),
        sourceKey: `customer-follow-up:${customer.id}:${sequence.id}:${step.stepNumber}`,
      },
      select: { id: true },
    });
    await createSystemTaskEvent(transaction, {
      tenantId: input.tenantId,
      taskId: task.id,
      type: "CREATED",
      fromStatus: null,
      toStatus: "OPEN",
      source: `follow-up-seed:${sequence.id}:${step.stepNumber}`,
    });
  }

  return transaction.customerFollowUpSequence.findUniqueOrThrow({
    where: { id_tenantId: { id: sequence.id, tenantId: input.tenantId } },
    include: { tasks: { orderBy: [{ followUpStepNumber: "asc" }] } },
  });
}

export async function cancelAutomatedCustomerFollowUps(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    customerId: string;
    reason: string;
    occurredAtUtc?: Date;
  },
) {
  const now = input.occurredAtUtc ?? new Date();
  const tasks = await transaction.activityTask.findMany({
    where: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
      status: { in: ["OPEN", "IN_PROGRESS"] },
      deletedAtUtc: null,
    },
    select: { id: true, status: true },
  });
  for (const task of tasks) {
    await transaction.activityTask.update({
      where: { id_tenantId: { id: task.id, tenantId: input.tenantId } },
      data: { status: "CANCELED", canceledAtUtc: now, version: { increment: 1 } },
    });
    await createSystemTaskEvent(transaction, {
      tenantId: input.tenantId,
      taskId: task.id,
      type: "CANCELED",
      fromStatus: task.status,
      toStatus: "CANCELED",
      source: `follow-up-cancel:${input.reason}:${now.toISOString()}`,
    });
  }
  await transaction.customerFollowUpSequence.updateMany({
    where: { tenantId: input.tenantId, customerId: input.customerId, status: "ACTIVE" },
    data: {
      status: "CANCELED",
      canceledAtUtc: now,
      cancellationReason: input.reason.slice(0, 64),
    },
  });
  return { canceledTaskCount: tasks.length };
}

/**
 * Acquires the Customer lock before an automatic ActivityTask is completed.
 * This keeps the canonical Customer -> ActivityTask lock order used by loss,
 * archive, and sequence cancellation workflows.
 */
export async function lockCustomerForAutomatedFollowUpCompletion(
  transaction: FollowUpTransaction,
  input: { tenantId: string; customerId: string },
) {
  const [customer] = await transaction.$queryRaw<Array<{ followUpStatus: string }>>(Prisma.sql`
    SELECT customer."followUpStatus"::text AS "followUpStatus"
    FROM "Customer" customer
    WHERE customer."id" = ${input.customerId}
      AND customer."tenantId" = ${input.tenantId}
      AND customer."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
    FOR NO KEY UPDATE OF customer
  `);
  return Boolean(customer && !isTerminalCustomerFollowUpStatus(customer.followUpStatus));
}

export async function reassignOpenAutomatedCustomerFollowUps(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string | null;
  },
) {
  const assignedTenantUserId = await resolveScheduleAssignee(
    transaction,
    input.tenantId,
    input.assignedTenantUserId,
  );
  const result = await transaction.activityTask.updateMany({
    where: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      origin: "AUTOMATED_CUSTOMER_FOLLOW_UP",
      status: { in: ["OPEN", "IN_PROGRESS"] },
      deletedAtUtc: null,
    },
    data: { assignedTenantUserId, version: { increment: 1 } },
  });
  return { assignedTenantUserId, updatedTaskCount: result.count };
}

export async function applyAutomatedFollowUpOutcome(
  transaction: FollowUpTransaction,
  input: {
    tenantId: string;
    customerId: string;
    taskId: string;
    sequenceId: string;
    stepNumber: number;
    outcome: FollowUpOutcome;
    occurredAtUtc: Date;
  },
) {
  const sequence = await transaction.customerFollowUpSequence.findFirst({
    where: {
      id: input.sequenceId,
      tenantId: input.tenantId,
      customerId: input.customerId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!sequence) return;

  const currentCustomer = await transaction.customer.findFirst({
    where: {
      id: input.customerId,
      tenantId: input.tenantId,
      followUpStatus: { notIn: ["WON", "LOST"] },
    },
    select: { followUpStatus: true },
  });
  if (!currentCustomer) return;
  const nextFollowUpStatus = input.outcome === "CONTACTED"
    ? "FOLLOWED_UP"
    : input.outcome === "NO_RESPONSE"
      ? "NEEDS_FOLLOW_UP"
      : null;
  const statusChanged = Boolean(
    nextFollowUpStatus && currentCustomer.followUpStatus !== nextFollowUpStatus,
  );
  const updated = await transaction.customer.updateMany({
    where: {
      id: input.customerId,
      tenantId: input.tenantId,
      followUpStatus: currentCustomer.followUpStatus,
    },
    data: input.outcome === "CONTACTED"
      ? {
          followUpStatus: "FOLLOWED_UP",
          followUpUpdatedAtUtc: input.occurredAtUtc,
          lastFollowUpAttemptAtUtc: input.occurredAtUtc,
          lastSuccessfulContactAtUtc: input.occurredAtUtc,
          lifecycleVersion: statusChanged ? { increment: 1 } : undefined,
        }
      : input.outcome === "NO_RESPONSE"
        ? {
            followUpStatus: "NEEDS_FOLLOW_UP",
            followUpUpdatedAtUtc: input.occurredAtUtc,
            lastFollowUpAttemptAtUtc: input.occurredAtUtc,
            lifecycleVersion: statusChanged ? { increment: 1 } : undefined,
          }
        : { followUpUpdatedAtUtc: input.occurredAtUtc },
  });
  if (updated.count !== 1) return;
  const indexedCustomer = await transaction.customer.findUniqueOrThrow({
    where: { id_tenantId: { id: input.customerId, tenantId: input.tenantId } },
    select: { id: true, updatedAt: true },
  });
  await enqueueAiIndexJob(transaction, {
    tenantId: input.tenantId,
    sourceType: "Customer",
    sourceId: indexedCustomer.id,
    operation: "UPSERT",
    expectedSourceUpdatedAtUtc: indexedCustomer.updatedAt,
  });

  if (input.outcome === "CONTACTED") {
    await cancelAutomatedCustomerFollowUps(transaction, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      reason: "CONTACTED",
      occurredAtUtc: input.occurredAtUtc,
    });
    await transaction.customerFollowUpSequence.updateMany({
      where: { id: input.sequenceId, tenantId: input.tenantId },
      data: {
        status: "COMPLETED",
        completedAtUtc: input.occurredAtUtc,
        canceledAtUtc: null,
        cancellationReason: null,
      },
    });
    return;
  }

  const remaining = await transaction.activityTask.count({
    where: {
      tenantId: input.tenantId,
      followUpSequenceId: input.sequenceId,
      id: { not: input.taskId },
      status: { in: ["OPEN", "IN_PROGRESS"] },
      deletedAtUtc: null,
    },
  });
  if (remaining === 0) {
    await transaction.customerFollowUpSequence.update({
      where: { id_tenantId: { id: input.sequenceId, tenantId: input.tenantId } },
      data: { status: "COMPLETED", completedAtUtc: input.occurredAtUtc },
    });
  }
}

export function isTerminalCustomerFollowUpStatus(status: string | null | undefined) {
  return status === "WON" || status === "LOST";
}

export function isTerminalQuoteStatus(status: string | null | undefined) {
  return status === "ACCEPTED" || status === "REJECTED";
}

export type { CustomerFollowUpSequenceStatus };
