import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { PaginationQuerySchema, tenantActiveScope } from "../lib/query-scope";

const CreateCustomerSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
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
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required.",
  });

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/customers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateCustomerSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const existing = await app.prisma.customer.findUnique({
      where: {
        tenantId_phone: {
          tenantId: claims.tenantId,
          phone: payload.phone,
        },
      },
    });

    if (existing) {
      const customer = await app.prisma.customer.update({
        where: { id: existing.id },
        data: {
          fullName: payload.fullName,
          email: payload.email,
          notes: payload.notes,
          deletedAtUtc: null,
        },
      });

      return reply.send({ customer, restored: existing.deletedAtUtc !== null });
    }

    const customer = await app.prisma.customer.create({
      data: {
        tenantId: claims.tenantId,
        fullName: payload.fullName,
        phone: payload.phone,
        email: payload.email,
        notes: payload.notes,
      },
    });

    return reply.code(201).send({ customer });
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
