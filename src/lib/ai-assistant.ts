import { Prisma, type DataClassification, type PrismaClient, type ServiceCategory } from "@prisma/client";
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
  type AiUsageTelemetry,
  type MonthlyAiUsageSnapshot,
} from "./ai-usage";
import {
  AiBusinessInsightForbiddenError,
  generateAiBusinessInsight,
  type AiBusinessInsightTool,
} from "./ai-business-insights";
import { AI_DATA_POLICY_VERSION } from "./data-classification";
import { normalizePhoneSearchDigits } from "./phone";
import { tenantActiveCustomerScope, tenantActiveQuoteScope } from "./query-scope";
import { parseChatToQuotePrompt } from "../services/chat-to-quote";

export const AI_ASSISTANT_TOOLS = [
  "AUTO",
  "NAVIGATE_WORKSPACE",
  "FOLLOW_UP_QUEUE",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_QUOTE",
] as const;

export type AiAssistantRequestedTool = (typeof AI_ASSISTANT_TOOLS)[number];
export type AiAssistantTool = Exclude<AiAssistantRequestedTool, "AUTO">;

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
    | "OPEN_QUOTE_DRAFT"
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
const NAVIGATION_VERB_PATTERN = /\b(?:go|open|navigate|take\s+me|bring\s+me|move\s+me|show\s+me)\b/i;
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

