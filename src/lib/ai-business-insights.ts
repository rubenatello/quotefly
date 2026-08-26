import { Prisma, type DataClassification, type PrismaClient, type QuoteStatus, type ServiceCategory } from "@prisma/client";
import type { AccessContext } from "./access-policy";
import { hasCapability } from "./access-policy";
import {
  composeAssistantAnswer,
  type AiAssistantAnswerMode,
} from "./ai-assistant-composer";
import { createAiUsageEvent } from "./ai-usage";
import type { AiUsageTelemetry } from "./ai-usage";
import { hashSourceReference } from "./ai-data-governance";
import { AI_DATA_POLICY_VERSION } from "./data-classification";
import { tenantActiveScope } from "./query-scope";
import type { ActivityActor } from "./activity";
import type { AiAssistantConversationTurn } from "./ai-assistant-contract";

export const AI_BUSINESS_INSIGHT_TOOLS = [
  "SALES_PIPELINE",
  "SERVICE_PROFITABILITY",
  "ITEM_PROFITABILITY",
  "LOW_MARGIN_QUOTES",
] as const;

export type AiBusinessInsightTool = (typeof AI_BUSINESS_INSIGHT_TOOLS)[number];

const ACCEPTED_STATUSES: QuoteStatus[] = ["ACCEPTED"];
const OPEN_PIPELINE_STATUSES: QuoteStatus[] = ["READY_FOR_REVIEW", "SENT_TO_CUSTOMER"];
const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 730;
const MAX_RESULT_LIMIT = 20;
const DEFAULT_RESULT_LIMIT = 8;
const LOW_MARGIN_THRESHOLD_PERCENT = 20;

export type AiBusinessInsightInput = Readonly<{
  access: AccessContext;
  actor: ActivityActor;
  prompt: string;
  tool: AiBusinessInsightTool;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  serviceType?: ServiceCategory | null;
  limit?: number;
  includeArchived?: boolean;
  now?: Date;
  sensitiveValues?: readonly (string | null | undefined)[];
  conversation?: readonly AiAssistantConversationTurn[];
}>;

export type AiBusinessInsightResult = Readonly<{
  tool: AiBusinessInsightTool;
  generatedAtUtc: Date;
  policyVersion: string;
  maxClassification: DataClassification;
  dateRange: {
    from: Date;
    to: Date;
  };
  filters: {
    serviceType: ServiceCategory | null;
    includeArchived: boolean;
    statuses: QuoteStatus[];
  };
  answer: string;
  summary: {
    quoteCount: number;
    acceptedQuoteCount: number;
    pipelineQuoteCount: number;
    revenue: number;
    acceptedRevenue: number;
    pipelineRevenue: number;
    averageAcceptedQuoteValue: number | null;
    grossCost?: number;
    grossProfit?: number;
    grossMarginPercent?: number | null;
    winRatePercent?: number | null;
  };
  rows: Array<Record<string, string | number | null>>;
  citations: Array<{
    key: string;
    label: string;
    sourceType: string;
    classification: DataClassification;
  }>;
  auditEventId: string;
  fieldsExcluded: string[];
  answerMode: AiAssistantAnswerMode;
  model: string | null;
  telemetry: AiUsageTelemetry | null;
}>;

export class AiBusinessInsightForbiddenError extends Error {
  constructor(message = "You do not have access to financial business insights.") {
    super(message);
    this.name = "AiBusinessInsightForbiddenError";
  }
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function roundPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}

function money(value: number | null | undefined) {
  return `$${(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "n/a" : `${value}%`;
}

function formatInsightDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatQuoteStatus(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function rowString(row: Record<string, string | number | null> | undefined, key: string) {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowNumber(row: Record<string, string | number | null> | undefined, key: string) {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function marginPercent(revenue: number, cost: number) {
  if (revenue <= 0) return null;
  return ((revenue - cost) / revenue) * 100;
}

function clampLimit(value?: number) {
  if (value === undefined || value === null) return DEFAULT_RESULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULT_LIMIT);
}

function normalizeRange(params: { from?: Date | null; to?: Date | null; now?: Date }) {
  const now = params.now ?? new Date();
  const to = params.to ? new Date(params.to) : now;
  const defaultFrom = new Date(to);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - DEFAULT_RANGE_DAYS);
  const from = params.from ? new Date(params.from) : defaultFrom;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error("Invalid insight date range.");
  }
  if (from > to) {
    throw new Error("dateFrom must be before dateTo.");
  }
  const maxFrom = new Date(to);
  maxFrom.setUTCDate(maxFrom.getUTCDate() - MAX_RANGE_DAYS);
  if (from < maxFrom) {
    throw new Error(`Business insight date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to };
}

