import type {
  AiAssistantAction,
  AiAssistantCitation,
  AiAssistantRequestedTool,
  AiAssistantResponse,
  AiAssistantTool,
  DataClassification,
} from "../../lib/api";

type AssistantPayload = AiAssistantResponse["assistant"];
type AssistantDiagnostics = AssistantPayload["diagnostics"];
type AssistantResult = Record<string, string | number | boolean | null>;

const DATA_CLASSIFICATIONS: DataClassification[] = [
  "C0_PUBLIC",
  "C1_BUSINESS_INTERNAL",
  "C2_CUSTOMER_CONFIDENTIAL",
  "C3_FINANCIAL_CONFIDENTIAL",
  "C4_RESTRICTED",
];

const ASSISTANT_TOOLS: AiAssistantTool[] = [
  "ASSISTANT_HELP",
  "OUT_OF_SCOPE",
  "NAVIGATE_WORKSPACE",
  "FOLLOW_UP_QUEUE",
  "LIST_SCHEDULE",
  "LIST_MY_ACTIVITIES",
  "PRIORITIZE_MY_DAY",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SEARCH_PRODUCTS",
  "SEARCH_JOBS",
  "GET_JOB_STATUS",
  "LIST_INVOICES",
  "GET_INVOICE_STATUS",
  "GET_QUICKBOOKS_SETUP_STATUS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_CUSTOMER",
  "DRAFT_PRODUCT",
  "DRAFT_QUOTE",
  "PREPARE_BOOKING",
  "PREPARE_DISPATCH",
  "PREPARE_ACTIVITY",
  "PREPARE_QUOTE_SEND",
];

const REQUESTED_TOOLS: AiAssistantRequestedTool[] = ["AUTO", ...ASSISTANT_TOOLS];

const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  C0_PUBLIC: 0,
  C1_BUSINESS_INTERNAL: 1,
  C2_CUSTOMER_CONFIDENTIAL: 2,
  C3_FINANCIAL_CONFIDENTIAL: 3,
  C4_RESTRICTED: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDataClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && DATA_CLASSIFICATIONS.includes(value as DataClassification);
}

function isAssistantTool(value: unknown): value is AiAssistantTool {
  return typeof value === "string" && ASSISTANT_TOOLS.includes(value as AiAssistantTool);
}

function isRequestedTool(value: unknown): value is AiAssistantRequestedTool {
  return typeof value === "string" && REQUESTED_TOOLS.includes(value as AiAssistantRequestedTool);
}

function isAssistantActionType(value: unknown): value is AiAssistantAction["type"] {
  return (
    value === "OPEN_CUSTOMER" ||
    value === "OPEN_CUSTOMER_DRAFT" ||
    value === "OPEN_PRODUCT_DRAFT" ||
    value === "OPEN_QUOTE_DRAFT" ||
    value === "OPEN_QUOTE_SEND" ||
    value === "OPEN_ACTIVITY_DRAFT" ||
    value === "OPEN_SCHEDULE" ||
    value === "OPEN_BOOKING_REVIEW" ||
    value === "OPEN_DISPATCH_REVIEW" ||
    value === "OPEN_ANALYTICS" ||
    value === "OPEN_WORKSPACE_PAGE" ||
    value === "OPEN_QUICKBOOKS_SETUP" ||
    value === "REQUEST_ADMIN_ACCESS"
  );
}

function actionLabelForType(type: AiAssistantAction["type"]) {
  // This is an internal fallback only. Presentation maps the canonical action
  // type through the active locale and never routes from this display label.
  return type;
}

const REVIEW_ACTION_TYPES = new Set<AiAssistantAction["type"]>([
  "OPEN_CUSTOMER_DRAFT",
  "OPEN_PRODUCT_DRAFT",
  "OPEN_QUOTE_DRAFT",
  "OPEN_QUOTE_SEND",
  "OPEN_ACTIVITY_DRAFT",
]);

const NAVIGATE_TO_REVIEW_ACTION_TYPES = new Set<AiAssistantAction["type"]>([
  "OPEN_BOOKING_REVIEW",
  "OPEN_DISPATCH_REVIEW",
]);

function copyString(payload: Record<string, unknown>, source: Record<string, unknown>, key: string, maxLength = 2_000) {
  const value = getString(source[key]);
  if (value && value.length <= maxLength) payload[key] = value;
}

function copyNumber(payload: Record<string, unknown>, source: Record<string, unknown>, key: string) {
  const value = getFiniteNumber(source[key]);
  if (value !== null) payload[key] = value;
}

