import type {
  PresetCategory,
  PresetUnitType,
  PrismaClient,
  ServiceCategory,
} from "@prisma/client";
import type { ChatQuoteLineItemSuggestion } from "./chat-to-quote";
import { getStandardWorkPresetDefinition } from "./work-preset-catalog";

type TenantQuotePreset = {
  id: string;
  catalogKey: string | null;
  name: string;
  description: string | null;
  category: PresetCategory;
  unitType: PresetUnitType;
  defaultQuantity: unknown;
  unitCost?: unknown;
  unitPrice: unknown;
};

export type PreparedCatalogQuoteLine = {
  description: string;
  quantity: number;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel: string | null;
  sourcePresetId: string | null;
  catalogKey: string | null;
  unitType: PresetUnitType | null;
  unitPrice: number | null;
  unitCost: number | null;
  priceProvenance: "TENANT_PRESET" | "STANDARD_CATALOG" | "UNRESOLVED";
  catalogMatched: boolean;
};

const GENERIC_MATCH_TOKENS = new Set([
  "about", "add", "customer", "draft", "estimate", "hours", "item", "job", "kody",
  "need", "package", "please", "prepare", "product", "quote", "review", "service", "take",
  "work", "with", "depending",
]);

function normalizedText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string) {
  return normalizedText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !GENERIC_MATCH_TOKENS.has(token));
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : 0;
}

function positiveQuantity(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : fallback;
}

function presetDescription(preset: TenantQuotePreset) {
  const details = preset.description?.trim();
  return details ? `${preset.name}\n${details}` : preset.name;
}

function explicitPresetScore(preset: TenantQuotePreset, prompt: string) {
  const normalizedPrompt = normalizedText(prompt);
  const normalizedName = normalizedText(preset.name);
  if (!normalizedPrompt || !normalizedName) return 0;
  if (normalizedPrompt.includes(normalizedName)) return 100;

  const nameTokens = meaningfulTokens(`${preset.name} ${preset.catalogKey ?? ""}`);
  if (!nameTokens.length) return 0;
  const hits = nameTokens.filter((token) => normalizedPrompt.includes(token)).length;
  if (hits === nameTokens.length && hits >= 2) return 40 + hits;
  if (hits >= 2) return 20 + hits;
  if (hits === 1 && nameTokens.length === 1 && nameTokens[0]!.length >= 5) return 8;
  return 0;
}

function selectHourlyPreset(presets: TenantQuotePreset[], usedIds: Set<string>) {
  return presets
    .filter((preset) => preset.unitType === "HOUR" && !usedIds.has(preset.id))
    .sort((left, right) => {
      const leftScore = (left.category === "LABOR" ? 4 : 0) + (/labor/i.test(left.name) ? 2 : 0);
      const rightScore = (right.category === "LABOR" ? 4 : 0) + (/labor/i.test(right.name) ? 2 : 0);
      return rightScore - leftScore || left.name.localeCompare(right.name);
    })[0] ?? null;
}

function lineFromPreset(
  preset: TenantQuotePreset,
  parsedLine: ChatQuoteLineItemSuggestion,
  quantityOverride: number | null,
  includeInternalCost: boolean,
): PreparedCatalogQuoteLine {
  return {
    description: presetDescription(preset),
    quantity: quantityOverride ?? positiveQuantity(parsedLine.quantity, positiveQuantity(preset.defaultQuantity)),
    sectionType: parsedLine.sectionType ?? "INCLUDED",
    sectionLabel: parsedLine.sectionLabel ?? null,
    sourcePresetId: preset.id,
    catalogKey: preset.catalogKey,
    unitType: preset.unitType,
    unitPrice: money(preset.unitPrice),
    unitCost: includeInternalCost ? money(preset.unitCost) : null,
    priceProvenance: "TENANT_PRESET",
    catalogMatched: true,
  };
}

function lineFromStandardPreset(
  serviceType: ServiceCategory,
  parsedLine: ChatQuoteLineItemSuggestion,
  quantityOverride: number | null,
  includeInternalCost: boolean,
): PreparedCatalogQuoteLine | null {
  if (!parsedLine.catalogKey) return null;
  const preset = getStandardWorkPresetDefinition(serviceType, parsedLine.catalogKey);
  if (!preset) return null;
  const details = preset.description?.trim();
  return {
    description: details ? `${preset.name}\n${details}` : preset.name,
    quantity: quantityOverride ?? positiveQuantity(parsedLine.quantity, positiveQuantity(preset.defaultQuantity)),
    sectionType: parsedLine.sectionType ?? "INCLUDED",
    sectionLabel: parsedLine.sectionLabel ?? null,
    sourcePresetId: null,
    catalogKey: preset.catalogKey,
    unitType: preset.unitType,
    unitPrice: money(preset.unitPrice),
    unitCost: includeInternalCost ? money(preset.unitCost) : null,
    priceProvenance: "STANDARD_CATALOG",
    catalogMatched: true,
  };
}

