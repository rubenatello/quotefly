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
const STOP_CUSTOMER_SEARCH_PREFIX =
  /^(?:please\s+)?(?:find|search|look\s+up|show|show\s+me|open)\s+(?:a\s+)?(?:customer|client|contact|customers|clients|contacts)\s*(?:named|called|for|matching|with)?\s*/i;
const FINANCIAL_INTENT_PATTERN = /\b(profit|profitable|profitability|margin|gross|cost|costs|rank|underpriced|low[-\s]*margin|item|items|product|products)\b/i;
const PIPELINE_INTENT_PATTERN = /\b(pipeline|sales|revenue|win\s*rate|accepted|sent|open\s+quotes?|follow[-\s]*up)\b/i;
const CUSTOMER_INTENT_PATTERN = /\b(customer|client|contact|phone|email|find|search|look\s+up)\b/i;
const QUOTE_DRAFT_INTENT_PATTERN = /\b(quote|estimate|draft|bid|proposal|new\s+job|sq\s*ft|sqft|roof|roofing|floor|flooring|hvac|plumb|plumbing|landscap|construction)\b/i;
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

function resolveTool(message: string, requestedTool?: AiAssistantRequestedTool, context?: AiAssistantContext): AiAssistantTool {
  if (requestedTool && requestedTool !== "AUTO") return requestedTool;
  const lower = message.toLowerCase();

  if (FINANCIAL_INTENT_PATTERN.test(lower)) return "RANK_PROFITABLE_JOBS";
  if (PIPELINE_INTENT_PATTERN.test(lower)) return "SUMMARIZE_PIPELINE";
  if (CUSTOMER_INTENT_PATTERN.test(lower) || context?.currentPage === "customers") return "SEARCH_CUSTOMERS";
  if (QUOTE_DRAFT_INTENT_PATTERN.test(lower) || context?.currentPage === "quotes") return "DRAFT_QUOTE";
  if (context?.currentPage === "analytics") return "SUMMARIZE_PIPELINE";

  return "DRAFT_QUOTE";
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
  const tool = resolveTool(params.message, params.tool, params.context);

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
