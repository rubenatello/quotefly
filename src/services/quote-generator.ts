export type ServiceCategory = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";

const MATCHING_ALIASES: Array<[RegExp, string]> = [
  [/\bqoute\b/g, "quote"],
  [/\bestimte\b/g, "estimate"],
  [/\breplce\b/g, "replace"],
  [/\binstal\b/g, "install"],
  [/\binstll\b/g, "install"],
  [/\barchitechtural\b/g, "architectural"],
  [/\bfurnce\b/g, "furnace"],
  [/\bevap(?:orator)?\s*coil\b/g, "evaporator coil"],
  [/\brefridgerant\b/g, "refrigerant"],
  [/\bcondenesr\b/g, "condenser"],
  [/\bthremostat\b/g, "thermostat"],
  [/\blamnate\b/g, "laminate"],
  [/\bhardwoord\b/g, "hardwood"],
  [/\blinolium\b/g, "linoleum"],
  [/\birragation\b/g, "irrigation"],
  [/\baerateing\b/g, "aerating"],
  [/\bplubming\b/g, "plumbing"],
  [/\bsewr\b/g, "sewer"],
  [/\bhyrdo\b/g, "hydro"],
  [/\btankles\b/g, "tankless"],
  [/\btoiet\b/g, "toilet"],
  [/\bgarburator\b/g, "garbage disposal"],
  [/\bprv\b/g, "pressure regulator valve"],
  [/\bdrane\b/g, "drain"],
  [/\btriming\b/g, "trimming"],
  [/\bchimmney\b/g, "chimney"],
  [/\brepiar\b/g, "repair"],
  [/\baspahlt\b/g, "asphalt"],
  [/\bshingels\b/g, "shingles"],
  [/\bmodbit\b/g, "modified bitumen"],
  [/\btorchdown\b/g, "torch down"],
  [/\bcontorl\b/g, "control"],
  [/\btreatmnt\b/g, "treatment"],
  [/\bclean\s+up\b/g, "cleanup"],
];

const serviceKeywords: Record<ServiceCategory, string[]> = {
  HVAC: [
    "hvac",
    "furnace",
    "ac",
    "a/c",
    "air conditioner",
    "condenser",
    "ac condenser",
    "evaporator coil",
    "a coil",
    "a-coil",
    "compressor",
    "capacitor",
    "contactor",
    "refrigerant",
    "r410a",
    "r-410a",
    "r32",
    "r-32",
    "seer2",
    "hspf2",
    "heat pump",
    "mini split",
    "ductless",
    "ductwork",
    "duct sealing",
    "air handler",
    "static pressure",
    "cfm",
    "rooftop unit",
    "rtu",
    "cooling",
    "heating",
    "thermostat",
  ],
  PLUMBING: [
    "plumbing",
    "pipe",
    "piping",
    "repipe",
    "pex",
    "copper line",
    "leak",
    "slab leak",
    "clog",
    "unclog",
    "snaking",
    "auger",
    "toilet",
    "toilet flange",
    "wax ring",
    "water heater",
    "tankless",
    "anode rod",
    "drain",
    "sewer",
    "sewer line",
    "sewer camera",
    "trenchless",
    "pipe bursting",
    "cipp",
    "hydro jet",
    "hydrojetting",
    "jetting",
    "faucet",
    "sink",
    "garbage disposal",
    "pressure regulator valve",
    "prv",
    "backflow",
    "rpz",
    "sump pump",
    "shower valve",
  ],
  FLOORING: [
    "floor",
    "flooring",
    "tile",
    "linoleum",
    "vinyl",
    "lvp",
    "lvt",
    "sheet vinyl",
    "vinyl sheet",
    "porcelain tile",
    "ceramic tile",
    "uncoupling membrane",
    "ditra",
    "thinset",
    "grout",
    "laminate",
    "hardwood",
    "carpet",
    "subfloor",
    "self leveler",
    "baseboard",
    "transition strip",
    "floor prep",
    "nail down",
    "glue down",
    "floating floor",
    "refinish",
  ],
  ROOFING: [
    "roof",
    "roofing",
    "shingle",
    "asphalt shingle",
    "architectural shingle",
    "composition shingle",
    "spanish tile roof",
    "clay tile roof",
    "concrete tile roof",
    "metal roof",
    "standing seam",
    "corrugated metal",
    "roof square",
    "roofing square",
    "tpo",
    "epdm",
    "modified bitumen",
    "torch down",
    "flat roof",
    "low slope roof",
    "ridge cap",
    "drip edge",
    "gutter",
    "flashing",
    "underlayment",
    "soffit",
    "fascia",
    "leak repair",
    "roof replacement",
  ],
  GARDENING: [
    "garden",
    "gardening",
    "lawn",
    "yard",
    "landscape",
    "landscaping",
    "mulch",
    "sod",
    "aeration",
    "overseed",
    "fertilizer",
    "fertilization",
    "weed and feed",
    "pre emergent",
    "pre-emergent",
    "preemergence",
    "sprinkler",
    "sprinkler valve",
    "irrigation",
    "drip irrigation",
    "hydrozone",
    "controller",
    "hedge",
    "pruning",
    "tree trim",
    "drainage",
    "cleanup",
  ],
  CONSTRUCTION: [
    "construction",
    "remodel",
    "renovation",
    "framing",
    "build-out",
    "drywall",
    "paint",
    "painting",
    "deck",
    "fence",
    "concrete",
    "addition",
    "demo",
    "demolition",
  ],
};

