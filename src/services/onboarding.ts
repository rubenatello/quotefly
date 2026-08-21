import {
  PresetCategory,
  PresetUnitType,
  Prisma,
  ServiceCategory,
} from "@prisma/client";
import { sanitizeBrandLogoDataUrl } from "../lib/brand-logo";
import {
  STANDARD_SQ_FT_BASE_CATALOG_KEY,
  buildSquareFootBaselinePreset,
  getStandardWorkPresetCatalog,
  getStandardWorkPresetDefinition,
  isStandardWorkPresetCustomized,
  standardWorkPresetContentHash,
} from "./work-preset-catalog";
import {
  addMissingTenantStarterCatalogLocked,
  assertTenantProductActivationCapacity,
  findTenantProductNameMatches,
  lockTenantProductCatalog,
  TenantProductNameConflictError,
} from "./tenant-starter-catalog";

export interface OnboardingPresetInput {
  id?: string;
  catalogKey?: string | null;
  catalogVersion?: number | null;
  catalogContentHash?: string | null;
  wasSubmitted?: boolean;
  name: string;
  description?: string;
  category: PresetCategory;
  unitType: PresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
  isDefault?: boolean;
}

export interface OnboardingSetupInput {
  tenantId: string;
  companyName: string;
  primaryTrade: ServiceCategory;
  logoUrl?: string;
  primaryColor?: string;
  chargeBySquareFoot?: boolean;
  sqFtUnitCost?: number;
  sqFtUnitPrice?: number;
  customPresets?: OnboardingPresetInput[];
}

export interface SaveTenantWorkPresetInput {
  tenantId: string;
  serviceType: ServiceCategory;
  name: string;
  description?: string;
  category: PresetCategory;
  unitType: PresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
}

const DEFAULT_PRICING_BY_TRADE: Record<ServiceCategory, { laborRate: number; materialMarkup: number }> = {
  HVAC: { laborRate: 2.4, materialMarkup: 0.33 },
  PLUMBING: { laborRate: 2.6, materialMarkup: 0.38 },
  FLOORING: { laborRate: 2.1, materialMarkup: 0.3 },
  ROOFING: { laborRate: 2.75, materialMarkup: 0.35 },
  GARDENING: { laborRate: 1.75, materialMarkup: 0.28 },
  CONSTRUCTION: { laborRate: 3.1, materialMarkup: 0.34 },
};

function normalizePresetName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function recommendedPresetsForTrade(serviceType: ServiceCategory): OnboardingPresetInput[] {
  return getStandardWorkPresetCatalog(serviceType).map((preset) => ({
    catalogKey: preset.catalogKey,
    catalogVersion: preset.catalogVersion,
    name: preset.name,
    description: preset.description,
    category: preset.category,
    unitType: preset.unitType,
    defaultQuantity: preset.defaultQuantity,
    unitCost: preset.unitCost,
    unitPrice: preset.unitPrice,
    isDefault: preset.isDefault ?? true,
  }));
}

function sqFtPreset(serviceType: ServiceCategory, unitCost: number, unitPrice: number): OnboardingPresetInput {
  const preset = buildSquareFootBaselinePreset(serviceType, unitCost, unitPrice);
  return {
    catalogKey: preset.catalogKey,
    catalogVersion: preset.catalogVersion,
    catalogContentHash: standardWorkPresetContentHash(serviceType, preset),
    name: preset.name,
    description: preset.description,
    category: preset.category,
    unitType: preset.unitType,
    defaultQuantity: preset.defaultQuantity,
    unitCost: preset.unitCost,
    unitPrice: preset.unitPrice,
    isDefault: preset.isDefault ?? true,
  };
}

function clampMoney(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Number(value.toFixed(2));
}

function resolveLogoUrl(suppliedLogoUrl: string): string {
  const logoUrl = sanitizeBrandLogoDataUrl(suppliedLogoUrl);
  if (!logoUrl) {
    throw new Error("Logo must be a valid supported PNG or JPEG.");
  }
  return logoUrl;
}

function resolvePrimaryColor(suppliedPrimaryColor: string): string {
  const primaryColor = suppliedPrimaryColor.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(primaryColor)) {
    throw new Error("Primary color must be a valid hex color.");
  }
  return primaryColor;
}

