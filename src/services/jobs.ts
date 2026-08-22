import { createHash } from "node:crypto";
import { JobAppointmentStatus, JobStatus, Prisma, type ServiceCategory } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { setTenantRlsContext } from "../lib/tenant-rls";

export type JobTransaction = Prisma.TransactionClient;

export class JobServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const JobPublicSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  sourceQuoteId: true,
  assignedTenantUserId: true,
  jobNumber: true,
  status: true,
  title: true,
  scopeSnapshot: true,
  serviceType: true,
  serviceAddressSnapshot: true,
  accessInstructions: true,
  acceptedAtUtc: true,
  scheduledAtUtc: true,
  dispatchedAtUtc: true,
  startedAtUtc: true,
  completedAtUtc: true,
  canceledAtUtc: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  archivedAtUtc: true,
  deletedAtUtc: true,
  customer: {
    select: {
      id: true,
      fullName: true,
    },
  },
  sourceQuote: {
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
        },
      },
    },
  },
} as const satisfies Prisma.JobSelect;

export type JobPublic = Prisma.JobGetPayload<{ select: typeof JobPublicSelect }>;

export const JobAppointmentPublicSelect = {
  id: true,
  jobId: true,
  assignedTenantUserId: true,
  createdByTenantUserId: true,
  status: true,
  startsAtUtc: true,
  endsAtUtc: true,
  timeZone: true,
  instructions: true,
  dispatchedAtUtc: true,
  arrivedAtUtc: true,
  completedAtUtc: true,
  canceledAtUtc: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAtUtc: true,
  assignedTenantUser: {
    select: {
      id: true,
      role: true,
      user: {
        select: {
          id: true,
          fullName: true,
        },
      },
    },
  },
  createdByTenantUser: {
    select: {
      id: true,
      user: {
        select: {
          id: true,
          fullName: true,
        },
      },
    },
  },
} as const satisfies Prisma.JobAppointmentSelect;

export type JobAppointmentPublic = Prisma.JobAppointmentGetPayload<{ select: typeof JobAppointmentPublicSelect }>;

export const JobScheduleAppointmentPublicSelect = {
  ...JobAppointmentPublicSelect,
  job: {
    select: {
      id: true,
      jobNumber: true,
      status: true,
      title: true,
      serviceAddressSnapshot: true,
      customer: {
        select: {
          id: true,
          fullName: true,
        },
      },
      sourceQuote: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  },
} as const satisfies Prisma.JobAppointmentSelect;

export type JobScheduleAppointmentPublic = Prisma.JobAppointmentGetPayload<{ select: typeof JobScheduleAppointmentPublicSelect }>;

export const JobNotePublicSelect = {
  id: true,
  jobId: true,
  createdByTenantUserId: true,
  body: true,
  createdAt: true,
  deletedAtUtc: true,
  createdByTenantUser: {
    select: {
      id: true,
      user: {
        select: {
          id: true,
          fullName: true,
        },
      },
    },
  },
} as const satisfies Prisma.JobNoteSelect;

export type JobNotePublic = Prisma.JobNoteGetPayload<{ select: typeof JobNotePublicSelect }>;

const JOB_SEQUENCE_KEY = "job_number";
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "IN_PROGRESS"];
const ACTIVE_APPOINTMENT_STATUSES: JobAppointmentStatus[] = ["SCHEDULED", "DISPATCHED", "ARRIVED"];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapQuoteJobStatus(status: string): JobStatus {
  if (status === "SCHEDULED") return "SCHEDULED";
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "COMPLETED") return "COMPLETED";
  return "UNSCHEDULED";
}

