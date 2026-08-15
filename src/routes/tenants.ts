import { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { getJwtClaims } from "../lib/auth";

const TenantWorkspaceSelect = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  primaryTrade: true,
  onboardingCompletedAtUtc: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        users: {
          some: { userId: claims.userId },
        },
      },
      select: TenantWorkspaceSelect,
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    return { tenants: [tenant] };
  });
};
