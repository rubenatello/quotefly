import { PresetCategory, PresetUnitType, ServiceCategory } from "@prisma/client";

export interface StandardWorkPresetDefinition {
  catalogKey: string;
  name: string;
  description?: string;
  category: PresetCategory;
  unitType: PresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
  isDefault?: boolean;
  matchKeywords?: string[];
}

export const STANDARD_SQ_FT_BASE_CATALOG_KEY = "sq_ft_base";

function standardPreset(
  catalogKey: string,
  name: string,
  category: PresetCategory,
  unitType: PresetUnitType,
  unitCost: number,
  unitPrice: number,
  description?: string,
  defaultQuantity = 1,
  matchKeywords?: string[],
): StandardWorkPresetDefinition {
  return {
    catalogKey,
    name,
    category,
    unitType,
    unitCost,
    unitPrice,
    description,
    defaultQuantity,
    isDefault: true,
    matchKeywords,
  };
}

const STANDARD_WORK_PRESET_CATALOG: Record<ServiceCategory, StandardWorkPresetDefinition[]> = {
  PLUMBING: [
    standardPreset("minor_clog", "Minor Clog", "SERVICE", "FLAT", 45, 120, "Drain unclogging / minor blockage resolution.", 1, ["clog", "drain", "blockage", "unclog"]),
    standardPreset("pipe_replacement", "Pipe Replacement", "SERVICE", "FLAT", 180, 450, "Standard replacement section with fittings.", 1, ["pipe replacement", "replace pipe", "repipe", "new pipe"]),
    standardPreset("pipe_burst_repair", "Pipe Burst Repair", "SERVICE", "FLAT", 260, 700, "Emergency burst repair including access and sealing.", 1, ["burst pipe", "pipe burst", "leak", "broken pipe"]),
    standardPreset("priority_work_fee", "Priority Work Fee", "FEE", "FLAT", 0, 75, "After-hours or urgent response fee.", 1, ["priority", "urgent", "after hours", "emergency"]),
    standardPreset("labor_hour", "Labor Hour", "LABOR", "HOUR", 55, 110, "Hourly plumbing labor.", 1, ["labor hour", "hourly labor"]),
  ],
  ROOFING: [
    standardPreset("asphalt_shingle_remove_replace", "Asphalt Shingle Roof Tear-Off and Replacement", "SERVICE", "SQ_FT", 3.8, 7.9, "Remove existing shingles, dispose of debris, inspect roof deck, install underlayment, then install new shingles and accessories.", 100, ["asphalt shingle", "shingle", "tear-off", "tear off", "roof replacement", "replace roof", "reroof", "re-roof"]),
    standardPreset("underlayment_layer", "Underlayment Layer", "MATERIAL", "SQ_FT", 0.35, 0.85, "Synthetic underlayment.", 100, ["underlayment"]),
    standardPreset("roof_deck_repair_allowance", "Roof Deck Repair Allowance", "SERVICE", "SQ_FT", 1.2, 2.8, "Deck repair when damage is discovered.", 25, ["deck repair", "roof deck", "rot", "wood rot", "damaged deck"]),
    standardPreset("flashing_package", "Flashing Package", "MATERIAL", "FLAT", 80, 185, "Valley and edge flashing package.", 1, ["flashing", "valley", "edge metal"]),
    standardPreset("disposal_fee", "Disposal Fee", "FEE", "FLAT", 90, 220, "Dump/disposal and haul-away.", 1, ["disposal", "haul away", "haul-away", "dump"]),
  ],
  FLOORING: [
    standardPreset("floor_demo_disposal", "Floor Demo + Disposal", "SERVICE", "SQ_FT", 1.1, 2.5, "Removal and disposal of old flooring.", 100, ["demo", "demolition", "remove flooring", "floor removal"]),
    standardPreset("lvp_install", "LVP Install", "SERVICE", "SQ_FT", 2.6, 5.9, "Install luxury vinyl plank.", 100, ["lvp", "vinyl plank", "luxury vinyl plank"]),
    standardPreset("tile_install", "Tile Install", "SERVICE", "SQ_FT", 4.5, 9.5, "Tile setting and grout finish.", 100, ["tile", "grout"]),
    standardPreset("underlayment", "Underlayment", "MATERIAL", "SQ_FT", 0.42, 0.95, "Subfloor prep underlayment.", 100, ["underlayment"]),
    standardPreset("trim_transition_kit", "Trim/Transition Kit", "MATERIAL", "EACH", 18, 45, "Transition strips and trim.", 1, ["transition", "trim"]),
  ],
  HVAC: [
    standardPreset("system_tune_up", "System Tune-Up", "SERVICE", "FLAT", 65, 145, "Routine maintenance and performance check.", 1, ["tune up", "tune-up", "maintenance", "service"]),
    standardPreset("ac_condenser_replacement", "AC Condenser Replacement", "SERVICE", "FLAT", 1400, 3300, "Remove and replace condenser unit.", 1, ["condenser", "ac replacement", "replace ac", "air conditioner", "ac unit"]),
    standardPreset("furnace_install", "Furnace Install", "SERVICE", "FLAT", 1800, 4200, "Install/replace furnace unit.", 1, ["furnace", "heater", "heating system"]),
    standardPreset("ductwork_repair", "Ductwork Repair", "SERVICE", "HOUR", 70, 145, "Duct repair labor hour.", 1, ["duct", "ductwork", "vents"]),
    standardPreset("priority_dispatch_fee", "Priority Dispatch Fee", "FEE", "FLAT", 0, 95, "After-hours dispatch fee.", 1, ["priority", "urgent", "after hours", "emergency"]),
  ],
  GARDENING: [
    standardPreset("lawn_maintenance_visit", "Lawn Maintenance Visit", "SERVICE", "FLAT", 30, 75, "Mow, edge, cleanup.", 1, ["lawn maintenance", "mow", "mowing", "yard maintenance"]),
    standardPreset("mulch_install", "Mulch Install", "MATERIAL", "SQ_FT", 0.35, 1, "Mulch supply and install.", 100, ["mulch"]),
    standardPreset("irrigation_repair", "Irrigation Repair", "SERVICE", "HOUR", 45, 105, "Sprinkler and irrigation labor hour.", 1, ["irrigation", "sprinkler"]),
    standardPreset("seasonal_cleanup", "Seasonal Cleanup", "SERVICE", "FLAT", 80, 195, "Debris and overgrowth cleanup.", 1, ["cleanup", "seasonal cleanup", "yard cleanup"]),
    standardPreset("green_waste_disposal", "Green Waste Disposal", "FEE", "FLAT", 20, 55, "Dump/disposal fee.", 1, ["green waste", "disposal", "haul away", "haul-away"]),
  ],
  CONSTRUCTION: [
    standardPreset("general_labor", "General Labor", "LABOR", "HOUR", 65, 140, "Construction labor hour.", 1, ["general labor", "labor"]),
    standardPreset("site_prep", "Site Prep", "SERVICE", "FLAT", 120, 320, "Site setup and preparation.", 1, ["site prep", "site preparation", "prep"]),
    standardPreset("framing_package", "Framing Package", "MATERIAL", "FLAT", 650, 1450, "Lumber and framing materials.", 1, ["framing", "frame", "lumber"]),
    standardPreset("demo_haul_away", "Demo + Haul Away", "SERVICE", "FLAT", 220, 540, "Demolition and disposal service.", 1, ["demo", "demolition", "haul away", "haul-away"]),
    standardPreset("project_management_fee", "Project Management Fee", "FEE", "FLAT", 0, 250, "Coordination and scheduling fee.", 1, ["project management", "coordination"]),
  ],
};

