import { FastifyPluginAsync } from "fastify";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext, hasCapability, type AccessContext } from "../lib/access-policy";
import {
  markCustomerAiRetrievalSourcesDeleted,
  markQuoteAiRetrievalSourcesDeleted,
} from "../lib/ai-retrieval";
import { createCustomerActivityEvent, resolveActivityActor } from "../lib/activity";
import {
  normalizeCustomerPhone,
  normalizePhoneSearchDigits,
  normalizeUsPhoneDigits,
  phoneNumbersEquivalent,
} from "../lib/phone";
import {
  PaginationQuerySchema,
  tenantActiveCustomerScope,
  tenantActiveQuoteScope,
  tenantActiveScope,
  tenantScope,
} from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import {
  WorkspaceAssigneeSelect,
  assignedRecordScope,
  defaultAssigneeForCreatedRecord,
  validateActiveTenantAssignee,
} from "../lib/workspace-assignment";

const LeadFollowUpStatusSchema = z.enum([
  "NEEDS_FOLLOW_UP",
  "FOLLOWED_UP",
  "WON",
  "LOST",
]);

const CustomerStageSchema = z.enum(["NEW", "CONTACTED", "READY", "SENT", "WON", "LOST"]);
const CustomerLifecycleSchema = z.enum(["active", "archived", "deleted"]);
const CustomerPhoneSchema = z.string().trim().refine((phone) => normalizeUsPhoneDigits(phone) !== null, {
  message: "Enter a valid 10-digit US phone number.",
});

const CreateCustomerSchema = z.object({
  fullName: z.string().trim().min(2),
  phone: CustomerPhoneSchema,
  email: z.string().trim().email().nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
  followUpStatus: LeadFollowUpStatusSchema.optional(),
  duplicateAction: z.enum(["merge", "create_new", "use_existing"]).optional(),
  duplicateCustomerId: z.string().min(1).optional(),
  assignedTenantUserId: z.string().min(1).nullable().optional(),
});

const DuplicateMatchSummarySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  archivedAtUtc: z.string().nullable(),
  deletedAtUtc: z.string().nullable(),
  createdAt: z.string(),
  matchReasons: z.array(z.enum(["phone", "email"])).min(1),
});

const ListCustomersQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
  lifecycle: CustomerLifecycleSchema.default("active"),
  stage: CustomerStageSchema.optional(),
});

const CustomerParamsSchema = z.object({
  customerId: z.string().min(1),
});

const CustomerActivityQuerySchema = PaginationQuerySchema;

const UpdateCustomerSchema = z
  .object({
    fullName: z.string().trim().min(2).optional(),
    phone: CustomerPhoneSchema.optional(),
    email: z.string().trim().email().nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
    followUpStatus: LeadFollowUpStatusSchema.optional(),
    assignedTenantUserId: z.string().min(1).nullable().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required.",
  });

function quoteNumber(quoteId: string): string {
  return `QF-${quoteId.slice(0, 8).toUpperCase()}`;
}

function formatFollowUpStatus(status: z.infer<typeof LeadFollowUpStatusSchema>): string {
  return status.replaceAll("_", " ").toLowerCase();
}

function buildRevisionTitle(
  revision: {
    eventType: string;
    status: string;
  },
): string {
  if (revision.eventType === "CREATED") return "Quote drafted";
  if (revision.eventType === "LINE_ITEM_CHANGED") return "Quote lines updated";
  if (revision.eventType === "DECISION") {
    if (revision.status === "SENT_TO_CUSTOMER") return "Quote sent";
    if (revision.status === "ACCEPTED") return "Quote accepted";
    if (revision.status === "REJECTED") return "Quote closed";
    return "Quote decision updated";
  }
  if (revision.eventType === "STATUS_CHANGED") {
    if (revision.status === "SENT_TO_CUSTOMER") return "Quote sent";
    if (revision.status === "ACCEPTED") return "Quote accepted";
    if (revision.status === "REJECTED") return "Quote closed";
    if (revision.status === "READY_FOR_REVIEW") return "Quote completed";
    return "Quote status updated";
  }
  return "Quote updated";
}

function buildRevisionDetail(
  revision: {
    quote: { id: string; title: string };
    status: string;
    changedFields: string[];
  },
): string {
  const label = `${quoteNumber(revision.quote.id)} - ${revision.quote.title}`;
  if (revision.status === "REJECTED") return `${label} was marked rejected.`;
  if (revision.status === "ACCEPTED") return `${label} was marked accepted.`;
  if (revision.status === "SENT_TO_CUSTOMER") return label;
  if (revision.changedFields.length > 0) {
    return `${label} - ${revision.changedFields.join(", ")}`;
  }
  return label;
}

function buildOutboundTitle(channel: "EMAIL_APP" | "SMS_APP" | "COPY" | "NATIVE_SHARE"): string {
  if (channel === "EMAIL_APP") return "Quote prepared for email";
  if (channel === "SMS_APP") return "Quote prepared for text";
  if (channel === "NATIVE_SHARE") return "Quote shared from device";
  return "Quote message copied";
}

function retainedCustomerWasInactive(customer: {
  archivedAtUtc?: Date | null;
  deletedAtUtc?: Date | null;
}) {
  return Boolean(customer.archivedAtUtc || customer.deletedAtUtc);
}

function isInactiveDuplicateMatch(match: {
  archivedAtUtc: string | null;
  deletedAtUtc: string | null;
}) {
  return Boolean(match.archivedAtUtc || match.deletedAtUtc);
}

function formatCustomerPhoneResponse<T extends { phone: string }>(customer: T): T {
  return {
    ...customer,
    phone: normalizeCustomerPhone(customer.phone),
  };
}