function copyBoolean(payload: Record<string, unknown>, source: Record<string, unknown>, key: string) {
  if (typeof source[key] === "boolean") payload[key] = source[key];
}

function sanitizeQuoteLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const description = getString(candidate.description);
    if (!description || description.length > 500) return [];
    const line: Record<string, string | number | boolean> = { description };
    const quantity = getFiniteNumber(candidate.quantity);
    if (quantity !== null && quantity >= 0) line.quantity = quantity;
    if (candidate.sectionType === "INCLUDED" || candidate.sectionType === "ALTERNATE") {
      line.sectionType = candidate.sectionType;
    }
    const sectionLabel = getString(candidate.sectionLabel);
    if (sectionLabel && sectionLabel.length <= 120) line.sectionLabel = sectionLabel;
    const sourcePresetId = getString(candidate.sourcePresetId);
    if (sourcePresetId && sourcePresetId.length <= 200) line.sourcePresetId = sourcePresetId;
    const catalogKey = getString(candidate.catalogKey);
    if (catalogKey && catalogKey.length <= 200) line.catalogKey = catalogKey;
    if (candidate.unitType === "FLAT" || candidate.unitType === "SQ_FT" || candidate.unitType === "HOUR" || candidate.unitType === "EACH") {
      line.unitType = candidate.unitType;
    }
    const unitPrice = getFiniteNumber(candidate.unitPrice);
    if (unitPrice !== null && unitPrice >= 0) line.unitPrice = unitPrice;
    const unitCost = getFiniteNumber(candidate.unitCost);
    if (unitCost !== null && unitCost >= 0) line.unitCost = unitCost;
    if (
      candidate.priceProvenance === "EXPLICIT_PROMPT" ||
      candidate.priceProvenance === "TENANT_PRESET" ||
      candidate.priceProvenance === "STANDARD_CATALOG" ||
      candidate.priceProvenance === "CURRENT_QUOTE" ||
      candidate.priceProvenance === "UNRESOLVED"
    ) {
      line.priceProvenance = candidate.priceProvenance;
    }
    if (candidate.catalogMatched === true) line.catalogMatched = true;
    return [line];
  });
}

function sanitizeStringList(value: unknown, limit: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((candidate) => {
    const stringValue = getString(candidate);
    return stringValue && stringValue.length <= maxLength ? [stringValue] : [];
  });
}

function sanitizeWorkspaceContext(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const citationKey = getString(candidate.citationKey);
    const label = getString(candidate.label);
    const sourceType = getString(candidate.sourceType);
    const fact = getString(candidate.fact);
    if (
      !citationKey || citationKey.length > 200 ||
      !label || label.length > 500 ||
      !sourceType || sourceType.length > 200 ||
      !fact || fact.length > 2_000
    ) return [];
    return [{ citationKey, label, sourceType, fact }];
  });
}

