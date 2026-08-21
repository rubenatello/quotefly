import { randomUUID } from "node:crypto";
import { Prisma, ServiceCategory, type WorkPreset } from "@prisma/client";
import {
  getStandardWorkPresetCatalog,
  standardWorkPresetContentHash,
} from "./work-preset-catalog";

export class StarterCatalogSelectionError extends Error {
  constructor(readonly unknownCatalogKeys: string[]) {
    super("One or more starter catalog keys are invalid for the selected trade.");
  }
}

export class StarterCatalogCapacityError extends Error {
  constructor(
    readonly activeProductCount: number,
    readonly missingProductCount: number,
    readonly maximumProductCount = 200,
  ) {
    super("The starter catalog selection exceeds the workspace product limit.");
  }
}

export class TenantProductNameConflictError extends Error {
  constructor(
    readonly productId: string,
    readonly productName: string,
  ) {
    super("A product with this name already exists for the selected trade.");
  }
}

export interface AddMissingTenantStarterCatalogInput {
  tenantId: string;
  serviceType: ServiceCategory;
  catalogKeys?: readonly string[];
}

export interface AddMissingTenantStarterCatalogResult {
  requestedCount: number;
  createdCount: number;
  skippedCount: number;
  products: WorkPreset[];
}

function normalizeCatalogKeys(catalogKeys: readonly string[] | undefined): string[] | undefined {
  if (catalogKeys === undefined) return undefined;
  return [...new Set(catalogKeys.map((catalogKey) => catalogKey.trim()).filter(Boolean))];
}

export function normalizeTenantProductName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function findTenantProductNameMatches(
  prisma: Prisma.TransactionClient,
  input: {
    tenantId: string;
    serviceType: ServiceCategory;
    name: string;
  },
): Promise<WorkPreset[]> {
  const normalizedName = normalizeTenantProductName(input.name);
  return prisma.$queryRaw<WorkPreset[]>(Prisma.sql`
    SELECT *
    FROM "WorkPreset"
    WHERE "tenantId" = ${input.tenantId}
      AND "serviceType" = CAST(${input.serviceType} AS "ServiceCategory")
      AND LOWER(REGEXP_REPLACE(BTRIM("name"), '[[:space:]]+', ' ', 'g')) = ${normalizedName}
    ORDER BY "deletedAtUtc" NULLS FIRST, "createdAt", "id"
  `);
}

