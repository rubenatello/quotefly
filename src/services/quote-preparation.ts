import { createHash } from "node:crypto";
import type { DataClassification, PrismaClient, ServiceCategory } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { buildGovernedQuoteAiContext, type AiRetrievalResult } from "../lib/ai-retrieval";
import { normalizePhoneSearchDigits, normalizeUsPhoneDigits } from "../lib/phone";
import { tenantActiveCustomerScope, tenantActiveQuoteScope } from "../lib/query-scope";
import { assignedRecordScope } from "../lib/workspace-assignment";
import {
  aiParseChatToQuotePrompt,
  createAiTelemetryAccumulator,
  getAiQuoteRuntimeInfo,
  type AiTelemetryAccumulator,
} from "./ai-quote";
import type { AiQuoteProviderBudget } from "./ai-quote-provider-budget";
import { prepareCatalogQuoteLines } from "./ai-quote-catalog";
import { AiUsageLedgerError } from "./ai-usage-ledger";
import { parseChatToQuotePrompt, type ParsedChatToQuoteDraft } from "./chat-to-quote";

export type QuotePriceProvenance =
  | "EXPLICIT_PROMPT"
  | "TENANT_PRESET"
  | "STANDARD_CATALOG"
  | "UNRESOLVED";

export type QuotePreparationCustomer = Readonly<{
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}>;

export type QuotePreparationLine = Readonly<{
  description: string;
  quantity: number;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel: string | null;
  sourcePresetId: string | null;
  catalogKey: string | null;
  unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH" | null;
  unitPrice: number;
  unitCost?: number;
  priceProvenance: QuotePriceProvenance;
}>;

export type QuotePreparationDraft = Readonly<{
  quoteId: string | null;
  serviceType: ServiceCategory;
  title: string;
  scopeText: string;
  squareFeetEstimate: number | null;
  squareFeetEstimateLow: number | null;
  squareFeetEstimateHigh: number | null;
  estimatedDurationHoursLow: number | null;
  estimatedDurationHoursHigh: number | null;
  customerPriceSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  internalCostSubtotal?: number;
  lineItems: readonly QuotePreparationLine[];
  /**
   * Operator-only, governed workspace facts that informed preparation. These
   * are never promoted to customer-facing scope or pricing automatically.
   */
  workspaceContext: readonly Readonly<{
    citationKey: string;
    label: string;
    sourceType: string;
    fact: string;
  }>[];
  requiresPricingReview: boolean;
}>;

export type QuotePreparationClarificationCode =
  | "CUSTOMER_REQUIRED"
  | "CUSTOMER_NAME_REQUIRED"
  | "CUSTOMER_PHONE_REQUIRED"
  | "CUSTOMER_SELECTION_REQUIRED"
  | "WORK_REQUIRED";

export type QuotePreparationResult = Readonly<{
  preparationId: string;
  status: "READY" | "NEEDS_CLARIFICATION" | "CUSTOMER_AMBIGUOUS";
  customerResolution: "MATCHED" | "NEW_CUSTOMER_DRAFT" | "AMBIGUOUS" | "NONE";
  customer: QuotePreparationCustomer | null;
  customerDraft: Readonly<{
    fullName: string | null;
    email: string | null;
    phone: string | null;
  }>;
  customerCandidates: readonly QuotePreparationCustomer[];
  clarification: Readonly<{
    code: QuotePreparationClarificationCode;
    message: string;
  }> | null;
  draft: QuotePreparationDraft;
  sources: readonly Readonly<{
    key: string;
    label: string;
    sourceType: string;
    classification: DataClassification;
  }>[];
  retrievedSourceCount: number;
  retrievedSourceLabels: readonly string[];
  retrievalAuditEventId: string | null;
  retrievalDegraded: boolean;
  model: string;
  telemetry: AiTelemetryAccumulator;
}>;

export type PrepareQuoteReviewInput = Readonly<{
  access: AccessContext;
  prompt: string;
  customerId?: string | null;
  quoteId?: string | null;
  serviceTypeHint?: ServiceCategory | null;
  priorUserQueries?: readonly string[];
  providerMode?: "DETERMINISTIC" | "BOUNDED_ENHANCEMENT";
  providerBudget?: AiQuoteProviderBudget;
  telemetry?: AiTelemetryAccumulator;
  includeInternalCost?: boolean;
}>;

