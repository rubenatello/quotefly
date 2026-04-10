import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { PaginationQuerySchema, tenantActiveScope } from "../lib/query-scope";

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

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/customers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateCustomerSchema.parse(request.body);
    const claims = getJwtClaims(request);

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
            ...tenantActiveScope(claims.tenantId),
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
        where: { id: targetId, tenantId: claims.tenantId },
      });

      if (!target) {
        return reply.code(404).send({ error: "Customer selected for merge was not found." });
      }

      const customer = await app.prisma.customer.update({
        where: { id: target.id },
        data: {
          fullName: payload.fullName,
          phone: payload.phone,
          email: normalizedEmail,
          notes: payload.notes,
          followUpStatus: payload.followUpStatus,
          followUpUpdatedAtUtc: payload.followUpStatus ? new Date() : undefined,
          deletedAtUtc: null,
        },
      });

      return reply.send({
        customer,
        merged: true,
        restored: target.deletedAtUtc !== null,
      });
    }

    if (payload.duplicateAction === "create_new" && phoneMatch) {
      return reply.code(409).send({
        code: "PHONE_CONFLICT",
        error: "This phone number is already in use. Use merge for this customer.",
      });
    }

    try {
      const customer = await app.prisma.customer.create({
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
      ...tenantActiveScope(claims.tenantId),
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
        ...tenantActiveScope(claims.tenantId),
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    return { customer };
  });

  app.patch("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);
    const payload = UpdateCustomerSchema.parse(request.body);

    const existing = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveScope(claims.tenantId),
      },
    });

    if (!existing) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    if (payload.phone && payload.phone !== existing.phone) {
      const phoneConflict = await app.prisma.customer.findFirst({
        where: {
          ...tenantActiveScope(claims.tenantId),
          phone: payload.phone,
          id: { not: existing.id },
        },
      });

      if (phoneConflict) {
        return reply.code(409).send({ error: "Phone already used by another active customer." });
      }
    }

    const customer = await app.prisma.customer.update({
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

    return { customer };
  });

  app.delete("/customers/:customerId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { customerId } = CustomerParamsSchema.parse(request.params);

    const existing = await app.prisma.customer.findFirst({
      where: {
        id: customerId,
        ...tenantActiveScope(claims.tenantId),
      },
      select: { id: true },
    });

    if (!existing) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    await app.prisma.customer.update({
      where: { id: existing.id },
      data: { deletedAtUtc: new Date() },
    });

    return reply.code(204).send();
  });
};
