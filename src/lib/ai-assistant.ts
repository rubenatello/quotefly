import {
  Prisma,
  type AiPurpose,
  type AiUsageEventType,
  type DataClassification,
  type PrismaClient,
  type ServiceCategory,
} from "@prisma/client";
import {
  AI_ASSISTANT_TOOLS,
  type AiAssistantConversationState,
  type AiAssistantConversationTurn,
  type AiAssistantRequestedTool,
  type AiAssistantTool,
} from "./ai-assistant-contract";
import type { AccessContext } from "./access-policy";
import { hasCapability } from "./access-policy";
import type { ActivityActor } from "./activity";
import {
  composeAssistantAnswer,
  type AiAssistantAnswerMode,
  type AiAssistantCompositionResult,
} from "./ai-assistant-composer";
import { governAiPrompt, hashSourceReference } from "./ai-data-governance";
import {
  createAiUsageEvent,
  mergeAiUsageTelemetry,
  type AiUsageTelemetry,
  type MonthlyAiUsageSnapshot,
} from "./ai-usage";
import {
  AiBusinessInsightForbiddenError,
  generateAiBusinessInsight,
  type AiBusinessInsightTool,
} from "./ai-business-insights";
import { buildGovernedQuoteAiContext, type AiRetrievalResult } from "./ai-retrieval";
import { AI_DATA_POLICY_VERSION } from "./data-classification";
import { formatUsPhone, normalizePhoneSearchDigits, normalizeUsPhoneDigits } from "./phone";
import { tenantActiveCustomerScope, tenantActiveQuoteScope } from "./query-scope";
import { withTenantRlsContext } from "./tenant-rls";
import { parseChatToQuotePrompt } from "../services/chat-to-quote";

export { AI_ASSISTANT_TOOLS } from "./ai-assistant-contract";
export type { AiAssistantRequestedTool, AiAssistantTool } from "./ai-assistant-contract";

export type AiAssistantContext = Readonly<{
  currentPage?: "quotes" | "customers" | "analytics" | "products" | "dashboard";
  customerId?: string;
  quoteId?: string;
  search?: string;
  serviceType?: ServiceCategory;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  limit?: number;
  includeArchived?: boolean;
}>;

export type AiAssistantAction = Readonly<{
  type:
    | "OPEN_CUSTOMER"
    | "OPEN_CUSTOMER_DRAFT"
    | "OPEN_PRODUCT_DRAFT"
    | "OPEN_QUOTE_DRAFT"
    | "OPEN_QUOTE_SEND"
    | "OPEN_ANALYTICS"
    | "OPEN_WORKSPACE_PAGE"
    | "REQUEST_ADMIN_ACCESS";
  label: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
}>;

export type AiAssistantCitation = Readonly<{
  key: string;
  label: string;
  sourceType: string;
  classification: DataClassification;
}>;

export type AiAssistantResult = Readonly<{
  tool: AiAssistantTool;
  generatedAtUtc: Date;
  policyVersion: string;
  maxClassification: DataClassification;
  answer: string;
  results: Array<Record<string, string | number | boolean | null>>;
  citations: AiAssistantCitation[];
  actions: AiAssistantAction[];
  auditEventId: string;
  fieldsExcluded: string[];
  diagnostics: AiAssistantDiagnostics;
  conversation?: AiAssistantConversationState;
}>;

export type AiAssistantRunResult = Readonly<{
  assistant: AiAssistantResult;
  consumedCredits: number;
  consumedSpendUsd: number;
}>;

export type AiAssistantDiagnostics = Readonly<{
  requestedTool: AiAssistantRequestedTool;
  resolvedTool: AiAssistantTool;
  resultCount: number;
  citationCount: number;
  emptyReason: string | null;
  archivePolicy: string;
  filters: Readonly<Record<string, string | number | boolean | null>>;
  answerMode: AiAssistantAnswerMode;
  model: string | null;
}>;

export type AiAssistantInput = Readonly<{
  access: AccessContext;
  actor: ActivityActor;
  message: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
  conversation?: readonly AiAssistantConversationTurn[];
  now?: Date;
  usageSnapshot?: MonthlyAiUsageSnapshot;
}>;

const DEFAULT_CUSTOMER_LIMIT = 5;
const MAX_CUSTOMER_LIMIT = 8;
const OPEN_PIPELINE_STATUSES = ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER"] as const;
const ZERO_AI_TELEMETRY: AiUsageTelemetry = Object.freeze({
  requestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
});
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  C0_PUBLIC: 0,
  C1_BUSINESS_INTERNAL: 1,
  C2_CUSTOMER_CONFIDENTIAL: 2,
  C3_FINANCIAL_CONFIDENTIAL: 3,
  C4_RESTRICTED: 4,
};

function assignedCustomerScope(access: AccessContext): Prisma.CustomerWhereInput {
  return hasCapability(access, "viewAllWorkspaceRecords")
    ? {}
    : { assignedTenantUserId: access.tenantUserId };
}

function assignedQuoteScope(access: AccessContext): Prisma.QuoteWhereInput {
  return hasCapability(access, "viewAllWorkspaceRecords")
    ? {}
    : { assignedTenantUserId: access.tenantUserId };
}

function highestClassification(...values: readonly DataClassification[]) {
  return values.reduce<DataClassification>(
    (current, value) => CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[current] ? value : current,
    "C0_PUBLIC",
  );
}
const STOP_CUSTOMER_SEARCH_PREFIX =
  /^(?:please\s+)?(?:find|search|look\s+up|show|show\s+me|open)\s+(?:a\s+)?(?:customer|client|contact|customers|clients|contacts)\s*(?:named|called|for|matching|with)?\s*/i;
const FINANCIAL_INTENT_PATTERN = /\b(profit|profitable|profitability|margin|gross|cost|costs|rank|underpriced|low[-\s]*margin|item|items|product|products)\b/i;
const PIPELINE_INTENT_PATTERN = /\b(pipeline|sales|revenue|win\s*rate|accepted|sent|open\s+quotes?|follow[-\s]*up)\b/i;
const CUSTOMER_INTENT_PATTERN = /\b(customer|client|contact|phone|email|find|search|look\s+up)\b/i;
const QUOTE_DRAFT_INTENT_PATTERN = /\b(quote|estimate|draft|bid|proposal|new\s+job|sq\s*ft|sqft|roof|roofing|floor|flooring|hvac|plumb|plumbing|landscap|construction)\b/i;
const FOLLOW_UP_INTENT_PATTERN = /\bfollow(?:ed|ing)?[-\s]+up\b|\bfollow[-\s]*up\b/i;
const CUSTOMERS_WITHOUT_QUOTES_PATTERN =
  /\b(?:customers?|clients?)\b.{0,64}\b(?:do\s+not\s+have|does\s+not\s+have|don't\s+have|doesn't\s+have|have\s+no|has\s+no|without|missing)\b.{0,40}\b(?:quotes?|estimates?|proposals?)\b/i;
const PIPELINE_SCENARIO_PATTERN =
  /(?:\b(?:close|closed|convert|converted|win|won|sell|sold|attain|attained|land|landed|realize|realized)\b.{0,64}\b(?:\d{1,3}(?:\.\d+)?\s*(?:%|percent)|open\s+(?:quotes?|pipeline))\b)|(?:\b\d{1,3}(?:\.\d+)?\s*(?:%|percent)\b.{0,64}\b(?:open\s+quotes?|pipeline|revenue)\b)/i;
const PRODUCT_DRAFT_INTENT_PATTERN =
  /(?:\b(?:add|create|make|save|set\s+up)\b.{0,72}\b(?:product|service|catalog\s+item|line[-\s]*item)\b)|(?:\b(?:product|service|catalog\s+item|line[-\s]*item)\b.{0,72}\b(?:add|create|make|save|set\s+up)\b)/i;
const CUSTOMER_DRAFT_INTENT_PATTERN =
  /(?:\b(?:add|create|save|set\s+up|new)\b.{0,56}\b(?:customer(?!\s+(?:price|pricing|amount|rate))|client|contact)\b)|(?:\b(?:customer(?!\s+(?:price|pricing|amount|rate))|client|contact)\b.{0,56}\b(?:add|create|save|set\s+up)\b)/i;
const QUOTE_SEND_INTENT_PATTERN =
  /(?:\b(?:send|email|text|share)\b.{0,72}\b(?:quote|estimate|proposal)\b)|(?:\b(?:quote|estimate|proposal)\b.{0,72}\b(?:send|email|text|share)\b)/i;
const CUSTOMER_DRAFT_DETAIL_PATTERN =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i;
const QUOTE_SEND_FOLLOW_UP_PATTERN =
  /^(?:send|email|text|share|use\s+(?:email|text)|the\s+(?:first|second|third|latest)|for\s+|to\s+)/i;
const NAVIGATION_VERB_PATTERN = /\b(?:go|open|navigate|take\s+me|bring\s+me|move\s+me|show\s+me)\b/i;
const CONVERSATION_FOLLOW_UP_PATTERN =
  /^(?:and\b|also\b|what\s+about\b|how\s+about\b|now\b|same\b|show\s+me\s+more\b|which\s+(?:one|ones)\b|break\s+(?:that|it)\s+down\b|compare\s+(?:that|them|those)\b)/i;
const ASSISTANT_HELP_PATTERN =
  /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|help|what\s+can\s+you\s+do|how\s+can\s+you\s+help|who\s+are\s+you|what\s+is\s+kody)[\s.!?]*$/i;
const INSTRUCTION_OVERRIDE_PATTERN =
  /\b(?:ignore|disregard|override|forget)\b.{0,48}\b(?:instructions?|system|developer|safety\s+rules?|rules?|policy|guardrails?)\b/i;
