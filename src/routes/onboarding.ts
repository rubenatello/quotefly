import { PresetCategory, PresetUnitType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  markTenantAiRetrievalSourceTypeDeleted,
  markWorkPresetAiRetrievalSourceDeleted,
} from "../lib/ai-retrieval";
import { enqueueTenantWorkPresetAiIndexJobs } from "../lib/ai-index-jobs";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { BrandLogoDataUrlSchema } from "../lib/brand-logo";
import {
  applyOnboardingSetup,
  parseServiceCategory,
  recommendedPresetsForTrade,
  saveTenantWorkPreset,
} from "../services/onboarding";
import {
  StarterCatalogCapacityError,
  TenantProductNameConflictError,
} from "../services/tenant-starter-catalog";

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
  id: z.string().trim().min(1).max(120).optional(),
  catalogKey: z.string().trim().min(2).max(120).optional(),
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
  logoUrl: BrandLogoDataUrlSchema.optional(),
  primaryColor: z.string().trim().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/).optional(),
  chargeBySquareFoot: z.boolean().default(false),
  sqFtUnitCost: z.number().positive().max(10000).optional(),
  sqFtUnitPrice: z.number().positive().max(10000).optional(),
  presets: z.array(OnboardingPresetSchema).max(50).optional(),
});

const SavePresetSchema = z.object({
  serviceType: ServiceTypeEnum,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  category: PresetCategoryEnum.default(PresetCategory.SERVICE),
  unitType: PresetUnitTypeEnum.default(PresetUnitType.FLAT),
  defaultQuantity: z.number().positive().max(100000).default(1),
  unitCost: z.number().nonnegative().max(1000000).default(0),
  unitPrice: z.number().nonnegative().max(1000000).default(0),
});

const PresetQuerySchema = z.object({
  serviceType: z.string().trim().min(2),
});

function onboardingCatalogWriteError(error: unknown): {
  statusCode: 404 | 409;
  body: Record<string, unknown>;
} | null {
  if (error instanceof StarterCatalogCapacityError) {
    return {
      statusCode: 409,
      body: {
        error: "Product catalog is limited to 200 active items.",
        code: "PRODUCT_CATALOG_LIMIT",
        activeProductCount: error.activeProductCount,
        requestedMissingCount: error.missingProductCount,
        maximumProductCount: error.maximumProductCount,
      },
    };
  }
  if (error instanceof TenantProductNameConflictError) {
    return {
      statusCode: 409,
      body: {
        error: error.message,
        code: "PRODUCT_NAME_CONFLICT",
        productId: error.productId,
      },
    };
  }
  if (error instanceof Error && error.message === "STARTER_CATALOG_TENANT_NOT_FOUND") {
    return {
      statusCode: 404,
      body: { error: "Tenant not found for account." },
    };
  }
  return null;
}

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/onboarding/setup", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can view setup pricing." });
    }

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
      presets: presets.map(({ catalogContentHash: _catalogContentHash, ...preset }) => preset),
      supportedTrades: ServiceTypeEnum.options,
    };
  });

  app.get("/onboarding/presets/recommended", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can view recommended product costs." });
    }
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
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can change setup pricing." });
    }
    const payload = SaveOnboardingSchema.parse(request.body);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      select: { id: true, name: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    try {
      const result = await app.prisma.$transaction(async (transaction) => {
        const setupResult = await applyOnboardingSetup(transaction, {
          tenantId: tenant.id,
          companyName: tenant.name,
          primaryTrade: payload.primaryTrade,
          logoUrl: payload.logoUrl,
          primaryColor: payload.primaryColor,
          chargeBySquareFoot: payload.chargeBySquareFoot,
          sqFtUnitCost: payload.sqFtUnitCost,
          sqFtUnitPrice: payload.sqFtUnitPrice,
          customPresets: payload.presets,
        });
        await markTenantAiRetrievalSourceTypeDeleted(transaction, {
          tenantId: tenant.id,
          sourceTypes: ["WorkPreset"],
        });
        await enqueueTenantWorkPresetAiIndexJobs(transaction, { tenantId: tenant.id });
        return setupResult;
      });

      return reply.send({
        message: "Onboarding setup saved.",
        presetsCreatedOrUpdated: result.presetsCreatedOrUpdated,
      });
    } catch (error) {
      const catalogError = onboardingCatalogWriteError(error);
      if (catalogError) {
        return reply.code(catalogError.statusCode).send(catalogError.body);
      }
      throw error;
    }
  });

  app.post("/onboarding/presets", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can save products and pricing." });
    }
    const payload = SavePresetSchema.parse(request.body);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      select: { id: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    try {
      const result = await app.prisma.$transaction(async (transaction) => {
        const saved = await saveTenantWorkPreset(transaction, {
          tenantId: tenant.id,
          serviceType: payload.serviceType,
          name: payload.name,
          description: payload.description,
          category: payload.category,
          unitType: payload.unitType,
          defaultQuantity: payload.defaultQuantity,
          unitCost: payload.unitCost,
          unitPrice: payload.unitPrice,
        });
        await markWorkPresetAiRetrievalSourceDeleted(transaction, {
          tenantId: tenant.id,
          workPresetIds: [saved.preset.id],
        });
        await enqueueTenantWorkPresetAiIndexJobs(transaction, { tenantId: tenant.id });
        return saved;
      });

      return reply.send({
        message: "Preset saved.",
        action: result.action,
        preset: (() => {
          const { catalogContentHash: _catalogContentHash, ...preset } = result.preset;
          return preset;
        })(),
      });
    } catch (error) {
      const catalogError = onboardingCatalogWriteError(error);
      if (catalogError) {
        return reply.code(catalogError.statusCode).send(catalogError.body);
      }
      throw error;
    }
  });
};
