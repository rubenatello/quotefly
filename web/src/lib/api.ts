import { trackEvent } from "./analytics";
import { normalizeQuickBooksInvoiceReviewOptions } from "./quickbooks-payment-link";

const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? "http://localhost:4000";
const SLOW_API_REQUEST_MS = 1_500;
const VERY_SLOW_API_REQUEST_MS = 5_000;

type RequestTelemetry = {
  route: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs: number;
  requestId: string | null;
  slowBucket: "normal" | "slow" | "very_slow";
};

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

function stripQueryString(path: string): string {
  return path.split("?")[0] ?? path;
}

function maskPathIdentifiers(pathname: string): string {
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/[a-z][a-z0-9]*_[A-Za-z0-9_-]{8,}(?=\/|$)/g, "/:id")
    .replace(/\/(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id");
}

export function apiTelemetryRoute(path: string): string {
  const pathname = stripQueryString(path)
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\/+$/, "");

  if (pathname === "/v1/auth/me") return "/v1/auth/me";
  if (pathname.startsWith("/v1/auth/")) return "/v1/auth/:action";
  if (pathname.startsWith("/v1/internal/ai-quality/assistant-test")) return "/v1/internal/ai-quality/assistant-test";
  if (pathname.startsWith("/v1/internal/ai-quality/feedback")) return "/v1/internal/ai-quality/feedback";
  if (pathname.startsWith("/v1/ai/assistant")) return "/v1/ai/assistant";
  if (pathname.startsWith("/v1/ai/business-insights")) return "/v1/ai/business-insights";
  if (pathname.startsWith("/v1/quote-drafts/")) return "/v1/quote-drafts/:scope";
  if (pathname.startsWith("/v1/customers/") && pathname.endsWith("/activity")) return "/v1/customers/:id/activity";
  if (pathname.startsWith("/v1/customers/") && pathname.endsWith("/archive")) return "/v1/customers/:id/archive";
  if (pathname.startsWith("/v1/customers/") && pathname.endsWith("/restore")) return "/v1/customers/:id/restore";
  if (pathname.startsWith("/v1/customers/")) return "/v1/customers/:id";
  if (pathname === "/v1/customers") return "/v1/customers";
  if (pathname.startsWith("/v1/quotes/") && pathname.includes("/line-items/")) return "/v1/quotes/:id/line-items/:id";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/line-items")) return "/v1/quotes/:id/line-items";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/history")) return "/v1/quotes/:id/history";
  if (pathname.startsWith("/v1/quotes/") && pathname.includes("/history/")) return "/v1/quotes/:id/history/:id/restore";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/ai-runs")) return "/v1/quotes/:id/ai-runs";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/outbound-events")) return "/v1/quotes/:id/outbound-events";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/confirm-send")) return "/v1/quotes/:id/confirm-send";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/decision")) return "/v1/quotes/:id/decision";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/sheet")) return "/v1/quotes/:id/sheet";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/archive")) return "/v1/quotes/:id/archive";
  if (pathname.startsWith("/v1/quotes/") && pathname.endsWith("/pdf")) return "/v1/quotes/:id/pdf";
  if (pathname === "/v1/quotes/chat-draft") return "/v1/quotes/chat-draft";
  if (pathname === "/v1/quotes/ai-suggest") return "/v1/quotes/ai-suggest";
  if (pathname === "/v1/quotes/history") return "/v1/quotes/history";
  if (pathname === "/v1/quotes/invoices/export-csv") return "/v1/quotes/invoices/export-csv";
  if (pathname.startsWith("/v1/quotes/")) return "/v1/quotes/:id";
  if (pathname === "/v1/quotes") return "/v1/quotes";
  if (pathname === "/v1/notifications/summary") return "/v1/notifications/summary";
  if (pathname === "/v1/notifications/read-all") return "/v1/notifications/read-all";
  if (pathname.startsWith("/v1/notifications/") && pathname.endsWith("/read")) return "/v1/notifications/:id/read";
  if (pathname === "/v1/notifications") return "/v1/notifications";
  if (pathname.startsWith("/v1/products/")) return "/v1/products/:id";
  if (pathname === "/v1/products") return "/v1/products";
  if (pathname.startsWith("/v1/internal/control-plane")) return maskPathIdentifiers(pathname);
  if (pathname.startsWith("/v1/")) return maskPathIdentifiers(pathname);
  return "/unknown";
}

function slowBucket(durationMs: number): RequestTelemetry["slowBucket"] {
  if (durationMs >= VERY_SLOW_API_REQUEST_MS) return "very_slow";
  if (durationMs >= SLOW_API_REQUEST_MS) return "slow";
  return "normal";
}

function methodFromOptions(options: RequestInit): string {
  return (options.method ?? "GET").toUpperCase();
}

function durationSince(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function trackApiRequest(telemetry: RequestTelemetry) {
  if (telemetry.slowBucket === "normal" && telemetry.ok) return;
  trackEvent("api_request_latency", {
    route: telemetry.route,
    method: telemetry.method,
    status: telemetry.status,
    ok: telemetry.ok,
    durationMs: telemetry.durationMs,
    requestId: telemetry.requestId,
    slowBucket: telemetry.slowBucket,
  });
}

function buildRequestTelemetry(
  path: string,
  options: RequestInit,
  response: Response,
  startedAt: number,
): RequestTelemetry {
  const durationMs = durationSince(startedAt);
  return {
    route: apiTelemetryRoute(path),
    method: methodFromOptions(options),
    status: response.status,
    ok: response.ok,
    durationMs,
    requestId: response.headers.get("x-request-id"),
    slowBucket: slowBucket(durationMs),
  };
}

function buildFailedRequestTelemetry(path: string, options: RequestInit, startedAt: number): RequestTelemetry {
  const durationMs = durationSince(startedAt);
  return {
    route: apiTelemetryRoute(path),
    method: methodFromOptions(options),
    status: 0,
    ok: false,
    durationMs,
    requestId: null,
    slowBucket: slowBucket(durationMs),
  };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const body = options.body;
  const hasBody = body !== undefined && body !== null;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  const isUrlSearchParams =
    typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams;

  if (
    hasBody &&
    !headers.has("Content-Type") &&
    !isFormData &&
    !isBlob &&
    !isUrlSearchParams
  ) {
    headers.set("Content-Type", "application/json");
  }

  if (!hasBody && headers.has("Content-Type")) {
    headers.delete("Content-Type");
  }

  const startedAt = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      body,
      credentials: options.credentials ?? "include",
      headers,
    });
  } catch (error) {
    trackApiRequest(buildFailedRequestTelemetry(path, options, startedAt));
    throw error;
  }
  trackApiRequest(buildRequestTelemetry(path, options, res, startedAt));

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `Request failed: ${res.status}`;
    throw new ApiError(message, res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

async function requestBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  const startedAt = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: options.credentials ?? "include",
      headers,
    });
  } catch (error) {
    trackApiRequest(buildFailedRequestTelemetry(path, options, startedAt));
    throw error;
  }
  trackApiRequest(buildRequestTelemetry(path, options, res, startedAt));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `Request failed: ${res.status}`;
    throw new ApiError(message, res.status, body);
  }

  return res.blob();
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly code: string | null;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code =
      details && typeof details === "object" && "code" in details && typeof details.code === "string"
        ? details.code
        : null;
  }
}

export type SupportedLocale = "en-US" | "es-US";

export type AuthPayload = {
  user: { id: string; email: string; fullName: string; preferredLocale: SupportedLocale };
  tenant: { id: string; name: string; slug: string };
};

export type QuoteDraftRecoveryPayload = Record<string, unknown> & {
  version: 1;
  savedAtUtc: string;
};

export type QuoteDraftRecovery = {
  payload: QuoteDraftRecoveryPayload;
  savedAtUtc: string;
  expiresAtUtc: string;
};

export type PlanCode = "starter" | "professional" | "enterprise";
export type TenantAccessReason =
  | "superuser"
  | "trial"
  | "paid"
  | "payment_required"
  | "past_due"
  | "inactive";

export type TenantEntitlements = {
  planCode: PlanCode;
  planName: string;
  seatPlanCode: PlanCode;
  seatPlanName: string;
  isTrial: boolean;
  hasWorkspaceAccess: boolean;
  billingRequired: boolean;
  accessReason: TenantAccessReason;
  limits: {
    quotesPerMonth: number | null;
    aiQuotesPerMonth: number | null;
    aiSpendUsdPerMonth: number | null;
    teamMembers: number | null;
    quoteHistoryDays: number | null;
  };
  features: {
    quoteVersionHistory: boolean;
    communicationLog: boolean;
    advancedAnalytics: boolean;
    multiTrade: boolean;
    apiAccess: boolean;
    auditLogs: boolean;
    aiAutomation: boolean;
  };
};

export type TenantUsageSnapshot = {
  periodStartUtc: string;
  periodEndUtc: string;
  periodSource?: AiUsagePeriodSource;
  billingCycleReconciliationPending?: boolean;
  monthlyQuoteCount: number;
  monthlyAiQuoteCount: number;
  monthlyAiSpendUsd?: number;
  monthlyAiSpendLimitUsd?: number | null;
  monthlyAiSpendRemainingUsd?: number | null;
  monthlyAiSpendUsagePercent?: number | null;
  monthlyAiSpendWarningThresholdPercent?: 25 | 50 | 75 | 85 | 95 | 100 | null;
  monthlyAiLimitReached?: boolean;
  monthlyAiEstimatedPromptsRemaining?: number | null;
  monthlyUsageCompletedPercent?: number | null;
  monthlyUsageReservedPercent?: number | null;
  monthlyUsageEffectivePercent?: number | null;
  monthlyUsageRemainingPercent?: number | null;
  activeReservationCount?: number;
  enforcementMode?: "SPEND" | "CREDITS" | "UNLIMITED";
  limitReached?: boolean;
};

export type AiUsagePeriodSource =
  | "PAID_SUBSCRIPTION"
  | "ACTIVE_TRIAL"
  | "UTC_CALENDAR_SUPERUSER"
  | "UTC_CALENDAR_LEGACY"
  | "UTC_CALENDAR";

export type AuthSessionPayload = {
  user: {
    id: string;
    email: string;
    fullName: string;
    preferredLocale: SupportedLocale;
    createdAt: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    timezone?: string;
    primaryTrade?: ServiceType | null;
    onboardingCompletedAtUtc?: string | null;
    subscriptionStatus?: string;
    subscriptionPlanCode?: string | null;
    trialEndsAtUtc?: string | null;
    subscriptionCurrentPeriodEndUtc?: string | null;
    effectivePlanCode?: PlanCode;
    effectivePlanName?: string;
    isTrial?: boolean;
    entitlements?: TenantEntitlements;
    usage?: TenantUsageSnapshot;
  };
  role: string;
  isSuperuser?: boolean;
};

export type InternalAiQualitySummary = {
  windowDays: number;
  windowStartUtc: string;
  generatedAtUtc: string;
  totals: {
    totalRuns: number;
    activeTenants: number;
    totalCreditsConsumed: number;
    totalSpendUsd: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
  };
  averages: {
    spendUsdPerRun: number;
    promptTokensPerRun: number;
    completionTokensPerRun: number;
    totalTokensPerRun: number;
  };
  confidence: {
    high: number;
    medium: number;
    low: number;
  };
  quality: {
    noPatchRuns: number;
    noPatchRatePct: number;
    lowConfidenceRuns: number;
    lowConfidenceRatePct: number;
    regexFallbackRuns: number;
    regexFallbackRatePct: number;
  };
  qualitySignals: Array<{
    key: string;
    label: string;
    count: number;
    ratePct: number;
  }>;
  models: Array<{
    model: string;
    runCount: number;
    spendUsd: number;
    averageTokensPerRun: number;
  }>;
  tradeBreakdown: Array<{
    trade: ServiceType;
    runCount: number;
    draftRuns: number;
    reviseRuns: number;
    spendUsd: number;
    averageTokensPerRun: number;
    noPatchRuns: number;
    noPatchRatePct: number;
    lowConfidenceRuns: number;
    lowConfidenceRatePct: number;
    regexFallbackRuns: number;
    regexFallbackRatePct: number;
  }>;
};