function memberJobScope(access: AccessContext): Prisma.JobWhereInput {
  if (hasCapability(access, "viewAllWorkspaceRecords")) return {};
  return {
    assignedTenantUserId: access.tenantUserId,
    customer: {
      assignedTenantUserId: access.tenantUserId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
    sourceQuote: {
      assignedTenantUserId: access.tenantUserId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
  };
}

export function visibleJobWhere(access: AccessContext): Prisma.JobWhereInput {
  return {
    tenantId: access.tenantId,
    deletedAtUtc: null,
    archivedAtUtc: null,
    customer: { archivedAtUtc: null, deletedAtUtc: null },
    sourceQuote: { archivedAtUtc: null, deletedAtUtc: null },
    ...memberJobScope(access),
  };
}

export async function countActiveJobsForQuote(
  transaction: JobTransaction,
  params: { tenantId: string; quoteId: string },
): Promise<number> {
  await setTenantRlsContext(transaction, params.tenantId);
  return transaction.job.count({
    where: {
      tenantId: params.tenantId,
      sourceQuoteId: params.quoteId,
      status: { in: ACTIVE_JOB_STATUSES },
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
  });
}

export async function countActiveJobsForCustomer(
  transaction: JobTransaction,
  params: { tenantId: string; customerId: string },
): Promise<number> {
  await setTenantRlsContext(transaction, params.tenantId);
  return transaction.job.count({
    where: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      status: { in: ACTIVE_JOB_STATUSES },
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
  });
}

export async function assertNoRetainedJobForQuote(
  transaction: JobTransaction,
  params: { tenantId: string; quoteId: string },
): Promise<void> {
  await setTenantRlsContext(transaction, params.tenantId);
  const retainedJobCount = await transaction.job.count({
    where: {
      tenantId: params.tenantId,
      sourceQuoteId: params.quoteId,
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
  });

  if (retainedJobCount > 0) {
    throw new JobServiceError(
      409,
      "QUOTE_JOB_LOCKED",
      "This accepted quote already has a retained job snapshot. Use the job workflow or create a quote revision.",
      { retainedJobCount },
    );
  }
}

async function nextJobNumber(transaction: JobTransaction, tenantId: string): Promise<number> {
  await transaction.tenantSequence.createMany({
    data: [{
      id: `tenantseq_${tenantId}_job_number`,
      tenantId,
      key: JOB_SEQUENCE_KEY,
      nextValue: 1,
    }],
    skipDuplicates: true,
  });

  const rows = await transaction.$queryRaw<Array<{ nextValue: number }>>(Prisma.sql`
    SELECT "nextValue"
    FROM "TenantSequence"
    WHERE "tenantId" = ${tenantId}
      AND "key" = ${JOB_SEQUENCE_KEY}
    FOR UPDATE
  `);
  const nextValue = rows[0]?.nextValue;
  if (!nextValue || nextValue < 1) {
    throw new JobServiceError(500, "JOB_SEQUENCE_UNAVAILABLE", "Job number sequence is unavailable.");
  }

  await transaction.tenantSequence.update({
    where: { tenantId_key: { tenantId, key: JOB_SEQUENCE_KEY } },
    data: { nextValue: nextValue + 1 },
  });
  return nextValue;
}

async function assertAssigneeCanSeeLinkedRecords(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string | null;
    customerId: string;
    sourceQuoteId: string;
  },
) {
  if (!params.assignedTenantUserId) return;
  const assignee = await transaction.tenantUser.findFirst({
    where: {
      id: params.assignedTenantUserId,
      tenantId: params.tenantId,
      deletedAtUtc: null,
      user: { deletedAtUtc: null },
    },
    select: { id: true, role: true },
  });
  if (!assignee) {
    throw new JobServiceError(404, "JOB_ASSIGNEE_NOT_FOUND", "Choose an active member from this workspace.");
  }
  const normalizedRole = assignee.role.trim().toLowerCase();
  if (normalizedRole === "owner" || normalizedRole === "admin") return;

  const [customerCount, quoteCount] = await Promise.all([
    transaction.customer.count({
      where: {
        id: params.customerId,
        tenantId: params.tenantId,
        assignedTenantUserId: assignee.id,
        archivedAtUtc: null,
        deletedAtUtc: null,
      },
    }),
    transaction.quote.count({
      where: {
        id: params.sourceQuoteId,
        tenantId: params.tenantId,
        assignedTenantUserId: assignee.id,
        archivedAtUtc: null,
        deletedAtUtc: null,
      },
    }),
  ]);

  if (customerCount !== 1 || quoteCount !== 1) {
    throw new JobServiceError(
      409,
      "JOB_ASSIGNEE_RECORD_SCOPE_MISMATCH",
      "Assign the linked customer and quote to this member before assigning the job.",
    );
  }
}

export async function ensureJobForAcceptedQuote(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    quoteId: string;
    actorTenantUserId: string;
    requestId: string;
  },
): Promise<JobPublic | null> {
  await setTenantRlsContext(transaction, access.tenantId);

  const existing = await transaction.job.findFirst({
    where: {
      tenantId: access.tenantId,
      sourceQuoteId: params.quoteId,
      deletedAtUtc: null,
    },
    select: JobPublicSelect,
  });
  if (existing) return existing;

  const memberScope = hasCapability(access, "viewAllWorkspaceRecords")
    ? Prisma.empty
    : Prisma.sql`AND quote."assignedTenantUserId" = ${access.tenantUserId}`;
  const rows = await transaction.$queryRaw<Array<{
    id: string;
    tenantId: string;
    customerId: string;
    assignedTenantUserId: string | null;
    serviceType: ServiceCategory;
    status: string;
    jobStatus: string;
    title: string;
    scopeText: string;
    closedAtUtc: Date | null;
    jobCompletedAtUtc: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>>(Prisma.sql`
    SELECT
      quote."id",
      quote."tenantId",
      quote."customerId",
      quote."assignedTenantUserId",
      quote."serviceType",
      quote."status",
      quote."jobStatus",
      quote."title",
      quote."scopeText",
      quote."closedAtUtc",
      quote."jobCompletedAtUtc",
      quote."createdAt",
      quote."updatedAt"
    FROM "Quote" quote
    INNER JOIN "Customer" customer
      ON customer."id" = quote."customerId"
     AND customer."tenantId" = quote."tenantId"
    WHERE quote."id" = ${params.quoteId}
      AND quote."tenantId" = ${access.tenantId}
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
      AND customer."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
      ${memberScope}
    FOR UPDATE OF quote
  `);
  const quote = rows[0];
  if (!quote) {
    throw new JobServiceError(404, "QUOTE_NOT_FOUND", "Quote not found for tenant.");
  }
  if (quote.status !== "ACCEPTED") {
    return null;
  }

  const existingAfterLock = await transaction.job.findFirst({
    where: {
      tenantId: access.tenantId,
      sourceQuoteId: params.quoteId,
      deletedAtUtc: null,
    },
    select: JobPublicSelect,
  });
  if (existingAfterLock) return existingAfterLock;

  await assertAssigneeCanSeeLinkedRecords(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: quote.assignedTenantUserId,
    customerId: quote.customerId,
    sourceQuoteId: quote.id,
  });

  const jobNumber = await nextJobNumber(transaction, access.tenantId);
  const status = mapQuoteJobStatus(quote.jobStatus);
  const acceptedAtUtc = quote.closedAtUtc ?? quote.updatedAt ?? quote.createdAt;
  const job = await transaction.job.create({
    data: {
      tenantId: access.tenantId,
      customerId: quote.customerId,
      sourceQuoteId: quote.id,
      assignedTenantUserId: quote.assignedTenantUserId,
      jobNumber,
      status,
      title: quote.title,
      scopeSnapshot: quote.scopeText,
      serviceType: quote.serviceType,
      acceptedAtUtc,
      completedAtUtc: status === "COMPLETED" ? quote.jobCompletedAtUtc ?? acceptedAtUtc : null,
    },
    select: JobPublicSelect,
  });

  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: params.actorTenantUserId,
      type: "CREATED",
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-created:${access.tenantId}:${quote.id}`),
      commandPayloadHash: sha256(JSON.stringify({
        sourceQuoteId: quote.id,
        customerId: quote.customerId,
        jobNumber,
        status,
      })),
    },
  });

  return job;
}

export async function listJobs(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    mine?: boolean;
    status?: JobStatus;
    customerId?: string;
    assignedTenantUserId?: string;
    search?: string;
    limit: number;
    offset: number;
  },
) {
  const manager = hasCapability(access, "viewAllWorkspaceRecords");
  const where: Prisma.JobWhereInput = {
    ...visibleJobWhere(access),
    ...(params.mine || !manager ? { assignedTenantUserId: access.tenantUserId } : {}),
    ...(params.status ? { status: params.status } : { status: { in: ACTIVE_JOB_STATUSES } }),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(manager && params.assignedTenantUserId ? { assignedTenantUserId: params.assignedTenantUserId } : {}),
  };

  if (params.search) {
    const trimmed = params.search.trim();
    const numeric = Number.parseInt(trimmed.replace(/^j[-\s]*/i, ""), 10);
    where.OR = [
      ...(Number.isFinite(numeric) ? [{ jobNumber: numeric }] : []),
      { title: { contains: trimmed, mode: "insensitive" } },
      { customer: { fullName: { contains: trimmed, mode: "insensitive" } } },
      { sourceQuote: { title: { contains: trimmed, mode: "insensitive" } } },
    ];
  }

  const [items, total] = await Promise.all([
    transaction.job.findMany({
      where,
      select: JobPublicSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: params.limit,
      skip: params.offset,
    }),
    transaction.job.count({ where }),
  ]);
  return { items, total };
}

export async function getJob(
  transaction: JobTransaction,
  access: AccessContext,
  jobId: string,
) {
  return transaction.job.findFirst({
    where: {
      id: jobId,
      ...visibleJobWhere(access),
    },
    select: JobPublicSelect,
  });
}

export async function updateJob(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    version: number;
    assignedTenantUserId?: string | null;
    accessInstructions?: string | null;
    requestId: string;
  },
) {
  if (!hasCapability(access, "manageAssignments")) {
    throw new JobServiceError(403, "JOB_FORBIDDEN", "You do not have permission to update this job.");
  }
  await lockJobSchedule(transaction, { tenantId: access.tenantId, jobId: params.jobId });
  const current = await transaction.job.findFirst({
    where: {
      id: params.jobId,
      ...visibleJobWhere(access),
    },
    select: {
      id: true,
      tenantId: true,
      customerId: true,
      sourceQuoteId: true,
      assignedTenantUserId: true,
      status: true,
      version: true,
    },
  });
  if (!current) {
    throw new JobServiceError(404, "JOB_NOT_FOUND", "Job not found for tenant.");
  }
  if (current.version !== params.version) {
    throw new JobServiceError(409, "JOB_STALE_VERSION", "This job changed. Refresh and try again.");
  }

  if (params.assignedTenantUserId !== undefined) {
    if (params.assignedTenantUserId) {
      await lockJobAppointmentAssignee(transaction, {
        tenantId: access.tenantId,
        assignedTenantUserId: params.assignedTenantUserId,
      });
    }
    await assertAssigneeCanSeeLinkedRecords(transaction, {
      tenantId: access.tenantId,
      assignedTenantUserId: params.assignedTenantUserId,
      customerId: current.customerId,
      sourceQuoteId: current.sourceQuoteId,
    });
    if (params.assignedTenantUserId !== current.assignedTenantUserId) {
      const activeAppointmentCount = await transaction.jobAppointment.count({
        where: {
          tenantId: access.tenantId,
          jobId: current.id,
          deletedAtUtc: null,
          status: { in: ACTIVE_APPOINTMENT_STATUSES },
        },
      });
      if (activeAppointmentCount > 0) {
        throw new JobServiceError(
          409,
          "JOB_ACTIVE_APPOINTMENTS_REASSIGN_CONFLICT",
          "Cancel or complete active bookings before reassigning this job.",
          { activeAppointmentCount },
        );
      }
    }
  }

  const updatedCount = await transaction.job.updateMany({
    where: {
      id: current.id,
      tenantId: access.tenantId,
      version: current.version,
      deletedAtUtc: null,
      archivedAtUtc: null,
    },
    data: {
      ...(params.assignedTenantUserId !== undefined ? { assignedTenantUserId: params.assignedTenantUserId } : {}),
      ...(params.accessInstructions !== undefined ? { accessInstructions: params.accessInstructions } : {}),
      version: { increment: 1 },
    },
  });
  if (updatedCount.count !== 1) {
    throw new JobServiceError(409, "JOB_STALE_VERSION", "This job changed. Refresh and try again.");
  }

  const updated = await getJob(transaction, access, current.id);
  if (!updated) {
    throw new JobServiceError(404, "JOB_NOT_FOUND", "Job not found for tenant.");
  }

  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: updated.id,
      actorTenantUserId: access.tenantUserId,
      type: current.assignedTenantUserId !== updated.assignedTenantUserId ? "ASSIGNED" : "UPDATED",
      fromStatus: current.status,
      toStatus: updated.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-update:${access.tenantId}:${updated.id}:${params.requestId}`),
      commandPayloadHash: sha256(JSON.stringify({
        version: params.version,
        assignedTenantUserId: params.assignedTenantUserId ?? null,
        accessInstructions: params.accessInstructions ?? null,
      })),
    },
  });

  return updated;
}

