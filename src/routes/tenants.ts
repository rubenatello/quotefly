import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const CreateTenantSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
});

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.post("/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateTenantSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const normalizedSlug = payload.slug.toLowerCase();

    const existingTenant = await app.prisma.tenant.findUnique({
      where: { slug: normalizedSlug },
      select: { id: true },
    });

    if (existingTenant) {
      return reply.code(409).send({ error: "Tenant slug already in use." });
    }

    const tenant = await app.prisma.tenant.create({
      data: {
        name: payload.name,
        slug: normalizedSlug,
        users: {
          create: {
            userId: claims.userId,
            role: "owner",
          },
        },
      },
    });

    return reply.code(201).send({ tenant });
  });

  app.get("/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        users: {
          some: { userId: claims.userId },
        },
      },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    return { tenants: [tenant] };
  });
};
