import { CustomerLostReason, Prisma } from "@prisma/client";
import { createCustomerActivityEvent, type ActivityActor } from "../lib/activity";
import { enqueueAiIndexJob } from "../lib/ai-index-jobs";
import {
  cancelAutomatedCustomerFollowUps,
  seedCustomerFollowUpSchedule,
} from "./customer-follow-up";
import { countActiveJobsForCustomer } from "./jobs";

type LifecycleTransaction = Prisma.TransactionClient;

export class CustomerLifecycleError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const LOST_REASON_LABELS = {
  PRICE: "Price",
  NO_RESPONSE: "No response",
  COMPETITOR: "Competitor",
  TIMING: "Timing",
  NOT_A_FIT: "Not a fit",
  CUSTOMER_CANCELED: "Customer canceled",
  OTHER: "Other",
} as const satisfies Record<CustomerLostReason, string>;

async function lockActiveCustomer(
  transaction: LifecycleTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string;
    lockMode?: "UPDATE" | "NO_KEY_UPDATE";
  },
) {
  const assignmentScope = input.assignedTenantUserId
    ? Prisma.sql`AND customer."assignedTenantUserId" = ${input.assignedTenantUserId}`
    : Prisma.empty;
  const lockClause = input.lockMode === "NO_KEY_UPDATE"
    ? Prisma.sql`FOR NO KEY UPDATE OF customer`
    : Prisma.sql`FOR UPDATE OF customer`;
  const [customer] = await transaction.$queryRaw<Array<{
    id: string;
    fullName: string;
    followUpStatus: string;
    lifecycleVersion: number;
    lostReason: CustomerLostReason | null;
    lostReasonNotes: string | null;
    lostAtUtc: Date | null;
  }>>(Prisma.sql`
    SELECT
      customer."id",
      customer."fullName",
      customer."followUpStatus"::text AS "followUpStatus",
      customer."lifecycleVersion",
      customer."lostReason",
      customer."lostReasonNotes",
      customer."lostAtUtc"
    FROM "Customer" customer
    WHERE customer."id" = ${input.customerId}
      AND customer."tenantId" = ${input.tenantId}
      AND customer."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
      ${assignmentScope}
    ${lockClause}
  `);
  if (!customer) {
    throw new CustomerLifecycleError(404, "CUSTOMER_NOT_FOUND", "Customer not found for tenant.");
  }
  return customer;
}

/**
 * Serializes every quote-admission path against mark-lost/reopen. Retained
 * customers may be included only by flows that intentionally restore them.
 */
export async function lockCustomerForQuoteAdmission(
  transaction: LifecycleTransaction,
  input: {
    tenantId: string;
    customerId: string;
    includeRetained?: boolean;
    assignedTenantUserId?: string;
  },
) {
  const retentionScope = input.includeRetained
    ? Prisma.empty
    : Prisma.sql`
      AND customer."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
    `;
  const assignmentScope = input.assignedTenantUserId
    ? Prisma.sql`AND customer."assignedTenantUserId" = ${input.assignedTenantUserId}`
    : Prisma.empty;
  const [customer] = await transaction.$queryRaw<Array<{
    id: string;
    followUpStatus: string;
  }>>(Prisma.sql`
    SELECT customer."id", customer."followUpStatus"::text AS "followUpStatus"
    FROM "Customer" customer
    WHERE customer."id" = ${input.customerId}
      AND customer."tenantId" = ${input.tenantId}
      ${retentionScope}
      ${assignmentScope}
    FOR NO KEY UPDATE OF customer
  `);
  if (!customer) {
    throw new CustomerLifecycleError(404, "CUSTOMER_NOT_FOUND", "Customer not found for tenant.");
  }
  if (customer.followUpStatus === "LOST") {
    throw new CustomerLifecycleError(
      409,
      "CUSTOMER_REOPEN_REQUIRED",
      "Reopen this customer before creating, sending, or accepting another quote.",
    );
  }
  return customer;
}

async function openManualTaskCount(
  transaction: LifecycleTransaction,
  input: { tenantId: string; customerId: string },
) {
  return transaction.activityTask.count({
    where: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      origin: "MANUAL",
      status: { in: ["OPEN", "IN_PROGRESS"] },
      deletedAtUtc: null,
    },
  });
}