export type InternalAiQualityTenantRow = {
  tenantId: string;
  tenantName: string;
  tenantSlug?: string | null;
  runCount: number;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageSpendUsdPerRun: number;
  averageTokensPerRun: number;
  noPatchRuns: number;
  noPatchRatePct: number;
  lowConfidenceRuns: number;
  lowConfidenceRatePct: number;
  regexFallbackRuns: number;
  regexFallbackRatePct: number;
};

export type DataClassification =
  | "C0_PUBLIC"
  | "C1_BUSINESS_INTERNAL"
  | "C2_CUSTOMER_CONFIDENTIAL"
  | "C3_FINANCIAL_CONFIDENTIAL"
  | "C4_RESTRICTED";

export type DataGovernanceValidationIssue = {
  severity: "error" | "warning";
  code: string;
  model: string;
  field?: string;
  message: string;
};

export type DataGovernanceValidation = {
  status: "PASSED" | "FAILED";
  policyVersion: string;
  schemaHash: string;
  baselineHash: string;
  modelCount: number;
  fieldCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: DataGovernanceValidationIssue[];
};

export type InternalControlPlaneSummary = {
  generatedAtUtc: string;
  configuredAiModel: string;
  totals: {
    activeTenants: number;
    deletedTenants: number;
    activeUsers: number;
    activeCustomers: number;
    activeQuotes: number;
    quickBooksConnectedTenants: number;
    quickBooksConfirmedTenants: number;
    quickBooksReadyTenants: number;
    aiRuns: number;
    aiTokens: number;
    aiSpendUsd: number;
  };
  observedModels: Array<{ model: string; runCount: number }>;
  liveValidation: DataGovernanceValidation;
  latestValidation: null | {
    id: string;
    status: "PASSED" | "FAILED";
    schemaHash: string;
    baselineHash: string;
    modelCount: number;
    fieldCount: number;
    issueCount: number;
    createdAt: string;
  };
  workers: {
    quickBooksReconciliation: WorkerHeartbeatPayload | null;
  };
  mutationPolicy: { enabled: false; reason: string };
};

export type InternalTenantMetadata = {
  id: string;
  name: string;
  slug: string;
  primaryTrade: ServiceType;
  subscriptionStatus: string;
  subscriptionPlanCode?: string | null;
  onboardingCompletedAtUtc?: string | null;
  trialEndsAtUtc?: string | null;
  subscriptionCurrentPeriodEndUtc?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAtUtc?: string | null;
  _count: {
    users: number;
    customers: number;
    quotes: number;
    workPresets: number;
    aiUsageEvents: number;
  };
  quickBooks: {
    present: boolean;
    status: QuickBooksConnectionStatus | null;
    setupPhase: QuickBooksSetupPhase;
    setupConfirmedAtUtc?: string | null;
    environment?: string | null;
    connectedAtUtc?: string | null;
    lastSyncAtUtc?: string | null;
    lastWebhookAtUtc?: string | null;
    counts: { customerMaps: number; itemMaps: number; invoiceSyncs: number };
  };
};

export type InternalDataCatalogField = {
  field: string;
  column: string;
  type: string;
  kind: string;
  isRequired: boolean;
  isList: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  classification: DataClassification;
  classificationSource: "field_override" | "model_default" | "fail_closed";
  ragStatus: "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED";
  analyticsStatus: "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED";
  requiredAccess: string[];
};

export type InternalAiAssistantFeedback = {
  id: string;
  rating: AiAssistantFeedbackRating;
  note?: string | null;
  createdAt: string;
  tenant: {
    id: string;
    name: string;
  };
  usage: {
    eventType: string;
    purpose: string;
    model?: string | null;
    confidenceLevel?: string | null;
    createdAt: string;
  };
};

export type InternalAiAssistantFeedbackResponse = {
  windowDays: number;
  windowStartUtc: string;
  generatedAtUtc: string;
  summary: {
    total: number;
    up: number;
    down: number;
    withNote: number;
  };
  notesIncluded: boolean;
  feedback: InternalAiAssistantFeedback[];
};

export type InternalDataCatalogModel = {
  model: string;
  table: string;
  purpose: string;
  tenantScope: "required" | "optional" | "platform";
  defaultClassification: DataClassification;
  reviewStatus: "REVIEWED" | "REVIEW_REQUIRED";
  fields: InternalDataCatalogField[];
};

export type InternalDataCatalog = {
  policyVersion: string;
  validation: DataGovernanceValidation;
  summary: {
    modelCount: number;
    fieldCount: number;
    classificationCounts: Record<DataClassification, number>;
    ragEligibleCount: number;
    analyticsEligibleCount: number;
    reviewRequiredCount: number;
  };
  models: InternalDataCatalogModel[];
  filters: {
    search?: string;
    classification?: DataClassification;
    ragStatus?: "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED";
  };
};

export type AiBusinessInsightTool =
  | "SALES_PIPELINE"
  | "SERVICE_PROFITABILITY"
  | "ITEM_PROFITABILITY"
  | "LOW_MARGIN_QUOTES";