function requiresFinancialAccess(tool: AiBusinessInsightTool) {
  return tool === "SERVICE_PROFITABILITY" || tool === "ITEM_PROFITABILITY" || tool === "LOW_MARGIN_QUOTES";
}

function canIncludeArchivedRecords(access: AccessContext) {
  return hasCapability(access, "viewAiRunAudit");
}

function shouldIncludeArchivedRecords(params: AiBusinessInsightInput) {
  return Boolean(params.includeArchived && canIncludeArchivedRecords(params.access));
}

function quoteWhere(params: AiBusinessInsightInput, range: { from: Date; to: Date }): Prisma.QuoteWhereInput {
  return {
    tenantId: params.access.tenantId,
    ...(!hasCapability(params.access, "viewAllWorkspaceRecords")
      ? { assignedTenantUserId: params.access.tenantUserId }
      : {}),
    deletedAtUtc: null,
    ...(shouldIncludeArchivedRecords(params) ? {} : { archivedAtUtc: null }),
    ...(params.serviceType ? { serviceType: params.serviceType } : {}),
    createdAt: {
      gte: range.from,
      lte: range.to,
    },
  };
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function buildStatusRows(counts: Record<QuoteStatus, { count: number; revenue: number }>) {
  return (Object.entries(counts) as Array<[QuoteStatus, { count: number; revenue: number }]>)
    .filter(([, value]) => value.count > 0)
    .sort((left, right) => right[1].revenue - left[1].revenue)
    .map(([status, value]) => ({
      status,
      quoteCount: value.count,
      revenue: roundCurrency(value.revenue),
    }));
}

function emptyStatusCounts(): Record<QuoteStatus, { count: number; revenue: number }> {
  return {
    DRAFT: { count: 0, revenue: 0 },
    READY_FOR_REVIEW: { count: 0, revenue: 0 },
    SENT_TO_CUSTOMER: { count: 0, revenue: 0 },
    ACCEPTED: { count: 0, revenue: 0 },
    REJECTED: { count: 0, revenue: 0 },
  };
}

function buildAnswer(params: {
  tool: AiBusinessInsightTool;
  dateRange: { from: Date; to: Date };
  includeArchived: boolean;
  summary: AiBusinessInsightResult["summary"];
  rows: AiBusinessInsightResult["rows"];
}) {
  const dateScope = `${formatInsightDate(params.dateRange.from)} to ${formatInsightDate(params.dateRange.to)}`;
  const archiveScope = params.includeArchived ? "including archived quotes" : "excluding archived quotes";
  const rowCount = params.rows.length;
  if (params.tool === "SALES_PIPELINE") {
    const topStatus = params.rows[0];
    const topStatusText = topStatus
      ? `Largest bucket: ${formatQuoteStatus(rowString(topStatus, "status") ?? "unknown")} at ${money(rowNumber(topStatus, "revenue"))}.`
      : "No active pipeline rows matched that range.";
    return [
      `Sales pipeline for quotes created ${dateScope}, ${archiveScope}: ${params.summary.quoteCount} quotes found.`,
      `Accepted revenue is ${money(params.summary.acceptedRevenue)}; open pipeline is ${money(params.summary.pipelineRevenue)}.`,
      topStatusText,
      params.summary.winRatePercent === null ? null : `Win rate is ${params.summary.winRatePercent}%.`,
    ].filter(Boolean).join(" ");
  }

  if (params.tool === "SERVICE_PROFITABILITY") {
    const topService = params.rows[0];
    const topServiceText = topService
      ? `Top service: ${rowString(topService, "serviceType") ?? "unknown"} with ${money(rowNumber(topService, "grossProfit"))} gross profit on ${money(rowNumber(topService, "revenue"))} revenue (${percent(rowNumber(topService, "grossMarginPercent"))} margin).`
      : "No accepted quotes matched that range.";
    return [
      `Service profitability for accepted quotes created ${dateScope}, ${archiveScope}: ranked ${rowCount} service categor${rowCount === 1 ? "y" : "ies"}.`,
      topServiceText,
      `Overall accepted revenue is ${money(params.summary.acceptedRevenue)} with ${money(params.summary.grossProfit)} gross profit.`,
      params.summary.grossMarginPercent === null || params.summary.grossMarginPercent === undefined
        ? null
        : `Gross margin is ${params.summary.grossMarginPercent}%.`,
    ].filter(Boolean).join(" ");
  }

  if (params.tool === "ITEM_PROFITABILITY") {
    const topItem = params.rows[0];
    const topItemText = topItem
      ? `Top item: ${rowString(topItem, "item") ?? "unknown"} with ${money(rowNumber(topItem, "grossProfit"))} gross profit (${percent(rowNumber(topItem, "grossMarginPercent"))} margin).`
      : "No accepted quote line items matched that range.";
    return `Item profitability for accepted quotes created ${dateScope}, ${archiveScope}: ranked ${rowCount} line-item group${rowCount === 1 ? "" : "s"}. ${topItemText}`;
  }

  const lowestMargin = params.rows[0];
  const lowestMarginText = lowestMargin
    ? `Lowest margin: ${rowString(lowestMargin, "title") ?? "selected quote"} at ${percent(rowNumber(lowestMargin, "grossMarginPercent"))}.`
    : "No accepted quotes fell below the margin threshold.";
  return `Low-margin review for accepted quotes created ${dateScope}, ${archiveScope}: found ${rowCount} quote${rowCount === 1 ? "" : "s"} below ${LOW_MARGIN_THRESHOLD_PERCENT}% gross margin. ${lowestMarginText}`;
}

async function loadRevenueQuotes(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  return prisma.quote.findMany({
    where: quoteWhere(params, range),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      status: true,
      customerPriceSubtotal: true,
    },
  });
}