const SENSITIVE_SCOPE_ESCAPE_PATTERN =
  /\b(?:system\s+prompt|developer\s+message|hidden\s+prompt|jailbreak|bypass\s+(?:the\s+)?(?:tenant|policy|guardrails?)|cross[-\s]*tenant|(?:another|other)\s+tenant(?:'s|s)?|api\s+key|secret\s+token)\b/i;
const OUTSIDE_KNOWLEDGE_PATTERN =
  /\b(?:weather|forecast|headline|news|politics|election|sports?|celebrity|movie|television|recipe|cooking|joke|poem|story|homework|medical\s+advice|diagnos(?:e|is)|legal\s+advice|stock\s+tip|invest(?:ment|ing)|cryptocurrency|write\s+code|programming)\b/i;
const CONTEXTUAL_ENTITY_QUERY_PATTERN =
  /^(?!.*\b(?:what|why|how|when|where|who|tell|explain|write|give|could|would|should)\b)[\p{L}\p{N}][\p{L}\p{N}\s.'@()+&/-]{0,80}$/iu;

type AssistantTopic = "CRM" | "QUOTING" | "SENDING" | "PRODUCTS" | "INSIGHTS" | "NAVIGATION" | "HELP";

function assistantTopic(tool: AiAssistantTool): AssistantTopic {
  if (tool === "ASSISTANT_HELP" || tool === "OUT_OF_SCOPE") return "HELP";
  if (["SEARCH_CUSTOMERS", "FOLLOW_UP_QUEUE", "CUSTOMERS_WITHOUT_QUOTES", "DRAFT_CUSTOMER"].includes(tool)) return "CRM";
  if (tool === "DRAFT_QUOTE") return "QUOTING";
  if (tool === "PREPARE_QUOTE_SEND") return "SENDING";
  if (tool === "DRAFT_PRODUCT") return "PRODUCTS";
  if (tool === "NAVIGATE_WORKSPACE") return "NAVIGATION";
  return "INSIGHTS";
}

function assistantTopicLabel(topic: AssistantTopic) {
  if (topic === "CRM") return "customer follow-up";
  if (topic === "QUOTING") return "building a quote";
  if (topic === "SENDING") return "preparing a quote to send";
  if (topic === "PRODUCTS") return "setting up a product or service";
  if (topic === "INSIGHTS") return "business insights";
  if (topic === "HELP") return "QuoteFly help";
  return "workspace navigation";
}

function previousOperationalTool(conversation: readonly AiAssistantConversationTurn[] | undefined) {
  return [...(conversation ?? [])]
    .reverse()
    .find((turn) => turn.resolvedTool !== "ASSISTANT_HELP" && turn.resolvedTool !== "OUT_OF_SCOPE")
    ?.resolvedTool ?? null;
}

export function resolveAssistantConversationState(
  conversation: readonly AiAssistantConversationTurn[] | undefined,
  currentTool: AiAssistantTool,
): AiAssistantConversationState {
  const previousTool = previousOperationalTool(conversation);
  if (currentTool === "ASSISTANT_HELP" || currentTool === "OUT_OF_SCOPE") {
    return { mode: "NEW", acknowledgement: null, previousTool, currentTool };
  }
  if (!previousTool) {
    return { mode: "NEW", acknowledgement: null, previousTool: null, currentTool };
  }

  const previousTopic = assistantTopic(previousTool);
  const currentTopic = assistantTopic(currentTool);
  if (previousTopic === currentTopic || previousTopic === "NAVIGATION" || currentTopic === "NAVIGATION") {
    return { mode: "CONTINUING", acknowledgement: null, previousTool, currentTool };
  }

  return {
    mode: "SHIFTED",
    acknowledgement: `Got it — we're switching from ${assistantTopicLabel(previousTopic)} to ${assistantTopicLabel(currentTopic)}. I'll use your latest request.`,
    previousTool,
    currentTool,
  };
}
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "called",
  "can",
  "client",
  "clients",
  "contact",
  "contacts",
  "customer",
  "customers",
  "find",
  "for",
  "include",
  "look",
  "matching",
  "named",
  "or",
  "please",
  "retrieve",
  "search",
  "show",
  "so",
  "tenant",
  "tenantid",
  "too",
  "up",
  "with",
  "you",
]);

const CUSTOMER_DRAFT_PHONE_PATTERN = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const CUSTOMER_DRAFT_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CUSTOMER_DRAFT_GENERIC_NAME_PATTERN = /^(?:a\s+)?(?:new\s+)?(?:customer|client|contact)$/i;
const QUOTE_SEND_STOP_WORDS = new Set([
  "a",
  "an",
  "by",
  "customer",
  "email",
  "estimate",
  "for",
  "latest",
  "my",
  "please",
  "prepare",
  "proposal",
  "quote",
  "saved",
  "selected",
  "send",
  "share",
  "text",
  "the",
  "this",
  "to",
  "using",
  "via",
]);

type CustomerDraftPreview = Readonly<{
  fullName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}>;

function extractCustomerDraftName(message: string) {
  const commandMatch = message.match(
    /\b(?:add|create|save|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:customer|client|contact)(?:\s+(?:named|called))?\s+([^,;\n]+)/i,
  );
  const withoutContactDetails = message
    .replace(CUSTOMER_DRAFT_EMAIL_PATTERN, " ")
    .replace(CUSTOMER_DRAFT_PHONE_PATTERN, " ")
    .replace(/\b(?:phone|mobile|cell|email|e-mail|notes?)\s*[:=-]?/gi, " ")
    .replace(/^\s*(?:add|create|save|set\s+up)?\s*(?:a\s+)?(?:new\s+)?(?:customer|client|contact)?(?:\s+(?:named|called))?\s*/i, "")
    .split(/[,;\n]/, 1)[0]
    ?.trim();
  const candidate = (commandMatch?.[1] ?? withoutContactDetails ?? "")
    .replace(/\b(?:phone|mobile|cell|email|e-mail|notes?)\b.*$/i, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .slice(0, 120);
  if (
    candidate.length < 2
    || CUSTOMER_DRAFT_GENERIC_NAME_PATTERN.test(candidate)
    || !/^[\p{L}][\p{L}\p{M}.'-]*(?:\s+[\p{L}][\p{L}\p{M}.'-]*){0,5}$/u.test(candidate)
  ) return null;
  return candidate;
}

function parseCustomerDraft(message: string): CustomerDraftPreview {
  const phoneRaw = message.match(CUSTOMER_DRAFT_PHONE_PATTERN)?.[0] ?? null;
  const phoneDigits = normalizeUsPhoneDigits(phoneRaw);
  const email = message.match(CUSTOMER_DRAFT_EMAIL_PATTERN)?.[0]?.toLowerCase() ?? null;
  const notesMatch = message.match(/\bnotes?\s*[:=-]\s*([^\n]{1,500})/i);
  return {
    fullName: extractCustomerDraftName(message),
    phone: phoneDigits ? formatUsPhone(phoneDigits) : null,
    email,
    notes: notesMatch?.[1]?.trim().slice(0, 500) || null,
  };
}

function quoteSendSearchTokens(message: string) {
  return message
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !QUOTE_SEND_STOP_WORDS.has(token))
    .slice(0, 5);
}

function clampLimit(value: number | undefined, max: number, fallback: number) {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function cleanSearchQuery(message: string, contextSearch?: string) {
  let raw = contextSearch?.trim() || message.trim().replace(STOP_CUSTOMER_SEARCH_PREFIX, "").trim();
  raw = raw.split(/\b(?:and\s+)?(?:ignore|bypass|override|expose|retrieve\s+all|show\s+all)\b/i)[0] ?? raw;
  const cleaned = raw.replace(/\s+/g, " ").slice(0, 120);
  return /^(?:please\s+)?(?:find|search|show(?:\s+me)?|look\s+up)?\s*(?:(?:my|assigned|active|recent)\s+)*(?:customers?|clients?|contacts?)$/i.test(cleaned)
    ? ""
    : cleaned;
}

function searchableTokens(search: string) {
  return search
    .normalize("NFKC")
    .split(/[^a-zA-Z0-9@._+-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
    .slice(0, 6);
}

type AiWorkspaceTarget = "customers" | "quotes" | "products" | "follow-up" | "analytics" | "build";

function navigationTarget(message: string): AiWorkspaceTarget | null {
  if (!NAVIGATION_VERB_PATTERN.test(message)) return null;
  if (/\b(?:profit|profitable|profitability|margin|gross|cost|costs|rank|underpriced|low[-\s]*margin)\b/i.test(message)) {
    return null;
  }
  if (/\b(?:new|create|draft|build)\s+(?:a\s+)?(?:quote|estimate|proposal)\b/i.test(message)) return "build";
  if (/\b(?:products?|services?|catalog|pricing)\b/i.test(message)) return "products";
  if (FOLLOW_UP_INTENT_PATTERN.test(message)) return "follow-up";
  if (/\b(?:analytics|reports?|insights?|dashboard)\b/i.test(message)) return "analytics";
  if (
    /\b(?:go|navigate|take\s+me|bring\s+me|move\s+me)\b.{0,40}\b(?:customers?|clients?|contacts?)\b/i.test(message) ||
    /\bopen\s+(?:the\s+)?(?:customers?|clients?|contacts?)(?:\s+(?:page|list|tab|screen))?\s*[.!?]*$/i.test(message)
  ) return "customers";
  if (
    /\b(?:go|navigate|take\s+me|bring\s+me|move\s+me)\b.{0,40}\b(?:quotes?|estimates?|proposals?)\b/i.test(message) ||
    /\bopen\s+(?:the\s+)?(?:quotes?|estimates?|proposals?)(?:\s+(?:page|list|tab|screen))?\s*[.!?]*$/i.test(message)
  ) return "quotes";
  return null;
}

export function resolveAssistantTool(
  message: string,
  requestedTool?: AiAssistantRequestedTool,
  context?: AiAssistantContext,
  conversation?: readonly AiAssistantConversationTurn[],
): AiAssistantTool {
  const normalizedMessage = message.normalize("NFKC").trim();
  if (OUTSIDE_KNOWLEDGE_PATTERN.test(normalizedMessage)) return "OUT_OF_SCOPE";
  const overrideMatch = INSTRUCTION_OVERRIDE_PATTERN.exec(normalizedMessage);
  if (overrideMatch?.index === 0) return "OUT_OF_SCOPE";
  const routingMessage = overrideMatch?.index
    ? normalizedMessage.slice(0, overrideMatch.index).trim()
    : normalizedMessage;
  if (SENSITIVE_SCOPE_ESCAPE_PATTERN.test(routingMessage)) return "OUT_OF_SCOPE";

  // A review-only product draft is a stronger intent than a stale UI tool
  // selection. This also protects older clients that opened Kody from a
  // customer-specific button and then replaced the suggested prompt.
  if (PRODUCT_DRAFT_INTENT_PATTERN.test(routingMessage)) return "DRAFT_PRODUCT";
  if (CUSTOMER_DRAFT_INTENT_PATTERN.test(routingMessage)) return "DRAFT_CUSTOMER";
  if (QUOTE_SEND_INTENT_PATTERN.test(routingMessage)) return "PREPARE_QUOTE_SEND";
  const lower = routingMessage.toLowerCase();
  if (requestedTool && requestedTool !== "AUTO") {
    if (ASSISTANT_HELP_PATTERN.test(routingMessage)) return "ASSISTANT_HELP";
    const hasQuoteFlyIntent =
      PIPELINE_SCENARIO_PATTERN.test(lower)
      || CUSTOMERS_WITHOUT_QUOTES_PATTERN.test(lower)
      || FOLLOW_UP_INTENT_PATTERN.test(lower)
      || Boolean(navigationTarget(lower))
      || FINANCIAL_INTENT_PATTERN.test(lower)
      || PIPELINE_INTENT_PATTERN.test(lower)
      || CUSTOMER_DRAFT_INTENT_PATTERN.test(lower)
      || CUSTOMER_INTENT_PATTERN.test(lower)
      || QUOTE_SEND_INTENT_PATTERN.test(lower)
      || QUOTE_DRAFT_INTENT_PATTERN.test(lower)
      || CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage);
    return hasQuoteFlyIntent ? requestedTool : "OUT_OF_SCOPE";
  }

  if (PIPELINE_SCENARIO_PATTERN.test(lower)) return "PIPELINE_SCENARIO";
  if (CUSTOMERS_WITHOUT_QUOTES_PATTERN.test(lower)) return "CUSTOMERS_WITHOUT_QUOTES";
  if (FOLLOW_UP_INTENT_PATTERN.test(lower)) return "FOLLOW_UP_QUEUE";
  if (navigationTarget(lower)) return "NAVIGATE_WORKSPACE";
  if (FINANCIAL_INTENT_PATTERN.test(lower)) return "RANK_PROFITABLE_JOBS";
  if (PIPELINE_INTENT_PATTERN.test(lower)) return "SUMMARIZE_PIPELINE";
  if (QUOTE_DRAFT_INTENT_PATTERN.test(lower)) return "DRAFT_QUOTE";

  const previousTool = previousOperationalTool(conversation);
  if (previousTool === "DRAFT_CUSTOMER" && CUSTOMER_DRAFT_DETAIL_PATTERN.test(routingMessage)) {
    return "DRAFT_CUSTOMER";
  }
  if (previousTool === "PREPARE_QUOTE_SEND" && QUOTE_SEND_FOLLOW_UP_PATTERN.test(lower.trim())) {
    return "PREPARE_QUOTE_SEND";
  }
  if (CUSTOMER_INTENT_PATTERN.test(lower)) return "SEARCH_CUSTOMERS";
  if (previousTool && previousTool !== "NAVIGATE_WORKSPACE" && CONVERSATION_FOLLOW_UP_PATTERN.test(lower.trim())) {
    return previousTool;
  }

  if (ASSISTANT_HELP_PATTERN.test(routingMessage)) return "ASSISTANT_HELP";

  if (CONTEXTUAL_ENTITY_QUERY_PATTERN.test(routingMessage)) {
    if (context?.currentPage === "customers") return "SEARCH_CUSTOMERS";
    if (context?.currentPage === "quotes") return "DRAFT_QUOTE";
    if (context?.currentPage === "analytics") return "SUMMARIZE_PIPELINE";
  }

  return "OUT_OF_SCOPE";
}

export function inferAssistantRelativeDateRange(message: string, now: Date) {
  const normalized = message.normalize("NFKC").toLowerCase();
  const numericDays = normalized.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/);
  let days = numericDays ? Number(numericDays[1]) : null;
  if (days === null && /\b(?:last|past|previous)\s+week\b/.test(normalized)) days = 7;
  if (days === null && /\b(?:last|past|previous)\s+month\b/.test(normalized)) days = 30;
  if (days === null && /\b(?:last|past|previous)\s+quarter\b/.test(normalized)) days = 90;
  if (days === null && /\b(?:last|past|previous)\s+year\b/.test(normalized)) days = 365;
  if (days === null || !Number.isFinite(days) || days < 1 || days > 730) return null;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days);
  return { from, to: now };
}

