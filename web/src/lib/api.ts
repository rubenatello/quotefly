const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function getToken(): string | null {
  return localStorage.getItem("qf_token");
}

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  const body = options.body;
  const hasBody = body !== undefined && body !== null;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  const isUrlSearchParams =
    typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams;

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

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

  const res = await fetch(`${API_BASE}${path}`, { ...options, body, headers });

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
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
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

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export type AuthPayload = {
  token: string;
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; name: string; slug: string };
};

export type PlanCode = "starter" | "professional" | "enterprise";

export type TenantEntitlements = {
  planCode: PlanCode;
  planName: string;
  isTrial: boolean;
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
  monthlyQuoteCount: number;
  monthlyAiQuoteCount: number;
  monthlyAiSpendUsd?: number;
  monthlyAiSpendLimitUsd?: number | null;
  monthlyAiSpendRemainingUsd?: number | null;
  monthlyAiSpendUsagePercent?: number | null;
  monthlyAiEstimatedPromptsRemaining?: number | null;
};

export type AuthSessionPayload = {
  user: {
    id: string;
    email: string;
    fullName: string;
    createdAt: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
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

export type QuoteOutboundChannel = "EMAIL_APP" | "SMS_APP" | "COPY";
export type LeadFollowUpStatus = "NEEDS_FOLLOW_UP" | "FOLLOWED_UP" | "WON" | "LOST";

export type ServiceType = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";
export type BrandingTemplateId = "modern" | "professional" | "bold" | "minimal" | "classic";
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

export type Customer = {
  id: string;
  tenantId: string;
  fullName: string;
  email?: string | null;
  phone: string;
  notes?: string | null;
  followUpStatus: LeadFollowUpStatus;
  followUpUpdatedAtUtc?: string | null;
  archivedAtUtc?: string | null;
  deletedAtUtc?: string | null;
  createdAt: string;
  updatedAt: string;
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

export type QuoteLineItem = {
  id: string;
  tenantId: string;
  quoteId: string;
  description: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: DecimalLike;
  unitCost: DecimalLike;
  unitPrice: DecimalLike;
  createdAt: string;
};

export type Quote = {
  id: string;
  tenantId: string;
  customerId: string;
  serviceType: ServiceType;
  status: QuoteStatus;
  jobStatus: QuoteJobStatus;
  afterSaleFollowUpStatus: AfterSaleFollowUpStatus;
  title: string;
  scopeText: string;
  internalCostSubtotal: DecimalLike;
  customerPriceSubtotal: DecimalLike;
  taxAmount: DecimalLike;
  totalAmount: DecimalLike;
  aiGeneratedAtUtc?: string | null;
  aiPromptText?: string | null;
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

export type QuoteRevisionSnapshot = {
  quote: {
    id: string;
    title: string;
    serviceType: ServiceType;
    status: QuoteStatus;
    jobStatus?: QuoteJobStatus;
    afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
    scopeText: string;
    internalCostSubtotal: number;
    customerPriceSubtotal: number;
    taxAmount: number;
    totalAmount: number;
    sentAtUtc?: string | null;
    closedAtUtc?: string | null;
    jobCompletedAtUtc?: string | null;
    afterSaleFollowUpDueAtUtc?: string | null;
    afterSaleFollowUpCompletedAtUtc?: string | null;
  };
  customer: {
    id: string;
    fullName: string;
    email?: string | null;
    phone: string;
  };
  lineItems: Array<{
    id: string;
    description: string;
    sectionType: "INCLUDED" | "ALTERNATE";
    sectionLabel?: string | null;
    quantity: number;
    unitCost: number;
    unitPrice: number;
    lineTotal: number;
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
  snapshot: QuoteRevisionSnapshot;
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
};

export type ChatToQuoteParsed = {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceType: ServiceType;
  squareFeetEstimate?: number | null;
  estimatedTotalAmount?: number | null;
};

export type AiUsageSummary = {
  consumedCredits: number;
  consumedSpendUsd: number;
  monthlyCreditsUsed: number;
  monthlyCreditsLimit: number | null;
  monthlyCreditsRemaining: number | null;
  monthlySpendUsedUsd: number;
  monthlySpendLimitUsd: number | null;
  monthlySpendRemainingUsd: number | null;
  monthlySpendUsagePercent: number | null;
  estimatedPromptCostUsd: number;
  estimatedPromptsRemaining: number | null;
  renewsAtUtc: string;
};

export type ChatToQuoteResult = {
  quote: Quote;
  parsed: ChatToQuoteParsed;
  usage: AiUsageSummary;
};

export type AiQuoteSuggestion = {
  serviceType: ServiceType;
  title: string;
  scopeText: string;
  internalCostSubtotal: number;
  customerPriceSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  model: string;
  lineItems: Array<{
    description: string;
    sectionType: "INCLUDED" | "ALTERNATE";
    sectionLabel?: string | null;
    quantity: number;
    unitCost: number;
    unitPrice: number;
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
  unitCost: number;
  unitPrice: number;
  reason: string;
};

export type AiQuoteInsight = {
  summary: string;
  reasons: string[];
  sources: Array<{
    type: "current_quote" | "customer" | "customer_notes" | "customer_activity" | "saved_jobs" | "similar_quote";
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

export type AiQuoteSuggestionResult = {
  customer?: {
    id: string;
    fullName: string;
    phone: string;
    email?: string | null;
  } | null;
  parsed: ChatToQuoteParsed;
  suggestion: AiQuoteSuggestion;
  patch: {
    lineChanges: AiQuoteLinePatch[];
    added: number;
    updated: number;
    removed: number;
  };
  insight: AiQuoteInsight;
  aiRunId: string;
  usage: AiUsageSummary;
};

export type AiQuoteRun = {
  id: string;
  quoteId?: string | null;
  customerId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  eventType: "DRAFT" | "REVISE";
  creditsConsumed: number;
  requestCount: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
  promptText: string;
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
  | { type: "complete"; result: AiQuoteSuggestionResult }
  | { type: "error"; error: string };

export type WorkPresetCategory = "LABOR" | "MATERIAL" | "FEE" | "SERVICE";
export type WorkPresetUnitType = "FLAT" | "SQ_FT" | "HOUR" | "EACH";

export type WorkPreset = {
  id: string;
  tenantId: string;
  serviceType: ServiceType;
  catalogKey?: string | null;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  name: string;
  description?: string | null;
  defaultQuantity: number | string;
  unitCost: number | string;
  unitPrice: number | string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrgUserRole = "owner" | "admin" | "member";

export type OrganizationUser = {
  id: string;
  tenantId: string;
  role: OrgUserRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    createdAt: string;
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

export type QuickBooksConnectionStatus = "CONNECTED" | "NEEDS_REAUTH" | "ERROR" | "DISCONNECTED";

export type QuickBooksStatusPayload = {
  enabled: boolean;
  webhookConfigured: boolean;
  canManage: boolean;
  environment: "sandbox" | "production";
  redirectUri: string;
  webhookUrl: string;
  connection: null | {
    id: string;
    realmId: string;
    environment: string;
    companyName?: string | null;
    status: QuickBooksConnectionStatus;
    scopes: string[];
    connectedAtUtc: string;
    disconnectedAtUtc?: string | null;
    lastTokenRefreshAtUtc?: string | null;
    lastSyncAtUtc?: string | null;
    lastWebhookAtUtc?: string | null;
    lastError?: string | null;
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

export type QuickBooksInvoiceStatusPayload = {
  invoiceId: string;
  docNumber?: string | null;
  txnDate?: string | null;
  dueDate?: string | null;
  totalAmount: number;
  balance: number;
  currency?: string | null;
  emailStatus?: string | null;
  linkedPayments: Array<{ txnId: string; txnType: string }>;
  paid: boolean;
};

export type QuickBooksInvoiceSyncRecord = {
  id: string;
  quickBooksInvoiceId?: string | null;
  quickBooksDocNumber?: string | null;
  requestId?: string | null;
  status: "PENDING" | "SYNCED" | "FAILED";
  lastError?: string | null;
  lastAttemptedAtUtc?: string | null;
  syncedAtUtc?: string | null;
};

export type QuickBooksPushInvoiceResult = {
  sync: QuickBooksInvoiceSyncRecord;
  invoice: QuickBooksInvoiceStatusPayload;
  warnings: string[];
  customer: {
    quickBooksCustomerId: string;
    quickBooksDisplayName: string;
    created: boolean;
  };
  createdItems: number;
};

export const api = {
  auth: {
    signup: (body: {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
      primaryTrade: ServiceType;
      logoUrl?: string;
      generateLogoIfMissing?: boolean;
    }) => request<AuthPayload>("/v1/auth/signup", { method: "POST", body: JSON.stringify(body) }),

    signin: (body: { email: string; password: string }) =>
      request<AuthPayload>("/v1/auth/signin", { method: "POST", body: JSON.stringify(body) }),

    me: () => request<AuthSessionPayload>("/v1/auth/me"),
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
        request<{ disconnected: boolean }>(`/v1/integrations/quickbooks/disconnect`, {
          method: "POST",
        }),

      syncPreview: (quoteId: string) =>
        request<QuickBooksSyncPreview>(`/v1/integrations/quickbooks/quotes/${quoteId}/sync-preview`),

      pushInvoice: (
        quoteId: string,
        body?: { createCustomerIfMissing?: boolean; createItemsIfMissing?: boolean; dueInDays?: number },
      ) =>
        request<QuickBooksPushInvoiceResult>(`/v1/integrations/quickbooks/quotes/${quoteId}/push-invoice`, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        }),

      invoiceStatus: (quoteId: string) =>
        request<{
          sync: QuickBooksInvoiceSyncRecord;
          invoice: QuickBooksInvoiceStatusPayload;
        }>(`/v1/integrations/quickbooks/quotes/${quoteId}/invoice-status`),
    },
  },

  branding: {
    get: (tenantId: string) =>
      request<{
        tenant: {
          name: string;
          timezone: string;
        };
        branding: TenantBranding | null;
      }>(
        `/v1/tenants/${tenantId}/branding`,
      ),

    save: (
      tenantId: string,
      body: {
        logoUrl?: string | null;
        logoPosition: BrandingLogoPosition;
        hideQuoteFlyAttribution?: boolean;
        primaryColor: string;
        templateId: BrandingTemplateId;
        timezone: string;
        businessProfile: BrandingBusinessProfile;
        componentColors?: BrandingComponentColors | null;
      },
    ) =>
      request<{
        tenant: {
          name: string;
          timezone: string;
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
      generateLogoIfMissing?: boolean;
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

  org: {
    users: {
      list: () =>
        request<{
          members: OrganizationUser[];
          policy: {
            canManageUsers: boolean;
            teamMembersLimit: number | null;
            teamMembersUsed: number;
          };
        }>(`/v1/org/users`),

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
    list: (query?: { limit?: number; offset?: number; search?: string }) =>
      request<{ customers: Customer[]; pagination: Pagination }>(
        `/v1/customers${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          search: query?.search,
        })}`,
      ),

    create: (body: {
      fullName: string;
      phone: string;
      email?: string | null;
      notes?: string | null;
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
        followUpStatus?: LeadFollowUpStatus;
      },
    ) => request<{ customer: Customer }>(`/v1/customers/${customerId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

    archive: (customerId: string) =>
      request<void>(`/v1/customers/${customerId}/archive`, {
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
      customerId?: string;
      search?: string;
    }) =>
      request<{ quotes: Quote[]; pagination: Pagination }>(
        `/v1/quotes${toQueryString({
          limit: query?.limit,
          offset: query?.offset,
          status: query?.status,
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
      customerId: string;
      serviceType: ServiceType;
      title: string;
      scopeText: string;
      internalCostSubtotal: number;
      customerPriceSubtotal: number;
      taxAmount: number;
      aiUsageEventId?: string;
      lineItems?: Array<{
        description: string;
        sectionType?: "INCLUDED" | "ALTERNATE";
        sectionLabel?: string | null;
        quantity: number;
        unitCost: number;
        unitPrice: number;
      }>;
    }) =>
      request<{ quote: Quote }>(`/v1/quotes`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    createFromChat: (body: {
      prompt: string;
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
    }) =>
      request<ChatToQuoteResult>(`/v1/quotes/chat-draft`, {
        method: "POST",
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
      }>;
    }, options?: {
      onProgress?: (event: AiProgressEvent) => void;
    }) =>
      (async () => {
        const token = getToken();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const res = await fetch(`${API_BASE}/v1/quotes/ai-suggest`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;

            const event = JSON.parse(line) as AiSuggestionStreamEvent;
            if (event.type === "progress") {
              options?.onProgress?.(event);
              continue;
            }

            if (event.type === "error") {
              throw new ApiError(event.error, res.status, event);
            }

            if (event.type === "complete") {
              finalResult = event.result;
            }
          }
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
        jobStatus?: QuoteJobStatus;
        afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
        title?: string;
        scopeText?: string;
        internalCostSubtotal?: number;
        customerPriceSubtotal?: number;
        taxAmount?: number;
      },
    ) =>
      request<{ quote: Quote }>(`/v1/quotes/${quoteId}`, {
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
        body: { description: string; sectionType?: "INCLUDED" | "ALTERNATE"; sectionLabel?: string | null; quantity: number; unitCost: number; unitPrice: number },
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
  },
};