export function getStandardWorkPresetCatalog(serviceType: ServiceCategory): StandardWorkPresetDefinition[] {
  return STANDARD_WORK_PRESET_CATALOG[serviceType].map((preset) => ({ ...preset }));
}

export function getStandardWorkPresetDefinition(
  serviceType: ServiceCategory,
  catalogKey: string,
): StandardWorkPresetDefinition | null {
  return (
    STANDARD_WORK_PRESET_CATALOG[serviceType].find((preset) => preset.catalogKey === catalogKey) ?? null
  );
}

export function buildSquareFootBaselinePreset(
  serviceType: ServiceCategory,
  unitCost: number,
  unitPrice: number,
): StandardWorkPresetDefinition {
  return standardPreset(
    STANDARD_SQ_FT_BASE_CATALOG_KEY,
    `${serviceType} SQ FT Base`,
    "SERVICE",
    "SQ_FT",
    unitCost,
    unitPrice,
    "Square-foot baseline pricing preset.",
    100,
  );
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

export function findBestStandardWorkPresetMatch(
  serviceType: ServiceCategory,
  text: string,
): StandardWorkPresetDefinition | null {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return null;

  let bestMatch: StandardWorkPresetDefinition | null = null;
  let bestScore = 0;

  for (const preset of STANDARD_WORK_PRESET_CATALOG[serviceType]) {
    const keywords = preset.matchKeywords ?? [];
    let score = 0;

    for (const keyword of keywords) {
      if (normalizedText.includes(normalizeText(keyword))) {
        score += keyword.includes(" ") ? 4 : 2;
      }
    }

    if (normalizedText.includes(normalizeText(preset.name))) {
      score += 5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = preset;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}
