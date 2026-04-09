import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const CreateCustomerSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional(),
});

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/customers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateCustomerSchema.parse(request.body);
    const claims = getJwtClaims(request);

    const customer = await app.prisma.customer.upsert({
      where: {
        tenantId_phone: {
          tenantId: claims.tenantId,
          phone: payload.phone,
        },
      },
      create: {
        tenantId: claims.tenantId,
        fullName: payload.fullName,
        phone: payload.phone,
        email: payload.email,
      },
      update: {
        fullName: payload.fullName,
        email: payload.email,
      },
    });

    return reply.code(201).send({ customer });
  });
};