async function loadProfitabilityQuotes(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  return prisma.quote.findMany({
    where: quoteWhere(params, range),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      title: true,
      serviceType: true,
      status: true,
      closedAtUtc: true,
      customerPriceSubtotal: true,
      internalCostSubtotal: true,
    },
  });
}

async function buildSalesPipeline(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  const quotes = await loadRevenueQuotes(prisma, params, range);
  const counts = emptyStatusCounts();
  for (const quote of quotes) {
    const revenue = Number(quote.customerPriceSubtotal);
    counts[quote.status].count += 1;
    counts[quote.status].revenue += revenue;
  }
  const acceptedQuotes = quotes.filter((quote) => ACCEPTED_STATUSES.includes(quote.status));
  const pipelineQuotes = quotes.filter((quote) => OPEN_PIPELINE_STATUSES.includes(quote.status));
  const acceptedRevenue = sum(acceptedQuotes.map((quote) => Number(quote.customerPriceSubtotal)));
  const pipelineRevenue = sum(pipelineQuotes.map((quote) => Number(quote.customerPriceSubtotal)));
  const decidedCount = acceptedQuotes.length + quotes.filter((quote) => quote.status === "REJECTED").length;
  const summary = {
    quoteCount: quotes.length,
    acceptedQuoteCount: acceptedQuotes.length,
    pipelineQuoteCount: pipelineQuotes.length,
    revenue: roundCurrency(sum(quotes.map((quote) => Number(quote.customerPriceSubtotal)))),
    acceptedRevenue: roundCurrency(acceptedRevenue),
    pipelineRevenue: roundCurrency(pipelineRevenue),
    averageAcceptedQuoteValue: acceptedQuotes.length ? roundCurrency(acceptedRevenue / acceptedQuotes.length) : null,
    winRatePercent: decidedCount ? roundPercent((acceptedQuotes.length / decidedCount) * 100) : null,
  };
  return {
    summary,
    rows: buildStatusRows(counts),
    citations: [{ key: "A1", label: "Tenant quote aggregates by status", sourceType: "Quote", classification: "C2_CUSTOMER_CONFIDENTIAL" as DataClassification }],
  };
}

