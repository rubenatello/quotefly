import { PresetCategory, PresetUnitType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import {
  applyOnboardingSetup,
  parseServiceCategory,
  recommendedPresetsForTrade,
} from "../services/onboarding";

const ServiceTypeEnum = z.enum([
  "HVAC",
  "PLUMBING",
  "FLOORING",
  "ROOFING",
  "GARDENING",
  "CONSTRUCTION",
]);

const PresetCategoryEnum = z.enum([
  PresetCategory.LABOR,
  PresetCategory.MATERIAL,
  PresetCategory.FEE,
  PresetCategory.SERVICE,
]);

const PresetUnitTypeEnum = z.enum([
  PresetUnitType.FLAT,
  PresetUnitType.SQ_FT,
  PresetUnitType.HOUR,
  PresetUnitType.EACH,
]);

const OnboardingPresetSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  category: PresetCategoryEnum,
  unitType: PresetUnitTypeEnum,
  defaultQuantity: z.number().positive().max(100000),
  unitCost: z.number().nonnegative().max(1000000),
  unitPrice: z.number().nonnegative().max(1000000),
  isDefault: z.boolean().optional(),
});

const SaveOnboardingSchema = z.object({
  primaryTrade: ServiceTypeEnum,
  logoUrl: z.string().trim().max(1_500_000).optional(),
  primaryColor: z.string().trim().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/).optional(),
  generateLogoIfMissing: z.boolean().default(true),
  chargeBySquareFoot: z.boolean().default(false),
  sqFtUnitCost: z.number().positive().max(10000).optional(),
  sqFtUnitPrice: z.number().positive().max(10000).optional(),
  presets: z.array(OnboardingPresetSchema).max(50).optional(),
});

const PresetQuerySchema = z.object({
  serviceType: z.string().trim().min(2),
});

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/onboarding/setup", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      include: {
        branding: true,
        pricingProfiles: {
          where: {
            deletedAtUtc: null,
            isDefault: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const presets = await app.prisma.workPreset.findMany({
      where: {
        tenantId: claims.tenantId,
        deletedAtUtc: null,
        ...(tenant.primaryTrade ? { serviceType: tenant.primaryTrade } : {}),
      },
      orderBy: [{ serviceType: "asc" }, { category: "asc" }, { name: "asc" }],
      take: 200,
    });

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        primaryTrade: tenant.primaryTrade,
        onboardingCompletedAtUtc: tenant.onboardingCompletedAtUtc,
      },
      branding: tenant.branding
        ? {
            logoUrl: tenant.branding.logoUrl,
            primaryColor: tenant.branding.primaryColor,
            templateId: tenant.branding.templateId,
          }
        : null,
      defaultPricingProfiles: tenant.pricingProfiles,
      presets,
      supportedTrades: ServiceTypeEnum.options,
    };
  });

  app.get("/onboarding/presets/recommended", { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = PresetQuerySchema.parse(request.query);
    const serviceType = parseServiceCategory(query.serviceType);
    if (!serviceType) {
      return reply.code(400).send({ error: "Invalid serviceType value." });
    }

    return {
      serviceType,
      presets: recommendedPresetsForTrade(serviceType),
    };
  });

  app.post("/onboarding/setup", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const payload = SaveOnboardingSchema.parse(request.body);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      select: { id: true, name: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const result = await applyOnboardingSetup(app.prisma, {
      tenantId: tenant.id,
      companyName: tenant.name,
      primaryTrade: payload.primaryTrade,
      logoUrl: payload.logoUrl,
      primaryColor: payload.primaryColor,
      generateLogoIfMissing: payload.generateLogoIfMissing,
      chargeBySquareFoot: payload.chargeBySquareFoot,
      sqFtUnitCost: payload.sqFtUnitCost,
      sqFtUnitPrice: payload.sqFtUnitPrice,
      customPresets: payload.presets,
    });

    return reply.send({
      message: "Onboarding setup saved.",
      presetsCreatedOrUpdated: result.presetsCreatedOrUpdated,
    });
  });
};