export async function applyOnboardingSetup(
  prisma: Prisma.TransactionClient,
  input: OnboardingSetupInput,
): Promise<{
  presetsCreatedOrUpdated: number;
}> {
  const defaults = DEFAULT_PRICING_BY_TRADE[input.primaryTrade];
  const laborRate = clampMoney(
    input.chargeBySquareFoot ? input.sqFtUnitCost : undefined,
    defaults.laborRate,
  );
  const materialMarkup =
    input.chargeBySquareFoot &&
    Number.isFinite(input.sqFtUnitCost) &&
    Number.isFinite(input.sqFtUnitPrice) &&
    (input.sqFtUnitCost ?? 0) > 0
      ? Number(Math.max((input.sqFtUnitPrice! / input.sqFtUnitCost!) - 1, 0.05).toFixed(4))
      : defaults.materialMarkup;
  const hasExplicitSquareFootPricing =
    input.chargeBySquareFoot === true &&
    Number.isFinite(input.sqFtUnitCost) &&
    Number.isFinite(input.sqFtUnitPrice);

  // PDF and browser rendering intentionally accept only bounded PNG/JPEG data URLs.
  // Auto-generated SVG logos are no longer persisted because they cannot be rendered
  // consistently by the PDF pipeline. Users can upload a supported logo in Branding.
  const logoUrl = input.logoUrl === undefined ? undefined : resolveLogoUrl(input.logoUrl);
  const primaryColor = input.primaryColor === undefined ? undefined : resolvePrimaryColor(input.primaryColor);

  const submittedPresets = input.customPresets ?? [];

  const standardPresets = recommendedPresetsForTrade(input.primaryTrade);
  const presetsToApply = [...standardPresets];
  if (hasExplicitSquareFootPricing) {
    presetsToApply.unshift(
      sqFtPreset(
        input.primaryTrade,
        clampMoney(input.sqFtUnitCost, defaults.laborRate),
        clampMoney(input.sqFtUnitPrice, defaults.laborRate * (1 + defaults.materialMarkup)),
      ),
    );
  }

  const matchedPresetIndexes = new Set<number>();
  const resolvedPresetsToApply = presetsToApply.map((presetItem) => {
    const matchedIndex = submittedPresets.findIndex((candidate) => {
      if (presetItem.catalogKey && candidate.catalogKey === presetItem.catalogKey) {
        return true;
      }

      return !candidate.id &&
        !candidate.catalogKey &&
        normalizePresetName(candidate.name) === normalizePresetName(presetItem.name);
    });

    const matchedPreset = matchedIndex >= 0 ? submittedPresets[matchedIndex] : undefined;
    if (matchedIndex >= 0) matchedPresetIndexes.add(matchedIndex);

    const catalogDefinition = presetItem.catalogKey
      ? getStandardWorkPresetDefinition(input.primaryTrade, presetItem.catalogKey)
      : null;
    const catalogPreset = catalogDefinition ?? presetItem;
    const hasAuthoritativeSquareFootPricing =
      hasExplicitSquareFootPricing && presetItem.catalogKey === STANDARD_SQ_FT_BASE_CATALOG_KEY;

    return {
      id: matchedPreset?.id,
      catalogKey: catalogPreset.catalogKey ?? null,
      catalogVersion: catalogDefinition?.catalogVersion ?? presetItem.catalogVersion ?? null,
      catalogContentHash: catalogDefinition
        ? standardWorkPresetContentHash(input.primaryTrade, catalogDefinition)
        : presetItem.catalogContentHash ?? null,
      wasSubmitted: Boolean(matchedPreset),
      name: catalogPreset.name,
      description: matchedPreset?.description?.trim() || catalogPreset.description,
      category: catalogPreset.category,
      unitType: catalogPreset.unitType,
      defaultQuantity: clampMoney(matchedPreset?.defaultQuantity, catalogPreset.defaultQuantity),
      unitCost: hasAuthoritativeSquareFootPricing
        ? catalogPreset.unitCost
        : clampMoney(matchedPreset?.unitCost, catalogPreset.unitCost),
      unitPrice: hasAuthoritativeSquareFootPricing
        ? catalogPreset.unitPrice
        : clampMoney(matchedPreset?.unitPrice, catalogPreset.unitPrice),
      isDefault: matchedPreset?.isDefault ?? catalogPreset.isDefault ?? true,
    } satisfies OnboardingPresetInput;
  });

  const customPresetsToApply = submittedPresets
    .filter((_, index) => !matchedPresetIndexes.has(index))
    .filter((presetItem) => !presetItem.catalogKey)
    .map((presetItem) => ({
      id: presetItem.id,
      catalogKey: null,
      name: presetItem.name.trim(),
      description: presetItem.description?.trim() || undefined,
      category: presetItem.category,
      unitType: presetItem.unitType,
      defaultQuantity: clampMoney(presetItem.defaultQuantity, 1),
      unitCost: clampMoney(presetItem.unitCost, 0),
      unitPrice: clampMoney(presetItem.unitPrice, 0),
      isDefault: presetItem.isDefault ?? true,
    } satisfies OnboardingPresetInput));

  // All product capacity, restore, and name decisions below are serialized by
  // the tenant row. Callers must supply a real transaction so the lock remains
  // held until setup and its AI-index outbox writes commit atomically.
  await lockTenantProductCatalog(prisma, input.tenantId);

  await prisma.tenant.update({
    where: { id: input.tenantId },
    data: {
      primaryTrade: input.primaryTrade,
      onboardingCompletedAtUtc: new Date(),
    },
  });

  const starterCatalogResult = await addMissingTenantStarterCatalogLocked(
    prisma,
    {
      tenantId: input.tenantId,
      serviceType: input.primaryTrade,
    },
  );

  await prisma.tenantBranding.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      logoUrl: logoUrl ?? null,
      primaryColor: primaryColor ?? "#1e6fd8",
      templateId: "modern",
    },
    update: {
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      ...(primaryColor !== undefined ? { primaryColor } : {}),
    },
  });

  const existingDefaultProfile = await prisma.pricingProfile.findFirst({
    where: {
      tenantId: input.tenantId,
      serviceType: input.primaryTrade,
      deletedAtUtc: null,
      isDefault: true,
    },
    select: { id: true },
  });

  if (existingDefaultProfile) {
    await prisma.pricingProfile.update({
      where: { id: existingDefaultProfile.id },
      data: {
        laborRate,
        materialMarkup,
        isDefault: true,
      },
    });
  } else {
    await prisma.pricingProfile.create({
      data: {
        tenantId: input.tenantId,
        serviceType: input.primaryTrade,
        laborRate,
        materialMarkup,
        isDefault: true,
      },
    });
  }

  const existingPresets = await prisma.workPreset.findMany({
    where: {
      tenantId: input.tenantId,
      serviceType: input.primaryTrade,
    },
    select: {
      id: true,
      name: true,
      catalogKey: true,
      deletedAtUtc: true,
    },
  });

  const keptPresetIds = new Set<string>();

  for (const presetItem of resolvedPresetsToApply) {
    if (presetItem.catalogKey) {
      const catalogMatch = existingPresets.find((existingPreset) => existingPreset.catalogKey === presetItem.catalogKey);
      const tenantNameReservation = existingPresets.find(
        (existingPreset) =>
          !existingPreset.catalogKey &&
          normalizePresetName(existingPreset.name) === normalizePresetName(presetItem.name),
      );
      if (!catalogMatch && tenantNameReservation) {
        // A tenant-authored row owns its name even when archived. Do not turn it
        // into a managed starter, restore it, or create a same-name duplicate.
        keptPresetIds.add(tenantNameReservation.id);
        continue;
      }
      const targetPreset = catalogMatch;

      if (targetPreset) {
        const hasAuthoritativeSquareFootPricing =
          hasExplicitSquareFootPricing && presetItem.catalogKey === STANDARD_SQ_FT_BASE_CATALOG_KEY;
        if (
          catalogMatch &&
          !presetItem.wasSubmitted &&
          !hasAuthoritativeSquareFootPricing
        ) {
          // Omission never resets or restores an existing tenant-owned copy.
          keptPresetIds.add(catalogMatch.id);
          continue;
        }

        const activeNameOwner = existingPresets.find(
          (existingPreset) =>
            existingPreset.id !== targetPreset.id &&
            !existingPreset.deletedAtUtc &&
            normalizePresetName(existingPreset.name) === normalizePresetName(presetItem.name),
        );
        if (activeNameOwner) {
          throw new TenantProductNameConflictError(activeNameOwner.id, presetItem.name);
        }

        if (targetPreset.deletedAtUtc) {
          await assertTenantProductActivationCapacity(prisma, input.tenantId);
        }

        const updated = await prisma.workPreset.update({
          where: { id: targetPreset.id },
          data: {
            catalogKey: presetItem.catalogKey,
            catalogVersion: presetItem.catalogVersion,
            catalogContentHash: presetItem.catalogContentHash,
            catalogCustomizedAtUtc: isStandardWorkPresetCustomized(
              input.primaryTrade,
              presetItem.catalogKey,
              {
                description: presetItem.description,
                defaultQuantity: presetItem.defaultQuantity,
                unitCost: presetItem.unitCost,
                unitPrice: presetItem.unitPrice,
                isDefault: presetItem.isDefault ?? true,
              },
            ) ? new Date() : null,
            category: presetItem.category,
            unitType: presetItem.unitType,
            name: presetItem.name,
            description: presetItem.description,
            defaultQuantity: presetItem.defaultQuantity,
            unitCost: presetItem.unitCost,
            unitPrice: presetItem.unitPrice,
            isDefault: presetItem.isDefault ?? true,
            deletedAtUtc: null,
          },
          select: { id: true },
        });
        keptPresetIds.add(updated.id);
        Object.assign(targetPreset, {
          name: presetItem.name,
          catalogKey: presetItem.catalogKey,
          deletedAtUtc: null,
        });
        continue;
      }

      await assertTenantProductActivationCapacity(prisma, input.tenantId);
      const created = await prisma.workPreset.create({
        data: {
          tenantId: input.tenantId,
          serviceType: input.primaryTrade,
          catalogKey: presetItem.catalogKey,
          catalogVersion: presetItem.catalogVersion,
          catalogContentHash: presetItem.catalogContentHash,
          catalogCustomizedAtUtc: isStandardWorkPresetCustomized(
            input.primaryTrade,
            presetItem.catalogKey,
            {
              description: presetItem.description,
              defaultQuantity: presetItem.defaultQuantity,
              unitCost: presetItem.unitCost,
              unitPrice: presetItem.unitPrice,
              isDefault: presetItem.isDefault ?? true,
            },
          ) ? new Date() : null,
          category: presetItem.category,
          unitType: presetItem.unitType,
          name: presetItem.name,
          description: presetItem.description,
          defaultQuantity: presetItem.defaultQuantity,
          unitCost: presetItem.unitCost,
          unitPrice: presetItem.unitPrice,
          isDefault: presetItem.isDefault ?? true,
        },
        select: { id: true },
      });
      keptPresetIds.add(created.id);
      existingPresets.push({
        id: created.id,
        name: presetItem.name,
        catalogKey: presetItem.catalogKey,
        deletedAtUtc: null,
      });
    }
  }

  for (const presetItem of customPresetsToApply) {
    const normalizedName = normalizePresetName(presetItem.name);
    const idTarget = presetItem.id
      ? existingPresets.find(
          (existingPreset) => existingPreset.id === presetItem.id && !existingPreset.catalogKey,
        )
      : undefined;
    const sameNamePresets = existingPresets.filter(
      (existingPreset) => normalizePresetName(existingPreset.name) === normalizedName,
    );
    const activeNameOwner = sameNamePresets.find((existingPreset) => !existingPreset.deletedAtUtc);
    if (
      (idTarget && activeNameOwner && activeNameOwner.id !== idTarget.id) ||
      (!idTarget && activeNameOwner?.catalogKey)
    ) {
      throw new TenantProductNameConflictError(activeNameOwner.id, presetItem.name);
    }
    const targetPreset = idTarget ??
      (activeNameOwner && !activeNameOwner.catalogKey ? activeNameOwner : undefined) ??
      sameNamePresets.find((existingPreset) => existingPreset.deletedAtUtc && !existingPreset.catalogKey);

    if (targetPreset) {
      if (targetPreset.deletedAtUtc) {
        await assertTenantProductActivationCapacity(prisma, input.tenantId);
      }
      const updated = await prisma.workPreset.update({
        where: { id: targetPreset.id },
        data: {
          catalogKey: null,
          category: presetItem.category,
          unitType: presetItem.unitType,
          name: presetItem.name,
          description: presetItem.description,
          defaultQuantity: presetItem.defaultQuantity,
          unitCost: presetItem.unitCost,
          unitPrice: presetItem.unitPrice,
          isDefault: presetItem.isDefault ?? true,
          deletedAtUtc: null,
        },
        select: { id: true },
      });
      keptPresetIds.add(updated.id);
      Object.assign(targetPreset, {
        name: presetItem.name,
        catalogKey: null,
        deletedAtUtc: null,
      });
      continue;
    }

    await assertTenantProductActivationCapacity(prisma, input.tenantId);
    const created = await prisma.workPreset.create({
      data: {
        tenantId: input.tenantId,
        serviceType: input.primaryTrade,
        category: presetItem.category,
        unitType: presetItem.unitType,
        name: presetItem.name,
        description: presetItem.description,
        defaultQuantity: presetItem.defaultQuantity,
        unitCost: presetItem.unitCost,
        unitPrice: presetItem.unitPrice,
        isDefault: presetItem.isDefault ?? true,
      },
      select: { id: true },
    });
    keptPresetIds.add(created.id);
    existingPresets.push({
      id: created.id,
      name: presetItem.name,
      catalogKey: null,
      deletedAtUtc: null,
    });
  }

  // Disabling the separately managed square-foot baseline is explicit. No
  // other omitted setup item is pruned or restored by a general setup save.
  if (input.chargeBySquareFoot === false) {
    await prisma.workPreset.updateMany({
      where: {
        tenantId: input.tenantId,
        serviceType: input.primaryTrade,
        catalogKey: STANDARD_SQ_FT_BASE_CATALOG_KEY,
        deletedAtUtc: null,
      },
      data: {
        deletedAtUtc: new Date(),
      },
    });
  }

  return {
    presetsCreatedOrUpdated:
      starterCatalogResult.createdCount +
      resolvedPresetsToApply.filter((preset) => preset.wasSubmitted).length +
      customPresetsToApply.length,
  };
}