type SelectedQuote = Readonly<{
  id: string;
  title: string;
  scopeText: string;
  serviceType: ServiceCategory;
  customerId: string;
  customer: QuotePreparationCustomer;
}>;

const QUOTE_WORK_DETAIL_PATTERN =
  /\b(?:hvac|plumb(?:ing)?|roof(?:ing)?|floor(?:ing)?|garden(?:ing)?|landscap(?:ing)?|construction|repair|replace(?:ment)?|install(?:ation)?|inspect(?:ion)?|diagnos(?:e|is|tic)|service|maintenance|clean(?:ing|up)?|labor|material|fixture|faucet|toilet|sink|heater|pipe|drain|sewer|hours?|hrs?|sq\s*ft|sqft|square\s+feet|techo|plomeria|piso|jardineria|paisajismo|construccion|reparacion|reemplazo|instalacion|inspeccion|servicio|mano\s+de\s+obra|horas?)\b/i;

function roundCurrency(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function preparationId(input: PrepareQuoteReviewInput) {
  return createHash("sha256")
    .update([
      "QF_QUOTE_PREPARATION_V1",
      input.access.tenantId,
      input.access.tenantUserId,
      input.quoteId ?? "",
      input.customerId ?? "",
      input.prompt.trim(),
    ].join("\u001f"), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function normalizedEmail(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function normalizedPhoneDigits(value: string | null | undefined) {
  if (!value) return null;
  return normalizeUsPhoneDigits(value) ?? normalizePhoneSearchDigits(value) ?? null;
}

async function resolveCustomer(
  prisma: PrismaClient,
  access: AccessContext,
  input: {
    selectedCustomer: QuotePreparationCustomer | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
  },
) {
  if (input.selectedCustomer) {
    return { customer: input.selectedCustomer, candidates: [input.selectedCustomer] } as const;
  }

  const email = normalizedEmail(input.customerEmail);
  const phoneDigits = normalizedPhoneDigits(input.customerPhone);
  const assignedScope = assignedRecordScope(access);
  const select = { id: true, fullName: true, email: true, phone: true } as const;
  const orderBy = [{ updatedAt: "desc" as const }, { id: "desc" as const }];

  const exactContactMatches = email || phoneDigits
    ? await prisma.customer.findMany({
        where: {
          ...tenantActiveCustomerScope(access.tenantId),
          ...assignedScope,
          OR: [
            ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
            ...(phoneDigits ? [{ phoneDigits }] : []),
          ],
        },
        orderBy,
        take: 4,
        select,
      })
    : [];
  if (exactContactMatches.length) {
    return {
      customer: exactContactMatches.length === 1 ? exactContactMatches[0]! : null,
      candidates: exactContactMatches,
    } as const;
  }

  const customerName = input.customerName?.trim() ?? "";
  if (!customerName) return { customer: null, candidates: [] } as const;
  const exactNameMatches = await prisma.customer.findMany({
    where: {
      ...tenantActiveCustomerScope(access.tenantId),
      ...assignedScope,
      fullName: { equals: customerName, mode: "insensitive" },
    },
    orderBy,
    take: 4,
    select,
  });
  if (exactNameMatches.length) {
    return {
      customer: exactNameMatches.length === 1 ? exactNameMatches[0]! : null,
      candidates: exactNameMatches,
    } as const;
  }

  const partialNameMatches = await prisma.customer.findMany({
    where: {
      ...tenantActiveCustomerScope(access.tenantId),
      ...assignedScope,
      fullName: { contains: customerName, mode: "insensitive" },
    },
    orderBy,
    take: 4,
    select,
  });
  return {
    customer: partialNameMatches.length === 1 ? partialNameMatches[0]! : null,
    candidates: partialNameMatches,
  } as const;
}

function providerContext(input: {
  selectedQuote: SelectedQuote | null;
  customer: QuotePreparationCustomer | null;
  retrieval: AiRetrievalResult | null;
}) {
  const quoteSafeContext = input.retrieval?.chunks
    .filter((chunk) =>
      chunk.sourceField === "Quote.title"
      || chunk.sourceField === "Quote.scopeText"
      || chunk.sourceField === "QuoteLineItem.description"
      || chunk.sourceField === "WorkPreset.name"
      || chunk.sourceField === "WorkPreset.description",
    )
    .slice(0, 8)
    .map((chunk) => `[${chunk.citationKey}] ${chunk.citationLabel} | ${chunk.sourceField}\n${chunk.content}`)
    .join("\n\n")
    .trim();
  return [
    input.customer ? "An authorized customer record is selected." : null,
    input.selectedQuote
      ? `Current quote: ${input.selectedQuote.title}\nCurrent scope: ${input.selectedQuote.scopeText}`
      : null,
    quoteSafeContext || null,
  ].filter(Boolean).join("\n\n");
}

async function retrieveContext(
  prisma: PrismaClient,
  input: PrepareQuoteReviewInput,
  params: {
    query: string;
    serviceType: ServiceCategory;
    customerId: string | null;
    quoteId: string | null;
  },
) {
  try {
    return {
      result: await buildGovernedQuoteAiContext(prisma, {
        access: input.access,
        query: params.query,
        purpose: params.quoteId ? "QUOTE_REVISION" : "QUOTE_DRAFT",
        serviceType: params.serviceType,
        requestId: input.access.requestId,
        customerId: params.customerId,
        quoteId: params.quoteId,
        priorUserQueries: input.priorUserQueries,
        filters: {
          lifecycle: "active",
          serviceTypes: [params.serviceType],
          // Until a customer is authorized, only reusable tenant presets may
          // participate. Once resolved, quote history is restricted to that
          // customer and service; arbitrary customer notes/activity remain
          // outside the customer-facing preparation provider boundary.
          sourceTypes: params.customerId
            ? ["Quote", "QuoteLineItem"]
            : ["WorkPreset"],
          // Once a customer has been authorized, retrieval must stay on that
          // customer. This prevents another customer's otherwise-authorized
          // workspace facts from influencing this preparation.
          ...(params.customerId ? { customerId: params.customerId } : {}),
        },
        refreshIndex: Boolean(params.customerId || params.quoteId),
        allowProviderCalls: false,
      }),
      degraded: false,
    } as const;
  } catch (error) {
    if (error instanceof AiUsageLedgerError) throw error;
    return { result: null, degraded: true } as const;
  }
}

function allocateExplicitPromptPricing(
  lines: Awaited<ReturnType<typeof prepareCatalogQuoteLines>>["lines"],
  parsed: ParsedChatToQuoteDraft,
  includeInternalCost: boolean,
): QuotePreparationLine[] {
  const explicitPrice = parsed.estimatedTotalAmount ?? 0;
  const explicitCost = includeInternalCost ? parsed.estimatedInternalCostAmount ?? 0 : 0;
  const included = lines.filter((line) => line.sectionType === "INCLUDED");
  const includedQuantity = Math.max(
    included.reduce((sum, line) => sum + Math.max(line.quantity, 1), 0),
    1,
  );
  const catalogPriceSubtotal = included.reduce(
    (sum, line) => sum + line.quantity * (line.unitPrice ?? 0),
    0,
  );
  const catalogCostSubtotal = included.reduce(
    (sum, line) => sum + line.quantity * (line.unitCost ?? 0),
    0,
  );

  const allocated = lines.map((line) => {
    const isIncluded = line.sectionType === "INCLUDED";
    const quantity = Math.max(line.quantity, 1);
    const quantityShare = quantity / includedQuantity;
    const unitPrice = explicitPrice > 0 && isIncluded
      ? catalogPriceSubtotal > 0
        ? (line.unitPrice ?? 0) * (explicitPrice / catalogPriceSubtotal)
        : explicitPrice * quantityShare / quantity
      : line.unitPrice ?? 0;
    const unitCost = includeInternalCost
      ? explicitCost > 0 && isIncluded
        ? catalogCostSubtotal > 0
          ? (line.unitCost ?? 0) * (explicitCost / catalogCostSubtotal)
          : explicitCost * quantityShare / quantity
        : line.unitCost ?? 0
      : undefined;
    return {
      description: line.description,
      quantity: line.quantity,
      sectionType: line.sectionType,
      sectionLabel: line.sectionLabel,
      sourcePresetId: explicitPrice > 0 && isIncluded ? null : line.sourcePresetId,
      catalogKey: line.catalogKey,
      unitType: line.unitType,
      unitPrice: roundCurrency(unitPrice),
      ...(includeInternalCost ? { unitCost: roundCurrency(unitCost ?? 0) } : {}),
      priceProvenance: explicitPrice > 0 && isIncluded
        ? "EXPLICIT_PROMPT" as const
        : line.priceProvenance,
    };
  });

  const reconcileTarget = (
    target: number,
    key: "unitPrice" | "unitCost",
  ) => {
    if (target <= 0) return;
    const includedLines = allocated.filter((line) => line.sectionType === "INCLUDED");
    const adjustmentLine = [...includedLines]
      .reverse()
      .find((line) => line.quantity === 1) ?? includedLines.at(-1);
    if (!adjustmentLine) return;
    const otherSubtotal = allocated.reduce((sum, line) => {
      if (line.sectionType !== "INCLUDED" || line === adjustmentLine) return sum;
      return sum + line.quantity * (key === "unitPrice" ? line.unitPrice : line.unitCost ?? 0);
    }, 0);
    const adjustedUnitAmount = roundCurrency((target - otherSubtotal) / Math.max(adjustmentLine.quantity, 1));
    if (key === "unitPrice") {
      (adjustmentLine as { unitPrice: number }).unitPrice = Math.max(0, adjustedUnitAmount);
    } else {
      (adjustmentLine as { unitCost?: number }).unitCost = Math.max(0, adjustedUnitAmount);
    }
  };
  reconcileTarget(explicitPrice, "unitPrice");
  if (includeInternalCost) reconcileTarget(explicitCost, "unitCost");
  return allocated;
}

function clarificationFor(input: {
  selectedQuote: SelectedQuote | null;
  parsed: ParsedChatToQuoteDraft;
  customer: QuotePreparationCustomer | null;
  candidates: readonly QuotePreparationCustomer[];
  prompt: string;
}) {
  if (input.candidates.length > 1) {
    return {
      status: "CUSTOMER_AMBIGUOUS" as const,
      code: "CUSTOMER_SELECTION_REQUIRED" as const,
      message: `I found ${input.candidates.length} matching customers. Choose the correct customer to continue.`,
    };
  }
  if (!input.customer && !input.parsed.customerName && !input.parsed.customerEmail && !input.parsed.customerPhone) {
    return {
      status: "NEEDS_CLARIFICATION" as const,
      code: "CUSTOMER_REQUIRED" as const,
      message: "Who is this quote for? Reply with the customer name, email, or phone number.",
    };
  }
  if (!input.customer && !input.parsed.customerName) {
    return {
      status: "NEEDS_CLARIFICATION" as const,
      code: "CUSTOMER_NAME_REQUIRED" as const,
      message: "I could not find that customer. Reply with the customer's name so I can prepare a new linked customer.",
    };
  }
  if (!input.customer && !input.parsed.customerPhone) {
    return {
      status: "NEEDS_CLARIFICATION" as const,
      code: "CUSTOMER_PHONE_REQUIRED" as const,
      message: `I could not find an active assigned customer${input.parsed.customerName ? ` named ${input.parsed.customerName}` : ""}. Reply with the phone number to prepare a new linked customer, or provide another email or phone to search again.`,
    };
  }
  if (!input.selectedQuote && !QUOTE_WORK_DETAIL_PATTERN.test(input.prompt)) {
    return {
      status: "NEEDS_CLARIFICATION" as const,
      code: "WORK_REQUIRED" as const,
      message: "What work should this quote cover? Reply with the trade and job, product, or service.",
    };
  }
  return null;
}

/**
 * Authoritative, review-only Kody quote preparation boundary.
 *
 * This service may refresh governed retrieval indexes and audit retrieval, but
 * it never creates or updates a customer, quote, job, invoice, or line item.
 * Domain mutations remain behind the normal reviewed quote/customer routes.
 */
export async function prepareQuoteReview(
  prisma: PrismaClient,
  input: PrepareQuoteReviewInput,
): Promise<QuotePreparationResult> {
  const prompt = input.prompt.trim();
  const includeInternalCost = Boolean(
    input.includeInternalCost && hasCapability(input.access, "viewInternalCosts"),
  );
  const assignedScope = assignedRecordScope(input.access);
  const selectedQuote = input.quoteId
    ? await prisma.quote.findFirst({
        where: {
          id: input.quoteId,
          ...tenantActiveQuoteScope(input.access.tenantId),
          ...assignedScope,
        },
        select: {
          id: true,
          title: true,
          scopeText: true,
          serviceType: true,
          customerId: true,
          customer: { select: { id: true, fullName: true, email: true, phone: true } },
        },
      })
    : null;
  const requestedCustomerId = input.customerId ?? selectedQuote?.customerId ?? null;
  const selectedCustomer = selectedQuote?.customer ?? (requestedCustomerId
    ? await prisma.customer.findFirst({
        where: {
          id: requestedCustomerId,
          ...tenantActiveCustomerScope(input.access.tenantId),
          ...assignedScope,
        },
        select: { id: true, fullName: true, email: true, phone: true },
      })
    : null);

  const deterministicParsed = parseChatToQuotePrompt(prompt);
  let parsed = deterministicParsed;
  let resolution = await resolveCustomer(prisma, input.access, {
    selectedCustomer,
    customerName: parsed.customerName,
    customerEmail: parsed.customerEmail,
    customerPhone: parsed.customerPhone,
  });
  let serviceType = input.serviceTypeHint ?? selectedQuote?.serviceType ?? parsed.serviceType;
  const preliminaryClarification = clarificationFor({
    selectedQuote,
    parsed,
    customer: resolution.customer,
    candidates: resolution.candidates,
    prompt,
  });
  let retrieval = preliminaryClarification
    ? { result: null, degraded: false } as const
    : await retrieveContext(prisma, input, {
        query: prompt,
        serviceType,
        customerId: resolution.customer?.id ?? null,
        quoteId: selectedQuote?.id ?? null,
      });
  let retrievalDegraded = retrieval.degraded;
  const telemetry = input.telemetry ?? createAiTelemetryAccumulator();

  if (input.providerMode === "BOUNDED_ENHANCEMENT" && !preliminaryClarification) {
    const providerParsed = await aiParseChatToQuotePrompt(prompt, {
      context: providerContext({
        selectedQuote,
        customer: resolution.customer,
        retrieval: retrieval.result,
      }),
      sensitiveValues: [
        resolution.customer?.fullName,
        resolution.customer?.email,
        resolution.customer?.phone,
        deterministicParsed.customerName,
        deterministicParsed.customerEmail,
        deterministicParsed.customerPhone,
      ],
      telemetry,
      providerBudget: input.providerBudget,
      diagnosticContext: { requestId: input.access.requestId },
    });
    // The provider may improve trade, scope, title, and work lines, but it is
    // never an authorization source for a customer record. Customer identity
    // remains bound to the selected record or deterministic prompt lookup.
    parsed = {
      ...providerParsed,
      customerName: deterministicParsed.customerName,
      customerEmail: deterministicParsed.customerEmail,
      customerPhone: deterministicParsed.customerPhone,
    };
    serviceType = input.serviceTypeHint ?? selectedQuote?.serviceType ?? parsed.serviceType;
    if (serviceType !== (input.serviceTypeHint ?? selectedQuote?.serviceType ?? deterministicParsed.serviceType)) {
      retrieval = await retrieveContext(prisma, input, {
        query: prompt,
        serviceType,
        customerId: resolution.customer?.id ?? null,
        quoteId: selectedQuote?.id ?? null,
      });
      retrievalDegraded ||= retrieval.degraded;
    }
  }

  const preparedCatalog = await prepareCatalogQuoteLines(prisma, {
    tenantId: input.access.tenantId,
    serviceType,
    prompt,
    parsedLines: parsed.lineItems,
    estimatedDurationHoursHigh: parsed.estimatedDurationHoursHigh,
    includeInternalCost,
  });
  const lineItems = allocateExplicitPromptPricing(preparedCatalog.lines, deterministicParsed, includeInternalCost);
  const customerPriceSubtotal = roundCurrency(lineItems.reduce(
    (sum, line) => line.sectionType === "INCLUDED" ? sum + line.quantity * line.unitPrice : sum,
    0,
  ));
  const taxAmount = roundCurrency(deterministicParsed.estimatedTaxAmount ?? 0);
  const internalCostSubtotal = includeInternalCost
    ? roundCurrency(lineItems.reduce(
        (sum, line) => line.sectionType === "INCLUDED" ? sum + line.quantity * (line.unitCost ?? 0) : sum,
        0,
      ))
    : undefined;
  const requiresPricingReview = lineItems.some(
    (line) => line.sectionType === "INCLUDED" && (line.priceProvenance === "UNRESOLVED" || line.unitPrice <= 0),
  );
  const clarification = preliminaryClarification ?? clarificationFor({
      selectedQuote,
      parsed,
      customer: resolution.customer,
      candidates: resolution.candidates,
      prompt,
    });
  const customerResolution = resolution.candidates.length > 1
    ? "AMBIGUOUS" as const
    : resolution.customer
      ? "MATCHED" as const
      : parsed.customerName && parsed.customerPhone
        ? "NEW_CUSTOMER_DRAFT" as const
        : "NONE" as const;
  const retrievalSources = retrieval.result?.citations.map((citation) => ({
    key: citation.key,
    label: citation.label,
    sourceType: citation.sourceType,
    classification: citation.classification,
  })) ?? [];
  const catalogSources = preparedCatalog.matchedPresetLabels.map((label, index) => ({
    key: `P${index + 1}`,
    label,
    sourceType: "WorkPreset",
    classification: includeInternalCost
      ? "C3_FINANCIAL_CONFIDENTIAL" as const
      : "C1_BUSINESS_INTERNAL" as const,
  }));
  const retrievedSourceLabels = Array.from(new Set([
    ...preparedCatalog.matchedPresetLabels,
    ...retrievalSources.map((source) => source.label),
  ])).slice(0, 8);
  const workspaceContext = (retrieval.result?.chunks ?? [])
    .filter((chunk) => chunk.classification !== "C3_FINANCIAL_CONFIDENTIAL" && chunk.classification !== "C4_RESTRICTED")
    .slice(0, 4)
    .map((chunk) => ({
      citationKey: chunk.citationKey,
      label: chunk.citationLabel,
      sourceType: chunk.sourceType,
      fact: chunk.content.replace(/\s+/g, " ").trim().slice(0, 500),
    }))
    .filter((fact) => Boolean(fact.fact));

  return {
    preparationId: preparationId(input),
    status: clarification?.status ?? "READY",
    customerResolution,
    customer: resolution.customer,
    customerDraft: {
      fullName: resolution.customer?.fullName ?? parsed.customerName ?? null,
      email: resolution.customer?.email ?? normalizedEmail(parsed.customerEmail),
      phone: resolution.customer?.phone ?? parsed.customerPhone ?? null,
    },
    customerCandidates: resolution.candidates.length > 1 ? resolution.candidates : [],
    clarification: clarification
      ? { code: clarification.code, message: clarification.message }
      : null,
    draft: {
      quoteId: selectedQuote?.id ?? null,
      serviceType,
      title: selectedQuote?.title || parsed.title,
      scopeText: selectedQuote?.scopeText || parsed.scopeText || prompt,
      squareFeetEstimate: parsed.squareFeetEstimate,
      squareFeetEstimateLow: parsed.squareFeetEstimateLow,
      squareFeetEstimateHigh: parsed.squareFeetEstimateHigh,
      estimatedDurationHoursLow: parsed.estimatedDurationHoursLow,
      estimatedDurationHoursHigh: parsed.estimatedDurationHoursHigh,
      customerPriceSubtotal,
      taxAmount,
      totalAmount: roundCurrency(customerPriceSubtotal + taxAmount),
      ...(includeInternalCost ? { internalCostSubtotal } : {}),
      lineItems,
      workspaceContext,
      requiresPricingReview,
    },
    sources: [...catalogSources, ...retrievalSources],
    retrievedSourceCount: catalogSources.length + retrievalSources.length,
    retrievedSourceLabels,
    retrievalAuditEventId: retrieval.result?.auditEventId ?? null,
    retrievalDegraded,
    model: getAiQuoteRuntimeInfo().model,
    telemetry,
  };
}
