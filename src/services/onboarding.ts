import {
  PresetCategory,
  PresetUnitType,
  Prisma,
  PrismaClient,
  ServiceCategory,
} from "@prisma/client";
import { generateMinimalLogoDataUrl } from "./logo-generator";
import {
  buildSquareFootBaselinePreset,
  getStandardWorkPresetCatalog,
  getStandardWorkPresetDefinition,
} from "./work-preset-catalog";

export interface OnboardingPresetInput {
  id?: string;
  catalogKey?: string | null;
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
  logoUrl?: string | null;
  primaryColor?: string;
  generateLogoIfMissing?: boolean;
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

function resolveLogoUrl(
  companyName: string,
  suppliedLogoUrl?: string | null,
  primaryColor?: string,
  generateLogoIfMissing = true,
): string | null {
  const normalizedSupplied = suppliedLogoUrl?.trim();
  if (normalizedSupplied) return normalizedSupplied;
  if (!generateLogoIfMissing) return null;
  return generateMinimalLogoDataUrl(companyName, primaryColor ?? "#1e6fd8");
}

export async function applyOnboardingSetup(
  prisma: PrismaClient | Prisma.TransactionClient,
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

  const normalizedPrimaryColor = input.primaryColor?.trim() || "#1e6fd8";
  const logoUrl = resolveLogoUrl(
    input.companyName,
    input.logoUrl,
    normalizedPrimaryColor,
    input.generateLogoIfMissing ?? true,
  );

  const submittedPresets = input.customPresets?.length
    ? input.customPresets
    : recommendedPresetsForTrade(input.primaryTrade);

  const standardPresets = recommendedPresetsForTrade(input.primaryTrade);
  const presetsToApply = [...standardPresets];
  if (
    input.chargeBySquareFoot &&
    Number.isFinite(input.sqFtUnitCost) &&
    Number.isFinite(input.sqFtUnitPrice)
  ) {
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

      return !candidate.catalogKey && normalizePresetName(candidate.name) === normalizePresetName(presetItem.name);
    });

    const matchedPreset = matchedIndex >= 0 ? submittedPresets[matchedIndex] : undefined;
    if (matchedIndex >= 0) matchedPresetIndexes.add(matchedIndex);

    const catalogPreset = presetItem.catalogKey
      ? getStandardWorkPresetDefinition(input.primaryTrade, presetItem.catalogKey) ?? presetItem
      : presetItem;

    return {
      id: matchedPreset?.id,
      catalogKey: catalogPreset.catalogKey ?? null,
      name: catalogPreset.name,
      description: matchedPreset?.description?.trim() || catalogPreset.description,
      category: catalogPreset.category,
      unitType: catalogPreset.unitType,
      defaultQuantity: clampMoney(matchedPreset?.defaultQuantity, catalogPreset.defaultQuantity),
      unitCost: clampMoney(matchedPreset?.unitCost, catalogPreset.unitCost),
      unitPrice: clampMoney(matchedPreset?.unitPrice, catalogPreset.unitPrice),
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

  await prisma.tenant.update({
    where: { id: input.tenantId },
    data: {
      primaryTrade: input.primaryTrade,
      onboardingCompletedAtUtc: new Date(),
    },
  });

  await prisma.tenantBranding.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      logoUrl,
      primaryColor: normalizedPrimaryColor,
      templateId: "modern",
    },
    update: {
      logoUrl,
      primaryColor: normalizedPrimaryColor,
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
      deletedAtUtc: null,
    },
    select: {
      id: true,
      name: true,
      catalogKey: true,
    },
  });

  const keptPresetIds = new Set<string>();

  for (const presetItem of resolvedPresetsToApply) {
    const legacyMatch = existingPresets.find(
      (existingPreset) =>
        !existingPreset.catalogKey &&
        normalizePresetName(existingPreset.name) === normalizePresetName(presetItem.name),
    );

    if (presetItem.catalogKey) {
      const catalogMatch = existingPresets.find((existingPreset) => existingPreset.catalogKey === presetItem.catalogKey);
      const targetPreset = catalogMatch ?? legacyMatch;

      if (targetPreset) {
        const updated = await prisma.workPreset.update({
          where: { id: targetPreset.id },
          data: {
            catalogKey: presetItem.catalogKey,
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
        continue;
      }

      const created = await prisma.workPreset.create({
        data: {
          tenantId: input.tenantId,
          serviceType: input.primaryTrade,
          catalogKey: presetItem.catalogKey,
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
    }
  }

  for (const presetItem of customPresetsToApply) {
    const targetPreset =
      (presetItem.id
        ? existingPresets.find((existingPreset) => existingPreset.id === presetItem.id)
        : undefined) ??
      existingPresets.find(
        (existingPreset) =>
          !existingPreset.catalogKey &&
          normalizePresetName(existingPreset.name) === normalizePresetName(presetItem.name),
      );

    if (targetPreset) {
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
      continue;
    }

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
  }

  const presetIdsToDelete = existingPresets
    .filter((presetItem) => !keptPresetIds.has(presetItem.id))
    .map((presetItem) => presetItem.id);

  if (presetIdsToDelete.length > 0) {
    await prisma.workPreset.updateMany({
      where: {
        tenantId: input.tenantId,
        id: { in: presetIdsToDelete },
      },
      data: {
        deletedAtUtc: new Date(),
      },
    });
  }

  return {
    presetsCreatedOrUpdated: resolvedPresetsToApply.length + customPresetsToApply.length,
  };
}

export function parseServiceCategory(input: string): ServiceCategory | null {
  const normalized = input.trim().toUpperCase();
  const candidates = Object.values(ServiceCategory) as string[];
  if (!candidates.includes(normalized)) return null;
  return normalized as ServiceCategory;
}

export async function saveTenantWorkPreset(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: SaveTenantWorkPresetInput,
) {
  const normalizedName = input.name.trim();
  if (!normalizedName) {
    throw new Error("Preset name is required.");
  }

  const existingPresets = await prisma.workPreset.findMany({
    where: {
      tenantId: input.tenantId,
      serviceType: input.serviceType,
      catalogKey: null,
    },
    select: {
      id: true,
      name: true,
      deletedAtUtc: true,
    },
    take: 200,
  });

  const matchedPreset = existingPresets.find(
    (preset) => normalizePresetName(preset.name) === normalizePresetName(normalizedName),
  );

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
    const preset = await prisma.workPreset.update({
      where: { id: matchedPreset.id },
      data: payload,
    });

    return {
      action: matchedPreset.deletedAtUtc ? "restored" : "updated",
      preset,
    } as const;
  }

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