export function assistantToolConsumesAiBudget(tool: AiAssistantTool) {
  return ![
    "NAVIGATE_WORKSPACE",
    "FOLLOW_UP_QUEUE",
    "CUSTOMERS_WITHOUT_QUOTES",
    "PIPELINE_SCENARIO",
    "DRAFT_CUSTOMER",
    "DRAFT_PRODUCT",
    "PREPARE_QUOTE_SEND",
    "ASSISTANT_HELP",
    "OUT_OF_SCOPE",
  ].includes(tool);
}

function defaultExcludedFields(financial = false) {
  return [
    "tenant ids",
    "deleted rows",
    "provider identifiers",
    "raw prompts",
    ...(financial ? [] : ["internal costs", "gross profit", "margins"]),
  ];
}

function currency(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function requestedTool(params: AiAssistantInput): AiAssistantRequestedTool {
  return params.tool ?? "AUTO";
}

function diagnostics(params: {
  input: AiAssistantInput;
  resolvedTool: AiAssistantTool;
  resultCount: number;
  citationCount: number;
  emptyReason?: string | null;
  archivePolicy: string;
  filters?: Record<string, string | number | boolean | null | undefined>;
}): AiAssistantDiagnostics {
  const filters = Object.fromEntries(
    Object.entries(params.filters ?? {}).map(([key, value]) => [key, value ?? null]),
  ) as Record<string, string | number | boolean | null>;

  return {
    requestedTool: requestedTool(params.input),
    resolvedTool: params.resolvedTool,
    resultCount: params.resultCount,
    citationCount: params.citationCount,
    emptyReason: params.emptyReason ?? null,
    archivePolicy: params.archivePolicy,
    filters,
    answerMode: "DETERMINISTIC",
    model: null,
  };
}

function composedDiagnostics(
  base: AiAssistantDiagnostics,
  composition: AiAssistantCompositionResult,
): AiAssistantDiagnostics {
  return {
    ...base,
    answerMode: composition.answerMode,
    model: composition.model,
  };
}

async function createAssistantUsageEvent(
  prisma: PrismaClient,
  params: {
    access: AccessContext;
    actor: ActivityActor;
    message: string;
    answer: string;
    classification: DataClassification;
    sourceTypes: string[];
    sourceLabels: string[];
    quoteId?: string | null;
    customerId?: string | null;
    serviceType?: ServiceCategory | null;
    creditsConsumed?: number;
    riskNote?: string;
    confidenceLevel?: string;
    confidenceLabel?: string;
    insightReasons?: string[];
    retrievalAuditEventId?: string | null;
    model?: string | null;
    telemetry?: AiUsageTelemetry | null;
    eventType?: AiUsageEventType;
    purpose?: AiPurpose;
  },
) {
  return createAiUsageEvent(prisma, {
    tenantId: params.access.tenantId,
    quoteId: params.quoteId ?? null,
    customerId: params.customerId ?? null,
    actor: params.actor,
    eventType: params.eventType ?? "BUSINESS_INSIGHT",
    purpose: params.purpose ?? "BUSINESS_INSIGHT",
    classification: params.classification,
    promptText: params.message,
    requestId: params.access.requestId,
    serviceType: params.serviceType ?? null,
    creditsConsumed: params.creditsConsumed ?? 1,
    model: params.model ?? null,
    telemetry: params.telemetry ?? null,
    sensitiveValues: [params.message],
    retrievalAuditEventId: params.retrievalAuditEventId ?? null,
    trace: {
      insightSummary: params.answer,
      insightReasons: [
        "assistant tool registry execution",
        `toolClassification=${params.classification}`,
        ...(params.insightReasons ?? []),
      ],
      insightSourceLabels: params.sourceLabels,
      sourceTypes: params.sourceTypes,
      confidenceLevel: params.confidenceLevel ?? "high",
      confidenceLabel: params.confidenceLabel ?? "Deterministic approved tool",
      riskNote: params.riskNote ?? "Tenant-scoped assistant response generated without exposing raw prompts.",
    },
  });
}

async function runNonDataAssistantResponse(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "ASSISTANT_HELP" | "OUT_OF_SCOPE",
): Promise<AiAssistantRunResult> {
  const isOutOfScope = tool === "OUT_OF_SCOPE";
  const answer = isOutOfScope
    ? "I can only help with work inside QuoteFly—customers, quotes, products, follow-ups, pipeline, profitability, and workspace navigation. Try asking, “Which customers need follow-up?” or “Draft a quote for a roof repair.”"
    : "I can find customers, draft quotes and products, check follow-ups, summarize pipeline revenue, rank job profitability when your role allows it, and move you around QuoteFly. Tell me what you’re trying to get done.";
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C1_BUSINESS_INTERNAL",
    sourceTypes: ["QuoteFlyAssistant"],
    sourceLabels: [isOutOfScope ? "QuoteFly scope guard" : "Kody capability guide"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic QuoteFly scope policy",
    insightReasons: [isOutOfScope ? "request rejected by deterministic scope guard" : "capability help handled without retrieval"],
    riskNote: isOutOfScope
      ? "No model call or workspace retrieval was performed for the out-of-scope request."
      : "Capability help was generated without a model call or workspace retrieval.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C1_BUSINESS_INTERNAL",
      answer,
      results: [],
      citations: [],
      actions: [],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: 0,
        citationCount: 0,
        emptyReason: isOutOfScope
          ? "The request is outside Kody's QuoteFly-only scope."
          : "Capability help does not retrieve workspace records.",
        archivePolicy: isOutOfScope
          ? "Out-of-scope requests do not retrieve workspace records or call the language model."
          : "Capability help does not retrieve workspace records.",
        filters: {
          scopeDecision: tool,
          modelCalled: false,
          workspaceRowsRetrieved: false,
        },
      }),
    },
  };
}

async function runCustomerSearch(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    const answer = "Customer lookup requires permission to view customer contact data.";
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Customer"],
      sourceLabels: ["Customer lookup denied"],
      creditsConsumed: 0,
      riskNote: "Denied before customer PII retrieval because the actor lacks viewCustomerPii.",
    });

    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "SEARCH_CUSTOMERS",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: "Ask an admin for customer access", requiresConfirmation: true, payload: { capability: "viewCustomerPii" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "SEARCH_CUSTOMERS",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Customer lookup denied before retrieval because the role lacks customer PII access.",
          archivePolicy: "No customer rows are retrieved when customer PII access is denied.",
          filters: {
            includeArchivedRequested: Boolean(params.context?.includeArchived),
            includeArchivedEffective: false,
            limit: clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT),
          },
        }),
      },
    };
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const scopedCustomerId = params.context?.customerId?.trim();
  const search = cleanSearchQuery(params.message, params.context?.search);
  const phoneDigits = normalizePhoneSearchDigits(search);
  const tokens = searchableTokens(search);
  const filters: Prisma.CustomerWhereInput[] = [];
  if (search.length >= 2) {
    filters.push(
      { fullName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    );
  }
  for (const token of tokens) {
    filters.push(
      { fullName: { contains: token, mode: "insensitive" } },
      { email: { contains: token, mode: "insensitive" } },
    );
  }
  if (phoneDigits && phoneDigits.length >= 3) {
    filters.push({ phoneDigits: { contains: phoneDigits } });
  }

  const customers = await prisma.customer.findMany({
    where: {
      ...tenantActiveCustomerScope(params.access.tenantId),
      ...assignedCustomerScope(params.access),
      ...(scopedCustomerId ? { id: scopedCustomerId } : filters.length ? { OR: filters } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      followUpStatus: true,
      updatedAt: true,
      _count: {
        select: {
          quotes: {
            where: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) },
          },
        },
      },
      quotes: {
        where: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          title: true,
          status: true,
          totalAmount: true,
          updatedAt: true,
        },
      },
    },
  });

  const answer = customers.length
    ? `Found ${customers.length} active customer${customers.length === 1 ? "" : "s"} matching "${search || "recent customers"}".`
    : `I did not find active customers matching "${search}".`;
  const includeArchivedRequested = Boolean(params.context?.includeArchived);
  const results = customers.map((customer) => {
    const latestQuote = customer.quotes[0] ?? null;
    return {
      customerId: customer.id,
      fullName: customer.fullName,
      email: customer.email ?? null,
      phone: customer.phone,
      followUpStatus: customer.followUpStatus,
      quoteCount: customer._count.quotes,
      latestQuoteTitle: latestQuote?.title ?? null,
      latestQuoteStatus: latestQuote?.status ?? null,
      latestQuoteTotalAmount: currency(latestQuote?.totalAmount) ?? null,
      latestQuoteUpdatedAtUtc: latestQuote?.updatedAt.toISOString() ?? null,
    };
  });
  const citations: AiAssistantCitation[] = [{ key: "A1", label: "Active tenant customer lookup", sourceType: "Customer", classification: "C2_CUSTOMER_CONFIDENTIAL" }];
  const actions = customers.map((customer) => ({
    type: "OPEN_CUSTOMER" as const,
    label: `Open ${customer.fullName}`,
    requiresConfirmation: false,
    payload: { customerId: customer.id },
  }));
  const fieldsExcluded = [
    ...defaultExcludedFields(false),
    "archived customers",
    "deleted customers",
    ...(includeArchivedRequested ? ["includeArchived ignored for customer lookup"] : []),
  ];
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "SEARCH_CUSTOMERS",
    resultCount: customers.length,
    citationCount: citations.length,
    emptyReason: customers.length ? null : "No active customer rows matched tenant scope and search filters.",
    archivePolicy: "Customer lookup searches active customers only; archived/deleted customers are excluded.",
    filters: {
      currentPage: params.context?.currentPage,
      searchProvided: Boolean(search),
      searchTokenCount: tokens.length,
      phoneSearchUsed: Boolean(phoneDigits && phoneDigits.length >= 3),
      scopedCustomer: Boolean(scopedCustomerId),
      limit,
      includeArchivedRequested,
      includeArchivedEffective: false,
    },
  });
  const composition = await composeAssistantAnswer({
    userMessage: params.message,
    tool: "SEARCH_CUSTOMERS",
    deterministicAnswer: answer,
    maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
    results,
    citations,
    actions,
    fieldsExcluded,
    diagnostics: baseDiagnostics,
    sensitiveValues: [params.actor.actorEmail, params.actor.actorName],
    conversation: params.conversation,
  });
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer: composition.answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: ["Active tenant customer lookup"],
    customerId: customers[0]?.id ?? null,
    model: composition.model,
    telemetry: composition.telemetry,
    confidenceLevel: composition.confidenceLevel,
    confidenceLabel: composition.confidenceLabel,
    insightReasons: composition.insightReasons,
    riskNote: composition.riskNote,
  });

  return {
    consumedCredits: 1,
    consumedSpendUsd: composition.telemetry?.estimatedCostUsd ?? 0,
    assistant: {
      tool: "SEARCH_CUSTOMERS",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer: composition.answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: composedDiagnostics(baseDiagnostics, composition),
    },
  };
}