function fallbackLine(parsedLine: ChatQuoteLineItemSuggestion): PreparedCatalogQuoteLine {
  return {
    description: parsedLine.description,
    quantity: positiveQuantity(parsedLine.quantity),
    sectionType: parsedLine.sectionType ?? "INCLUDED",
    sectionLabel: parsedLine.sectionLabel ?? null,
    sourcePresetId: null,
    catalogKey: parsedLine.catalogKey ?? null,
    unitType: parsedLine.unitType ?? null,
    unitPrice: null,
    unitCost: null,
    priceProvenance: "UNRESOLVED",
    catalogMatched: false,
  };
}

export async function prepareCatalogQuoteLines(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    serviceType: ServiceCategory;
    prompt: string;
    parsedLines: readonly ChatQuoteLineItemSuggestion[];
    estimatedDurationHoursHigh: number | null;
    includeInternalCost: boolean;
  },
): Promise<{ lines: PreparedCatalogQuoteLine[]; matchedPresetLabels: string[] }> {
  const presets = await prisma.workPreset.findMany({
    where: {
      tenantId: input.tenantId,
      serviceType: input.serviceType,
      deletedAtUtc: null,
    },
    orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      catalogKey: true,
      name: true,
      description: true,
      category: true,
      unitType: true,
      defaultQuantity: true,
      ...(input.includeInternalCost ? { unitCost: true } : {}),
      unitPrice: true,
    },
  }) as TenantQuotePreset[];

  const byCatalogKey = new Map(
    presets.flatMap((preset) => preset.catalogKey ? [[preset.catalogKey, preset] as const] : []),
  );
  const usedIds = new Set<string>();
  const lines: PreparedCatalogQuoteLine[] = [];

  for (const parsedLine of input.parsedLines.slice(0, 8)) {
    let preset = parsedLine.catalogKey ? byCatalogKey.get(parsedLine.catalogKey) ?? null : null;
    if (!preset && parsedLine.unitType === "HOUR" && input.estimatedDurationHoursHigh) {
      preset = selectHourlyPreset(presets, usedIds);
    }
    if (!preset) {
      const explicitMatch = presets
        .filter((candidate) => !usedIds.has(candidate.id))
        .map((candidate) => ({ preset: candidate, score: explicitPresetScore(candidate, parsedLine.description) }))
        .filter((candidate) => candidate.score >= 8)
        .sort((left, right) => right.score - left.score || left.preset.name.localeCompare(right.preset.name))[0];
      preset = explicitMatch?.preset ?? null;
    }

    if (preset && !usedIds.has(preset.id)) {
      usedIds.add(preset.id);
      lines.push(lineFromPreset(
        preset,
        parsedLine,
        parsedLine.unitType === "HOUR" && input.estimatedDurationHoursHigh
          ? input.estimatedDurationHoursHigh
          : null,
        input.includeInternalCost,
      ));
    } else {
      lines.push(
        lineFromStandardPreset(
          input.serviceType,
          parsedLine,
          parsedLine.unitType === "HOUR" && input.estimatedDurationHoursHigh
            ? input.estimatedDurationHoursHigh
            : null,
          input.includeInternalCost,
        ) ?? fallbackLine(parsedLine),
      );
    }
  }

  const explicitlyNamedPresets = presets
    .filter((preset) => !usedIds.has(preset.id))
    .map((preset) => ({ preset, score: explicitPresetScore(preset, input.prompt) }))
    .filter((candidate) => candidate.score >= 20)
    .sort((left, right) => right.score - left.score || left.preset.name.localeCompare(right.preset.name))
    .slice(0, Math.max(0, 8 - lines.length));

  for (const { preset } of explicitlyNamedPresets) {
    usedIds.add(preset.id);
    lines.push(lineFromPreset(preset, {
      description: preset.name,
      quantity: positiveQuantity(preset.defaultQuantity),
      sectionType: "INCLUDED",
      sectionLabel: null,
      catalogKey: preset.catalogKey ?? undefined,
      unitType: preset.unitType,
    }, null, input.includeInternalCost));
  }

  return {
    lines: lines.slice(0, 8),
    matchedPresetLabels: presets.filter((preset) => usedIds.has(preset.id)).map((preset) => preset.name),
  };
}
