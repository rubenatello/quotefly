export type ServiceCategory = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING";

const serviceKeywords: Record<ServiceCategory, string[]> = {
  HVAC: ["hvac", "furnace", "ac", "air conditioner", "cooling", "heating"],
  PLUMBING: ["plumbing", "pipe", "leak", "toilet", "water heater", "drain"],
  FLOORING: ["floor", "flooring", "tile", "linoleum", "vinyl", "hardwood"],
  ROOFING: ["roof", "roofing", "shingle", "gutter"],
  GARDENING: ["garden", "gardening", "lawn", "yard", "landscape"],
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
  return "FLOORING";
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