function workspacePageLabel(page: AiWorkspaceTarget) {
  if (page === "follow-up") return "Follow-up";
  if (page === "build") return "New quote";
  return `${page.charAt(0).toUpperCase()}${page.slice(1)}`;
}

type ProductDraft = Readonly<{
  name: string;
  description: string;
  category: "LABOR" | "MATERIAL" | "FEE" | "SERVICE";
  unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
  defaultQuantity: number;
  unitCost: number | null;
  unitPrice: number | null;
}>;

function parsedMoney(message: string, patterns: readonly RegExp[]) {
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replaceAll(",", ""));
    if (Number.isFinite(value) && value >= 0 && value <= 1_000_000) return value;
  }
  return null;
}

function parseProductDraft(message: string): ProductDraft {
  const quotedName = message.match(/\b(?:as|called|named)\s+["']([^"']{2,120})["']/i)?.[1];
  const productName = message.match(
    /\b(?:add|create|make|save|set\s+up)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:product(?:\s*\/\s*service)?|service|catalog\s+item|line[-\s]*item)\s+(?:as\s+|called\s+|named\s+)?([a-z0-9][a-z0-9 /&+_-]{1,80}?)(?=\s+(?:for|with|where|that|cost|priced|at|to\s+the\s+catalog)\b|[,.;]|$)/i,
  )?.[1];
  const name = (quotedName ?? productName ?? "New product or service").trim().replace(/\s+/g, " ").slice(0, 120);
  const normalized = `${name} ${message}`.toLowerCase();
  const category: ProductDraft["category"] = /\blabor\b/.test(normalized)
    ? "LABOR"
    : /\bmaterial/.test(normalized)
      ? "MATERIAL"
      : /\bfee\b|\bpermit\b|\bdisposal\b/.test(normalized)
        ? "FEE"
        : "SERVICE";
  const unitType: ProductDraft["unitType"] = /\bper\s+(?:labor\s+)?hour\b|\bhourly\b|\blabor\s+hours?\b/.test(normalized)
    ? "HOUR"
    : /\bper\s+(?:square|sq)\s*(?:foot|feet|ft)\b|\bsq\s*ft\b|\bsqft\b/.test(normalized)
      ? "SQ_FT"
      : /\bper\s+(?:item|unit|each)\b|\beach\b/.test(normalized)
        ? "EACH"
        : "FLAT";
  const unitCost = parsedMoney(message, [
    /\b(?:the\s+)?cost\s+internally\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\binternal(?:\s+unit)?\s+cost\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bmy\s+(?:unit\s+)?cost\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const unitPrice = parsedMoney(message, [
    /\bcustomer(?:\s+unit)?\s+price\s+(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:charge|sell)(?:d|ing)?(?:\s+(?:the\s+)?customer)?\s+(?:is|at|of|for)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\bprice(?:d)?\s+(?:to\s+the\s+customer\s+)?(?:is|at|of)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const description = unitType === "HOUR"
    ? `Hourly ${category === "LABOR" ? "labor" : "service"} for ${name}. Confirm included work, minimums, and exclusions before using on quotes.`
    : unitType === "SQ_FT"
      ? `Per-square-foot ${category.toLowerCase()} pricing for ${name}. Confirm materials, preparation, and exclusions before using on quotes.`
      : unitType === "EACH"
        ? `Per-item pricing for ${name}. Confirm the included labor, materials, and exclusions before using on quotes.`
        : `Flat-rate pricing for ${name}. Confirm the included scope, materials, and exclusions before using on quotes.`;

  return {
    name,
    description,
    category,
    unitType,
    defaultQuantity: 1,
    unitCost,
    unitPrice,
  };
}

async function runProductDraftPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "manageCatalog")) {
    const answer = "Only a workspace owner or admin can add or change products. I can still help you build an assigned quote with products they have approved.";
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C1_BUSINESS_INTERNAL",
      sourceTypes: ["WorkPreset"],
      sourceLabels: ["Catalog management denied"],
      creditsConsumed: 0,
      telemetry: ZERO_AI_TELEMETRY,
      riskNote: "Denied before creating a product draft because members cannot manage the tenant catalog.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "DRAFT_PRODUCT",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C1_BUSINESS_INTERNAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: "Ask an admin to add this product", requiresConfirmation: true, payload: { capability: "manageCatalog" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "DRAFT_PRODUCT",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Catalog drafting denied for member role.",
          archivePolicy: "No catalog rows were read or written.",
          filters: { currentPage: params.context?.currentPage },
        }),
      },
    };
  }
  const draft = parseProductDraft(params.message);
  const canViewInternalCosts = hasCapability(params.access, "viewInternalCosts");
  const visibleUnitCost = canViewInternalCosts ? draft.unitCost : null;
  const serviceType = params.context?.serviceType ?? null;
  const missing = [
    draft.name === "New product or service" ? "name" : null,
    draft.unitPrice === null ? "customer price" : null,
  ].filter((value): value is string => Boolean(value));
  const answer = missing.length
    ? `I prepared a product draft. Add the ${missing.join(" and ")} in the review form before saving it to your catalog.`
    : `I prepared ${draft.name} as a ${draft.unitType === "HOUR" ? "per-hour" : draft.unitType === "SQ_FT" ? "per-square-foot" : draft.unitType === "EACH" ? "per-item" : "flat-rate"} catalog item. Review the pricing and description before saving.`;
  const maxClassification: DataClassification = draft.unitCost !== null
    ? "C3_FINANCIAL_CONFIDENTIAL"
    : "C2_CUSTOMER_CONFIDENTIAL";
  const result = {
    name: draft.name,
    serviceType,
    category: draft.category,
    unitType: draft.unitType,
    defaultQuantity: draft.defaultQuantity,
    unitCost: visibleUnitCost,
    unitPrice: draft.unitPrice,
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: maxClassification,
    sourceTypes: ["WorkPreset"],
    sourceLabels: ["User-supplied product draft"],
    serviceType,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: missing.length ? "medium" : "high",
    confidenceLabel: "Deterministic product draft parser",
    riskNote: "No catalog row was created. The user must review and explicitly save the tenant-scoped product form.",
  });
  const fieldsExcluded = [
    ...defaultExcludedFields(canViewInternalCosts),
    ...(!canViewInternalCosts && draft.unitCost !== null ? ["user-supplied internal cost"] : []),
  ];

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "DRAFT_PRODUCT",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification,
      answer,
      results: [result],
      citations: [{
        key: "A1",
        label: "Product details supplied in this request",
        sourceType: "WorkPreset",
        classification: maxClassification,
      }],
      actions: [{
        type: "OPEN_PRODUCT_DRAFT",
        label: "Review product draft",
        requiresConfirmation: true,
        payload: {
          ...draft,
          unitCost: visibleUnitCost,
          serviceType,
        },
      }],
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "DRAFT_PRODUCT",
        resultCount: 1,
        citationCount: 1,
        emptyReason: null,
        archivePolicy: "Product drafting does not read archived, deleted, or cross-tenant catalog rows.",
        filters: {
          currentPage: params.context?.currentPage,
          serviceType,
          internalCostVisible: canViewInternalCosts,
          missingFields: missing.join(",") || null,
        },
      }),
    },
  };
}

async function runCustomerDraftPreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const combinedPrompt = [
    ...(params.conversation ?? [])
      .filter((turn) => turn.resolvedTool === "DRAFT_CUSTOMER")
      .map((turn) => turn.message),
    params.message,
  ].slice(-3).join("\n");
  const draft = parseCustomerDraft(combinedPrompt);
  const missingFields = [
    ...(!draft.fullName ? ["full name"] : []),
    ...(!draft.phone ? ["10-digit phone"] : []),
  ];
  const ready = missingFields.length === 0;
  const answer = ready
    ? `I prepared a customer draft for ${draft.fullName}. Open it to review the contact details; nothing is saved until you press Save customer.`
    : `I can add the customer. I still need ${missingFields.join(" and ")}. Reply with those details and I’ll prepare the review form.`;
  const result = {
    fullName: draft.fullName,
    phone: draft.phone,
    email: draft.email,
    notes: draft.notes,
    missingFields: missingFields.join(", ") || null,
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer"],
    sourceLabels: ["Customer details supplied in this request"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: ready ? "high" : "medium",
    confidenceLabel: "Deterministic customer draft parser",
    riskNote: "No customer row was created. The existing duplicate-safe customer form remains authoritative.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "DRAFT_CUSTOMER",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: [result],
      citations: [{
        key: "A1",
        label: "Customer details supplied in this request",
        sourceType: "Customer",
        classification: "C2_CUSTOMER_CONFIDENTIAL",
      }],
      actions: ready ? [{
        type: "OPEN_CUSTOMER_DRAFT",
        label: "Review customer draft",
        requiresConfirmation: true,
        payload: draft,
      }] : [],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "DRAFT_CUSTOMER",
        resultCount: 1,
        citationCount: 1,
        emptyReason: ready ? null : `Missing required fields: ${missingFields.join(", ")}.`,
        archivePolicy: "Customer drafting does not read or mutate customer rows.",
        filters: {
          currentPage: params.context?.currentPage,
          readyForReview: ready,
          missingFields: missingFields.join(", ") || null,
        },
      }),
    },
  };
}

