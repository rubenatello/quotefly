import {
  Prisma,
  PrismaClient,
  PresetCategory,
  PresetUnitType,
  ServiceCategory,
} from "@prisma/client";
import { generateMinimalLogoDataUrl } from "./logo-generator";

export interface OnboardingPresetInput {
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

const DEFAULT_PRICING_BY_TRADE: Record<ServiceCategory, { laborRate: number; materialMarkup: number }> = {
  HVAC: { laborRate: 2.4, materialMarkup: 0.33 },
  PLUMBING: { laborRate: 2.6, materialMarkup: 0.38 },
  FLOORING: { laborRate: 2.1, materialMarkup: 0.3 },
  ROOFING: { laborRate: 2.75, materialMarkup: 0.35 },
  GARDENING: { laborRate: 1.75, materialMarkup: 0.28 },
  CONSTRUCTION: { laborRate: 3.1, materialMarkup: 0.34 },
};

function preset(
  name: string,
  category: PresetCategory,
  unitType: PresetUnitType,
  unitCost: number,
  unitPrice: number,
  description?: string,
  defaultQuantity = 1,
): OnboardingPresetInput {
  return {
    name,
    category,
    unitType,
    unitCost,
    unitPrice,
    description,
    defaultQuantity,
    isDefault: true,
  };
}

export function recommendedPresetsForTrade(serviceType: ServiceCategory): OnboardingPresetInput[] {
  if (serviceType === "PLUMBING") {
    return [
      preset("Minor Clog", "SERVICE", "FLAT", 45, 120, "Drain unclogging / minor blockage resolution."),
      preset("Pipe Replacement", "SERVICE", "FLAT", 180, 450, "Standard replacement section with fittings."),
      preset("Pipe Burst Repair", "SERVICE", "FLAT", 260, 700, "Emergency burst repair including access and sealing."),
      preset("Priority Work Fee", "FEE", "FLAT", 0, 75, "After-hours or urgent response fee."),
      preset("Labor Hour", "LABOR", "HOUR", 55, 110, "Hourly plumbing labor.", 1),
    ];
  }

  if (serviceType === "ROOFING") {
    return [
      preset("Asphalt Shingle Removal + Replace", "SERVICE", "SQ_FT", 3.8, 7.9, "Tear-off, prep, install shingles.", 100),
      preset("Underlayment Layer", "MATERIAL", "SQ_FT", 0.35, 0.85, "Synthetic underlayment.", 100),
      preset("Roof Deck Repair Allowance", "SERVICE", "SQ_FT", 1.2, 2.8, "Deck repair when damage is discovered.", 25),
      preset("Flashing Package", "MATERIAL", "FLAT", 80, 185, "Valley and edge flashing package."),
      preset("Disposal Fee", "FEE", "FLAT", 90, 220, "Dump/disposal and haul-away."),
    ];
  }

  if (serviceType === "FLOORING") {
    return [
      preset("Floor Demo + Disposal", "SERVICE", "SQ_FT", 1.1, 2.5, "Removal and disposal of old flooring.", 100),
      preset("LVP Install", "SERVICE", "SQ_FT", 2.6, 5.9, "Install luxury vinyl plank.", 100),
      preset("Tile Install", "SERVICE", "SQ_FT", 4.5, 9.5, "Tile setting and grout finish.", 100),
      preset("Underlayment", "MATERIAL", "SQ_FT", 0.42, 0.95, "Subfloor prep underlayment.", 100),
      preset("Trim/Transition Kit", "MATERIAL", "EACH", 18, 45, "Transition strips and trim."),
    ];
  }

  if (serviceType === "HVAC") {
    return [
      preset("System Tune-Up", "SERVICE", "FLAT", 65, 145, "Routine maintenance and performance check."),
      preset("AC Condenser Replacement", "SERVICE", "FLAT", 1400, 3300, "Remove and replace condenser unit."),
      preset("Furnace Install", "SERVICE", "FLAT", 1800, 4200, "Install/replace furnace unit."),
      preset("Ductwork Repair", "SERVICE", "HOUR", 70, 145, "Duct repair labor hour."),
      preset("Priority Dispatch Fee", "FEE", "FLAT", 0, 95, "After-hours dispatch fee."),
    ];
  }

  if (serviceType === "GARDENING") {
    return [
      preset("Lawn Maintenance Visit", "SERVICE", "FLAT", 30, 75, "Mow, edge, cleanup."),
      preset("Mulch Install", "MATERIAL", "SQ_FT", 0.35, 1.0, "Mulch supply and install.", 100),
      preset("Irrigation Repair", "SERVICE", "HOUR", 45, 105, "Sprinkler and irrigation labor hour."),
      preset("Seasonal Cleanup", "SERVICE", "FLAT", 80, 195, "Debris and overgrowth cleanup."),
      preset("Green Waste Disposal", "FEE", "FLAT", 20, 55, "Dump/disposal fee."),
    ];
  }

  return [
    preset("General Labor", "LABOR", "HOUR", 65, 140, "Construction labor hour."),
    preset("Site Prep", "SERVICE", "FLAT", 120, 320, "Site setup and preparation."),
    preset("Framing Package", "MATERIAL", "FLAT", 650, 1450, "Lumber and framing materials."),
    preset("Demo + Haul Away", "SERVICE", "FLAT", 220, 540, "Demolition and disposal service."),
    preset("Project Management Fee", "FEE", "FLAT", 0, 250, "Coordination and scheduling fee."),
  ];
}

function sqFtPreset(serviceType: ServiceCategory, unitCost: number, unitPrice: number): OnboardingPresetInput {
  return preset(
    `${serviceType} SQ FT Base`,
    "SERVICE",
    "SQ_FT",
    unitCost,
    unitPrice,
    "Square-foot baseline pricing preset.",
    100,
  );
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

  const recommendedPresets = input.customPresets?.length
    ? input.customPresets
    : recommendedPresetsForTrade(input.primaryTrade);

  const presetsToApply = [...recommendedPresets];
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

  for (const presetItem of presetsToApply) {
    await prisma.workPreset.upsert({
      where: {
        tenantId_serviceType_name: {
          tenantId: input.tenantId,
          serviceType: input.primaryTrade,
          name: presetItem.name,
        },
      },
      create: {
        tenantId: input.tenantId,
        serviceType: input.primaryTrade,
        category: presetItem.category,
        unitType: presetItem.unitType,
        name: presetItem.name,
        description: presetItem.description,
        defaultQuantity: clampMoney(presetItem.defaultQuantity, 1),
        unitCost: clampMoney(presetItem.unitCost, 0),
        unitPrice: clampMoney(presetItem.unitPrice, 0),
        isDefault: presetItem.isDefault ?? true,
      },
      update: {
        category: presetItem.category,
        unitType: presetItem.unitType,
        description: presetItem.description,
        defaultQuantity: clampMoney(presetItem.defaultQuantity, 1),
        unitCost: clampMoney(presetItem.unitCost, 0),
        unitPrice: clampMoney(presetItem.unitPrice, 0),
        isDefault: presetItem.isDefault ?? true,
        deletedAtUtc: null,
      },
    });
  }

  return {
    presetsCreatedOrUpdated: presetsToApply.length,
  };
}

export function parseServiceCategory(input: string): ServiceCategory | null {
  const normalized = input.trim().toUpperCase();
  const candidates = Object.values(ServiceCategory) as string[];
  if (!candidates.includes(normalized)) return null;
  return normalized as ServiceCategory;
}