export type AiBusinessInsight = {
  tool: AiBusinessInsightTool;
  generatedAtUtc: string;
  policyVersion: string;
  maxClassification: DataClassification;
  dateRange: { from: string; to: string };
  filters: {
    serviceType: ServiceType | null;
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
  answerMode: "DETERMINISTIC" | "LLM_COMPOSED";
  model: string | null;
  telemetry: {
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  } | null;
};

export type AiAssistantRequestedTool =
  | "AUTO"
  | "ASSISTANT_HELP"
  | "OUT_OF_SCOPE"
  | "NAVIGATE_WORKSPACE"
  | "FOLLOW_UP_QUEUE"
  | "LIST_SCHEDULE"
  | "ASSESS_SCHEDULE_FIT"
  | "LIST_MY_ACTIVITIES"
  | "PRIORITIZE_MY_DAY"
  | "CUSTOMERS_WITHOUT_QUOTES"
  | "PIPELINE_SCENARIO"
  | "SEARCH_CUSTOMERS"
  | "SEARCH_PRODUCTS"
  | "SEARCH_JOBS"
  | "GET_JOB_STATUS"
  | "LIST_INVOICES"
  | "GET_INVOICE_STATUS"
  | "GET_QUICKBOOKS_SETUP_STATUS"
  | "SUMMARIZE_PIPELINE"
  | "RANK_PROFITABLE_JOBS"
  | "DRAFT_CUSTOMER"
  | "DRAFT_PRODUCT"
  | "DRAFT_QUOTE"
  | "PREPARE_BOOKING"
  | "PREPARE_DISPATCH"
  | "PREPARE_ACTIVITY"
  | "PREPARE_QUOTE_SEND";

export type AiAssistantTool = Exclude<AiAssistantRequestedTool, "AUTO">;

export type AiAssistantFeedbackRating = "UP" | "DOWN";

export type AiAssistantConversationTurn = {
  message: string;
  resolvedTool: AiAssistantTool;
};

export type AiAssistantConversationState = {
  mode: "NEW" | "CONTINUING" | "SHIFTED";
  acknowledgement: string | null;
  previousTool: AiAssistantTool | null;
  currentTool: AiAssistantTool;
};

export type AiAssistantContext = {
  currentPage?: "quotes" | "customers" | "analytics" | "products" | "dashboard" | "follow-up" | "jobs";
  customerId?: string;
  quoteId?: string;
  jobId?: string;
  invoiceId?: string;
  appointmentId?: string;
  search?: string;
  serviceType?: ServiceType;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  includeArchived?: boolean;
};

export type AiAssistantAction = {
  type: "OPEN_CUSTOMER" | "OPEN_CUSTOMER_DRAFT" | "OPEN_PRODUCT_DRAFT" | "OPEN_QUOTE_DRAFT" | "OPEN_QUOTE_SEND" | "OPEN_ACTIVITY_DRAFT" | "OPEN_SCHEDULE" | "OPEN_BOOKING_REVIEW" | "OPEN_DISPATCH_REVIEW" | "OPEN_ANALYTICS" | "OPEN_WORKSPACE_PAGE" | "OPEN_QUICKBOOKS_SETUP" | "REQUEST_ADMIN_ACCESS";
  label: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
};

export type AiAssistantCitation = {
  key: string;
  label: string;
  sourceType: string;
  classification: DataClassification;
};

export type AiAssistantResponse = {
  assistant: {
    tool: AiAssistantTool;
    generatedAtUtc: string;
    policyVersion: string;
    maxClassification: DataClassification;
    answer: string;
    results: Array<Record<string, string | number | boolean | null>>;
    citations: AiAssistantCitation[];
    actions: AiAssistantAction[];
    auditEventId: string;
    fieldsExcluded: string[];
    conversation: AiAssistantConversationState;
    diagnostics: {
      requestedTool: AiAssistantRequestedTool;
      resolvedTool: AiAssistantTool;
      resultCount: number;
      citationCount: number;
      emptyReason: string | null;
      archivePolicy: string;
      filters: Record<string, string | number | boolean | null>;
      answerMode: "DETERMINISTIC" | "LLM_COMPOSED";
      model: string | null;
    };
  };
  usage: AiUsageSummary;
};

export type InternalRagIndexSummary = {
  generatedAtUtc: string;
  policyVersion: string | null;
  rollout: {
    mode: "off" | "shadow_allowlist" | "allowlist" | "all";
    configuredAllowlistSize: number;
    enabledActiveTenantCount: number;
    exposedActiveTenantCount: number;
    inlineRefreshEnabled: boolean;
    workerEnabled: boolean;
  };
  totals: {
    documents: number;
    activeDocuments: number;
    deletedDocuments: number;
    chunks: number;
    activeChunks: number;
    deletedChunks: number;
  };
  documentsByStatus: Record<string, number>;
  activeChunksByClassification: Partial<Record<DataClassification, number>>;
  activeChunksBySourceType: Array<{ sourceType: string; chunkCount: number }>;
  indexingQueue: {
    scope: "rollout_enabled_active_tenants";
    activeTenantCount: number;
    jobsByStatus: Record<string, number>;
    successfulJobs: number;
    averageSuccessfulDurationMs: number | null;
    embeddingCacheHitRate: number | null;
    oldestPendingAtUtc: string | null;
    outOfRollout: {
      activeTenantCount: number;
      jobsByStatus: Record<string, number>;
      oldestPendingAtUtc: string | null;
      expectedWhileDisabled: boolean;
    };
  };
  latestIndexedAtUtc: string | null;
  fieldsExcluded: string[];
};

export type InternalPermissionPolicy = {
  capabilities: string[];
  roles: Record<"owner" | "admin" | "member", string[]>;
  operatorCapabilities: Record<string, boolean>;
};

export type InternalValidationRun = {
  id: string;
  actorUserId?: string | null;
  schemaHash: string;
  baselineHash: string;
  policyVersion: string;
  status: "PASSED" | "FAILED";
  modelCount: number;
  fieldCount: number;
  issueCount: number;
  issues: DataGovernanceValidationIssue[];
  createdAt: string;
};

export type InternalSuperuserAuditEvent = {
  id: string;
  requestId: string;
  action: string;
  targetType?: string | null;
  targetRefHash?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  actorUser?: { id: string; email: string; fullName: string } | null;
};

export type QuoteStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "SENT_TO_CUSTOMER"
  | "ACCEPTED"
  | "REJECTED";

export type QuoteJobStatus = "NOT_STARTED" | "SCHEDULED" | "IN_PROGRESS" | "COMPLETED";
export type AfterSaleFollowUpStatus = "NOT_READY" | "DUE" | "COMPLETED";

export type QuoteRevisionEventType =
  | "CREATED"
  | "UPDATED"
  | "STATUS_CHANGED"
  | "LINE_ITEM_CHANGED"
  | "DECISION";

export type QuoteOutboundChannel = "EMAIL_APP" | "SMS_APP" | "COPY" | "NATIVE_SHARE";
export type LeadFollowUpStatus = "NEEDS_FOLLOW_UP" | "FOLLOWED_UP" | "WON" | "LOST";

export type ServiceType = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";
export type BrandingTemplateId = "modern" | "professional" | "minimal";
export type BrandingLogoPosition = "left" | "center" | "right";
export type BrandingComponentColors = {
  headerBgColor?: string;
  headerTextColor?: string;
  sectionTitleColor?: string;
  tableHeaderBgColor?: string;
  tableHeaderTextColor?: string;
  totalsColor?: string;
  footerTextColor?: string;
};

export type BrandingBusinessProfile = {
  businessEmail?: string | null;
  businessPhone?: string | null;
  quoteMessageTemplate?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

export type TenantBranding = {
  primaryColor: string;
  templateId: BrandingTemplateId;
  logoUrl?: string | null;
  logoPosition?: BrandingLogoPosition;
  hideQuoteFlyAttribution?: boolean;
  businessEmail?: string | null;
  businessPhone?: string | null;
  quoteMessageTemplate?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  componentColors?: BrandingComponentColors | null;
};

type DecimalLike = number | string;

export type CustomerLifecycle = "active" | "archived" | "deleted";
export type CustomerStage = "NEW" | "CONTACTED" | "READY" | "SENT" | "WON" | "LOST";
export type CustomerLostReason = "PRICE" | "NO_RESPONSE" | "COMPETITOR" | "TIMING" | "NOT_A_FIT" | "CUSTOMER_CANCELED" | "OTHER";

export type CustomerQuoteSummary = {
  id: string;
  title: string;
  status: QuoteStatus;
  jobStatus: QuoteJobStatus;
  totalAmount: DecimalLike;
  updatedAt: string;
  archivedAtUtc?: string | null;
  deletedAtUtc?: string | null;
};

export type Customer = {
  id: string;
  tenantId: string;
  fullName: string;
  email?: string | null;
  phone: string;
  notes?: string | null;
  preferredLocale?: SupportedLocale | null;
  followUpStatus: LeadFollowUpStatus;
  followUpUpdatedAtUtc?: string | null;
  lifecycleVersion: number;
  lostReason?: CustomerLostReason | null;
  lostReasonNotes?: string | null;
  lostAtUtc?: string | null;
  lostByTenantUserId?: string | null;
  lostByTenantUser?: WorkspaceAssignee | null;
  reopenedAtUtc?: string | null;
  archivedAtUtc?: string | null;
  deletedAtUtc?: string | null;
  createdAt: string;
  updatedAt: string;
  assignedTenantUserId?: string | null;
  assignedTenantUser?: WorkspaceAssignee | null;
  summary?: {
    quoteCount: number;
    latestQuote: CustomerQuoteSummary | null;
    stage: CustomerStage;
    openManualTaskCount?: number;
  };
};

export type CustomerDuplicateMatch = {
  id: string;
  fullName: string;
  phone: string;
  email?: string | null;
  archivedAtUtc?: string | null;
  deletedAtUtc?: string | null;
  createdAt: string;
  matchReasons: Array<"phone" | "email">;
};

export type QuoteCustomerDraft = {
  fullName: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  preferredLocale?: SupportedLocale | null;
  duplicateAction?: "merge" | "create_new" | "use_existing";
  duplicateCustomerId?: string;
};

export type QuoteLineItem = {
  id: string;
  tenantId: string;
  quoteId: string;
  description: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: DecimalLike;
  unitCost?: DecimalLike;
  unitPrice: DecimalLike;
  createdAt: string;
};

export type QuoteSheetLineInput = {
  description: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  sourcePresetId?: string;
};

export type SaveQuoteSheetInput = {
  quote: {
    serviceType: ServiceType;
    status: QuoteStatus;
    afterSaleFollowUpStatus: AfterSaleFollowUpStatus;
    title: string;
    scopeText: string;
    taxAmount: number;
    documentLocale?: SupportedLocale;
  };
  lineItems: Array<QuoteSheetLineInput & { id: string }>;
  newLineItems: QuoteSheetLineInput[];
};

export type Quote = {
  id: string;
  tenantId: string;
  customerId: string;
  serviceType: ServiceType;
  status: QuoteStatus;
  /** Legacy projection retained for read compatibility. Job is the workflow authority. */
  readonly jobStatus: QuoteJobStatus;
  afterSaleFollowUpStatus: AfterSaleFollowUpStatus;
  title: string;
  scopeText: string;
  documentLocale: SupportedLocale;
  internalCostSubtotal?: DecimalLike;
  customerPriceSubtotal: DecimalLike;
  taxAmount: DecimalLike;
  totalAmount: DecimalLike;
  aiGeneratedAtUtc?: string | null;
  aiModel?: string | null;
  closedAtUtc?: string | null;
  jobCompletedAtUtc?: string | null;
  afterSaleFollowUpDueAtUtc?: string | null;
  afterSaleFollowUpCompletedAtUtc?: string | null;
  sentAt?: string | null;
  archivedAtUtc?: string | null;
  deletedAtUtc?: string | null;
  createdAt: string;
  updatedAt: string;
  assignedTenantUserId?: string | null;
  assignedTenantUser?: WorkspaceAssignee | null;
  acceptedJob?: QuoteAcceptedJobSummary | null;
  customer?: Customer;
  lineItems?: QuoteLineItem[];
  quickBooksInvoiceSyncs?: Array<{
    id: string;
    quickBooksInvoiceId?: string | null;
    quickBooksDocNumber?: string | null;
    status: "PENDING" | "SYNCED" | "FAILED";
    syncedAtUtc?: string | null;
    lastAttemptedAtUtc?: string | null;
    lastError?: string | null;
  }>;
};

export type QuoteRevision = {
  id: string;
  quoteId: string;
  customerId: string;
  version: number;
  eventType: QuoteRevisionEventType;
  changedFields: string[];
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  title: string;
  status: QuoteStatus;
  customerPriceSubtotal: DecimalLike;
  totalAmount: DecimalLike;
  createdAt: string;
  quote: {
    id: string;
    title: string;
  };
  customer: {
    id: string;
    fullName: string;
  };
};

export type QuoteOutboundEvent = {
  id: string;
  tenantId: string;
  quoteId: string;
  customerId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  channel: QuoteOutboundChannel;
  destination?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
};

export type CustomerActivityEvent = {
  id: string;
  sourceType: "customer_event" | "quote_revision" | "quote_outbound";
  eventType: string;
  occurredAt: string;
  title: string;
  detail: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  quoteId?: string | null;
  quoteTitle?: string | null;
  version?: number | null;
  channel?: QuoteOutboundChannel | null;
  metadata?: Record<string, unknown> | null;
};

export type ChatToQuoteParsed = {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceType: ServiceType;
  squareFeetEstimate?: number | null;
  squareFeetVariancePercent?: number | null;
  squareFeetEstimateLow?: number | null;
  squareFeetEstimateHigh?: number | null;
  estimatedTotalAmount?: number | null;
};

export type AiUsageSummary = {
  consumedCredits: number;
  consumedSpendUsd?: number;
  monthlyCreditsUsed: number;
  monthlyCreditsLimit: number | null;
  monthlyCreditsRemaining: number | null;
  monthlySpendUsedUsd?: number;
  monthlySpendLimitUsd?: number | null;
  monthlySpendReservedUsd?: number;
  monthlySpendRemainingUsd?: number | null;
  monthlySpendUsagePercent?: number | null;
  monthlyUsageCompletedPercent?: number | null;
  monthlyUsageReservedPercent?: number | null;
  monthlyUsageEffectivePercent?: number | null;
  monthlyUsageRemainingPercent?: number | null;
  activeReservationCount?: number;
  enforcementMode?: "SPEND" | "CREDITS" | "UNLIMITED";
  periodSource?: AiUsagePeriodSource;
  billingCycleReconciliationPending?: boolean;
  warningThresholdPercent?: 25 | 50 | 75 | 85 | 95 | 100 | null;
  limitReached?: boolean;
  estimatedPromptCostUsd?: number;
  estimatedPromptsRemaining: number | null;
  renewsAtUtc?: string | null;
};

export type AiPriceProvenance =
  | "EXPLICIT_PROMPT"
  | "TENANT_PRESET"
  | "STANDARD_CATALOG"
  | "CURRENT_QUOTE"
  | "UNRESOLVED";

export type QuotePreparationStatus = "READY" | "NEEDS_CLARIFICATION" | "CUSTOMER_AMBIGUOUS";

export type QuotePreparationDraft = {
  quoteId: string | null;
  serviceType: ServiceType;
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
  lineItems: Array<{
    description: string;
    quantity: number;
    sectionType: "INCLUDED" | "ALTERNATE";
    sectionLabel: string | null;
    sourcePresetId: string | null;
    catalogKey: string | null;
    unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH" | null;
    unitPrice: number;
    unitCost?: number;
    priceProvenance: Exclude<AiPriceProvenance, "CURRENT_QUOTE">;
  }>;
  workspaceContext: Array<{
    citationKey: string;
    label: string;
    sourceType: string;
    fact: string;
  }>;
  requiresPricingReview: boolean;
};

export type QuotePreparationClarification = {
  code: "CUSTOMER_REQUIRED" | "CUSTOMER_NAME_REQUIRED" | "CUSTOMER_PHONE_REQUIRED" | "CUSTOMER_SELECTION_REQUIRED" | "PRICING_BREAKDOWN_CONFLICT" | "WORK_REQUIRED";
  message: string;
};

type QuotePreparationBase = {
  preparationId: string;
  auditEventId?: string;
  customerResolution: "MATCHED" | "NEW_CUSTOMER_DRAFT" | "AMBIGUOUS" | "NONE";
  customer: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
  } | null;
  customerDraft: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };
  customerCandidates: Array<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
  }>;
  draft: QuotePreparationDraft;
  sources: Array<{
    key: string;
    label: string;
    sourceType: string;
    classification: DataClassification;
  }>;
  retrievedSourceCount: number;
  retrievedSourceLabels: string[];
  retrievalAuditEventId: string | null;
  retrievalDegraded: boolean;
  model: string;
};

export type QuotePreparationReady = QuotePreparationBase & {
  status: "READY";
  clarification: null;
};

export type QuotePreparationNeedsClarification = QuotePreparationBase & {
  status: "NEEDS_CLARIFICATION";
  clarification: QuotePreparationClarification;
};

export type QuotePreparationCustomerAmbiguous = QuotePreparationBase & {
  status: "CUSTOMER_AMBIGUOUS";
  customerResolution: "AMBIGUOUS";
  customer: null;
  clarification: QuotePreparationClarification;
};

export type QuotePreparationResult =
  | QuotePreparationReady
  | QuotePreparationNeedsClarification
  | QuotePreparationCustomerAmbiguous;

export type AiQuoteSuggestion = {
  serviceType: ServiceType;
  title: string;
  scopeText: string;
  internalCostSubtotal?: number;
  customerPriceSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  requiresPricingReview?: boolean;
  model: string;
  lineItems: Array<{
    description: string;
    sectionType: "INCLUDED" | "ALTERNATE";
    sectionLabel?: string | null;
    quantity: number;
    unitCost?: number;
    unitPrice: number;
    priceProvenance?: AiPriceProvenance;
    sourcePresetId?: string;
  }>;
};

export type AiQuoteLinePatch = {
  action: "ADD" | "UPDATE" | "REMOVE";
  targetLineId: string | null;
  previousDescription: string | null;
  description: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: number;
  unitCost?: number;
  unitPrice: number;
  priceProvenance?: AiPriceProvenance;
  sourcePresetId?: string;
  reason: string;
};

export type AiQuoteInsight = {
  summary: string;
  reasons: string[];
  sources: Array<{
    type:
      | "current_quote"
      | "customer"
      | "customer_notes"
      | "customer_activity"
      | "saved_jobs"
      | "trade_catalog"
      | "similar_quote"
      | "retrieved_context";
    label: string;
  }>;
  confidence: {
    level: "high" | "medium" | "low";
    label: string;
  };
  riskNote?: string | null;
  patch: {
    added: number;
    updated: number;
    removed: number;
  };
};

type AiQuoteSuggestionResultBase = {
  customer: {
    id: string;
    fullName: string;
    phone: string;
    email?: string | null;
  } | null;
  parsed: ChatToQuoteParsed;
  aiRunId: string;
  usage: AiUsageSummary;
};

export type AiQuoteSuggestionReadyResult = AiQuoteSuggestionResultBase & {
  status: "READY";
  preparation: QuotePreparationReady;
  suggestion: AiQuoteSuggestion;
  patch: {
    lineChanges: AiQuoteLinePatch[];
    added: number;
    updated: number;
    removed: number;
  };
  insight: AiQuoteInsight;
};