async function runPrepareQuoteSend(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewTenantQuotes") || !hasCapability(params.access, "viewCustomerPii")) {
    const answer = "Preparing a quote to send requires access to the assigned quote and customer contact details.";
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Quote", "Customer"],
      sourceLabels: ["Quote send preparation denied"],
      creditsConsumed: 0,
      telemetry: ZERO_AI_TELEMETRY,
      riskNote: "Denied before quote retrieval because the actor lacks quote or customer access.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "PREPARE_QUOTE_SEND",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{
          type: "REQUEST_ADMIN_ACCESS",
          label: "Ask an admin for quote access",
          requiresConfirmation: true,
          payload: { capabilities: ["viewTenantQuotes", "viewCustomerPii"] },
        }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "PREPARE_QUOTE_SEND",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Quote send preparation denied before retrieval.",
          archivePolicy: "No quote rows are retrieved when access is denied.",
          filters: { currentPage: params.context?.currentPage },
        }),
      },
    };
  }

  const combinedPrompt = [
    ...(params.conversation ?? [])
      .filter((turn) => turn.resolvedTool === "PREPARE_QUOTE_SEND")
      .map((turn) => turn.message),
    params.message,
  ].slice(-2).join(" ");
  const searchTokens = quoteSendSearchTokens(combinedPrompt);
  const requestedChannel = /\b(?:text|sms|message)\b/i.test(params.message)
    ? "sms"
    : /\b(?:email|mail)\b/i.test(params.message)
      ? "email"
      : null;
  const quoteWhere: Prisma.QuoteWhereInput = {
    ...tenantActiveQuoteScope(params.access.tenantId),
    ...assignedQuoteScope(params.access),
    customer: {
      is: {
        ...tenantActiveCustomerScope(params.access.tenantId),
        ...assignedCustomerScope(params.access),
      },
    },
    status: { in: ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER"] },
    ...(params.context?.quoteId
      ? { id: params.context.quoteId }
      : searchTokens.length
        ? {
            AND: searchTokens.map((token) => ({
              OR: [
                { title: { contains: token, mode: "insensitive" } },
                { customer: { fullName: { contains: token, mode: "insensitive" } } },
                { customer: { email: { contains: token, mode: "insensitive" } } },
              ],
            })),
          }
        : {}),
  };
  const candidates = await prisma.quote.findMany({
    where: quoteWhere,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: params.context?.quoteId ? 1 : 5,
    select: {
      id: true,
      title: true,
      status: true,
      totalAmount: true,
      updatedAt: true,
      customerId: true,
      customer: { select: { fullName: true, email: true, phone: true } },
    },
  });
  const selectedCandidates = /\blatest\b/i.test(params.message) && candidates.length ? candidates.slice(0, 1) : candidates;
  const results = selectedCandidates.map((quote) => ({
    quoteId: quote.id,
    quoteTitle: quote.title,
    quoteStatus: quote.status,
    quoteAmount: Number(quote.totalAmount),
    customerName: quote.customer.fullName,
    recipient: requestedChannel === "sms"
      ? formatUsPhone(quote.customer.phone)
      : requestedChannel === "email"
        ? quote.customer.email
        : quote.customer.email ?? formatUsPhone(quote.customer.phone),
    updatedAtUtc: quote.updatedAt.toISOString(),
  }));
  const actions: AiAssistantAction[] = selectedCandidates.flatMap((quote) => {
    const channel = requestedChannel ?? (quote.customer.email ? "email" : normalizeUsPhoneDigits(quote.customer.phone) ? "sms" : "copy");
    const destination = channel === "email"
      ? quote.customer.email
      : channel === "sms"
        ? formatUsPhone(quote.customer.phone)
        : null;
    if ((channel === "email" || channel === "sms") && !destination) return [];
    return [{
      type: "OPEN_QUOTE_SEND",
      label: `${quote.status === "SENT_TO_CUSTOMER" ? "Review resend" : "Review send"} · ${quote.customer.fullName}`,
      requiresConfirmation: true,
      payload: {
        quoteId: quote.id,
        quoteTitle: quote.title,
        quoteStatus: quote.status,
        customerName: quote.customer.fullName,
        channel,
        destination,
        totalAmount: Number(quote.totalAmount),
      },
    }];
  });
  const answer = !candidates.length
    ? params.context?.quoteId
      ? "I couldn’t find that active assigned quote. It may have changed, been archived, or no longer be available to you."
      : "I couldn’t match an active assigned quote. Tell me the customer or quote title, or open the quote and ask me again."
    : actions.length === 0
      ? `I found ${selectedCandidates.length} matching quote${selectedCandidates.length === 1 ? "" : "s"}, but the customer is missing the requested contact method. Update the customer first, then try again.`
      : selectedCandidates.length === 1
        ? `I found ${selectedCandidates[0].title} for ${selectedCandidates[0].customer.fullName}. Review the recipient and message before opening the ${actions[0]?.payload.channel === "sms" ? "text" : actions[0]?.payload.channel === "copy" ? "copy" : "email"} handoff. I will not mark it sent automatically.`
        : `I found ${selectedCandidates.length} matching quotes. Choose the correct customer and quote to open the send review. Nothing will be marked sent automatically.`;
  const citations: AiAssistantCitation[] = candidates.length ? [{
    key: "A1",
    label: "Active assigned tenant quotes and current customer contact details",
    sourceType: "Quote + Customer",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }] : [];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Quote", "Customer"],
    sourceLabels: citations.map((citation) => citation.label),
    quoteId: selectedCandidates.length === 1 ? selectedCandidates[0]?.id ?? null : null,
    customerId: selectedCandidates.length === 1 ? selectedCandidates[0]?.customerId ?? null : null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: selectedCandidates.length === 1 ? "high" : candidates.length ? "medium" : "low",
    confidenceLabel: "Deterministic quote send preparation",
    riskNote: "Kody only opens the existing two-phase send review. It does not contact the customer or mark the quote sent.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PREPARE_QUOTE_SEND",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PREPARE_QUOTE_SEND",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: candidates.length ? null : "No active assigned quote matched the trusted context or bounded search terms.",
        archivePolicy: "Only active, assigned tenant quotes in draft, ready, or sent status are eligible.",
        filters: {
          currentPage: params.context?.currentPage,
          scopedQuote: Boolean(params.context?.quoteId),
          searchTokenCount: searchTokens.length,
          requestedChannel,
          candidateCount: candidates.length,
        },
      }),
    },
  };
}

async function runWorkspaceNavigation(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const target = navigationTarget(params.message) ?? (
    params.context?.currentPage === "customers" ||
    params.context?.currentPage === "quotes" ||
    params.context?.currentPage === "products" ||
    params.context?.currentPage === "analytics"
      ? params.context.currentPage
      : "customers"
  );
  const catalogRestricted = target === "products" && !hasCapability(params.access, "manageCatalog");
  const authorizedTarget = catalogRestricted ? "quotes" : target;
  const label = workspacePageLabel(authorizedTarget);
  const answer = catalogRestricted
    ? "The product catalog is managed by workspace owners and admins. I can take you to your assigned quotes, where you can use products they have approved."
    : `I can take you to ${label}. Your Kody conversation will stay open while you move.`;
  const action: AiAssistantAction = {
    type: "OPEN_WORKSPACE_PAGE",
    label: `Open ${label}`,
    requiresConfirmation: false,
    payload: { page: authorizedTarget },
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C1_BUSINESS_INTERNAL",
    sourceTypes: [],
    sourceLabels: [catalogRestricted ? "Catalog navigation restricted by role" : "Approved workspace navigation"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic navigation",
    riskNote: catalogRestricted
      ? "Catalog management navigation was replaced with assigned quote navigation for a member role."
      : "No workspace records or external AI provider were used for navigation.",
  });
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "NAVIGATE_WORKSPACE",
    resultCount: 0,
    citationCount: 0,
    archivePolicy: "Navigation does not retrieve customer or quote rows.",
    filters: { targetPage: authorizedTarget, requestedPage: target, catalogRestricted },
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "NAVIGATE_WORKSPACE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C1_BUSINESS_INTERNAL",
      answer,
      results: [],
      citations: [],
      actions: [action],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: baseDiagnostics,
    },
  };
}

async function createDeniedCustomerToolResult(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "FOLLOW_UP_QUEUE" | "CUSTOMERS_WITHOUT_QUOTES",
): Promise<AiAssistantRunResult> {
  const answer = "This request requires permission to view customer and quote details.";
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [`${tool} denied`],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    riskNote: "Denied before customer data retrieval because the actor lacks viewCustomerPii.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results: [],
      citations: [],
      actions: [{
        type: "REQUEST_ADMIN_ACCESS",
        label: "Ask an admin for customer access",
        requiresConfirmation: true,
        payload: { capability: "viewCustomerPii" },
      }],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: tool,
        resultCount: 0,
        citationCount: 0,
        emptyReason: "Customer retrieval denied before query execution.",
        archivePolicy: "No customer or quote rows are retrieved when customer PII access is denied.",
        filters: { includeArchivedEffective: false },
      }),
    },
  };
}

async function runCustomersWithoutQuotes(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    return createDeniedCustomerToolResult(prisma, params, generatedAtUtc, "CUSTOMERS_WITHOUT_QUOTES");
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const where: Prisma.CustomerWhereInput = {
    ...tenantActiveCustomerScope(params.access.tenantId),
    ...assignedCustomerScope(params.access),
    quotes: { none: { ...tenantActiveQuoteScope(params.access.tenantId), ...assignedQuoteScope(params.access) } },
  };
  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        fullName: true,
        followUpStatus: true,
        createdAt: true,
      },
    }),
  ]);
  const results = customers.map((customer) => ({
    customerId: customer.id,
    fullName: customer.fullName,
    followUpStatus: customer.followUpStatus,
    activeQuoteCount: 0,
    customerSinceUtc: customer.createdAt.toISOString(),
  }));
  const answer = total
    ? `${total} active customer${total === 1 ? " has" : "s have"} no active quote. Showing ${customers.length}; open a customer to start one.`
    : "Every active customer currently has at least one active quote.";
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: "Active tenant customers without active quotes",
    sourceType: "Customer + Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const actions: AiAssistantAction[] = customers.map((customer) => ({
    type: "OPEN_CUSTOMER",
    label: `Open ${customer.fullName}`,
    requiresConfirmation: false,
    payload: { customerId: customer.id },
  }));
  if (!customers.length) {
    actions.push({
      type: "OPEN_WORKSPACE_PAGE",
      label: "Open customers",
      requiresConfirmation: false,
      payload: { page: "customers" },
    });
  }
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [citations[0].label],
    customerId: customers[0]?.id ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: ["active quote relation count equals zero"],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "CUSTOMERS_WITHOUT_QUOTES",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "archived customers", "archived quotes"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "CUSTOMERS_WITHOUT_QUOTES",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: total ? null : "No active tenant customers were missing an active quote.",
        archivePolicy: "Only active customers and active quotes are considered.",
        filters: { total, limit, includeArchivedEffective: false },
      }),
    },
  };
}