async function loadVisibleJobForSchedule(
  transaction: JobTransaction,
  access: AccessContext,
  jobId: string,
  options?: { requireBookable?: boolean },
) {
  const job = await transaction.job.findFirst({
    where: {
      id: jobId,
      ...visibleJobWhere(access),
    },
    select: {
      id: true,
      tenantId: true,
      customerId: true,
      sourceQuoteId: true,
      assignedTenantUserId: true,
      status: true,
      version: true,
    },
  });
  if (!job) {
    throw new JobServiceError(404, "JOB_NOT_FOUND", "Job not found for tenant.");
  }
  if (options?.requireBookable && (job.status === "COMPLETED" || job.status === "CANCELED")) {
    throw new JobServiceError(409, "JOB_NOT_BOOKABLE", "This job is completed or canceled and cannot be booked.");
  }
  return job;
}

function assertAppointmentAssigneeMatchesJob(
  job: { assignedTenantUserId: string | null },
  assignedTenantUserId: string,
) {
  if (!job.assignedTenantUserId || job.assignedTenantUserId !== assignedTenantUserId) {
    throw new JobServiceError(
      409,
      "JOB_APPOINTMENT_ASSIGNEE_MISMATCH",
      "Assign the job to this member before booking the appointment.",
      { jobAssignedTenantUserId: job.assignedTenantUserId, appointmentAssignedTenantUserId: assignedTenantUserId },
    );
  }
}

