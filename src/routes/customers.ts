import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { createCustomerActivityEvent, resolveActivityActor } from "../lib/activity";
import {
  PaginationQuerySchema,
  tenantActiveCustomerScope,
  tenantActiveQuoteScope,
  tenantActiveScope,
  tenantScope,
} from "../lib/query-scope";

const LeadFollowUpStatusSchema = z.enum([
  "NEEDS_FOLLOW_UP",
  "FOLLOWED_UP",
  "WON",
  "LOST",
]);

const CreateCustomerSchema = z.object({
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email().nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
  followUpStatus: LeadFollowUpStatusSchema.optional(),
  duplicateAction: z.enum(["merge", "create_new"]).optional(),
  duplicateCustomerId: z.string().min(1).optional(),
});

const DuplicateMatchSummarySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  deletedAtUtc: z.string().nullable(),
  createdAt: z.string(),
  matchReasons: z.array(z.enum(["phone", "email"])).min(1),
});

const ListCustomersQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
});

const CustomerParamsSchema = z.object({
  customerId: z.string().min(1),
});

const CustomerActivityQuerySchema = PaginationQuerySchema;

const UpdateCustomerSchema = z
  .object({
    fullName: z.string().min(2).optional(),
    phone: z.string().min(7).optional(),
    email: z.string().email().nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
    followUpStatus: LeadFollowUpStatusSchema.optional(),
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

function buildOutboundTitle(channel: "EMAIL_APP" | "SMS_APP" | "COPY"): string {
  if (channel === "EMAIL_APP") return "Quote prepared for email";
  if (channel === "SMS_APP") return "Quote prepared for text";
  return "Quote message copied";
}

function retainedCustomerWasInactive(customer: {
  archivedAtUtc?: Date | null;
  deletedAtUtc?: Date | null;
}) {
  return Boolean(customer.archivedAtUtc || customer.deletedAtUtc);
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/customers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateCustomerSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);

    const normalizedEmail = payload.email?.toLowerCase() ?? null;
    const phoneMatch = await app.prisma.customer.findUnique({
      where: {
        tenantId_phone: {
          tenantId: claims.tenantId,
          phone: payload.phone,
        },
      },
    });

    const emailMatches = normalizedEmail
      ? await app.prisma.customer.findMany({
          where: {
            ...tenantScope(claims.tenantId),
            email: { equals: normalizedEmail, mode: "insensitive" },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        })
      : [];

    const matchMap = new Map<string, (typeof emailMatches)[number]>();
    if (phoneMatch) {
      matchMap.set(phoneMatch.id, phoneMatch);
    }
    for (const candidate of emailMatches) {
      matchMap.set(candidate.id, candidate);
    }

    const duplicateMatches = [...matchMap.values()].map((candidate) => {
      const matchReasons: ("phone" | "email")[] = [];
      if (candidate.phone === payload.phone) {
        matchReasons.push("phone");
      }
      if (
        normalizedEmail &&
        candidate.email &&
        candidate.email.toLowerCase() === normalizedEmail.toLowerCase()
      ) {
        matchReasons.push("email");
      }

      return {
        id: candidate.id,
        fullName: candidate.fullName,
        phone: candidate.phone,
        email: candidate.email,
        deletedAtUtc: candidate.deletedAtUtc?.toISOString() ?? null,
        createdAt: candidate.createdAt.toISOString(),
        matchReasons,
      };
    });

    if (duplicateMatches.length > 0 && !payload.duplicateAction) {
      return reply.code(409).send({
        code: "DUPLICATE_CANDIDATE",
        error: "Potential duplicate customer found.",
        matches: DuplicateMatchSummarySchema.array().parse(duplicateMatches),
      });
    }

    if (payload.duplicateAction === "merge") {
      const targetId = payload.duplicateCustomerId ?? duplicateMatches[0]?.id;
      if (!targetId) {
        return reply.code(400).send({ error: "Choose a customer record to merge into." });
      }

      const target = await app.prisma.customer.findFirst({
        where: { id: targetId, ...tenantScope(claims.tenantId) },
      });

      if (!target) {
        return reply.code(404).send({ error: "Customer selected for merge was not found." });
      }

      const customer = await app.prisma.$transaction(async (tx) => {
        const mergedCustomer = await tx.customer.update({
          where: { id: target.id },
          data: {
            fullName: payload.fullName,
            phone: payload.phone,
            email: normalizedEmail,
            notes: payload.notes,
            followUpStatus: payload.followUpStatus,
            followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
            archivedAtUtc: null,
            deletedAtUtc: null,
          },
        });

        await createCustomerActivityEvent(tx, {
          tenantId: claims.tenantId,
          customerId: mergedCustomer.id,
          actor,
          eventType: retainedCustomerWasInactive(target) ? "RESTORED" : "MERGED",
          title: retainedCustomerWasInactive(target) ? "Customer restored" : "Customer merged",
          detail: retainedCustomerWasInactive(target)
            ? `${mergedCustomer.fullName} was restored and updated.`
            : `${mergedCustomer.fullName} was merged into the existing customer record.`,
        });

        if (payload.notes?.trim()) {
          await createCustomerActivityEvent(tx, {
            tenantId: claims.tenantId,
            customerId: mergedCustomer.id,
            actor,
            eventType: "NOTES_UPDATED",
            title: "Customer notes updated",
            detail: payload.notes.trim().slice(0, 500),
          });
        }

        return mergedCustomer;
      });

      return reply.send({
        customer,
        merged: true,
        restored: retainedCustomerWasInactive(target),
      });
    }

    if (payload.duplicateAction === "create_new" && phoneMatch) {
      return reply.code(409).send({
        code: "PHONE_CONFLICT",
        error: "This phone number is already in use. Use merge for this customer.",
      });
    }

    try {
      const customer = await app.prisma.$transaction(async (tx) => {
        const createdCustomer = await tx.customer.create({
          data: {
            tenantId: claims.tenantId,
            fullName: payload.fullName,
            phone: payload.phone,
            email: normalizedEmail,
            notes: payload.notes,
            followUpStatus: payload.followUpStatus,
            followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
          },
        });

        await createCustomerActivityEvent(tx, {
          tenantId: claims.tenantId,
          customerId: createdCustomer.id,
          actor,
          eventType: "CREATED",
          title: "Customer added",
          detail: `${createdCustomer.fullName} was added to the workspace.`,
        });

        if (payload.followUpStatus) {
          await createCustomerActivityEvent(tx, {
            tenantId: claims.tenantId,
            customerId: createdCustomer.id,
            actor,
            eventType: "STATUS_CHANGED",
            title: "Customer status updated",
            detail: `Marked as ${formatFollowUpStatus(payload.followUpStatus)}.`,
          });
        }

        if (payload.notes?.trim()) {
          await createCustomerActivityEvent(tx, {
            tenantId: claims.tenantId,
            customerId: createdCustomer.id,
            actor,
            eventType: "NOTES_ADDED",
            title: "Customer notes added",
            detail: payload.notes.trim().slice(0, 500),
          });
        }

        return createdCustomer;
      });

      return reply.code(201).send({ customer });
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
    const query = ListCustomersQuerySchema.parse(request.query);

    const where: Prisma.CustomerWhereInput = {
      ...tenantActiveCustomerScope(claims.tenantId),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
              { phone: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [customers, total] = await app.prisma.$transaction([
      app.prisma.customer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: query.limit,
        skip: query.offset,
      }),
      app.prisma.customer.count({ where }),
    ]);

    return {
      customers,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
    };
  });

  app.get("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);

    const customer = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveCustomerScope(claims.tenantId),
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return { customer };
  });

  app.get("/customers/:customerId/activity", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const query = CustomerActivityQuerySchema.parse(request.query);

    const customer = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveCustomerScope(claims.tenantId),
      },
      select: { id: true, fullName: true },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    const take = Math.min(query.limit + query.offset + 10, 120);

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
            },
          },
        },
      }),
      app.prisma.quoteOutboundEvent.findMany({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
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
        },
      }),
      app.prisma.quoteOutboundEvent.count({
        where: {
          customerId: customer.id,
          ...tenantActiveScope(claims.tenantId),
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
        quoteId: revision.quote.id,
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
        quoteId: event.quote.id,
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
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const payload = UpdateCustomerSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);

    const existing = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveCustomerScope(claims.tenantId),
      },
    });

    if (!existing) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    if (payload.phone && payload.phone !== existing.phone) {
      const phoneConflict = await app.prisma.customer.findFirst({
        where: {
          ...tenantActiveCustomerScope(claims.tenantId),
          phone: payload.phone,
          id: { not: existing.id },
        },
      });

      if (phoneConflict) {
        return reply.code(409).send({ error: "Phone already used by another active customer." });
      }
    }

    const customer = await app.prisma.$transaction(async (tx) => {
      const updatedCustomer = await tx.customer.update({
        where: { id: existing.id },
        data: {
          fullName: payload.fullName,
          phone: payload.phone,
          email: payload.email,
          notes: payload.notes,
          followUpStatus: payload.followUpStatus,
          followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
        },
      });

      const changedIdentityFields: string[] = [];
      if (payload.fullName !== undefined && payload.fullName !== existing.fullName) changedIdentityFields.push("name");
      if (payload.phone !== undefined && payload.phone !== existing.phone) changedIdentityFields.push("phone");
      if (payload.email !== undefined && payload.email !== existing.email) changedIdentityFields.push("email");

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

    return { customer };
  });

  app.post("/customers/:customerId/archive", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const actor = await resolveActivityActor(app.prisma, claims);
    const now = new Date();

    const archived = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          id: customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
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

      await tx.customer.update({
        where: { id: existing.id },
        data: {
          archivedAtUtc: now,
          deletedAtUtc: null,
        },
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
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const actor = await resolveActivityActor(app.prisma, claims);
    const now = new Date();

    const deleted = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          id: customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
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

      return true;
    });

    if (!deleted) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return reply.code(204).send();
  });
};