async function runFollowUpQueue(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "viewCustomerPii")) {
    return createDeniedCustomerToolResult(prisma, params, generatedAtUtc, "FOLLOW_UP_QUEUE");
  }

  const limit = clampLimit(params.context?.limit, MAX_CUSTOMER_LIMIT, DEFAULT_CUSTOMER_LIMIT);
  const quoteOnly = /\b(?:quotes?|estimates?|proposals?)\b/i.test(params.message) &&
    /\b(?:not|never|haven't|havent|hasn't|hasnt|without|need|needs|due|pending)\b/i.test(params.message);
  const tenantId = params.access.tenantId;
  const activeCustomer = tenantActiveCustomerScope(tenantId);
  const activeQuote = tenantActiveQuoteScope(tenantId);
  const memberCustomer = assignedCustomerScope(params.access);
  const memberQuote = assignedQuoteScope(params.access);

  const [sentQuotes, afterSaleQuotes] = await Promise.all([
    prisma.quote.findMany({
      where: {
        ...activeQuote,
        ...memberQuote,
        status: "SENT_TO_CUSTOMER",
        customer: { is: { ...activeCustomer, ...memberCustomer, followUpStatus: "NEEDS_FOLLOW_UP" } },
      },
      orderBy: [{ sentAt: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        title: true,
        totalAmount: true,
        sentAt: true,
        updatedAt: true,
        customer: { select: { id: true, fullName: true, followUpStatus: true } },
      },
    }),
    quoteOnly
      ? Promise.resolve([])
      : prisma.quote.findMany({
          where: {
            ...activeQuote,
            ...memberQuote,
            status: "ACCEPTED",
            afterSaleFollowUpStatus: "DUE",
            afterSaleFollowUpDueAtUtc: { lte: generatedAtUtc },
            customer: { is: { ...activeCustomer, ...memberCustomer } },
          },
          orderBy: [{ afterSaleFollowUpDueAtUtc: "asc" }, { id: "asc" }],
          take: limit,
          select: {
            id: true,
            title: true,
            totalAmount: true,
            afterSaleFollowUpDueAtUtc: true,
            customer: { select: { id: true, fullName: true } },
          },
        }),
  ]);
  const remaining = Math.max(limit - sentQuotes.length - afterSaleQuotes.length, 0);
  const otherCustomers = quoteOnly || remaining === 0
    ? []
    : await prisma.customer.findMany({
        where: {
          ...activeCustomer,
          ...memberCustomer,
          followUpStatus: "NEEDS_FOLLOW_UP",
          quotes: {
            none: { ...activeQuote, ...memberQuote, status: { in: ["SENT_TO_CUSTOMER", "ACCEPTED"] } },
          },
        },
        orderBy: [{ followUpUpdatedAtUtc: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
        take: remaining,
        select: {
          id: true,
          fullName: true,
          followUpStatus: true,
          updatedAt: true,
          quotes: {
            where: { ...activeQuote, ...memberQuote },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { id: true, title: true, status: true, totalAmount: true },
          },
        },
      });

  const sentResults = sentQuotes.map((quote) => ({
      followUpType: "SENT_QUOTE",
      customerId: quote.customer.id,
      fullName: quote.customer.fullName,
      quoteId: quote.id,
      quoteTitle: quote.title,
      quoteStatus: "SENT_TO_CUSTOMER",
      quoteAmount: currency(quote.totalAmount),
      dueSinceUtc: (quote.sentAt ?? quote.updatedAt).toISOString(),
    }));
  const otherSalesResults = otherCustomers.map((customer) => {
      const quote = customer.quotes[0] ?? null;
      return {
        followUpType: quote ? "OPEN_QUOTE" : "NEW_CUSTOMER",
        customerId: customer.id,
        fullName: customer.fullName,
        quoteId: quote?.id ?? null,
        quoteTitle: quote?.title ?? null,
        quoteStatus: quote?.status ?? null,
        quoteAmount: currency(quote?.totalAmount),
        dueSinceUtc: customer.updatedAt.toISOString(),
      };
    });
  const afterSaleResults = afterSaleQuotes.map((quote) => ({
    followUpType: "AFTER_SALE",
    customerId: quote.customer.id,
    fullName: quote.customer.fullName,
    quoteId: quote.id,
    quoteTitle: quote.title,
    quoteStatus: "ACCEPTED",
    quoteAmount: currency(quote.totalAmount),
    dueSinceUtc: quote.afterSaleFollowUpDueAtUtc?.toISOString() ?? null,
  }));
  const results = quoteOnly
    ? sentResults.slice(0, limit)
    : [...sentResults, ...afterSaleResults, ...otherSalesResults].slice(0, limit);
  const displayedAfterSaleCount = results.filter((result) => result.followUpType === "AFTER_SALE").length;
  const displayedSalesCount = results.length - displayedAfterSaleCount;
  const answer = quoteOnly
    ? sentQuotes.length
      ? `Showing ${sentQuotes.length} sent quote${sentQuotes.length === 1 ? " that still needs" : "s that still need"} a sales follow-up. Oldest is shown first.`
      : "No active sent quotes are currently marked as needing a sales follow-up."
    : results.length
      ? `Showing ${displayedSalesCount} open sales follow-up${displayedSalesCount === 1 ? "" : "s"} and ${displayedAfterSaleCount} completed-job check-in${displayedAfterSaleCount === 1 ? "" : "s"} due now. Sales follow-ups are status-based and oldest-first because they do not yet have a separate due date.`
      : "No active sales follow-ups or due completed-job check-ins were found.";
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: quoteOnly ? "Active sent quotes awaiting follow-up" : "Tenant follow-up queue",
    sourceType: "Customer + Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const actions: AiAssistantAction[] = results.map((result) => ({
    type: "OPEN_CUSTOMER",
    label: `Open ${result.fullName}`,
    requiresConfirmation: false,
    payload: { customerId: result.customerId },
  }));
  actions.unshift({
    type: "OPEN_WORKSPACE_PAGE",
    label: "Open follow-up",
    requiresConfirmation: false,
    payload: { page: "follow-up" },
  });
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Customer", "Quote"],
    sourceLabels: [citations[0].label],
    quoteId: results[0]?.quoteId ?? null,
    customerId: results[0]?.customerId ?? null,
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: [quoteOnly ? "sent quote sales follow-up" : "sales and after-sale follow-up queue"],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "FOLLOW_UP_QUEUE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "archived customers", "archived quotes"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "FOLLOW_UP_QUEUE",
        resultCount: results.length,
        citationCount: citations.length,
        emptyReason: results.length ? null : "No active follow-up rows matched the requested queue.",
        archivePolicy: "Only active customers and active quotes are considered.",
        filters: {
          quoteOnly,
          salesFollowUpCount: displayedSalesCount,
          afterSaleDueCount: displayedAfterSaleCount,
          dueAtOrBeforeUtc: generatedAtUtc.toISOString(),
          limit,
        },
      }),
    },
  };
}

function scenarioWinRate(message: string) {
  const match = message.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\b/i);
  const parsed = match ? Number(match[1]) : 30;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : 30;
}

async function runPipelineScenario(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  const tenantId = params.access.tenantId;
  const winRatePercent = scenarioWinRate(params.message);
  const referenceFromUtc = new Date(generatedAtUtc.getTime() - (90 * 24 * 60 * 60 * 1_000));
  const serviceFilter = params.context?.serviceType ? { serviceType: params.context.serviceType } : {};
  const [open, accepted] = await Promise.all([
    prisma.quote.aggregate({
      where: {
        ...tenantActiveQuoteScope(tenantId),
        ...assignedQuoteScope(params.access),
        status: { in: [...OPEN_PIPELINE_STATUSES] },
        ...serviceFilter,
      },
      _count: { _all: true },
      _sum: { customerPriceSubtotal: true },
    }),
    prisma.quote.aggregate({
      where: {
        ...tenantActiveQuoteScope(tenantId),
        ...assignedQuoteScope(params.access),
        status: "ACCEPTED",
        closedAtUtc: { gte: referenceFromUtc, lte: generatedAtUtc },
        ...serviceFilter,
      },
      _count: { _all: true },
      _sum: { customerPriceSubtotal: true },
    }),
  ]);
  const openPipelineRevenue = roundCurrency(Number(open._sum.customerPriceSubtotal ?? 0));
  const acceptedRevenueLast90Days = roundCurrency(Number(accepted._sum.customerPriceSubtotal ?? 0));
  const scenarioRevenue = roundCurrency(openPipelineRevenue * (winRatePercent / 100));
  const revenueBoostPercent = acceptedRevenueLast90Days > 0
    ? Number(((scenarioRevenue / acceptedRevenueLast90Days) * 100).toFixed(1))
    : null;
  const projectedRevenue = roundCurrency(acceptedRevenueLast90Days + scenarioRevenue);
  const results = [{
    openQuoteCount: open._count._all,
    openPipelineRevenue,
    assumedWinRatePercent: winRatePercent,
    scenarioRevenue,
    acceptedQuoteCountLast90Days: accepted._count._all,
    acceptedRevenueLast90Days,
    revenueBoostPercent,
    projectedRevenueWithScenario: projectedRevenue,
  }];
  const answer = open._count._all
    ? acceptedRevenueLast90Days > 0
      ? `Your active open quote subtotal is ${money(openPipelineRevenue)} across ${open._count._all} quotes. Closing ${winRatePercent}% would add about ${money(scenarioRevenue)}—a ${revenueBoostPercent}% lift over the ${money(acceptedRevenueLast90Days)} accepted in the last 90 days, for about ${money(projectedRevenue)} combined.`
      : `Your active open quote subtotal is ${money(openPipelineRevenue)} across ${open._count._all} quotes. Closing ${winRatePercent}% would add about ${money(scenarioRevenue)}. There is no accepted revenue in the last 90 days, so a meaningful percentage lift cannot be calculated yet.`
    : "There are no active open quotes to model right now.";
  const citations: AiAssistantCitation[] = [{
    key: "A1",
    label: "Tenant quote revenue aggregates",
    sourceType: "Quote",
    classification: "C2_CUSTOMER_CONFIDENTIAL",
  }];
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C2_CUSTOMER_CONFIDENTIAL",
    sourceTypes: ["Quote"],
    sourceLabels: [citations[0].label],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    insightReasons: [
      `winRatePercent=${winRatePercent}`,
      "active open quote customerPriceSubtotal aggregate",
      "accepted quote 90-day closedAtUtc aggregate",
    ],
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "PIPELINE_SCENARIO",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer,
      results,
      citations,
      actions: [{
        type: "OPEN_ANALYTICS",
        label: "Open analytics",
        requiresConfirmation: false,
        payload: { winRatePercent, referenceFromUtc: referenceFromUtc.toISOString() },
      }],
      auditEventId: event.id,
      fieldsExcluded: defaultExcludedFields(false),
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "PIPELINE_SCENARIO",
        resultCount: 1,
        citationCount: citations.length,
        emptyReason: open._count._all ? null : "No active open quotes matched tenant scope.",
        archivePolicy: "Archived and deleted quotes are excluded from both aggregates.",
        filters: {
          openStatuses: OPEN_PIPELINE_STATUSES.join(","),
          serviceType: params.context?.serviceType,
          acceptedReferenceFromUtc: referenceFromUtc.toISOString(),
          acceptedReferenceToUtc: generatedAtUtc.toISOString(),
          winRatePercent,
        },
      }),
    },
  };
}