export async function markCustomerLost(
  transaction: LifecycleTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string;
    actorTenantUserId: string;
    actor: ActivityActor;
    reason: CustomerLostReason;
    notes?: string | null;
    expectedVersion: number;
    occurredAtUtc?: Date;
  },
) {
  const existing = await lockActiveCustomer(transaction, input);
  if (existing.followUpStatus === "LOST") {
    throw new CustomerLifecycleError(409, "CUSTOMER_ALREADY_LOST", "This customer is already marked lost.");
  }
  if (existing.lifecycleVersion !== input.expectedVersion) {
    throw new CustomerLifecycleError(409, "CUSTOMER_LIFECYCLE_STALE_VERSION", "Customer lifecycle changed. Refresh before trying again.");
  }

  const occurredAtUtc = input.occurredAtUtc ?? new Date();
  const notes = input.notes?.trim() || null;
  if (input.reason === "OTHER" && !notes) {
    throw new CustomerLifecycleError(
      422,
      "CUSTOMER_LOST_OTHER_NOTES_REQUIRED",
      "Add a short note when the lost reason is Other.",
    );
  }
  const manualTaskCount = await openManualTaskCount(transaction, input);
  const activeJobCount = await countActiveJobsForCustomer(transaction, {
    tenantId: input.tenantId,
    customerId: existing.id,
  });
  if (activeJobCount > 0) {
    throw new CustomerLifecycleError(
      409,
      "CUSTOMER_HAS_ACTIVE_JOBS",
      "Complete or cancel active jobs before marking this customer lost.",
    );
  }
  const customer = await transaction.customer.update({
    where: { id_tenantId: { id: existing.id, tenantId: input.tenantId } },
    data: {
      followUpStatus: "LOST",
      followUpUpdatedAtUtc: occurredAtUtc,
      lostReason: input.reason,
      lostReasonNotes: notes,
      lostAtUtc: occurredAtUtc,
      lostByTenantUserId: input.actorTenantUserId,
      reopenedAtUtc: null,
      lifecycleVersion: { increment: 1 },
    },
  });
  const cancellation = await cancelAutomatedCustomerFollowUps(transaction, {
    tenantId: input.tenantId,
    customerId: existing.id,
    reason: `CUSTOMER_LOST_${input.reason}`,
    occurredAtUtc,
  });

  const reasonLabel = LOST_REASON_LABELS[input.reason];
  await createCustomerActivityEvent(transaction, {
    tenantId: input.tenantId,
    customerId: existing.id,
    actor: input.actor,
    eventType: "CUSTOMER_LOST",
    title: "Customer marked lost",
    detail: `Reason: ${reasonLabel}.`,
    metadata: {
      reason: input.reason,
      hasNotes: Boolean(notes),
      canceledAutomaticTaskCount: cancellation.canceledTaskCount,
      openManualTaskCount: manualTaskCount,
    },
  });
  await enqueueAiIndexJob(transaction, {
    tenantId: input.tenantId,
    sourceType: "Customer",
    sourceId: customer.id,
    operation: "UPSERT",
    expectedSourceUpdatedAtUtc: customer.updatedAt,
  });

  return {
    customer,
    canceledAutomaticTaskCount: cancellation.canceledTaskCount,
    openManualTaskCount: manualTaskCount,
  };
}