async function buildServiceProfitability(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  const quotes = (await loadProfitabilityQuotes(prisma, params, range)).filter((quote) => quote.status === "ACCEPTED");
  const byService = new Map<ServiceCategory, { quoteCount: number; revenue: number; cost: number }>();
  for (const quote of quotes) {
    const current = byService.get(quote.serviceType) ?? { quoteCount: 0, revenue: 0, cost: 0 };
    current.quoteCount += 1;
    current.revenue += Number(quote.customerPriceSubtotal);
    current.cost += Number(quote.internalCostSubtotal);
    byService.set(quote.serviceType, current);
  }

  const rows = [...byService.entries()]
    .map(([serviceType, value]) => {
      const grossProfit = value.revenue - value.cost;
      return {
        serviceType,
        quoteCount: value.quoteCount,
        revenue: roundCurrency(value.revenue),
        grossCost: roundCurrency(value.cost),
        grossProfit: roundCurrency(grossProfit),
        grossMarginPercent: roundPercent(marginPercent(value.revenue, value.cost)),
      };
    })
    .sort((left, right) => Number(right.grossProfit) - Number(left.grossProfit))
    .slice(0, clampLimit(params.limit));

  const acceptedRevenue = sum(quotes.map((quote) => Number(quote.customerPriceSubtotal)));
  const grossCost = sum(quotes.map((quote) => Number(quote.internalCostSubtotal)));
  const grossProfit = acceptedRevenue - grossCost;
  const summary = {
    quoteCount: quotes.length,
    acceptedQuoteCount: quotes.length,
    pipelineQuoteCount: 0,
    revenue: roundCurrency(acceptedRevenue),
    acceptedRevenue: roundCurrency(acceptedRevenue),
    pipelineRevenue: 0,
    averageAcceptedQuoteValue: quotes.length ? roundCurrency(acceptedRevenue / quotes.length) : null,
    grossCost: roundCurrency(grossCost),
    grossProfit: roundCurrency(grossProfit),
    grossMarginPercent: roundPercent(marginPercent(acceptedRevenue, grossCost)),
    winRatePercent: null,
  };

  return {
    summary,
    rows,
    citations: [{ key: "A1", label: "Accepted quote revenue and internal cost aggregates", sourceType: "Quote", classification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification }],
  };
}

function normalizeItemDescription(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
}

async function buildItemProfitability(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  const lineItems = await prisma.quoteLineItem.findMany({
    where: {
      ...tenantActiveScope(params.access.tenantId),
      quote: {
        ...quoteWhere(params, range),
        status: "ACCEPTED",
      },
    },
    select: {
      description: true,
      quantity: true,
      unitCost: true,
      unitPrice: true,
      quote: {
        select: { id: true, serviceType: true },
      },
    },
  });

  const byItem = new Map<string, { description: string; serviceTypes: Set<ServiceCategory>; quantity: number; revenue: number; cost: number; lineCount: number }>();
  for (const lineItem of lineItems) {
    const key = normalizeItemDescription(lineItem.description);
    if (!key) continue;
    const current = byItem.get(key) ?? {
      description: lineItem.description.trim().slice(0, 160),
      serviceTypes: new Set<ServiceCategory>(),
      quantity: 0,
      revenue: 0,
      cost: 0,
      lineCount: 0,
    };
    const quantity = Number(lineItem.quantity);
    current.quantity += quantity;
    current.revenue += quantity * Number(lineItem.unitPrice);
    current.cost += quantity * Number(lineItem.unitCost);
    current.lineCount += 1;
    current.serviceTypes.add(lineItem.quote.serviceType);
    byItem.set(key, current);
  }

  const rows = [...byItem.values()]
    .map((value) => {
      const grossProfit = value.revenue - value.cost;
      return {
        item: value.description,
        serviceTypes: [...value.serviceTypes].sort().join(", "),
        lineCount: value.lineCount,
        quantity: roundCurrency(value.quantity),
        revenue: roundCurrency(value.revenue),
        grossCost: roundCurrency(value.cost),
        grossProfit: roundCurrency(grossProfit),
        grossMarginPercent: roundPercent(marginPercent(value.revenue, value.cost)),
      };
    })
    .sort((left, right) => Number(right.grossProfit) - Number(left.grossProfit))
    .slice(0, clampLimit(params.limit));

  const acceptedQuoteCount = new Set(lineItems.map((lineItem) => lineItem.quote.id)).size;
  const revenue = sum(rows.map((row) => Number(row.revenue)));
  const cost = sum(rows.map((row) => Number(row.grossCost)));
  const summary = {
    quoteCount: acceptedQuoteCount,
    acceptedQuoteCount,
    pipelineQuoteCount: 0,
    revenue: roundCurrency(revenue),
    acceptedRevenue: roundCurrency(revenue),
    pipelineRevenue: 0,
    averageAcceptedQuoteValue: null,
    grossCost: roundCurrency(cost),
    grossProfit: roundCurrency(revenue - cost),
    grossMarginPercent: roundPercent(marginPercent(revenue, cost)),
    winRatePercent: null,
  };

  return {
    summary,
    rows,
    citations: [{ key: "A1", label: "Accepted quote line item revenue and internal cost aggregates", sourceType: "QuoteLineItem", classification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification }],
  };
}

