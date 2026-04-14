export type ServiceCategory = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";

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

const serviceKeywords: Record<ServiceCategory, string[]> = {
  HVAC: [
    "hvac",
    "furnace",
    "ac",
    "a/c",
    "air conditioner",
    "condenser",
    "heat pump",
    "mini split",
    "ductwork",
    "cooling",
    "heating",
    "thermostat",
  ],
  PLUMBING: [
    "plumbing",
    "pipe",
    "piping",
    "leak",
    "clog",
    "unclog",
    "toilet",
    "water heater",
    "drain",
    "sewer",
    "hydro jet",
    "jetting",
    "faucet",
    "sink",
    "garbage disposal",
    "shower valve",
  ],
  FLOORING: [
    "floor",
    "flooring",
    "tile",
    "linoleum",
    "vinyl",
    "lvp",
    "laminate",
    "hardwood",
    "carpet",
    "subfloor",
  ],
  ROOFING: [
    "roof",
    "roofing",
    "shingle",
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
    "sprinkler",
    "irrigation",
    "hedge",
    "tree trim",
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
  const sqftMatch = message.match(/(\d+(?:\.\d+)?)\s*(sq\s*ft|sqft|square\s*feet)/i);
  if (!sqftMatch) {
    return 100;
  }

  const parsed = Number(sqftMatch[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export function generateDraftFromSms(message: string): GeneratedQuoteDraft {
  return {
    serviceType: inferServiceType(message),
    squareFeetEstimate: extractSquareFeet(message),
    scopeText: message.trim(),
  };
}
