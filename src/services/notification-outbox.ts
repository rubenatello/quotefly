import { createHash, randomUUID } from "node:crypto";
import {
  NotificationDeliveryStatus,
  NotificationKind,
  Prisma,
} from "@prisma/client";
import {
  capabilitiesForRole,
  normalizeWorkspaceRole,
  type AccessContext,
} from "../lib/access-policy";
import { visibleJobWhere, type JobTransaction } from "./jobs";

const TEMPLATE_KEYS = Object.freeze({
  BOOKED: "job_appointment_booked",
  RESCHEDULED: "job_appointment_rescheduled",
  DISPATCHED: "job_appointment_dispatched",
  ARRIVED: "job_appointment_arrived",
  COMPLETED: "job_appointment_completed",
  CANCELED: "job_appointment_canceled",
} satisfies Record<NotificationKind, string>);

const NotificationPublicSelect = {
  id: true,
  appointmentId: true,
  kind: true,
  templateKey: true,
  templateVersion: true,
  sourceVersion: true,
  startsAtUtc: true,
  endsAtUtc: true,
  timeZone: true,
  deliveryStatus: true,
  deliveredAtUtc: true,
  readAtUtc: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  job: {
    select: {
      id: true,
      jobNumber: true,
      title: true,
      customer: { select: { id: true, fullName: true } },
    },
  },
} as const satisfies Prisma.NotificationOutboxSelect;

export type NotificationPublic = Prisma.NotificationOutboxGetPayload<{
  select: typeof NotificationPublicSelect;
}>;

export type NotificationCursor = Readonly<{ createdAt: Date; id: string }>;

