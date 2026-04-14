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
  isPrimaryJob?: boolean;
  quantityMode?: "default" | "project_area";
}

export const STANDARD_SQ_FT_BASE_CATALOG_KEY = "sq_ft_base";

const MATCHING_ALIASES: Array<[RegExp, string]> = [
  [/\bqoute\b/g, "quote"],
  [/\bestimte\b/g, "estimate"],
  [/\breplce\b/g, "replace"],
  [/\binstal\b/g, "install"],
  [/\bfurnce\b/g, "furnace"],
  [/\bdrane\b/g, "drain"],
  [/\btriming\b/g, "trimming"],
  [/\bchimmney\b/g, "chimney"],
  [/\brepiar\b/g, "repair"],
  [/\bcontorl\b/g, "control"],
  [/\btreatmnt\b/g, "treatment"],
  [/\bclean\s+up\b/g, "cleanup"],
];

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
  options?: {
    isPrimaryJob?: boolean;
    quantityMode?: "default" | "project_area";
  },
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
    isPrimaryJob: options?.isPrimaryJob ?? category === "SERVICE",
    quantityMode: options?.quantityMode ?? (unitType === "SQ_FT" ? "project_area" : "default"),
  };
}

const STANDARD_WORK_PRESET_CATALOG: Record<ServiceCategory, StandardWorkPresetDefinition[]> = {
  PLUMBING: [
    standardPreset("minor_clog", "Minor Clog", "SERVICE", "FLAT", 45, 120, "Drain unclogging / minor blockage resolution.", 1, ["clog", "drain", "blockage", "unclog"], { isPrimaryJob: true }),
    standardPreset("pipe_replacement", "Pipe Replacement", "SERVICE", "FLAT", 180, 450, "Standard replacement section with fittings.", 1, ["pipe replacement", "replace pipe", "repipe", "new pipe"], { isPrimaryJob: true }),
    standardPreset("pipe_burst_repair", "Pipe Burst Repair", "SERVICE", "FLAT", 260, 700, "Emergency burst repair including access and sealing.", 1, ["burst pipe", "pipe burst", "leak", "broken pipe"], { isPrimaryJob: true }),
    standardPreset("water_heater_replacement", "Water Heater Replacement", "SERVICE", "FLAT", 1050, 2450, "Remove and replace standard tank water heater with reconnect and startup.", 1, ["water heater", "heater replacement", "tank water heater", "hot water heater"], { isPrimaryJob: true }),
    standardPreset("tankless_water_heater_upgrade", "Tankless Water Heater Upgrade", "SERVICE", "FLAT", 1750, 3950, "Upgrade to tankless unit with venting and connection updates.", 1, ["tankless", "tankless heater", "tankless water heater"], { isPrimaryJob: true }),
    standardPreset("sewer_camera_inspection", "Sewer Camera Inspection", "SERVICE", "FLAT", 120, 285, "Camera line inspection and blockage diagnosis.", 1, ["camera inspection", "sewer camera", "line inspection"], { isPrimaryJob: false }),
    standardPreset("hydro_jetting", "Hydro-Jetting Drain Service", "SERVICE", "FLAT", 220, 560, "Hydro-jet cleaning for heavy drain/sewer buildup.", 1, ["hydro jet", "hydro-jet", "jetting", "sewer cleaning"], { isPrimaryJob: true }),
    standardPreset("fixture_install_package", "Fixture Install Package", "SERVICE", "EACH", 70, 180, "Install faucet, sink, toilet, or similar plumbing fixture.", 1, ["fixture install", "toilet install", "faucet install", "sink install"], { isPrimaryJob: false }),
    standardPreset("shutoff_valve_replacement", "Shutoff Valve Replacement", "SERVICE", "EACH", 40, 125, "Replace worn or leaking shutoff valve.", 1, ["shutoff valve", "angle stop", "valve replacement"], { isPrimaryJob: false }),
    standardPreset("priority_work_fee", "Priority Work Fee", "FEE", "FLAT", 0, 75, "After-hours or urgent response fee.", 1, ["priority", "urgent", "after hours", "emergency"], { isPrimaryJob: false }),
    standardPreset("labor_hour", "Labor Hour", "LABOR", "HOUR", 55, 110, "Hourly plumbing labor.", 1, ["labor hour", "hourly labor"], { isPrimaryJob: false }),
  ],
  ROOFING: [
    standardPreset("asphalt_shingle_remove_replace", "Asphalt Shingle Roof Tear-Off and Replacement", "SERVICE", "SQ_FT", 3.8, 7.9, "Remove existing shingles, dispose of debris, inspect roof deck, install underlayment, then install new shingles and accessories.", 100, ["asphalt shingle", "shingle", "tear-off", "tear off", "roof replacement", "replace roof", "reroof", "re-roof"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("underlayment_layer", "Underlayment Layer", "MATERIAL", "SQ_FT", 0.35, 0.85, "Synthetic underlayment.", 100, ["underlayment"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("roof_deck_repair_allowance", "Roof Deck Repair Allowance", "SERVICE", "SQ_FT", 1.2, 2.8, "Deck repair when damage is discovered.", 25, ["deck repair", "roof deck", "rot", "wood rot", "damaged deck"], { isPrimaryJob: false, quantityMode: "default" }),
    standardPreset("flashing_package", "Flashing Package", "MATERIAL", "FLAT", 80, 185, "Valley and edge flashing package.", 1, ["flashing", "valley", "edge metal"], { isPrimaryJob: false }),
    standardPreset("roof_leak_diagnostic", "Roof Leak Diagnostic", "SERVICE", "FLAT", 90, 245, "Leak source inspection with moisture path check.", 1, ["roof leak", "leak diagnostic", "water intrusion"], { isPrimaryJob: true }),
    standardPreset("ridge_vent_install", "Ridge Vent Install", "SERVICE", "EACH", 85, 220, "Install or replace ridge vent sections.", 1, ["ridge vent", "roof ventilation", "attic ventilation"], { isPrimaryJob: false }),
    standardPreset("chimney_flashing_repair", "Chimney Flashing Repair", "SERVICE", "FLAT", 140, 360, "Repair or replace chimney flashing and seal transitions.", 1, ["chimney flashing", "chimney leak", "counter flashing"], { isPrimaryJob: false }),
    standardPreset("roof_coating_system", "Roof Coating System", "SERVICE", "SQ_FT", 1.9, 4.6, "Clean, prep, and apply elastomeric roof coating.", 100, ["roof coating", "elastomeric", "flat roof coating"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("gutter_replacement_labor", "Gutter Replacement Labor", "LABOR", "HOUR", 80, 165, "Labor for gutter and downspout replacement work.", 4, ["gutter replacement", "downspout", "gutter labor"], { isPrimaryJob: false }),
    standardPreset("permit_inspection_fee", "Permit + Inspection Fee", "FEE", "FLAT", 0, 185, "Permit filing and required inspection coordination.", 1, ["permit", "inspection fee", "city permit"], { isPrimaryJob: false }),
    standardPreset("disposal_fee", "Disposal Fee", "FEE", "FLAT", 90, 220, "Dump/disposal and haul-away.", 1, ["disposal", "dispose", "haul away", "haul-away", "dump"], { isPrimaryJob: false }),
  ],
  FLOORING: [
    standardPreset("floor_demo_disposal", "Floor Demo + Disposal", "SERVICE", "SQ_FT", 1.1, 2.5, "Removal and disposal of old flooring.", 100, ["demo", "demolition", "remove flooring", "floor removal"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("lvp_install", "LVP Install", "SERVICE", "SQ_FT", 2.6, 5.9, "Install luxury vinyl plank.", 100, ["lvp", "vinyl plank", "luxury vinyl plank"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("tile_install", "Tile Install", "SERVICE", "SQ_FT", 4.5, 9.5, "Tile setting and grout finish.", 100, ["tile", "grout"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("laminate_install", "Laminate Install", "SERVICE", "SQ_FT", 2.35, 5.4, "Install laminate flooring with cuts and transitions.", 100, ["laminate", "laminate flooring"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("hardwood_install", "Hardwood Install", "SERVICE", "SQ_FT", 4.95, 10.9, "Install engineered or solid hardwood flooring.", 100, ["hardwood", "engineered wood", "wood floor"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("carpet_install", "Carpet Install", "SERVICE", "SQ_FT", 2.2, 5.2, "Install carpet and pad with seam finishing.", 100, ["carpet", "carpet install", "padding"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("underlayment", "Underlayment", "MATERIAL", "SQ_FT", 0.42, 0.95, "Subfloor prep underlayment.", 100, ["underlayment"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("moisture_barrier", "Moisture Barrier", "MATERIAL", "SQ_FT", 0.28, 0.78, "Moisture/vapor barrier material under finish floor.", 100, ["moisture barrier", "vapor barrier", "moisture membrane"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("subfloor_leveling", "Subfloor Leveling", "SERVICE", "SQ_FT", 0.95, 2.4, "Patch and level subfloor before install.", 100, ["subfloor leveling", "self leveler", "floor prep", "subfloor prep"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("trim_transition_kit", "Trim/Transition Kit", "MATERIAL", "EACH", 18, 45, "Transition strips and trim.", 1, ["transition", "trim"], { isPrimaryJob: false }),
    standardPreset("baseboard_reinstall", "Baseboard Reinstall", "SERVICE", "EACH", 16, 42, "Remove and reinstall/replace baseboard sections.", 1, ["baseboard", "quarter round", "shoe molding"], { isPrimaryJob: false }),
  ],
  HVAC: [
    standardPreset("system_tune_up", "System Tune-Up", "SERVICE", "FLAT", 65, 145, "Routine maintenance and performance check.", 1, ["tune up", "tune-up", "maintenance", "service"], { isPrimaryJob: true }),
    standardPreset("ac_condenser_replacement", "AC Condenser Replacement", "SERVICE", "FLAT", 1400, 3300, "Remove and replace condenser unit.", 1, ["condenser", "ac replacement", "replace ac", "air conditioner", "ac unit"], { isPrimaryJob: true }),
    standardPreset("furnace_install", "Furnace Install", "SERVICE", "FLAT", 1800, 4200, "Install/replace furnace unit.", 1, ["furnace", "heater", "heating system"], { isPrimaryJob: true }),
    standardPreset("ductwork_repair", "Ductwork Repair", "SERVICE", "HOUR", 70, 145, "Duct repair labor hour.", 1, ["duct", "ductwork", "vents"], { isPrimaryJob: true }),
    standardPreset("heat_pump_replacement", "Heat Pump Replacement", "SERVICE", "FLAT", 2100, 4950, "Replace heat pump system and test operation.", 1, ["heat pump", "heat pump replacement"], { isPrimaryJob: true }),
    standardPreset("mini_split_install_zone", "Mini-Split Install (Per Zone)", "SERVICE", "EACH", 950, 2250, "Install single mini-split indoor zone with line set.", 1, ["mini split", "mini-split", "ductless"], { isPrimaryJob: true }),
    standardPreset("air_handler_replacement", "Air Handler Replacement", "SERVICE", "FLAT", 1200, 2950, "Replace indoor air handler and reconnect controls.", 1, ["air handler", "blower unit", "indoor unit"], { isPrimaryJob: true }),
    standardPreset("refrigerant_leak_repair", "Refrigerant Leak Repair", "SERVICE", "FLAT", 260, 690, "Locate, seal, and recharge for verified leak repair.", 1, ["refrigerant leak", "freon leak", "leak repair", "recharge"], { isPrimaryJob: false }),
    standardPreset("thermostat_install", "Thermostat Install", "SERVICE", "EACH", 65, 185, "Install and configure programmable/smart thermostat.", 1, ["thermostat", "smart thermostat"], { isPrimaryJob: false }),
    standardPreset("duct_sealing_package", "Duct Sealing Package", "SERVICE", "FLAT", 220, 540, "Seal major duct leaks and verify airflow.", 1, ["duct sealing", "air leak", "airflow balancing"], { isPrimaryJob: false }),
    standardPreset("priority_dispatch_fee", "Priority Dispatch Fee", "FEE", "FLAT", 0, 95, "After-hours dispatch fee.", 1, ["priority", "urgent", "after hours", "emergency"], { isPrimaryJob: false }),
  ],
  GARDENING: [
    standardPreset("lawn_maintenance_visit", "Lawn Maintenance Visit", "SERVICE", "FLAT", 30, 75, "Mow, edge, cleanup.", 1, ["lawn maintenance", "mow", "mowing", "yard maintenance"], { isPrimaryJob: true }),
    standardPreset("sod_install", "Sod Install", "SERVICE", "SQ_FT", 0.8, 2.1, "Supply and install new sod.", 200, ["sod", "resod", "new lawn"], { isPrimaryJob: true, quantityMode: "project_area" }),
    standardPreset("mulch_install", "Mulch Install", "MATERIAL", "SQ_FT", 0.35, 1, "Mulch supply and install.", 100, ["mulch"], { isPrimaryJob: false, quantityMode: "project_area" }),
    standardPreset("planting_bed_refresh", "Planting Bed Refresh", "SERVICE", "FLAT", 95, 245, "Refresh planting beds, edge, and amend soil.", 1, ["planting bed", "bed refresh", "soil amendment"], { isPrimaryJob: true }),
    standardPreset("hedge_trimming", "Hedge Trimming", "SERVICE", "HOUR", 40, 95, "Trim and shape hedges/shrubs.", 2, ["hedge trim", "shrub trimming", "trim hedges"], { isPrimaryJob: true }),
    standardPreset("tree_trimming_service", "Tree Trimming Service", "SERVICE", "HOUR", 65, 155, "Tree trimming and canopy cleanup labor.", 2, ["tree trimming", "pruning", "canopy"], { isPrimaryJob: true }),
    standardPreset("irrigation_repair", "Irrigation Repair", "SERVICE", "HOUR", 45, 105, "Sprinkler and irrigation labor hour.", 1, ["irrigation", "sprinkler"], { isPrimaryJob: true }),
    standardPreset("drip_irrigation_install", "Drip Irrigation Install", "SERVICE", "FLAT", 180, 440, "Install drip lines and emitters for planting zones.", 1, ["drip irrigation", "drip line", "emitters"], { isPrimaryJob: true }),
    standardPreset("weed_control_treatment", "Weed Control Treatment", "SERVICE", "FLAT", 55, 145, "Targeted weed treatment for beds and hardscape edges.", 1, ["weed control", "weed treatment", "weed removal"], { isPrimaryJob: false }),
    standardPreset("seasonal_cleanup", "Seasonal Cleanup", "SERVICE", "FLAT", 80, 195, "Debris and overgrowth cleanup.", 1, ["cleanup", "seasonal cleanup", "yard cleanup"], { isPrimaryJob: true }),
    standardPreset("green_waste_disposal", "Green Waste Disposal", "FEE", "FLAT", 20, 55, "Dump/disposal fee.", 1, ["green waste", "disposal", "haul away", "haul-away"], { isPrimaryJob: false }),
  ],
  CONSTRUCTION: [
    standardPreset("general_labor", "General Labor", "LABOR", "HOUR", 65, 140, "Construction labor hour.", 1, ["general labor", "labor"], { isPrimaryJob: true }),
    standardPreset("site_prep", "Site Prep", "SERVICE", "FLAT", 120, 320, "Site setup and preparation.", 1, ["site prep", "site preparation", "prep"], { isPrimaryJob: true }),
    standardPreset("framing_package", "Framing Package", "MATERIAL", "FLAT", 650, 1450, "Lumber and framing materials.", 1, ["framing", "frame", "lumber"], { isPrimaryJob: false }),
    standardPreset("demo_haul_away", "Demo + Haul Away", "SERVICE", "FLAT", 220, 540, "Demolition and disposal service.", 1, ["demo", "demolition", "haul away", "haul-away"], { isPrimaryJob: true }),
    standardPreset("project_management_fee", "Project Management Fee", "FEE", "FLAT", 0, 250, "Coordination and scheduling fee.", 1, ["project management", "coordination"], { isPrimaryJob: false }),
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
  let normalized = value.toLowerCase();
  for (const [pattern, replacement] of MATCHING_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeNormalizedText(value: string): string[] {
  return value.split(" ").map((token) => token.trim()).filter((token) => token.length > 0);
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

function hasFuzzyTokenMatch(token: string, textTokens: string[]): boolean {
  if (token.length < 5) return false;
  for (const textToken of textTokens) {
    if (Math.abs(textToken.length - token.length) > 2) continue;
    const distance = levenshteinDistance(token, textToken);
    if (distance <= 1 || (token.length >= 8 && distance <= 2)) {
      return true;
    }
  }
  return false;
}

export interface StandardWorkPresetMatch {
  preset: StandardWorkPresetDefinition;
  score: number;
}

export function findStandardWorkPresetMatches(
  serviceType: ServiceCategory,
  text: string,
  options?: {
    primaryOnly?: boolean;
    excludeCatalogKeys?: string[];
    minimumScore?: number;
  },
): StandardWorkPresetMatch[] {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return [];
  const textTokens = tokenizeNormalizedText(normalizedText);

  const excluded = new Set(options?.excludeCatalogKeys ?? []);
  const matches: StandardWorkPresetMatch[] = [];
  for (const preset of STANDARD_WORK_PRESET_CATALOG[serviceType]) {
    if (options?.primaryOnly && !preset.isPrimaryJob) continue;
    if (excluded.has(preset.catalogKey)) continue;
    const keywords = preset.matchKeywords ?? [];
    let score = 0;

    for (const keyword of keywords) {
      const normalizedKeyword = normalizeText(keyword);
      if (!normalizedKeyword) continue;
      if (normalizedText.includes(normalizedKeyword)) {
        score += normalizedKeyword.includes(" ") ? 4 : 2;
        continue;
      }

      if (!normalizedKeyword.includes(" ") && hasFuzzyTokenMatch(normalizedKeyword, textTokens)) {
        score += 1;
      }
    }

    if (normalizedText.includes(normalizeText(preset.name))) {
      score += 5;
    }

    const catalogKeyKeywords = preset.catalogKey
      .split("_")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3);
    for (const token of catalogKeyKeywords) {
      if (normalizedText.includes(token)) {
        score += 1;
      } else if (hasFuzzyTokenMatch(token, textTokens)) {
        score += 1;
      }
    }

    if (preset.description) {
      const descriptionTokens = normalizeText(preset.description)
        .split(" ")
        .filter((token) => token.length >= 5);
      let descriptionHits = 0;
      for (const token of descriptionTokens) {
        if (normalizedText.includes(token)) {
          descriptionHits += 1;
        } else if (hasFuzzyTokenMatch(token, textTokens)) {
          descriptionHits += 1;
        }
        if (descriptionHits >= 3) break;
      }
      score += descriptionHits;
    }

    if (score >= (options?.minimumScore ?? 1)) {
      matches.push({ preset, score });
    }
  }

  return matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.preset.name.localeCompare(right.preset.name);
  });
}

export function findBestStandardWorkPresetMatch(
  serviceType: ServiceCategory,
  text: string,
  options?: {
    primaryOnly?: boolean;
    excludeCatalogKeys?: string[];
    minimumScore?: number;
  },
): StandardWorkPresetDefinition | null {
  return findStandardWorkPresetMatches(serviceType, text, options)[0]?.preset ?? null;
}