function businessToolForProfitPrompt(message: string): AiBusinessInsightTool {
  return /\b(item|items|product|products|material|materials|line[-\s]*items?)\b/i.test(message)
    ? "ITEM_PROFITABILITY"
    : "SERVICE_PROFITABILITY";
}

async function createDeniedFinancialAudit(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
) {
  const answer = "Profitability ranking uses internal costs and margins. Ask an owner or admin to run this, or use pipeline summary for revenue-only insights.";
  const governedPrompt = governAiPrompt(params.message, {
    knownSensitiveValues: [
      params.actor.actorEmail,
      params.actor.actorName,
    ].filter((value): value is string => Boolean(value?.trim())),
  });
  const retrievalAudit = await withTenantRlsContext(prisma, params.access.tenantId, (tx) => tx.aiRetrievalAuditEvent.create({
    data: {
      tenant: { connect: { id: params.access.tenantId } },
      ...(params.actor.actorUserId ? { actorUser: { connect: { id: params.actor.actorUserId } } } : {}),
      requestId: params.access.requestId.slice(0, 128),
      purpose: "BUSINESS_INSIGHT",
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
      sourceTypes: ["Quote", "QuoteLineItem"],
      sourceRefs: Prisma.JsonNull,
      resultCount: 0,
      queryHash: governedPrompt.sha256,
      policyVersion: AI_DATA_POLICY_VERSION,
      status: "DENIED",
      denialCode: "MISSING_FINANCIAL_CAPABILITY",
      retentionExpiresAtUtc: governedPrompt.retentionExpiresAtUtc,
    },
  }));
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C3_FINANCIAL_CONFIDENTIAL",
    sourceTypes: ["Quote", "QuoteLineItem"],
    sourceLabels: ["Profitability insight denied"],
    creditsConsumed: 0,
    retrievalAuditEventId: retrievalAudit.id,
    riskNote: "Denied before C3 financial aggregate retrieval because the actor lacks margin/cost capabilities.",
  });

  return {
    consumedCredits: 0,
    consumedSpendUsd: 0,
    assistant: {
      tool: "RANK_PROFITABLE_JOBS" as const,
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification,
      answer,
      results: [],
      citations: [{ key: "A1", label: "Profitability insight denied", sourceType: "Quote", classification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification }],
      actions: [{ type: "REQUEST_ADMIN_ACCESS" as const, label: "Ask an admin for profitability access", requiresConfirmation: true, payload: { capabilities: ["viewInternalCosts", "viewMargins"] } }],
      auditEventId: event.id,
      fieldsExcluded: [...defaultExcludedFields(false), "internal cost aggregates", "margin aggregates"],
      diagnostics: diagnostics({
        input: params,
        resolvedTool: "RANK_PROFITABLE_JOBS",
        resultCount: 0,
        citationCount: 1,
        emptyReason: "Profitability retrieval denied before C3 financial aggregate access.",
        archivePolicy: "No quote rows are retrieved when profitability access is denied.",
        filters: {
          currentPage: params.context?.currentPage,
          includeArchivedRequested: Boolean(params.context?.includeArchived),
          includeArchivedEffective: false,
        },
      }),
    },
  };
}

async function runBusinessInsightTool(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
  tool: "SUMMARIZE_PIPELINE" | "RANK_PROFITABLE_JOBS",
): Promise<AiAssistantRunResult> {
  const businessTool: AiBusinessInsightTool =
    tool === "SUMMARIZE_PIPELINE" ? "SALES_PIPELINE" : businessToolForProfitPrompt(params.message);
  const inferredRange = inferAssistantRelativeDateRange(params.message, generatedAtUtc);

  try {
    const insight = await generateAiBusinessInsight(prisma, {
      access: params.access,
      actor: params.actor,
      prompt: params.message,
      tool: businessTool,
      dateFrom: params.context?.dateFrom ?? inferredRange?.from ?? null,
      dateTo: params.context?.dateTo ?? inferredRange?.to ?? null,
      serviceType: params.context?.serviceType ?? null,
      limit: params.context?.limit,
      includeArchived: params.context?.includeArchived,
      now: generatedAtUtc,
      sensitiveValues: [params.message],
      conversation: params.conversation,
    });

    return {
      consumedCredits: 1,
      consumedSpendUsd: insight.telemetry?.estimatedCostUsd ?? 0,
      assistant: {
        tool,
        generatedAtUtc,
        policyVersion: insight.policyVersion,
        maxClassification: insight.maxClassification,
        answer: insight.answer,
        results: insight.rows.map((row) => ({ ...row })),
        citations: insight.citations,
        actions: [{
          type: "OPEN_ANALYTICS",
          label: tool === "SUMMARIZE_PIPELINE" ? "Open analytics" : "Review profitability",
          requiresConfirmation: false,
          payload: {
            insightTool: businessTool,
            dateFrom: insight.dateRange.from.toISOString(),
            dateTo: insight.dateRange.to.toISOString(),
            serviceType: insight.filters.serviceType,
          },
        }],
        auditEventId: insight.auditEventId,
        fieldsExcluded: insight.fieldsExcluded,
        diagnostics: {
          ...diagnostics({
            input: params,
            resolvedTool: tool,
            resultCount: insight.rows.length,
            citationCount: insight.citations.length,
            emptyReason: insight.rows.length ? null : "No active quote aggregates matched tenant scope and effective filters.",
            archivePolicy: insight.filters.includeArchived
              ? "Archived quote aggregates were included because the current role policy allowed it."
              : "Archived/deleted quote aggregates were excluded by the current role policy.",
            filters: {
              currentPage: params.context?.currentPage,
              businessInsightTool: businessTool,
              dateField: "Quote.createdAt",
              dateFrom: insight.dateRange.from.toISOString(),
              dateTo: insight.dateRange.to.toISOString(),
              serviceType: insight.filters.serviceType,
              limit: params.context?.limit ?? null,
              includeArchivedRequested: Boolean(params.context?.includeArchived),
              includeArchivedEffective: insight.filters.includeArchived,
            },
          }),
          answerMode: insight.answerMode,
          model: insight.model,
        },
      },
    };
  } catch (error) {
    if (error instanceof AiBusinessInsightForbiddenError && tool === "RANK_PROFITABLE_JOBS") {
      return createDeniedFinancialAudit(prisma, params, generatedAtUtc);
    }
    throw error;
  }
}