async function buildLowMarginQuotes(prisma: PrismaClient, params: AiBusinessInsightInput, range: { from: Date; to: Date }) {
  const quotes = (await loadProfitabilityQuotes(prisma, params, range))
    .filter((quote) => quote.status === "ACCEPTED")
    .map((quote) => {
      const revenue = Number(quote.customerPriceSubtotal);
      const cost = Number(quote.internalCostSubtotal);
      const grossProfit = revenue - cost;
      return {
        quoteRefHash: hashSourceReference("Quote", quote.id),
        title: quote.title.slice(0, 160),
        serviceType: quote.serviceType,
        closedAtUtc: quote.closedAtUtc?.toISOString() ?? null,
        revenue: roundCurrency(revenue),
        grossCost: roundCurrency(cost),
        grossProfit: roundCurrency(grossProfit),
        grossMarginPercent: roundPercent(marginPercent(revenue, cost)),
      };
    })
    .filter((quote) => quote.grossMarginPercent !== null && quote.grossMarginPercent < LOW_MARGIN_THRESHOLD_PERCENT)
    .sort((left, right) => Number(left.grossMarginPercent) - Number(right.grossMarginPercent))
    .slice(0, clampLimit(params.limit));

  const revenue = sum(quotes.map((quote) => Number(quote.revenue)));
  const cost = sum(quotes.map((quote) => Number(quote.grossCost)));
  const summary = {
    quoteCount: quotes.length,
    acceptedQuoteCount: quotes.length,
    pipelineQuoteCount: 0,
    revenue: roundCurrency(revenue),
    acceptedRevenue: roundCurrency(revenue),
    pipelineRevenue: 0,
    averageAcceptedQuoteValue: quotes.length ? roundCurrency(revenue / quotes.length) : null,
    grossCost: roundCurrency(cost),
    grossProfit: roundCurrency(revenue - cost),
    grossMarginPercent: roundPercent(marginPercent(revenue, cost)),
    winRatePercent: null,
  };

  return {
    summary,
    rows: quotes,
    citations: [{ key: "A1", label: `Accepted quotes under ${LOW_MARGIN_THRESHOLD_PERCENT}% margin`, sourceType: "Quote", classification: "C3_FINANCIAL_CONFIDENTIAL" as DataClassification }],
  };
}

