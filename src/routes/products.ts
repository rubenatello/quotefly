import { PresetCategory, PresetUnitType, Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { markWorkPresetAiRetrievalSourceDeleted } from "../lib/ai-retrieval";
import { enqueueAiIndexJob } from "../lib/ai-index-jobs";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext, hasCapability } from "../lib/access-policy";

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

const ProductQuerySchema = z.object({
  serviceType: ServiceTypeEnum.optional(),
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

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value?.trim() || null;
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  async function runSerializableProductWrite<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastSerializationError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await app.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const serializationConflict = error instanceof Prisma.PrismaClientKnownRequestError && (
          error.code === "P2034"
          || (error.code === "P2010" && error.meta?.code === "40001")
        );
        if (serializationConflict) {
          lastSerializationError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastSerializationError;
  }

  app.get("/products", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const query = ProductQuerySchema.parse(request.query);

    const tenant = await app.prisma.tenant.findFirst({
      where: { id: claims.tenantId, deletedAtUtc: null },
      select: { id: true, primaryTrade: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const products = await app.prisma.workPreset.findMany({
      where: {
        tenantId: claims.tenantId,
        deletedAtUtc: null,
        ...(query.serviceType ? { serviceType: query.serviceType } : {}),
      },
      orderBy: [{ serviceType: "asc" }, { category: "asc" }, { name: "asc" }],
      take: 200,
    });

    return {
      primaryTrade: tenant.primaryTrade,
      supportedTrades: ServiceTypeEnum.options,
      products: products.map((product) => {
        const { unitCost, ...visibleProduct } = product;
        return hasCapability(access, "viewInternalCosts")
          ? { ...visibleProduct, unitCost }
          : visibleProduct;
      }),
      policy: {
        canManageCatalog: hasCapability(access, "manageCatalog"),
        canViewInternalCosts: hasCapability(access, "viewInternalCosts"),
      },
    };
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

    const outcome = await runSerializableProductWrite(async (transaction) => {
      const existingProduct = await transaction.workPreset.findFirst({
        where: {
          tenantId: claims.tenantId,
          serviceType: payload.serviceType,
          catalogKey: null,
          name: { equals: payload.name, mode: "insensitive" },
        },
      });

      if (existingProduct && !existingProduct.deletedAtUtc) {
        return { kind: "conflict", productId: existingProduct.id } as const;
      }

      if (!existingProduct || existingProduct.deletedAtUtc) {
        const activeProductCount = await transaction.workPreset.count({
          where: {
            tenantId: claims.tenantId,
            deletedAtUtc: null,
          },
        });
        if (activeProductCount >= 200) {
          return { kind: "limit" } as const;
        }
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

      const product = existingProduct
        ? await transaction.workPreset.update({
            where: { id: existingProduct.id },
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

      if (existingProduct) {
        await markWorkPresetAiRetrievalSourceDeleted(transaction, {
          tenantId: claims.tenantId,
          workPresetIds: [existingProduct.id],
        });
      }
      await enqueueAiIndexJob(transaction, {
        tenantId: claims.tenantId,
        sourceType: "WorkPreset",
        sourceId: product.id,
        operation: "UPSERT",
        expectedSourceUpdatedAtUtc: product.updatedAt,
      });

      return { kind: "success", product, restored: Boolean(existingProduct) } as const;
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
      product: outcome.product,
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

    const outcome = await runSerializableProductWrite(async (transaction) => {
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
        const conflictingProduct = await transaction.workPreset.findFirst({
          where: {
            tenantId: claims.tenantId,
            serviceType: nextServiceType,
            catalogKey: null,
            deletedAtUtc: null,
            id: { not: existingProduct.id },
            name: { equals: nextName, mode: "insensitive" },
          },
          select: { id: true },
        });

        if (conflictingProduct) {
          return { kind: "conflict", productId: conflictingProduct.id } as const;
        }
      }

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

    return reply.send({ message: "Product updated.", product: outcome.product });
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