function sanitizeQuotePreparation(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.draft) || !isRecord(value.customerDraft)) return null;
  if (value.status !== "READY" && value.status !== "NEEDS_CLARIFICATION" && value.status !== "CUSTOMER_AMBIGUOUS") return null;
  if (
    value.customerResolution !== "MATCHED" &&
    value.customerResolution !== "NEW_CUSTOMER_DRAFT" &&
    value.customerResolution !== "AMBIGUOUS" &&
    value.customerResolution !== "NONE"
  ) return null;

  const preparation: Record<string, unknown> = {
    status: value.status,
    customerResolution: value.customerResolution,
    customerCandidates: [],
    sources: [],
    retrievedSourceLabels: sanitizeStringList(value.retrievedSourceLabels, 8, 160),
    retrievalDegraded: value.retrievalDegraded === true,
  };
  copyString(preparation, value, "preparationId", 200);
  copyString(preparation, value, "auditEventId", 200);
  copyString(preparation, value, "retrievalAuditEventId", 200);
  copyString(preparation, value, "model", 160);
  copyNumber(preparation, value, "retrievedSourceCount");

  const sanitizeCustomer = (candidate: unknown) => {
    if (!isRecord(candidate)) return null;
    const id = getString(candidate.id);
    const fullName = getString(candidate.fullName);
    if (!id || id.length > 200 || !fullName || fullName.length > 500) return null;
    return {
      id,
      fullName,
      email: getString(candidate.email)?.slice(0, 500) ?? null,
      phone: getString(candidate.phone)?.slice(0, 100) ?? null,
    };
  };
  preparation.customer = sanitizeCustomer(value.customer);
  preparation.customerCandidates = Array.isArray(value.customerCandidates)
    ? value.customerCandidates.slice(0, 4).flatMap((candidate) => {
        const customer = sanitizeCustomer(candidate);
        return customer ? [customer] : [];
      })
    : [];
  preparation.customerDraft = {
    fullName: getString(value.customerDraft.fullName)?.slice(0, 500) ?? null,
    email: getString(value.customerDraft.email)?.slice(0, 500) ?? null,
    phone: getString(value.customerDraft.phone)?.slice(0, 100) ?? null,
  };

  if (isRecord(value.clarification)) {
    const code = getString(value.clarification.code);
    const message = getString(value.clarification.message);
    if (code && message && message.length <= 1_000) {
      preparation.clarification = { code, message };
    }
  } else {
    preparation.clarification = null;
  }

  const draft: Record<string, unknown> = {
    lineItems: sanitizeQuoteLines(value.draft.lineItems),
    workspaceContext: sanitizeWorkspaceContext(value.draft.workspaceContext),
    requiresPricingReview: value.draft.requiresPricingReview === true,
  };
  for (const [key, maxLength] of [
    ["quoteId", 200], ["serviceType", 32], ["title", 500], ["scopeText", 4_000],
  ] as const) copyString(draft, value.draft, key, maxLength);
  for (const key of [
    "squareFeetEstimate", "squareFeetEstimateLow", "squareFeetEstimateHigh",
    "estimatedDurationHoursLow", "estimatedDurationHoursHigh", "customerPriceSubtotal",
    "taxAmount", "totalAmount", "internalCostSubtotal",
  ] as const) copyNumber(draft, value.draft, key);
  preparation.draft = draft;
  preparation.sources = Array.isArray(value.sources)
    ? value.sources.slice(0, 16).flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const key = getString(candidate.key);
        const label = getString(candidate.label);
        const sourceType = getString(candidate.sourceType);
        if (!key || !label || !sourceType || !isDataClassification(candidate.classification)) return [];
        return [{ key, label, sourceType, classification: candidate.classification }];
      })
    : [];
  return preparation;
}

