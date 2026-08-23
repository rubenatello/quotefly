import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { measureRequestPerformance } from "../lib/request-performance";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  summarizeNotifications,
  type NotificationCursor,
  type NotificationPublic,
} from "../services/notification-outbox";

const NotificationParamsSchema = z.object({
  notificationId: z.string().trim().min(1).max(191),
}).strict();
const ListNotificationsQuerySchema = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
const EmptyBodySchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);

const NotificationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "appointmentId", "kind", "templateKey", "templateVersion", "sourceVersion",
    "startsAtUtc", "endsAtUtc", "timeZone", "deliveryStatus", "deliveredAtUtc",
    "readAtUtc", "version", "createdAt", "updatedAt", "job",
  ],
  properties: {
    id: { type: "string" },
    appointmentId: { type: "string" },
    kind: { type: "string", enum: ["BOOKED", "RESCHEDULED", "DISPATCHED", "ARRIVED", "COMPLETED", "CANCELED"] },
    templateKey: { type: "string" },
    templateVersion: { type: "integer", minimum: 1 },
    sourceVersion: { type: "integer", minimum: 1 },
    startsAtUtc: { type: "string", format: "date-time" },
    endsAtUtc: { type: "string", format: "date-time" },
    timeZone: { type: "string" },
    deliveryStatus: { type: "string", enum: ["AVAILABLE", "DELIVERED"] },
    deliveredAtUtc: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    readAtUtc: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    job: {
      type: "object",
      additionalProperties: false,
      required: ["id", "jobNumber", "title", "customer"],
      properties: {
        id: { type: "string" },
        jobNumber: { type: "integer", minimum: 1 },
        title: { type: "string" },
        customer: {
          type: "object",
          additionalProperties: false,
          required: ["id", "fullName"],
          properties: { id: { type: "string" }, fullName: { type: "string" } },
        },
      },
    },
  },
} as const;

function encodeCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify({
    createdAtUtc: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): NotificationCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = z.object({
      createdAtUtc: z.string().datetime({ offset: true }),
      id: z.string().trim().min(1).max(191),
    }).strict().parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { createdAt: new Date(parsed.createdAtUtc), id: parsed.id };
  } catch {
    throw new z.ZodError([{
      code: "custom",
      path: ["cursor"],
      message: "Notification cursor is invalid.",
    }]);
  }
}

function serializeNotification(notification: NotificationPublic) {
  return {
    ...notification,
    startsAtUtc: notification.startsAtUtc.toISOString(),
    endsAtUtc: notification.endsAtUtc.toISOString(),
    deliveredAtUtc: notification.deliveredAtUtc?.toISOString() ?? null,
    readAtUtc: notification.readAtUtc?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/notifications", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Notifications"],
      summary: "List the authenticated member's visible in-app notifications",
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          filter: { type: "string", enum: ["all", "unread"], default: "all" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          cursor: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["items", "page"],
          properties: {
            items: { type: "array", items: NotificationResponseSchema },
            page: {
              type: "object",
              additionalProperties: false,
              required: ["limit", "hasMore", "nextCursor"],
              properties: {
                limit: { type: "integer" },
                hasMore: { type: "boolean" },
                nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const access = buildAccessContext(request);
    const query = ListNotificationsQuerySchema.parse(request.query);
    const cursor = decodeCursor(query.cursor);
    const result = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        listNotifications(transaction, access, {
          unreadOnly: query.filter === "unread",
          limit: query.limit,
          cursor,
        }),
      { maxWait: 5_000, timeout: 15_000 }),
    );
    const last = result.items.at(-1);
    return {
      items: result.items.map(serializeNotification),
      page: {
        limit: query.limit,
        hasMore: result.hasMore,
        nextCursor: result.hasMore && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      },
    };
  });

  app.get("/notifications/summary", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Notifications"],
      summary: "Summarize visible notifications for the authenticated member",
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["unreadCount", "totalCount", "latestCreatedAtUtc"],
          properties: {
            unreadCount: { type: "integer", minimum: 0 },
            totalCount: { type: "integer", minimum: 0 },
            latestCreatedAtUtc: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const access = buildAccessContext(request);
    const summary = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        summarizeNotifications(transaction, access),
      { maxWait: 5_000, timeout: 15_000 }),
    );
    return {
      ...summary,
      latestCreatedAtUtc: summary.latestCreatedAtUtc?.toISOString() ?? null,
    };
  });

  app.post("/notifications/read-all", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Notifications"],
      summary: "Mark visible notifications read through a server cutoff",
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["updatedCount", "cutoffAtUtc"],
          properties: {
            updatedCount: { type: "integer", minimum: 0 },
            cutoffAtUtc: { type: "string", format: "date-time" },
          },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    EmptyBodySchema.parse(request.body);
    const access = buildAccessContext(request);
    const result = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        markAllNotificationsRead(transaction, access),
      { maxWait: 5_000, timeout: 15_000 }),
    );
    return {
      updatedCount: result.updatedCount,
      cutoffAtUtc: result.cutoffAtUtc.toISOString(),
    };
  });

  app.post("/notifications/:notificationId/read", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Notifications"],
      summary: "Idempotently mark one visible recipient notification read",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["notificationId"],
        properties: { notificationId: { type: "string", minLength: 1, maxLength: 191 } },
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["notification"],
          properties: { notification: NotificationResponseSchema },
        },
        404: {
          type: "object",
          additionalProperties: false,
          required: ["error", "code"],
          properties: { error: { type: "string" }, code: { type: "string", enum: ["NOTIFICATION_NOT_FOUND"] } },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    EmptyBodySchema.parse(request.body);
    const access = buildAccessContext(request);
    const { notificationId } = NotificationParamsSchema.parse(request.params);
    const notification = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        markNotificationRead(transaction, access, notificationId),
      { maxWait: 5_000, timeout: 15_000 }),
    );
    if (!notification) {
      return reply.code(404).send({ error: "Notification not found.", code: "NOTIFICATION_NOT_FOUND" });
    }
    return { notification: serializeNotification(notification) };
  });
};
