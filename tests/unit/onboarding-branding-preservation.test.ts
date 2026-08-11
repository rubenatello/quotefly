import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PresetCategory, PresetUnitType, PrismaClient, ServiceCategory } from "@prisma/client";
import { applyOnboardingSetup, type OnboardingSetupInput } from "../../src/services/onboarding";

interface BrandingState {
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string;
  templateId: string;
}

interface PresetState {
  id: string;
  name: string;
  catalogKey: string | null;
  unitCost?: number;
  unitPrice?: number;
  deletedAtUtc?: Date | null;
}

function createPrismaHarness(initialBranding: BrandingState | null, initialPresets: PresetState[] = []) {
  let branding = initialBranding;
  const presets = initialPresets.map((preset) => ({ ...preset }));
  let nextPresetId = 1;
  let lastBrandingUpdate: Record<string, unknown> | null = null;

  const prisma = {
    tenant: {
      update: async () => ({}),
    },
    tenantBranding: {
      upsert: async ({ create, update }: { create: BrandingState; update: Record<string, unknown> }) => {
        lastBrandingUpdate = update;
        branding = branding
          ? { ...branding, ...update }
          : { ...create };
        return branding;
      },
    },
    pricingProfile: {
      findFirst: async () => null,
      create: async () => ({}),
    },
    workPreset: {
      findMany: async () => presets.filter((preset) => !preset.deletedAtUtc || preset.catalogKey !== null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const preset = {
          id: `preset-${nextPresetId++}`,
          name: String(data.name),
          catalogKey: typeof data.catalogKey === "string" ? data.catalogKey : null,
          unitCost: Number(data.unitCost),
          unitPrice: Number(data.unitPrice),
          deletedAtUtc: null,
        };
        presets.push(preset);
        return { id: preset.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const preset = presets.find((candidate) => candidate.id === where.id);
        if (!preset) throw new Error(`Missing preset ${where.id}`);
        Object.assign(preset, data);
        return { id: preset.id };
      },
      updateMany: async ({ where, data }: { where: { id?: { in?: string[] } }; data: Record<string, unknown> }) => {
        const ids = new Set(where.id?.in ?? []);
        let count = 0;
        for (const preset of presets) {
          if (!ids.has(preset.id)) continue;
          Object.assign(preset, data);
          count += 1;
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    getBranding: () => branding,
    getLastBrandingUpdate: () => lastBrandingUpdate,
    getPresets: () => presets,
  };
}

function setupInput(overrides: Partial<OnboardingSetupInput> = {}) {
  return {
    tenantId: "tenant-branding-preservation",
    companyName: "Preserved Branding Co.",
    primaryTrade: ServiceCategory.ROOFING,
    ...overrides,
  };
}

test("saving setup without branding fields preserves customized tenant branding", async () => {
  const favicon = await readFile("web/public/favicon.png");
  const customizedBranding: BrandingState = {
    tenantId: "tenant-branding-preservation",
    logoUrl: `data:image/png;base64,${favicon.toString("base64")}`,
    primaryColor: "#7C3AED",
    templateId: "professional",
  };
  const harness = createPrismaHarness(customizedBranding);

  await applyOnboardingSetup(harness.prisma, setupInput());

  assert.deepEqual(harness.getLastBrandingUpdate(), {});
  assert.deepEqual(harness.getBranding(), customizedBranding);
});

test("explicit supported branding fields update while omitted setup fields retain defaults on create", async () => {
  const favicon = await readFile("web/public/favicon.png");
  const logoUrl = `data:image/png;base64,${favicon.toString("base64")}`;
  const existing = createPrismaHarness({
    tenantId: "tenant-branding-preservation",
    logoUrl: null,
    primaryColor: "#1e6fd8",
    templateId: "minimal",
  });

  await applyOnboardingSetup(existing.prisma, setupInput({ logoUrl, primaryColor: "#0F766E" }));
  assert.deepEqual(existing.getLastBrandingUpdate(), { logoUrl, primaryColor: "#0F766E" });
  assert.deepEqual(existing.getBranding(), {
    tenantId: "tenant-branding-preservation",
    logoUrl,
    primaryColor: "#0F766E",
    templateId: "minimal",
  });

  const newlyCreated = createPrismaHarness(null);
  await applyOnboardingSetup(newlyCreated.prisma, setupInput());
  assert.deepEqual(newlyCreated.getBranding(), {
    tenantId: "tenant-branding-preservation",
    logoUrl: null,
    primaryColor: "#1e6fd8",
    templateId: "modern",
  });
});

test("saving setup without presets preserves custom products and existing canonical preset values", async () => {
  const customProduct: PresetState = {
    id: "custom-product",
    name: "Custom copper flashing package",
    catalogKey: null,
    unitPrice: 275,
    deletedAtUtc: null,
  };
  const customizedCanonicalPreset: PresetState = {
    id: "canonical-product",
    name: "Roof Leak Diagnostic",
    catalogKey: "roof_leak_diagnostic",
    unitPrice: 987.65,
    deletedAtUtc: null,
  };
  const staleSquareFootPreset: PresetState = {
    id: "stale-square-foot-product",
    name: "Roofing square-foot baseline",
    catalogKey: "sq_ft_base",
    unitPrice: 12,
    deletedAtUtc: null,
  };
  const harness = createPrismaHarness(null, [customProduct, customizedCanonicalPreset, staleSquareFootPreset]);

  await applyOnboardingSetup(harness.prisma, setupInput());

  const savedCustomProduct = harness.getPresets().find((preset) => preset.id === customProduct.id);
  const savedCanonicalPreset = harness.getPresets().find((preset) => preset.id === customizedCanonicalPreset.id);
  const savedSquareFootPreset = harness.getPresets().find((preset) => preset.id === staleSquareFootPreset.id);
  assert.equal(savedCustomProduct?.deletedAtUtc, null);
  assert.equal(savedCustomProduct?.unitPrice, 275);
  assert.equal(savedCanonicalPreset?.deletedAtUtc, null);
  assert.equal(savedCanonicalPreset?.unitPrice, 987.65);
  assert.ok(savedSquareFootPreset?.deletedAtUtc instanceof Date);
  assert.equal(
    harness.getPresets().filter((preset) => preset.catalogKey === customizedCanonicalPreset.catalogKey).length,
    1,
  );
});

test("an explicit preset array reconciles custom products and keeps canonical catalog keys managed", async () => {
  const harness = createPrismaHarness(null, [
    {
      id: "canonical-product",
      name: "Roof Leak Diagnostic",
      catalogKey: "roof_leak_diagnostic",
      unitPrice: 245,
      deletedAtUtc: null,
    },
    {
      id: "kept-custom-product",
      name: "Kept custom package",
      catalogKey: null,
      unitPrice: 325,
      deletedAtUtc: null,
    },
    {
      id: "omitted-custom-product",
      name: "Omitted custom package",
      catalogKey: null,
      unitPrice: 425,
      deletedAtUtc: null,
    },
  ]);

  await applyOnboardingSetup(
    harness.prisma,
    setupInput({
      customPresets: [
        {
          id: "canonical-product",
          catalogKey: "roof_leak_diagnostic",
          name: "Roof Leak Diagnostic",
          description: "Tenant-adjusted diagnostic.",
          category: PresetCategory.SERVICE,
          unitType: PresetUnitType.FLAT,
          defaultQuantity: 1,
          unitCost: 100,
          unitPrice: 295,
          isDefault: true,
        },
        {
          id: "kept-custom-product",
          name: "Kept custom package",
          category: PresetCategory.SERVICE,
          unitType: PresetUnitType.FLAT,
          defaultQuantity: 1,
          unitCost: 125,
          unitPrice: 350,
          isDefault: true,
        },
      ],
    }),
  );

  const canonical = harness.getPresets().find((preset) => preset.id === "canonical-product");
  const keptCustom = harness.getPresets().find((preset) => preset.id === "kept-custom-product");
  const omittedCustom = harness.getPresets().find((preset) => preset.id === "omitted-custom-product");
  assert.equal(canonical?.catalogKey, "roof_leak_diagnostic");
  assert.equal(canonical?.unitPrice, 295);
  assert.equal(keptCustom?.unitPrice, 350);
  assert.equal(keptCustom?.deletedAtUtc, null);
  assert.ok(omittedCustom?.deletedAtUtc instanceof Date);
});

test("explicit square-foot pricing updates an existing baseline when presets are omitted", async () => {
  const harness = createPrismaHarness(null, [
    {
      id: "sq-ft-base",
      name: "ROOFING SQ FT Base",
      catalogKey: "sq_ft_base",
      unitCost: 4,
      unitPrice: 9,
      deletedAtUtc: null,
    },
  ]);

  await applyOnboardingSetup(
    harness.prisma,
    setupInput({
      chargeBySquareFoot: true,
      sqFtUnitCost: 7.25,
      sqFtUnitPrice: 15.5,
    }),
  );

  const squareFootPreset = harness.getPresets().find((preset) => preset.id === "sq-ft-base");
  assert.equal(squareFootPreset?.unitCost, 7.25);
  assert.equal(squareFootPreset?.unitPrice, 15.5);
  assert.equal(squareFootPreset?.deletedAtUtc, null);
});

test("explicit square-foot pricing overrides stale values in a submitted preset array", async () => {
  const harness = createPrismaHarness(null, [
    {
      id: "sq-ft-base",
      name: "ROOFING SQ FT Base",
      catalogKey: "sq_ft_base",
      unitCost: 4,
      unitPrice: 9,
      deletedAtUtc: null,
    },
  ]);

  await applyOnboardingSetup(
    harness.prisma,
    setupInput({
      chargeBySquareFoot: true,
      sqFtUnitCost: 8.5,
      sqFtUnitPrice: 18.75,
      customPresets: [
        {
          id: "sq-ft-base",
          catalogKey: "sq_ft_base",
          name: "ROOFING SQ FT Base",
          description: "Stale setup form values.",
          category: PresetCategory.SERVICE,
          unitType: PresetUnitType.SQ_FT,
          defaultQuantity: 100,
          unitCost: 5,
          unitPrice: 11,
          isDefault: true,
        },
      ],
    }),
  );

  const squareFootPreset = harness.getPresets().find((preset) => preset.id === "sq-ft-base");
  assert.equal(squareFootPreset?.unitCost, 8.5);
  assert.equal(squareFootPreset?.unitPrice, 18.75);
  assert.equal(squareFootPreset?.deletedAtUtc, null);
});

test("disabling and re-enabling square-foot pricing restores the managed baseline without a duplicate", async () => {
  const harness = createPrismaHarness(null, [
    {
      id: "sq-ft-base",
      name: "ROOFING SQ FT Base",
      catalogKey: "sq_ft_base",
      unitCost: 4,
      unitPrice: 9,
      deletedAtUtc: null,
    },
  ]);

  await applyOnboardingSetup(harness.prisma, setupInput({ chargeBySquareFoot: false }));
  const disabledPreset = harness.getPresets().find((preset) => preset.id === "sq-ft-base");
  assert.ok(disabledPreset?.deletedAtUtc instanceof Date);

  await applyOnboardingSetup(
    harness.prisma,
    setupInput({
      chargeBySquareFoot: true,
      sqFtUnitCost: 9.25,
      sqFtUnitPrice: 19.75,
    }),
  );

  const squareFootPresets = harness.getPresets().filter((preset) => preset.catalogKey === "sq_ft_base");
  assert.equal(squareFootPresets.length, 1);
  assert.equal(squareFootPresets[0]?.id, "sq-ft-base");
  assert.equal(squareFootPresets[0]?.deletedAtUtc, null);
  assert.equal(squareFootPresets[0]?.unitCost, 9.25);
  assert.equal(squareFootPresets[0]?.unitPrice, 19.75);
});