function normalizeActionPayload(type: AiAssistantAction["type"], value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const payload: Record<string, unknown> = {};

  if (type === "OPEN_CUSTOMER") {
    copyString(payload, value, "customerId", 200);
  } else if (type === "OPEN_CUSTOMER_DRAFT") {
    for (const [key, maxLength] of [["fullName", 500], ["phone", 100], ["email", 500], ["notes", 2_000]] as const) {
      copyString(payload, value, key, maxLength);
    }
  } else if (type === "OPEN_PRODUCT_DRAFT") {
    for (const [key, maxLength] of [["serviceType", 32], ["name", 120], ["description", 500], ["category", 32], ["unitType", 32]] as const) {
      copyString(payload, value, key, maxLength);
    }
    for (const key of ["defaultQuantity", "unitCost", "unitPrice"] as const) copyNumber(payload, value, key);
  } else if (type === "OPEN_QUOTE_DRAFT") {
    for (const [key, maxLength] of [
      ["prompt", 2_000], ["customerId", 200], ["customerName", 500], ["customerEmail", 500],
      ["customerPhone", 100], ["quoteId", 200], ["serviceType", 32], ["title", 500], ["scopeText", 4_000],
      ["auditEventId", 200],
    ] as const) copyString(payload, value, key, maxLength);
    for (const key of ["squareFeetEstimate", "squareFeetEstimateLow", "squareFeetEstimateHigh", "estimatedDurationHoursLow", "estimatedDurationHoursHigh", "estimatedTotalAmount", "estimatedTaxAmount", "estimatedInternalCostAmount", "retrievedSourceCount"] as const) {
      copyNumber(payload, value, key);
    }
    copyBoolean(payload, value, "useWorkspaceContext");
    copyBoolean(payload, value, "requiresPricingReview");
    payload.lineItems = sanitizeQuoteLines(value.lineItems);
    payload.retrievedSourceLabels = sanitizeStringList(value.retrievedSourceLabels, 6, 160);
    const preparation = sanitizeQuotePreparation(value.preparation);
    if (preparation) payload.preparation = preparation;
  } else if (type === "OPEN_QUOTE_SEND") {
    for (const [key, maxLength] of [["quoteId", 200], ["quoteTitle", 500], ["quoteStatus", 40], ["customerName", 500], ["channel", 20], ["destination", 500]] as const) {
      copyString(payload, value, key, maxLength);
    }
    copyNumber(payload, value, "totalAmount");
  } else if (type === "OPEN_ACTIVITY_DRAFT") {
    for (const [key, maxLength] of [["customerId", 200], ["customerName", 500], ["quoteId", 200], ["quoteTitle", 500], ["type", 40], ["priority", 40], ["title", 500], ["dueAtUtc", 64]] as const) {
      copyString(payload, value, key, maxLength);
    }
  } else if (type === "OPEN_SCHEDULE") {
    const range = getString(value.range);
    if (range === "day" || range === "week" || range === "next7") payload.range = range;
    copyString(payload, value, "date", 10);
    copyBoolean(payload, value, "mine");
  } else if (type === "OPEN_BOOKING_REVIEW") {
    for (const [key, maxLength] of [
      ["mode", 12], ["jobId", 200], ["jobTitle", 500], ["customerId", 200], ["customerName", 500],
      ["assignedTenantUserId", 200], ["assigneeName", 500], ["startsAtUtc", 64], ["endsAtUtc", 64],
      ["timeZone", 120], ["appointmentId", 200], ["expectedStatus", 40],
    ] as const) copyString(payload, value, key, maxLength);
    copyNumber(payload, value, "jobNumber");
    copyNumber(payload, value, "appointmentVersion");
  } else if (type === "OPEN_DISPATCH_REVIEW") {
    for (const [key, maxLength] of [
      ["jobId", 200], ["jobTitle", 500], ["customerId", 200], ["customerName", 500], ["appointmentId", 200],
      ["expectedStatus", 40], ["startsAtUtc", 64], ["endsAtUtc", 64], ["timeZone", 120],
      ["assignedTenantUserId", 200], ["assigneeName", 500],
    ] as const) copyString(payload, value, key, maxLength);
    copyNumber(payload, value, "jobNumber");
    copyNumber(payload, value, "appointmentVersion");
  } else if (type === "OPEN_ANALYTICS") {
    for (const [key, maxLength] of [["referenceFromUtc", 64], ["insightTool", 64], ["dateFrom", 64], ["dateTo", 64], ["serviceType", 32]] as const) {
      copyString(payload, value, key, maxLength);
    }
    copyNumber(payload, value, "winRatePercent");
  } else if (type === "OPEN_WORKSPACE_PAGE") {
    copyString(payload, value, "page", 40);
    copyString(payload, value, "jobId", 200);
    copyString(payload, value, "invoiceId", 200);
    copyNumber(payload, value, "jobNumber");
    copyNumber(payload, value, "invoiceNumber");
  } else if (type === "OPEN_QUICKBOOKS_SETUP") {
    copyString(payload, value, "section", 80);
  } else if (type === "REQUEST_ADMIN_ACCESS") {
    copyString(payload, value, "capability", 80);
    const capabilities = sanitizeStringList(value.capabilities, 8, 80);
    if (capabilities.length) payload.capabilities = capabilities;
  }

  return payload;
}

function sanitizePrimitiveRecord(value: unknown): AssistantResult | null {
  if (!isRecord(value)) return null;
  const result: AssistantResult = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key.trim()) continue;
    if (
      rawValue === null ||
      typeof rawValue === "string" ||
      typeof rawValue === "boolean" ||
      (typeof rawValue === "number" && Number.isFinite(rawValue))
    ) {
      result[key] = rawValue;
    }
  }
  return Object.keys(result).length ? result : null;
}

function sanitizePrimitiveFilters(value: unknown): Record<string, string | number | boolean | null> {
  return sanitizePrimitiveRecord(value) ?? {};
}

function normalizeCitation(
  value: unknown,
  index: number,
  fallbackClassification: DataClassification,
): AiAssistantCitation | null {
  if (!isRecord(value)) return null;
  const classification = isDataClassification(value.classification)
    ? value.classification
    : fallbackClassification;
  return {
    key: getString(value.key) ?? `A${index + 1}`,
    label: getString(value.label) ?? `A${index + 1}`,
    sourceType: getString(value.sourceType) ?? "WORKSPACE",
    classification,
  };
}

