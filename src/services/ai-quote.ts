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

export type AiTelemetryAccumulator = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  model: string | null;
};

export function createAiTelemetryAccumulator(): AiTelemetryAccumulator {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    model: AI_ENABLED ? AI_MODEL : "regex-fallback",
  };
}

export type AiQuoteRevisionLineOperation = {
  action: "KEEP" | "UPDATE" | "ADD" | "REMOVE";
  targetLineNumber: number | null;
  description: string | null;
  quantity: number | null;
  unitCost: number | null;
  unitPrice: number | null;
  reason: string;
};

export type AiQuoteRevisionPlan = {
  serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION" | null;
  title: string | null;
  scopeText: string | null;
  summary: string;
  reasons: string[];
  sourceHints: string[];
  lineOperations: AiQuoteRevisionLineOperation[];
};

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
    { "description": string, "quantity": number }
  ]
}

Rules:
- serviceType must be one of the 6 options above, inferred from context.
- title should be a short professional quote title (e.g. "Roof Replacement Quote").
- scopeText should be a clean, professional description of the work scope based on the prompt.
- You may receive extra context about the current customer, customer notes, current quote draft, and saved jobs. Use that context when it is relevant.
- You may receive recent customer activity history. Use it to understand project context, urgency, objections, and previous follow-up.
- You may also receive similar past quotes from the same tenant. Use those as pricing and scope anchors when they fit the requested job.
- If customer notes are provided, use them as internal context for scope, constraints, and follow-up relevance, but do not repeat them verbatim unless they clearly belong in the quote.
- If recent customer activity is provided, use it as internal context and do not repeat irrelevant internal log phrasing in the customer-facing quote.
- If current quote context is provided, preserve the same trade unless the user clearly asks to change it.
- If current quote context is provided, treat the task as a revision. Preserve good existing structure, line intent, and scope unless the user clearly asks to replace or remove them.
- If the user asks for multiple lines, multiple phases, alternatives, contingencies, options, or fallback work, return separate lineItems for each requested option instead of collapsing them into one generic line.
- If the user asks for repair plus replacement, inspection plus allowance, or option A vs option B, return distinct lineItems for each major billable path.
- If saved job names or pricing hints are provided, prefer those names when they fit the requested work.
- If similar past quotes are provided, prefer their structure, naming, and pricing patterns over generic assumptions, especially when square footage or scope is similar.
- Prefer the tenant's own saved jobs and similar past quotes over generic invented line items whenever they fit the request.
- If the customer name, phone, or email are not mentioned, set them to null.
- squareFeetEstimate should only be set if explicitly mentioned.
- estimatedTotalAmount is the total customer-facing price if mentioned.
- estimatedInternalCostAmount is the internal cost if mentioned (usually not).
- lineItems should include each major billable line or option requested by the user, minimum 1.
- quantity should be square footage only when the prompt clearly implies area-based pricing for that line; otherwise default to 1.
- Be concise and accurate. Do not hallucinate numbers not present in the prompt.`;

const REVISION_SYSTEM_PROMPT = `You are a contractor quoting assistant revising an existing quote line by line.

Return a JSON object (no markdown, no code fences) with exactly these fields:
{
  "serviceType": "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION" | null,
  "title": string | null,
  "scopeText": string | null,
  "summary": string,
  "reasons": string[],
  "sourceHints": string[],
  "lineOperations": [
    {
      "action": "KEEP" | "UPDATE" | "ADD" | "REMOVE",
      "targetLineNumber": number | null,
      "description": string | null,
      "quantity": number | null,
      "unitCost": number | null,
      "unitPrice": number | null,
      "reason": string
    }
  ]
}