function clampLimit(value: number | undefined, max: number, fallback: number) {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function cleanSearchQuery(message: string, contextSearch?: string) {
  let raw = contextSearch?.trim() || message.trim().replace(STOP_CUSTOMER_SEARCH_PREFIX, "").trim();
  raw = raw.split(/\b(?:and\s+)?(?:ignore|bypass|override|expose|retrieve\s+all|show\s+all)\b/i)[0] ?? raw;
  return raw.replace(/\s+/g, " ").slice(0, 120);
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
): AiAssistantTool {
  if (requestedTool && requestedTool !== "AUTO") return requestedTool;
  const lower = message.toLowerCase();

  if (PIPELINE_SCENARIO_PATTERN.test(lower)) return "PIPELINE_SCENARIO";
  if (CUSTOMERS_WITHOUT_QUOTES_PATTERN.test(lower)) return "CUSTOMERS_WITHOUT_QUOTES";
  if (FOLLOW_UP_INTENT_PATTERN.test(lower)) return "FOLLOW_UP_QUEUE";
  if (navigationTarget(lower)) return "NAVIGATE_WORKSPACE";
  if (FINANCIAL_INTENT_PATTERN.test(lower)) return "RANK_PROFITABLE_JOBS";
  if (PIPELINE_INTENT_PATTERN.test(lower)) return "SUMMARIZE_PIPELINE";
  if (CUSTOMER_INTENT_PATTERN.test(lower) || context?.currentPage === "customers") return "SEARCH_CUSTOMERS";
  if (QUOTE_DRAFT_INTENT_PATTERN.test(lower) || context?.currentPage === "quotes") return "DRAFT_QUOTE";
  if (context?.currentPage === "analytics") return "SUMMARIZE_PIPELINE";

  return "DRAFT_QUOTE";
}

export function assistantToolConsumesAiBudget(tool: AiAssistantTool) {
  return ![
    "NAVIGATE_WORKSPACE",
    "FOLLOW_UP_QUEUE",
    "CUSTOMERS_WITHOUT_QUOTES",
    "PIPELINE_SCENARIO",
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
  },
) {
  return createAiUsageEvent(prisma, {
    tenantId: params.access.tenantId,
    quoteId: params.quoteId ?? null,
    customerId: params.customerId ?? null,
    actor: params.actor,
    eventType: "BUSINESS_INSIGHT",
    purpose: "BUSINESS_INSIGHT",
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
            where: tenantActiveQuoteScope(params.access.tenantId),
          },
        },
      },
      quotes: {
        where: tenantActiveQuoteScope(params.access.tenantId),
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
  const label = workspacePageLabel(target);
  const answer = `I can take you to ${label}. Your Kody conversation will stay open while you move.`;
  const action: AiAssistantAction = {
    type: "OPEN_WORKSPACE_PAGE",
    label: `Open ${label}`,
    requiresConfirmation: false,
    payload: { page: target },
  };
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer,
    classification: "C1_BUSINESS_INTERNAL",
    sourceTypes: [],
    sourceLabels: ["Approved workspace navigation"],
    creditsConsumed: 0,
    telemetry: ZERO_AI_TELEMETRY,
    confidenceLevel: "high",
    confidenceLabel: "Deterministic navigation",
    riskNote: "No workspace records or external AI provider were used for navigation.",
  });
  const baseDiagnostics = diagnostics({
    input: params,
    resolvedTool: "NAVIGATE_WORKSPACE",
    resultCount: 0,
    citationCount: 0,
    archivePolicy: "Navigation does not retrieve customer or quote rows.",
    filters: { targetPage: target },
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
    quotes: { none: tenantActiveQuoteScope(params.access.tenantId) },
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

  const [sentQuotes, afterSaleQuotes] = await Promise.all([
    prisma.quote.findMany({
      where: {
        ...activeQuote,
        status: "SENT_TO_CUSTOMER",
        customer: { is: { ...activeCustomer, followUpStatus: "NEEDS_FOLLOW_UP" } },
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
            status: "ACCEPTED",
            afterSaleFollowUpStatus: "DUE",
            afterSaleFollowUpDueAtUtc: { lte: generatedAtUtc },
            customer: { is: activeCustomer },
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
          followUpStatus: "NEEDS_FOLLOW_UP",
          quotes: {
            none: { ...activeQuote, status: { in: ["SENT_TO_CUSTOMER", "ACCEPTED"] } },
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
            where: activeQuote,
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
        status: { in: [...OPEN_PIPELINE_STATUSES] },
        ...serviceFilter,
      },
      _count: { _all: true },
      _sum: { customerPriceSubtotal: true },
    }),
    prisma.quote.aggregate({
      where: {
        ...tenantActiveQuoteScope(tenantId),
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
  const retrievalAudit = await prisma.aiRetrievalAuditEvent.create({
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
  });
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

  try {
    const insight = await generateAiBusinessInsight(prisma, {
      access: params.access,
      actor: params.actor,
      prompt: params.message,
      tool: businessTool,
      dateFrom: params.context?.dateFrom ?? null,
      dateTo: params.context?.dateTo ?? null,
      serviceType: params.context?.serviceType ?? null,
      limit: params.context?.limit,
      includeArchived: params.context?.includeArchived,
      now: generatedAtUtc,
      sensitiveValues: [params.message],
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
  const selectedCustomerId = params.context?.customerId ?? selectedQuote?.customerId ?? null;
  const selectedCustomer = selectedQuote?.customer ?? (selectedCustomerId
    ? await prisma.customer.findFirst({
        where: {
          id: selectedCustomerId,
          ...tenantActiveCustomerScope(params.access.tenantId),
        },
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : null);

  const draft = parseChatToQuotePrompt(params.message);
  const serviceType = params.context?.serviceType ?? selectedQuote?.serviceType ?? draft.serviceType;
  const title = selectedQuote?.title || draft.title;
  const scopeText = selectedQuote?.scopeText || draft.scopeText;
  const includeInternalCost = hasCapability(params.access, "viewInternalCosts") && draft.estimatedInternalCostAmount !== null;
  const maxClassification: DataClassification = includeInternalCost ? "C3_FINANCIAL_CONFIDENTIAL" : "C2_CUSTOMER_CONFIDENTIAL";
  const answer = `Prepared a preview for a ${serviceType.toLowerCase()} quote: ${title}. Review it before creating or sending anything.`;
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
  const citations: AiAssistantCitation[] = [{ key: "A1", label: "Parsed quote drafting prompt", sourceType: "Quote", classification: maxClassification }];
  const actions = [{
    type: "OPEN_QUOTE_DRAFT" as const,
    label: "Review quote draft",
    requiresConfirmation: true,
    payload: {
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
    },
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
  });
  const event = await createAssistantUsageEvent(prisma, {
    access: params.access,
    actor: params.actor,
    message: params.message,
    answer: composition.answer,
    classification: maxClassification,
    sourceTypes: selectedCustomer ? ["Customer", "Quote"] : ["Quote"],
    sourceLabels: selectedQuote
      ? ["Selected active quote", "Preview quote draft"]
      : selectedCustomer
        ? ["Selected active customer", "Preview quote draft"]
        : ["Preview quote draft"],
    quoteId: selectedQuote?.id ?? null,
    customerId: selectedCustomer?.id ?? null,
    serviceType,
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
  const tool = resolveAssistantTool(params.message, params.tool, params.context);

  if (tool === "NAVIGATE_WORKSPACE") {
    return runWorkspaceNavigation(prisma, params, generatedAtUtc);
  }
  if (tool === "FOLLOW_UP_QUEUE") {
    return runFollowUpQueue(prisma, params, generatedAtUtc);
  }
  if (tool === "CUSTOMERS_WITHOUT_QUOTES") {
    return runCustomersWithoutQuotes(prisma, params, generatedAtUtc);
  }
  if (tool === "PIPELINE_SCENARIO") {
    return runPipelineScenario(prisma, params, generatedAtUtc);
  }
  if (tool === "SEARCH_CUSTOMERS") {
    return runCustomerSearch(prisma, params, generatedAtUtc);
  }
  if (tool === "SUMMARIZE_PIPELINE") {
    return runBusinessInsightTool(prisma, params, generatedAtUtc, "SUMMARIZE_PIPELINE");
  }
  if (tool === "RANK_PROFITABLE_JOBS") {
    return runBusinessInsightTool(prisma, params, generatedAtUtc, "RANK_PROFITABLE_JOBS");
  }
  return runDraftQuotePreview(prisma, params, generatedAtUtc);
}
