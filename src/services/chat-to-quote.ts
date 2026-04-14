import { ServiceCategory, inferServiceType } from "./quote-generator";
import { findBestStandardWorkPresetMatch } from "./work-preset-catalog";

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
  estimatedTotalAmount: number | null;
  estimatedTaxAmount: number | null;
  estimatedInternalCostAmount: number | null;
  lineItems: ChatQuoteLineItemSuggestion[];
}

const PHONE_PATTERN = /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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

function extractExplicitSquareFeet(prompt: string): number | null {
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*(sq\s*ft|sqft|square\s*feet)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Number(value.toFixed(2));
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
    /\b(?:new\s+quote|quote|estimate)\s+for\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})(?=[,.\d]|$)/i,
  );
  const fallbackMatch = prompt.match(
    /\bfor\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})(?=[,.\d]|$)/i,
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
    if (lower.includes("asphalt shingle")) return "Asphalt shingles and roofing accessories";
    if (lower.includes("metal")) return "Metal roofing panels and flashing accessories";
    if (lower.includes("tile")) return "Tile roofing materials and underlayment";
    return "Roofing materials, underlayment, and accessories";
  }

  if (serviceType === "HVAC") {
    return "HVAC equipment, fittings, and install materials";
  }

  if (serviceType === "PLUMBING") {
    return "Plumbing fixtures, piping, and install materials";
  }

  if (serviceType === "GARDENING") {
    return "Landscape materials, mulch, and site supplies";
  }

  if (serviceType === "CONSTRUCTION") {
    return "Construction materials, consumables, and site supplies";
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
  if (serviceType === "ROOFING" && (lower.includes("replace") || lower.includes("replacement"))) {
    return "Roof Replacement Quote";
  }
  if (serviceType === "FLOORING" && (lower.includes("replace") || lower.includes("installation"))) {
    return "Flooring Installation Quote";
  }
  if (serviceType === "HVAC" && lower.includes("replace")) {
    return "HVAC Replacement Quote";
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

export function parseChatToQuotePrompt(rawPrompt: string): ParsedChatToQuoteDraft {
  const prompt = normalizePrompt(rawPrompt);
  const serviceType = inferServiceType(prompt);
  const squareFeetEstimate = extractExplicitSquareFeet(prompt);

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

  return {
    customerName,
    customerPhone,
    customerEmail,
    serviceType,
    title: inferTitle(serviceType, prompt),
    scopeText: prompt,
    squareFeetEstimate,
    estimatedTotalAmount,
    estimatedTaxAmount,
    estimatedInternalCostAmount,
    lineItems: [
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
