import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  ActivityTaskPriority,
  ActivityTaskStatus,
  ActivityTaskType,
  FollowUpOutcome,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { getJwtClaims } from "../lib/auth";
import { PaginationQuerySchema } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { tenantActivityWindows } from "../lib/tenant-time";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { withTransactionConflictRetry } from "../lib/transaction-retry";
import {
  ActivityTaskServiceError,
  completeActivityTask,
  createActivityTask,
  deleteActivityTask,
  listActivityTasks,
  reopenActivityTask,
  summarizeActivityTasks,
  updateActivityTask,
  type ActivityTaskPublic,
} from "../services/activity-tasks";
import {
  CustomerFollowUpError,
  getFollowUpSettings,
  updateFollowUpSettings,
} from "../services/customer-follow-up";

const ActivityTaskTypeSchema = z.nativeEnum(ActivityTaskType);
const ActivityTaskStatusSchema = z.nativeEnum(ActivityTaskStatus);
const ActivityTaskPrioritySchema = z.nativeEnum(ActivityTaskPriority);
const FollowUpOutcomeSchema = z.nativeEnum(FollowUpOutcome);
const ActivityTaskParamsSchema = z.object({ activityTaskId: z.string().trim().min(1).max(191) }).strict();
const ExplicitDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const BooleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");
const DueWindowSchema = z.enum(["active", "overdue", "today", "upcoming", "completed"]);
const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const ListActivityTasksQuerySchema = PaginationQuerySchema.extend({
  mine: BooleanQuerySchema.default(true),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  status: ActivityTaskStatusSchema.optional(),
  type: ActivityTaskTypeSchema.optional(),
  due: DueWindowSchema.optional(),
  customerId: z.string().trim().min(1).max(191).optional(),
  quoteId: z.string().trim().min(1).max(191).optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((query, context) => {
  if (query.status && query.due) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Use either status or a due-date view, not both.",
    });
  }
});

const SummaryQuerySchema = z.object({
  mine: BooleanQuerySchema.default(true),
}).strict();

const CreateActivityTaskSchema = z.object({
  customerId: z.string().trim().min(1).max(191),
  quoteId: z.string().trim().min(1).max(191).nullable().optional(),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  type: ActivityTaskTypeSchema,
  priority: ActivityTaskPrioritySchema.default("NORMAL"),
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2000).nullable().optional(),
  dueAtUtc: ExplicitDateTimeSchema,
}).strict();

const UpdateActivityTaskSchema = z.object({
  version: z.number().int().min(1),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  type: ActivityTaskTypeSchema.optional(),
  priority: ActivityTaskPrioritySchema.optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "CANCELED"]).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  dueAtUtc: ExplicitDateTimeSchema.optional(),
}).strict().refine(
  (payload) => Object.keys(payload).some((key) => key !== "version"),
  { message: "At least one task field must be updated." },
);

const VersionCommandSchema = z.object({
  version: z.number().int().min(1),
  outcome: FollowUpOutcomeSchema.optional(),
}).strict();

const FollowUpSettingsStepSchema = z.object({
  stepNumber: z.number().int().min(1).max(6),
  delayMinutes: z.number().int().min(5).max(43_200),
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2000).nullable(),
  priority: ActivityTaskPrioritySchema,
}).strict();

const UpdateFollowUpSettingsSchema = z.object({
  version: z.number().int().min(0),
  enabled: z.boolean().optional(),
  steps: z.array(FollowUpSettingsStepSchema).min(1).max(6).optional(),
}).strict().superRefine((payload, context) => {
  if (payload.enabled === undefined && payload.steps === undefined) {
    context.addIssue({ code: "custom", message: "Change enabled or provide follow-up steps." });
  }
  payload.steps?.forEach((step, index) => {
    if (step.stepNumber !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "stepNumber"],
        message: "Follow-up step numbers must be consecutive and start at 1.",
      });
    }
    if (index > 0 && step.delayMinutes <= payload.steps![index - 1]!.delayMinutes) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "delayMinutes"],
        message: "Each follow-up step must occur after the previous step.",
      });
    }
  });
});

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  return IdempotencyKeySchema.parse(Array.isArray(raw) ? raw[0] : raw);
}

