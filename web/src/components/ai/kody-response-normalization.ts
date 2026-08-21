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
  "LIST_MY_ACTIVITIES",
  "PRIORITIZE_MY_DAY",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SEARCH_PRODUCTS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_CUSTOMER",
  "DRAFT_PRODUCT",
  "DRAFT_QUOTE",
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
    value === "OPEN_ANALYTICS" ||
    value === "OPEN_WORKSPACE_PAGE" ||
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
    requiresConfirmation: REVIEW_ACTION_TYPES.has(value.type)
      ? true
      : typeof value.requiresConfirmation === "boolean"
        ? value.requiresConfirmation
        : true,
    payload: isRecord(value.payload) ? value.payload : {},
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