export async function generateAiBusinessInsight(
  prisma: PrismaClient,
  params: AiBusinessInsightInput,
): Promise<AiBusinessInsightResult> {
  if (!hasCapability(params.access, "useAiBusinessInsights")) {
    throw new AiBusinessInsightForbiddenError("AI business insights are not enabled for this role.");
  }
  const financial = requiresFinancialAccess(params.tool);
  if (financial && (!hasCapability(params.access, "viewInternalCosts") || !hasCapability(params.access, "viewMargins"))) {
    throw new AiBusinessInsightForbiddenError("Profitability insights require access to internal costs and margins.");
  }

  const generatedAtUtc = params.now ?? new Date();
  const dateRange = normalizeRange({ from: params.dateFrom, to: params.dateTo, now: generatedAtUtc });
  const maxClassification: DataClassification = financial ? "C3_FINANCIAL_CONFIDENTIAL" : "C2_CUSTOMER_CONFIDENTIAL";
  const includeArchived = shouldIncludeArchivedRecords(params);
  const data = params.tool === "SALES_PIPELINE"
    ? await buildSalesPipeline(prisma, params, dateRange)
    : params.tool === "SERVICE_PROFITABILITY"
      ? await buildServiceProfitability(prisma, params, dateRange)
      : params.tool === "ITEM_PROFITABILITY"
        ? await buildItemProfitability(prisma, params, dateRange)
        : await buildLowMarginQuotes(prisma, params, dateRange);
  const answer = buildAnswer({
    tool: params.tool,
    dateRange,
    includeArchived,
    summary: data.summary,
    rows: data.rows,
  });
  const fieldsExcluded = [
    "tenant ids",
    "raw row ids",
    "customer contact data",
    "provider identifiers",
    "raw prompts",
    ...(params.includeArchived && !includeArchived ? ["archived records"] : []),
    ...(financial ? [] : ["internal costs", "gross profit", "margins"]),
  ];
  const statuses: QuoteStatus[] = params.tool === "SALES_PIPELINE"
    ? ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"]
    : ["ACCEPTED"];
  const composition = await composeAssistantAnswer({
    diagnosticContext: { requestId: params.access.requestId },
    userMessage: params.prompt,
    tool: params.tool,
    deterministicAnswer: answer,
    maxClassification,
    results: data.rows,
    citations: data.citations,
    actions: [],
    fieldsExcluded,
    sensitiveValues: [
      params.actor.actorEmail,
      params.actor.actorName,
      ...(params.sensitiveValues ?? []),
    ],
    conversation: params.conversation,
    diagnostics: {
      resultCount: data.rows.length,
      citationCount: data.citations.length,
      emptyReason: data.rows.length ? null : "No quote aggregates matched tenant scope and effective filters.",
      archivePolicy: includeArchived
        ? "Archived quote aggregates were included because the current role policy allowed it."
        : "Archived/deleted quote aggregates were excluded by the current role policy.",
      filters: {
        businessInsightTool: params.tool,
        dateField: "Quote.createdAt",
        dateFrom: dateRange.from.toISOString(),
        dateTo: dateRange.to.toISOString(),
        serviceType: params.serviceType ?? null,
        includeArchivedRequested: Boolean(params.includeArchived),
        includeArchivedEffective: includeArchived,
      },
    },
  });

  const event = await createAiUsageEvent(prisma, {
    tenantId: params.access.tenantId,
    actor: params.actor,
    eventType: "BUSINESS_INSIGHT",
    purpose: "BUSINESS_INSIGHT",
    classification: maxClassification,
    promptText: params.prompt,
    requestId: params.access.requestId,
    creditsConsumed: 1,
    model: composition.model,
    telemetry: composition.telemetry,
    sensitiveValues: params.sensitiveValues,
    trace: {
      insightSummary: composition.answer,
      insightReasons: [
        `tool=${params.tool}`,
        `dateRange=${dateRange.from.toISOString()}..${dateRange.to.toISOString()}`,
        `classification=${maxClassification}`,
        ...composition.insightReasons,
      ],
      insightSourceLabels: data.citations.map((citation) => citation.label),
      sourceTypes: data.citations.map((citation) => citation.sourceType),
      confidenceLevel: composition.confidenceLevel,
      confidenceLabel: composition.confidenceLabel,
      riskNote: composition.riskNote,
    },
  });

  return {
    tool: params.tool,
    generatedAtUtc,
    policyVersion: AI_DATA_POLICY_VERSION,
    maxClassification,
    dateRange,
    filters: {
      serviceType: params.serviceType ?? null,
      includeArchived,
      statuses,
    },
    answer: composition.answer,
    summary: data.summary,
    rows: data.rows,
    citations: data.citations,
    auditEventId: event.id,
    fieldsExcluded,
    answerMode: composition.answerMode,
    model: composition.model,
    telemetry: composition.telemetry,
  };
}