type NotificationAppointmentSource = Readonly<{
  id: string;
  jobId: string;
  assignedTenantUserId: string;
  createdByTenantUserId: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  timeZone: string;
  version: number;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function notificationRecipientLockKey(tenantId: string, recipientTenantUserId: string): string {
  return `${tenantId}:notification-recipient:${recipientTenantUserId}`;
}

async function lockNotificationRecipients(
  transaction: JobTransaction,
  tenantId: string,
  recipientTenantUserIds: readonly string[],
): Promise<void> {
  const sortedRecipientIds = [...new Set(recipientTenantUserIds)].sort();
  for (const recipientTenantUserId of sortedRecipientIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT 1::int AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${notificationRecipientLockKey(tenantId, recipientTenantUserId)}, 0)
        )
      ) acquired
    `);
  }
}

/**
 * Adds content-minimal in-app rows inside the caller's appointment mutation
 * transaction. Recipient identities are derived only from authoritative
 * membership and appointment rows; no request or model output may select them.
 */
export async function enqueueAppointmentNotifications(
  transaction: JobTransaction,
  params: Readonly<{
    tenantId: string;
    actorTenantUserId: string;
    sourceJobEventId: string;
    kind: NotificationKind;
    appointment: NotificationAppointmentSource;
  }>,
): Promise<number> {
  const candidateRecipientIds = [...new Set([
    params.appointment.assignedTenantUserId,
    params.appointment.createdByTenantUserId,
  ])].filter((tenantUserId) => tenantUserId !== params.actorTenantUserId);

  if (candidateRecipientIds.length === 0) return 0;

  const activeRecipients = await transaction.tenantUser.findMany({
    where: {
      tenantId: params.tenantId,
      id: { in: candidateRecipientIds },
      deletedAtUtc: null,
      tenant: { deletedAtUtc: null },
      user: { deletedAtUtc: null },
    },
    select: { id: true, userId: true, role: true },
    orderBy: { id: "asc" },
  });

  const visibleRecipients: typeof activeRecipients = [];
  for (const recipient of activeRecipients) {
    const role = normalizeWorkspaceRole(recipient.role);
    const recipientAccess: AccessContext = Object.freeze({
      tenantId: params.tenantId,
      tenantUserId: recipient.id,
      userId: recipient.userId,
      role,
      capabilities: capabilitiesForRole(role),
      requestId: `notification-recipient:${params.sourceJobEventId}`,
    });
    const canSeeJob = await transaction.job.count({
      where: { id: params.appointment.jobId, ...visibleJobWhere(recipientAccess) },
    });
    if (canSeeJob === 1) visibleRecipients.push(recipient);
  }

  // Appointment mutations already own their Job schedule and assignee locks.
  // Notification locks are the final lock tier, acquired in recipient-id order;
  // enqueue performs no later Job/assignee lock acquisition that could cycle.
  await lockNotificationRecipients(
    transaction,
    params.tenantId,
    visibleRecipients.map((recipient) => recipient.id),
  );

  const templateKey = TEMPLATE_KEYS[params.kind];
  const result = await transaction.notificationOutbox.createMany({
    data: visibleRecipients.map(({ id: recipientTenantUserId }) => {
      const dedupeKeyHash = sha256([
        "notification-outbox-v1",
        params.tenantId,
        params.appointment.id,
        String(params.appointment.version),
        params.kind,
        recipientTenantUserId,
      ].join(":"));
      const payloadHash = sha256(JSON.stringify({
        appointmentId: params.appointment.id,
        jobId: params.appointment.jobId,
        kind: params.kind,
        sourceVersion: params.appointment.version,
        startsAtUtc: params.appointment.startsAtUtc.toISOString(),
        endsAtUtc: params.appointment.endsAtUtc.toISOString(),
        timeZone: params.appointment.timeZone,
      }));
      return {
        id: randomUUID(),
        tenantId: params.tenantId,
        recipientTenantUserId,
        actorTenantUserId: params.actorTenantUserId,
        jobId: params.appointment.jobId,
        appointmentId: params.appointment.id,
        sourceJobEventId: params.sourceJobEventId,
        kind: params.kind,
        channel: "IN_APP",
        templateKey,
        templateVersion: 1,
        sourceVersion: params.appointment.version,
        startsAtUtc: params.appointment.startsAtUtc,
        endsAtUtc: params.appointment.endsAtUtc,
        timeZone: params.appointment.timeZone,
        dedupeKeyHash,
        payloadHash,
      };
    }),
    skipDuplicates: true,
  });
  return result.count;
}

function recipientVisibleWhere(
  access: AccessContext,
  options: { unreadOnly?: boolean; cursor?: NotificationCursor; cutoffAtUtc?: Date } = {},
): Prisma.NotificationOutboxWhereInput {
  return {
    tenantId: access.tenantId,
    recipientTenantUserId: access.tenantUserId,
    archivedAtUtc: null,
    ...(options.unreadOnly ? { readAtUtc: null } : {}),
    ...(options.cutoffAtUtc ? { createdAt: { lte: options.cutoffAtUtc } } : {}),
    ...(options.cursor ? {
      OR: [
        { createdAt: { lt: options.cursor.createdAt } },
        { createdAt: options.cursor.createdAt, id: { lt: options.cursor.id } },
      ],
    } : {}),
    job: visibleJobWhere(access),
  };
}

export async function listNotifications(
  transaction: JobTransaction,
  access: AccessContext,
  params: Readonly<{ unreadOnly: boolean; limit: number; cursor?: NotificationCursor }>,
): Promise<{ items: NotificationPublic[]; hasMore: boolean }> {
  const rows = await transaction.notificationOutbox.findMany({
    where: recipientVisibleWhere(access, {
      unreadOnly: params.unreadOnly,
      cursor: params.cursor,
    }),
    select: NotificationPublicSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.limit + 1,
  });
  const hasMore = rows.length > params.limit;
  const items = rows.slice(0, params.limit);
  return { items, hasMore };
}

export async function summarizeNotifications(
  transaction: JobTransaction,
  access: AccessContext,
): Promise<{ unreadCount: number; totalCount: number; latestCreatedAtUtc: Date | null }> {
  const where = recipientVisibleWhere(access);
  const [unreadCount, totalCount, latest] = await Promise.all([
    transaction.notificationOutbox.count({ where: { ...where, readAtUtc: null } }),
    transaction.notificationOutbox.count({ where }),
    transaction.notificationOutbox.findFirst({
      where,
      select: { createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return { unreadCount, totalCount, latestCreatedAtUtc: latest?.createdAt ?? null };
}

export async function markNotificationRead(
  transaction: JobTransaction,
  access: AccessContext,
  notificationId: string,
): Promise<NotificationPublic | null> {
  const current = await transaction.notificationOutbox.findFirst({
    where: { id: notificationId, ...recipientVisibleWhere(access) },
    select: NotificationPublicSelect,
  });
  if (!current || current.readAtUtc) return current;

  const readAtUtc = new Date();
  await transaction.notificationOutbox.updateMany({
    where: {
      id: current.id,
      tenantId: access.tenantId,
      recipientTenantUserId: access.tenantUserId,
      readAtUtc: null,
      archivedAtUtc: null,
      job: visibleJobWhere(access),
    },
    data: {
      deliveryStatus: NotificationDeliveryStatus.DELIVERED,
      deliveredAtUtc: current.deliveredAtUtc ?? readAtUtc,
      readAtUtc,
      version: { increment: 1 },
    },
  });
  return transaction.notificationOutbox.findFirst({
    where: { id: current.id, ...recipientVisibleWhere(access) },
    select: NotificationPublicSelect,
  });
}

export async function markAllNotificationsRead(
  transaction: JobTransaction,
  access: AccessContext,
): Promise<{ updatedCount: number; cutoffAtUtc: Date }> {
  // This path owns only the recipient notification lock. Its visibility reads
  // never acquire the Job schedule/assignee advisory-lock tiers.
  await lockNotificationRecipients(transaction, access.tenantId, [access.tenantUserId]);
  const cutoffRows = await transaction.$queryRaw<Array<{ cutoffAtUtc: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "cutoffAtUtc"
  `);
  const cutoffAtUtc = cutoffRows[0]?.cutoffAtUtc;
  if (!cutoffAtUtc) throw new Error("Notification cutoff could not be established.");
  const where = recipientVisibleWhere(access, { unreadOnly: true, cutoffAtUtc });
  const [available, delivered] = await Promise.all([
    transaction.notificationOutbox.updateMany({
      where: { ...where, deliveryStatus: NotificationDeliveryStatus.AVAILABLE },
      data: {
        deliveryStatus: NotificationDeliveryStatus.DELIVERED,
        deliveredAtUtc: cutoffAtUtc,
        readAtUtc: cutoffAtUtc,
        version: { increment: 1 },
      },
    }),
    transaction.notificationOutbox.updateMany({
      where: { ...where, deliveryStatus: NotificationDeliveryStatus.DELIVERED },
      data: {
        readAtUtc: cutoffAtUtc,
        version: { increment: 1 },
      },
    }),
  ]);
  return { updatedCount: available.count + delivered.count, cutoffAtUtc };
}