export async function lockJobAppointmentAssignee(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string;
  },
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${params.tenantId}:job-appointment:${params.assignedTenantUserId}`}, 0))) acquired
  `);
}

async function lockJobSchedule(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    jobId: string;
  },
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${params.tenantId}:job-schedule:${params.jobId}`}, 0))) acquired
  `);
}

async function assertNoAppointmentOverlap(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string;
    startsAtUtc: Date;
    endsAtUtc: Date;
    excludeAppointmentId?: string;
  },
) {
  const overlap = await transaction.jobAppointment.findFirst({
    where: {
      tenantId: params.tenantId,
      assignedTenantUserId: params.assignedTenantUserId,
      deletedAtUtc: null,
      status: { in: ACTIVE_APPOINTMENT_STATUSES },
      ...(params.excludeAppointmentId ? { id: { not: params.excludeAppointmentId } } : {}),
      startsAtUtc: { lt: params.endsAtUtc },
      endsAtUtc: { gt: params.startsAtUtc },
    },
    select: { id: true, startsAtUtc: true, endsAtUtc: true },
  });
  if (overlap) {
    throw new JobServiceError(
      409,
      "JOB_APPOINTMENT_OVERLAP",
      "This member already has a booking that overlaps this time.",
      {
        conflictingAppointmentId: overlap.id,
        conflictingStartsAtUtc: overlap.startsAtUtc.toISOString(),
        conflictingEndsAtUtc: overlap.endsAtUtc.toISOString(),
      },
    );
  }
}

