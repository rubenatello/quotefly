import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { prepareCatalogQuoteLines } from "../../src/services/ai-quote-catalog";

function fakePrisma(presets: Array<Record<string, unknown>>) {
  return {
    workPreset: {
      findMany: async () => presets,
    },
  } as unknown as PrismaClient;
}

test("prepares separate source-linked lines from the active tenant catalog", async () => {
  const presets = [
    {
      id: "fixture-preset",
      catalogKey: "fixture_install_package",
      name: "Fixture replacement",
      description: "Replace the selected faucet fixture.",
      category: "MATERIAL",
      unitType: "EACH",
      defaultQuantity: 1,
      unitCost: 80,
      unitPrice: 225,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `custom-${index}`,
      catalogKey: null,
      name: index === 8 ? "Premium inspection" : `Unrelated item ${index}`,
      description: null,
      category: "SERVICE",
      unitType: "FLAT",
      defaultQuantity: 1,
      unitCost: 10,
      unitPrice: index === 8 ? 175 : 25,
    })),
    {
      id: "labor-preset",
      catalogKey: null,
      name: "Plumbing labor",
      description: "Hourly field labor.",
      category: "LABOR",
      unitType: "HOUR",
      defaultQuantity: 1,
      unitCost: 42,
      unitPrice: 95,
    },
  ];

  const prepared = await prepareCatalogQuoteLines(fakePrisma(presets), {
    tenantId: "tenant-1",
    serviceType: "PLUMBING",
    prompt: "Replace a faucet, add Premium inspection, and allow 3-4 hours.",
    parsedLines: [{
      description: "Fixture Install Package",
      quantity: 1,
      sectionType: "INCLUDED",
      sectionLabel: null,
      catalogKey: "fixture_install_package",
      unitType: "EACH",
    }, {
      description: "Plumbing labor hours",
      quantity: 4,
      sectionType: "INCLUDED",
      sectionLabel: null,
      unitType: "HOUR",
    }],
    estimatedDurationHoursHigh: 4,
    includeInternalCost: true,
  });

  assert.deepEqual(prepared.lines.map((line) => ({
    sourcePresetId: line.sourcePresetId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    unitCost: line.unitCost,
  })), [{
    sourcePresetId: "fixture-preset",
    quantity: 1,
    unitPrice: 225,
    unitCost: 80,
  }, {
    sourcePresetId: "labor-preset",
    quantity: 4,
    unitPrice: 95,
    unitCost: 42,
  }, {
    sourcePresetId: "custom-8",
    quantity: 1,
    unitPrice: 175,
    unitCost: 10,
  }]);
});

test("omits internal cost when the caller cannot view it", async () => {
  const prepared = await prepareCatalogQuoteLines(fakePrisma([{
    id: "labor-preset",
    catalogKey: null,
    name: "Labor Hours",
    description: null,
    category: "LABOR",
    unitType: "HOUR",
    defaultQuantity: 1,
    unitPrice: 75,
  }]), {
    tenantId: "tenant-1",
    serviceType: "PLUMBING",
    prompt: "Use Labor Hours for 4 hours.",
    parsedLines: [{
      description: "Plumbing labor hours",
      quantity: 4,
      sectionType: "INCLUDED",
      sectionLabel: null,
      unitType: "HOUR",
    }],
    estimatedDurationHoursHigh: 4,
    includeInternalCost: false,
  });

  assert.equal(prepared.lines[0]?.unitPrice, 75);
  assert.equal(prepared.lines[0]?.unitCost, null);
});

test("uses the standard trade catalog with explicit provenance when no tenant preset exists", async () => {
  const prepared = await prepareCatalogQuoteLines(fakePrisma([]), {
    tenantId: "tenant-1",
    serviceType: "PLUMBING",
    prompt: "Replace the kitchen faucet.",
    parsedLines: [{
      description: "Fixture Install Package",
      quantity: 1,
      sectionType: "INCLUDED",
      sectionLabel: null,
      catalogKey: "fixture_install_package",
      unitType: "EACH",
    }],
    estimatedDurationHoursHigh: null,
    includeInternalCost: false,
  });

  assert.equal(prepared.lines.length, 1);
  assert.equal(prepared.lines[0]?.sourcePresetId, null);
  assert.equal(prepared.lines[0]?.catalogKey, "fixture_install_package");
  assert.equal(prepared.lines[0]?.priceProvenance, "STANDARD_CATALOG");
  assert.equal((prepared.lines[0]?.unitPrice ?? 0) > 0, true);
  assert.equal(prepared.lines[0]?.unitCost, null);
});

test("preserves reconciled prompt prices as separate lines without adding catalog matches", async () => {
  const prepared = await prepareCatalogQuoteLines(fakePrisma([{
    id: "construction-labor",
    catalogKey: null,
    name: "General labor",
    description: null,
    category: "LABOR",
    unitType: "HOUR",
    defaultQuantity: 1,
    unitCost: 50,
    unitPrice: 100,
  }]), {
    tenantId: "tenant-1",
    serviceType: "CONSTRUCTION",
    prompt: "Custom wooden table with $2000 materials and $1500 labor.",
    parsedLines: [{
      description: "Custom wooden table materials",
      quantity: 1,
      unitPrice: 2000,
      sectionType: "INCLUDED",
      sectionLabel: null,
      unitType: "FLAT",
    }, {
      description: "Custom wooden table labor",
      quantity: 1,
      unitPrice: 1500,
      sectionType: "INCLUDED",
      sectionLabel: null,
      unitType: "FLAT",
    }],
    estimatedDurationHoursHigh: null,
    includeInternalCost: true,
  });

  assert.deepEqual(prepared.lines.map((line) => ({
    description: line.description,
    unitPrice: line.unitPrice,
    unitCost: line.unitCost,
    sourcePresetId: line.sourcePresetId,
    priceProvenance: line.priceProvenance,
  })), [{
    description: "Custom wooden table materials",
    unitPrice: 2000,
    unitCost: null,
    sourcePresetId: null,
    priceProvenance: "EXPLICIT_PROMPT",
  }, {
    description: "Custom wooden table labor",
    unitPrice: 1500,
    unitCost: null,
    sourcePresetId: null,
    priceProvenance: "EXPLICIT_PROMPT",
  }]);
  assert.deepEqual(prepared.matchedPresetLabels, []);
});