Rules:
- Use the numbered current quote lines when targeting an existing line.
- Preserve unrelated lines. Do not rewrite the whole quote.
- Only remove a line when the user clearly asks to remove, delete, exclude, or replace it.
- ADD actions must include description, quantity, unitCost, and unitPrice.
- UPDATE actions should target an existing line and only change what is necessary.
- If the user asks for alternative options, contingencies, fallback work, or "another line", prefer separate ADD actions rather than collapsing everything into one updated line.
- If the user asks for repair and replacement options together, preserve them as distinct line items.
- If title or scope do not need changes, return null for them.
- Prefer the tenant's saved jobs, pricing hints, similar accepted/sent quotes, customer notes, and recent activity when they fit the request.
- Keep customer-facing wording professional and concise.
- reasons should contain 1-3 short operator-facing explanations.
- sourceHints should contain 1-3 short source references such as saved jobs, customer notes, or similar accepted quotes.
- Be conservative. When unsure, preserve the current line rather than deleting it.`;

export async function aiParseChatToQuotePrompt(
  rawPrompt: string,
  options?: {
    context?: string;
    telemetry?: AiTelemetryAccumulator;
  },
): Promise<ParsedChatToQuoteDraft> {
  // If OpenAI is not configured, fall back to regex parser
  if (!AI_ENABLED) {
    return parseChatToQuotePrompt(rawPrompt);
  }

  try {
    const client = getOpenAI();
    const userMessage = options?.context?.trim()
      ? `Context:\n${options.context.trim()}\n\nUser request:\n${rawPrompt}`
      : rawPrompt;
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });
    accumulateOpenAiTelemetry(options?.telemetry, completion);

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

export async function aiBuildQuoteRevisionPlan(
  rawPrompt: string,
  options: {
    context?: string;
    telemetry?: AiTelemetryAccumulator;
  },
): Promise<AiQuoteRevisionPlan> {
  if (!AI_ENABLED) {
    return emptyRevisionPlan();
  }

  try {
    const client = getOpenAI();
    const userMessage = options.context?.trim()
      ? `Revision context:\n${options.context.trim()}\n\nUser request:\n${rawPrompt}`
      : rawPrompt;
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        { role: "system", content: REVISION_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });
    accumulateOpenAiTelemetry(options?.telemetry, completion);

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      console.warn("[ai-quote] Empty AI revision response");
      return emptyRevisionPlan();
    }

    const jsonStr = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      serviceType: validateServiceType(parsed.serviceType),
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null,
      scopeText: typeof parsed.scopeText === "string" && parsed.scopeText.trim() ? parsed.scopeText.trim() : null,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : "AI prepared a quote revision for review.",
      reasons: normalizeStringList(parsed.reasons, 3),
      sourceHints: normalizeStringList(parsed.sourceHints, 3),
      lineOperations: normalizeRevisionLineOperations(parsed.lineOperations),
    };
  } catch (err) {
    console.error("[ai-quote] AI revision planning failed:", err);
    return emptyRevisionPlan();
  }
}

const VALID_SERVICE_TYPES = new Set(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

function validateServiceType(value: unknown): "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION" | null {
  if (typeof value === "string" && VALID_SERVICE_TYPES.has(value)) {
    return value as "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";
  }
  return null;
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeRevisionLineOperations(value: unknown): AiQuoteRevisionLineOperation[] {
  if (!Array.isArray(value)) return [];

  const normalized: AiQuoteRevisionLineOperation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const operation = entry as Record<string, unknown>;
    const action =
      operation.action === "KEEP" ||
      operation.action === "UPDATE" ||
      operation.action === "ADD" ||
      operation.action === "REMOVE"
        ? operation.action
        : null;

    if (!action) continue;

    const targetLineNumber =
      typeof operation.targetLineNumber === "number" && operation.targetLineNumber > 0
        ? Math.floor(operation.targetLineNumber)
        : null;
    const description =
      typeof operation.description === "string" && operation.description.trim()
        ? operation.description.trim()
        : null;
    const quantity =
      typeof operation.quantity === "number" && Number.isFinite(operation.quantity) && operation.quantity > 0
        ? Number(operation.quantity.toFixed(2))
        : null;
    const unitCost =
      typeof operation.unitCost === "number" && Number.isFinite(operation.unitCost) && operation.unitCost >= 0
        ? Number(operation.unitCost.toFixed(2))
        : null;
    const unitPrice =
      typeof operation.unitPrice === "number" && Number.isFinite(operation.unitPrice) && operation.unitPrice >= 0
        ? Number(operation.unitPrice.toFixed(2))
        : null;
    const reason =
      typeof operation.reason === "string" && operation.reason.trim()
        ? operation.reason.trim()
        : "Aligned to the AI revision request.";

    if (action === "ADD" && (!description || quantity === null || unitCost === null || unitPrice === null)) {
      continue;
    }

    if ((action === "UPDATE" || action === "REMOVE") && targetLineNumber === null) {
      continue;
    }

    normalized.push({
      action,
      targetLineNumber,
      description,
      quantity,
      unitCost,
      unitPrice,
      reason,
    });
  }

  return normalized;
}

function emptyRevisionPlan(): AiQuoteRevisionPlan {
  return {
    serviceType: null,
    title: null,
    scopeText: null,
    summary: "AI prepared a quote revision for review.",
    reasons: [],
    sourceHints: [],
    lineOperations: [],
  };
}

function accumulateOpenAiTelemetry(
  target: AiTelemetryAccumulator | undefined,
  completion: {
    usage?: {
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      total_tokens?: number | null;
    } | null;
  },
) {
  if (!target) return;

  const promptTokens = completion.usage?.prompt_tokens ?? 0;
  const completionTokens = completion.usage?.completion_tokens ?? 0;
  const totalTokens = completion.usage?.total_tokens ?? promptTokens + completionTokens;

  target.requestCount += 1;
  target.promptTokens += promptTokens;
  target.completionTokens += completionTokens;
  target.totalTokens += totalTokens;
  target.estimatedCostUsd = roundTelemetryCost(
    target.estimatedCostUsd + estimateUsageCostUsd(promptTokens, completionTokens),
  );
  target.model = AI_MODEL;
}

function estimateUsageCostUsd(promptTokens: number, completionTokens: number) {
  const inputCost = (promptTokens / 1_000_000) * env.OPENAI_COST_INPUT_PER_1M_USD;
  const outputCost = (completionTokens / 1_000_000) * env.OPENAI_COST_OUTPUT_PER_1M_USD;
  return inputCost + outputCost;
}

function roundTelemetryCost(value: number) {
  return Number(value.toFixed(6));
}

function normalizeLineItems(items: unknown): ParsedChatToQuoteDraft["lineItems"] {
  const defaultItems: ParsedChatToQuoteDraft["lineItems"] = [
    { description: "Labor and installation", quantity: 1 },
    { description: "Materials and supplies", quantity: 1 },
  ];

  if (!Array.isArray(items) || items.length === 0) return defaultItems;

  const normalized: ParsedChatToQuoteDraft["lineItems"] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    if (!description) continue;
    normalized.push({
      description,
      quantity: typeof rec.quantity === "number" && rec.quantity > 0 ? rec.quantity : 1,
    });
  }

  return normalized.length ? normalized : defaultItems;
}