function serializeTask(task: ActivityTaskPublic) {
  const { deletedAtUtc: _deletedAtUtc, ...safe } = task;
  return {
    ...safe,
    dueAtUtc: task.dueAtUtc.toISOString(),
    completedAtUtc: task.completedAtUtc?.toISOString() ?? null,
    canceledAtUtc: task.canceledAtUtc?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    quote: task.quote
      ? {
          ...task.quote,
          totalAmount: Number(task.quote.totalAmount),
        }
      : null,
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ActivityTaskServiceError)) throw error;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details ?? {}),
  });
}

function serializeFollowUpSettings(settings: Awaited<ReturnType<typeof getFollowUpSettings>>) {
  return { ...settings, updatedAtUtc: settings.updatedAtUtc.toISOString() };
}

async function loadTenantWindows(
  transaction: Prisma.TransactionClient,
  tenantId: string,
) {
  const tenant = await transaction.tenant.findFirst({
    where: { id: tenantId, deletedAtUtc: null },
    select: { timezone: true },
  });
  if (!tenant) {
    throw new ActivityTaskServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  }
  return tenantActivityWindows(new Date(), tenant.timezone);
}

export const activityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/follow-up-settings", { preHandler: [app.authenticate] }, async (request) => {
    const access = buildAccessContext(request);
    const settings = await withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
      getFollowUpSettings(transaction, access.tenantId));
    return { followUpSettings: serializeFollowUpSettings(settings) };
  });

  app.patch("/follow-up-settings", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageAssignments")) {
      return reply.code(403).send({
        code: "FOLLOW_UP_SETTINGS_FORBIDDEN",
        error: "Only workspace owners and admins can change automatic follow-up settings.",
      });
    }
    const payload = UpdateFollowUpSettingsSchema.parse(request.body);
    try {
      const settings = await withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        updateFollowUpSettings(transaction, {
          tenantId: access.tenantId,
          expectedVersion: payload.version,
          enabled: payload.enabled,
          steps: payload.steps,
        }));
      return { followUpSettings: serializeFollowUpSettings(settings) };
    } catch (error) {
      if (!(error instanceof CustomerFollowUpError)) throw error;
      return reply.code(error.statusCode).send({
        code: error.code,
        error: error.message,
        ...(error.details ?? {}),
      });
    }
  });

  app.get("/activities", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const query = ListActivityTasksQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, async (transaction) => {
          const effectiveDue = query.due ?? (query.status ? undefined : "active");
          const windows = effectiveDue && effectiveDue !== "active" && effectiveDue !== "completed"
            ? await loadTenantWindows(transaction, access.tenantId)
            : null;
          const dueFilter = effectiveDue === "active"
            ? { statuses: ["OPEN", "IN_PROGRESS"] as ActivityTaskStatus[] }
            : effectiveDue === "overdue"
            ? { statuses: ["OPEN", "IN_PROGRESS"] as ActivityTaskStatus[], dueToUtc: windows!.todayStartUtc }
            : effectiveDue === "today"
              ? {
                  statuses: ["OPEN", "IN_PROGRESS"] as ActivityTaskStatus[],
                  dueFromUtc: windows!.todayStartUtc,
                  dueToUtc: windows!.tomorrowStartUtc,
                }
              : effectiveDue === "upcoming"
                ? {
                    statuses: ["OPEN", "IN_PROGRESS"] as ActivityTaskStatus[],
                    dueFromUtc: windows!.tomorrowStartUtc,
                    dueToUtc: windows!.upcomingEndUtc,
                  }
                : effectiveDue === "completed"
                  ? { statuses: ["COMPLETED"] as ActivityTaskStatus[] }
                  : {};
          return listActivityTasks(transaction, access, {
            mine: query.mine,
            assignedTenantUserId: query.assignedTenantUserId,
            status: query.status,
            type: query.type,
            customerId: query.customerId,
            quoteId: query.quoteId,
            search: query.search,
            ...dueFilter,
            limit: query.limit,
            offset: query.offset,
          });
        }, { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeTask),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
        scope: {
          mine: !hasCapability(access, "viewAllWorkspaceRecords") || query.mine,
        },
      };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get("/activities/summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const query = SummaryQuerySchema.parse(request.query);
    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, async (transaction) => {
          const windows = await loadTenantWindows(transaction, access.tenantId);
          const summary = await summarizeActivityTasks(transaction, access, windows, { mine: query.mine });
          return { windows, summary };
        }, { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        generatedAtUtc: new Date().toISOString(),
        timezone: result.windows.timeZone,
        windows: {
          todayStartUtc: result.windows.todayStartUtc.toISOString(),
          tomorrowStartUtc: result.windows.tomorrowStartUtc.toISOString(),
          upcomingEndUtc: result.windows.upcomingEndUtc.toISOString(),
          completedStartUtc: result.windows.completedStartUtc.toISOString(),
        },
        counts: {
          overdue: result.summary.overdue,
          today: result.summary.today,
          upcoming: result.summary.upcoming,
          completed: result.summary.completed,
        },
        top: result.summary.top.map(serializeTask),
      };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post("/activities", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const claims = getJwtClaims(request);
    const payload = CreateActivityTaskSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);
    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          createActivityTask(transaction, access, {
            ...payload,
            actor,
            command: {
              operation: "CREATE",
              idempotencyKey: idempotencyKey(request),
              payload,
              requestId: request.id,
            },
          }),
        { maxWait: 5_000, timeout: 15_000 }),
      );
      return reply.code(result.duplicate ? 200 : 201).send({
        task: serializeTask(result.task),
        duplicate: result.duplicate,
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.patch("/activities/:activityTaskId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const claims = getJwtClaims(request);
    const { activityTaskId } = ActivityTaskParamsSchema.parse(request.params);
    const payload = UpdateActivityTaskSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);
    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          updateActivityTask(transaction, access, {
            taskId: activityTaskId,
            ...payload,
            actor,
            command: {
              operation: `UPDATE:${activityTaskId}`,
              idempotencyKey: idempotencyKey(request),
              payload,
              requestId: request.id,
            },
          }),
        { maxWait: 5_000, timeout: 15_000 }),
      );
      return { task: serializeTask(result.task), duplicate: result.duplicate };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post("/activities/:activityTaskId/complete", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const claims = getJwtClaims(request);
    const { activityTaskId } = ActivityTaskParamsSchema.parse(request.params);
    const payload = VersionCommandSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);
    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTransactionConflictRetry(() =>
          withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
            completeActivityTask(transaction, access, {
              taskId: activityTaskId,
              version: payload.version,
              outcome: payload.outcome,
              actor,
              command: {
                operation: `COMPLETE:${activityTaskId}`,
                idempotencyKey: idempotencyKey(request),
                payload,
                requestId: request.id,
              },
            }),
          { maxWait: 5_000, timeout: 15_000 }),
        ),
      );
      return { task: serializeTask(result.task), duplicate: result.duplicate };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post("/activities/:activityTaskId/reopen", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const claims = getJwtClaims(request);
    const { activityTaskId } = ActivityTaskParamsSchema.parse(request.params);
    const payload = VersionCommandSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);
    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          reopenActivityTask(transaction, access, {
            taskId: activityTaskId,
            version: payload.version,
            actor,
            command: {
              operation: `REOPEN:${activityTaskId}`,
              idempotencyKey: idempotencyKey(request),
              payload,
              requestId: request.id,
            },
          }),
        { maxWait: 5_000, timeout: 15_000 }),
      );
      return { task: serializeTask(result.task), duplicate: result.duplicate };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.delete("/activities/:activityTaskId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const claims = getJwtClaims(request);
    const { activityTaskId } = ActivityTaskParamsSchema.parse(request.params);
    const payload = VersionCommandSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);
    try {
      await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          deleteActivityTask(transaction, access, {
            taskId: activityTaskId,
            version: payload.version,
            actor,
            command: {
              operation: `DELETE:${activityTaskId}`,
              idempotencyKey: idempotencyKey(request),
              payload,
              requestId: request.id,
            },
          }),
        { maxWait: 5_000, timeout: 15_000 }),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });
};
