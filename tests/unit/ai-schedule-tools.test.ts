import assert from "node:assert/strict";
import test from "node:test";
import type { AccessContext } from "../../src/lib/access-policy";
import { capabilitiesForRole } from "../../src/lib/access-policy";
import { prepareAssistantBooking } from "../../src/services/ai-schedule-tools";
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
