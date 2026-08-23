import { JobAppointmentStatus, JobStatus, Prisma } from "@prisma/client";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { PaginationQuerySchema } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { isValidIanaTimeZone } from "../lib/tenant-time";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  createJobAppointment,
  createJobNote,
  deleteJobAppointment,
  deleteJobNote,
  getJob,
  JobServiceError,
  listJobAppointments,
  listJobs,
  listJobNotes,
  listJobSchedule,
  updateJobAppointment,
  updateJob,
  type JobAppointmentPublic,
  type JobNotePublic,
  type JobPublic,
  type JobScheduleAppointmentPublic,
} from "../services/jobs";

const JobStatusSchema = z.nativeEnum(JobStatus);
const JobAppointmentStatusSchema = z.nativeEnum(JobAppointmentStatus);
const BooleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");
const EXPLICIT_OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/i;

function isValidExplicitOffsetDateTime(value: string): boolean {
  const match = EXPLICIT_OFFSET_DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7]?.toUpperCase() === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[7]?.toUpperCase() === "Z" ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}

const ExplicitOffsetDateTimeSchema = z.string().trim().regex(
  EXPLICIT_OFFSET_DATE_TIME,
  "Use an ISO 8601 date-time with an explicit UTC offset.",
).refine(
  isValidExplicitOffsetDateTime,
  "Use a valid ISO 8601 date-time.",
).transform((value) => new Date(value));
const JobParamsSchema = z.object({ jobId: z.string().trim().min(1).max(191) }).strict();
const JobAppointmentParamsSchema = z.object({
  jobId: z.string().trim().min(1).max(191),
  appointmentId: z.string().trim().min(1).max(191),
}).strict();
const JobNoteParamsSchema = z.object({
  jobId: z.string().trim().min(1).max(191),
  noteId: z.string().trim().min(1).max(191),
}).strict();

const ListJobsQuerySchema = PaginationQuerySchema.extend({
  mine: BooleanQuerySchema.default(false),
  status: JobStatusSchema.optional(),
  customerId: z.string().trim().min(1).max(191).optional(),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();
const JobChildListQuerySchema = PaginationQuerySchema;
const ListJobScheduleQuerySchema = PaginationQuerySchema.extend({
  mine: BooleanQuerySchema.default(false),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  fromUtc: ExplicitOffsetDateTimeSchema,
  toUtc: ExplicitOffsetDateTimeSchema,
}).strict().refine(
  (payload) => !(payload.fromUtc instanceof Date) || !(payload.toUtc instanceof Date) || payload.fromUtc < payload.toUtc,
  { path: ["toUtc"], message: "Schedule end must be after start." },
).refine(
  (payload) => !(payload.fromUtc instanceof Date)
    || !(payload.toUtc instanceof Date)
    || payload.toUtc.getTime() - payload.fromUtc.getTime() <= 35 * 24 * 60 * 60 * 1000,
  { path: ["toUtc"], message: "Schedule window cannot exceed 35 days." },
).refine(
  (payload) => payload.offset <= 1000,
  { path: ["offset"], message: "Schedule offset cannot exceed 1000." },
);

const UpdateJobSchema = z.object({
  version: z.number().int().min(1),
  assignedTenantUserId: z.string().trim().min(1).max(191).nullable().optional(),
  accessInstructions: z.string().trim().max(2000).nullable().optional(),
}).strict().refine(
  (payload) => Object.keys(payload).some((key) => key !== "version"),
  { message: "At least one job field must be updated." },
);

const AppointmentTimeZoneSchema = z.string().trim().min(1).max(64).refine(isValidIanaTimeZone, {
  message: "Use a valid IANA timezone.",
});

const CreateJobAppointmentSchema = z.object({
  assignedTenantUserId: z.string().trim().min(1).max(191),
  startsAtUtc: ExplicitOffsetDateTimeSchema,
  endsAtUtc: ExplicitOffsetDateTimeSchema,
  timeZone: AppointmentTimeZoneSchema,
  instructions: z.string().trim().max(2000).nullable().optional(),
}).strict().refine(
  (payload) => !(payload.startsAtUtc instanceof Date)
    || !(payload.endsAtUtc instanceof Date)
    || payload.startsAtUtc < payload.endsAtUtc,
  { path: ["endsAtUtc"], message: "Appointment end must be after start." },
).refine(
  (payload) => !(payload.startsAtUtc instanceof Date)
    || !(payload.endsAtUtc instanceof Date)
    || payload.endsAtUtc.getTime() - payload.startsAtUtc.getTime() <= 14 * 24 * 60 * 60 * 1000,
  { path: ["endsAtUtc"], message: "Appointment duration cannot exceed 14 days." },
);

const UpdateJobAppointmentSchema = z.object({
  version: z.number().int().min(1),
  assignedTenantUserId: z.string().trim().min(1).max(191).optional(),
  startsAtUtc: ExplicitOffsetDateTimeSchema.optional(),
  endsAtUtc: ExplicitOffsetDateTimeSchema.optional(),
  timeZone: AppointmentTimeZoneSchema.optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  status: JobAppointmentStatusSchema.optional(),
}).strict().superRefine((payload, context) => {
  const hasAssignment = payload.assignedTenantUserId !== undefined;
  const hasStartsAtUtc = payload.startsAtUtc !== undefined;
  const hasEndsAtUtc = payload.endsAtUtc !== undefined;
  const hasTimeZone = payload.timeZone !== undefined;
  const hasInstructions = payload.instructions !== undefined;
  const hasStatus = payload.status !== undefined;
  const scheduleFieldCount = Number(hasStartsAtUtc) + Number(hasEndsAtUtc) + Number(hasTimeZone);

  if (!hasAssignment && scheduleFieldCount === 0 && !hasInstructions && !hasStatus) {
    context.addIssue({ code: "custom", message: "At least one appointment field must be updated." });
  }
  if (hasStatus && (hasAssignment || scheduleFieldCount > 0 || hasInstructions)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Appointment status changes must be submitted without other updates.",
    });
  }
  if (scheduleFieldCount > 0 && scheduleFieldCount < 3) {
    context.addIssue({
      code: "custom",
      path: ["startsAtUtc"],
      message: "Rescheduling requires startsAtUtc, endsAtUtc, and timeZone together.",
    });
  }
  if (
    payload.startsAtUtc instanceof Date
    && payload.endsAtUtc instanceof Date
    && payload.startsAtUtc >= payload.endsAtUtc
  ) {
    context.addIssue({ code: "custom", path: ["endsAtUtc"], message: "Appointment end must be after start." });
  }
  if (
    payload.startsAtUtc instanceof Date
    && payload.endsAtUtc instanceof Date
    && payload.endsAtUtc.getTime() - payload.startsAtUtc.getTime() > 14 * 24 * 60 * 60 * 1000
  ) {
    context.addIssue({ code: "custom", path: ["endsAtUtc"], message: "Appointment duration cannot exceed 14 days." });
  }
});

