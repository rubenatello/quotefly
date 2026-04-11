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
  | "GARDENING"
  | "CONSTRUCTION";

export type QuoteStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "SENT_TO_CUSTOMER"
  | "ACCEPTED"
  | "REJECTED";

export type QuoteJobStatus =
  | "NOT_STARTED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "COMPLETED";

export type AfterSaleFollowUpStatus =
  | "NOT_READY"
  | "DUE"
  | "COMPLETED";

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

export type LeadFollowUpStatus =
  | "NEEDS_FOLLOW_UP"
  | "FOLLOWED_UP"
  | "WON"
  | "LOST";

export type QuoteOutboundChannel =
  | "EMAIL_APP"
  | "SMS_APP"
  | "COPY";

export type PresetCategory =
  | "LABOR"
  | "MATERIAL"
  | "FEE"
  | "SERVICE";

export type PresetUnitType =
  | "FLAT"
  | "SQ_FT"
  | "HOUR"
  | "EACH";

export interface BrandingComponentColors {
  headerBgColor?: string;
  headerTextColor?: string;
  sectionTitleColor?: string;
  tableHeaderBgColor?: string;
  tableHeaderTextColor?: string;
  totalsColor?: string;
  footerTextColor?: string;
}

export interface TenantBrandingRow {
  id: string;
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string;
  templateId: string;
  businessEmail: string | null;
  businessPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
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
  primaryTrade: ServiceCategory | null;
  onboardingCompletedAtUtc: UtcDate | null;
  subscriptionStatus: string;
  subscriptionPlanCode: string | null;
  trialStartsAtUtc: UtcDate | null;
  trialEndsAtUtc: UtcDate | null;
  subscriptionCurrentPeriodEndUtc: UtcDate | null;
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
  followUpStatus: LeadFollowUpStatus;
  followUpUpdatedAtUtc: UtcDate | null;
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
  jobStatus: QuoteJobStatus;
  afterSaleFollowUpStatus: AfterSaleFollowUpStatus;
  title: string;
  scopeText: string;
  internalCostSubtotal: DecimalValue;
  customerPriceSubtotal: DecimalValue;
  taxAmount: DecimalValue;
  totalAmount: DecimalValue;
  aiGeneratedAtUtc: UtcDate | null;
  sentAt: UtcDate | null;
  closedAtUtc: UtcDate | null;
  jobCompletedAtUtc: UtcDate | null;
  afterSaleFollowUpDueAtUtc: UtcDate | null;
  afterSaleFollowUpCompletedAtUtc: UtcDate | null;
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

export interface QuoteOutboundEventRow {
  id: string;
  tenantId: string;
  quoteId: string;
  customerId: string;
  channel: QuoteOutboundChannel;
  destination: string | null;
  subject: string | null;
  bodyPreview: string | null;
  createdAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface WorkPresetRow {
  id: string;
  tenantId: string;
  serviceType: ServiceCategory;
  catalogKey: string | null;
  category: PresetCategory;
  unitType: PresetUnitType;
  name: string;
  description: string | null;
  defaultQuantity: DecimalValue;
  unitCost: DecimalValue;
  unitPrice: DecimalValue;
  isDefault: boolean;
  createdAt: UtcDate;
  updatedAt: UtcDate;
  deletedAtUtc: UtcDate | null;
}

export interface BillingWebhookEventRow {
  id: string;
  stripeEventId: string;
  eventType: string;
  tenantId: string | null;
  payload: Record<string, unknown>;
  createdAt: UtcDate;
  processedAtUtc: UtcDate;
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
      "QuoteOutboundEvent",
      "BillingWebhookEvent",
      "WorkPreset",
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
    hasMany: ["Quote", "QuoteRevision", "QuoteOutboundEvent"],
  },
  PricingProfile: {
    belongsTo: ["Tenant"],
  },
  QuoteTemplate: {
    belongsTo: ["Tenant"],
  },
  Quote: {
    belongsTo: ["Tenant", "Customer"],
    hasMany: ["QuoteLineItem", "QuoteDecisionSession", "QuoteRevision", "QuoteOutboundEvent"],
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
  QuoteOutboundEvent: {
    belongsTo: ["Tenant", "Quote", "Customer"],
  },
  BillingWebhookEvent: {
    belongsTo: ["Tenant"],
  },
  WorkPreset: {
    belongsTo: ["Tenant"],
  },
} as const;