const APPOINTMENT_TRANSITIONS: Readonly<Record<JobAppointmentStatus, readonly JobAppointmentStatus[]>> = {
  SCHEDULED: ["DISPATCHED", "CANCELED"],
  DISPATCHED: ["ARRIVED", "CANCELED"],
  ARRIVED: ["COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: [],
};

function assertAppointmentTransitionAllowed(currentStatus: JobAppointmentStatus, nextStatus: JobAppointmentStatus) {
  if (currentStatus === nextStatus) return;
  if (!APPOINTMENT_TRANSITIONS[currentStatus].includes(nextStatus)) {
    throw new JobServiceError(
      409,
      "JOB_APPOINTMENT_INVALID_TRANSITION",
      "This appointment status change is not allowed.",
      { currentStatus, nextStatus },
    );
  }
}

function earliestDate(dates: Array<Date | null>): Date | null {
  const validDates = dates.filter((date): date is Date => date instanceof Date);
  if (validDates.length === 0) return null;
  return new Date(Math.min(...validDates.map((date) => date.getTime())));
}

function latestDate(dates: Array<Date | null>): Date | null {
  const validDates = dates.filter((date): date is Date => date instanceof Date);
  if (validDates.length === 0) return null;
  return new Date(Math.max(...validDates.map((date) => date.getTime())));
}

async function syncJobScheduleState(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    jobId: string;
    actorTenantUserId: string;
    requestId: string;
  },
) {
  await lockJobSchedule(transaction, { tenantId: params.tenantId, jobId: params.jobId });
  const job = await transaction.job.findFirst({
    where: { id: params.jobId, tenantId: params.tenantId, deletedAtUtc: null, archivedAtUtc: null },
    select: {
      id: true,
      status: true,
      scheduledAtUtc: true,
      dispatchedAtUtc: true,
      startedAtUtc: true,
      completedAtUtc: true,
    },
  });
  if (!job || job.status === "COMPLETED" || job.status === "CANCELED") return;

  const retainedAppointments = await transaction.jobAppointment.findMany({
    where: {
      tenantId: params.tenantId,
      jobId: params.jobId,
      deletedAtUtc: null,
      status: { in: [...ACTIVE_APPOINTMENT_STATUSES, "COMPLETED"] },
    },
    orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    select: {
      startsAtUtc: true,
      status: true,
      dispatchedAtUtc: true,
      arrivedAtUtc: true,
      completedAtUtc: true,
    },
  });

  const activeAppointments = retainedAppointments.filter((appointment) =>
    ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status),
  );
  const completedAppointments = retainedAppointments.filter((appointment) => appointment.status === "COMPLETED");
  const nextAppointment = activeAppointments[0] ?? null;
  const nextStatus: JobStatus = activeAppointments.some((appointment) => appointment.status === "ARRIVED")
    ? "IN_PROGRESS"
    : activeAppointments.some((appointment) => appointment.status === "DISPATCHED")
      ? "DISPATCHED"
      : nextAppointment
        ? "SCHEDULED"
        : completedAppointments.length > 0
          ? "COMPLETED"
          : "UNSCHEDULED";
  const nextScheduledAtUtc = nextAppointment?.startsAtUtc ?? null;
  const nextDispatchedAtUtc = job.dispatchedAtUtc ?? earliestDate(retainedAppointments.map((appointment) => appointment.dispatchedAtUtc));
  const nextStartedAtUtc = job.startedAtUtc ?? earliestDate(retainedAppointments.map((appointment) => appointment.arrivedAtUtc));
  const nextCompletedAtUtc = job.completedAtUtc ?? (nextStatus === "COMPLETED"
    ? latestDate(completedAppointments.map((appointment) => appointment.completedAtUtc))
    : null);

  if (
    job.status === nextStatus
    && (job.scheduledAtUtc?.getTime() ?? null) === (nextScheduledAtUtc?.getTime() ?? null)
    && (job.dispatchedAtUtc?.getTime() ?? null) === (nextDispatchedAtUtc?.getTime() ?? null)
    && (job.startedAtUtc?.getTime() ?? null) === (nextStartedAtUtc?.getTime() ?? null)
    && (job.completedAtUtc?.getTime() ?? null) === (nextCompletedAtUtc?.getTime() ?? null)
  ) {
    return;
  }

  await transaction.job.updateMany({
    where: { id: params.jobId, tenantId: params.tenantId, deletedAtUtc: null, archivedAtUtc: null },
    data: {
      status: nextStatus,
      scheduledAtUtc: nextScheduledAtUtc,
      ...(nextDispatchedAtUtc ? { dispatchedAtUtc: nextDispatchedAtUtc } : {}),
      ...(nextStartedAtUtc ? { startedAtUtc: nextStartedAtUtc } : {}),
      ...(nextCompletedAtUtc ? { completedAtUtc: nextCompletedAtUtc } : {}),
      version: { increment: 1 },
    },
  });

  await transaction.jobEvent.create({
    data: {
      tenantId: params.tenantId,
      jobId: params.jobId,
      actorTenantUserId: params.actorTenantUserId,
      type: "UPDATED",
      fromStatus: job.status,
      toStatus: nextStatus,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-schedule-sync:${params.tenantId}:${params.jobId}:${params.requestId}`),
      commandPayloadHash: sha256(JSON.stringify({
        fromStatus: job.status,
        toStatus: nextStatus,
        scheduledAtUtc: nextScheduledAtUtc?.toISOString() ?? null,
        dispatchedAtUtc: nextDispatchedAtUtc?.toISOString() ?? null,
        startedAtUtc: nextStartedAtUtc?.toISOString() ?? null,
        completedAtUtc: nextCompletedAtUtc?.toISOString() ?? null,
      })),
    },
  });
}

export async function listJobAppointments(
  transaction: JobTransaction,
  access: AccessContext,
  jobId: string,
  params: { limit: number; offset: number },
) {
  await loadVisibleJobForSchedule(transaction, access, jobId);
  const where: Prisma.JobAppointmentWhereInput = {
      tenantId: access.tenantId,
      jobId,
      deletedAtUtc: null,
  };
  const [items, total] = await Promise.all([
    transaction.jobAppointment.findMany({
      where,
      select: JobAppointmentPublicSelect,
      orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
      take: params.limit,
      skip: params.offset,
    }),
    transaction.jobAppointment.count({ where }),
  ]);
  return { items, total };
}

export async function listJobSchedule(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    mine?: boolean;
    assignedTenantUserId?: string;
    fromUtc: Date;
    toUtc: Date;
    limit: number;
    offset: number;
  },
) {
  const manager = hasCapability(access, "viewAllWorkspaceRecords");
  const where: Prisma.JobAppointmentWhereInput = {
    tenantId: access.tenantId,
    deletedAtUtc: null,
    startsAtUtc: { lt: params.toUtc },
    endsAtUtc: { gt: params.fromUtc },
    ...(params.mine || !manager ? { assignedTenantUserId: access.tenantUserId } : {}),
    ...(manager && params.assignedTenantUserId ? { assignedTenantUserId: params.assignedTenantUserId } : {}),
    job: visibleJobWhere(access),
  };

  const [items, total] = await Promise.all([
    transaction.jobAppointment.findMany({
      where,
      select: JobScheduleAppointmentPublicSelect,
      orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
      take: params.limit,
      skip: params.offset,
    }),
    transaction.jobAppointment.count({ where }),
  ]);
  return { items, total };
}

export async function createJobAppointment(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    assignedTenantUserId: string;
    startsAtUtc: Date;
    endsAtUtc: Date;
    timeZone: string;
    instructions?: string | null;
    requestId: string;
  },
) {
  if (!hasCapability(access, "manageAssignments")) {
    throw new JobServiceError(403, "JOB_FORBIDDEN", "You do not have permission to book this job.");
  }
  if (params.startsAtUtc >= params.endsAtUtc) {
    throw new JobServiceError(400, "JOB_APPOINTMENT_INVALID_TIME", "Appointment start must be before end.");
  }
  if (params.endsAtUtc.getTime() - params.startsAtUtc.getTime() > 14 * 24 * 60 * 60 * 1000) {
    throw new JobServiceError(400, "JOB_APPOINTMENT_TOO_LONG", "Appointment duration cannot exceed 14 days.");
  }

  await lockJobSchedule(transaction, { tenantId: access.tenantId, jobId: params.jobId });
  const job = await loadVisibleJobForSchedule(transaction, access, params.jobId, { requireBookable: true });
  assertAppointmentAssigneeMatchesJob(job, params.assignedTenantUserId);
  await lockJobAppointmentAssignee(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: params.assignedTenantUserId,
  });
  await assertAssigneeCanSeeLinkedRecords(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: params.assignedTenantUserId,
    customerId: job.customerId,
    sourceQuoteId: job.sourceQuoteId,
  });
  await assertNoAppointmentOverlap(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: params.assignedTenantUserId,
    startsAtUtc: params.startsAtUtc,
    endsAtUtc: params.endsAtUtc,
  });

  const appointment = await transaction.jobAppointment.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      assignedTenantUserId: params.assignedTenantUserId,
      createdByTenantUserId: access.tenantUserId,
      startsAtUtc: params.startsAtUtc,
      endsAtUtc: params.endsAtUtc,
      timeZone: params.timeZone,
      instructions: params.instructions ?? null,
    },
    select: JobAppointmentPublicSelect,
  });

  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: access.tenantUserId,
      type: "APPOINTMENT_CREATED",
      fromStatus: job.status,
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-appointment-create:${access.tenantId}:${appointment.id}`),
      commandPayloadHash: sha256(JSON.stringify({
        appointmentId: appointment.id,
        assignedTenantUserId: params.assignedTenantUserId,
        startsAtUtc: params.startsAtUtc.toISOString(),
        endsAtUtc: params.endsAtUtc.toISOString(),
      })),
    },
  });
  await syncJobScheduleState(transaction, {
    tenantId: access.tenantId,
    jobId: job.id,
    actorTenantUserId: access.tenantUserId,
    requestId: `${params.requestId}:schedule-state`,
  });

  return appointment;
}