type DuplicateCustomerCandidate = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  createdAt: Date;
  archivedAtUtc: Date | null;
  deletedAtUtc: Date | null;
};

async function loadPhoneMatchCandidates(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  normalizedPhoneDigits: string,
  options?: {
    excludeCustomerId?: string;
    limit?: number;
    activeOnly?: boolean;
    assignedTenantUserId?: string;
  },
): Promise<DuplicateCustomerCandidate[]> {
  const limit = options?.limit ?? 5;
  return prisma.customer.findMany({
    where: {
      ...tenantScope(tenantId),
      ...(options?.assignedTenantUserId
        ? { assignedTenantUserId: options.assignedTenantUserId }
        : {}),
      phoneDigits: normalizedPhoneDigits,
      ...(options?.excludeCustomerId ? { id: { not: options.excludeCustomerId } } : {}),
      ...(options?.activeOnly
        ? {
            archivedAtUtc: null,
            deletedAtUtc: null,
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      createdAt: true,
      archivedAtUtc: true,
      deletedAtUtc: true,
    },
  });
}

function deriveCustomerStage(
  followUpStatus: z.infer<typeof LeadFollowUpStatusSchema>,
  latestQuoteStatus?: string,
): z.infer<typeof CustomerStageSchema> {
  // Explicit customer outcomes override quote state. Otherwise the latest active quote
  // is the sole workflow signal so an older accepted/rejected quote cannot pin the customer.
  if (followUpStatus === "WON") return "WON";
  if (followUpStatus === "LOST") return "LOST";
  if (latestQuoteStatus === "ACCEPTED") return "WON";
  if (latestQuoteStatus === "REJECTED") return "LOST";
  if (latestQuoteStatus === "SENT_TO_CUSTOMER") return "SENT";
  if (latestQuoteStatus === "READY_FOR_REVIEW") return "READY";
  if (followUpStatus === "FOLLOWED_UP") return "CONTACTED";
  return "NEW";
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function customerLifecycleSql(lifecycle: z.infer<typeof CustomerLifecycleSchema>): Prisma.Sql {
  if (lifecycle === "archived") {
    return Prisma.sql`customer."archivedAtUtc" IS NOT NULL AND customer."deletedAtUtc" IS NULL`;
  }
  if (lifecycle === "deleted") {
    return Prisma.sql`customer."deletedAtUtc" IS NOT NULL`;
  }
  return Prisma.sql`customer."archivedAtUtc" IS NULL AND customer."deletedAtUtc" IS NULL`;
}

function customerSearchSql(input: {
  tenantId: string;
  assignedTenantUserId?: string;
  searchTerm?: string;
  normalizedSearchDigits?: string | null;
}): Prisma.Sql {
  if (!input.searchTerm) return Prisma.empty;

  const searchPattern = `%${escapeLikePattern(input.searchTerm)}%`;
  const phonePattern = input.normalizedSearchDigits && input.normalizedSearchDigits.length >= 2
    ? `%${input.normalizedSearchDigits}%`
    : null;
  return Prisma.sql`
    AND (
      customer."fullName" ILIKE ${searchPattern} ESCAPE E'\\\\'
      OR customer."email" ILIKE ${searchPattern} ESCAPE E'\\\\'
      OR customer."phone" ILIKE ${searchPattern} ESCAPE E'\\\\'
      ${phonePattern ? Prisma.sql`OR customer."phoneDigits" LIKE ${phonePattern}` : Prisma.empty}
      OR EXISTS (
        SELECT 1
        FROM "Quote" search_quote
        WHERE search_quote."tenantId" = ${input.tenantId}
          AND search_quote."customerId" = customer."id"
          ${input.assignedTenantUserId
            ? Prisma.sql`AND search_quote."assignedTenantUserId" = ${input.assignedTenantUserId}`
            : Prisma.empty}
          AND search_quote."archivedAtUtc" IS NULL
          AND search_quote."deletedAtUtc" IS NULL
          AND search_quote."title" ILIKE ${searchPattern} ESCAPE E'\\\\'
      )
    )`;
}

function customerAssignmentSql(assignedTenantUserId?: string): Prisma.Sql {
  return assignedTenantUserId
    ? Prisma.sql`AND customer."assignedTenantUserId" = ${assignedTenantUserId}`
    : Prisma.empty;
}

function customerStageScopeSql(input: {
  tenantId: string;
  assignedTenantUserId?: string;
  lifecycle: z.infer<typeof CustomerLifecycleSchema>;
  searchTerm?: string;
  normalizedSearchDigits?: string | null;
}): Prisma.Sql {
  const searchSql = customerSearchSql(input);

  return Prisma.sql`
    WITH scoped_customers AS (
      SELECT
        customer."id",
        customer."updatedAt",
        CASE
          WHEN customer."followUpStatus"::text = 'WON' THEN 'WON'
          WHEN customer."followUpStatus"::text = 'LOST' THEN 'LOST'
          WHEN latest_quote."status"::text = 'ACCEPTED' THEN 'WON'
          WHEN latest_quote."status"::text = 'REJECTED' THEN 'LOST'
          WHEN latest_quote."status"::text = 'SENT_TO_CUSTOMER' THEN 'SENT'
          WHEN latest_quote."status"::text = 'READY_FOR_REVIEW' THEN 'READY'
          WHEN customer."followUpStatus"::text = 'FOLLOWED_UP' THEN 'CONTACTED'
          ELSE 'NEW'
        END AS stage
      FROM "Customer" customer
      LEFT JOIN LATERAL (
        SELECT quote."status"
        FROM "Quote" quote
        WHERE quote."tenantId" = ${input.tenantId}
          AND quote."customerId" = customer."id"
          ${input.assignedTenantUserId
            ? Prisma.sql`AND quote."assignedTenantUserId" = ${input.assignedTenantUserId}`
            : Prisma.empty}
          AND quote."archivedAtUtc" IS NULL
          AND quote."deletedAtUtc" IS NULL
        ORDER BY quote."updatedAt" DESC, quote."id" DESC
        LIMIT 1
      ) latest_quote ON TRUE
      WHERE customer."tenantId" = ${input.tenantId}
        ${customerAssignmentSql(input.assignedTenantUserId)}
        AND ${customerLifecycleSql(input.lifecycle)}
        ${searchSql}
    )`;
}

type CustomerStagePageRow = { id: string };
type CustomerStageAggregateRow = {
  total: bigint;
  newCount: bigint;
  contactedCount: bigint;
  readyCount: bigint;
  sentCount: bigint;
  wonCount: bigint;
  lostCount: bigint;
};
type CustomerLifecycleAggregateRow = {
  activeCount: bigint;
  archivedCount: bigint;
  deletedCount: bigint;
};

export const customerRoutes: FastifyPluginAsync = async (app) => {
  async function resolveRequestedAssignee(
    access: AccessContext,
    requested: string | null | undefined,
  ): Promise<{ allowed: true; assignedTenantUserId: string | null } | { allowed: false }> {
    if (!hasCapability(access, "manageAssignments")) {
      if (requested !== undefined && requested !== access.tenantUserId) return { allowed: false };
      return { allowed: true, assignedTenantUserId: access.tenantUserId };
    }
    if (requested === null) return { allowed: true, assignedTenantUserId: null };
    if (requested === undefined) {
      return { allowed: true, assignedTenantUserId: defaultAssigneeForCreatedRecord(access) };
    }
    const valid = await validateActiveTenantAssignee(app.prisma, {
      tenantId: access.tenantId,
      tenantUserId: requested,
    });
    return valid ? { allowed: true, assignedTenantUserId: requested } : { allowed: false };
  }

  async function runSerializableCustomerWrite<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastSerializationError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await app.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          lastSerializationError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastSerializationError;
  }

  app.post("/customers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateCustomerSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const assignee = await resolveRequestedAssignee(access, payload.assignedTenantUserId);
    if (!assignee.allowed) {
      return reply.code(403).send({ error: "Choose an active member from this workspace." });
    }
    const recordScope = assignedRecordScope(access);

    const normalizedPhone = normalizeCustomerPhone(payload.phone);
    const normalizedPhoneDigits = normalizePhoneSearchDigits(payload.phone);
    const normalizedEmail = payload.email?.trim().toLowerCase() ?? null;
    const [exactPhoneMatches, emailMatches] = await Promise.all([
      app.prisma.customer.findMany({
        where: {
          ...tenantScope(claims.tenantId),
          ...recordScope,
          phone: normalizedPhone,
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          archivedAtUtc: true,
          deletedAtUtc: true,
          createdAt: true,
        },
      }),
      normalizedEmail
        ? app.prisma.customer.findMany({
            where: {
              ...tenantScope(claims.tenantId),
              ...recordScope,
              email: normalizedEmail,
            },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              archivedAtUtc: true,
              deletedAtUtc: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const phoneMatches =
      exactPhoneMatches.length > 0
        ? exactPhoneMatches
        : normalizedPhoneDigits
          ? await loadPhoneMatchCandidates(app.prisma, claims.tenantId, normalizedPhoneDigits, {
              limit: 5,
              assignedTenantUserId: recordScope.assignedTenantUserId,
            })
          : [];

    const matchMap = new Map<string, (typeof phoneMatches)[number]>();
    for (const candidate of phoneMatches) {
      matchMap.set(candidate.id, candidate);
    }
    for (const candidate of emailMatches) {
      matchMap.set(candidate.id, candidate);
    }

    const duplicateMatches = [...matchMap.values()].map((candidate) => {
      const matchReasons: ("phone" | "email")[] = [];
      if (phoneNumbersEquivalent(candidate.phone, normalizedPhone)) {
        matchReasons.push("phone");
      }
      if (
        normalizedEmail &&
        candidate.email &&
        candidate.email === normalizedEmail
      ) {
        matchReasons.push("email");
      }

      return {
        id: candidate.id,
        fullName: candidate.fullName,
        phone: normalizeCustomerPhone(candidate.phone),
        email: candidate.email,
        archivedAtUtc: candidate.archivedAtUtc?.toISOString() ?? null,
        deletedAtUtc: candidate.deletedAtUtc?.toISOString() ?? null,
        createdAt: candidate.createdAt.toISOString(),
        matchReasons,
      };
    }).filter((match) => match.matchReasons.length > 0);
    const sortedDuplicateMatches = [...duplicateMatches].sort((left, right) => {
      const leftHasPhone = left.matchReasons.includes("phone") ? 0 : 1;
      const rightHasPhone = right.matchReasons.includes("phone") ? 0 : 1;
      if (leftHasPhone !== rightHasPhone) return leftHasPhone - rightHasPhone;

      const leftInactive = isInactiveDuplicateMatch(left) ? 1 : 0;
      const rightInactive = isInactiveDuplicateMatch(right) ? 1 : 0;
      if (leftInactive !== rightInactive) return leftInactive - rightInactive;

      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

    if (sortedDuplicateMatches.length > 0 && !payload.duplicateAction) {
      return reply.code(409).send({
        code: "DUPLICATE_CANDIDATE",
        error: "Potential duplicate customer found.",
        matches: DuplicateMatchSummarySchema.array().parse(sortedDuplicateMatches),
      });
    }

    const hasPhoneDuplicate = sortedDuplicateMatches.some((match) =>
      match.matchReasons.includes("phone"),
    );

    if (payload.duplicateAction === "merge") {
      const targetId = payload.duplicateCustomerId ?? sortedDuplicateMatches[0]?.id;
      if (!targetId) {
        return reply.code(400).send({ error: "Choose a customer record to merge into." });
      }

      const selectedCurrentMatch = sortedDuplicateMatches.find((match) => match.id === targetId);
      if (!selectedCurrentMatch) {
        return reply.code(409).send({
          code: "STALE_DUPLICATE_TARGET",
          error: "The selected record no longer matches this customer. Review the latest duplicate results.",
          matches: DuplicateMatchSummarySchema.array().parse(sortedDuplicateMatches),
        });
      }

      const actor = await resolveActivityActor(app.prisma, claims);

      const mergeOutcome = await runSerializableCustomerWrite(async (tx) => {
        const target = await tx.customer.findFirst({
          where: { id: targetId, ...tenantScope(claims.tenantId), ...recordScope },
        });
        if (!target) return { kind: "not_found" as const };

        const targetEmail = target.email?.trim().toLowerCase() ?? null;
        const stillMatchesPhone = phoneNumbersEquivalent(target.phone, normalizedPhone);
        const stillMatchesEmail = Boolean(normalizedEmail && targetEmail === normalizedEmail);
        if (!stillMatchesPhone && !stillMatchesEmail) {
          return { kind: "stale" as const };
        }
        if (
          !stillMatchesPhone ||
          (targetEmail && normalizedEmail && targetEmail !== normalizedEmail)
        ) {
          return { kind: "contact_conflict" as const };
        }

        const wasInactive = retainedCustomerWasInactive(target);
        const mergedName = payload.fullName.trim() || target.fullName;
        const mergedEmail = targetEmail || normalizedEmail;
        const mergedNotes = payload.notes?.trim() ? payload.notes.trim() : target.notes;
        const mergedCustomer = await tx.customer.update({
          where: { id_tenantId: { id: target.id, tenantId: claims.tenantId } },
          data: {
            fullName: mergedName,
            phone: normalizeCustomerPhone(target.phone),
            phoneDigits: normalizePhoneSearchDigits(target.phone),
            email: mergedEmail,
            notes: mergedNotes,
            ...(payload.followUpStatus
              ? {
                  followUpStatus: payload.followUpStatus,
                  followUpUpdatedAtUtc: new Date(),
                }
              : {}),
            archivedAtUtc: null,
            deletedAtUtc: null,
            assignedTenantUserId: assignee.assignedTenantUserId,
          },
        });
        const activityEvents: Prisma.CustomerActivityEventCreateManyInput[] = [
          {
            tenantId: claims.tenantId,
            customerId: mergedCustomer.id,
            actorUserId: actor.actorUserId,
            actorEmail: actor.actorEmail,
            actorName: actor.actorName,
            eventType: retainedCustomerWasInactive(target) ? "RESTORED" : "MERGED",
            title: retainedCustomerWasInactive(target) ? "Customer restored" : "Customer merged",
            detail: retainedCustomerWasInactive(target)
              ? `${mergedCustomer.fullName} was restored and updated.`
              : `${mergedCustomer.fullName} was merged into the existing customer record.`,
          },
        ];
        if (payload.notes?.trim() && payload.notes.trim() !== (target.notes ?? "")) {
          activityEvents.push({
            tenantId: claims.tenantId,
            customerId: mergedCustomer.id,
            actorUserId: actor.actorUserId,
            actorEmail: actor.actorEmail,
            actorName: actor.actorName,
            eventType: "NOTES_UPDATED",
            title: "Customer notes updated",
            detail: payload.notes.trim().slice(0, 500),
          });
        }
        await tx.customerActivityEvent.createMany({ data: activityEvents });

        return { kind: "merged" as const, customer: mergedCustomer, restored: wasInactive };
      });

      if (mergeOutcome.kind === "not_found") {
        return reply.code(404).send({ error: "Customer selected for merge was not found." });
      }
      if (mergeOutcome.kind === "stale") {
        return reply.code(409).send({
          code: "STALE_DUPLICATE_TARGET",
          error: "The selected record changed and no longer matches this customer. Review duplicates again.",
        });
      }
      if (mergeOutcome.kind === "contact_conflict") {
        return reply.code(409).send({
          code: "MERGE_CONTACT_CONFLICT",
          error: "Merge stopped because both records contain different contact details. Use the existing record or save this customer separately.",
        });
      }

      return reply.send({
        customer: formatCustomerPhoneResponse(mergeOutcome.customer),
        merged: true,
        restored: mergeOutcome.restored,
      });
    }

    if (payload.duplicateAction === "use_existing") {
      const targetId = payload.duplicateCustomerId ?? sortedDuplicateMatches[0]?.id;
      if (!targetId) {
        return reply.code(400).send({ error: "Choose a customer record to continue with." });
      }

      const selectedCurrentMatch = sortedDuplicateMatches.find((match) => match.id === targetId);
      if (!selectedCurrentMatch) {
        return reply.code(409).send({
          code: "STALE_DUPLICATE_TARGET",
          error: "The selected record no longer matches this customer. Review the latest duplicate results.",
          matches: DuplicateMatchSummarySchema.array().parse(sortedDuplicateMatches),
        });
      }

      const existingCustomer = await app.prisma.customer.findFirst({
        where: { id: targetId, ...tenantScope(claims.tenantId), ...recordScope },
      });

      if (!existingCustomer) {
        return reply.code(404).send({ error: "Selected customer was not found." });
      }

      if (retainedCustomerWasInactive(existingCustomer)) {
        return reply.code(409).send({
          code: "USE_EXISTING_REQUIRES_RESTORE",
          error: "Selected customer is archived. Use merge to restore and continue.",
        });
      }

      return reply.send({
        customer: formatCustomerPhoneResponse(existingCustomer),
        reusedExisting: true,
      });
    }

    if (payload.duplicateAction === "create_new" && hasPhoneDuplicate) {
      return reply.code(409).send({
        code: "PHONE_CONFLICT",
        error: "This phone number is already in use. Use merge for this customer.",
      });
    }

    try {
      const actor = await resolveActivityActor(app.prisma, claims);
      const customer = await app.prisma.$transaction(async (tx) => {
        const createdCustomer = await tx.customer.create({
          data: {
            tenantId: claims.tenantId,
            fullName: payload.fullName.trim(),
            phone: normalizedPhone,
            phoneDigits: normalizedPhoneDigits,
            email: normalizedEmail,
            notes: payload.notes,
            followUpStatus: payload.followUpStatus,
            followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
            assignedTenantUserId: assignee.assignedTenantUserId,
          },
        });
        const activityEvents: Prisma.CustomerActivityEventCreateManyInput[] = [
          {
            tenantId: claims.tenantId,
            customerId: createdCustomer.id,
            actorUserId: actor.actorUserId,
            actorEmail: actor.actorEmail,
            actorName: actor.actorName,
            eventType: "CREATED",
            title: "Customer added",
            detail: `${createdCustomer.fullName} was added to the workspace.`,
          },
        ];
        if (payload.followUpStatus) {
          activityEvents.push({
            tenantId: claims.tenantId,
            customerId: createdCustomer.id,
            actorUserId: actor.actorUserId,
            actorEmail: actor.actorEmail,
            actorName: actor.actorName,
            eventType: "STATUS_CHANGED",
            title: "Customer status updated",
            detail: `Marked as ${formatFollowUpStatus(payload.followUpStatus)}.`,
          });
        }
        if (payload.notes?.trim()) {
          activityEvents.push({
            tenantId: claims.tenantId,
            customerId: createdCustomer.id,
            actorUserId: actor.actorUserId,
            actorEmail: actor.actorEmail,
            actorName: actor.actorName,
            eventType: "NOTES_ADDED",
            title: "Customer notes added",
            detail: payload.notes.trim().slice(0, 500),
          });
        }
        await tx.customerActivityEvent.createMany({ data: activityEvents });

        return createdCustomer;
      });

      return reply.code(201).send({ customer: formatCustomerPhoneResponse(customer) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({
          code: "PHONE_CONFLICT",
          error: "Phone already used by another customer. Use merge instead.",
        });
      }
      throw error;
    }
  });

  app.get("/customers", { preHandler: [app.authenticate] }, async (request) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const recordScope = assignedRecordScope(access);
    const query = ListCustomersQuerySchema.parse(request.query);
    const searchTerm = query.search?.trim();
    const normalizedSearchDigits = normalizePhoneSearchDigits(searchTerm);
    const stageScopeSql = customerStageScopeSql({
      tenantId: claims.tenantId,
      assignedTenantUserId: recordScope.assignedTenantUserId,
      lifecycle: query.lifecycle,
      searchTerm,
      normalizedSearchDigits,
    });
    const lifecycleSearchSql = customerSearchSql({
      tenantId: claims.tenantId,
      assignedTenantUserId: recordScope.assignedTenantUserId,
      searchTerm,
      normalizedSearchDigits,
    });
    const selectedStageWhere = query.stage
      ? Prisma.sql`WHERE stage = ${query.stage}`
      : Prisma.empty;
    const selectedStageAggregateFilter = query.stage
      ? Prisma.sql`stage = ${query.stage}`
      : Prisma.sql`TRUE`;

    const listResult = await measureRequestPerformance(request, "db", () => app.prisma.$transaction(async (tx) => {
      const pageRows = await tx.$queryRaw<CustomerStagePageRow[]>(Prisma.sql`
        ${stageScopeSql}
        SELECT id
        FROM scoped_customers
        ${selectedStageWhere}
        ORDER BY "updatedAt" DESC, id DESC
        LIMIT ${query.limit}
        OFFSET ${query.offset}
      `);
      const aggregateRows = await tx.$queryRaw<CustomerStageAggregateRow[]>(Prisma.sql`
        ${stageScopeSql}
        SELECT
          COUNT(*) FILTER (WHERE ${selectedStageAggregateFilter})::bigint AS "total",
          COUNT(*) FILTER (WHERE stage = 'NEW')::bigint AS "newCount",
          COUNT(*) FILTER (WHERE stage = 'CONTACTED')::bigint AS "contactedCount",
          COUNT(*) FILTER (WHERE stage = 'READY')::bigint AS "readyCount",
          COUNT(*) FILTER (WHERE stage = 'SENT')::bigint AS "sentCount",
          COUNT(*) FILTER (WHERE stage = 'WON')::bigint AS "wonCount",
          COUNT(*) FILTER (WHERE stage = 'LOST')::bigint AS "lostCount"
        FROM scoped_customers
      `);
      const lifecycleAggregateRows = await tx.$queryRaw<CustomerLifecycleAggregateRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (
            WHERE customer."archivedAtUtc" IS NULL AND customer."deletedAtUtc" IS NULL
          )::bigint AS "activeCount",
          COUNT(*) FILTER (
            WHERE customer."archivedAtUtc" IS NOT NULL AND customer."deletedAtUtc" IS NULL
          )::bigint AS "archivedCount",
          COUNT(*) FILTER (
            WHERE customer."deletedAtUtc" IS NOT NULL
          )::bigint AS "deletedCount"
        FROM "Customer" customer
        WHERE customer."tenantId" = ${claims.tenantId}
          ${customerAssignmentSql(recordScope.assignedTenantUserId)}
          ${lifecycleSearchSql}
      `);
      const lifecycleAggregates = lifecycleAggregateRows[0] ?? {
        activeCount: 0n,
        archivedCount: 0n,
        deletedCount: 0n,
      };
      const pageIds = pageRows.map((row) => row.id);
      const customerRecords = pageIds.length
        ? await tx.customer.findMany({
          where: {
            id: { in: pageIds },
            ...tenantScope(claims.tenantId),
            ...recordScope,
          },
          include: {
            assignedTenantUser: { select: WorkspaceAssigneeSelect },
            _count: {
              select: {
                quotes: {
                  where: {
                    ...tenantActiveQuoteScope(claims.tenantId),
                    ...recordScope,
                  },
                },
              },
            },
            quotes: {
              where: {
                ...tenantActiveQuoteScope(claims.tenantId),
                ...recordScope,
              },
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 1,
              select: {
                id: true,
                title: true,
                status: true,
                jobStatus: true,
                totalAmount: true,
                updatedAt: true,
                archivedAtUtc: true,
                deletedAtUtc: true,
              },
            },
          },
        })
        : [];

      return {
        pageIds,
        customerRecords,
        aggregates: aggregateRows[0] ?? {
          total: 0n,
          newCount: 0n,
          contactedCount: 0n,
          readyCount: 0n,
          sentCount: 0n,
          wonCount: 0n,
          lostCount: 0n,
        },
        lifecycleCounts: lifecycleAggregates,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 10_000,
    }));

    const { pageIds, customerRecords, aggregates } = listResult;
    const { activeCount, archivedCount, deletedCount } = listResult.lifecycleCounts;
    const total = Number(aggregates.total);
    const stageCounts: Record<z.infer<typeof CustomerStageSchema>, number> = {
      NEW: Number(aggregates.newCount),
      CONTACTED: Number(aggregates.contactedCount),
      READY: Number(aggregates.readyCount),
      SENT: Number(aggregates.sentCount),
      WON: Number(aggregates.wonCount),
      LOST: Number(aggregates.lostCount),
    };
    const customerById = new Map(customerRecords.map((customer) => [customer.id, customer]));
    const customers = pageIds.flatMap((id) => {
      const customer = customerById.get(id);
      return customer ? [customer] : [];
    });

    return {
      customers: customers.map(({ quotes, _count, ...customer }) => ({
        ...formatCustomerPhoneResponse(customer),
        summary: {
          quoteCount: _count.quotes,
          latestQuote: quotes[0] ?? null,
          stage: deriveCustomerStage(customer.followUpStatus, quotes[0]?.status),
        },
      })),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      summary: {
        lifecycleCounts: {
          active: Number(activeCount),
          archived: Number(archivedCount),
          deleted: Number(deletedCount),
        },
        stageCounts,
      },
    };
  });

  app.get("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);

    const customer = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      include: {
        assignedTenantUser: { select: WorkspaceAssigneeSelect },
        quotes: {
          where: {
            ...tenantActiveQuoteScope(claims.tenantId),
            ...assignedRecordScope(access),
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            title: true,
            status: true,
            jobStatus: true,
            totalAmount: true,
            updatedAt: true,
            archivedAtUtc: true,
            deletedAtUtc: true,
          },
        },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    const { quotes, ...customerRecord } = customer;
    return {
      customer: {
        ...formatCustomerPhoneResponse(customerRecord),
        summary: {
          quoteCount: quotes.length,
          latestQuote: quotes[0] ?? null,
          stage: deriveCustomerStage(customerRecord.followUpStatus, quotes[0]?.status),
        },
      },
      quotes,
    };
  });

  app.get("/customers/:customerId/activity", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const query = CustomerActivityQuerySchema.parse(request.query);

    const customer = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      select: { id: true, fullName: true },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    const take = query.limit + query.offset;

    const [customerEvents, revisions, outboundEvents, customerEventCount, revisionCount, outboundCount] = await Promise.all([
      app.prisma.customerActivityEvent.findMany({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
        },
        orderBy: { createdAt: "desc" },
        take,
      }),
      app.prisma.quoteRevision.findMany({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
          ...(!hasCapability(access, "viewAllWorkspaceRecords")
            ? { quote: { assignedTenantUserId: access.tenantUserId } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { version: "desc" }],
        take,
        select: {
          id: true,
          quoteId: true,
          version: true,
          eventType: true,
          changedFields: true,
          title: true,
          status: true,
          createdAt: true,
          actorUserId: true,
          actorEmail: true,
          actorName: true,
          quote: {
            select: {
              id: true,
              title: true,
              archivedAtUtc: true,
              deletedAtUtc: true,
            },
          },
        },
      }),
      app.prisma.quoteOutboundEvent.findMany({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
          ...(!hasCapability(access, "viewAllWorkspaceRecords")
            ? { quote: { assignedTenantUserId: access.tenantUserId } }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true,
          quoteId: true,
          channel: true,
          destination: true,
          subject: true,
          bodyPreview: true,
          createdAt: true,
          actorUserId: true,
          actorEmail: true,
          actorName: true,
          quote: {
            select: {
              id: true,
              title: true,
              archivedAtUtc: true,
              deletedAtUtc: true,
            },
          },
        },
      }),
      app.prisma.customerActivityEvent.count({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
        },
      }),
      app.prisma.quoteRevision.count({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
          ...(!hasCapability(access, "viewAllWorkspaceRecords")
            ? { quote: { assignedTenantUserId: access.tenantUserId } }
            : {}),
        },
      }),
      app.prisma.quoteOutboundEvent.count({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
          ...(!hasCapability(access, "viewAllWorkspaceRecords")
            ? { quote: { assignedTenantUserId: access.tenantUserId } }
            : {}),
        },
      }),
    ]);

    const items = [
      ...customerEvents.map((event) => ({
        id: event.id,
        sourceType: "customer_event" as const,
        eventType: event.eventType,
        occurredAt: event.createdAt,
        title: event.title,
        detail: event.detail ?? "",
        actorUserId: event.actorUserId,
        actorEmail: event.actorEmail,
        actorName: event.actorName,
        quoteId: null,
        quoteTitle: null,
        version: null,
        channel: null,
      })),
      ...revisions.map((revision) => ({
        id: revision.id,
        sourceType: "quote_revision" as const,
        eventType: revision.eventType,
        occurredAt: revision.createdAt,
        title: buildRevisionTitle(revision),
        detail: buildRevisionDetail(revision),
        actorUserId: revision.actorUserId,
        actorEmail: revision.actorEmail,
        actorName: revision.actorName,
        quoteId: revision.quote.archivedAtUtc || revision.quote.deletedAtUtc ? null : revision.quote.id,
        quoteTitle: revision.quote.title,
        version: revision.version,
        channel: null,
      })),
      ...outboundEvents.map((event) => ({
        id: event.id,
        sourceType: "quote_outbound" as const,
        eventType: event.channel,
        occurredAt: event.createdAt,
        title: buildOutboundTitle(event.channel),
        detail: event.destination
          ? `${quoteNumber(event.quote.id)} - ${event.quote.title} - ${event.destination}`
          : `${quoteNumber(event.quote.id)} - ${event.quote.title}`,
        actorUserId: event.actorUserId,
        actorEmail: event.actorEmail,
        actorName: event.actorName,
        quoteId: event.quote.archivedAtUtc || event.quote.deletedAtUtc ? null : event.quote.id,
        quoteTitle: event.quote.title,
        version: null,
        channel: event.channel,
      })),
    ]
      .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
      .slice(query.offset, query.offset + query.limit);

    return {
      items,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: customerEventCount + revisionCount + outboundCount,
      },
    };
  });

  app.patch("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const payload = UpdateCustomerSchema.parse(request.body);
    const assignee = payload.assignedTenantUserId !== undefined
      ? await resolveRequestedAssignee(access, payload.assignedTenantUserId)
      : null;
    if (assignee && !assignee.allowed) {
      return reply.code(403).send({ error: "Choose an active member from this workspace." });
    }
    const recordScope = assignedRecordScope(access);
    const actor = await resolveActivityActor(app.prisma, claims);
    const normalizedPhone =
      payload.phone === undefined ? undefined : normalizeCustomerPhone(payload.phone);
    const normalizedPhoneDigits =
      normalizedPhone === undefined ? undefined : normalizePhoneSearchDigits(normalizedPhone);
    const normalizedEmail =
      payload.email === undefined ? undefined : payload.email === null ? null : payload.email.trim().toLowerCase();

    const existing = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveCustomerScope(claims.tenantId),
        ...recordScope,
      },
    });

    if (!existing) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    if (normalizedPhone !== undefined && !phoneNumbersEquivalent(normalizedPhone, existing.phone)) {
      const exactPhoneConflict = await app.prisma.customer.findFirst({
        where: {
          ...tenantScope(claims.tenantId),
          phone: normalizedPhone,
          id: { not: existing.id },
        },
        select: { id: true },
      });
      if (exactPhoneConflict) {
        return reply.code(409).send({ error: "Phone already used by another customer in this workspace." });
      }

      if (normalizedPhoneDigits) {
        const digitPhoneConflict = await app.prisma.customer.findFirst({
          where: {
            ...tenantScope(claims.tenantId),
            phoneDigits: normalizedPhoneDigits,
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (digitPhoneConflict) {
          return reply.code(409).send({ error: "Phone already used by another customer in this workspace." });
        }
      }
    }

    if (
      normalizedEmail !== undefined &&
      normalizedEmail !== (existing.email ? existing.email.toLowerCase() : existing.email)
    ) {
      if (normalizedEmail) {
        const emailConflict = await app.prisma.customer.findFirst({
          where: {
            ...tenantScope(claims.tenantId),
            email: normalizedEmail,
            id: { not: existing.id },
          },
        });

        if (emailConflict) {
          return reply.code(409).send({ error: "Email already used by another customer in this workspace." });
        }
      }
    }

    const customer = await app.prisma.$transaction(async (tx) => {
      const updatedCustomer = await tx.customer.update({
        where: { id: existing.id },
        data: {
          fullName: payload.fullName,
          phone: normalizedPhone,
          phoneDigits: normalizedPhoneDigits,
          email: normalizedEmail,
          notes: payload.notes,
          followUpStatus: payload.followUpStatus,
          followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
          ...(assignee ? { assignedTenantUserId: assignee.assignedTenantUserId } : {}),
        },
      });

      const changedIdentityFields: string[] = [];
      if (payload.fullName !== undefined && payload.fullName !== existing.fullName) changedIdentityFields.push("name");
      if (
        normalizedPhone !== undefined &&
        !phoneNumbersEquivalent(normalizedPhone, existing.phone)
      ) changedIdentityFields.push("phone");
      if (normalizedEmail !== undefined && normalizedEmail !== existing.email) changedIdentityFields.push("email");

      if (changedIdentityFields.length > 0) {
        await createCustomerActivityEvent(tx, {
          tenantId: claims.tenantId,
          customerId: updatedCustomer.id,
          actor,
          eventType: "UPDATED",
          title: "Customer updated",
          detail: `Updated ${changedIdentityFields.join(", ")}.`,
        });
      }

      if (payload.notes !== undefined && payload.notes !== existing.notes) {
        await createCustomerActivityEvent(tx, {
          tenantId: claims.tenantId,
          customerId: updatedCustomer.id,
          actor,
          eventType: payload.notes?.trim() ? "NOTES_UPDATED" : "NOTES_CLEARED",
          title: payload.notes?.trim() ? "Customer notes updated" : "Customer notes cleared",
          detail: payload.notes?.trim() ? payload.notes.trim().slice(0, 500) : "Notes were cleared.",
        });
        await markCustomerAiRetrievalSourcesDeleted(tx, {
          tenantId: claims.tenantId,
          customerIds: [updatedCustomer.id],
        });
      }

      if (payload.followUpStatus && payload.followUpStatus !== existing.followUpStatus) {
        await createCustomerActivityEvent(tx, {
          tenantId: claims.tenantId,
          customerId: updatedCustomer.id,
          actor,
          eventType: "STATUS_CHANGED",
          title: "Customer status updated",
          detail: `Marked as ${formatFollowUpStatus(payload.followUpStatus)}.`,
        });
      }

      return updatedCustomer;
    });

    return { customer: formatCustomerPhoneResponse(customer) };
  });

  app.post("/customers/:customerId/restore", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageRecordRetention")) {
      return reply.code(403).send({ error: "Only a workspace owner or admin can restore customers." });
    }
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const actor = await resolveActivityActor(app.prisma, claims);

    const restored = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          id: customerId,
          ...tenantScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
      });

      if (!existing) return null;
      if (!retainedCustomerWasInactive(existing)) return existing;

      const customer = await tx.customer.update({
        where: { id_tenantId: { id: existing.id, tenantId: claims.tenantId } },
        data: {
          archivedAtUtc: null,
          deletedAtUtc: null,
        },
      });

      await createCustomerActivityEvent(tx, {
        tenantId: claims.tenantId,
        customerId: customer.id,
        actor,
        eventType: "RESTORED",
        title: "Customer restored",
        detail: "Customer was restored to the active workspace. Retained quotes were not restored automatically.",
      });

      return customer;
    });

    if (!restored) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return {
      customer: formatCustomerPhoneResponse(restored),
      restoredQuoteCount: 0,
    };
  });

  app.post("/customers/:customerId/archive", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageRecordRetention")) {
      return reply.code(403).send({ error: "Only a workspace owner or admin can archive customers." });
    }
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const actor = await resolveActivityActor(app.prisma, claims);
    const now = new Date();

    const archived = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          id: customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true, fullName: true },
      });

      if (!existing) {
        return false;
      }

      const relatedQuotes = await tx.quote.findMany({
        where: {
          customerId: existing.id,
          ...tenantActiveQuoteScope(claims.tenantId),
        },
        select: { id: true },
      });

      await createCustomerActivityEvent(tx, {
        tenantId: claims.tenantId,
        customerId: existing.id,
        actor,
        eventType: "ARCHIVED",
        title: "Customer archived",
        detail: relatedQuotes.length
          ? `Customer was archived from the workspace. ${relatedQuotes.length} related quote(s) were archived as well.`
          : "Customer was archived from the workspace.",
      });

      await tx.quote.updateMany({
        where: {
          id: { in: relatedQuotes.map((quote) => quote.id) },
          ...tenantActiveQuoteScope(claims.tenantId),
        },
        data: {
          archivedAtUtc: now,
          deletedAtUtc: null,
        },
      });

      await markQuoteAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        quoteIds: relatedQuotes.map((quote) => quote.id),
        now,
      });

      await tx.customer.update({
        where: { id: existing.id },
        data: {
          archivedAtUtc: now,
          deletedAtUtc: null,
        },
      });

      await markCustomerAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        customerIds: [existing.id],
        now,
      });

      return true;
    });

    if (!archived) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return reply.code(204).send();
  });

  app.delete("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageRecordRetention")) {
      return reply.code(403).send({ error: "Only a workspace owner or admin can delete customers." });
    }
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const actor = await resolveActivityActor(app.prisma, claims);
    const now = new Date();

    const deleted = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          id: customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true, fullName: true },
      });

      if (!existing) {
        return false;
      }

      const relatedQuotes = await tx.quote.findMany({
        where: {
          customerId: existing.id,
          ...tenantActiveQuoteScope(claims.tenantId),
        },
        select: { id: true },
      });

      await createCustomerActivityEvent(tx, {
        tenantId: claims.tenantId,
        customerId: existing.id,
        actor,
        eventType: "DELETED",
        title: "Customer deleted",
        detail: relatedQuotes.length
          ? `Customer was removed from the active workspace. ${relatedQuotes.length} related quote(s) were deleted as well.`
          : "Customer was removed from the active workspace.",
      });

      if (relatedQuotes.length) {
        const relatedQuoteIds = relatedQuotes.map((quote) => quote.id);

        await tx.quote.updateMany({
          where: {
            id: { in: relatedQuoteIds },
            ...tenantActiveQuoteScope(claims.tenantId),
          },
          data: {
            archivedAtUtc: null,
            deletedAtUtc: now,
          },
        });

        await tx.quoteLineItem.updateMany({
          where: {
            quoteId: { in: relatedQuoteIds },
            ...tenantActiveScope(claims.tenantId),
          },
          data: { deletedAtUtc: now },
        });

        await tx.quoteDecisionSession.updateMany({
          where: {
            quoteId: { in: relatedQuoteIds },
            ...tenantActiveScope(claims.tenantId),
          },
          data: { deletedAtUtc: now },
        });
      }

      await tx.customer.update({
        where: { id: existing.id },
        data: {
          archivedAtUtc: null,
          deletedAtUtc: now,
        },
      });

      await markCustomerAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        customerIds: [existing.id],
        includeQuotes: true,
        now,
      });

      return true;
    });

    if (!deleted) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return reply.code(204).send();
  });
};
