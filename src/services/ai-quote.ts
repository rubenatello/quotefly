import OpenAI from "openai";
import { env } from "../config/env";
import type { ParsedChatToQuoteDraft } from "./chat-to-quote";
import { deriveSquareFeetEstimateRange, parseChatToQuotePrompt } from "./chat-to-quote";

const AI_ENABLED = !!env.OPENAI_API_KEY;
const AI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_AI_CONTEXT_CHARS = 10_000;
const MAX_AI_CONTEXT_LINES = 220;
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
  sectionType: "INCLUDED" | "ALTERNATE" | null;
  sectionLabel: string | null;
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
    {
      "description": string,
      "quantity": number,
      "sectionType": "INCLUDED" | "ALTERNATE",
      "sectionLabel": string | null
    }
  ]
}

Rules:
- serviceType must be one of the 6 options above, inferred from context.
- title should be a short professional quote title (e.g. "Roof Replacement Quote").
- scopeText should be a clean, professional description of the work scope based on the prompt.
- You may receive extra context about the current customer, customer notes, current quote draft, and saved jobs. Use that context when it is relevant.
- You may receive recent customer activity history. Use it to understand project context, urgency, objections, and previous follow-up.
- You may also receive similar past quotes from the same tenant. Use those as pricing and scope anchors when they fit the requested job.
- You may receive standard trade catalog matches (roofing, flooring, HVAC, gardening, plumbing, and construction). Treat them as valid baseline job templates when tenant-specific saved jobs are missing or incomplete.
- For roofing prompts, keep material/system terminology precise when present (for example asphalt shingles, architectural shingles, Spanish/clay tile, metal panels, TPO, EPDM, and modified bitumen/torch-down).
- For roofing prompts, interpret roofing "squares" as area: 1 square = 100 sq ft.
- For flooring prompts, preserve material/system terminology when present (for example LVP/LVT, linoleum or sheet vinyl, laminate, hardwood, tile, carpet) and keep prep/install terms explicit (underlayment, moisture barrier, subfloor leveling, uncoupling membrane, thinset/grout, trim/transition, nail-down/glue-down/floating method when stated).
- For HVAC prompts, preserve system terminology when present (for example condenser, evaporator coil, furnace, heat pump, mini-split, refrigerant repair/recharge, duct sealing, thermostat, airflow/static-pressure diagnostics, and efficiency cues such as SEER2/HSPF2).
- For plumbing prompts, preserve system terminology when present (for example repipe PEX/copper, water heater/tankless, sewer camera, hydro-jetting, trenchless sewer repair, slab leak, fixture reset/replacement, PRV/backflow, sump pump).
- For gardening prompts, preserve job mode and terminology when present (maintenance vs install; sod, aeration/overseed, fertilization/pre-emergent, irrigation/drip/sprinkler/controller, mulch, pruning, cleanup, drainage correction).
- When tenant saved jobs and pricing are provided in context and match the requested scope, prefer those cost/price anchors over generic assumptions.
- If customer notes are provided, use them as internal context for scope, constraints, and follow-up relevance, but do not repeat them verbatim unless they clearly belong in the quote.
- If recent customer activity is provided, use it as internal context and do not repeat irrelevant internal log phrasing in the customer-facing quote.
- If current quote context is provided, preserve the same trade unless the user clearly asks to change it.
- If current quote context is provided, treat the task as a revision. Preserve good existing structure, line intent, and scope unless the user clearly asks to replace or remove them.
- If the user asks for multiple lines, multiple phases, alternatives, contingencies, options, or fallback work, return separate lineItems for each requested option instead of collapsing them into one generic line.
- If the user asks for repair plus replacement, inspection plus allowance, or option A vs option B, return distinct lineItems for each major billable path.
- If the user gives explicit structured lines (for example "Line 1:", "Line 2:", or "Item 1:"), preserve each provided line as its own lineItem in the same order.
- If structured lines include explicit quantities, keep those quantities on the corresponding lineItems.
- Normal included work should use sectionType "INCLUDED".
- Alternate or fallback choices should use sectionType "ALTERNATE" and include a short sectionLabel like "Repair Option", "Replacement Option", or "Alternate Scope".
- If saved job names or pricing hints are provided, prefer those names when they fit the requested work.
- If standard trade catalog matches are provided, prefer those line names and pricing patterns over generic placeholder wording.
- If similar past quotes are provided, prefer their structure, naming, and pricing patterns over generic assumptions, especially when square footage or scope is similar.
- Prefer the tenant's own saved jobs and similar past quotes over generic invented line items whenever they fit the request.
- If the customer name, phone, or email are not mentioned, set them to null.
- squareFeetEstimate should only be set if explicitly mentioned.
- When multiple primary area lines are present, squareFeetEstimate should be the summed project area across those primary lines. Exclude alternate/optional allowance lines from that sum.
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
      "sectionType": "INCLUDED" | "ALTERNATE" | null,
      "sectionLabel": string | null,
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
- If the user includes explicit "Line 1 / Line 2 / Item 1" instructions, preserve that line-by-line structure.
- Use sectionType "ALTERNATE" for optional/fallback/add-on pricing that should not count toward the primary total.
- Use sectionLabel to group alternate lines when helpful, such as "Repair Option" or "Replacement Option".
- If title or scope do not need changes, return null for them.
- Prefer the tenant's saved jobs, pricing hints, similar accepted/sent quotes, customer notes, and recent activity when they fit the request.
- When standard trade catalog matches are provided, use them to ground line descriptions and unit economics by trade instead of inventing vague line names.
- For roofing revisions, preserve explicit material/system wording and treat roofing "squares" as 100 sq ft each.
- For flooring/HVAC/gardening/plumbing revisions, preserve precise material/system wording and keep distinct scope lines when the prompt requests multiple phases/options.
- Keep customer-facing wording professional and concise.
- reasons should contain 1-3 short operator-facing explanations.
- sourceHints should contain 1-3 short source references such as saved jobs, customer notes, or similar accepted quotes.
- Be conservative. When unsure, preserve the current line rather than deleting it.`;

export async function aiParseChatToQuotePrompt(
  rawPrompt: string,
  options?: {
    context?: string;
    telemetry?: AiTelemetryAccumulator;
    strictAi?: boolean;
  },
): Promise<ParsedChatToQuoteDraft> {
  // If OpenAI is not configured, fall back to regex parser
  if (!AI_ENABLED) {
    if (options?.strictAi) {
      throw new Error("OPENAI_API_KEY is missing; strict AI parsing cannot run.");
    }
    return parseChatToQuotePrompt(rawPrompt);
  }

  try {
    const client = getOpenAI();
    const deterministicFallback = parseChatToQuotePrompt(rawPrompt);
    const compactContext = compactAiContext(options?.context);
    const userMessage = compactContext
      ? `Context:\n${compactContext}\n\nUser request:\n${rawPrompt}`
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
      if (options?.strictAi) {
        throw new Error("AI returned an empty response for chat-to-quote parsing.");
      }
      console.warn("[ai-quote] Empty AI response, falling back to regex parser");
      return parseChatToQuotePrompt(rawPrompt);
    }

    // Strip code fences if the model wraps the response
    const jsonStr = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Validate and normalize the response
    const aiLineItems = normalizeLineItems(parsed.lineItems);
    const serviceType = validateServiceType(parsed.serviceType) ?? deterministicFallback.serviceType;
    const resolvedLineItems = shouldUseDeterministicLineItems(
      rawPrompt,
      aiLineItems,
      deterministicFallback.lineItems,
    )
      ? deterministicFallback.lineItems
      : aiLineItems;
    const aiSquareFeetEstimate = normalizeOptionalNumber(parsed.squareFeetEstimate, { min: 0.01 });
    const resolvedSquareFeetEstimate = resolveSquareFeetEstimate({
      rawPrompt,
      aiSquareFeetEstimate,
      deterministicSquareFeetEstimate: deterministicFallback.squareFeetEstimate,
      resolvedLineItems,
    });
    const squareFeetRange = deriveSquareFeetEstimateRange(rawPrompt, resolvedSquareFeetEstimate);

    return {
      customerName: normalizeOptionalString(parsed.customerName) ?? deterministicFallback.customerName,
      customerPhone: normalizeOptionalString(parsed.customerPhone) ?? deterministicFallback.customerPhone,
      customerEmail: normalizeOptionalEmail(parsed.customerEmail) ?? deterministicFallback.customerEmail,
      serviceType,
      title: normalizeOptionalString(parsed.title) ?? deterministicFallback.title,
      scopeText: normalizeOptionalString(parsed.scopeText) ?? deterministicFallback.scopeText,
      squareFeetEstimate: resolvedSquareFeetEstimate,
      squareFeetVariancePercent: squareFeetRange.squareFeetVariancePercent,
      squareFeetEstimateLow: squareFeetRange.squareFeetEstimateLow,
      squareFeetEstimateHigh: squareFeetRange.squareFeetEstimateHigh,
      estimatedTotalAmount:
        normalizeOptionalNumber(parsed.estimatedTotalAmount, { min: 0 }) ?? deterministicFallback.estimatedTotalAmount,
      estimatedTaxAmount:
        normalizeOptionalNumber(parsed.estimatedTaxAmount, { min: 0 }) ?? deterministicFallback.estimatedTaxAmount,
      estimatedInternalCostAmount:
        normalizeOptionalNumber(parsed.estimatedInternalCostAmount, { min: 0 }) ??
        deterministicFallback.estimatedInternalCostAmount,
      lineItems: resolvedLineItems,
    };
  } catch (err) {
    if (options?.strictAi) {
      throw err;
    }
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
    const compactContext = compactAiContext(options?.context);
    const userMessage = compactContext
      ? `Revision context:\n${compactContext}\n\nUser request:\n${rawPrompt}`
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
    const sectionType = validateSectionType(operation.sectionType);
    const sectionLabel =
      typeof operation.sectionLabel === "string" && operation.sectionLabel.trim()
        ? operation.sectionLabel.trim().slice(0, 80)
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
      sectionType,
      sectionLabel,
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

function compactAiContext(context?: string): string {
  const raw = context?.trim();
  if (!raw) return "";

  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd());

  const limitedLines = lines.slice(0, MAX_AI_CONTEXT_LINES);
  const joined = limitedLines.join("\n").trim();
  if (joined.length <= MAX_AI_CONTEXT_CHARS) {
    return joined;
  }

  return `${joined.slice(0, MAX_AI_CONTEXT_CHARS).trimEnd()}\n\n[Context trimmed for token budget safety.]`;
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
    { description: "Labor and installation", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
    { description: "Materials and supplies", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
  ];

  if (!Array.isArray(items) || items.length === 0) return defaultItems;

  const normalized: ParsedChatToQuoteDraft["lineItems"] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    if (!description) continue;
    const parsedQuantity =
      typeof rec.quantity === "number" && rec.quantity > 0
        ? Number(rec.quantity.toFixed(2))
        : null;
    const inferredQuantity = extractFirstSquareFeetValue(description);
    normalized.push({
      description,
      quantity:
        parsedQuantity !== null && Number.isFinite(parsedQuantity)
          ? parsedQuantity <= 1 && inferredQuantity && inferredQuantity > 1
            ? inferredQuantity
            : parsedQuantity
          : inferredQuantity ?? 1,
      sectionType: validateSectionType(rec.sectionType) ?? "INCLUDED",
      sectionLabel:
        typeof rec.sectionLabel === "string" && rec.sectionLabel.trim()
          ? rec.sectionLabel.trim().slice(0, 80)
          : null,
    });
  }

  return normalized.length ? normalized : defaultItems;
}

function validateSectionType(value: unknown): "INCLUDED" | "ALTERNATE" | null {
  return value === "ALTERNATE" || value === "INCLUDED" ? value : null;
}

const GENERIC_FALLBACK_LINE_LABELS = new Set([
  "labor and installation",
  "materials and supplies",
]);

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isGenericFallbackLineItems(lineItems: ParsedChatToQuoteDraft["lineItems"]): boolean {
  if (lineItems.length !== 2) return false;
  return lineItems.every((line) => GENERIC_FALLBACK_LINE_LABELS.has(normalizeComparableText(line.description)));
}

function hasComplexPromptCues(prompt: string): boolean {
  const normalized = normalizeComparableText(prompt);
  if (!normalized) return false;
  const cueMatches =
    normalized.match(/\b(include|plus|with|and|also|optional|alternate|option|phase|allowance|as well as|along with)\b/g)
      ?.length ?? 0;
  const commaCount = (prompt.match(/,/g) ?? []).length;
  return cueMatches >= 3 || commaCount >= 3;
}

function lineItemRichnessScore(lineItems: ParsedChatToQuoteDraft["lineItems"]): number {
  if (!lineItems.length || isGenericFallbackLineItems(lineItems)) return 0;
  const descriptions = lineItems
    .map((line) => normalizeComparableText(line.description))
    .filter((value) => value.length > 0);
  const uniqueDescriptions = new Set(descriptions);
  const multiWordCount = descriptions.filter((description) => description.includes(" ")).length;
  return uniqueDescriptions.size * 2 + Math.min(multiWordCount, 4);
}

function shouldUseDeterministicLineItems(
  rawPrompt: string,
  aiLineItems: ParsedChatToQuoteDraft["lineItems"],
  deterministicLineItems: ParsedChatToQuoteDraft["lineItems"],
): boolean {
  if (!aiLineItems.length) return true;
  if (!deterministicLineItems.length) return false;
  if (isGenericFallbackLineItems(aiLineItems)) {
    return !isGenericFallbackLineItems(deterministicLineItems);
  }

  if (!hasComplexPromptCues(rawPrompt) || isGenericFallbackLineItems(deterministicLineItems)) {
    return false;
  }

  if (aiLineItems.length <= 1 && deterministicLineItems.length >= 2) {
    return true;
  }

  return lineItemRichnessScore(deterministicLineItems) >= lineItemRichnessScore(aiLineItems) + 3;
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

function extractAreaClause(text: string, startIndex: number, matchLength: number): string {
  let clauseStart = startIndex;
  while (clauseStart > 0) {
    const previousChar = text[clauseStart - 1];
    if (AREA_CLAUSE_BOUNDARY_PATTERN.test(previousChar)) break;
    clauseStart -= 1;
  }

  let clauseEnd = Math.min(text.length, startIndex + matchLength);
  while (clauseEnd < text.length) {
    const currentChar = text[clauseEnd];
    if (AREA_CLAUSE_BOUNDARY_PATTERN.test(currentChar)) break;
    clauseEnd += 1;
  }

  return text.slice(clauseStart, clauseEnd);
}

function extractSquareFeetValues(text: string): number[] {
  return extractSquareFeetMatches(text).map((entry) => entry.value);
}

function extractSquareFeetMatches(text: string): Array<{ value: number; secondary: boolean }> {
  const matches: Array<{ value: number; secondary: boolean }> = [];
  for (const match of text.matchAll(SQUARE_FEET_PATTERN_GLOBAL)) {
    const parsed = parseSquareFeetLiteral(match[1] ?? "");
    if (parsed === null) continue;
    const index = match.index ?? 0;
    const clause = extractAreaClause(text, index, (match[0] ?? "").length);
    matches.push({
      value: parsed,
      secondary: AREA_SECONDARY_CUE_PATTERN.test(clause),
    });
  }
  for (const match of text.matchAll(ROOFING_SQUARE_PATTERN_GLOBAL)) {
    const parsed = parseSquareFeetLiteral(match[1] ?? "");
    if (parsed === null) continue;
    const index = match.index ?? 0;
    const clause = extractAreaClause(text, index, (match[0] ?? "").length);
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

function extractFirstSquareFeetValue(text: string): number | null {
  return extractSquareFeetValues(text)[0] ?? null;
}

function inferSquareFeetFromLineItems(lineItems: ParsedChatToQuoteDraft["lineItems"]): number | null {
  const secondaryCuePattern =
    /\b(allowance|if needed|optional|alternate|option|transition(?:s)?|trim(?:s)?|cut(?:s)?|repair|patch|level|leveling|upgrade|permit|fee|inspection)\b/i;
  const values: number[] = [];
  for (const line of lineItems) {
    if (line.sectionType === "ALTERNATE") continue;
    if (secondaryCuePattern.test(line.description)) continue;
    values.push(...extractSquareFeetValues(line.description));
  }
  if (!values.length) return null;
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function countPrimarySquareFeetLineSignals(lineItems: ParsedChatToQuoteDraft["lineItems"]): number {
  const areaKeywordPattern =
    /\b(room|bedroom|bath|bathroom|hall|hallway|floor|flooring|roof|roofing|sod|lawn|tile|shingle|area|sq|square)\b/i;
  const secondaryCuePattern =
    /\b(allowance|if needed|optional|alternate|option|transition(?:s)?|trim(?:s)?|cut(?:s)?|repair|patch|level|leveling|upgrade|permit|fee|inspection)\b/i;

  let count = 0;
  for (const line of lineItems) {
    if (line.sectionType === "ALTERNATE") continue;
    if (secondaryCuePattern.test(line.description)) continue;
    const quantity = Number(line.quantity);
    const hasSquareFeetLiteral = extractSquareFeetValues(line.description).length > 0;
    const hasAreaQuantity = quantity > 1.5 && areaKeywordPattern.test(line.description);
    if (hasSquareFeetLiteral || hasAreaQuantity) {
      count += 1;
    }
  }

  return count;
}

function inferSquareFeetFromLineItemQuantities(
  lineItems: ParsedChatToQuoteDraft["lineItems"],
  rawPrompt: string,
): number | null {
  if (extractSquareFeetValues(rawPrompt).length === 0) return null;

  const areaKeywordPattern =
    /\b(room|bedroom|bath|bathroom|hall|hallway|floor|flooring|roof|roofing|sod|lawn|tile|shingle|area|sq|square)\b/i;
  const secondaryQuantityCuePattern =
    /\b(allowance|if needed|optional|alternate|option|transition(?:s)?|trim(?:s)?|cut(?:s)?|repair|patch|level|leveling|upgrade|permit|fee|inspection)\b/i;
  const nonAreaUnitPattern =
    /\b(hour|hours|hr|hrs|zone|zones|ton|tons|unit|units|fixture|camera|thermostat|cleanup|disposal|service call|trip)\b/i;

  let sum = 0;
  let count = 0;
  for (const line of lineItems) {
    if (line.sectionType === "ALTERNATE") continue;
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 1.5) continue;
    if (secondaryQuantityCuePattern.test(line.description)) continue;
    if (nonAreaUnitPattern.test(line.description) && !areaKeywordPattern.test(line.description)) continue;
    if (!areaKeywordPattern.test(line.description) && extractSquareFeetValues(line.description).length === 0) continue;

    sum += quantity;
    count += 1;
  }

  if (count === 0 || sum <= 0) return null;
  return Number(sum.toFixed(2));
}

function hasSecondaryAreaCueInLineDescriptions(lineItems: ParsedChatToQuoteDraft["lineItems"]): boolean {
  const secondaryCuePattern =
    /\b(level|leveling|allowance|repair|patch|upgrade|option|alternate|optional|sealing|cleanup|disposal|trim(?:s)?|transition(?:s)?|cut(?:s)?|baseboard|underlayment|flashing|vent|fee|permit|inspection)\b/i;

  return lineItems.some((line) => {
    if (line.sectionType === "ALTERNATE") return true;
    const hasSqFt = extractSquareFeetValues(line.description).length > 0;
    if (!hasSqFt) return false;
    return secondaryCuePattern.test(line.description);
  });
}

function resolvePromptSquareFeetEstimate(matches: Array<{ value: number; secondary: boolean }>, rawPrompt: string): number | null {
  if (!matches.length) return null;

  const primaryValues = matches.filter((entry) => !entry.secondary).map((entry) => entry.value);
  if (primaryValues.length > 0) {
    if (primaryValues.length === 1) return primaryValues[0];
    return Number(primaryValues.reduce((sum, value) => sum + value, 0).toFixed(2));
  }

  const values = matches.map((entry) => entry.value);
  if (AREA_OPTION_PATTERN.test(rawPrompt)) {
    return Number(Math.max(...values).toFixed(2));
  }

  if (values.length === 1) return values[0];
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function resolveSquareFeetEstimate(params: {
  rawPrompt: string;
  aiSquareFeetEstimate: number | null;
  deterministicSquareFeetEstimate: number | null;
  resolvedLineItems: ParsedChatToQuoteDraft["lineItems"];
}): number | null {
  const promptSquareFeetMatches = extractSquareFeetMatches(params.rawPrompt);
  const promptPrimaryValues = promptSquareFeetMatches
    .filter((entry) => !entry.secondary)
    .map((entry) => entry.value);
  const promptSquareFeetEstimate = resolvePromptSquareFeetEstimate(promptSquareFeetMatches, params.rawPrompt);
  const lineItemSquareFeetEstimate = inferSquareFeetFromLineItems(params.resolvedLineItems);
  const lineQuantitySquareFeetEstimate = inferSquareFeetFromLineItemQuantities(
    params.resolvedLineItems,
    params.rawPrompt,
  );
  const resolvedLineSquareFeetEstimate =
    lineItemSquareFeetEstimate !== null ? lineItemSquareFeetEstimate : lineQuantitySquareFeetEstimate;
  const primaryLineSignalCount = countPrimarySquareFeetLineSignals(params.resolvedLineItems);
  if (
    resolvedLineSquareFeetEstimate !== null &&
    params.aiSquareFeetEstimate !== null &&
    primaryLineSignalCount >= 2
  ) {
    const delta = Math.abs(params.aiSquareFeetEstimate - resolvedLineSquareFeetEstimate);
    const ratio = resolvedLineSquareFeetEstimate > 0 ? delta / resolvedLineSquareFeetEstimate : 0;
    if (ratio >= 0.05) {
      return resolvedLineSquareFeetEstimate;
    }
  }
  if (resolvedLineSquareFeetEstimate !== null) {
    const hasSecondaryCue = hasSecondaryAreaCueInLineDescriptions(params.resolvedLineItems);
    if (
      hasSecondaryCue &&
      params.aiSquareFeetEstimate !== null &&
      params.aiSquareFeetEstimate <= resolvedLineSquareFeetEstimate
    ) {
      return params.aiSquareFeetEstimate;
    }

    if (params.aiSquareFeetEstimate === null) return resolvedLineSquareFeetEstimate;
    const delta = Math.abs(params.aiSquareFeetEstimate - resolvedLineSquareFeetEstimate);
    const ratio = resolvedLineSquareFeetEstimate > 0 ? delta / resolvedLineSquareFeetEstimate : 0;
    if (ratio >= 0.2) return resolvedLineSquareFeetEstimate;
  }

  if (
    params.aiSquareFeetEstimate !== null &&
    params.deterministicSquareFeetEstimate !== null &&
    promptPrimaryValues.length >= 2 &&
    !AREA_OPTION_PATTERN.test(params.rawPrompt) &&
    params.deterministicSquareFeetEstimate > params.aiSquareFeetEstimate
  ) {
    const delta = params.deterministicSquareFeetEstimate - params.aiSquareFeetEstimate;
    const ratio = params.deterministicSquareFeetEstimate > 0 ? delta / params.deterministicSquareFeetEstimate : 0;
    if (ratio >= 0.2) {
      return params.deterministicSquareFeetEstimate;
    }
  }

  if (
    params.aiSquareFeetEstimate !== null &&
    params.deterministicSquareFeetEstimate !== null &&
    hasSecondaryAreaCueInPrompt(params.rawPrompt) &&
    params.deterministicSquareFeetEstimate < params.aiSquareFeetEstimate
  ) {
    return params.deterministicSquareFeetEstimate;
  }

  if (params.aiSquareFeetEstimate !== null) {
    return params.aiSquareFeetEstimate;
  }

  if (params.deterministicSquareFeetEstimate !== null) {
    return params.deterministicSquareFeetEstimate;
  }

  return promptSquareFeetEstimate;
}

function hasSecondaryAreaCueInPrompt(prompt: string): boolean {
  return /\b(allowance|uneven|level|leveling|patch|repair|optional|alternate|option|upgrade|contingency|if needed)\b/i.test(
    prompt,
  );
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalEmail(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function normalizeOptionalNumber(value: unknown, options?: { min?: number }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof options?.min === "number" && value < options.min) return null;
  return Number(value.toFixed(2));
}
