import assert from "node:assert/strict";
import test from "node:test";
import type { AccessContext } from "../../src/lib/access-policy";
import { capabilitiesForRole } from "../../src/lib/access-policy";
import { assessAssistantScheduleCapacity, prepareAssistantBooking } from "../../src/services/ai-schedule-tools";
import type { JobTransaction } from "../../src/services/jobs";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/quotefly_unit_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "unit-test-secret-that-is-long-enough-for-validation";

const ownerAccess: AccessContext = Object.freeze({
  tenantId: "tenant-1",
  tenantUserId: "owner-membership",
  userId: "owner-user",
  role: "owner",
  capabilities: capabilitiesForRole("owner"),
  requestId: "schedule-unit-test",
});

const assignedJob = {
  id: "job-104",
  jobNumber: 104,
  status: "UNSCHEDULED",
  title: "Dining table installation",
  customerId: "customer-1",
  assignedTenantUserId: "field-member-1",
  customer: { id: "customer-1", fullName: "Robert California" },
  assignedTenantUser: {
    id: "field-member-1",
    deletedAtUtc: null,
    user: { fullName: "Alex Installer", deletedAtUtc: null },
  },
} as const;

type AppointmentQuery = Readonly<{ where?: Record<string, unknown> }>;

function scheduleTransaction(conflicts: readonly { id: string; startsAtUtc: Date; endsAtUtc: Date }[] = []) {
  const appointmentQueries: AppointmentQuery[] = [];
  const transaction = {
    job: {
      findFirst: async () => assignedJob,
      findMany: async () => [assignedJob],
    },
    jobAppointment: {
      findMany: async (query: AppointmentQuery) => {
        appointmentQueries.push(query);
        return query.where && "jobId" in query.where ? [] : conflicts;
      },
    },
  } as unknown as JobTransaction;
  return { transaction, appointmentQueries };
}