export function parseServiceCategory(input: string): ServiceCategory | null {
  const normalized = input.trim().toUpperCase();
  const candidates = Object.values(ServiceCategory) as string[];
  if (!candidates.includes(normalized)) return null;
  return normalized as ServiceCategory;
}

export async function saveTenantWorkPreset(
  prisma: Prisma.TransactionClient,
  input: SaveTenantWorkPresetInput,
) {
  const normalizedName = input.name.trim();
  if (!normalizedName) {
    throw new Error("Preset name is required.");
  }

  await lockTenantProductCatalog(prisma, input.tenantId);

  const existingPresets = await findTenantProductNameMatches(prisma, {
    tenantId: input.tenantId,
    serviceType: input.serviceType,
    name: normalizedName,
  });

  const sameNamePresets = existingPresets.filter(
    (preset) => normalizePresetName(preset.name) === normalizePresetName(normalizedName),
  );
  const activeNameOwner = sameNamePresets.find((preset) => !preset.deletedAtUtc);
  if (activeNameOwner?.catalogKey) {
    throw new TenantProductNameConflictError(activeNameOwner.id, normalizedName);
  }
  const matchedPreset = activeNameOwner ??
    sameNamePresets.find((preset) => preset.deletedAtUtc && !preset.catalogKey);

  const normalizedDescription =
    input.description !== undefined ? input.description.trim() || null : undefined;

  const payload = {
    category: input.category,
    unitType: input.unitType,
    name: normalizedName,
    description: normalizedDescription,
    defaultQuantity: clampMoney(input.defaultQuantity, 1),
    unitCost: clampMoney(input.unitCost, 0),
    unitPrice: clampMoney(input.unitPrice, 0),
    isDefault: true,
    deletedAtUtc: null,
  } satisfies Prisma.WorkPresetUncheckedUpdateInput;

  if (matchedPreset) {
    if (matchedPreset.deletedAtUtc) {
      await assertTenantProductActivationCapacity(prisma, input.tenantId);
    }
    const preset = await prisma.workPreset.update({
      where: { id: matchedPreset.id },
      data: payload,
    });
    return {
      action: matchedPreset.deletedAtUtc ? "restored" : "updated",
      preset,
    } as const;
  }

  await assertTenantProductActivationCapacity(prisma, input.tenantId);
  const preset = await prisma.workPreset.create({
    data: {
      tenantId: input.tenantId,
      serviceType: input.serviceType,
      category: input.category,
      unitType: input.unitType,
      name: normalizedName,
      description: normalizedDescription,
      defaultQuantity: clampMoney(input.defaultQuantity, 1),
      unitCost: clampMoney(input.unitCost, 0),
      unitPrice: clampMoney(input.unitPrice, 0),
      isDefault: true,
    },
  });

  return {
    action: "created",
    preset,
  } as const;
}
