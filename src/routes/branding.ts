import { Prisma } from "@prisma/client";
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const DataImageUrlSchema = z.string().regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/);

function nullableTrimmedStringSchema(max: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    },
    z.string().max(max).nullable().optional(),
  );
}

const NullableEmailSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  },
  z.string().email().nullable().optional(),
);

const BrandingComponentColorsSchema = z
  .object({
    headerBgColor: HexColorSchema.optional(),
    headerTextColor: HexColorSchema.optional(),
    sectionTitleColor: HexColorSchema.optional(),
    tableHeaderBgColor: HexColorSchema.optional(),
    tableHeaderTextColor: HexColorSchema.optional(),
    totalsColor: HexColorSchema.optional(),
    footerTextColor: HexColorSchema.optional(),
  })
  .nullable()
  .optional();

const LogoPositionSchema = z.enum(["left", "center", "right"]);

const BusinessProfileSchema = z
  .object({
    businessEmail: NullableEmailSchema,
    businessPhone: nullableTrimmedStringSchema(50),
    addressLine1: nullableTrimmedStringSchema(120),
    addressLine2: nullableTrimmedStringSchema(120),
    city: nullableTrimmedStringSchema(80),
    state: nullableTrimmedStringSchema(80),
    postalCode: nullableTrimmedStringSchema(20),
  })
  .default({});

const UpsertBrandingSchema = z.object({
  logoUrl: z.union([z.string().url(), DataImageUrlSchema]).optional().nullable(),
  logoPosition: LogoPositionSchema.default("left"),
  primaryColor: HexColorSchema.default("#5B85AA"),
  templateId: z.enum(["modern", "professional", "bold", "minimal", "classic"]).default("modern"),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  businessProfile: BusinessProfileSchema,
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

      const tenant = await app.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAtUtc: null },
        select: {
          name: true,
          timezone: true,
          branding: {
            select: {
              logoUrl: true,
              logoPosition: true,
              primaryColor: true,
              templateId: true,
              businessEmail: true,
              businessPhone: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
              componentColors: true,
            },
          },
        },
      });

      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found." });
      }

      return {
        tenant: {
          name: tenant.name,
          timezone: tenant.timezone,
        },
        branding: tenant.branding,
      };
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
      const businessProfile = payload.businessProfile ?? {};
      const componentColorsInput =
        payload.componentColors === undefined
          ? undefined
          : payload.componentColors === null
            ? Prisma.JsonNull
            : payload.componentColors;

      const result = await app.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            timezone: payload.timezone,
          },
          select: {
            name: true,
            timezone: true,
          },
        });

        const branding = await tx.tenantBranding.upsert({
          where: { tenantId },
          create: {
            tenantId,
            logoUrl: payload.logoUrl ?? null,
            logoPosition: payload.logoPosition,
            primaryColor: payload.primaryColor,
            templateId: payload.templateId,
            businessEmail: businessProfile.businessEmail ?? null,
            businessPhone: businessProfile.businessPhone ?? null,
            addressLine1: businessProfile.addressLine1 ?? null,
            addressLine2: businessProfile.addressLine2 ?? null,
            city: businessProfile.city ?? null,
            state: businessProfile.state ?? null,
            postalCode: businessProfile.postalCode ?? null,
            ...(componentColorsInput !== undefined ? { componentColors: componentColorsInput } : {}),
          },
          update: {
            logoUrl: payload.logoUrl ?? null,
            logoPosition: payload.logoPosition,
            primaryColor: payload.primaryColor,
            templateId: payload.templateId,
            businessEmail: businessProfile.businessEmail ?? null,
            businessPhone: businessProfile.businessPhone ?? null,
            addressLine1: businessProfile.addressLine1 ?? null,
            addressLine2: businessProfile.addressLine2 ?? null,
            city: businessProfile.city ?? null,
            state: businessProfile.state ?? null,
            postalCode: businessProfile.postalCode ?? null,
            ...(componentColorsInput !== undefined ? { componentColors: componentColorsInput } : {}),
          },
          select: {
            logoUrl: true,
            logoPosition: true,
            primaryColor: true,
            templateId: true,
            businessEmail: true,
            businessPhone: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            componentColors: true,
          },
        });

        return { tenant, branding };
      });

      return result;
    },
  );
};