export async function lockTenantProductCatalog(
  prisma: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  const lockedTenant = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Tenant"
    WHERE "id" = ${tenantId}
      AND "deletedAtUtc" IS NULL
    FOR UPDATE
  `);
  if (lockedTenant.length !== 1) {
    throw new Error("STARTER_CATALOG_TENANT_NOT_FOUND");
  }
}

export async function assertTenantProductActivationCapacity(
  prisma: Prisma.TransactionClient,
  tenantId: string,
  additionalActiveCount = 1,
): Promise<number> {
  const activeProductCount = await prisma.workPreset.count({
    where: { tenantId, deletedAtUtc: null },
  });
  if (activeProductCount + additionalActiveCount > 200) {
    throw new StarterCatalogCapacityError(activeProductCount, additionalActiveCount);
  }
  return activeProductCount;
}

/**
 * Copies immutable QuoteFly catalog definitions into tenant-owned WorkPreset
 * rows. Existing active, customized, or archived tenant rows are never
 * updated or restored. The tenant row lock and composite catalog key ensure
 * concurrent imports are idempotent across API replicas.
 */
export async function addMissingTenantStarterCatalog(
  prisma: Prisma.TransactionClient,
  input: AddMissingTenantStarterCatalogInput,
): Promise<AddMissingTenantStarterCatalogResult> {
  await lockTenantProductCatalog(prisma, input.tenantId);
  return addMissingTenantStarterCatalogLocked(prisma, input);
}

export async function addMissingTenantStarterCatalogLocked(
  prisma: Prisma.TransactionClient,
  input: AddMissingTenantStarterCatalogInput,
): Promise<AddMissingTenantStarterCatalogResult> {
  const catalog = getStandardWorkPresetCatalog(input.serviceType);
  const catalogByKey = new Map(catalog.map((preset) => [preset.catalogKey, preset]));
  const normalizedKeys = normalizeCatalogKeys(input.catalogKeys);
  const requestedKeys = normalizedKeys ?? catalog.map((preset) => preset.catalogKey);
  const unknownCatalogKeys = requestedKeys.filter((catalogKey) => !catalogByKey.has(catalogKey));
  if (unknownCatalogKeys.length > 0) {
    throw new StarterCatalogSelectionError(unknownCatalogKeys);
  }

  if (requestedKeys.length === 0) {
    return { requestedCount: 0, createdCount: 0, skippedCount: 0, products: [] };
  }

  const requestedDefinitions = requestedKeys.map((catalogKey) => catalogByKey.get(catalogKey)!);
  const requestedNames = [...new Set(
    requestedDefinitions.map((definition) => normalizeTenantProductName(definition.name)),
  )];
  const [existingProducts, activeProductCount] = await Promise.all([
    prisma.$queryRaw<Array<{ catalogKey: string | null; name: string }>>(Prisma.sql`
      SELECT "catalogKey", "name"
      FROM "WorkPreset"
      WHERE "tenantId" = ${input.tenantId}
        AND "serviceType" = CAST(${input.serviceType} AS "ServiceCategory")
        AND (
          "catalogKey" IN (${Prisma.join(requestedKeys)})
          OR LOWER(REGEXP_REPLACE(BTRIM("name"), '[[:space:]]+', ' ', 'g'))
            IN (${Prisma.join(requestedNames)})
        )
    `),
    prisma.workPreset.count({
      where: { tenantId: input.tenantId, deletedAtUtc: null },
    }),
  ]);
  const existingKeys = new Set(existingProducts.flatMap((product) => product.catalogKey ? [product.catalogKey] : []));
  const existingNames = new Set(existingProducts.map((product) => normalizeTenantProductName(product.name)));
  const missingDefinitions = requestedDefinitions.filter(
    (definition) =>
      !existingKeys.has(definition.catalogKey) &&
      !existingNames.has(normalizeTenantProductName(definition.name)),
  );

  if (missingDefinitions.length === 0) {
    return {
      requestedCount: requestedKeys.length,
      createdCount: 0,
      skippedCount: requestedKeys.length,
      products: [],
    };
  }

  if (activeProductCount + missingDefinitions.length > 200) {
    throw new StarterCatalogCapacityError(activeProductCount, missingDefinitions.length);
  }

  const insertCandidates = missingDefinitions.map((preset) => ({
    id: randomUUID(),
    tenantId: input.tenantId,
    serviceType: input.serviceType,
    catalogKey: preset.catalogKey,
    catalogVersion: preset.catalogVersion,
    catalogContentHash: standardWorkPresetContentHash(input.serviceType, preset),
    catalogCustomizedAtUtc: null,
    category: preset.category,
    unitType: preset.unitType,
    name: preset.name,
    description: preset.description,
    defaultQuantity: preset.defaultQuantity,
    unitCost: preset.unitCost,
    unitPrice: preset.unitPrice,
    isDefault: preset.isDefault ?? true,
  }));
  const insertResult = await prisma.workPreset.createMany({
    data: insertCandidates,
    skipDuplicates: true,
  });

  const createdProducts = insertResult.count === 0
    ? []
    : await prisma.workPreset.findMany({
        where: {
          tenantId: input.tenantId,
          serviceType: input.serviceType,
          id: { in: insertCandidates.map((candidate) => candidate.id) },
        },
        orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
      });

  return {
    requestedCount: requestedKeys.length,
    createdCount: insertResult.count,
    skippedCount: requestedKeys.length - insertResult.count,
    products: createdProducts,
  };
}