async function runDraftQuotePreview(
  prisma: PrismaClient,
  params: AiAssistantInput,
  generatedAtUtc: Date,
): Promise<AiAssistantRunResult> {
  if (!hasCapability(params.access, "useAiQuoteDrafting")) {
    const answer = "AI quote drafting is not enabled for this role.";
    const event = await createAssistantUsageEvent(prisma, {
      access: params.access,
      actor: params.actor,
      message: params.message,
      answer,
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      sourceTypes: ["Quote"],
      sourceLabels: ["Quote drafting denied"],
      creditsConsumed: 0,
      riskNote: "Denied before quote drafting preview because the actor lacks useAiQuoteDrafting.",
    });
    return {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      assistant: {
        tool: "DRAFT_QUOTE",
        generatedAtUtc,
        policyVersion: AI_DATA_POLICY_VERSION,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        answer,
        results: [],
        citations: [],
        actions: [{ type: "REQUEST_ADMIN_ACCESS", label: "Ask an admin for AI quote drafting", requiresConfirmation: true, payload: { capability: "useAiQuoteDrafting" } }],
        auditEventId: event.id,
        fieldsExcluded: defaultExcludedFields(false),
        diagnostics: diagnostics({
          input: params,
          resolvedTool: "DRAFT_QUOTE",
          resultCount: 0,
          citationCount: 0,
          emptyReason: "Quote drafting denied before prompt parsing because the role lacks AI quote drafting access.",
          archivePolicy: "No quote rows are retrieved when quote drafting access is denied.",
          filters: {
            currentPage: params.context?.currentPage,
            scopedCustomer: Boolean(params.context?.customerId),
            scopedQuote: Boolean(params.context?.quoteId),
            includeArchivedRequested: Boolean(params.context?.includeArchived),
            includeArchivedEffective: false,
          },
        }),
      },
    };
  }

  const selectedQuote = params.context?.quoteId
    ? await prisma.quote.findFirst({
        where: {
          id: params.context.quoteId,
          ...tenantActiveQuoteScope(params.access.tenantId),
          ...assignedQuoteScope(params.access),
        },
        select: {
          id: true,
          title: true,
          scopeText: true,
          serviceType: true,
          customerId: true,
          customer: {
            select: { id: true, fullName: true, email: true, phone: true },
          },
        },
      })
    : null;
  const draft = parseChatToQuotePrompt(params.message);
  const selectedCustomerId = params.context?.customerId ?? selectedQuote?.customerId ?? null;
  const scopedCustomer = selectedQuote?.customer ?? (selectedCustomerId
    ? await prisma.customer.findFirst({
        where: {
          id: selectedCustomerId,
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
        },
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : null);
  const parsedCustomerMatches = !selectedCustomerId && !scopedCustomer && (
    draft.customerName || draft.customerEmail || draft.customerPhone
  )
    ? await prisma.customer.findMany({
        where: {
          ...tenantActiveCustomerScope(params.access.tenantId),
          ...assignedCustomerScope(params.access),
          OR: [
            ...(draft.customerName ? [{ fullName: { equals: draft.customerName, mode: "insensitive" as const } }] : []),
            ...(draft.customerEmail ? [{ email: { equals: draft.customerEmail, mode: "insensitive" as const } }] : []),
            ...(draft.customerPhone ? [{ phone: formatUsPhone(draft.customerPhone) ?? draft.customerPhone }] : []),
          ],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 4,
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : [];
  const selectedCustomer = scopedCustomer ?? (parsedCustomerMatches.length === 1 ? parsedCustomerMatches[0] : null);
  const serviceType = params.context?.serviceType ?? selectedQuote?.serviceType ?? draft.serviceType;
  const title = selectedQuote?.title || draft.title;
  const scopeText = selectedQuote?.scopeText || draft.scopeText;
  let governedRetrieval: AiRetrievalResult | null = null;
  try {
    governedRetrieval = await buildGovernedQuoteAiContext(prisma, {
      access: params.access,
      query: params.message,
      purpose: selectedQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
      serviceType,
      requestId: params.access.requestId,
      customerId: selectedCustomer?.id ?? null,
      quoteId: selectedQuote?.id ?? null,
      priorUserQueries: params.conversation
        ?.filter((turn) => turn.resolvedTool === "DRAFT_QUOTE")
        .map((turn) => turn.message),
    });
  } catch {
    // Retrieval is additive. Kody still returns a review-only deterministic
    // preview when indexing or the embedding provider is temporarily unavailable.
  }
  const includeInternalCost = hasCapability(params.access, "viewInternalCosts") && draft.estimatedInternalCostAmount !== null;
  const promptClassification: DataClassification = includeInternalCost ? "C3_FINANCIAL_CONFIDENTIAL" : "C2_CUSTOMER_CONFIDENTIAL";
  const retrievalClassification = governedRetrieval?.chunks.reduce<DataClassification>(
    (current, chunk) => highestClassification(current, chunk.classification),
    "C0_PUBLIC",
  ) ?? "C0_PUBLIC";
  const maxClassification = highestClassification(promptClassification, retrievalClassification);
  const retrievedSourceCount = governedRetrieval?.citations.length ?? 0;
  const answer = parsedCustomerMatches.length > 1
    ? `I found ${parsedCustomerMatches.length} active assigned customers matching ${draft.customerName ?? "those contact details"}. Choose the correct customer before opening the review draft.`
    : retrievedSourceCount
    ? `Prepared a ${serviceType.toLowerCase()} quote preview for ${title} and found ${retrievedSourceCount} relevant workspace source${retrievedSourceCount === 1 ? "" : "s"}. Open the draft to generate the grounded version, then review scope and pricing before saving or sending.`
    : `Prepared a preview for a ${serviceType.toLowerCase()} quote: ${title}. I did not find useful saved workspace context, so review it carefully before creating or sending anything.`;
  const results = [{
    title,
    serviceType,
    customerName: selectedCustomer?.fullName ?? draft.customerName ?? null,
    squareFeetEstimate: draft.squareFeetEstimate,
    estimatedTotalAmount: draft.estimatedTotalAmount,
    estimatedTaxAmount: draft.estimatedTaxAmount,
    estimatedInternalCostAmount: includeInternalCost ? draft.estimatedInternalCostAmount : null,
    lineItemCount: draft.lineItems.length,
  }];
  const citations: AiAssistantCitation[] = [
    { key: "A1", label: "Parsed quote drafting prompt", sourceType: "Quote", classification: promptClassification },
    ...(governedRetrieval?.citations.map((citation) => ({
      key: citation.key,
      label: citation.label,
      sourceType: citation.sourceType,
      classification: citation.classification,
    })) ?? []),
  ];
  const baseActionPayload = {
      prompt: params.message,
      customerId: selectedCustomer?.id ?? null,
      customerName: selectedCustomer?.fullName ?? draft.customerName ?? null,
      customerEmail: selectedCustomer?.email ?? draft.customerEmail ?? null,
      customerPhone: selectedCustomer?.phone ?? draft.customerPhone ?? null,
      quoteId: selectedQuote?.id ?? null,
      serviceType,
      title,
      scopeText,
      squareFeetEstimate: draft.squareFeetEstimate,
      squareFeetEstimateLow: draft.squareFeetEstimateLow,
      squareFeetEstimateHigh: draft.squareFeetEstimateHigh,
      estimatedTotalAmount: draft.estimatedTotalAmount,
      estimatedTaxAmount: draft.estimatedTaxAmount,
      estimatedInternalCostAmount: includeInternalCost ? draft.estimatedInternalCostAmount : null,
      lineItems: draft.lineItems.map((lineItem) => ({
        description: lineItem.description,
        quantity: lineItem.quantity,
        sectionType: lineItem.sectionType ?? "INCLUDED",
        sectionLabel: lineItem.sectionLabel ?? null,
      })),
      useWorkspaceContext: retrievedSourceCount > 0,
      retrievedSourceCount,
      retrievedSourceLabels: Array.from(
        new Set(governedRetrieval?.citations.map((citation) => citation.label) ?? []),
      ).slice(0, 6),
    };
  const actions: AiAssistantAction[] = parsedCustomerMatches.length > 1
    ? parsedCustomerMatches.slice(0, 3).map((customer) => ({
        type: "OPEN_QUOTE_DRAFT",
        label: `Draft for ${customer.fullName} · ${formatUsPhone(customer.phone) ?? customer.phone}`,
        requiresConfirmation: true,
        payload: {
          ...baseActionPayload,
          customerId: customer.id,
          customerName: customer.fullName,
          customerEmail: customer.email,
          customerPhone: customer.phone,
        },
      }))
    : [{
        type: "OPEN_QUOTE_DRAFT",
        label: "Review quote draft",
        requiresConfirmation: true,
        payload: baseActionPayload,
      }];
  const fieldsExcluded = [
    ...defaultExcludedFields(includeInternalCost),
    ...(includeInternalCost ? [] : ["user-supplied internal cost estimate"]),
  ];
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "DRAFT_QUOTE",
    resultCount: 1,
    citationCount: citations.length,
    emptyReason: selectedCustomer || selectedQuote ? null : "No selected active customer or quote context was found; preview was derived from the prompt only.",
    archivePolicy: "Quote drafting context uses active tenant customers and quotes only.",
    filters: {
      currentPage: params.context?.currentPage,
      scopedCustomer: Boolean(selectedCustomerId),
      selectedCustomerFound: Boolean(selectedCustomer),
      scopedQuote: Boolean(params.context?.quoteId),
      selectedQuoteFound: Boolean(selectedQuote),
      includeArchivedRequested: Boolean(params.context?.includeArchived),
      includeArchivedEffective: false,
      retrievedSourceCount,
    },
  });
  const composition = await composeAssistantAnswer({
    userMessage: params.message,
    tool: "DRAFT_QUOTE",
    deterministicAnswer: answer,
    maxClassification,
    results,
    citations,
    actions,
    fieldsExcluded,
    diagnostics: baseDiagnostics,
    sensitiveValues: [
      params.actor.actorEmail,
      params.actor.actorName,
      selectedCustomer?.fullName,
      selectedCustomer?.email,
      selectedCustomer?.phone,
    ],
    conversation: params.conversation,
    retrievalExcerpts: governedRetrieval?.chunks.map((chunk) => ({
      key: chunk.citationKey,
      label: chunk.citationLabel,
      sourceType: chunk.sourceType,
      sourceField: chunk.sourceField,
      classification: chunk.classification,
      content: chunk.content,
    })),
  });
  const combinedTelemetry = mergeAiUsageTelemetry(governedRetrieval?.telemetry, composition.telemetry);
  const sourceTypes = Array.from(new Set([
    "Quote",
    ...(selectedCustomer ? ["Customer"] : []),
    ...(governedRetrieval?.citations.map((citation) => citation.sourceType) ?? []),
  ]));
  const sourceLabels = Array.from(new Set([
    selectedQuote
      ? "Selected active quote"
      : selectedCustomer
        ? "Selected active customer"
        : "Preview quote draft",
    ...((governedRetrieval?.citations ?? []).map((citation) => citation.label)),
  ])).slice(0, 16);
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer: composition.answer,
    classification: maxClassification,
    sourceTypes,
    sourceLabels,
    quoteId: selectedQuote?.id ?? null,
    customerId: selectedCustomer?.id ?? null,
    serviceType,
    model: composition.model,
    telemetry: combinedTelemetry,
    retrievalAuditEventId: governedRetrieval?.auditEventId ?? null,
    eventType: selectedQuote ? "REVISE" : "DRAFT",
    purpose: selectedQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
    confidenceLevel: composition.confidenceLevel,
    confidenceLabel: composition.confidenceLabel,
    insightReasons: composition.insightReasons,
    riskNote: governedRetrieval
      ? `${composition.riskNote} Retrieved excerpts were tenant-scoped, policy-filtered, and treated as untrusted source material.`
      : composition.riskNote,
  });

  return {
    consumedCredits: 1,
    consumedSpendUsd: combinedTelemetry?.estimatedCostUsd ?? 0,
    assistant: {
      tool: "DRAFT_QUOTE",
      generatedAtUtc,
      policyVersion: AI_DATA_POLICY_VERSION,
      maxClassification,
      answer: composition.answer,
      results,
      citations,
      actions,
      auditEventId: event.id,
      fieldsExcluded,
      diagnostics: composedDiagnostics(baseDiagnostics, composition),
    },
  };
}

export async function runAiAssistant(
  prisma: PrismaClient,
  params: AiAssistantInput,
): Promise<AiAssistantRunResult> {
  const generatedAtUtc = params.now ?? new Date();
  const tool = resolveAssistantTool(params.message, params.tool, params.context, params.conversation);
  let result: AiAssistantRunResult;

  if (tool === "ASSISTANT_HELP" || tool === "OUT_OF_SCOPE") {
    result = await runNonDataAssistantResponse(prisma, params, generatedAtUtc, tool);
  } else if (tool === "NAVIGATE_WORKSPACE") {
    result = await runWorkspaceNavigation(prisma, params, generatedAtUtc);
  } else if (tool === "DRAFT_CUSTOMER") {
    result = await runCustomerDraftPreview(prisma, params, generatedAtUtc);
  } else if (tool === "DRAFT_PRODUCT") {
    result = await runProductDraftPreview(prisma, params, generatedAtUtc);
  } else if (tool === "PREPARE_QUOTE_SEND") {
    result = await runPrepareQuoteSend(prisma, params, generatedAtUtc);
  } else if (tool === "FOLLOW_UP_QUEUE") {
    result = await runFollowUpQueue(prisma, params, generatedAtUtc);
  } else if (tool === "CUSTOMERS_WITHOUT_QUOTES") {
    result = await runCustomersWithoutQuotes(prisma, params, generatedAtUtc);
  } else if (tool === "PIPELINE_SCENARIO") {
    result = await runPipelineScenario(prisma, params, generatedAtUtc);
  } else if (tool === "SEARCH_CUSTOMERS") {
    result = await runCustomerSearch(prisma, params, generatedAtUtc);
  } else if (tool === "SUMMARIZE_PIPELINE") {
    result = await runBusinessInsightTool(prisma, params, generatedAtUtc, "SUMMARIZE_PIPELINE");
  } else if (tool === "RANK_PROFITABLE_JOBS") {
    result = await runBusinessInsightTool(prisma, params, generatedAtUtc, "RANK_PROFITABLE_JOBS");
  } else {
    result = await runDraftQuotePreview(prisma, params, generatedAtUtc);
  }

  return {
    ...result,
    assistant: {
      ...result.assistant,
      conversation: resolveAssistantConversationState(params.conversation, tool),
    },
  };
}