export type AiQuoteSuggestionNeedsClarificationResult = AiQuoteSuggestionResultBase & {
  status: "NEEDS_CLARIFICATION";
  preparation: QuotePreparationNeedsClarification;
  suggestion?: never;
  patch?: never;
  insight?: never;
};

export type AiQuoteSuggestionCustomerAmbiguousResult = AiQuoteSuggestionResultBase & {
  status: "CUSTOMER_AMBIGUOUS";
  preparation: QuotePreparationCustomerAmbiguous;
  suggestion?: never;
  patch?: never;
  insight?: never;
};

export type AiQuoteSuggestionResult =
  | AiQuoteSuggestionReadyResult
  | AiQuoteSuggestionNeedsClarificationResult
  | AiQuoteSuggestionCustomerAmbiguousResult;

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePreparationWorkspaceContext(value: unknown): QuotePreparationDraft["workspaceContext"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    if (!isRuntimeRecord(candidate)) return [];
    const citationKey = typeof candidate.citationKey === "string" ? candidate.citationKey.trim() : "";
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const sourceType = typeof candidate.sourceType === "string" ? candidate.sourceType.trim() : "";
    const fact = typeof candidate.fact === "string" ? candidate.fact.trim() : "";
    if (!citationKey || citationKey.length > 200 || !label || label.length > 500 || !sourceType || sourceType.length > 200 || !fact || fact.length > 2_000) {
      return [];
    }
    return [{ citationKey, label, sourceType, fact }];
  });
}

export function normalizeAiQuoteSuggestionResult(value: unknown): AiQuoteSuggestionResult {
  if (!isRuntimeRecord(value) || !isRuntimeRecord(value.preparation) || !isRuntimeRecord(value.preparation.draft)) {
    throw new ApiError("AI response contract was invalid.", 502);
  }
  const status = value.preparation.status;
  if (status !== "READY" && status !== "NEEDS_CLARIFICATION" && status !== "CUSTOMER_AMBIGUOUS") {
    throw new ApiError("AI response contract was invalid.", 502);
  }
  if (!isRuntimeRecord(value.parsed) || !isRuntimeRecord(value.usage) || typeof value.aiRunId !== "string") {
    throw new ApiError("AI response contract was invalid.", 502);
  }
  const preparation = {
    ...value.preparation,
    draft: {
      ...value.preparation.draft,
      workspaceContext: normalizePreparationWorkspaceContext(value.preparation.draft.workspaceContext),
    },
  } as QuotePreparationResult;
  const common = {
    customer: isRuntimeRecord(value.customer) ? value.customer : null,
    parsed: value.parsed,
    aiRunId: value.aiRunId,
    usage: value.usage,
  } as AiQuoteSuggestionResultBase;

  if (status === "READY") {
    if (!isRuntimeRecord(value.suggestion) || !isRuntimeRecord(value.patch) || !isRuntimeRecord(value.insight) || preparation.status !== "READY") {
      throw new ApiError("AI response contract was invalid.", 502);
    }
    return {
      ...common,
      status,
      preparation,
      suggestion: value.suggestion as AiQuoteSuggestion,
      patch: value.patch as AiQuoteSuggestionReadyResult["patch"],
      insight: value.insight as AiQuoteInsight,
    };
  }

  if (!isRuntimeRecord(preparation.clarification)) {
    throw new ApiError("AI response contract was invalid.", 502);
  }
  if (status === "CUSTOMER_AMBIGUOUS") {
    if (preparation.status !== "CUSTOMER_AMBIGUOUS") throw new ApiError("AI response contract was invalid.", 502);
    return { ...common, status, preparation };
  }
  if (preparation.status !== "NEEDS_CLARIFICATION") throw new ApiError("AI response contract was invalid.", 502);
  return { ...common, status, preparation };
}

export type AiQuoteRun = {
  id: string;
  quoteId?: string | null;
  customerId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  eventType: "DRAFT" | "REVISE";
  purpose?: "QUOTE_DRAFT" | "QUOTE_REVISION" | "BUSINESS_INSIGHT" | null;
  classification?:
    | "C0_PUBLIC"
    | "C1_BUSINESS_INTERNAL"
    | "C2_CUSTOMER_CONFIDENTIAL"
    | "C3_FINANCIAL_CONFIDENTIAL"
    | "C4_RESTRICTED"
    | null;
  serviceType?: ServiceType | null;
  creditsConsumed: number;
  requestCount: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
  promptRedacted?: string | null;
  model?: string | null;
  insightSummary?: string | null;
  insightReasons: string[];
  insightSourceLabels: string[];
  confidenceLevel?: "high" | "medium" | "low" | null;
  confidenceLabel?: string | null;
  riskNote?: string | null;
  patchAdded?: number | null;
  patchUpdated?: number | null;
  patchRemoved?: number | null;
  sourceCount?: number | null;
  createdAt: string;
};

export type AiProgressStep =
  | "analyzing_prompt"
  | "loading_customer_context"
  | "retrieving_workspace_context"
  | "drafting_quote_patch"
  | "reviewing_line_changes"
  | "finalizing_suggestion";

export type AiProgressEvent = {
  type: "progress";
  step: AiProgressStep;
  value: number;
  label: string;
  detail: string;
  sourceHints?: string[];
  patchCounts?: {
    added: number;
    updated: number;
    removed: number;
  };
};

type AiSuggestionStreamEvent =
  | AiProgressEvent
  | { type: "complete"; result: unknown }
  | { type: "error"; error: string; code?: string };

export type WorkPresetCategory = "LABOR" | "MATERIAL" | "FEE" | "SERVICE";
export type WorkPresetUnitType = "FLAT" | "SQ_FT" | "HOUR" | "EACH";

export type WorkPreset = {
  id: string;
  tenantId: string;
  serviceType: ServiceType;
  catalogKey?: string | null;
  catalogVersion?: number | null;
  catalogCustomizedAtUtc?: string | null;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  name: string;
  description?: string | null;
  defaultQuantity: number | string;
  unitCost?: number | string;
  unitPrice: number | string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProductInput = {
  serviceType: ServiceType;
  name: string;
  description?: string | null;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
  isDefault?: boolean;
};

export type OrgUserRole = "owner" | "admin" | "member";

export type OrganizationUser = {
  id: string;
  tenantId: string;
  role: OrgUserRole;
  createdAt: string;
  capabilities?: string[];
  assignments?: {
    assignedCustomers: number;
    assignedQuotes: number;
  };
  user: {
    id: string;
    email: string;
    fullName: string;
    createdAt: string;
  };
};

export type ActivityTaskType = "FOLLOW_UP" | "PREPARE_QUOTE" | "SEND_QUOTE" | "CHECK_IN" | "CUSTOM";
export type ActivityTaskStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELED";
export type ActivityTaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type ActivityTaskDueFilter = "active" | "overdue" | "today" | "upcoming" | "completed";
export type ActivityTaskOrigin = "MANUAL" | "AUTOMATED_CUSTOMER_FOLLOW_UP";
export type FollowUpOutcome = "CONTACTED" | "NO_RESPONSE" | "SKIPPED";

export type FollowUpSettingsStep = {
  stepNumber: number;
  delayMinutes: number;
  title: string;
  notes: string | null;
  priority: ActivityTaskPriority;
};

export type FollowUpSettings = {
  enabled: boolean;
  version: number;
  updatedAtUtc: string;
  steps: FollowUpSettingsStep[];
};

export type FollowUpSettingsUpdate = {
  version: number;
  enabled?: boolean;
  steps?: Array<{
    stepNumber: number;
    delayMinutes: number;
    title: string;
    notes?: string | null;
    priority: ActivityTaskPriority;
  }>;
};
export type JobStatus = "UNSCHEDULED" | "SCHEDULED" | "DISPATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELED";
export type JobAppointmentStatus = "SCHEDULED" | "DISPATCHED" | "ARRIVED" | "COMPLETED" | "CANCELED";
export type WorkspaceNotificationKind =
  | "BOOKED"
  | "RESCHEDULED"
  | "DISPATCHED"
  | "ARRIVED"
  | "COMPLETED"
  | "CANCELED";
export type WorkspaceNotificationDeliveryStatus = "AVAILABLE" | "DELIVERED";

export type WorkspaceNotification = {
  id: string;
  kind: WorkspaceNotificationKind;
  appointmentId: string;
  templateKey: string;
  templateVersion: number;
  sourceVersion: number;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  deliveryStatus: WorkspaceNotificationDeliveryStatus;
  deliveredAtUtc: string | null;
  readAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  job: {
    id: string;
    jobNumber: number;
    title: string;
    customer: {
      id: string;
      fullName: string;
    };
  };
};

export type WorkspaceNotificationListResponse = {
  items: WorkspaceNotification[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type WorkspaceNotificationSummaryResponse = {
  unreadCount: number;
  totalCount: number;
  latestCreatedAtUtc: string | null;
};

export type AppointmentNotificationReceipt = {
  kind: WorkspaceNotificationKind;
  createdCount: number;
};

export type ActivityTask = {
  id: string;
  customerId: string;
  quoteId: string | null;
  assignedTenantUserId: string;
  createdByTenantUserId: string | null;
  completedByTenantUserId: string | null;
  type: ActivityTaskType;
  status: ActivityTaskStatus;
  priority: ActivityTaskPriority;
  origin: ActivityTaskOrigin;
  followUpOutcome: FollowUpOutcome | null;
  followUpSequenceId: string | null;
  followUpStepNumber: number | null;
  title: string;
  notes: string | null;
  dueAtUtc: string;
  completedAtUtc: string | null;
  canceledAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    fullName: string;
  };
  quote: {
    id: string;
    title: string;
    status: QuoteStatus;
    totalAmount: number;
  } | null;
  assignedTenantUser: WorkspaceAssignee;
};

export type ActivityTaskInput = {
  customerId: string;
  quoteId?: string | null;
  assignedTenantUserId?: string;
  type: ActivityTaskType;
  priority?: ActivityTaskPriority;
  title: string;
  notes?: string | null;
  dueAtUtc: string;
};

export type Job = {
  id: string;
  customerId: string;
  sourceQuoteId: string;
  assignedTenantUserId: string | null;
  jobNumber: number;
  status: JobStatus;
  title: string;
  scopeSnapshot: string;
  serviceType: ServiceType;
  serviceAddressSnapshot: string | null;
  accessInstructions: string | null;
  acceptedAtUtc: string;
  scheduledAtUtc: string | null;
  dispatchedAtUtc: string | null;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  canceledAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    fullName: string;
  };
  sourceQuote: {
    id: string;
    title: string;
    status: QuoteStatus;
    totalAmount: number;
  };
  assignedTenantUser: {
    id: string;
    role: OrgUserRole;
    user: {
      id: string;
      fullName: string;
    };
  } | null;
};

export type JobAppointment = {
  id: string;
  jobId: string;
  assignedTenantUserId: string;
  createdByTenantUserId: string;
  status: JobAppointmentStatus;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  instructions: string | null;
  dispatchedAtUtc: string | null;
  arrivedAtUtc: string | null;
  completedAtUtc: string | null;
  canceledAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  assignedTenantUser: {
    id: string;
    role: OrgUserRole;
    user: {
      id: string;
      fullName: string;
    };
  };
  createdByTenantUser: {
    id: string;
    user: {
      id: string;
      fullName: string;
    };
  };
};

export type JobScheduleAppointment = {
  id: string;
  jobId: string;
  assignedTenantUserId: string;
  status: JobAppointmentStatus;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  version: number;
  assignedTenantUser: {
    id: string;
    role: OrgUserRole;
    user: {
      id: string;
      fullName: string;
    };
  };
  job: {
    id: string;
    jobNumber: number;
    status: JobStatus;
    title: string;
    serviceAddressSnapshot: string | null;
    customer: {
      id: string;
      fullName: string;
    };
    sourceQuote: {
      id: string;
      title: string;
    };
  };
};

export type JobNote = {
  id: string;
  jobId: string;
  createdByTenantUserId: string;
  body: string;
  createdAt: string;
  createdByTenantUser: {
    id: string;
    user: {
      id: string;
      fullName: string;
    };
  };
};

export type InvoiceStatus = "DRAFT" | "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE";
export type InvoicePaymentStatus =
  | "PENDING"
  | "PARTIALLY_PAID"
  | "SUCCEEDED"
  | "FAILED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "CANCELED";

export type Invoice = {
  id: string;
  customerId: string;
  jobId: string;
  sourceQuoteId: string;
  invoiceNumber: number;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  hasReversedPayment: boolean;
  titleSnapshot: string;
  documentLocale: SupportedLocale;
  currency: string;
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  issuedAtUtc: string | null;
  dueAtUtc: string | null;
  sentAtUtc: string | null;
  paidAtUtc: string | null;
  voidedAtUtc: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    fullName: string;
  };
  job: {
    id: string;
    jobNumber: number;
    status: JobStatus;
    title: string;
  };
  sourceQuote: {
    id: string;
    title: string;
    status: QuoteStatus;
    totalAmount: number;
  };
};