const VersionBodySchema = z.object({
  version: z.number().int().min(1),
}).strict();

const CreateJobNoteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
}).strict();

function serializeJob(job: JobPublic) {
  const {
    deletedAtUtc: _deletedAtUtc,
    archivedAtUtc: _archivedAtUtc,
    tenantId: _tenantId,
    ...safe
  } = job;
  return {
    ...safe,
    acceptedAtUtc: job.acceptedAtUtc.toISOString(),
    scheduledAtUtc: job.scheduledAtUtc?.toISOString() ?? null,
    dispatchedAtUtc: job.dispatchedAtUtc?.toISOString() ?? null,
    startedAtUtc: job.startedAtUtc?.toISOString() ?? null,
    completedAtUtc: job.completedAtUtc?.toISOString() ?? null,
    canceledAtUtc: job.canceledAtUtc?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    sourceQuote: {
      ...job.sourceQuote,
      totalAmount: Number(job.sourceQuote.totalAmount),
    },
  };
}

function serializeAppointment(appointment: JobAppointmentPublic) {
  const { deletedAtUtc: _deletedAtUtc, ...safe } = appointment;
  return {
    ...safe,
    startsAtUtc: appointment.startsAtUtc.toISOString(),
    endsAtUtc: appointment.endsAtUtc.toISOString(),
    dispatchedAtUtc: appointment.dispatchedAtUtc?.toISOString() ?? null,
    arrivedAtUtc: appointment.arrivedAtUtc?.toISOString() ?? null,
    completedAtUtc: appointment.completedAtUtc?.toISOString() ?? null,
    canceledAtUtc: appointment.canceledAtUtc?.toISOString() ?? null,
    createdAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString(),
  };
}

function serializeScheduleAppointment(appointment: JobScheduleAppointmentPublic) {
  return {
    ...appointment,
    startsAtUtc: appointment.startsAtUtc.toISOString(),
    endsAtUtc: appointment.endsAtUtc.toISOString(),
    job: appointment.job,
  };
}