export async function updateJobAppointment(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    appointmentId: string;
    version: number;
    assignedTenantUserId?: string;
    startsAtUtc?: Date;
    endsAtUtc?: Date;
    timeZone?: string;
    instructions?: string | null;
    status?: JobAppointmentStatus;
    requestId: string;
  },
) {
  const manager = hasCapability(access, "manageAssignments");
  await lockJobSchedule(transaction, { tenantId: access.tenantId, jobId: params.jobId });
  const job = await loadVisibleJobForSchedule(transaction, access, params.jobId, { requireBookable: true });
  const current = await transaction.jobAppointment.findFirst({
    where: {
      id: params.appointmentId,
      tenantId: access.tenantId,
      jobId: job.id,
      deletedAtUtc: null,
    },
    select: JobAppointmentPublicSelect,
  });
  if (!current) {
    throw new JobServiceError(404, "JOB_APPOINTMENT_NOT_FOUND", "Appointment not found for tenant.");
  }
  if (current.version !== params.version) {
    throw new JobServiceError(409, "JOB_APPOINTMENT_STALE_VERSION", "This appointment changed. Refresh and try again.");
  }
  if (!manager) {
    const statusOnly =
      params.status !== undefined
      && params.assignedTenantUserId === undefined
      && params.startsAtUtc === undefined
      && params.endsAtUtc === undefined
      && params.timeZone === undefined
      && params.instructions === undefined;
    if (!statusOnly || current.assignedTenantUserId !== access.tenantUserId || params.status === "CANCELED") {
      throw new JobServiceError(403, "JOB_FORBIDDEN", "You do not have permission to update this booking.");
    }
    if (params.status === current.status) {
      throw new JobServiceError(
        409,
        "JOB_APPOINTMENT_INVALID_TRANSITION",
        "This appointment status change is not allowed.",
        { currentStatus: current.status, nextStatus: params.status },
      );
    }
  }

  const nextAssignedTenantUserId = params.assignedTenantUserId ?? current.assignedTenantUserId;
  const nextStartsAtUtc = params.startsAtUtc ?? current.startsAtUtc;
  const nextEndsAtUtc = params.endsAtUtc ?? current.endsAtUtc;
  const nextStatus = params.status ?? current.status;
  assertAppointmentTransitionAllowed(current.status, nextStatus);
  assertAppointmentAssigneeMatchesJob(job, nextAssignedTenantUserId);
  await lockJobAppointmentAssignee(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: nextAssignedTenantUserId,
  });
  if (nextStartsAtUtc >= nextEndsAtUtc) {
    throw new JobServiceError(400, "JOB_APPOINTMENT_INVALID_TIME", "Appointment start must be before end.");
  }
  if (nextEndsAtUtc.getTime() - nextStartsAtUtc.getTime() > 14 * 24 * 60 * 60 * 1000) {
    throw new JobServiceError(400, "JOB_APPOINTMENT_TOO_LONG", "Appointment duration cannot exceed 14 days.");
  }
  await assertAssigneeCanSeeLinkedRecords(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: nextAssignedTenantUserId,
    customerId: job.customerId,
    sourceQuoteId: job.sourceQuoteId,
  });
  if (ACTIVE_APPOINTMENT_STATUSES.includes(nextStatus)) {
    await assertNoAppointmentOverlap(transaction, {
      tenantId: access.tenantId,
      assignedTenantUserId: nextAssignedTenantUserId,
      startsAtUtc: nextStartsAtUtc,
      endsAtUtc: nextEndsAtUtc,
      excludeAppointmentId: current.id,
    });
  }

  const now = new Date();
  const updatedCount = await transaction.jobAppointment.updateMany({
    where: {
      id: current.id,
      tenantId: access.tenantId,
      version: current.version,
      deletedAtUtc: null,
    },
    data: {
      ...(params.assignedTenantUserId !== undefined ? { assignedTenantUserId: nextAssignedTenantUserId } : {}),
      ...(params.startsAtUtc !== undefined ? { startsAtUtc: nextStartsAtUtc } : {}),
      ...(params.endsAtUtc !== undefined ? { endsAtUtc: nextEndsAtUtc } : {}),
      ...(params.timeZone !== undefined ? { timeZone: params.timeZone } : {}),
      ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
      ...(params.status !== undefined ? { status: nextStatus } : {}),
      ...(nextStatus === "DISPATCHED" && !current.dispatchedAtUtc ? { dispatchedAtUtc: now } : {}),
      ...(nextStatus === "ARRIVED" && !current.arrivedAtUtc ? { arrivedAtUtc: now } : {}),
      ...(nextStatus === "COMPLETED" && !current.completedAtUtc ? { completedAtUtc: now } : {}),
      ...(nextStatus === "CANCELED" && !current.canceledAtUtc ? { canceledAtUtc: now } : {}),
      version: { increment: 1 },
    },
  });
  if (updatedCount.count !== 1) {
    throw new JobServiceError(409, "JOB_APPOINTMENT_STALE_VERSION", "This appointment changed. Refresh and try again.");
  }

  const updated = await transaction.jobAppointment.findFirstOrThrow({
    where: { id: current.id, tenantId: access.tenantId },
    select: JobAppointmentPublicSelect,
  });
  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: access.tenantUserId,
      type: nextStatus === "CANCELED" ? "APPOINTMENT_CANCELED" : "APPOINTMENT_UPDATED",
      fromStatus: job.status,
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-appointment-update:${access.tenantId}:${updated.id}:${params.requestId}`),
      commandPayloadHash: sha256(JSON.stringify({
        appointmentId: updated.id,
        version: params.version,
        assignedTenantUserId: nextAssignedTenantUserId,
        startsAtUtc: nextStartsAtUtc.toISOString(),
        endsAtUtc: nextEndsAtUtc.toISOString(),
        status: nextStatus,
      })),
    },
  });
  await syncJobScheduleState(transaction, {
    tenantId: access.tenantId,
    jobId: job.id,
    actorTenantUserId: access.tenantUserId,
    requestId: `${params.requestId}:schedule-state`,
  });
  return updated;
}

export async function deleteJobAppointment(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    appointmentId: string;
    version: number;
    requestId: string;
  },
) {
  if (!hasCapability(access, "manageAssignments")) {
    throw new JobServiceError(403, "JOB_FORBIDDEN", "You do not have permission to delete this booking.");
  }
  await lockJobSchedule(transaction, { tenantId: access.tenantId, jobId: params.jobId });
  const job = await loadVisibleJobForSchedule(transaction, access, params.jobId, { requireBookable: true });
  const current = await transaction.jobAppointment.findFirst({
    where: { id: params.appointmentId, tenantId: access.tenantId, jobId: job.id, deletedAtUtc: null },
    select: { id: true, version: true, status: true, assignedTenantUserId: true },
  });
  if (!current) {
    throw new JobServiceError(404, "JOB_APPOINTMENT_NOT_FOUND", "Appointment not found for tenant.");
  }
  await lockJobAppointmentAssignee(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: current.assignedTenantUserId,
  });
  if (current.version !== params.version) {
    throw new JobServiceError(409, "JOB_APPOINTMENT_STALE_VERSION", "This appointment changed. Refresh and try again.");
  }
  assertAppointmentTransitionAllowed(current.status, "CANCELED");
  const now = new Date();
  const updated = await transaction.jobAppointment.updateMany({
    where: { id: current.id, tenantId: access.tenantId, version: current.version, deletedAtUtc: null },
    data: { deletedAtUtc: now, canceledAtUtc: now, status: "CANCELED", version: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw new JobServiceError(409, "JOB_APPOINTMENT_STALE_VERSION", "This appointment changed. Refresh and try again.");
  }
  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: access.tenantUserId,
      type: "APPOINTMENT_CANCELED",
      fromStatus: job.status,
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-appointment-delete:${access.tenantId}:${current.id}:${params.requestId}`),
      commandPayloadHash: sha256(JSON.stringify({ appointmentId: current.id, version: params.version })),
    },
  });
  await syncJobScheduleState(transaction, {
    tenantId: access.tenantId,
    jobId: job.id,
    actorTenantUserId: access.tenantUserId,
    requestId: `${params.requestId}:schedule-state`,
  });
}