export async function reopenCustomer(
  transaction: LifecycleTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string;
    actorTenantUserId: string;
    actor: ActivityActor;
    startFollowUpSequence: boolean;
    expectedVersion: number;
    occurredAtUtc?: Date;
  },
) {
  const existing = await lockActiveCustomer(transaction, input);
  if (existing.followUpStatus !== "LOST") {
    throw new CustomerLifecycleError(409, "CUSTOMER_NOT_LOST", "Only a lost customer can be reopened.");
  }
  if (existing.lifecycleVersion !== input.expectedVersion) {
    throw new CustomerLifecycleError(409, "CUSTOMER_LIFECYCLE_STALE_VERSION", "Customer lifecycle changed. Refresh before trying again.");
  }

  const occurredAtUtc = input.occurredAtUtc ?? new Date();
  const manualTaskCount = await openManualTaskCount(transaction, input);
  const customer = await transaction.customer.update({
    where: { id_tenantId: { id: existing.id, tenantId: input.tenantId } },
    data: {
      followUpStatus: "NEEDS_FOLLOW_UP",
      followUpUpdatedAtUtc: occurredAtUtc,
      lostReason: null,
      lostReasonNotes: null,
      lostAtUtc: null,
      lostByTenantUserId: null,
      reopenedAtUtc: occurredAtUtc,
      lifecycleVersion: { increment: 1 },
    },
  });

  const sequence = input.startFollowUpSequence
    ? await seedCustomerFollowUpSchedule(transaction, {
        tenantId: input.tenantId,
        customerId: existing.id,
        assignedTenantUserId: customer.assignedTenantUserId,
        createdByTenantUserId: input.actorTenantUserId,
        startedAtUtc: occurredAtUtc,
      })
    : null;
  const startedFollowUpSequence = Boolean(sequence);
  const createdAutomaticTaskCount = sequence?.tasks.length ?? 0;
  await createCustomerActivityEvent(transaction, {
    tenantId: input.tenantId,
    customerId: existing.id,
    actor: input.actor,
    eventType: "CUSTOMER_REOPENED",
    title: "Customer reopened",
    detail: startedFollowUpSequence
      ? `Reopened from ${LOST_REASON_LABELS[existing.lostReason ?? "OTHER"]} and started a new follow-up sequence.`
      : `Reopened from ${LOST_REASON_LABELS[existing.lostReason ?? "OTHER"]} without starting a new follow-up sequence.`,
    metadata: {
      previousReason: existing.lostReason,
      hadPreviousNotes: Boolean(existing.lostReasonNotes),
      previousLostAtUtc: existing.lostAtUtc?.toISOString() ?? null,
      followUpSequenceRequested: input.startFollowUpSequence,
      startedFollowUpSequence,
      createdAutomaticTaskCount,
      openManualTaskCount: manualTaskCount,
    },
  });
  await enqueueAiIndexJob(transaction, {
    tenantId: input.tenantId,
    sourceType: "Customer",
    sourceId: customer.id,
    operation: "UPSERT",
    expectedSourceUpdatedAtUtc: customer.updatedAt,
  });

  return {
    customer,
    startedFollowUpSequence,
    createdAutomaticTaskCount,
    openManualTaskCount: manualTaskCount,
  };
}

export async function applyQuoteCustomerLifecycle(
  transaction: LifecycleTransaction,
  input: {
    tenantId: string;
    customerId: string;
    assignedTenantUserId?: string;
    quoteStatus: "SENT_TO_CUSTOMER" | "ACCEPTED" | "REJECTED";
    occurredAtUtc?: Date;
  },
) {
  // Quote revisions retain a Customer FK and therefore take a KEY SHARE lock.
  // NO KEY UPDATE still serializes lifecycle writes while avoiding a deadlock
  // when concurrent quote transactions later lock the same customer row.
  const customer = await lockActiveCustomer(transaction, {
    tenantId: input.tenantId,
    customerId: input.customerId,
    assignedTenantUserId: input.assignedTenantUserId,
    lockMode: "NO_KEY_UPDATE",
  });
  const occurredAtUtc = input.occurredAtUtc ?? new Date();

  if (input.quoteStatus === "REJECTED") {
    const cancellation = await cancelAutomatedCustomerFollowUps(transaction, {
      tenantId: input.tenantId,
      customerId: customer.id,
      reason: "QUOTE_REJECTED",
      occurredAtUtc,
    });
    return {
      customerStatusChanged: false,
      canceledAutomaticTaskCount: cancellation.canceledTaskCount,
    };
  }

  if (customer.followUpStatus === "LOST") {
    throw new CustomerLifecycleError(
      409,
      "CUSTOMER_REOPEN_REQUIRED",
      "Reopen this customer before sending or accepting another quote.",
    );
  }

  const followUpStatus = input.quoteStatus === "ACCEPTED" ? "WON" : "NEEDS_FOLLOW_UP";
  let updatedCustomer = null;
  if (customer.followUpStatus !== followUpStatus) {
    updatedCustomer = await transaction.customer.update({
      where: { id_tenantId: { id: customer.id, tenantId: input.tenantId } },
      data: {
        followUpStatus,
        followUpUpdatedAtUtc: occurredAtUtc,
        reopenedAtUtc: null,
        lifecycleVersion: { increment: 1 },
      },
    });
    await enqueueAiIndexJob(transaction, {
      tenantId: input.tenantId,
      sourceType: "Customer",
      sourceId: updatedCustomer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: updatedCustomer.updatedAt,
    });
  }
  const cancellation = input.quoteStatus === "ACCEPTED"
    ? await cancelAutomatedCustomerFollowUps(transaction, {
        tenantId: input.tenantId,
        customerId: customer.id,
        reason: "QUOTE_ACCEPTED",
        occurredAtUtc,
      })
    : { canceledTaskCount: 0 };
  return { customerStatusChanged: Boolean(updatedCustomer), canceledAutomaticTaskCount: cancellation.canceledTaskCount };
}
