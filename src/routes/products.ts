import { PresetCategory, PresetUnitType, Prisma, type WorkPreset } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { markWorkPresetAiRetrievalSourceDeleted } from "../lib/ai-retrieval";
import { enqueueAiIndexJob, enqueueAiIndexJobs } from "../lib/ai-index-jobs";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { PaginationQuerySchema } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import {
  addMissingTenantStarterCatalog,
  findTenantProductNameMatches,
  lockTenantProductCatalog,
  StarterCatalogCapacityError,
  StarterCatalogSelectionError,
} from "../services/tenant-starter-catalog";
import { isStandardWorkPresetCustomized } from "../services/work-preset-catalog";

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

const ProductParamsSchema = z.object({
  productId: z.string().trim().min(1).max(120),
});

const ProductQuerySchema = PaginationQuerySchema.extend({
  serviceType: ServiceTypeEnum.optional(),
  category: PresetCategoryEnum.optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

const ProductFieldsSchema = z.object({
  serviceType: ServiceTypeEnum,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  category: PresetCategoryEnum,
  unitType: PresetUnitTypeEnum,
  defaultQuantity: z.number().positive().max(100000),
  unitCost: z.number().nonnegative().max(1000000),
  unitPrice: z.number().nonnegative().max(1000000),
  isDefault: z.boolean(),
});

const CreateProductSchema = ProductFieldsSchema.extend({
  isDefault: z.boolean().default(true),
});

const UpdateProductSchema = ProductFieldsSchema.partial().refine(
  (payload) => Object.keys(payload).length > 0,
  { message: "At least one product field is required." },
);

const AddMissingStarterCatalogSchema = z.object({
  serviceType: ServiceTypeEnum,
  catalogKeys: z.array(z.string().trim().min(2).max(120)).min(1).max(50).optional(),
});

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value?.trim() || null;
}

function productResponse(product: WorkPreset) {
  const { catalogContentHash: _catalogContentHash, ...visibleProduct } = product;
  return visibleProduct;
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  async function runTenantSerializedProductWrite<T>(
    tenantId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return app.prisma.$transaction(async (transaction) => {
      // Product names, restores, and the 200-item catalog limit are tenant-wide
      // invariants. Lock the tenant row before reading catalog state so concurrent
      // API replicas make those decisions in order without exhausting optimistic
      // serializable retries and leaking a transient P2034 as a 500 response.
      await lockTenantProductCatalog(transaction, tenantId);
      return operation(transaction);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  app.get("/products", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const query = ProductQuerySchema.parse(request.query);
    const canViewInternalCosts = hasCapability(access, "viewInternalCosts");

    const where: Prisma.WorkPresetWhereInput = {
      tenantId: claims.tenantId,
      deletedAtUtc: null,
      ...(query.serviceType ? { serviceType: query.serviceType } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { description: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [tenant, products, total, standardCount] = await measureRequestPerformance(request, "db", () => app.prisma.$transaction([
      app.prisma.tenant.findFirst({
        where: { id: claims.tenantId, deletedAtUtc: null },
        select: { id: true, primaryTrade: true },
      }),
      app.prisma.workPreset.findMany({
        where,
        orderBy: [{ serviceType: "asc" }, { category: "asc" }, { name: "asc" }, { id: "asc" }],
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          tenantId: true,
          serviceType: true,
          catalogKey: true,
          catalogVersion: true,
          catalogCustomizedAtUtc: true,
          category: true,
          unitType: true,
          name: true,
          description: true,
          defaultQuantity: true,
          ...(canViewInternalCosts ? { unitCost: true } : {}),
          unitPrice: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
          deletedAtUtc: true,
        },
      }),
      app.prisma.workPreset.count({ where }),
      app.prisma.workPreset.count({ where: { ...where, catalogKey: { not: null } } }),
    ]));

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    return {
      primaryTrade: tenant.primaryTrade,
      supportedTrades: ServiceTypeEnum.options,
      products,
      policy: {
        canManageCatalog: hasCapability(access, "manageCatalog"),
        canViewInternalCosts,
      },
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      summary: {
        standardCount,
      },
    };
  });

  app.post("/products/starter-catalog/add-missing", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can add starter products." });
    }
    const payload = AddMissingStarterCatalogSchema.parse(request.body);

    try {
      const result = await app.prisma.$transaction(async (transaction) => {
        const imported = await addMissingTenantStarterCatalog(transaction, {
          tenantId: claims.tenantId,
          serviceType: payload.serviceType,
          catalogKeys: payload.catalogKeys,
        });
        await enqueueAiIndexJobs(transaction, {
          tenantId: claims.tenantId,
          jobs: imported.products.map((product) => ({
            sourceType: "WorkPreset",
            sourceId: product.id,
            operation: "UPSERT",
            expectedSourceUpdatedAtUtc: product.updatedAt,
          })),
        });
        return imported;
      });

      return reply.send({
        message: result.createdCount > 0
          ? `${result.createdCount} starter product${result.createdCount === 1 ? "" : "s"} added.`
          : "Starter catalog is already up to date.",
        serviceType: payload.serviceType,
        requestedCount: result.requestedCount,
        createdCount: result.createdCount,
        skippedCount: result.skippedCount,
      });
    } catch (error) {
      if (error instanceof StarterCatalogSelectionError) {
        return reply.code(400).send({
          error: error.message,
          code: "STARTER_CATALOG_INVALID_SELECTION",
          unknownCatalogKeys: error.unknownCatalogKeys,
        });
      }
      if (error instanceof StarterCatalogCapacityError) {
        return reply.code(409).send({
          error: error.message,
          code: "PRODUCT_CATALOG_LIMIT",
          activeProductCount: error.activeProductCount,
          requestedMissingCount: error.missingProductCount,
          maximumProductCount: error.maximumProductCount,
        });
      }
      if (error instanceof Error && error.message === "STARTER_CATALOG_TENANT_NOT_FOUND") {
        return reply.code(404).send({ error: "Tenant not found for account." });
      }
      throw error;
    }
  });

  app.post("/products", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can manage products and pricing." });
    }
    const payload = CreateProductSchema.parse(request.body);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      select: { id: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const outcome = await runTenantSerializedProductWrite(claims.tenantId, async (transaction) => {
      const sameNameProducts = await findTenantProductNameMatches(transaction, {
        tenantId: claims.tenantId,
        serviceType: payload.serviceType,
        name: payload.name,
      });
      const activeNameOwner = sameNameProducts.find((product) => !product.deletedAtUtc);
      const restorableCustomProduct = sameNameProducts.find(
        (product) => product.deletedAtUtc && !product.catalogKey,
      );

      if (activeNameOwner) {
        return { kind: "conflict", productId: activeNameOwner.id } as const;
      }

      const activeProductCount = await transaction.workPreset.count({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
        },
      });
      if (activeProductCount >= 200) {
        return { kind: "limit" } as const;
      }

      const data = {
        serviceType: payload.serviceType,
        name: payload.name,
        description: normalizeOptionalText(payload.description),
        category: payload.category,
        unitType: payload.unitType,
        defaultQuantity: payload.defaultQuantity,
        unitCost: payload.unitCost,
        unitPrice: payload.unitPrice,
        isDefault: payload.isDefault,
        deletedAtUtc: null,
      } satisfies Prisma.WorkPresetUncheckedUpdateInput;

      const product = restorableCustomProduct
        ? await transaction.workPreset.update({
            where: { id: restorableCustomProduct.id },
            data,
          })
        : await transaction.workPreset.create({
            data: {
              tenantId: claims.tenantId,
              serviceType: payload.serviceType,
              name: payload.name,
              description: normalizeOptionalText(payload.description),
              category: payload.category,
              unitType: payload.unitType,
              defaultQuantity: payload.defaultQuantity,
              unitCost: payload.unitCost,
              unitPrice: payload.unitPrice,
              isDefault: payload.isDefault,
            },
          });

      if (restorableCustomProduct) {
        await markWorkPresetAiRetrievalSourceDeleted(transaction, {
          tenantId: claims.tenantId,
          workPresetIds: [restorableCustomProduct.id],
        });
      }
      await enqueueAiIndexJob(transaction, {
        tenantId: claims.tenantId,
        sourceType: "WorkPreset",
        sourceId: product.id,
        operation: "UPSERT",
        expectedSourceUpdatedAtUtc: product.updatedAt,
      });

      return { kind: "success", product, restored: Boolean(restorableCustomProduct) } as const;
    });

    if (outcome.kind === "conflict") {
      return reply.code(409).send({
        error: "A product with this name already exists for the selected trade.",
        code: "PRODUCT_NAME_CONFLICT",
        productId: outcome.productId,
      });
    }

    if (outcome.kind === "limit") {
      return reply.code(409).send({
        error: "Product catalog is limited to 200 active items.",
        code: "PRODUCT_CATALOG_LIMIT",
      });
    }

    return reply.code(outcome.restored ? 200 : 201).send({
      message: outcome.restored ? "Product restored." : "Product created.",
      product: productResponse(outcome.product),
    });
  });

  app.patch("/products/:productId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can manage products and pricing." });
    }
    const params = ProductParamsSchema.parse(request.params);
    const payload = UpdateProductSchema.parse(request.body);

    const outcome = await runTenantSerializedProductWrite(claims.tenantId, async (transaction) => {
      const existingProduct = await transaction.workPreset.findFirst({
        where: {
          id: params.productId,
          tenantId: claims.tenantId,
          deletedAtUtc: null,
        },
      });

      if (!existingProduct) {
        return { kind: "not_found" } as const;
      }

      if (
        existingProduct.catalogKey &&
        (payload.name !== undefined ||
          payload.serviceType !== undefined ||
          payload.category !== undefined ||
          payload.unitType !== undefined)
      ) {
        return { kind: "standard_locked" } as const;
      }

      const nextServiceType = payload.serviceType ?? existingProduct.serviceType;
      const nextName = payload.name ?? existingProduct.name;
      if (!existingProduct.catalogKey && (payload.name !== undefined || payload.serviceType !== undefined)) {
        const conflictingProduct = (await findTenantProductNameMatches(transaction, {
          tenantId: claims.tenantId,
          serviceType: nextServiceType,
          name: nextName,
        })).find((product) => !product.deletedAtUtc && product.id !== existingProduct.id);

        if (conflictingProduct) {
          return { kind: "conflict", productId: conflictingProduct.id } as const;
        }
      }

      const nextDescription = payload.description !== undefined
        ? normalizeOptionalText(payload.description)
        : existingProduct.description;
      const catalogCustomizedAtUtc = existingProduct.catalogKey && isStandardWorkPresetCustomized(
        existingProduct.serviceType,
        existingProduct.catalogKey,
        {
          description: nextDescription,
          defaultQuantity: payload.defaultQuantity ?? existingProduct.defaultQuantity,
          unitCost: payload.unitCost ?? existingProduct.unitCost,
          unitPrice: payload.unitPrice ?? existingProduct.unitPrice,
          isDefault: payload.isDefault ?? existingProduct.isDefault,
        },
      ) ? new Date() : null;

      const product = await transaction.workPreset.update({
        where: { id: existingProduct.id },
        data: {
          ...(payload.serviceType !== undefined ? { serviceType: payload.serviceType } : {}),
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.description !== undefined
            ? { description: normalizeOptionalText(payload.description) }
            : {}),
          ...(payload.category !== undefined ? { category: payload.category } : {}),
          ...(payload.unitType !== undefined ? { unitType: payload.unitType } : {}),
          ...(payload.defaultQuantity !== undefined ? { defaultQuantity: payload.defaultQuantity } : {}),
          ...(payload.unitCost !== undefined ? { unitCost: payload.unitCost } : {}),
          ...(payload.unitPrice !== undefined ? { unitPrice: payload.unitPrice } : {}),
          ...(payload.isDefault !== undefined ? { isDefault: payload.isDefault } : {}),
          ...(existingProduct.catalogKey ? { catalogCustomizedAtUtc } : {}),
        },
      });
      await markWorkPresetAiRetrievalSourceDeleted(transaction, {
        tenantId: claims.tenantId,
        workPresetIds: [existingProduct.id],
      });
      await enqueueAiIndexJob(transaction, {
        tenantId: claims.tenantId,
        sourceType: "WorkPreset",
        sourceId: product.id,
        operation: "UPSERT",
        expectedSourceUpdatedAtUtc: product.updatedAt,
      });
      return { kind: "success", product } as const;
    });

    if (outcome.kind === "not_found") {
      return reply.code(404).send({ error: "Product not found." });
    }
    if (outcome.kind === "standard_locked") {
      return reply.code(400).send({
        error: "Standard catalog names, trades, categories, and unit types cannot be changed.",
      });
    }
    if (outcome.kind === "conflict") {
      return reply.code(409).send({
        error: "A product with this name already exists for the selected trade.",
        code: "PRODUCT_NAME_CONFLICT",
        productId: outcome.productId,
      });
    }

    return reply.send({ message: "Product updated.", product: productResponse(outcome.product) });
  });

  app.delete("/products/:productId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageCatalog")) {
      return reply.code(403).send({ error: "Only workspace owners and admins can manage products and pricing." });
    }
    const params = ProductParamsSchema.parse(request.params);

    const existingProduct = await app.prisma.workPreset.findFirst({
      where: {
        id: params.productId,
        tenantId: claims.tenantId,
        deletedAtUtc: null,
      },
      select: { id: true, catalogKey: true },
    });

    if (!existingProduct) {
      return reply.code(404).send({ error: "Product not found." });
    }

    if (existingProduct.catalogKey) {
      return reply.code(400).send({
        code: "STANDARD_PRODUCT_ARCHIVE_FORBIDDEN",
        error: "Standard catalog items stay available. Edit their pricing or description instead.",
      });
    }

    const now = new Date();
    await app.prisma.$transaction(async (transaction) => {
      await transaction.workPreset.update({
        where: { id: existingProduct.id },
        data: { deletedAtUtc: now },
      });
      await markWorkPresetAiRetrievalSourceDeleted(transaction, {
        tenantId: claims.tenantId,
        workPresetIds: [existingProduct.id],
        now,
      });
      await enqueueAiIndexJob(transaction, {
        tenantId: claims.tenantId,
        sourceType: "WorkPreset",
        sourceId: existingProduct.id,
        operation: "DELETE",
        availableAtUtc: now,
      });
    });

    return reply.send({ message: "Product archived." });
  });
};