function normalizeAction(value: unknown): AiAssistantAction | null {
  if (!isRecord(value) || !isAssistantActionType(value.type)) return null;
  return {
    type: value.type,
    label: getString(value.label) ?? actionLabelForType(value.type),
    requiresConfirmation: NAVIGATE_TO_REVIEW_ACTION_TYPES.has(value.type)
      ? false
      : REVIEW_ACTION_TYPES.has(value.type)
      ? true
      : typeof value.requiresConfirmation === "boolean"
        ? value.requiresConfirmation
        : true,
    payload: normalizeActionPayload(value.type, value.payload),
  };
}

function maxClassificationFromCitations(
  citations: readonly AiAssistantCitation[],
  fallback: DataClassification,
): DataClassification {
  return citations.reduce<DataClassification>(
    (current, citation) =>
      CLASSIFICATION_RANK[citation.classification] > CLASSIFICATION_RANK[current]
        ? citation.classification
        : current,
    fallback,
  );
}

function normalizeAnswerMode(value: unknown): AssistantDiagnostics["answerMode"] {
  return value === "LLM_COMPOSED" ? "LLM_COMPOSED" : "DETERMINISTIC";
}

export function normalizeKodyAssistantResponse(response: unknown): AssistantPayload {
  const raw = isRecord(response) ? response : {};
  const rawDiagnostics = isRecord(raw.diagnostics) ? raw.diagnostics : {};
  const rawMaxClassification = isDataClassification(raw.maxClassification)
    ? raw.maxClassification
    : null;
  const citationFallback = rawMaxClassification ?? "C1_BUSINESS_INTERNAL";
  const citations = Array.isArray(raw.citations)
    ? raw.citations
        .map((citation, index) => normalizeCitation(citation, index, citationFallback))
        .filter((citation): citation is AiAssistantCitation => citation !== null)
    : [];
  const maxClassification =
    rawMaxClassification ?? maxClassificationFromCitations(citations, "C1_BUSINESS_INTERNAL");
  const results = Array.isArray(raw.results)
    ? raw.results
        .map(sanitizePrimitiveRecord)
        .filter((result): result is AssistantResult => result !== null)
    : [];
  const actions = Array.isArray(raw.actions)
    ? raw.actions
        .map(normalizeAction)
        .filter((action): action is AiAssistantAction => action !== null)
    : [];
  const fieldsExcluded = Array.isArray(raw.fieldsExcluded)
    ? raw.fieldsExcluded.filter((field): field is string => typeof field === "string" && Boolean(field.trim()))
    : [];
  const tool = isAssistantTool(raw.tool)
    ? raw.tool
    : isAssistantTool(rawDiagnostics.resolvedTool)
      ? rawDiagnostics.resolvedTool
      : "OUT_OF_SCOPE";
  const resolvedTool = isAssistantTool(rawDiagnostics.resolvedTool) ? rawDiagnostics.resolvedTool : tool;
  const rawConversation = isRecord(raw.conversation) ? raw.conversation : {};
  const previousTool = isAssistantTool(rawConversation.previousTool) ? rawConversation.previousTool : null;
  const currentTool = isAssistantTool(rawConversation.currentTool) ? rawConversation.currentTool : resolvedTool;
  const conversationMode = rawConversation.mode === "SHIFTED" || rawConversation.mode === "CONTINUING"
    ? rawConversation.mode
    : "NEW";

  return {
    tool,
    generatedAtUtc: getString(raw.generatedAtUtc) ?? "1970-01-01T00:00:00.000Z",
    policyVersion: getString(raw.policyVersion) ?? "unknown",
    maxClassification,
    answer: getString(raw.answer) ?? "",
    results,
    citations,
    actions,
    auditEventId: getString(raw.auditEventId) ?? "audit-unavailable",
    fieldsExcluded,
    conversation: {
      mode: conversationMode,
      acknowledgement: conversationMode === "SHIFTED" ? getString(rawConversation.acknowledgement) : null,
      previousTool,
      currentTool,
    },
    diagnostics: {
      requestedTool: isRequestedTool(rawDiagnostics.requestedTool) ? rawDiagnostics.requestedTool : "AUTO",
      resolvedTool,
      resultCount: getFiniteNumber(rawDiagnostics.resultCount) ?? results.length,
      citationCount: getFiniteNumber(rawDiagnostics.citationCount) ?? citations.length,
      emptyReason: getString(rawDiagnostics.emptyReason),
      archivePolicy: getString(rawDiagnostics.archivePolicy) ?? "TENANT_ACTIVE_ONLY",
      filters: sanitizePrimitiveFilters(rawDiagnostics.filters),
      answerMode: normalizeAnswerMode(rawDiagnostics.answerMode),
      model: getString(rawDiagnostics.model),
    },
  };
}