export interface GeneratedQuoteDraft {
  serviceType: ServiceCategory;
  squareFeetEstimate: number;
  scopeText: string;
}

const SQUARE_FEET_PATTERN =
  /([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(sq\.?[\s-]*ft\.?|sqft|s\.?[\s-]*f\.?|square\s*feet|square\s*foot|sq\s*feet|sq\s*foot|ft2|ft\^2|feet\s*squared|foot\s*squared)\b/i;
const SQUARE_FEET_PATTERN_GLOBAL =
  /([\d,]+(?:\.\d+)?(?:\s*[kK])?)\s*(sq\.?[\s-]*ft\.?|sqft|s\.?[\s-]*f\.?|square\s*feet|square\s*foot|sq\s*feet|sq\s*foot|ft2|ft\^2|feet\s*squared|foot\s*squared)\b/gi;
const AREA_SECONDARY_CUE_PATTERN =
  /\b(about|around|approx|approximately|roughly|allowance|uneven|level|leveling|patch|repair|optional|alternate|option|upgrade|contingency|if needed)\b/i;
const AREA_OPTION_PATTERN = /\b(option|alternate|alternative|either|vs\.?|versus)\b/i;

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

function extractSquareFeetMatches(message: string): Array<{ value: number; secondary: boolean }> {
  const values: Array<{ value: number; secondary: boolean }> = [];
  for (const match of message.matchAll(SQUARE_FEET_PATTERN_GLOBAL)) {
    const parsed = parseSquareFeetLiteral(match[1] ?? "");
    if (parsed === null) continue;
    const index = match.index ?? 0;
    const context = message.slice(Math.max(0, index - 48), Math.min(message.length, index + 72));
    values.push({
      value: parsed,
      secondary: AREA_SECONDARY_CUE_PATTERN.test(context),
    });
  }
  return values;
}

function normalizeKeywordText(value: string): string {
  let normalized = value.toLowerCase();
  for (const [pattern, replacement] of MATCHING_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function getNormalizedTokens(normalizedMessage: string): string[] {
  return normalizedMessage.split(" ").filter((token) => token.length > 0);
}

function hasFuzzySingleTokenMatch(keywordToken: string, messageTokens: string[]): boolean {
  if (keywordToken.length < 5) return false;
  for (const token of messageTokens) {
    if (Math.abs(token.length - keywordToken.length) > 2) continue;
    const distance = levenshteinDistance(token, keywordToken);
    if (distance <= 1 || (keywordToken.length >= 8 && distance <= 2)) {
      return true;
    }
  }
  return false;
}

function scoreKeywordMatch(
  normalizedMessage: string,
  messageTokens: string[],
  keyword: string,
): number {
  const normalizedKeyword = normalizeKeywordText(keyword);
  if (!normalizedKeyword) return 0;

  if (normalizedKeyword.includes(" ")) {
    return normalizedMessage.includes(normalizedKeyword) ? 4 : 0;
  }

  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedKeyword)}(?:\\s|$)`);
  if (pattern.test(normalizedMessage)) {
    return 3;
  }

  if (hasFuzzySingleTokenMatch(normalizedKeyword, messageTokens)) {
    return 1;
  }

  return 0;
}

export function inferServiceType(message: string): ServiceCategory {
  const normalizedMessage = normalizeKeywordText(message);
  const messageTokens = getNormalizedTokens(normalizedMessage);
  const serviceScores: Array<{ service: ServiceCategory; score: number }> = [];

  for (const [service, keywords] of Object.entries(serviceKeywords) as [ServiceCategory, string[]][]) {
    let score = 0;
    for (const keyword of keywords) {
      score += scoreKeywordMatch(normalizedMessage, messageTokens, keyword);
    }
    serviceScores.push({ service, score });
  }

  serviceScores.sort((left, right) => right.score - left.score);
  if ((serviceScores[0]?.score ?? 0) > 0) {
    return serviceScores[0].service;
  }

  return FLOORINGFallback(normalizedMessage);
}

function FLOORINGFallback(_text: string): ServiceCategory {
  return "CONSTRUCTION";
}

export function extractSquareFeet(message: string): number {
  const matches = extractSquareFeetMatches(message);
  const values = matches.map((entry) => entry.value);
  if (!values.length) {
    const sqftMatch = message.match(SQUARE_FEET_PATTERN);
    if (!sqftMatch?.[1]) return 100;
    const parsed = parseSquareFeetLiteral(sqftMatch[1]);
    return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  }

  const primaryValues = matches.filter((entry) => !entry.secondary).map((entry) => entry.value);
  if (primaryValues.length > 0) {
    if (primaryValues.length === 1) return primaryValues[0];
    return Number(primaryValues.reduce((sum, value) => sum + value, 0).toFixed(2));
  }

  if (AREA_OPTION_PATTERN.test(message)) {
    return Number(Math.max(...values).toFixed(2));
  }

  if (values.length === 1) return values[0];
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

export function generateDraftFromSms(message: string): GeneratedQuoteDraft {
  return {
    serviceType: inferServiceType(message),
    squareFeetEstimate: extractSquareFeet(message),
    scopeText: message.trim(),
  };
}