function serializeNote(note: JobNotePublic) {
  const { deletedAtUtc: _deletedAtUtc, ...safe } = note;
  return {
    ...safe,
    createdAt: note.createdAt.toISOString(),
  };
}

function sendJobError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof JobServiceError)) throw error;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details ?? {}),
  });
}

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get("/jobs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const query = ListJobsQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          listJobs(transaction, access, {
            mine: query.mine,
            status: query.status,
            customerId: query.customerId,
            assignedTenantUserId: query.assignedTenantUserId,
            search: query.search,
            limit: query.limit,
            offset: query.offset,
          }), { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeJob),
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
      return sendJobError(reply, error);
    }
  });

  app.get("/jobs/schedule", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const query = ListJobScheduleQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          listJobSchedule(transaction, access, {
            mine: query.mine,
            assignedTenantUserId: query.assignedTenantUserId,
            fromUtc: query.fromUtc,
            toUtc: query.toUtc,
            limit: query.limit,
            offset: query.offset,
          }), { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeScheduleAppointment),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.get("/jobs/:jobId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);

    const job = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        getJob(transaction, access, jobId), { maxWait: 5_000, timeout: 15_000 }),
    );
    if (!job) {
      return reply.code(404).send({ error: "Job not found for tenant.", code: "JOB_NOT_FOUND" });
    }
    reply.header("Cache-Control", "private, no-store");
    return { job: serializeJob(job) };
  });

  app.patch("/jobs/:jobId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);
    const payload = UpdateJobSchema.parse(request.body);

    try {
      const job = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          updateJob(transaction, access, {
            jobId,
            version: payload.version,
            assignedTenantUserId: payload.assignedTenantUserId,
            accessInstructions: payload.accessInstructions,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      reply.header("Cache-Control", "private, no-store");
      return { job: serializeJob(job) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.get("/jobs/:jobId/appointments", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);
    const query = JobChildListQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          listJobAppointments(transaction, access, jobId, { limit: query.limit, offset: query.offset }), { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeAppointment),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/jobs/:jobId/appointments", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);
    const payload = CreateJobAppointmentSchema.parse(request.body);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          createJobAppointment(transaction, access, {
            jobId,
            assignedTenantUserId: payload.assignedTenantUserId,
            startsAtUtc: payload.startsAtUtc,
            endsAtUtc: payload.endsAtUtc,
            timeZone: payload.timeZone,
            instructions: payload.instructions,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      reply.header("Cache-Control", "private, no-store");
      return reply.code(201).send({
        appointment: serializeAppointment(result.appointment),
        notificationReceipt: result.notificationReceipt,
      });
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.patch("/jobs/:jobId/appointments/:appointmentId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId, appointmentId } = JobAppointmentParamsSchema.parse(request.params);
    const payload = UpdateJobAppointmentSchema.parse(request.body);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          updateJobAppointment(transaction, access, {
            jobId,
            appointmentId,
            version: payload.version,
            assignedTenantUserId: payload.assignedTenantUserId,
            startsAtUtc: payload.startsAtUtc,
            endsAtUtc: payload.endsAtUtc,
            timeZone: payload.timeZone,
            instructions: payload.instructions,
            status: payload.status,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        appointment: serializeAppointment(result.appointment),
        notificationReceipt: result.notificationReceipt,
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.delete("/jobs/:jobId/appointments/:appointmentId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId, appointmentId } = JobAppointmentParamsSchema.parse(request.params);
    const payload = VersionBodySchema.parse(request.body);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          deleteJobAppointment(transaction, access, {
            jobId,
            appointmentId,
            version: payload.version,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        appointmentId: result.appointmentId,
        notificationReceipt: result.notificationReceipt,
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.get("/jobs/:jobId/notes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);
    const query = JobChildListQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          listJobNotes(transaction, access, jobId, { limit: query.limit, offset: query.offset }), { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeNote),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/jobs/:jobId/notes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId } = JobParamsSchema.parse(request.params);
    const payload = CreateJobNoteSchema.parse(request.body);

    try {
      const note = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          createJobNote(transaction, access, {
            jobId,
            body: payload.body,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      reply.header("Cache-Control", "private, no-store");
      return reply.code(201).send({ note: serializeNote(note) });
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.delete("/jobs/:jobId/notes/:noteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { jobId, noteId } = JobNoteParamsSchema.parse(request.params);

    try {
      await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          deleteJobNote(transaction, access, {
            jobId,
            noteId,
            requestId: request.id,
          }), { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendJobError(reply, error);
    }
  });
};
