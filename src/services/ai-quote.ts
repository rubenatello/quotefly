import OpenAI from "openai";
import { env } from "../config/env";
import type { ParsedChatToQuoteDraft } from "./chat-to-quote";
import { parseChatToQuotePrompt } from "./chat-to-quote";
import { inferServiceType } from "./quote-generator";

const AI_ENABLED = !!env.OPENAI_API_KEY;
const AI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";

let openaiClient: OpenAI | undefined;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export function getAiQuoteRuntimeInfo() {
  return {
    enabled: AI_ENABLED,
    model: AI_ENABLED ? AI_MODEL : "regex-fallback",
  };
}

const SYSTEM_PROMPT = `You are a contractor quoting assistant. Extract structured data from a natural-language quote request.

Return a JSON object (no markdown, no code fences) with exactly these fields:
{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "serviceType": "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
  "title": string,
  "scopeText": string,
  "squareFeetEstimate": number | null,
  "estimatedTotalAmount": number | null,
  "estimatedTaxAmount": number | null,
  "estimatedInternalCostAmount": number | null,
  "lineItems": [
    { "kind": "LABOR", "description": string, "quantity": number },
    { "kind": "MATERIAL", "description": string, "quantity": number }
  ]
}

Rules:
- serviceType must be one of the 6 options above, inferred from context.
- title should be a short professional quote title (e.g. "Roof Replacement Quote").
- scopeText should be a clean, professional description of the work scope based on the prompt.
- If the customer name, phone, or email are not mentioned, set them to null.
- squareFeetEstimate should only be set if explicitly mentioned.
- estimatedTotalAmount is the total customer-facing price if mentioned.
- estimatedInternalCostAmount is the internal cost if mentioned (usually not).
- lineItems should always include at least one LABOR and one MATERIAL item.
- quantity for labor = sq ft if mentioned, otherwise 1.
- quantity for material = 1 unless specified.
- Be concise and accurate. Do not hallucinate numbers not present in the prompt.`;

export async function aiParseChatToQuotePrompt(
  rawPrompt: string,
): Promise<ParsedChatToQuoteDraft> {
  // If OpenAI is not configured, fall back to regex parser
  if (!AI_ENABLED) {
    return parseChatToQuotePrompt(rawPrompt);
  }

  try {
    const client = getOpenAI();
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: rawPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      console.warn("[ai-quote] Empty AI response, falling back to regex parser");
      return parseChatToQuotePrompt(rawPrompt);
    }

    // Strip code fences if the model wraps the response
    const jsonStr = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Validate and normalize the response
    const serviceType = validateServiceType(parsed.serviceType) ?? inferServiceType(rawPrompt);

    return {
      customerName: typeof parsed.customerName === "string" ? parsed.customerName : undefined,
      customerPhone: typeof parsed.customerPhone === "string" ? parsed.customerPhone : undefined,
      customerEmail: typeof parsed.customerEmail === "string" ? parsed.customerEmail?.toLowerCase() : undefined,
      serviceType,
      title: typeof parsed.title === "string" ? parsed.title : `${serviceType} Service Quote`,
      scopeText: typeof parsed.scopeText === "string" ? parsed.scopeText : rawPrompt,
      squareFeetEstimate: typeof parsed.squareFeetEstimate === "number" ? parsed.squareFeetEstimate : null,
      estimatedTotalAmount: typeof parsed.estimatedTotalAmount === "number" ? parsed.estimatedTotalAmount : null,
      estimatedTaxAmount: typeof parsed.estimatedTaxAmount === "number" ? parsed.estimatedTaxAmount : null,
      estimatedInternalCostAmount: typeof parsed.estimatedInternalCostAmount === "number" ? parsed.estimatedInternalCostAmount : null,
      lineItems: normalizeLineItems(parsed.lineItems),
    };
  } catch (err) {
    console.error("[ai-quote] AI parsing failed, falling back to regex parser:", err);
    return parseChatToQuotePrompt(rawPrompt);
  }
}

const VALID_SERVICE_TYPES = new Set(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

function validateServiceType(value: unknown): "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION" | null {
  if (typeof value === "string" && VALID_SERVICE_TYPES.has(value)) {
    return value as "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";
  }
  return null;
}

function normalizeLineItems(items: unknown): ParsedChatToQuoteDraft["lineItems"] {
  const defaultItems: ParsedChatToQuoteDraft["lineItems"] = [
    { kind: "LABOR", description: "Labor and installation", quantity: 1 },
    { kind: "MATERIAL", description: "Materials and supplies", quantity: 1 },
  ];

  if (!Array.isArray(items) || items.length === 0) return defaultItems;

  const normalized: ParsedChatToQuoteDraft["lineItems"] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind === "LABOR" || rec.kind === "MATERIAL" ? rec.kind : null;
    if (!kind) continue;
    normalized.push({
      kind,
      description: typeof rec.description === "string" ? rec.description : `${kind.toLowerCase()} item`,
      quantity: typeof rec.quantity === "number" && rec.quantity > 0 ? rec.quantity : 1,
    });
  }

  if (!normalized.some((i) => i.kind === "LABOR")) {
    normalized.unshift({ kind: "LABOR", description: "Labor and installation", quantity: 1 });
  }
  if (!normalized.some((i) => i.kind === "MATERIAL")) {
    normalized.push({ kind: "MATERIAL", description: "Materials and supplies", quantity: 1 });
  }

  return normalized;
}