export type QuickBooksInvoiceOperationStatus =
  | "PROCESSING"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export type QuickBooksInvoiceOperation = {
  status: QuickBooksInvoiceOperationStatus;
  providerDocNumber: string;
  reconciliationAvailable: boolean;
  paymentMethods?: { ach: boolean; card: boolean };
  providerBalance?: number | null;
  providerInvoiceStatus?: string | null;
  paymentLinkAvailable?: boolean;
};

export type QuickBooksInvoiceSyncPreview = {
  invoice: {
    id: string;
    invoiceNumber: number;
    version: number;
    status: InvoiceStatus;
    customerName: string;
    currency: string;
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    dueAtUtc: string | null;
  };
  connection: null | {
    companyName: string | null;
    status: QuickBooksConnectionStatus;
  };
  billingEmail: string | null;
  paymentMethods: {
    ach: boolean;
    card: boolean;
  };
  customerMapping: null | {
    quickBooksCustomerId: string;
    quickBooksDisplayName: string | null;
    reviewedAtUtc: string | null;
  };
  quickBooksCustomerName: string | null;
  providerDocNumber: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    itemKey: string;
    mapped: boolean;
    quickBooksItemId: string | null;
    quickBooksItemName: string | null;
    reviewedAtUtc: string | null;
  }>;
  blockers: string[];
  ready: boolean;
  reviewBinding: string | null;
  operation: QuickBooksInvoiceOperation | null;
};

export type QuickBooksInvoiceOperationResponse = {
  duplicate?: boolean;
  reconciliationRequired?: boolean;
  found?: boolean;
  operation: QuickBooksInvoiceOperation;
};

export type QuickBooksInvoiceReviewOptions = {
  billingEmail: string | null;
  allowOnlineAchPayment: boolean;
  allowOnlineCardPayment: boolean;
};

export type QuickBooksHostedPaymentLink = {
  invoiceId: string;
  provider: "QUICKBOOKS";
  hostedPaymentUrl: string;
  paymentStatus: InvoicePaymentStatus;
  balanceDue: number;
};

export type QuickBooksCustomerCandidate = {
  quickBooksCustomerId: string;
  displayName: string;
  email: string | null;
};

export type QuickBooksItemCandidate = {
  quickBooksItemId: string;
  name: string;
  type: string | null;
};

export type QuickBooksReviewedCustomerMapping = {
  customerId: string;
  quickBooksCustomerId: string;
  quickBooksDisplayName: string | null;
  reviewedAtUtc: string;
  reviewVersion: number;
};

export type QuickBooksReviewedItemMapping = {
  itemKey: string;
  quickBooksItemId: string;
  quickBooksItemName: string;
  workPresetId: string | null;
  reviewedAtUtc: string;
  reviewVersion: number;
};

export type QuoteAcceptedJobSummary = {
  id: string;
  jobNumber: number;
  status: JobStatus;
};

function activityCommandHeaders(idempotencyKey?: string): HeadersInit {
  return { "Idempotency-Key": idempotencyKey ?? `qf-ui-${crypto.randomUUID()}` };
}

export type WorkspaceAssignee = {
  id: string;
  role: OrgUserRole;
  user: {
    id: string;
    email: string;
    fullName: string;
  };
};

type Pagination = { limit: number; offset: number; total: number };

export type BillingCheckoutSession = {
  sessionId: string;
  checkoutUrl: string | null;
};

export type BillingPortalSession = {
  url: string;
};

export type QuickBooksConnectionStatus =
  | "CONNECTED"
  | "NEEDS_REAUTH"
  | "REVOCATION_PENDING"
  | "ERROR"
  | "DISCONNECTED";

export type QuickBooksSetupPhase =
  | "UNAVAILABLE"
  | "NOT_CONNECTED"
  | "ACTION_REQUIRED"
  | "CONNECTION_VERIFIED"
  | "READY_FOR_CONFIRMATION"
  | "CONFIRMED";

export type QuickBooksSetupCheckKey =
  | "PROVIDER_CONFIGURED"
  | "PROVIDER_WORKFLOWS_ENABLED"
  | "ACCOUNTING_WORKFLOWS_ENABLED"
  | "WEBHOOK_CONFIGURED"
  | "HOSTED_PAYMENTS_ENABLED"
  | "RECONCILIATION_WORKER_ENABLED"
  | "RECONCILIATION_WORKER_HEALTHY"
  | "CDC_WORKER_ENABLED"
  | "CONNECTION_ACTIVE"
  | "ENVIRONMENT_MATCHES"
  | "ACCOUNTING_SCOPE_GRANTED"
  | "CREDENTIALS_AVAILABLE"
  | "REALM_BINDING_ACTIVE"
  | "CDC_CURSOR_INITIALIZED"
  | "SETUP_CONFIRMED";

export type QuickBooksSetupReadiness = {
  phase: QuickBooksSetupPhase;
  ready: boolean;
  confirmed: boolean;
  checklistVersion: string;
  confirmedAtUtc?: string | null;
  checks: Array<{ key: QuickBooksSetupCheckKey; passed: boolean; managedBy: "QUOTEFLY" | "WORKSPACE" }>;
  capabilities: { canConnect: boolean; canReconnect: boolean; canConfirm: boolean; canDisconnect: boolean };
  operations: {
    coreConnectionReady: boolean;
    hostedPaymentsReady: boolean;
    reconciliationReady: boolean;
    cdcRecoveryReady: boolean;
    allAccountingWorkflowsReady: boolean;
  };
};

export type TenantWorkerHeartbeatPayload = {
  status: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED";
  fresh: boolean;
  heartbeatAtUtc: string;
};

export type WorkerHeartbeatPayload = TenantWorkerHeartbeatPayload & {
  observedAtUtc?: string;
  startedAtUtc: string;
  cycleStartedAtUtc: string;
  lastCycleDurationMs?: number | null;
  metrics: unknown;
  fleet: {
    totalInstanceCount: number;
    freshLiveInstanceCount: number;
    capacityInstanceCount: number;
    stoppingInstanceCount: number;
    staleInstanceCount: number;
    terminalInstanceCount: number;
    missingReleaseShaInstanceCount: number;
    releaseMismatchInstanceCount: number;
    overflowedFreshLiveInstanceCount: number;
    freshLiveInstanceLimit: number;
    freshLiveOverflowed: boolean;
  };
  releaseIdentity: {
    apiReleaseSha: string | null;
    workerReleaseSha: string | null;
    matches: boolean | null;
  };
};

export type QuickBooksStatusPayload = {
  enabled: boolean;
  configured: boolean;
  providerWorkflowsEnabled: boolean;
  oauthOnlyMode?: boolean;
  webhookConfigured: boolean;
  canManage: boolean;
  environment: "sandbox" | "production";
  reconciliationWorker: TenantWorkerHeartbeatPayload | null;
  releaseMatches: boolean | null;
  setup: QuickBooksSetupReadiness;
  connection: null | {
    environment: string;
    companyName?: string | null;
    status: QuickBooksConnectionStatus;
    connectedAtUtc: string;
    disconnectedAtUtc?: string | null;
    lastTokenRefreshAtUtc?: string | null;
    lastSyncAtUtc?: string | null;
    lastWebhookAtUtc?: string | null;
    counts: {
      customerMaps: number;
      itemMaps: number;
      invoiceSyncs: number;
    };
  };
};

export type QuickBooksSyncPreview = {
  connection: {
    realmId: string;
    companyName?: string | null;
  };
  customer: {
    quoteFlyCustomerId: string;
    fullName: string;
    email?: string | null;
    phone: string;
    quickBooksCustomerId?: string | null;
    quickBooksDisplayName?: string | null;
    createPayload: Record<string, unknown>;
  };
  invoice: {
    quoteId: string;
    quoteTitle: string;
    docNumber: string;
    invoiceDate: string;
    dueDate: string;
    totalAmount: number;
    payload: Record<string, unknown>;
  };
  lineItems: Array<{
    sourceLineId: string;
    description: string;
    itemKey: string;
    quickBooksItemId?: string | null;
    quickBooksItemName?: string | null;
    quantity: number;
    unitPrice: number;
    amount: number;
    payload: Record<string, unknown>;
  }>;
  warnings: string[];
  sync?: {
    id: string;
    quickBooksInvoiceId?: string | null;
    quickBooksDocNumber?: string | null;
    status: "PENDING" | "SYNCED" | "FAILED";
    lastError?: string | null;
    lastAttemptedAtUtc?: string | null;
    syncedAtUtc?: string | null;
  } | null;
};

export type FeatureRequestInput = {
  requestId: string;
  name: string;
  email: string;
  company?: string;
  category: "QUOTING" | "CUSTOMERS" | "MOBILE" | "REPORTING" | "INTEGRATIONS" | "OTHER";
  priority: "NICE_TO_HAVE" | "IMPORTANT" | "BLOCKING";
  title: string;
  details: string;
  source: "PUBLIC" | "WORKSPACE";
  website?: string;
};

export type WorkspaceAttentionReason =
  | "NEEDS_FIRST_QUOTE"
  | "DRAFT_TO_FINISH"
  | "READY_TO_SEND"
  | "AWAITING_RESPONSE"
  | "AFTER_SALE_DUE";

export type WorkspaceOverview = {
  generatedAtUtc: string;
  metrics: {
    activeCustomers: number;
    unquotedLeads: number;
    needsFollowUp: number;
    activeQuotes: number;
    openPipelineRevenue: number;
    acceptedRevenue: number;
    activeJobs: number;
    afterSaleDue: number;
  };
  quoteStatusCounts: Record<QuoteStatus, number>;
  attention: Array<{
    customerId: string;
    customerName: string;
    quoteId: string | null;
    quoteTitle: string | null;
    quoteStatus: QuoteStatus | null;
    totalAmount: number | null;
    reason: WorkspaceAttentionReason;
    occurredAt: string;
  }>;
  recentCustomers: Array<{
    id: string;
    fullName: string;
    followUpStatus: LeadFollowUpStatus;
    createdAt: string;
    latestQuote: null | {
      id: string;
      title: string;
      status: QuoteStatus;
      totalAmount: number;
      updatedAt: string;
    };
  }>;
  recentQuotes: Array<{
    id: string;
    title: string;
    status: QuoteStatus;
    totalAmount: number;
    updatedAt: string;
    customer: { id: string; fullName: string };
  }>;
};

export type WorkspaceFollowUpQueue = "new" | "quoted" | "closed" | "afterSale" | "recent";

export type WorkspaceFollowUpItem = {
  customerId: string;
  customerName: string;
  phone: string;
  email?: string | null;
  quoteId?: string;
  quoteTitle?: string;
  totalAmount?: number;
  status?: QuoteStatus;
  job?: {
    id: string;
    jobNumber: number;
    status: JobStatus;
  };
  afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  afterSaleFollowUpDueAtUtc?: string | null;
  followUpStatus: LeadFollowUpStatus;
  createdAt: string;
  /** Additive API fields; optional during a rolling API/web deployment. */
  activityAtUtc?: string;
  activityKind?: "ADDED" | "UPDATED";
};

export type WorkspaceFollowUpResponse = {
  items: WorkspaceFollowUpItem[];
  pagination: Pagination;
  totals: {
    newLeads: number;
    quotedLeads: number;
    closedLeads: number;
    afterSaleLeads: number;
    recentLeads: number;
  };
  metrics: {
    acceptedRevenue: number;
    monthlyQuotes: number;
  };
};

