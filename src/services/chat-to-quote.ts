import { ServiceCategory, inferServiceType } from "./quote-generator";
import { findBestStandardWorkPresetMatch, findStandardWorkPresetMatches } from "./work-preset-catalog";

export interface ChatQuoteLineItemSuggestion {
  description: string;
  quantity: number;
  sectionType?: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
}

export interface ParsedChatToQuoteDraft {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceType: ServiceCategory;
  title: string;
  scopeText: string;
  squareFeetEstimate: number | null;
  squareFeetVariancePercent: number | null;
  squareFeetEstimateLow: number | null;
  squareFeetEstimateHigh: number | null;
  estimatedTotalAmount: number | null;
  estimatedTaxAmount: number | null;
  estimatedInternalCostAmount: number | null;
  lineItems: ChatQuoteLineItemSuggestion[];
}

const PHONE_PATTERN = /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SQUARE_FEET_PATTERN =
  /([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(sq\.?[\s-]*ft\.?|sqft|s\.?[\s-]*f\.?|square\s*feet|square\s*foot|sq\s*feet|sq\s*foot|ft2|ft\^2|feet\s*squared|foot\s*squared)\b/i;
const SQUARE_FEET_PATTERN_GLOBAL =
  /([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(sq\.?[\s-]*ft\.?|sqft|s\.?[\s-]*f\.?|square\s*feet|square\s*foot|sq\s*feet|sq\s*foot|ft2|ft\^2|feet\s*squared|foot\s*squared)\b/gi;
const ROOFING_SQUARE_PATTERN_GLOBAL =
  /([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(?:roofing\s*)?squares?\b(?!\s*(?:feet|foot|ft|sq\.?[\s-]*ft))/gi;
const SQUARE_FEET_UNIT_CUE_PATTERN =
  /\b(sq\.?[\s-]*ft\.?|sqft|s\.?[\s-]*f\.?|square\s*feet|square\s*foot|sq\s*feet|sq\s*foot|ft2|ft\^2|feet\s*squared|foot\s*squared)\b/i;
const ROOFING_CONTEXT_PATTERN =
  /\b(roof|roofing|shingle|ridge|flashing|underlayment|tile|metal|tpo|epdm|modified bitumen|torch down|low[-\s]*slope)\b/i;
const AREA_SECONDARY_CUE_PATTERN =
  /\b(allowance|uneven|level|leveling|patch|repair|optional|alternate|option|upgrade|contingency|if needed)\b/i;
const AREA_OPTION_PATTERN = /\b(option|alternate|alternative|either|vs\.?|versus)\b/i;
const AREA_CLAUSE_BOUNDARY_PATTERN = /[.;:\n]/;
const ROUGH_ESTIMATE_CUE_PATTERN =
  /(?:~|\babout\b|\baround\b|\bapprox(?:imate(?:ly)?)?\b|\brough(?:ly)?\b|\bestimat(?:e|ed)\b|\bmaybe\b|\bif needed\b)/i;
const STRUCTURED_PROMPT_LINE_PATTERN = /^(?:line|item)\s*(\d+)\s*[:\-]\s*(.+)$/i;
const STRUCTURED_PROMPT_QTY_PATTERN = /\b(?:qty|quantity)\s*[:=]?\s*([\d,]+(?:\.\d+)?(?:\s*[kK])?)/i;
const STRUCTURED_PROMPT_ROOFING_SQUARE_QTY_PATTERN =
  /\b(?:qty|quantity)\s*[:=]?\s*([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(?:roofing\s*)?squares?\b/i;

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function parseCurrencyLiteral(raw: string): number | null {
  const normalized = raw.replace(/[^0-9.]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Number(amount.toFixed(2));
}

function parseSquareFeetLiteral(raw: string): number | null {
  const compact = raw.replace(/\s+/g, "").toLowerCase();
  if (!compact) return null;

  const isK = compact.endsWith("k");
  const numericPortion = isK ? compact.slice(0, -1) : compact;
  const normalized = numericPortion.replace(/,/g, "");
  if (!normalized) return null;

  const base = Number(normalized);
  if (!Number.isFinite(base) || base <= 0) return null;

  const value = isK ? base * 1000 : base;
  return Number(value.toFixed(2));
}

function normalizeStructuredLineDescription(raw: string): string {
  return raw
    .replace(/\|\s*(?:qty|quantity|unit\s*cost|cost|unit\s*price|price)\s*[:=]?.*$/i, "")
    .replace(/\b(?:qty|quantity)\s*[:=]?\s*[\d,]+(?:\.\d+)?(?:\s*[kK])?\b/gi, "")
    .trim()
    .replace(/\s{2,}/g, " ");
}

function extractStructuredLineItems(rawPrompt: string): ChatQuoteLineItemSuggestion[] {
  const lines = rawPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const parsedItems: Array<{ lineNo: number; item: ChatQuoteLineItemSuggestion }> = [];
  for (const line of lines) {
    const lineMatch = line.match(STRUCTURED_PROMPT_LINE_PATTERN);
    if (!lineMatch?.[2]) continue;

    const lineNo = Number(lineMatch[1]);
    const content = lineMatch[2].trim();
    if (!content) continue;

    const explicitRoofingSquareQtyRaw = content.match(STRUCTURED_PROMPT_ROOFING_SQUARE_QTY_PATTERN)?.[1] ?? null;
    const explicitRoofingSquareQtyBase = explicitRoofingSquareQtyRaw
      ? parseSquareFeetLiteral(explicitRoofingSquareQtyRaw)
      : null;
    const explicitQtyRaw = content.match(STRUCTURED_PROMPT_QTY_PATTERN)?.[1] ?? null;
    const explicitQty = explicitRoofingSquareQtyBase
      ? Number((explicitRoofingSquareQtyBase * 100).toFixed(2))
      : explicitQtyRaw
        ? parseSquareFeetLiteral(explicitQtyRaw)
        : null;
    const embeddedSqFt = extractSquareFeetMatches(content)
      .filter((entry) => !entry.secondary)
      .map((entry) => entry.value)[0] ?? null;
    const quantity = explicitQty ?? embeddedSqFt ?? 1;

    const sectionType = /\b(alternate|optional|option)\b/i.test(content) ? "ALTERNATE" : "INCLUDED";
    const sectionLabel = sectionType === "ALTERNATE" ? "Alternate Option" : null;
    const description = normalizeStructuredLineDescription(content);
    if (!description) continue;

    parsedItems.push({
      lineNo: Number.isFinite(lineNo) ? lineNo : Number.MAX_SAFE_INTEGER,
      item: {
        description,
        quantity: Number(Math.max(quantity, 1).toFixed(2)),
        sectionType,
        sectionLabel,
      },
    });
  }

  if (!parsedItems.length) return [];
  parsedItems.sort((left, right) => left.lineNo - right.lineNo);
  return parsedItems.map((entry) => entry.item);
}

function inferSquareFeetFromStructuredLines(lineItems: ChatQuoteLineItemSuggestion[]): number | null {
  const areaKeywordPattern =
    /\b(room|bedroom|bath|bathroom|hall|hallway|floor|flooring|roof|roofing|sod|lawn|tile|shingle|area|sq|square)\b/i;
  const secondaryCuePattern =
    /\b(allowance|if needed|optional|alternate|option|transition(?:s)?|trim(?:s)?|cut(?:s)?|repair|patch|level|leveling|upgrade|permit|fee|inspection)\b/i;

  let sum = 0;
  let count = 0;
  for (const line of lineItems) {
    if (line.sectionType === "ALTERNATE") continue;
    if (secondaryCuePattern.test(line.description)) continue;

    const quantity = Number(line.quantity);
    const explicitSqFt = extractSquareFeetMatches(line.description)
      .filter((entry) => !entry.secondary)
      .map((entry) => entry.value)[0] ?? null;
    if (explicitSqFt) {
      sum += explicitSqFt;
      count += 1;
      continue;
    }

    if (quantity > 1.5 && areaKeywordPattern.test(line.description)) {
      sum += quantity;
      count += 1;
    }
  }

  if (!count || sum <= 0) return null;
  return Number(sum.toFixed(2));
}

function extractAreaClause(prompt: string, startIndex: number, matchLength: number): string {
  let clauseStart = startIndex;
  while (clauseStart > 0) {
    const previousChar = prompt[clauseStart - 1];
    if (AREA_CLAUSE_BOUNDARY_PATTERN.test(previousChar)) break;
    clauseStart -= 1;
  }

  let clauseEnd = Math.min(prompt.length, startIndex + matchLength);
  while (clauseEnd < prompt.length) {
    const currentChar = prompt[clauseEnd];
    if (AREA_CLAUSE_BOUNDARY_PATTERN.test(currentChar)) break;
    clauseEnd += 1;
  }

  return prompt.slice(clauseStart, clauseEnd);
}

function extractSquareFeetMatches(prompt: string): Array<{ value: number; secondary: boolean }> {
  const matches: Array<{ value: number; secondary: boolean }> = [];
  for (const match of prompt.matchAll(SQUARE_FEET_PATTERN_GLOBAL)) {
    const parsed = parseSquareFeetLiteral(match[1] ?? "");
    if (parsed === null) continue;
    const index = match.index ?? 0;
    const clause = extractAreaClause(prompt, index, (match[0] ?? "").length);
    matches.push({
      value: parsed,
      secondary: AREA_SECONDARY_CUE_PATTERN.test(clause),
    });
  }
  for (const match of prompt.matchAll(ROOFING_SQUARE_PATTERN_GLOBAL)) {
    const parsed = parseSquareFeetLiteral(match[1] ?? "");
    if (parsed === null) continue;
    const index = match.index ?? 0;
    const clause = extractAreaClause(prompt, index, (match[0] ?? "").length);
    const hasRoofingContext =
      ROOFING_CONTEXT_PATTERN.test(clause) || /\broofing\s*squares?\b/i.test(match[0] ?? "");
    if (!hasRoofingContext) continue;
    const convertedSqFt = Number((parsed * 100).toFixed(2));
    const hasSqFtCue = SQUARE_FEET_UNIT_CUE_PATTERN.test(clause);
    const hasEquivalentSqFtMatch =
      hasSqFtCue &&
      matches.some((entry) => Math.abs(entry.value - convertedSqFt) <= Math.max(1, convertedSqFt * 0.01));
    if (hasEquivalentSqFtMatch) continue;
    matches.push({
      value: convertedSqFt,
      secondary: AREA_SECONDARY_CUE_PATTERN.test(clause),
    });
  }
  return matches;
}

function roundPercent(value: number) {
  return Number(value.toFixed(4));
}

function roundSquareFeet(value: number) {
  return Number(value.toFixed(2));
}

export function resolveSquareFeetVariancePercent(
  prompt: string,
  squareFeetEstimate: number | null,
  options?: {
    primaryAreaMatchCount?: number;
    forceRough?: boolean;
  },
): number | null {
  if (!squareFeetEstimate || squareFeetEstimate <= 0) return null;

  if (options?.forceRough) return 0.05;

  const normalizedPrompt = normalizePrompt(prompt);
  if (ROUGH_ESTIMATE_CUE_PATTERN.test(normalizedPrompt)) {
    return 0.05;
  }

  if ((options?.primaryAreaMatchCount ?? 0) >= 2) {
    return 0.03;
  }

  return 0.02;
}

export function buildSquareFeetRangeFromEstimate(
  squareFeetEstimate: number | null,
  variancePercent: number | null,
): {
  squareFeetVariancePercent: number | null;
  squareFeetEstimateLow: number | null;
  squareFeetEstimateHigh: number | null;
} {
  if (!squareFeetEstimate || squareFeetEstimate <= 0 || !variancePercent || variancePercent <= 0) {
    return {
      squareFeetVariancePercent: null,
      squareFeetEstimateLow: null,
      squareFeetEstimateHigh: null,
    };
  }

  const low = Math.max(0, squareFeetEstimate * (1 - variancePercent));
  const high = squareFeetEstimate * (1 + variancePercent);
  return {
    squareFeetVariancePercent: roundPercent(variancePercent),
    squareFeetEstimateLow: roundSquareFeet(low),
    squareFeetEstimateHigh: roundSquareFeet(high),
  };
}

export function deriveSquareFeetEstimateRange(
  prompt: string,
  squareFeetEstimate: number | null,
  options?: {
    forceRough?: boolean;
  },
): {
  squareFeetVariancePercent: number | null;
  squareFeetEstimateLow: number | null;
  squareFeetEstimateHigh: number | null;
} {
  if (!squareFeetEstimate || squareFeetEstimate <= 0) {
    return {
      squareFeetVariancePercent: null,
      squareFeetEstimateLow: null,
      squareFeetEstimateHigh: null,
    };
  }

  const normalizedPrompt = normalizePrompt(prompt);
  const squareFeetMatches = extractSquareFeetMatches(normalizedPrompt);
  const primaryAreaMatchCount = squareFeetMatches.filter((entry) => !entry.secondary).length;
  const variancePercent = resolveSquareFeetVariancePercent(normalizedPrompt, squareFeetEstimate, {
    primaryAreaMatchCount,
    forceRough: options?.forceRough,
  });

  return buildSquareFeetRangeFromEstimate(squareFeetEstimate, variancePercent);
}

function extractExplicitSquareFeet(prompt: string): number | null {
  const matches = extractSquareFeetMatches(prompt);
  const values = matches.map((entry) => entry.value);
  if (!values.length) {
    const match = prompt.match(SQUARE_FEET_PATTERN);
    if (!match?.[1]) return null;
    return parseSquareFeetLiteral(match[1]);
  }

  const primaryValues = matches.filter((entry) => !entry.secondary).map((entry) => entry.value);
  if (primaryValues.length > 0) {
    if (primaryValues.length === 1) return primaryValues[0];
    return Number(primaryValues.reduce((sum, value) => sum + value, 0).toFixed(2));
  }

  if (AREA_OPTION_PATTERN.test(prompt)) {
    return Number(Math.max(...values).toFixed(2));
  }

  if (values.length === 1) return values[0];
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function extractNamedAmount(prompt: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseCurrencyLiteral(match[1]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractCustomerName(prompt: string): string | undefined {
  const primaryMatch = prompt.match(
    /\b(?:new\s+quote|quote|estimate)\s+for\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})(?=\s*(?:[,.\d]|$))/i,
  );
  const fallbackMatch = prompt.match(
    /\bfor\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})(?=\s*(?:[,.\d]|$))/i,
  );
  const candidate = primaryMatch?.[1] ?? fallbackMatch?.[1];
  if (!candidate) return undefined;
  return candidate.trim().replace(/[,.]$/, "");
}

function serviceTitle(serviceType: ServiceCategory): string {
  if (serviceType === "ROOFING") return "Roofing";
  if (serviceType === "HVAC") return "HVAC";
  if (serviceType === "PLUMBING") return "Plumbing";
  if (serviceType === "GARDENING") return "Landscaping";
  if (serviceType === "CONSTRUCTION") return "Construction";
  return "Flooring";
}

function inferMaterialDescription(serviceType: ServiceCategory, prompt: string): string {
  const lower = prompt.toLowerCase();

  if (serviceType === "ROOFING") {
    if (/\b(spanish|clay|concrete|barrel|mission|s[-\s]?tile)\b/.test(lower)) {
      return "Tile roofing materials, underlayment, battens, and flashing accessories";
    }
    if (/\b(architectural|laminate|dimensional|hdz|duration)\b/.test(lower)) {
      return "Architectural shingles and roofing accessories";
    }
    if (/\b(asphalt|composition|3[-\s]?tab|three tab)\b/.test(lower)) {
      return "Asphalt shingles and roofing accessories";
    }
    if (/\b(standing seam|corrugated|metal|steel|r[-\s]?panel)\b/.test(lower)) {
      return "Metal roofing panels and flashing accessories";
    }
    if (/\b(tpo|single[-\s]?ply)\b/.test(lower)) {
      return "TPO membrane, insulation, and roofing accessories";
    }
    if (/\b(epdm|rubber roof)\b/.test(lower)) {
      return "EPDM membrane, seam materials, and flashing accessories";
    }
    if (/\b(modified bitumen|mod bit|torch[-\s]?down|cap sheet)\b/.test(lower)) {
      return "Modified bitumen membrane and roofing accessories";
    }
    return "Roofing materials, underlayment, and accessories";
  }

  if (serviceType === "HVAC") {
    if (/\b(seer2|hspf2|high efficiency)\b/.test(lower)) {
      return "High-efficiency HVAC equipment, accessories, and commissioning materials";
    }
    if (/\b(heat pump)\b/.test(lower)) {
      return "Heat pump equipment, line set components, and startup materials";
    }
    if (/\b(mini[-\s]?split|ductless)\b/.test(lower)) {
      return "Mini-split equipment, line set, and control accessories";
    }
    if (/\b(furnace)\b/.test(lower)) {
      return "Furnace equipment, venting materials, and install accessories";
    }
    if (/\b(evaporator coil|evap coil|a[-\s]?coil|air handler)\b/.test(lower)) {
      return "Evaporator/air-handler components and refrigerant circuit materials";
    }
    if (/\b(condenser|air conditioner|ac unit)\b/.test(lower)) {
      return "Condenser equipment, refrigerant accessories, and install materials";
    }
    if (/\b(duct sealing|static pressure|airflow|cfm)\b/.test(lower)) {
      return "Airflow balancing materials, sealing supplies, and diagnostic components";
    }
    return "HVAC equipment, fittings, and install materials";
  }

  if (serviceType === "PLUMBING") {
    if (/\b(tankless|water heater|anode rod|recirculation|venting)\b/.test(lower)) {
      return "Water heater equipment, venting materials, and plumbing connection supplies";
    }
    if (/\b(repipe|pex|copper|water line)\b/.test(lower)) {
      return "Water-line piping, fittings, valves, and install materials";
    }
    if (/\b(sewer|drain|hydro[-\s]?jet|camera|trenchless|pipe bursting|cipp)\b/.test(lower)) {
      return "Drain/sewer service equipment, repair materials, and restoration supplies";
    }
    if (/\b(toilet|faucet|sink|garbage disposal|fixture)\b/.test(lower)) {
      return "Fixture hardware, seals, fittings, and installation supplies";
    }
    if (/\b(prv|pressure regulator|backflow|rpz|sump pump)\b/.test(lower)) {
      return "Valve/pump assemblies, fittings, and compliance-related plumbing materials";
    }
    return "Plumbing fixtures, piping, and install materials";
  }

  if (serviceType === "GARDENING") {
    if (/\b(sod|resod|new lawn)\b/.test(lower)) {
      return "Sod materials, soil prep supplies, and landscape accessories";
    }
    if (/\b(irrigation|drip|sprinkler|controller)\b/.test(lower)) {
      return "Irrigation components, drip/sprinkler parts, and control accessories";
    }
    if (/\b(hydrozone|zone valve|rain sensor|water budgeting)\b/.test(lower)) {
      return "Irrigation zoning, controller, and water-management components";
    }
    if (/\b(mulch|planting bed|bed refresh)\b/.test(lower)) {
      return "Mulch, soil amendment, and bed refresh materials";
    }
    if (/\b(hedge|shrub|tree|pruning|trim)\b/.test(lower)) {
      return "Pruning supplies, hauling materials, and cleanup consumables";
    }
    if (/\b(aeration|overseed|fertili[sz]ation|weed and feed|pre[-\s]?emergent)\b/.test(lower)) {
      return "Lawn treatment materials and turf recovery supplies";
    }
    return "Landscape materials, mulch, and site supplies";
  }

  if (serviceType === "CONSTRUCTION") {
    return "Construction materials, consumables, and site supplies";
  }

  if (/\b(lvp|luxury vinyl plank|vinyl plank)\b/.test(lower)) {
    return "LVP flooring materials, underlayment, and transition accessories";
  }
  if (/\b(lvt|linoleum|sheet vinyl|vinyl sheet|marmoleum)\b/.test(lower)) {
    return "Linoleum/vinyl sheet materials, adhesive, and transition accessories";
  }
  if (/\b(tile|porcelain|ceramic|grout|thinset)\b/.test(lower)) {
    return "Tile, thinset, grout, and floor prep materials";
  }
  if (/\b(uncoupling membrane|ditra|backer board)\b/.test(lower)) {
    return "Tile underlayment, uncoupling membrane, and prep materials";
  }
  if (/\b(hardwood|engineered wood|wood floor)\b/.test(lower)) {
    if (/\b(nail down|nail-down)\b/.test(lower)) return "Hardwood materials with nail-down install accessories";
    if (/\b(glue down|glue-down)\b/.test(lower)) return "Hardwood materials with glue-down install accessories";
    if (/\b(floating floor|floating)\b/.test(lower)) return "Hardwood materials with floating-floor underlayment and trim";
    return "Hardwood flooring materials, moisture barrier, and trim";
  }
  if (/\b(laminate)\b/.test(lower)) {
    return "Laminate flooring, pad, and transition accessories";
  }
  if (/\b(carpet|pad)\b/.test(lower)) {
    return "Carpet, pad, and seam materials";
  }
  return "Flooring materials, trim, and install supplies";
}

function laborDescription(serviceType: ServiceCategory, squareFeetEstimate: number | null): string {
  const sqftText =
    squareFeetEstimate && squareFeetEstimate > 0
      ? ` (${squareFeetEstimate.toLocaleString()} sq ft est.)`
      : "";
  return `${serviceTitle(serviceType)} labor and installation${sqftText}`;
}

function inferTitle(serviceType: ServiceCategory, prompt: string): string {
  const matchedStandardPreset = findBestStandardWorkPresetMatch(serviceType, prompt, { primaryOnly: true });
  if (matchedStandardPreset) {
    return matchedStandardPreset.name;
  }

  const lower = prompt.toLowerCase();
  if (serviceType === "ROOFING") {
    if (/\b(spanish|clay|concrete|barrel|mission|s[-\s]?tile)\b/.test(lower)) {
      return "Spanish/Tile Roof Replacement Quote";
    }
    if (/\b(standing seam|corrugated|metal|steel|r[-\s]?panel)\b/.test(lower)) {
      return "Metal Roof Replacement Quote";
    }
    if (/\b(tpo|single[-\s]?ply|epdm|rubber roof|modified bitumen|mod bit|torch[-\s]?down|flat roof)\b/.test(lower)) {
      return "Flat Roof Membrane Replacement Quote";
    }
    if (/\b(architectural|laminate|dimensional|hdz|duration)\b/.test(lower)) {
      return "Architectural Shingle Roof Replacement Quote";
    }
    if (/\b(asphalt|composition|3[-\s]?tab|three tab)\b/.test(lower)) {
      return "Asphalt Shingle Roof Replacement Quote";
    }
    if (lower.includes("replace") || lower.includes("replacement")) {
      return "Roof Replacement Quote";
    }
  }
  if (serviceType === "FLOORING" && (lower.includes("replace") || lower.includes("installation"))) {
    if (/\b(tile|porcelain|ceramic)\b/.test(lower)) return "Tile Flooring Installation Quote";
    if (/\b(lvp|lvt|linoleum|sheet vinyl|vinyl sheet)\b/.test(lower)) return "Vinyl/LVP Flooring Installation Quote";
    if (/\b(hardwood|engineered wood)\b/.test(lower)) return "Hardwood Flooring Installation Quote";
    if (/\b(refinish|sand and finish)\b/.test(lower)) return "Hardwood Refinish Quote";
    if (/\b(carpet)\b/.test(lower)) return "Carpet Installation Quote";
    return "Flooring Installation Quote";
  }
  if (serviceType === "HVAC") {
    if (/\b(seer2|hspf2|high efficiency)\b/.test(lower)) return "High-Efficiency HVAC Replacement Quote";
    if (/\b(heat pump)\b/.test(lower)) return "Heat Pump Replacement Quote";
    if (/\b(mini[-\s]?split|ductless)\b/.test(lower)) return "Mini-Split Installation Quote";
    if (/\b(furnace)\b/.test(lower)) return "Furnace Replacement Quote";
    if (/\b(evaporator coil|evap coil|a[-\s]?coil)\b/.test(lower)) return "Evaporator Coil Replacement Quote";
    if (/\b(condenser|air conditioner|ac unit)\b/.test(lower)) return "AC Condenser Replacement Quote";
    if (/\b(compressor|capacitor|contactor|refrigerant|repair)\b/.test(lower)) return "HVAC Repair Quote";
    if (lower.includes("replace")) return "HVAC Replacement Quote";
  }
  if (serviceType === "PLUMBING") {
    if (/\b(tankless)\b/.test(lower)) return "Tankless Water Heater Upgrade Quote";
    if (/\b(water heater)\b/.test(lower)) return "Water Heater Replacement Quote";
    if (/\b(repipe|pex|copper)\b/.test(lower)) return "Repipe Service Quote";
    if (/\b(sewer|hydro[-\s]?jet|camera|trenchless|pipe bursting|cipp|drain)\b/.test(lower)) {
      return "Sewer and Drain Service Quote";
    }
    if (/\b(slab leak|burst|leak repair)\b/.test(lower)) return "Pipe Leak Repair Quote";
    if (/\b(toilet|faucet|sink|garbage disposal|fixture)\b/.test(lower)) return "Fixture Installation Quote";
    if (/\b(prv|pressure regulator|backflow|sump pump)\b/.test(lower)) return "Plumbing System Service Quote";
    return "Plumbing Service Quote";
  }
  if (serviceType === "GARDENING") {
    if (/\b(sod|resod|new lawn)\b/.test(lower)) return "Sod Installation Quote";
    if (/\b(aeration|overseed)\b/.test(lower)) return "Lawn Aeration and Overseed Quote";
    if (/\b(irrigation|drip|sprinkler|controller|hydrozone|zone valve)\b/.test(lower)) return "Irrigation Service Quote";
    if (/\b(hedge|shrub|tree|pruning|trim)\b/.test(lower)) return "Tree and Hedge Trimming Quote";
    if (/\b(mulch|planting bed|bed refresh)\b/.test(lower)) return "Landscape Bed Refresh Quote";
    return "Landscaping Service Quote";
  }
  return `${serviceTitle(serviceType)} Service Quote`;
}

function inferLaborQuantity(serviceType: ServiceCategory, squareFeetEstimate: number | null): number {
  if (!squareFeetEstimate || squareFeetEstimate <= 0) {
    return 1;
  }

  if (serviceType === "ROOFING" || serviceType === "FLOORING") {
    return Number(squareFeetEstimate.toFixed(2));
  }

  return Number(Math.max(1, squareFeetEstimate / 100).toFixed(2));
}

function inferCatalogQuantity(
  preset: {
    unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
    defaultQuantity: number;
    quantityMode?: "default" | "project_area";
  },
  squareFeetEstimate: number | null,
): number {
  if (
    preset.quantityMode === "project_area" &&
    preset.unitType === "SQ_FT" &&
    squareFeetEstimate &&
    squareFeetEstimate > 0
  ) {
    return Number(squareFeetEstimate.toFixed(2));
  }
  return Number(Math.max(1, preset.defaultQuantity).toFixed(2));
}

export function parseChatToQuotePrompt(rawPrompt: string): ParsedChatToQuoteDraft {
  const prompt = normalizePrompt(rawPrompt);
  const structuredLineItems = extractStructuredLineItems(rawPrompt);
  const serviceType = inferServiceType(prompt);
  const structuredSquareFeetEstimate = inferSquareFeetFromStructuredLines(structuredLineItems);
  const squareFeetEstimate = structuredSquareFeetEstimate ?? extractExplicitSquareFeet(prompt);
  const squareFeetRange = deriveSquareFeetEstimateRange(prompt, squareFeetEstimate);

  const estimatedTotalAmount = extractNamedAmount(prompt, [
    /(?:whole\s+job|project|quote|total|price|cost)\s+(?:should\s+be|is|around|about|for)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:comes?\s+to|estimate(?:d)?\s+at|budget(?:ed)?\s+at)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)/,
  ]);

  const estimatedTaxAmount = extractNamedAmount(prompt, [
    /(?:sales\s+tax|tax)\s+(?:is|of|around|about|at)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);

  const estimatedInternalCostAmount = extractNamedAmount(prompt, [
    /(?:internal\s+cost|our\s+cost|cost\s+to\s+us)\s+(?:is|of|around|about|at)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);

  const customerName = extractCustomerName(prompt);
  const customerPhone = prompt.match(PHONE_PATTERN)?.[0];
  const customerEmail = prompt.match(EMAIL_PATTERN)?.[0]?.toLowerCase();
  const primaryStandardPresetMatch =
    findStandardWorkPresetMatches(serviceType, prompt, {
      primaryOnly: true,
      minimumScore: 2,
    })[0] ?? null;
  const supplementalStandardPresetMatches = primaryStandardPresetMatch
    ? findStandardWorkPresetMatches(serviceType, prompt, {
        excludeCatalogKeys: [primaryStandardPresetMatch.preset.catalogKey],
        minimumScore: 3,
      })
        .filter((match) => !match.preset.isPrimaryJob)
        .slice(0, 2)
    : [];
  const additionalPrimaryPresetMatches = primaryStandardPresetMatch
    ? findStandardWorkPresetMatches(serviceType, prompt, {
        excludeCatalogKeys: [primaryStandardPresetMatch.preset.catalogKey],
        minimumScore: 4,
      })
        .filter((match) => match.preset.isPrimaryJob)
        .slice(0, 1)
    : [];
  const standardPresetMatches = primaryStandardPresetMatch
    ? [primaryStandardPresetMatch, ...supplementalStandardPresetMatches, ...additionalPrimaryPresetMatches].slice(0, 3)
    : findStandardWorkPresetMatches(serviceType, prompt, {
        minimumScore: 3,
      }).slice(0, 2);
  const matchedLineItems =
    standardPresetMatches.length > 0
      ? standardPresetMatches.map((match) => ({
          description: match.preset.name,
          quantity: inferCatalogQuantity(
            {
              unitType: match.preset.unitType,
              defaultQuantity: match.preset.defaultQuantity,
              quantityMode: match.preset.quantityMode,
            },
            squareFeetEstimate,
          ),
          sectionType: "INCLUDED" as const,
          sectionLabel: null,
        }))
      : [];

  return {
    customerName,
    customerPhone,
    customerEmail,
    serviceType,
    title: inferTitle(serviceType, prompt),
    scopeText: prompt,
    squareFeetEstimate,
    squareFeetVariancePercent: squareFeetRange.squareFeetVariancePercent,
    squareFeetEstimateLow: squareFeetRange.squareFeetEstimateLow,
    squareFeetEstimateHigh: squareFeetRange.squareFeetEstimateHigh,
    estimatedTotalAmount,
    estimatedTaxAmount,
    estimatedInternalCostAmount,
    lineItems:
      structuredLineItems.length > 0
        ? structuredLineItems
        : matchedLineItems.length > 0
        ? matchedLineItems
        : [
            {
              description: laborDescription(serviceType, squareFeetEstimate),
              quantity: inferLaborQuantity(serviceType, squareFeetEstimate),
            },
            {
              description: inferMaterialDescription(serviceType, prompt),
              quantity: 1,
            },
          ],
  };
}
