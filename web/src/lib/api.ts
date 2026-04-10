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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
    subscriptionStatus?: string;
    subscriptionPlanCode?: string | null;
    trialEndsAtUtc?: string | null;
    subscriptionCurrentPeriodEndUtc?: string | null;
  };
  role: string;
};

export type QuoteStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "SENT_TO_CUSTOMER"
  | "ACCEPTED"
  | "REJECTED";

export type QuoteRevisionEventType =
  | "CREATED"
  | "UPDATED"
  | "STATUS_CHANGED"
  | "LINE_ITEM_CHANGED"
  | "DECISION";

export type QuoteOutboundChannel = "EMAIL_APP" | "SMS_APP" | "COPY";
export type LeadFollowUpStatus = "NEEDS_FOLLOW_UP" | "FOLLOWED_UP" | "WON" | "LOST";

export type ServiceType = "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING";
export type BrandingTemplateId = "modern" | "professional" | "bold" | "minimal" | "classic";
export type BrandingComponentColors = {
  headerBgColor?: string;
  sectionTitleColor?: string;
  tableHeaderBgColor?: string;
  totalsColor?: string;
  footerTextColor?: string;
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
  createdAt: string;
  updatedAt: string;
};

export type CustomerDuplicateMatch = {
  id: string;
  fullName: string;
  phone: string;
  email?: string | null;
  deletedAtUtc?: string | null;
  createdAt: string;
  matchReasons: Array<"phone" | "email">;
};

export type QuoteLineItem = {
  id: string;
  tenantId: string;
  quoteId: string;
  description: string;
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
  title: string;
  scopeText: string;
  internalCostSubtotal: DecimalLike;
  customerPriceSubtotal: DecimalLike;
  taxAmount: DecimalLike;
  totalAmount: DecimalLike;
  sentAt?: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: Customer;
  lineItems?: QuoteLineItem[];
};

export type QuoteRevisionSnapshot = {
  quote: {
    id: string;
    title: string;
    serviceType: ServiceType;
    status: QuoteStatus;
    scopeText: string;
    internalCostSubtotal: number;
    customerPriceSubtotal: number;
    taxAmount: number;
    totalAmount: number;
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
  channel: QuoteOutboundChannel;
  destination?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  createdAt: string;
};

type Pagination = { limit: number; offset: number; total: number };

export const api = {
  auth: {
    signup: (body: {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
    }) => request<AuthPayload>("/v1/auth/signup", { method: "POST", body: JSON.stringify(body) }),

    signin: (body: { email: string; password: string }) =>
      request<AuthPayload>("/v1/auth/signin", { method: "POST", body: JSON.stringify(body) }),

    me: () => request<AuthSessionPayload>("/v1/auth/me"),
  },

  branding: {
    get: (tenantId: string) =>
      request<{
        branding:
          | {
              primaryColor: string;
              templateId: BrandingTemplateId;
              logoUrl?: string | null;
              componentColors?: BrandingComponentColors | null;
            }
          | null;
      }>(
        `/v1/tenants/${tenantId}/branding`,
      ),

    save: (
      tenantId: string,
      body: {
        logoUrl?: string | null;
        primaryColor: string;
        templateId: BrandingTemplateId;
        componentColors?: BrandingComponentColors | null;
      },
    ) =>
      request<{
        branding: {
          primaryColor: string;
          templateId: BrandingTemplateId;
          logoUrl?: string | null;
          componentColors?: BrandingComponentColors | null;
        };
      }>(
        `/v1/tenants/${tenantId}/branding`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
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
      duplicateAction?: "merge" | "create_new";
      duplicateCustomerId?: string;
    }) => request<{
      customer: Customer;
      restored?: boolean;
      merged?: boolean;
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

    remove: (customerId: string) =>
      request<void>(`/v1/customers/${customerId}`, {
        method: "DELETE",
      }),
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

    create: (body: {
      customerId: string;
      serviceType: ServiceType;
      title: string;
      scopeText: string;
      internalCostSubtotal: number;
      customerPriceSubtotal: number;
      taxAmount: number;
    }) =>
      request<{ quote: Quote }>(`/v1/quotes`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    update: (
      quoteId: string,
      body: {
        customerId?: string;
        serviceType?: ServiceType;
        status?: QuoteStatus;
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

    remove: (quoteId: string) =>
      request<void>(`/v1/quotes/${quoteId}`, {
        method: "DELETE",
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

    lineItems: {
      create: (
        quoteId: string,
        body: { description: string; quantity: number; unitCost: number; unitPrice: number },
      ) =>
        request<{ lineItem: QuoteLineItem; quote: Quote }>(`/v1/quotes/${quoteId}/line-items`, {
          method: "POST",
          body: JSON.stringify(body),
        }),

      update: (
        quoteId: string,
        lineItemId: string,
        body: Partial<{ description: string; quantity: number; unitCost: number; unitPrice: number }>,
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
