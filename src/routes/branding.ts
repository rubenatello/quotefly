import { Prisma } from "@prisma/client";
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const BrandingComponentColorsSchema = z
  .object({
    headerBgColor: HexColorSchema.optional(),
    sectionTitleColor: HexColorSchema.optional(),
    tableHeaderBgColor: HexColorSchema.optional(),
    totalsColor: HexColorSchema.optional(),
    footerTextColor: HexColorSchema.optional(),
  })
  .nullable()
  .optional();

const UpsertBrandingSchema = z.object({
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: HexColorSchema.default("#5B85AA"),
  templateId: z.enum(["modern", "professional", "bold", "minimal", "classic"]).default("modern"),
  componentColors: BrandingComponentColorsSchema,
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
      const componentColorsInput =
        payload.componentColors === undefined
          ? undefined
          : payload.componentColors === null
            ? Prisma.JsonNull
            : payload.componentColors;

      const createData = {
        tenantId,
        logoUrl: payload.logoUrl ?? null,
        primaryColor: payload.primaryColor,
        templateId: payload.templateId,
        ...(componentColorsInput !== undefined ? { componentColors: componentColorsInput } : {}),
      };

      const updateData = {
        logoUrl: payload.logoUrl ?? null,
        primaryColor: payload.primaryColor,
        templateId: payload.templateId,
        ...(componentColorsInput !== undefined ? { componentColors: componentColorsInput } : {}),
      };

      const branding = await app.prisma.tenantBranding.upsert({
        where: { tenantId },
        create: createData,
        update: updateData,
      });

      return { branding };
    },
  );
};
