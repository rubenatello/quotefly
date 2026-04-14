export type ServiceCategory = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";

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
    "toilet",
    "water heater",
    "drain",
    "sewer",
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

export function inferServiceType(message: string): ServiceCategory {
  const lower = message.toLowerCase();

  for (const [service, keywords] of Object.entries(serviceKeywords) as [ServiceCategory, string[]][]) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return service;
    }
  }

  return FLOORINGFallback(lower);
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