export async function listJobNotes(
  transaction: JobTransaction,
  access: AccessContext,
  jobId: string,
  params: { limit: number; offset: number },
) {
  await loadVisibleJobForSchedule(transaction, access, jobId);
  const where: Prisma.JobNoteWhereInput = { tenantId: access.tenantId, jobId, deletedAtUtc: null };
  const [items, total] = await Promise.all([
    transaction.jobNote.findMany({
      where,
      select: JobNotePublicSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit,
      skip: params.offset,
    }),
    transaction.jobNote.count({ where }),
  ]);
  return { items, total };
}

export async function createJobNote(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    body: string;
    requestId: string;
  },
) {
  const job = await loadVisibleJobForSchedule(transaction, access, params.jobId);
  const note = await transaction.jobNote.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      createdByTenantUserId: access.tenantUserId,
      body: params.body,
    },
    select: JobNotePublicSelect,
  });
  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: access.tenantUserId,
      type: "NOTE_ADDED",
      fromStatus: job.status,
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-note-create:${access.tenantId}:${note.id}`),
      commandPayloadHash: sha256(JSON.stringify({ noteId: note.id })),
    },
  });
  return note;
}

export async function deleteJobNote(
  transaction: JobTransaction,
  access: AccessContext,
  params: {
    jobId: string;
    noteId: string;
    requestId: string;
  },
) {
  const job = await loadVisibleJobForSchedule(transaction, access, params.jobId);
  const note = await transaction.jobNote.findFirst({
    where: { id: params.noteId, tenantId: access.tenantId, jobId: job.id, deletedAtUtc: null },
    select: { id: true, createdByTenantUserId: true },
  });
  if (!note) {
    throw new JobServiceError(404, "JOB_NOTE_NOT_FOUND", "Job note not found for tenant.");
  }
  if (note.createdByTenantUserId !== access.tenantUserId && !hasCapability(access, "manageAssignments")) {
    throw new JobServiceError(403, "JOB_FORBIDDEN", "You do not have permission to delete this note.");
  }
  const update = await transaction.jobNote.updateMany({
    where: { id: note.id, tenantId: access.tenantId, deletedAtUtc: null },
    data: { deletedAtUtc: new Date() },
  });
  if (update.count !== 1) {
    throw new JobServiceError(409, "JOB_NOTE_STALE_VERSION", "This note changed. Refresh and try again.");
  }
  await transaction.jobEvent.create({
    data: {
      tenantId: access.tenantId,
      jobId: job.id,
      actorTenantUserId: access.tenantUserId,
      type: "NOTE_DELETED",
      fromStatus: job.status,
      toStatus: job.status,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash: sha256(`job-note-delete:${access.tenantId}:${note.id}:${params.requestId}`),
      commandPayloadHash: sha256(JSON.stringify({ noteId: note.id })),
    },
  });
}