test("Kody finds at most three non-overlapping openings for the assigned member", async () => {
  const conflict = {
    id: "appointment-conflict",
    startsAtUtc: new Date("2026-08-27T17:00:00.000Z"),
    endsAtUtc: new Date("2026-08-27T19:00:00.000Z"),
  };
  const { transaction, appointmentQueries } = scheduleTransaction([conflict]);

  const preview = await prepareAssistantBooking(transaction, ownerAccess, {
    message: "Find a two-hour opening today between 8 AM and 5 PM for Job #104",
    now: new Date("2026-08-27T12:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });

  assert.equal(preview.outcome, "READY");
  assert.equal(preview.availabilitySearched, true);
  assert.equal(preview.options.length, 3);
  assert.deepEqual(
    preview.options.map(({ startsAtUtc, endsAtUtc, scheduleOpening }) => ({ startsAtUtc, endsAtUtc, scheduleOpening })),
    [
      { startsAtUtc: "2026-08-27T15:00:00.000Z", endsAtUtc: "2026-08-27T17:00:00.000Z", scheduleOpening: true },
      { startsAtUtc: "2026-08-27T19:00:00.000Z", endsAtUtc: "2026-08-27T21:00:00.000Z", scheduleOpening: true },
      { startsAtUtc: "2026-08-27T19:30:00.000Z", endsAtUtc: "2026-08-27T21:30:00.000Z", scheduleOpening: true },
    ],
  );

  const conflictQuery = appointmentQueries.at(-1)?.where;
  assert.ok(conflictQuery);
  assert.equal(conflictQuery.tenantId, ownerAccess.tenantId);
  assert.equal(conflictQuery.assignedTenantUserId, assignedJob.assignedTenantUserId);
  assert.equal(conflictQuery.deletedAtUtc, null);
  assert.deepEqual(conflictQuery.status, { in: ["SCHEDULED", "DISPATCHED", "ARRIVED"] });
});

test("Kody rejects an explicitly requested slot that overlaps an active booking", async () => {
  const { transaction } = scheduleTransaction([{
    id: "appointment-conflict",
    startsAtUtc: new Date("2026-08-27T17:00:00.000Z"),
    endsAtUtc: new Date("2026-08-27T19:00:00.000Z"),
  }]);

  const preview = await prepareAssistantBooking(transaction, ownerAccess, {
    message: "Book Job #104 on 2026-08-27 from 10 AM to 12 PM",
    now: new Date("2026-08-27T12:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });

  assert.equal(preview.outcome, "SLOT_CONFLICT");
  assert.deepEqual(preview.options, []);
});

test("Kody asks for missing availability details and denies members without assignment permission", async () => {
  const { transaction } = scheduleTransaction();
  const missingDate = await prepareAssistantBooking(transaction, ownerAccess, {
    message: "Find a 2-hour opening between 8 AM and 5 PM for Job #104",
    now: new Date("2026-08-27T12:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(missingDate.outcome, "MISSING_DATE");
  assert.equal(missingDate.availabilitySearched, true);

  for (const naturalPrompt of [
    "Find a slot for Job #104 tomorrow",
    "Can Kody find a time for Job #104 tomorrow?",
    "When can we fit Job #104 in tomorrow?",
  ]) {
    const naturalPreview = await prepareAssistantBooking(transaction, ownerAccess, {
      message: naturalPrompt,
      now: new Date("2026-08-27T12:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      jobId: assignedJob.id,
    });
    assert.equal(naturalPreview.outcome, "MISSING_DURATION", naturalPrompt);
    assert.equal(naturalPreview.availabilitySearched, true, naturalPrompt);
  }

  const memberAccess: AccessContext = {
    ...ownerAccess,
    tenantUserId: "member-membership",
    userId: "member-user",
    role: "member",
    capabilities: capabilitiesForRole("member"),
  };
  const forbidden = await prepareAssistantBooking(transaction, memberAccess, {
    message: "Find a 2-hour opening today between 8 AM and 5 PM for Job #104",
    now: new Date("2026-08-27T12:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(forbidden.outcome, "FORBIDDEN");
  assert.deepEqual(forbidden.options, []);
});

function capacityTransaction(options?: {
  job?: typeof assignedJob | null;
  quote?: Record<string, unknown> | null;
  members?: Array<{ id: string; user: { fullName: string } }>;
  appointments?: Array<{ id: string; assignedTenantUserId: string; startsAtUtc: Date; endsAtUtc: Date }>;
  onAppointmentQuery?: (query: AppointmentQuery) => void;
}) {
  const job = options?.job === undefined ? assignedJob : options.job;
  return {
    job: {
      findFirst: async () => job,
      findMany: async () => job ? [job] : [],
    },
    quote: {
      findFirst: async () => options?.quote ?? null,
      findMany: async () => options?.quote ? [options.quote] : [],
    },
    customer: { findMany: async () => [] },
    tenantUser: {
      findMany: async () => options?.members ?? [{ id: "field-member-1", user: { fullName: "Alex Installer" } }],
    },
    jobAppointment: {
      findMany: async (query: AppointmentQuery) => {
        options?.onAppointmentQuery?.(query);
        return options?.appointments ?? [];
      },
    },
  } as unknown as JobTransaction;
}

test("Kody schedule-fit clarification lists work candidates without guessing the target", async () => {
  const assessment = await assessAssistantScheduleCapacity(capacityTransaction(), ownerAccess, {
    message: "Can I fit in a job today somehow?",
    now: new Date("2026-08-27T14:00:00.000Z"),
    timeZone: "America/Los_Angeles",
  });

  assert.equal(assessment.outcome, "MISSING_TARGET");
  assert.equal(assessment.mode, "JOB_FIT");
  assert.equal(assessment.targets[0]?.jobId, assignedJob.id);
  assert.equal(assessment.durationMinutes, null);
  assert.deepEqual(assessment.options, []);
});

test("Kody schedule-fit openings enforce a 25-minute buffer around active jobs", async () => {
  const assessment = await assessAssistantScheduleCapacity(capacityTransaction({
    appointments: [{
      id: "existing-visit",
      assignedTenantUserId: "field-member-1",
      startsAtUtc: new Date("2026-08-27T17:00:00.000Z"),
      endsAtUtc: new Date("2026-08-27T18:00:00.000Z"),
    }],
  }), ownerAccess, {
    message: "Can we fit this 2-hour work today between 8 AM and 5 PM?",
    now: new Date("2026-08-27T14:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });

  assert.equal(assessment.outcome, "READY");
  assert.equal(assessment.durationMinutes, 120);
  assert.equal(assessment.durationSource, "PROMPT");
  assert.equal(assessment.travelBufferMinutes, 25);
  assert.equal(assessment.options[0]?.startsAtUtc, "2026-08-27T18:30:00.000Z");
  assert.equal(assessment.options[0]?.endsAtUtc, "2026-08-27T20:30:00.000Z");
});

test("Kody loads and enforces travel buffers on both sides of the planning window", async () => {
  const now = new Date("2026-08-27T14:00:00.000Z");
  const preceding = await assessAssistantScheduleCapacity(capacityTransaction({
    appointments: [{
      id: "preceding-visit",
      assignedTenantUserId: "field-member-1",
      startsAtUtc: new Date("2026-08-27T13:50:00.000Z"),
      endsAtUtc: new Date("2026-08-27T14:50:00.000Z"),
    }],
  }), ownerAccess, {
    message: "Fit this 1-hour work today between 8 AM and 5 PM",
    now,
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(preceding.outcome, "READY");
  assert.equal(preceding.options[0]?.startsAtUtc, "2026-08-27T15:30:00.000Z");

  const precedingEquality = await assessAssistantScheduleCapacity(capacityTransaction({
    appointments: [{
      id: "preceding-equality",
      assignedTenantUserId: "field-member-1",
      startsAtUtc: new Date("2026-08-27T13:00:00.000Z"),
      endsAtUtc: new Date("2026-08-27T14:35:00.000Z"),
    }],
  }), ownerAccess, {
    message: "Fit this 1-hour work today between 8 AM and 5 PM",
    now,
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(precedingEquality.options[0]?.startsAtUtc, "2026-08-27T15:00:00.000Z");

  const following = await assessAssistantScheduleCapacity(capacityTransaction({
    appointments: [{
      id: "following-visit",
      assignedTenantUserId: "field-member-1",
      startsAtUtc: new Date("2026-08-28T00:10:00.000Z"),
      endsAtUtc: new Date("2026-08-28T01:00:00.000Z"),
    }],
  }), ownerAccess, {
    message: "Fit this 9-hour work today between 8 AM and 5 PM",
    now,
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(following.outcome, "NO_OPEN_SLOT");

  const appointmentQueries: AppointmentQuery[] = [];
  const followingEquality = await assessAssistantScheduleCapacity(capacityTransaction({
    appointments: [{
      id: "following-equality",
      assignedTenantUserId: "field-member-1",
      startsAtUtc: new Date("2026-08-28T00:25:00.000Z"),
      endsAtUtc: new Date("2026-08-28T01:00:00.000Z"),
    }],
    onAppointmentQuery: (query) => appointmentQueries.push(query),
  }), ownerAccess, {
    message: "Fit this 9-hour work today between 8 AM and 5 PM",
    now,
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(followingEquality.outcome, "READY");
  assert.equal(followingEquality.options[0]?.startsAtUtc, "2026-08-27T15:00:00.000Z");
  assert.deepEqual(appointmentQueries[0]?.where?.startsAtUtc, { lt: new Date("2026-08-28T00:25:00.000Z") });
  assert.deepEqual(appointmentQueries[0]?.where?.endsAtUtc, { gt: new Date("2026-08-27T14:35:00.000Z") });
});

test("Kody team inspection capacity is manager-only and asks for the missing duration", async () => {
  const memberAccess: AccessContext = {
    ...ownerAccess,
    tenantUserId: "member-membership",
    userId: "member-user",
    role: "member",
    capabilities: capabilitiesForRole("member"),
  };
  const message = "Which teammate can inspect Robert California today to finalize the quote?";
  const denied = await assessAssistantScheduleCapacity(capacityTransaction(), memberAccess, {
    message,
    now: new Date("2026-08-27T14:00:00.000Z"),
    timeZone: "America/Los_Angeles",
  });
  assert.equal(denied.outcome, "FORBIDDEN");

  const quote = {
    id: "quote-1",
    title: "Dining table quote",
    status: "SENT_TO_CUSTOMER",
    assignedTenantUserId: null,
    customer: { id: "customer-1", fullName: "Robert California" },
    assignedTenantUser: null,
  };
  const owner = await assessAssistantScheduleCapacity(capacityTransaction({ job: null, quote }), ownerAccess, {
    message,
    now: new Date("2026-08-27T14:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    quoteId: quote.id,
  });
  assert.equal(owner.outcome, "MISSING_DURATION");
  assert.equal(owner.mode, "TEAM_INSPECTION");
  assert.equal(owner.target?.quoteId, quote.id);
});

test("Kody fails closed instead of silently truncating a team larger than the bounded capacity search", async () => {
  const members = Array.from({ length: 33 }, (_, index) => ({
    id: `member-${index + 1}`,
    user: { fullName: `Team Member ${index + 1}` },
  }));
  const assessment = await assessAssistantScheduleCapacity(capacityTransaction({ members }), ownerAccess, {
    message: "Which teammate can inspect Robert California today for 1 hour?",
    now: new Date("2026-08-27T14:00:00.000Z"),
    timeZone: "America/Los_Angeles",
    jobId: assignedJob.id,
  });
  assert.equal(assessment.outcome, "SCHEDULE_LIMIT_REACHED");
  assert.deepEqual(assessment.options, []);
});
