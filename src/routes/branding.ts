import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const UpsertBrandingSchema = z.object({
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#5B85AA"),
  templateId: z.enum(["modern", "professional", "bold", "minimal"]).default("modern"),
});

function requireSameTenant(request: FastifyRequest, reply: FastifyReply, tenantId: string): boolean {
  const claims = getJwtClaims(request);
  if (claims.tenantId !== tenantId) {
    reply.code(403).send({ error: "Forbidden" });
    return false;
  }
  return true;
}

export const brandingRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/tenants/:tenantId/branding
  app.get(
    "/tenants/:tenantId/branding",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { tenantId } = z.object({ tenantId: z.string() }).parse(request.params);
      if (!requireSameTenant(request, reply, tenantId)) return;

      const branding = await app.prisma.tenantBranding.findUnique({
        where: { tenantId },
      });

      return { branding };
    },
  );

  // PUT /v1/tenants/:tenantId/branding
  app.put(
    "/tenants/:tenantId/branding",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { tenantId } = z.object({ tenantId: z.string() }).parse(request.params);
      if (!requireSameTenant(request, reply, tenantId)) return;

      const payload = UpsertBrandingSchema.parse(request.body);

      const branding = await app.prisma.tenantBranding.upsert({
        where: { tenantId },
        create: { tenantId, ...payload },
        update: payload,
      });

      return { branding };
    },
  );
};
