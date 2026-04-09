/**
 * Human-readable model map for architecture/design discussions.
 * Source of truth remains prisma/schema.prisma.
 */

export type UtcDate = Date;
export type DecimalValue = string;

export type ServiceCategory =
  | "HVAC"
  | "PLUMBING"
  | "FLOORING"
  | "ROOFING"
  | "GARDENING";

export type QuoteStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "SENT_TO_CUSTOMER"
  | "ACCEPTED"
  | "REJECTED";

export type SmsMessageDirection = "INBOUND" | "OUTBOUND";

export type QuoteDecisionStatus =
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REVISION_REQUESTED";

export type QuoteRevisionEventType =
  | "CREATED"
  | "UPDATED"
  | "STATUS_CHANGED"
  | "LINE_ITEM_CHANGED"
  | "DECISION";

export interface BrandingComponentColors {
  headerBgColor?: string;
  sectionTitleColor?: string;
  tableHeaderBgColor?: string;
  totalsColor?: string;
  footerTextColor?: string;
}

export interface TenantBrandingRow {
  id: string;
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string;
  templateId: string;
  componentColors: BrandingComponentColors | null;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface TenantUserRow {
  id: string;
  tenantId: string;
  userId: string;
  role: string;
  createdAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface TenantPhoneNumberRow {
  id: string;
  tenantId: string;
  provider: string;
  e164Number: string;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface CustomerRow {
  id: string;
  tenantId: string;
  fullName: string;
  email: string | null;
  phone: string;
  notes: string | null;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface PricingProfileRow {
  id: string;
  tenantId: string;
  serviceType: ServiceCategory;
  laborRate: DecimalValue;
  materialMarkup: DecimalValue;
  isDefault: boolean;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface QuoteTemplateRow {
  id: string;
  tenantId: string;
  name: string;
  serviceType: ServiceCategory;
  description: string | null;
  isActive: boolean;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface QuoteRow {
  id: string;
  tenantId: string;
  customerId: string;
  serviceType: ServiceCategory;
  status: QuoteStatus;
  title: string;
  scopeText: string;
  internalCostSubtotal: DecimalValue;
  customerPriceSubtotal: DecimalValue;
  taxAmount: DecimalValue;
  totalAmount: DecimalValue;
  sentAt: UtcDate | null;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface QuoteLineItemRow {
  id: string;
  tenantId: string;
  quoteId: string;
  description: string;
  quantity: DecimalValue;
  unitCost: DecimalValue;
  unitPrice: DecimalValue;
  createdAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface QuoteRevisionRow {
  id: string;
  tenantId: string;
  quoteId: string;
  customerId: string;
  version: number;
  eventType: QuoteRevisionEventType;
  changedFields: string[];
  title: string;
  status: QuoteStatus;
  customerPriceSubtotal: DecimalValue;
  totalAmount: DecimalValue;
  snapshot: Record<string, unknown>;
  createdAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface SmsMessageRow {
  id: string;
  tenantId: string;
  externalSid: string | null;
  direction: SmsMessageDirection;
  fromNumber: string;
  toNumber: string;
  body: string;
  receivedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface QuoteDecisionSessionRow {
  id: string;
  tenantId: string;
  quoteId: string;
  requesterPhone: string;
  status: QuoteDecisionStatus;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export const TABLE_RELATION_MAP = {
  TenantBranding: {
    belongsTo: ["Tenant"],
  },
  Tenant: {
    hasMany: [
      "TenantUser",
      "Customer",
      "PricingProfile",
      "QuoteTemplate",
      "Quote",
      "QuoteDecisionSession",
      "SmsMessage",
      "QuoteLineItem",
      "QuoteRevision",
    ],
    hasOne: ["TenantBranding", "TenantPhoneNumber"],
  },
  User: {
    hasMany: ["TenantUser"],
  },
  TenantUser: {
    belongsTo: ["Tenant", "User"],
  },
  TenantPhoneNumber: {
    belongsTo: ["Tenant"],
  },
  Customer: {
    belongsTo: ["Tenant"],
    hasMany: ["Quote", "QuoteRevision"],
  },
  PricingProfile: {
    belongsTo: ["Tenant"],
  },
  QuoteTemplate: {
    belongsTo: ["Tenant"],
  },
  Quote: {
    belongsTo: ["Tenant", "Customer"],
    hasMany: ["QuoteLineItem", "QuoteDecisionSession", "QuoteRevision"],
  },
  QuoteLineItem: {
    belongsTo: ["Tenant", "Quote"],
  },
  QuoteRevision: {
    belongsTo: ["Tenant", "Quote", "Customer"],
  },
  SmsMessage: {
    belongsTo: ["Tenant"],
  },
  QuoteDecisionSession: {
    belongsTo: ["Tenant", "Quote"],
  },
} as const;