export const api = {
  workspace: {
    overview: () => request<WorkspaceOverview>("/v1/workspace/overview"),
    followUp: (query?: {
      queue?: WorkspaceFollowUpQueue;
      search?: string;
      limit?: number;
      offset?: number;
    }) => request<WorkspaceFollowUpResponse>(`/v1/workspace/follow-up${toQueryString({
      queue: query?.queue,
      search: query?.search,
      limit: query?.limit,
      offset: query?.offset,
    })}`),
  },

  feedback: {
    submitFeatureRequest: (body: FeatureRequestInput) =>
      request<{ message: string }>("/v1/feedback/feature-requests", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  quoteDrafts: {
    get: (scope: string) =>
      request<{ draft: QuoteDraftRecovery | null }>(`/v1/quote-drafts/${encodeURIComponent(scope)}`),

    save: (scope: string, payload: QuoteDraftRecoveryPayload, options?: { keepalive?: boolean }) =>
      request<{ draft: Pick<QuoteDraftRecovery, "savedAtUtc" | "expiresAtUtc"> }>(
        `/v1/quote-drafts/${encodeURIComponent(scope)}`,
        {
          method: "PUT",
          body: JSON.stringify({ payload }),
          keepalive: options?.keepalive,
        },
      ),

    remove: (scope: string, options?: { keepalive?: boolean }) =>
      request<void>(`/v1/quote-drafts/${encodeURIComponent(scope)}`, {
        method: "DELETE",
        keepalive: options?.keepalive,
      }),
  },

  auth: {
    signup: (body: {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
      primaryTrade: ServiceType;
      preferredLocale?: SupportedLocale;
      logoUrl?: string;
      acceptedLegalTerms: true;
      termsVersion: string;
      privacyPolicyVersion: string;
    }) => request<AuthPayload>("/v1/auth/signup", { method: "POST", body: JSON.stringify(body) }),

    signin: (body: { email: string; password: string }) =>
      request<AuthPayload>("/v1/auth/signin", { method: "POST", body: JSON.stringify(body) }),

    forgotPassword: (body: { email: string }) =>
      request<{ message: string }>("/v1/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    resetPassword: (body: { token: string; password: string }) =>
      request<{ message: string }>("/v1/auth/reset-password", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    logout: () => request<void>("/v1/auth/logout", { method: "POST" }),

    me: () => request<AuthSessionPayload>("/v1/auth/me"),

    updatePreferences: (body: { preferredLocale: SupportedLocale }) =>
      request<{ preferences: { preferredLocale: SupportedLocale } }>("/v1/auth/me/preferences", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  ai: {
    assistant: (body: {
      message: string;
      tool?: AiAssistantRequestedTool;
      context?: AiAssistantContext;
      conversation?: AiAssistantConversationTurn[];
    }, options?: { idempotencyKey?: string; signal?: AbortSignal }) => request<AiAssistantResponse>("/v1/ai/assistant", {
      method: "POST",
      headers: activityCommandHeaders(options?.idempotencyKey),
      body: JSON.stringify(body),
      signal: options?.signal,
    }),

    submitAssistantFeedback: (
      auditEventId: string,
      body: { rating: AiAssistantFeedbackRating; note?: string | null },
    ) =>
      request<{ feedback: { rating: AiAssistantFeedbackRating; note: string | null; updatedAt: string } }>(
        `/v1/ai/assistant/${encodeURIComponent(auditEventId)}/feedback`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    businessInsight: (body: {
      prompt: string;
      tool: AiBusinessInsightTool;
      dateFrom?: string;
      dateTo?: string;
      serviceType?: ServiceType;
      limit?: number;
      includeArchived?: boolean;
    }, options?: { idempotencyKey?: string }) => request<{ insight: AiBusinessInsight; usage: AiUsageSummary }>("/v1/ai/business-insights", {
      method: "POST",
      headers: activityCommandHeaders(options?.idempotencyKey),
      body: JSON.stringify(body),
    }),
  },

  internal: {
    controlPlane: {
      summary: () => request<InternalControlPlaneSummary>("/v1/internal/control-plane/summary"),
      tenants: (query?: {
        limit?: number;
        offset?: number;
        search?: string;
        lifecycle?: "active" | "deleted" | "all";
        quickBooks?: "all" | "connected" | "confirmed" | "attention" | "not_connected";
      }) => request<{
        tenants: InternalTenantMetadata[];
        pagination: { limit: number; offset: number; total: number };
        fieldsExcluded: string[];
      }>(`/v1/internal/control-plane/tenants${toQueryString({
        limit: query?.limit,
        offset: query?.offset,
        search: query?.search,
        lifecycle: query?.lifecycle,
        quickBooks: query?.quickBooks,
      })}`),
      dataCatalog: (query?: {
        search?: string;
        classification?: DataClassification;
        ragStatus?: "ELIGIBLE" | "EXCLUDED" | "REVIEW_REQUIRED";
      }) => request<InternalDataCatalog>(
        `/v1/internal/control-plane/data-catalog${toQueryString({
          search: query?.search,
          classification: query?.classification,
          ragStatus: query?.ragStatus,
        })}`,
      ),
      ragIndex: () => request<InternalRagIndexSummary>("/v1/internal/control-plane/rag-index"),
      permissions: () => request<InternalPermissionPolicy>("/v1/internal/control-plane/permissions"),
      runValidation: () => request<{ run: InternalValidationRun & DataGovernanceValidation }>(
        "/v1/internal/control-plane/validation-runs",
        { method: "POST" },
      ),
      validationRuns: (query?: { limit?: number }) => request<{ runs: InternalValidationRun[] }>(
        `/v1/internal/control-plane/validation-runs${toQueryString({ limit: query?.limit })}`,
      ),
      auditEvents: (query?: { limit?: number }) => request<{ events: InternalSuperuserAuditEvent[] }>(
        `/v1/internal/control-plane/audit-events${toQueryString({ limit: query?.limit })}`,
      ),
    },
    aiQuality: {
      assistantTest: (body: {
        message: string;
        tool?: AiAssistantRequestedTool;
        context?: AiAssistantContext;
        conversation?: AiAssistantConversationTurn[];
      }) => request<AiAssistantResponse>("/v1/internal/ai-quality/assistant-test", {
        method: "POST",
        headers: activityCommandHeaders(),
        body: JSON.stringify(body),
      }),
      summary: (query?: { days?: number }) =>
        request<InternalAiQualitySummary>(
          `/v1/internal/ai-quality/summary${toQueryString({
            days: query?.days,
          })}`,
        ),
      tenants: (query?: { days?: number; limit?: number }) =>
        request<{
          windowDays: number;
          windowStartUtc: string;
          tenants: InternalAiQualityTenantRow[];
        }>(
          `/v1/internal/ai-quality/tenants${toQueryString({
            days: query?.days,
            limit: query?.limit,
          })}`,
        ),
      feedback: (query?: { days?: number; limit?: number; includeNotes?: boolean }) =>
        request<InternalAiAssistantFeedbackResponse>(
          `/v1/internal/ai-quality/feedback${toQueryString({
            days: query?.days,
            limit: query?.limit,
            includeNotes: query?.includeNotes,
          })}`,
        ),
    },
  },

  billing: {
    createCheckoutSession: (body: { planCode: PlanCode }) =>
      request<BillingCheckoutSession>(`/v1/billing/checkout-session`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    createPortalSession: () =>
      request<BillingPortalSession>(`/v1/billing/portal-session`, {
        method: "POST",
      }),
  },

  integrations: {
    quickbooks: {
      status: () => request<QuickBooksStatusPayload>(`/v1/integrations/quickbooks/status`),

      connect: () =>
        request<{ authorizationUrl: string }>(`/v1/integrations/quickbooks/connect`, {
          method: "POST",
        }),

      disconnect: () =>
        request<{ disconnected: boolean; revocationPending?: boolean }>(`/v1/integrations/quickbooks/disconnect`, {
          method: "POST",
        }),

      confirmSetup: (body: {
        checklistVersion: string;
        companyConfirmed: true;
        reviewResponsibilityConfirmed: true;
      }) => request<{ confirmed: true; idempotent: boolean; setup: QuickBooksSetupReadiness }>(
        `/v1/integrations/quickbooks/setup-confirmation`,
        { method: "POST", body: JSON.stringify(body) },
      ),

      syncPreview: (quoteId: string) =>
        request<QuickBooksSyncPreview>(`/v1/integrations/quickbooks/quotes/${quoteId}/sync-preview`),

      invoiceSyncPreview: (invoiceId: string, options?: QuickBooksInvoiceReviewOptions) =>
        request<{
          providerWorkflowsEnabled: boolean;
          preview: QuickBooksInvoiceSyncPreview;
        }>(`/v1/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}/sync-preview`, {
          method: "POST",
          body: JSON.stringify(options ? normalizeQuickBooksInvoiceReviewOptions(options) : {}),
        }),

      reviewInvoiceCustomerMapping: (body: { customerId: string; quickBooksCustomerId: string }) =>
        request<{ mapping: QuickBooksReviewedCustomerMapping }>(`/v1/integrations/quickbooks/mappings/customer/review`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      reviewInvoiceItemMapping: (body: { itemKey: string; quickBooksItemId: string; workPresetId?: string }) =>
        request<{ mapping: QuickBooksReviewedItemMapping }>(`/v1/integrations/quickbooks/mappings/item/review`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      searchCustomerMappings: (query: string, limit = 10) =>
        request<{ candidates: QuickBooksCustomerCandidate[] }>(
          "/v1/integrations/quickbooks/mappings/customers/search",
          { method: "POST", body: JSON.stringify({ query, limit }) },
        ),

      searchItemMappings: (query: string, limit = 10) =>
        request<{ candidates: QuickBooksItemCandidate[] }>(
          "/v1/integrations/quickbooks/mappings/items/search",
          { method: "POST", body: JSON.stringify({ query, limit }) },
        ),

      publishQuoteFlyInvoice: (
        invoiceId: string,
        body: { invoiceVersion: number; reviewBinding: string } & QuickBooksInvoiceReviewOptions,
        idempotencyKey: string,
      ) => request<QuickBooksInvoiceOperationResponse>(
        `/v1/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}/publish`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            ...body,
            ...normalizeQuickBooksInvoiceReviewOptions(body),
          }),
        },
      ),

      reconcileQuoteFlyInvoice: (invoiceId: string) =>
        request<QuickBooksInvoiceOperationResponse>(
          `/v1/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}/reconcile`,
          { method: "POST" },
        ),

      refreshQuoteFlyInvoice: (invoiceId: string) =>
        request<QuickBooksInvoiceOperationResponse>(
          `/v1/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}/refresh`,
          { method: "POST" },
        ),

      invoicePaymentLink: (invoiceId: string) =>
        request<QuickBooksHostedPaymentLink>(
          `/v1/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}/payment-link`,
        ),
    },
  },

  branding: {
    get: (tenantId: string) =>
      request<{
        tenant: {
          name: string;
          timezone: string;
          defaultCustomerLocale: SupportedLocale;
        };
        branding: TenantBranding | null;
        permissions: {
          canEditBusinessName: boolean;
          canManageBranding: boolean;
        };
      }>(
        `/v1/tenants/${tenantId}/branding`,
      ),

    save: (
      tenantId: string,
      body: {
        businessName?: string;
        logoUrl?: string | null;
        logoPosition: BrandingLogoPosition;
        hideQuoteFlyAttribution?: boolean;
        primaryColor: string;
        templateId: BrandingTemplateId;
        timezone: string;
        defaultCustomerLocale?: SupportedLocale;
        businessProfile: BrandingBusinessProfile;
        componentColors?: BrandingComponentColors | null;
      },
    ) =>
      request<{
        tenant: {
          name: string;
          timezone: string;
          defaultCustomerLocale: SupportedLocale;
        };
        branding: TenantBranding;
      }>(
        `/v1/tenants/${tenantId}/branding`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
  },

  onboarding: {
    getSetup: () =>
      request<{
        tenant: {
          id: string;
          name: string;
          primaryTrade?: ServiceType | null;
          onboardingCompletedAtUtc?: string | null;
        };
        branding: {
          logoUrl?: string | null;
          primaryColor: string;
          templateId: BrandingTemplateId;
        } | null;
        defaultPricingProfiles: Array<{
          id: string;
          serviceType: ServiceType;
          laborRate: number | string;
          materialMarkup: number | string;
          isDefault: boolean;
        }>;
        presets: WorkPreset[];
        supportedTrades: ServiceType[];
      }>("/v1/onboarding/setup"),

    getRecommendedPresets: (serviceType: ServiceType) =>
      request<{
        serviceType: ServiceType;
        presets: Array<{
          id?: string;
          catalogKey?: string | null;
          name: string;
          description?: string;
          category: WorkPresetCategory;
          unitType: WorkPresetUnitType;
          defaultQuantity: number;
          unitCost: number;
          unitPrice: number;
          isDefault?: boolean;
        }>;
      }>(`/v1/onboarding/presets/recommended${toQueryString({ serviceType })}`),

    saveSetup: (body: {
      primaryTrade: ServiceType;
      logoUrl?: string;
      primaryColor?: string;
      chargeBySquareFoot?: boolean;
      sqFtUnitCost?: number;
      sqFtUnitPrice?: number;
      presets?: Array<{
        id?: string;
        catalogKey?: string | null;
        name: string;
        description?: string;
        category: WorkPresetCategory;
        unitType: WorkPresetUnitType;
        defaultQuantity: number;
        unitCost: number;
        unitPrice: number;
        isDefault?: boolean;
      }>;
    }) =>
      request<{ message: string; presetsCreatedOrUpdated: number }>(`/v1/onboarding/setup`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    savePreset: (body: {
      serviceType: ServiceType;
      name: string;
      description?: string;
      category?: WorkPresetCategory;
      unitType?: WorkPresetUnitType;
      defaultQuantity?: number;
      unitCost?: number;
      unitPrice?: number;
    }) =>
      request<{ message: string; action: "created" | "updated" | "restored"; preset: WorkPreset }>(
        `/v1/onboarding/presets`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
  },

  activities: {
    list: (query?: {
      mine?: boolean;
      assignedTenantUserId?: string;
      status?: ActivityTaskStatus;
      type?: ActivityTaskType;
      due?: ActivityTaskDueFilter;
      customerId?: string;
      quoteId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }) =>
      request<{
        items: ActivityTask[];
        pagination: Pagination;
        scope: { mine: boolean };
      }>(`/v1/activities${toQueryString({
        mine: query?.mine,
        assignedTenantUserId: query?.assignedTenantUserId,
        status: query?.status,
        type: query?.type,
        due: query?.due,
        customerId: query?.customerId,
        quoteId: query?.quoteId,
        search: query?.search,
        limit: query?.limit,
        offset: query?.offset,
      })}`),

    summary: (query?: { mine?: boolean }) =>
      request<{
        generatedAtUtc: string;
        timezone: string;
        windows: {
          todayStartUtc: string;
          tomorrowStartUtc: string;
          upcomingEndUtc: string;
          completedStartUtc: string;
        };
        counts: { overdue: number; today: number; upcoming: number; completed: number };
        top: ActivityTask[];
      }>(`/v1/activities/summary${toQueryString({ mine: query?.mine })}`),

    create: (body: ActivityTaskInput, idempotencyKey?: string) =>
      request<{ task: ActivityTask; duplicate: boolean }>("/v1/activities", {
        method: "POST",
        headers: activityCommandHeaders(idempotencyKey),
        body: JSON.stringify(body),
      }),

    update: (
      activityTaskId: string,
      body: {
        version: number;
        assignedTenantUserId?: string;
        type?: ActivityTaskType;
        priority?: ActivityTaskPriority;
        status?: "OPEN" | "IN_PROGRESS" | "CANCELED";
        title?: string;
        notes?: string | null;
        dueAtUtc?: string;
      },
      idempotencyKey?: string,
    ) => request<{ task: ActivityTask; duplicate: boolean }>(`/v1/activities/${activityTaskId}`, {
      method: "PATCH",
      headers: activityCommandHeaders(idempotencyKey),
      body: JSON.stringify(body),
    }),

    complete: (activityTaskId: string, version: number, outcome?: FollowUpOutcome) =>
      request<{ task: ActivityTask; duplicate: boolean }>(`/v1/activities/${activityTaskId}/complete`, {
        method: "POST",
        headers: activityCommandHeaders(),
        body: JSON.stringify({ version, ...(outcome ? { outcome } : {}) }),
      }),

    reopen: (activityTaskId: string, version: number) =>
      request<{ task: ActivityTask; duplicate: boolean }>(`/v1/activities/${activityTaskId}/reopen`, {
        method: "POST",
        headers: activityCommandHeaders(),
        body: JSON.stringify({ version }),
      }),

    remove: (activityTaskId: string, version: number) =>
      request<void>(`/v1/activities/${activityTaskId}`, {
        method: "DELETE",
        headers: activityCommandHeaders(),
        body: JSON.stringify({ version }),
      }),
  },

  followUpSettings: {
    get: () => request<{ followUpSettings: FollowUpSettings }>("/v1/follow-up-settings"),
    update: (body: FollowUpSettingsUpdate) =>
      request<{ followUpSettings: FollowUpSettings }>("/v1/follow-up-settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  jobs: {
    list: (query?: {
      mine?: boolean;
      status?: JobStatus;
      customerId?: string;
      assignedTenantUserId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }) =>
      request<{
        items: Job[];
        pagination: Pagination;
        scope: { mine: boolean };
      }>(`/v1/jobs${toQueryString({
        mine: query?.mine,
        status: query?.status,
        customerId: query?.customerId,
        assignedTenantUserId: query?.assignedTenantUserId,
        search: query?.search,
        limit: query?.limit,
        offset: query?.offset,
      })}`),

    schedule: (query: {
      fromUtc: string;
      toUtc: string;
      mine?: boolean;
      assignedTenantUserId?: string;
      limit?: number;
      offset?: number;
    }) =>
      request<{ items: JobScheduleAppointment[]; pagination: Pagination }>(`/v1/jobs/schedule${toQueryString({
        fromUtc: query.fromUtc,
        toUtc: query.toUtc,
        mine: query.mine,
        assignedTenantUserId: query.assignedTenantUserId,
        limit: query.limit,
        offset: query.offset,
      })}`),

    get: (jobId: string) => request<{ job: Job }>(`/v1/jobs/${jobId}`),

    update: (
      jobId: string,
      body: {
        version: number;
        assignedTenantUserId?: string | null;
        accessInstructions?: string | null;
      },
    ) => request<{ job: Job }>(`/v1/jobs/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

    appointments: {
      list: (jobId: string, query?: { limit?: number; offset?: number }) =>
        request<{ items: JobAppointment[]; pagination: Pagination }>(
          `/v1/jobs/${jobId}/appointments${toQueryString({
            limit: query?.limit,
            offset: query?.offset,
          })}`,
        ),

      create: (
        jobId: string,
        body: {
          assignedTenantUserId: string;
          startsAtUtc: string;
          endsAtUtc: string;
          timeZone: string;
          instructions?: string | null;
        },
      ) => request<{ appointment: JobAppointment; notificationReceipt?: AppointmentNotificationReceipt }>(`/v1/jobs/${jobId}/appointments`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

      update: (
        jobId: string,
        appointmentId: string,
        body: {
          version: number;
          assignedTenantUserId?: string;
          startsAtUtc?: string;
          endsAtUtc?: string;
          timeZone?: string;
          instructions?: string | null;
          status?: JobAppointmentStatus;
        },
      ) => request<{ appointment: JobAppointment; notificationReceipt?: AppointmentNotificationReceipt | null }>(`/v1/jobs/${jobId}/appointments/${appointmentId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),

      remove: (jobId: string, appointmentId: string, version: number) =>
        request<{ appointmentId: string; notificationReceipt?: AppointmentNotificationReceipt } | undefined>(`/v1/jobs/${jobId}/appointments/${appointmentId}`, {
          method: "DELETE",
          body: JSON.stringify({ version }),
        }),
    },

    notes: {
      list: (jobId: string, query?: { limit?: number; offset?: number }) =>
        request<{ items: JobNote[]; pagination: Pagination }>(
          `/v1/jobs/${jobId}/notes${toQueryString({
            limit: query?.limit,
            offset: query?.offset,
          })}`,
        ),

      create: (jobId: string, body: { body: string }) =>
        request<{ note: JobNote }>(`/v1/jobs/${jobId}/notes`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      remove: (jobId: string, noteId: string) =>
        request<void>(`/v1/jobs/${jobId}/notes/${noteId}`, {
          method: "DELETE",
        }),
    },
  },

  notifications: {
    list: (query?: {
      filter?: "all" | "unread";
      limit?: number;
      cursor?: string;
    }) => request<WorkspaceNotificationListResponse>(`/v1/notifications${toQueryString({
      filter: query?.filter,
      limit: query?.limit,
      cursor: query?.cursor,
    })}`),

    summary: () => request<WorkspaceNotificationSummaryResponse>("/v1/notifications/summary"),

    markRead: (notificationId: string) =>
      request<{ notification: WorkspaceNotification }>(
        `/v1/notifications/${encodeURIComponent(notificationId)}/read`,
        { method: "POST" },
      ),

    markAllRead: () => request<{ updatedCount: number; cutoffAtUtc: string }>(
      "/v1/notifications/read-all",
      { method: "POST" },
    ),
  },

  invoices: {
    list: (query?: {
      mine?: boolean;
      status?: InvoiceStatus;
      paymentStatus?: InvoicePaymentStatus;
      customerId?: string;
      jobId?: string;
      sourceQuoteId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }) =>
      request<{
        items: Invoice[];
        pagination: Pagination;
        scope: { mine: boolean };
      }>(`/v1/invoices${toQueryString({
        mine: query?.mine,
        status: query?.status,
        paymentStatus: query?.paymentStatus,
        customerId: query?.customerId,
        jobId: query?.jobId,
        sourceQuoteId: query?.sourceQuoteId,
        search: query?.search,
        limit: query?.limit,
        offset: query?.offset,
      })}`),

    get: (invoiceId: string) => request<{ invoice: Invoice }>(`/v1/invoices/${invoiceId}`),

    create: (
      body: { jobId?: string; sourceQuoteId?: string; dueAtUtc?: string | null },
      idempotencyKey: string,
    ) => request<{ invoice: Invoice; duplicate: boolean }>("/v1/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }),
  },

  products: {
    list: (query?: {
      serviceType?: ServiceType;
      category?: WorkPresetCategory;
      search?: string;
      limit?: number;
      offset?: number;
    }) =>
      request<{
        primaryTrade?: ServiceType | null;
        supportedTrades: ServiceType[];
        products: WorkPreset[];
        policy: { canManageCatalog: boolean; canViewInternalCosts: boolean };
        pagination: Pagination;
        summary: { standardCount: number };
      }>(`/v1/products${toQueryString({
        serviceType: query?.serviceType,
        category: query?.category,
        search: query?.search,
        limit: query?.limit,
        offset: query?.offset,
      })}`),

    create: (body: ProductInput) =>
      request<{ message: string; product: WorkPreset }>(`/v1/products`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    update: (productId: string, body: Partial<ProductInput>) =>
      request<{ message: string; product: WorkPreset }>(`/v1/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),

    archive: (productId: string) =>
      request<{ message: string }>(`/v1/products/${productId}`, {
        method: "DELETE",
      }),

    syncStarterCatalog: (body: { serviceType: ServiceType }) =>
      request<{
        message: string;
        serviceType: ServiceType;
        requestedCount: number;
        createdCount: number;
        skippedCount: number;
      }>(`/v1/products/starter-catalog/add-missing`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  org: {
    users: {
      list: (query?: { limit?: number; offset?: number; search?: string }) =>
        request<{
          members: OrganizationUser[];
          pagination: Pagination;
          policy: {
            canManageUsers: boolean;
            teamMembersLimit: number | null;
            teamMembersUsed: number;
            teamMembersRemaining: number | null;
            seatPlanCode: PlanCode;
            seatPlanName: string;
          };
        }>(`/v1/org/users${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          search: query?.search,
        })}`),

      create: (body: {
        email: string;
        fullName: string;
        password: string;
        role?: OrgUserRole;
      }) =>
        request<{ member: OrganizationUser }>(`/v1/org/users`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      updateRole: (tenantUserId: string, body: { role: OrgUserRole }) =>
        request<{ member: OrganizationUser }>(`/v1/org/users/${tenantUserId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),

      remove: (tenantUserId: string) =>
        request<void>(`/v1/org/users/${tenantUserId}`, {
          method: "DELETE",
          body: "{}",
        }),
    },
  },

  customers: {
    list: (query?: {
      limit?: number;
      offset?: number;
      search?: string;
      lifecycle?: CustomerLifecycle;
      stage?: CustomerStage;
    }) =>
      request<{
        customers: Customer[];
        pagination: Pagination;
        summary: {
          lifecycleCounts: Record<CustomerLifecycle, number>;
          stageCounts: Record<CustomerStage, number>;
        };
      }>(
        `/v1/customers${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          search: query?.search,
          lifecycle: query?.lifecycle,
          stage: query?.stage,
        })}`,
      ),

    get: (customerId: string) =>
      request<{ customer: Customer; quotes: CustomerQuoteSummary[] }>(`/v1/customers/${customerId}`),

    create: (body: {
      fullName: string;
      phone: string;
      email?: string | null;
      notes?: string | null;
      preferredLocale?: SupportedLocale | null;
      assignedTenantUserId?: string | null;
      followUpStatus?: LeadFollowUpStatus;
      duplicateAction?: "merge" | "create_new" | "use_existing";
      duplicateCustomerId?: string;
    }) => request<{
      customer: Customer;
      restored?: boolean;
      merged?: boolean;
      reusedExisting?: boolean;
      matches?: CustomerDuplicateMatch[];
      code?: string;
    }>("/v1/customers", {
      method: "POST",
      body: JSON.stringify(body),
    }),

    update: (
      customerId: string,
      body: {
        fullName?: string;
        phone?: string;
        email?: string | null;
        notes?: string | null;
        preferredLocale?: SupportedLocale | null;
        followUpStatus?: LeadFollowUpStatus;
        assignedTenantUserId?: string | null;
      },
    ) => request<{ customer: Customer }>(`/v1/customers/${customerId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

    markLost: (customerId: string, body: {
      reason: CustomerLostReason;
      notes?: string | null;
      expectedVersion: number;
    }) => request<{
      customer: Customer;
      canceledAutomaticTaskCount: number;
      openManualTaskCount: number;
    }>(`/v1/customers/${customerId}/mark-lost`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

    reopen: (customerId: string, body: {
      startFollowUpSequence: boolean;
      expectedVersion: number;
    }) => request<{
      customer: Customer;
      startedFollowUpSequence: boolean;
      createdAutomaticTaskCount: number;
      openManualTaskCount: number;
    }>(`/v1/customers/${customerId}/reopen`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

    archive: (customerId: string) =>
      request<void>(`/v1/customers/${customerId}/archive`, {
        method: "POST",
      }),

    restore: (customerId: string) =>
      request<{ customer: Customer; restoredQuoteCount: number }>(`/v1/customers/${customerId}/restore`, {
        method: "POST",
      }),

    delete: (customerId: string) =>
      request<void>(`/v1/customers/${customerId}`, {
        method: "DELETE",
        body: "{}",
      }),

    activity: (customerId: string, query?: { limit?: number; offset?: number }) =>
      request<{ items: CustomerActivityEvent[]; pagination: Pagination }>(
        `/v1/customers/${customerId}/activity${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
        })}`,
      ),
  },

  quotes: {
    list: (query?: {
      limit?: number;
      offset?: number;
      status?: QuoteStatus;
      stage?: "DRAFT" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "INVOICED";
      customerId?: string;
      search?: string;
    }) =>
      request<{
        quotes: Quote[];
        pagination: Pagination;
        summary: {
          stageCounts: Record<"DRAFT" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "INVOICED", number>;
          readyToSendCount: number;
          awaitingResponseCount: number;
          awaitingResponseAmount: number;
          acceptedAmount: number;
        };
      }>(
        `/v1/quotes${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          status: query?.status,
          stage: query?.stage,
          customerId: query?.customerId,
          search: query?.search,
        })}`,
      ),

    history: (query?: {
      limit?: number;
      offset?: number;
      customerId?: string;
      quoteId?: string;
    }) =>
      request<{ revisions: QuoteRevision[]; pagination: Pagination }>(
        `/v1/quotes/history${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          customerId: query?.customerId,
          quoteId: query?.quoteId,
        })}`,
      ),

    get: (quoteId: string) => request<{ quote: Quote }>(`/v1/quotes/${quoteId}`),

    getHistory: (quoteId: string, query?: { limit?: number; offset?: number }) =>
      request<{ revisions: QuoteRevision[]; pagination: Pagination }>(
        `/v1/quotes/${quoteId}/history${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
        })}`,
      ),

    getAiRuns: (quoteId: string, query?: { limit?: number; offset?: number }) =>
      request<{ runs: AiQuoteRun[]; pagination: Pagination }>(
        `/v1/quotes/${quoteId}/ai-runs${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
        })}`,
      ),

    restoreRevision: (quoteId: string, revisionId: string) =>
      request<{ message: string; quote: Quote }>(`/v1/quotes/${quoteId}/history/${revisionId}/restore`, {
        method: "POST",
      }),

    create: (body: {
      customerId?: string;
      customerDraft?: QuoteCustomerDraft;
      serviceType: ServiceType;
      title: string;
      scopeText: string;
      internalCostSubtotal: number;
      customerPriceSubtotal: number;
      taxAmount: number;
      aiUsageEventId?: string;
      aiPricingReviewAcknowledged?: boolean;
      assignedTenantUserId?: string | null;
      documentLocale?: SupportedLocale;
      lineItems?: Array<{
        description: string;
        sectionType?: "INCLUDED" | "ALTERNATE";
        sectionLabel?: string | null;
        quantity: number;
        unitCost: number;
        unitPrice: number;
        sourcePresetId?: string;
      }>;
    }, options?: { idempotencyKey?: string }) =>
      request<{
        quote: Quote;
        duplicate?: boolean;
        customerCreated?: boolean;
        customerReused?: boolean;
        customerMerged?: boolean;
        customerRestored?: boolean;
      }>(`/v1/quotes`, {
        method: "POST",
        headers: activityCommandHeaders(options?.idempotencyKey),
        body: JSON.stringify(body),
      }),

    suggestWithAi: (body: {
      prompt: string;
      quoteId?: string;
      customerId?: string;
      serviceType?: ServiceType;
      currentTitle?: string;
      currentScopeText?: string;
      currentLineItems?: Array<{
        id?: string;
        description: string;
        sectionType?: "INCLUDED" | "ALTERNATE";
        sectionLabel?: string | null;
        quantity: number;
        unitCost: number;
        unitPrice: number;
        sourcePresetId?: string;
      }>;
    }, options?: {
      onProgress?: (event: AiProgressEvent) => void;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }): Promise<AiQuoteSuggestionResult> =>
      (async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Idempotency-Key": options?.idempotencyKey ?? `qf-ai-${crypto.randomUUID()}`,
        };

        const streamStartedAt = performance.now();
        const streamRequestOptions: RequestInit = { method: "POST" };
        let res: Response;
        try {
          res = await fetch(`${API_BASE}/v1/quotes/ai-suggest`, {
            ...streamRequestOptions,
            credentials: "include",
            headers,
            body: JSON.stringify(body),
            signal: options?.signal,
          });
        } catch (error) {
          trackApiRequest(buildFailedRequestTelemetry("/v1/quotes/ai-suggest", streamRequestOptions, streamStartedAt));
          throw error;
        }
        trackApiRequest(buildRequestTelemetry("/v1/quotes/ai-suggest", streamRequestOptions, res, streamStartedAt));

        if (!res.ok) {
          const errorBody = await res.json().catch(() => ({}));
          const message = (errorBody as { error?: string }).error ?? `Request failed: ${res.status}`;
          throw new ApiError(message, res.status, errorBody);
        }

        if (!res.body) {
          throw new ApiError("AI response stream was empty.", res.status);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult: AiQuoteSuggestionResult | null = null;
        const handleStreamLine = (rawLine: string) => {
          const line = rawLine.trim();
          if (!line) return;

          const event = JSON.parse(line) as AiSuggestionStreamEvent;
          if (event.type === "progress") {
            options?.onProgress?.(event);
            return;
          }

          if (event.type === "error") {
            throw new ApiError(event.error, res.status, event);
          }

          if (event.type === "complete") {
            finalResult = normalizeAiQuoteSuggestionResult(event.result);
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });

          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            handleStreamLine(line);
          }

          if (done) break;
        }

        if (buffer.trim()) {
          handleStreamLine(buffer);
        }

        if (!finalResult) {
          throw new ApiError("AI response ended before a result was returned.", res.status);
        }

        return finalResult;
      })(),

    update: (
      quoteId: string,
      body: {
        customerId?: string;
        serviceType?: ServiceType;
        status?: QuoteStatus;
        afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
        title?: string;
        scopeText?: string;
        internalCostSubtotal?: number;
        assignedTenantUserId?: string | null;
        customerPriceSubtotal?: number;
        taxAmount?: number;
        documentLocale?: SupportedLocale;
      },
    ) =>
      request<{ quote: Quote; job?: QuoteAcceptedJobSummary | null }>(`/v1/quotes/${quoteId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),

    saveSheet: (quoteId: string, body: SaveQuoteSheetInput) =>
      request<{ quote: Quote; job?: QuoteAcceptedJobSummary | null }>(`/v1/quotes/${quoteId}/sheet`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),

    archive: (quoteId: string) =>
      request<void>(`/v1/quotes/${quoteId}/archive`, {
        method: "POST",
      }),

    delete: (quoteId: string) =>
      request<void>(`/v1/quotes/${quoteId}`, {
        method: "DELETE",
        body: "{}",
      }),

    decision: (quoteId: string, decision: "send" | "revise") =>
      request<{ quote: Quote; message: string }>(`/v1/quotes/${quoteId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),

    downloadPdf: (quoteId: string, options?: { inline?: boolean }) =>
      requestBlob(
        `/v1/quotes/${quoteId}/pdf${toQueryString({ download: options?.inline ? false : true })}`,
      ),

    exportInvoiceCsv: (body: { quoteIds: string[]; dueInDays?: number }) =>
      requestBlob(`/v1/quotes/invoices/export-csv`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),

    lineItems: {
      create: (
        quoteId: string,
        body: { description: string; sectionType?: "INCLUDED" | "ALTERNATE"; sectionLabel?: string | null; quantity: number; unitCost: number; unitPrice: number; sourcePresetId?: string },
      ) =>
        request<{ lineItem: QuoteLineItem; quote: Quote }>(`/v1/quotes/${quoteId}/line-items`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      update: (
        quoteId: string,
        lineItemId: string,
        body: Partial<{ description: string; sectionType: "INCLUDED" | "ALTERNATE"; sectionLabel?: string | null; quantity: number; unitCost: number; unitPrice: number }>,
      ) =>
        request<{ lineItem: QuoteLineItem; quote: Quote }>(
          `/v1/quotes/${quoteId}/line-items/${lineItemId}`,
          {
            method: "PATCH",
            body: JSON.stringify(body),
          },
        ),

      remove: (quoteId: string, lineItemId: string) =>
        request<void>(`/v1/quotes/${quoteId}/line-items/${lineItemId}`, {
          method: "DELETE",
          body: "{}",
        }),
    },

    outboundEvents: {
      list: (quoteId: string, query?: { limit?: number; offset?: number }) =>
        request<{ events: QuoteOutboundEvent[]; pagination: Pagination }>(
          `/v1/quotes/${quoteId}/outbound-events${toQueryString({
            limit: query?.limit,
            offset: query?.offset,
          })}`,
        ),

      create: (
        quoteId: string,
        body: {
          channel: QuoteOutboundChannel;
          destination?: string;
          subject?: string;
          body?: string;
        },
      ) =>
        request<{ event: QuoteOutboundEvent }>(`/v1/quotes/${quoteId}/outbound-events`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
    },

    confirmSend: (
      quoteId: string,
      body: {
        channel: QuoteOutboundChannel;
        idempotencyKey: string;
        destination?: string;
        subject?: string;
        body?: string;
      },
    ) =>
      request<{ quote: Quote; event: QuoteOutboundEvent; duplicate: boolean }>(
        `/v1/quotes/${quoteId}/confirm-send`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
  },
};
