import { LeadFollowUpStatus, Prisma, PrismaClient, QuoteOutboundChannel, QuoteRevisionEventType } from "@prisma/client";
import { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import type { AccessContext } from "../lib/access-policy";
import {
  accumulateAiUsageTelemetry,
  assertAiUsageAvailable,
  buildAiUsageResponse,
  createAiUsageEvent,
} from "../lib/ai-usage";
import {
  buildGovernedQuoteAiContext,
  markQuoteAiRetrievalSourcesDeleted,
  type AiRetrievalResult,
} from "../lib/ai-retrieval";
import { enqueueAiIndexJob, enqueueQuoteAiIndexJobs } from "../lib/ai-index-jobs";
import { createCustomerActivityEvent, resolveActivityActor, type ActivityActor } from "../lib/activity";
import { normalizeCustomerPhone, normalizePhoneSearchDigits } from "../lib/phone";
import {
  PaginationQuerySchema,
  tenantActiveCustomerScope,
  tenantActiveQuoteScope,
  tenantActiveScope,
} from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  WorkspaceAssigneeSelect,
  assignedRecordScope,
  defaultAssigneeForCreatedRecord,
  lockActiveTenantAssignee,
  validateActiveTenantAssignee,
} from "../lib/workspace-assignment";
import {
  buildTenantEntitlements,
  loadTenantEntitlements,
  startOfCurrentUtcMonth,
  startOfNextUtcMonth,
} from "../lib/subscription";
import { parseChatToQuotePrompt, type ParsedChatToQuoteDraft } from "../services/chat-to-quote";
import {
  aiBuildQuoteRevisionPlan,
  aiParseChatToQuotePrompt,
  createAiTelemetryAccumulator,
  getAiQuoteRuntimeInfo,
} from "../services/ai-quote";
import {
  generateQuotePdfBuffer,
  type QuoteComponentColors,
  type QuotePdfData,
} from "../services/quote-pdf";
import {
  persistQuoteBrandAsset,
  QuoteBrandAssetUnavailableError,
  resolveQuoteBrandingLogoDataUrl,
  type QuoteBrandAssetReference,
} from "../services/quote-brand-asset";
import {
  applyQuoteSheetLineMutations,
  QuoteSheetLineNotFoundError,
} from "../services/quote-sheet";
import {
  assertNoRetainedJobForQuote,
  countActiveJobsForQuote,
  ensureJobForAcceptedQuote,
  JobServiceError,
  type JobPublic,
} from "../services/jobs";
import { buildQuickBooksInvoiceCsv } from "../services/quickbooks-csv";
import { findBestStandardWorkPresetMatch, findStandardWorkPresetMatches } from "../services/work-preset-catalog";
import {
  normalizeSupportedLocale,
  SupportedLocaleSchema,
} from "../lib/supported-locale";

const ServiceTypeSchema = z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);
const QuoteStatusSchema = z.enum([
  "DRAFT",
  "READY_FOR_REVIEW",
  "SENT_TO_CUSTOMER",
  "ACCEPTED",
  "REJECTED",
]);

const QuoteJobStatusSchema = z.enum([
  "NOT_STARTED",
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
]);

const AfterSaleFollowUpStatusSchema = z.enum([
  "NOT_READY",
  "DUE",
  "COMPLETED",
]);

const QuoteLineSectionTypeSchema = z.enum(["INCLUDED", "ALTERNATE"]);

const CreateQuoteSchema = z.object({
  customerId: z.string().min(1),
  serviceType: ServiceTypeSchema,
  title: z.string().min(3),
  scopeText: z.string().min(3),
  internalCostSubtotal: z.number().nonnegative(),
  customerPriceSubtotal: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().default(0),
  aiUsageEventId: z.string().min(1).optional(),
  assignedTenantUserId: z.string().min(1).nullable().optional(),
  documentLocale: SupportedLocaleSchema.optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1),
        sectionType: QuoteLineSectionTypeSchema.default("INCLUDED"),
        sectionLabel: z.string().trim().max(80).optional().nullable(),
        quantity: z.number().positive(),
        unitCost: z.number().nonnegative(),
        unitPrice: z.number().nonnegative(),
        sourcePresetId: z.string().min(1).optional(),
      }),
    )
    .max(300)
    .optional(),
});

const UpdateQuoteSchema = z
  .object({
    customerId: z.string().min(1).optional(),
    serviceType: ServiceTypeSchema.optional(),
    status: QuoteStatusSchema.optional(),
    jobStatus: QuoteJobStatusSchema.optional(),
    afterSaleFollowUpStatus: AfterSaleFollowUpStatusSchema.optional(),
    title: z.string().min(3).optional(),
    scopeText: z.string().min(3).optional(),
    internalCostSubtotal: z.number().nonnegative().optional(),
    customerPriceSubtotal: z.number().nonnegative().optional(),
    taxAmount: z.number().nonnegative().optional(),
    assignedTenantUserId: z.string().min(1).nullable().optional(),
    documentLocale: SupportedLocaleSchema.optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required.",
  });

const ListQuotesQuerySchema = PaginationQuerySchema.extend({
  status: QuoteStatusSchema.optional(),
  stage: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "INVOICED"]).optional(),
  customerId: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

type QuoteLifecycleStage = NonNullable<z.infer<typeof ListQuotesQuerySchema>["stage"]>;

function quoteLifecycleWhere(stage: QuoteLifecycleStage): Prisma.QuoteWhereInput {
  const syncedInvoice = {
    quickBooksInvoiceSyncs: {
      some: {
        deletedAtUtc: null,
        status: "SYNCED" as const,
        quickBooksInvoiceId: { not: null },
      },
    },
  };

  if (stage === "INVOICED") return syncedInvoice;
  if (stage === "ACCEPTED") {
    return {
      status: "ACCEPTED",
      NOT: syncedInvoice,
    };
  }
  if (stage === "DECLINED") return { status: "REJECTED" };
  if (stage === "SENT") return { status: "SENT_TO_CUSTOMER" };
  if (stage === "READY") return { status: "READY_FOR_REVIEW" };
  return { status: "DRAFT" };
}

const ExportQuickBooksInvoicesCsvSchema = z.object({
  quoteIds: z.array(z.string().min(1)).min(1).max(100),
  dueInDays: z.number().int().min(0).max(365).default(14),
});

const QuoteParamsSchema = z.object({
  quoteId: z.string().min(1),
});

const QuoteRevisionParamsSchema = z.object({
  quoteId: z.string().min(1),
  revisionId: z.string().min(1),
});

const QuoteDecisionSchema = z.object({
  decision: z.enum(["send", "revise"]),
});

const CreateLineItemSchema = z.object({
  description: z.string().min(1),
  sectionType: QuoteLineSectionTypeSchema.default("INCLUDED"),
  sectionLabel: z.string().trim().max(80).optional().nullable(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  sourcePresetId: z.string().min(1).optional(),
});

const UpdateLineItemSchema = z
  .object({
    description: z.string().min(1).optional(),
    sectionType: QuoteLineSectionTypeSchema.optional(),
    sectionLabel: z.string().trim().max(80).optional().nullable(),
    quantity: z.number().positive().optional(),
    unitCost: z.number().nonnegative().optional(),
    unitPrice: z.number().nonnegative().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required.",
  });

const QuoteSheetLineSchema = z.object({
  description: z.string().min(1),
  sectionType: QuoteLineSectionTypeSchema.default("INCLUDED"),
  sectionLabel: z.string().trim().max(80).optional().nullable(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  sourcePresetId: z.string().min(1).optional(),
});

const SaveQuoteSheetSchema = z
  .object({
    quote: z.object({
      serviceType: ServiceTypeSchema,
      status: QuoteStatusSchema,
      jobStatus: QuoteJobStatusSchema,
      afterSaleFollowUpStatus: AfterSaleFollowUpStatusSchema,
      title: z.string().min(3),
      scopeText: z.string().min(3),
      taxAmount: z.number().nonnegative(),
      documentLocale: SupportedLocaleSchema.optional(),
    }),
    lineItems: z.array(QuoteSheetLineSchema.extend({ id: z.string().min(1) })).max(300).default([]),
    newLineItems: z.array(QuoteSheetLineSchema).max(300).default([]),
  })
  .superRefine((payload, context) => {
    if (payload.lineItems.length + payload.newLineItems.length > 300) {
      context.addIssue({
        code: "custom",
        path: ["lineItems"],
        message: "At most 300 line changes can be saved at once.",
      });
    }

    const ids = new Set<string>();
    for (const [index, line] of payload.lineItems.entries()) {
      if (ids.has(line.id)) {
        context.addIssue({
          code: "custom",
          path: ["lineItems", index, "id"],
          message: "Each existing line can only be saved once.",
        });
      }
      ids.add(line.id);
    }
  });

const QuoteLineItemParamsSchema = z.object({
  quoteId: z.string().min(1),
  lineItemId: z.string().min(1),
});

const QueryBooleanSchema = z.preprocess((raw) => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "1" || value === "true" || value === "yes") return true;
    if (value === "0" || value === "false" || value === "no") return false;
  }
  return raw;
}, z.boolean());

const QuotePdfQuerySchema = z.object({
  download: QueryBooleanSchema.default(true),
});

const QuoteHistoryQuerySchema = PaginationQuerySchema.extend({
  customerId: z.string().min(1).optional(),
  quoteId: z.string().min(1).optional(),
});

const QuoteHistoryByQuoteQuerySchema = PaginationQuerySchema;
const QuoteAiRunsByQuoteQuerySchema = PaginationQuerySchema;

const CreateQuoteOutboundEventSchema = z.object({
  channel: z.enum(["EMAIL_APP", "SMS_APP", "COPY", "NATIVE_SHARE"]),
  destination: z.string().trim().min(1).max(320).optional(),
  subject: z.string().trim().min(1).max(220).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
});

const ConfirmQuoteSendSchema = CreateQuoteOutboundEventSchema.extend({
  idempotencyKey: z.string().trim().min(16).max(100),
});

const QuoteOutboundEventQuerySchema = PaginationQuerySchema;

const CreateQuoteFromChatSchema = z.object({
  prompt: z.string().trim().min(12).max(5000),
  customerName: z.string().trim().min(2).max(120).optional(),
  customerPhone: z.string().trim().min(7).max(40).optional(),
  customerEmail: z.string().trim().email().optional(),
});

const SuggestQuoteWithAiSchema = z.object({
  prompt: z.string().trim().min(12).max(5000),
  quoteId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  serviceType: ServiceTypeSchema.optional(),
  currentTitle: z.string().trim().max(220).optional(),
  currentScopeText: z.string().trim().max(5000).optional(),
  currentLineItems: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        description: z.string().trim().min(1).max(5000),
        sectionType: QuoteLineSectionTypeSchema.optional(),
        sectionLabel: z.string().trim().max(80).optional().nullable(),
        quantity: z.number().positive(),
        unitCost: z.number().nonnegative(),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .max(100)
    .optional(),
});


const QuoteRevisionListSelect = {
  id: true,
  quoteId: true,
  customerId: true,
  version: true,
  eventType: true,
  changedFields: true,
  actorUserId: true,
  actorEmail: true,
  actorName: true,
  title: true,
  status: true,
  customerPriceSubtotal: true,
  totalAmount: true,
  createdAt: true,
  quote: {
    select: {
      id: true,
      title: true,
    },
  },
  customer: {
    select: {
      id: true,
      fullName: true,
    },
  },
} as const satisfies Prisma.QuoteRevisionSelect;

const AiUsageTraceSelect = {
  id: true,
  quoteId: true,
  customerId: true,
  actorUserId: true,
  actorEmail: true,
  actorName: true,
  eventType: true,
  purpose: true,
  classification: true,
  serviceType: true,
  creditsConsumed: true,
  requestCount: true,
  promptTokens: true,
  completionTokens: true,
  totalTokens: true,
  estimatedCostUsd: true,
  promptRedacted: true,
  model: true,
  insightSummary: true,
  insightReasons: true,
  insightSourceLabels: true,
  confidenceLevel: true,
  confidenceLabel: true,
  riskNote: true,
  patchAdded: true,
  patchUpdated: true,
  patchRemoved: true,
  sourceCount: true,
  createdAt: true,
} as const satisfies Prisma.AiUsageEventSelect;

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function calculateQuoteTotal(customerPriceSubtotal: number, taxAmount: number): number {
  return roundCurrency(customerPriceSubtotal + taxAmount);
}

function normalizeQuoteLineSectionType(value?: string | null): z.infer<typeof QuoteLineSectionTypeSchema> {
  return value === "ALTERNATE" ? "ALTERNATE" : "INCLUDED";
}

function isIncludedQuoteLineSection(value?: string | null) {
  return normalizeQuoteLineSectionType(value) === "INCLUDED";
}

function canEditQuoteDocumentLocale(status: string): boolean {
  return status === "DRAFT" || status === "READY_FOR_REVIEW";
}

class QuoteDocumentLocaleLockedError extends Error {
  constructor() {
    super("Customer document language cannot change after the quote has been sent.");
    this.name = "QuoteDocumentLocaleLockedError";
  }
}

function formatAiRenewalDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatUsdValue(value: number) {
  return Number(value.toFixed(2)).toFixed(2);
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function safeFileLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function mapQuoteStatusToFollowUpStatus(status?: z.infer<typeof QuoteStatusSchema>): LeadFollowUpStatus | undefined {
  if (status === "SENT_TO_CUSTOMER") return "NEEDS_FOLLOW_UP";
  if (status === "ACCEPTED") return "WON";
  if (status === "REJECTED") return "LOST";
  return undefined;
}

async function getActiveQuoteForTenant(
  tx: Prisma.TransactionClient,
  quoteId: string,
  tenantId: string,
  assignedTenantUserId?: string,
) {
  return tx.quote.findFirst({
    where: {
      id: quoteId,
      ...tenantActiveQuoteScope(tenantId),
      ...(assignedTenantUserId ? { assignedTenantUserId } : {}),
    },
  });
}

async function lockActiveQuoteForMutation(
  tx: Prisma.TransactionClient,
  input: { quoteId: string; tenantId: string; assignedTenantUserId?: string },
) {
  const assignmentScope = input.assignedTenantUserId
    ? Prisma.sql`AND quote."assignedTenantUserId" = ${input.assignedTenantUserId}`
    : Prisma.empty;
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT quote.id
    FROM "Quote" AS quote
    WHERE quote.id = ${input.quoteId}
      AND quote."tenantId" = ${input.tenantId}
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
      ${assignmentScope}
    FOR UPDATE OF quote
  `);
  if (!locked) return null;
  return getActiveQuoteForTenant(tx, input.quoteId, input.tenantId, input.assignedTenantUserId);
}

async function recalculateQuoteFromLineItems(
  tx: Prisma.TransactionClient,
  quoteId: string,
  tenantId: string,
) {
  const quote = await getActiveQuoteForTenant(tx, quoteId, tenantId);
  if (!quote) return null;

  const lineItems = await tx.quoteLineItem.findMany({
    where: {
      quoteId,
      ...tenantActiveScope(tenantId),
    },
    select: {
      sectionType: true,
      quantity: true,
      unitCost: true,
      unitPrice: true,
    },
  });

  let internalCostSubtotal = 0;
  let customerPriceSubtotal = 0;

  for (const lineItem of lineItems) {
    if (!isIncludedQuoteLineSection(lineItem.sectionType)) {
      continue;
    }
    const qty = Number(lineItem.quantity);
    internalCostSubtotal += qty * Number(lineItem.unitCost);
    customerPriceSubtotal += qty * Number(lineItem.unitPrice);
  }

  const roundedInternal = roundCurrency(internalCostSubtotal);
  const roundedCustomer = roundCurrency(customerPriceSubtotal);
  const taxAmount = Number(quote.taxAmount);
  const totalAmount = calculateQuoteTotal(roundedCustomer, taxAmount);

  return tx.quote.update({
    where: { id: quote.id },
    data: {
      internalCostSubtotal: roundedInternal,
      customerPriceSubtotal: roundedCustomer,
      totalAmount,
    },
  });
}

interface RevisionSnapshotLineItem {
  id: string;
  description: string;
  sectionType: z.infer<typeof QuoteLineSectionTypeSchema>;
  sectionLabel: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  lineTotal: number;
}

interface RevisionSnapshot {
  quote: {
    id: string;
    title: string;
    serviceType: string;
    status: string;
    jobStatus: string;
    afterSaleFollowUpStatus: string;
    scopeText: string;
    internalCostSubtotal: number;
    customerPriceSubtotal: number;
    taxAmount: number;
    totalAmount: number;
    documentLocale?: string;
    sentAtUtc?: string | null;
    closedAtUtc: string | null;
    jobCompletedAtUtc: string | null;
    afterSaleFollowUpDueAtUtc: string | null;
    afterSaleFollowUpCompletedAtUtc: string | null;
  };
  customer: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string;
  };
  lineItems: RevisionSnapshotLineItem[];
  document?: {
    locale?: string;
    tenant: QuotePdfData["tenant"];
    branding: Omit<QuotePdfData["branding"], "logoUrl"> & {
      logoUrl?: string | null;
      logoAsset?: QuoteBrandAssetReference | null;
    };
  };
}

const QuoteBrandAssetReferenceSchema = z.object({
  id: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const RevisionDocumentSnapshotSchema = z.object({
  locale: SupportedLocaleSchema.optional(),
  tenant: z.object({
    name: z.string().min(1),
    timezone: z.string().min(1),
  }),
  branding: z.object({
    templateId: z.string().min(1),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    logoUrl: z.string().nullable().optional(),
    logoAsset: QuoteBrandAssetReferenceSchema.nullable().optional(),
    logoPosition: z.enum(["left", "center", "right"]).nullable().optional(),
    showQuoteFlyAttribution: z.boolean(),
    businessEmail: z.string().nullable().optional(),
    businessPhone: z.string().nullable().optional(),
    addressLine1: z.string().nullable().optional(),
    addressLine2: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    componentColors: z
      .object({
        headerBgColor: z.string().optional(),
        headerTextColor: z.string().optional(),
        sectionTitleColor: z.string().optional(),
        tableHeaderBgColor: z.string().optional(),
        tableHeaderTextColor: z.string().optional(),
        totalsColor: z.string().optional(),
        footerTextColor: z.string().optional(),
      })
      .nullable()
      .optional(),
  }),
});

const RevisionSnapshotLineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  sectionType: QuoteLineSectionTypeSchema.default("INCLUDED"),
  sectionLabel: z.string().nullable().optional(),
  quantity: z.number().finite(),
  unitCost: z.number().finite(),
  unitPrice: z.number().finite(),
  lineTotal: z.number().finite(),
});

const RevisionSnapshotSchema = z.object({
  quote: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    serviceType: ServiceTypeSchema,
    status: QuoteStatusSchema,
    jobStatus: QuoteJobStatusSchema,
    afterSaleFollowUpStatus: AfterSaleFollowUpStatusSchema,
    scopeText: z.string(),
    internalCostSubtotal: z.number().finite(),
    customerPriceSubtotal: z.number().finite(),
    taxAmount: z.number().finite(),
    totalAmount: z.number().finite(),
    documentLocale: SupportedLocaleSchema.optional(),
    sentAtUtc: z.string().datetime().nullable().optional(),
    closedAtUtc: z.string().datetime().nullable(),
    jobCompletedAtUtc: z.string().datetime().nullable(),
    afterSaleFollowUpDueAtUtc: z.string().datetime().nullable(),
    afterSaleFollowUpCompletedAtUtc: z.string().datetime().nullable(),
  }),
  customer: z.object({
    id: z.string().min(1),
    fullName: z.string().min(1),
    email: z.string().email().nullable(),
    phone: z.string().min(1),
  }),
  lineItems: z.array(RevisionSnapshotLineItemSchema),
  document: RevisionDocumentSnapshotSchema.optional(),
});

async function getQuoteRevisionContext(
  tx: Prisma.TransactionClient,
  quoteId: string,
  tenantId: string,
) {
  return tx.quote.findFirst({
    where: {
      id: quoteId,
      ...tenantActiveQuoteScope(tenantId),
    },
    include: {
      tenant: {
        select: {
          name: true,
          timezone: true,
          subscriptionStatus: true,
          subscriptionPlanCode: true,
          trialStartsAtUtc: true,
          trialEndsAtUtc: true,
          subscriptionCurrentPeriodEndUtc: true,
          branding: {
            select: {
              templateId: true,
              primaryColor: true,
              logoUrl: true,
              logoPosition: true,
              hideQuoteFlyAttribution: true,
              businessEmail: true,
              businessPhone: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
              componentColors: true,
            },
          },
        },
      },
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
        },
      },
      lineItems: {
        where: tenantActiveScope(tenantId),
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          description: true,
          sectionType: true,
          sectionLabel: true,
          quantity: true,
          unitCost: true,
          unitPrice: true,
        },
      },
    },
  });
}

function buildQuoteRevisionSnapshot(
  context: NonNullable<Awaited<ReturnType<typeof getQuoteRevisionContext>>>,
  options?: { captureDocument?: boolean; actorEmail?: string | null },
): RevisionSnapshot {
  const entitlements = buildTenantEntitlements(context.tenant, new Date(), {
    userEmail: options?.actorEmail,
  });
  const componentColors =
    (context.tenant.branding?.componentColors as QuoteComponentColors | null | undefined) ?? null;

  return {
    quote: {
      id: context.id,
      title: context.title,
      serviceType: context.serviceType,
      status: context.status,
      jobStatus: context.jobStatus,
      afterSaleFollowUpStatus: context.afterSaleFollowUpStatus,
      scopeText: context.scopeText,
      internalCostSubtotal: Number(context.internalCostSubtotal),
      customerPriceSubtotal: Number(context.customerPriceSubtotal),
      taxAmount: Number(context.taxAmount),
      totalAmount: Number(context.totalAmount),
      documentLocale: normalizeSupportedLocale(context.documentLocale),
      sentAtUtc: context.sentAt?.toISOString() ?? null,
      closedAtUtc: context.closedAtUtc?.toISOString() ?? null,
      jobCompletedAtUtc: context.jobCompletedAtUtc?.toISOString() ?? null,
      afterSaleFollowUpDueAtUtc: context.afterSaleFollowUpDueAtUtc?.toISOString() ?? null,
      afterSaleFollowUpCompletedAtUtc: context.afterSaleFollowUpCompletedAtUtc?.toISOString() ?? null,
    },
    customer: {
      id: context.customer.id,
      fullName: context.customer.fullName,
      email: context.customer.email,
      phone: context.customer.phone,
    },
    lineItems: context.lineItems.map((lineItem) => {
      const quantity = Number(lineItem.quantity);
      const unitPrice = Number(lineItem.unitPrice);
      return {
        id: lineItem.id,
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel,
        quantity,
        unitCost: Number(lineItem.unitCost),
        unitPrice,
        lineTotal: roundCurrency(quantity * unitPrice),
      };
    }),
    ...(options?.captureDocument
      ? {
          document: {
            locale: normalizeSupportedLocale(context.documentLocale),
            tenant: {
              name: context.tenant.name,
              timezone: context.tenant.timezone,
            },
            branding: {
              templateId: context.tenant.branding?.templateId ?? "modern",
              primaryColor: context.tenant.branding?.primaryColor ?? "#5B85AA",
              logoUrl: context.tenant.branding?.logoUrl ?? null,
              logoPosition:
                context.tenant.branding?.logoPosition === "center" ||
                context.tenant.branding?.logoPosition === "right"
                  ? context.tenant.branding.logoPosition
                  : "left",
              showQuoteFlyAttribution:
                entitlements.planCode === "starter"
                  ? true
                  : !Boolean(context.tenant.branding?.hideQuoteFlyAttribution),
              businessEmail: context.tenant.branding?.businessEmail ?? null,
              businessPhone: context.tenant.branding?.businessPhone ?? null,
              addressLine1: context.tenant.branding?.addressLine1 ?? null,
              addressLine2: context.tenant.branding?.addressLine2 ?? null,
              city: context.tenant.branding?.city ?? null,
              state: context.tenant.branding?.state ?? null,
              postalCode: context.tenant.branding?.postalCode ?? null,
              componentColors,
            },
          },
        }
      : {}),
  };
}

async function externalizeRevisionDocumentLogo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  document: NonNullable<RevisionSnapshot["document"]>,
): Promise<NonNullable<RevisionSnapshot["document"]>> {
  const { logoUrl, logoAsset, ...branding } = document.branding;
  if (logoAsset) {
    return {
      ...document,
      branding: {
        ...branding,
        logoAsset,
      },
    };
  }

  const persistedAsset = await persistQuoteBrandAsset(tx, tenantId, logoUrl);
  return {
    ...document,
    branding: {
      ...branding,
      ...(persistedAsset ? { logoAsset: persistedAsset } : {}),
    },
  };
}

async function resolveRevisionDocumentBranding(
  prisma: PrismaClient,
  tenantId: string,
  document: NonNullable<RevisionSnapshot["document"]>,
): Promise<QuotePdfData["branding"]> {
  const { logoAsset, logoUrl, ...branding } = document.branding;
  return {
    ...branding,
    logoUrl: await resolveQuoteBrandingLogoDataUrl(prisma, tenantId, { logoAsset, logoUrl }),
  };
}

async function createQuoteRevision(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    quoteId: string;
    eventType: QuoteRevisionEventType;
    changedFields?: string[];
    actor?: ActivityActor;
    documentSnapshot?: RevisionSnapshot["document"];
  },
) {
  const context = await getQuoteRevisionContext(tx, params.quoteId, params.tenantId);
  if (!context) return null;

  const lastRevision = await tx.quoteRevision.findFirst({
    where: {
      quoteId: context.id,
      ...tenantActiveScope(params.tenantId),
    },
    orderBy: { version: "desc" },
    select: { version: true, status: true },
  });

  const captureCurrentDocument =
    context.status === "SENT_TO_CUSTOMER" && lastRevision?.status !== "SENT_TO_CUSTOMER";
  const snapshot = buildQuoteRevisionSnapshot(context, {
    captureDocument: captureCurrentDocument,
    actorEmail: params.actor?.actorEmail,
  });
  if (params.documentSnapshot) {
    snapshot.document = params.documentSnapshot;
  }
  if (snapshot.document) {
    snapshot.document = await externalizeRevisionDocumentLogo(tx, params.tenantId, snapshot.document);
  }
  const hasDocumentSnapshot = Boolean(snapshot.document);
  const version = (lastRevision?.version ?? 0) + 1;
  const changedFields = Array.from(
    new Set([...(params.changedFields ?? []), ...(hasDocumentSnapshot ? ["documentSnapshot"] : [])]),
  );

  const revision = await tx.quoteRevision.create({
    data: {
      tenantId: params.tenantId,
      quoteId: context.id,
      customerId: context.customer.id,
      version,
      eventType: params.eventType,
      changedFields,
      actorUserId: params.actor?.actorUserId,
      actorEmail: params.actor?.actorEmail,
      actorName: params.actor?.actorName,
      title: context.title,
      status: context.status,
      customerPriceSubtotal: Number(context.customerPriceSubtotal),
      totalAmount: Number(context.totalAmount),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
  await enqueueQuoteAiIndexJobs(tx, {
    tenantId: params.tenantId,
    quoteId: context.id,
    operation: "UPSERT",
    expectedSourceUpdatedAtUtc: context.updatedAt,
  });
  await enqueueAiIndexJob(tx, {
    tenantId: params.tenantId,
    sourceType: "Customer",
    sourceId: context.customer.id,
    operation: "UPSERT",
  });
  return revision;
}

async function restoreQuoteRevision(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    quoteId: string;
    revisionId: string;
    actor?: ActivityActor;
  },
) {
  const quote = await lockActiveQuoteForMutation(tx, {
    quoteId: params.quoteId,
    tenantId: params.tenantId,
  });
  if (!quote) return { status: "quote_missing" as const };
  await assertNoRetainedJobForQuote(tx, {
    tenantId: params.tenantId,
    quoteId: quote.id,
  });

  const revision = await tx.quoteRevision.findFirst({
    where: {
      id: params.revisionId,
      quoteId: quote.id,
      ...tenantActiveScope(params.tenantId),
    },
    select: {
      id: true,
      createdAt: true,
      snapshot: true,
    },
  });

  if (!revision) return { status: "revision_missing" as const };

  const parsedSnapshot = RevisionSnapshotSchema.safeParse(revision.snapshot);
  if (!parsedSnapshot.success) return { status: "snapshot_invalid" as const };
  const snapshot = parsedSnapshot.data;

  const customer = await tx.customer.findFirst({
    where: {
      id: snapshot.customer.id,
      ...tenantActiveCustomerScope(params.tenantId),
    },
    select: { id: true },
  });

  if (!customer) return { status: "customer_missing" as const };

  const now = new Date();
  const sentAt =
    snapshot.quote.sentAtUtc !== undefined
      ? snapshot.quote.sentAtUtc
        ? new Date(snapshot.quote.sentAtUtc)
        : null
      : snapshot.quote.status === "SENT_TO_CUSTOMER"
        ? quote.sentAt ?? revision.createdAt
        : null;

  await tx.quote.update({
    where: { id: quote.id },
    data: {
      customerId: snapshot.customer.id,
      serviceType: snapshot.quote.serviceType,
      status: snapshot.quote.status,
      jobStatus: snapshot.quote.jobStatus,
      afterSaleFollowUpStatus: snapshot.quote.afterSaleFollowUpStatus,
      title: snapshot.quote.title,
      scopeText: snapshot.quote.scopeText,
      internalCostSubtotal: roundCurrency(snapshot.quote.internalCostSubtotal),
      customerPriceSubtotal: roundCurrency(snapshot.quote.customerPriceSubtotal),
      taxAmount: roundCurrency(snapshot.quote.taxAmount),
      totalAmount: roundCurrency(snapshot.quote.totalAmount),
      documentLocale: normalizeSupportedLocale(snapshot.quote.documentLocale),
      sentAt,
      closedAtUtc: snapshot.quote.closedAtUtc ? new Date(snapshot.quote.closedAtUtc) : null,
      jobCompletedAtUtc: snapshot.quote.jobCompletedAtUtc ? new Date(snapshot.quote.jobCompletedAtUtc) : null,
      afterSaleFollowUpDueAtUtc: snapshot.quote.afterSaleFollowUpDueAtUtc
        ? new Date(snapshot.quote.afterSaleFollowUpDueAtUtc)
        : null,
      afterSaleFollowUpCompletedAtUtc: snapshot.quote.afterSaleFollowUpCompletedAtUtc
        ? new Date(snapshot.quote.afterSaleFollowUpCompletedAtUtc)
        : null,
      archivedAtUtc: null,
      deletedAtUtc: null,
      updatedAt: now,
    },
  });

  await tx.quoteLineItem.updateMany({
    where: {
      quoteId: quote.id,
      ...tenantActiveScope(params.tenantId),
    },
    data: {
      deletedAtUtc: now,
    },
  });

  for (const [position, lineItem] of snapshot.lineItems.entries()) {
    await tx.quoteLineItem.create({
      data: {
        tenantId: params.tenantId,
        quoteId: quote.id,
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel,
        position,
        quantity: roundCurrency(lineItem.quantity),
        unitCost: roundCurrency(lineItem.unitCost),
        unitPrice: roundCurrency(lineItem.unitPrice),
      },
    });
  }

  const restoredQuote = await recalculateQuoteFromLineItems(tx, quote.id, params.tenantId);
  if (!restoredQuote) return { status: "quote_missing" as const };

  const restoredTaxAmount = roundCurrency(snapshot.quote.taxAmount);
  const restoredTotalAmount = calculateQuoteTotal(
    Number(restoredQuote.customerPriceSubtotal),
    restoredTaxAmount,
  );

  const finalizedQuote = await tx.quote.update({
    where: { id: restoredQuote.id },
    data: {
      taxAmount: restoredTaxAmount,
      totalAmount: restoredTotalAmount,
    },
  });

  await createQuoteRevision(tx, {
    tenantId: params.tenantId,
    quoteId: finalizedQuote.id,
    eventType: "UPDATED",
    actor: params.actor,
    documentSnapshot: snapshot.document,
    changedFields: [
      "restoredFromRevision",
      `restoredFromRevisionId:${revision.id}`,
      "customerId",
      "status",
      "jobStatus",
      "afterSaleFollowUpStatus",
      "title",
      "scopeText",
      "lineItems",
      "internalCostSubtotal",
      "customerPriceSubtotal",
      "taxAmount",
      "totalAmount",
    ],
  });

  await markQuoteAiRetrievalSourcesDeleted(tx, {
    tenantId: params.tenantId,
    quoteIds: [finalizedQuote.id],
    now,
  });

  return { status: "ok" as const };
}

function quoteChangedFields(payload: z.infer<typeof UpdateQuoteSchema>): string[] {
  const fields = Object.keys(payload);
  return fields.length ? fields : ["manual_update"];
}

type AcceptedJobSummary = {
  id: string;
  jobNumber: number;
};

function serializeAcceptedJobSummary(job: JobPublic | null | undefined): AcceptedJobSummary | null {
  if (!job) return null;
  return {
    id: job.id,
    jobNumber: job.jobNumber,
  };
}

function decimalInputChanged(current: Prisma.Decimal | number | string, next: number | undefined): boolean {
  return next !== undefined && Number(current) !== next;
}

async function assertAcceptedQuoteJobMutationAllowed(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    quoteId: string;
    existingQuote: {
      customerId: string;
      serviceType: z.infer<typeof ServiceTypeSchema>;
      status: z.infer<typeof QuoteStatusSchema>;
      jobStatus: z.infer<typeof QuoteJobStatusSchema>;
      title: string;
      scopeText: string;
      internalCostSubtotal: Prisma.Decimal | number | string;
      customerPriceSubtotal: Prisma.Decimal | number | string;
      taxAmount: Prisma.Decimal | number | string;
    };
    payload: Partial<z.infer<typeof UpdateQuoteSchema>>;
    lineItemsChanged?: boolean;
  },
) {
  const payload = params.payload;
  const wouldDivergeFromJob =
    params.lineItemsChanged === true ||
    (payload.customerId !== undefined && payload.customerId !== params.existingQuote.customerId) ||
    (payload.serviceType !== undefined && payload.serviceType !== params.existingQuote.serviceType) ||
    (payload.title !== undefined && payload.title !== params.existingQuote.title) ||
    (payload.scopeText !== undefined && payload.scopeText !== params.existingQuote.scopeText) ||
    decimalInputChanged(params.existingQuote.internalCostSubtotal, payload.internalCostSubtotal) ||
    decimalInputChanged(params.existingQuote.customerPriceSubtotal, payload.customerPriceSubtotal) ||
    decimalInputChanged(params.existingQuote.taxAmount, payload.taxAmount) ||
    (payload.status !== undefined && payload.status !== params.existingQuote.status && payload.status !== "ACCEPTED") ||
    (payload.jobStatus !== undefined && payload.jobStatus !== params.existingQuote.jobStatus);

  if (!wouldDivergeFromJob) return;

  await assertNoRetainedJobForQuote(tx, {
    tenantId: params.tenantId,
    quoteId: params.quoteId,
  });
}

function resolveLifecycleUpdate(
  existingQuote: {
    status: z.infer<typeof QuoteStatusSchema>;
    jobStatus: z.infer<typeof QuoteJobStatusSchema>;
    afterSaleFollowUpStatus: z.infer<typeof AfterSaleFollowUpStatusSchema>;
    closedAtUtc: Date | null;
    jobCompletedAtUtc: Date | null;
    afterSaleFollowUpDueAtUtc: Date | null;
    afterSaleFollowUpCompletedAtUtc: Date | null;
  },
  payload: z.infer<typeof UpdateQuoteSchema>,
) {
  const now = new Date();
  const data: Prisma.QuoteUncheckedUpdateInput = {};
  const changedFields: string[] = [];

  if (payload.status === "ACCEPTED" && !existingQuote.closedAtUtc) {
    data.closedAtUtc = now;
    changedFields.push("closedAtUtc");
  }

  if (payload.jobStatus !== undefined) {
    data.jobStatus = payload.jobStatus;
    changedFields.push("jobStatus");

    if (payload.jobStatus === "COMPLETED") {
      if (!existingQuote.jobCompletedAtUtc) {
        data.jobCompletedAtUtc = now;
        changedFields.push("jobCompletedAtUtc");
      }

      if (
        payload.afterSaleFollowUpStatus === undefined &&
        existingQuote.afterSaleFollowUpStatus === "NOT_READY"
      ) {
        data.afterSaleFollowUpStatus = "DUE";
        data.afterSaleFollowUpDueAtUtc = existingQuote.afterSaleFollowUpDueAtUtc ?? addDays(now, 7);
        data.afterSaleFollowUpCompletedAtUtc = null;
        changedFields.push(
          "afterSaleFollowUpStatus",
          "afterSaleFollowUpDueAtUtc",
          "afterSaleFollowUpCompletedAtUtc",
        );
      }
    } else {
      data.jobCompletedAtUtc = null;
      changedFields.push("jobCompletedAtUtc");

      if (payload.afterSaleFollowUpStatus === undefined) {
        data.afterSaleFollowUpStatus = "NOT_READY";
        data.afterSaleFollowUpDueAtUtc = null;
        data.afterSaleFollowUpCompletedAtUtc = null;
        changedFields.push(
          "afterSaleFollowUpStatus",
          "afterSaleFollowUpDueAtUtc",
          "afterSaleFollowUpCompletedAtUtc",
        );
      }
    }
  }

  if (payload.afterSaleFollowUpStatus !== undefined) {
    data.afterSaleFollowUpStatus = payload.afterSaleFollowUpStatus;
    changedFields.push("afterSaleFollowUpStatus");

    if (payload.afterSaleFollowUpStatus === "NOT_READY") {
      data.afterSaleFollowUpDueAtUtc = null;
      data.afterSaleFollowUpCompletedAtUtc = null;
      changedFields.push("afterSaleFollowUpDueAtUtc", "afterSaleFollowUpCompletedAtUtc");
    } else if (payload.afterSaleFollowUpStatus === "DUE") {
      data.afterSaleFollowUpDueAtUtc = existingQuote.afterSaleFollowUpDueAtUtc ?? addDays(now, 7);
      data.afterSaleFollowUpCompletedAtUtc = null;
      changedFields.push("afterSaleFollowUpDueAtUtc", "afterSaleFollowUpCompletedAtUtc");
    } else {
      data.afterSaleFollowUpDueAtUtc = existingQuote.afterSaleFollowUpDueAtUtc ?? now;
      if (!existingQuote.afterSaleFollowUpCompletedAtUtc) {
        data.afterSaleFollowUpCompletedAtUtc = now;
      }
      changedFields.push("afterSaleFollowUpDueAtUtc", "afterSaleFollowUpCompletedAtUtc");
    }
  }

  return {
    data,
    changedFields,
  };
}

function requiredPlanForFeature(
  feature: "quoteVersionHistory" | "communicationLog",
): "professional" | "enterprise" {
  if (feature === "quoteVersionHistory") return "professional";
  return "professional";
}

function defaultLaborRate(serviceType: z.infer<typeof ServiceTypeSchema>): number {
  if (serviceType === "ROOFING") return 2.75;
  if (serviceType === "FLOORING") return 2.1;
  if (serviceType === "PLUMBING") return 2.6;
  if (serviceType === "GARDENING") return 1.75;
  if (serviceType === "CONSTRUCTION") return 3.1;
  return 2.4;
}

function defaultMaterialMarkup(serviceType: z.infer<typeof ServiceTypeSchema>): number {
  if (serviceType === "ROOFING") return 0.35;
  if (serviceType === "FLOORING") return 0.3;
  if (serviceType === "PLUMBING") return 0.38;
  if (serviceType === "GARDENING") return 0.28;
  if (serviceType === "CONSTRUCTION") return 0.34;
  return 0.33;
}

function laborSplit(serviceType: z.infer<typeof ServiceTypeSchema>): number {
  if (serviceType === "ROOFING") return 0.45;
  if (serviceType === "FLOORING") return 0.5;
  if (serviceType === "PLUMBING") return 0.62;
  if (serviceType === "GARDENING") return 0.68;
  if (serviceType === "CONSTRUCTION") return 0.56;
  return 0.58;
}

function normalizeNullableEmail(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeNullablePhone(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeCustomerPhone(value);
  return normalized || undefined;
}

async function findActiveCustomerByPhone(
  prisma: PrismaClient,
  tenantId: string,
  normalizedPhone: string,
) {
  const normalizedPhoneDigits = normalizePhoneSearchDigits(normalizedPhone);
  return prisma.customer.findFirst({
    where: {
      ...tenantActiveCustomerScope(tenantId),
      OR: [
        { phone: normalizedPhone },
        ...(normalizedPhoneDigits ? [{ phoneDigits: normalizedPhoneDigits }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

async function findOrCreatePromptCustomer(
  prisma: PrismaClient,
  tenantId: string,
  params: {
    fullName?: string | null;
    phone: string;
    email?: string | null;
  },
) {
  const phoneDigits = normalizePhoneSearchDigits(params.phone);
  const normalizedEmail = params.email?.trim().toLowerCase() || null;
  const existing = await prisma.customer.findFirst({
    where: {
      tenantId,
      OR: [
        { phone: params.phone },
        ...(phoneDigits ? [{ phoneDigits }] : []),
        ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing?.deletedAtUtc) {
    return null;
  }

  return prisma.$transaction(async (tx) => {
    const customer = existing
      ? await tx.customer.update({
          where: { id: existing.id },
          data: {
            fullName: params.fullName?.trim() || existing.fullName,
            phone: params.phone,
            phoneDigits,
            email: normalizedEmail ?? existing.email,
            archivedAtUtc: null,
          },
        })
      : await tx.customer.create({
          data: {
            tenantId,
            fullName: params.fullName?.trim() || "New Customer",
            phone: params.phone,
            phoneDigits,
            email: normalizedEmail,
          },
        });
    await enqueueAiIndexJob(tx, {
      tenantId,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: customer.updatedAt,
    });
    return customer;
  });
}

async function lockActiveQuoteForRetention(
  tx: Prisma.TransactionClient,
  input: { quoteId: string; tenantId: string; assignedTenantUserId?: string },
) {
  const candidate = await tx.quote.findFirst({
    where: {
      id: input.quoteId,
      ...tenantActiveQuoteScope(input.tenantId),
      ...(input.assignedTenantUserId ? { assignedTenantUserId: input.assignedTenantUserId } : {}),
    },
    select: { customerId: true },
  });
  if (!candidate) return null;

  await tx.$queryRaw(Prisma.sql`
    SELECT customer.id
    FROM "Customer" AS customer
    WHERE customer.id = ${candidate.customerId}
      AND customer."tenantId" = ${input.tenantId}
    FOR UPDATE OF customer
  `);

  const assignmentScope = input.assignedTenantUserId
    ? Prisma.sql`AND quote."assignedTenantUserId" = ${input.assignedTenantUserId}`
    : Prisma.empty;
  const [quote] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT quote.id
    FROM "Quote" AS quote
    WHERE quote.id = ${input.quoteId}
      AND quote."tenantId" = ${input.tenantId}
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
      ${assignmentScope}
    FOR UPDATE OF quote
  `);
  return quote ?? null;
}

function normalizeTextForComparison(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function lineComparisonTokens(value: string) {
  return normalizeTextForComparison(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

function isMeaningfulAiLine(line: AiCurrentLineItem | AiSuggestedLineItem) {
  return Boolean(
    normalizeTextForComparison(line.description).length ||
      line.quantity > 0 ||
      line.unitCost > 0 ||
      line.unitPrice > 0,
  );
}

function aiLineSimilarity(left: string, right: string) {
  const leftText = normalizeTextForComparison(left);
  const rightText = normalizeTextForComparison(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 10;

  let score = 0;
  const leftTokens = new Set(lineComparisonTokens(left));
  const rightTokens = new Set(lineComparisonTokens(right));

  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += 2;
  }

  if (leftText.includes(rightText) || rightText.includes(leftText)) {
    score += 3;
  }

  return score;
}

function lineValuesDiffer(current: AiCurrentLineItem, next: AiSuggestedLineItem) {
  return (
    normalizeTextForComparison(current.description) !== normalizeTextForComparison(next.description) ||
    normalizeQuoteLineSectionType(current.sectionType) !== normalizeQuoteLineSectionType(next.sectionType) ||
    (current.sectionLabel ?? "").trim() !== (next.sectionLabel ?? "").trim() ||
    roundCurrency(current.quantity) !== roundCurrency(next.quantity) ||
    roundCurrency(current.unitCost) !== roundCurrency(next.unitCost) ||
    roundCurrency(current.unitPrice) !== roundCurrency(next.unitPrice)
  );
}

function buildDeterministicAiPatch(
  currentLines: AiCurrentLineItem[],
  suggestedLines: AiSuggestedLineItem[],
): AiQuotePatchResult {
  const workingLines = currentLines.map((line) => ({ ...line }));
  const unmatchedIndexes = new Set<number>(
    workingLines
      .map((line, index) => (isMeaningfulAiLine(line) ? index : -1))
      .filter((index) => index >= 0),
  );
  const lineChanges: AiSuggestedLinePatch[] = [];
  let added = 0;
  let updated = 0;

  for (const suggestion of suggestedLines) {
    let bestIndex = -1;
    let bestScore = 0;

    for (const index of unmatchedIndexes) {
      const score = aiLineSimilarity(workingLines[index].description, suggestion.description);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore >= 4) {
      const current = workingLines[bestIndex];
      unmatchedIndexes.delete(bestIndex);
      if (lineValuesDiffer(current, suggestion)) {
        workingLines[bestIndex] = {
          ...current,
          description: suggestion.description,
          sectionType: suggestion.sectionType,
          sectionLabel: suggestion.sectionLabel,
          quantity: suggestion.quantity,
          unitCost: suggestion.unitCost,
          unitPrice: suggestion.unitPrice,
        };
        updated += 1;
        lineChanges.push({
          action: "UPDATE",
          targetLineId: current.id ?? null,
          previousDescription: current.description,
          description: suggestion.description,
          sectionType: suggestion.sectionType,
          sectionLabel: suggestion.sectionLabel,
          quantity: suggestion.quantity,
          unitCost: suggestion.unitCost,
          unitPrice: suggestion.unitPrice,
          reason: "Aligned to the AI quote draft.",
        });
      }
      continue;
    }

    workingLines.push({
      id: null,
      description: suggestion.description,
      sectionType: suggestion.sectionType,
      sectionLabel: suggestion.sectionLabel,
      quantity: suggestion.quantity,
      unitCost: suggestion.unitCost,
      unitPrice: suggestion.unitPrice,
    });
    added += 1;
    lineChanges.push({
      action: "ADD",
      targetLineId: null,
      previousDescription: null,
      description: suggestion.description,
      sectionType: suggestion.sectionType,
      sectionLabel: suggestion.sectionLabel,
      quantity: suggestion.quantity,
      unitCost: suggestion.unitCost,
      unitPrice: suggestion.unitPrice,
      reason: "Added from the AI quote draft.",
    });
  }

  return {
    lineChanges,
    added,
    updated,
    removed: 0,
    resolvedLines: workingLines
      .filter((line) => isMeaningfulAiLine(line))
      .map((line) => ({
        description: line.description,
        sectionType: normalizeQuoteLineSectionType(line.sectionType),
        sectionLabel: line.sectionLabel ?? null,
        quantity: roundCurrency(line.quantity),
        unitCost: roundCurrency(line.unitCost),
        unitPrice: roundCurrency(line.unitPrice),
      })),
  };
}

function applyAiRevisionPlan(
  currentLines: AiCurrentLineItem[],
  baselineSuggestion: AiSuggestedQuoteDraft,
  plan: Awaited<ReturnType<typeof aiBuildQuoteRevisionPlan>>,
): AiQuotePatchResult {
  const workingLines = currentLines.map((line) => ({ ...line }));
  const removedIndexes = new Set<number>();
  const lineChanges: AiSuggestedLinePatch[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const operation of plan.lineOperations) {
    if (operation.action === "KEEP") continue;

    if (operation.action === "ADD") {
      const nextLine: AiSuggestedLineItem = {
        description: operation.description ?? "Additional line item",
        sectionType: normalizeQuoteLineSectionType(operation.sectionType),
        sectionLabel: operation.sectionLabel ?? null,
        quantity: roundCurrency(operation.quantity ?? 1),
        unitCost: roundCurrency(operation.unitCost ?? 0),
        unitPrice: roundCurrency(operation.unitPrice ?? 0),
      };
      workingLines.push({
        id: null,
        ...nextLine,
      });
      added += 1;
      lineChanges.push({
        action: "ADD",
        targetLineId: null,
        previousDescription: null,
        description: nextLine.description,
        sectionType: nextLine.sectionType,
        sectionLabel: nextLine.sectionLabel,
        quantity: nextLine.quantity,
        unitCost: nextLine.unitCost,
        unitPrice: nextLine.unitPrice,
        reason: operation.reason,
      });
      continue;
    }

    const targetIndex = (operation.targetLineNumber ?? 0) - 1;
    if (targetIndex < 0 || targetIndex >= workingLines.length || removedIndexes.has(targetIndex)) {
      continue;
    }

    const current = workingLines[targetIndex];

    if (operation.action === "REMOVE") {
      removedIndexes.add(targetIndex);
      removed += 1;
      lineChanges.push({
        action: "REMOVE",
        targetLineId: current.id ?? null,
        previousDescription: current.description,
        description: current.description,
        sectionType: normalizeQuoteLineSectionType(current.sectionType),
        sectionLabel: current.sectionLabel ?? null,
        quantity: roundCurrency(current.quantity),
        unitCost: roundCurrency(current.unitCost),
        unitPrice: roundCurrency(current.unitPrice),
        reason: operation.reason,
      });
      continue;
    }

    const nextLine: AiSuggestedLineItem = {
      description: operation.description ?? current.description,
      sectionType: operation.sectionType ? normalizeQuoteLineSectionType(operation.sectionType) : normalizeQuoteLineSectionType(current.sectionType),
      sectionLabel:
        operation.sectionLabel !== null && operation.sectionLabel !== undefined
          ? operation.sectionLabel
          : current.sectionLabel ?? null,
      quantity: roundCurrency(operation.quantity ?? current.quantity),
      unitCost: roundCurrency(operation.unitCost ?? current.unitCost),
      unitPrice: roundCurrency(operation.unitPrice ?? current.unitPrice),
    };

    if (!lineValuesDiffer(current, nextLine)) {
      continue;
    }

    workingLines[targetIndex] = {
      ...current,
      ...nextLine,
    };
    updated += 1;
    lineChanges.push({
      action: "UPDATE",
      targetLineId: current.id ?? null,
      previousDescription: current.description,
      description: nextLine.description,
      sectionType: nextLine.sectionType,
      sectionLabel: nextLine.sectionLabel,
      quantity: nextLine.quantity,
      unitCost: nextLine.unitCost,
      unitPrice: nextLine.unitPrice,
      reason: operation.reason,
    });
  }

  if (!lineChanges.length) {
    return {
      lineChanges: [],
      added: 0,
      updated: 0,
      removed: 0,
      resolvedLines: workingLines
        .filter((line) => isMeaningfulAiLine(line))
        .map((line) => ({
          description: line.description,
          sectionType: normalizeQuoteLineSectionType(line.sectionType),
          sectionLabel: line.sectionLabel ?? null,
          quantity: roundCurrency(line.quantity),
          unitCost: roundCurrency(line.unitCost),
          unitPrice: roundCurrency(line.unitPrice),
        })),
    };
  }

  return {
    lineChanges,
    added,
    updated,
    removed,
    resolvedLines: workingLines
      .filter((_line, index) => !removedIndexes.has(index))
      .filter((line) => isMeaningfulAiLine(line))
      .map((line) => ({
        description: line.description,
        sectionType: normalizeQuoteLineSectionType(line.sectionType),
        sectionLabel: line.sectionLabel ?? null,
        quantity: roundCurrency(line.quantity),
        unitCost: roundCurrency(line.unitCost),
        unitPrice: roundCurrency(line.unitPrice),
      })),
  };
}

function hasMeaningfulCurrentQuoteContext(params: {
  title?: string | null;
  scopeText?: string | null;
  lineItems?: AiCurrentLineItem[] | null;
}) {
  return Boolean(
    normalizeTextForComparison(params.title ?? "").length ||
      normalizeTextForComparison(params.scopeText ?? "").length ||
      params.lineItems?.some((line) => isMeaningfulAiLine(line)),
  );
}

function formatAiSourceStatus(status: z.infer<typeof QuoteStatusSchema>) {
  if (status === "ACCEPTED") return "Accepted";
  if (status === "SENT_TO_CUSTOMER") return "Sent";
  if (status === "READY_FOR_REVIEW") return "Ready";
  if (status === "REJECTED") return "Rejected";
  return "Draft";
}

function hasCloseAmountMatch(similarQuotes: SimilarQuoteContext[], targetAmount?: number | null) {
  if (!targetAmount || targetAmount <= 0) return false;
  return similarQuotes.some((quote) => {
    if (quote.totalAmount <= 0) return false;
    const deltaRatio = Math.abs(quote.totalAmount - targetAmount) / targetAmount;
    return deltaRatio <= 0.2;
  });
}

function assessAiSuggestionConfidence(params: {
  currentQuoteUsed: boolean;
  customer?: {
    notes?: string | null;
  } | null;
  customerActivityCount: number;
  presetCount: number;
  standardPresetCount?: number;
  similarQuotes: SimilarQuoteContext[];
  targetAmount?: number | null;
}) {
  let score = 0;

  if (params.currentQuoteUsed) score += 3;
  if (params.customer) score += 1;
  if (params.customer?.notes?.trim()) score += 1;
  if (params.customerActivityCount > 0) score += 1;
  if (params.presetCount > 0) score += 2;
  if ((params.standardPresetCount ?? 0) > 0) score += 2;
  if (params.similarQuotes.length > 0) score += 2;
  if (params.similarQuotes.some((quote) => quote.status === "ACCEPTED")) score += 2;
  else if (params.similarQuotes.some((quote) => quote.status === "SENT_TO_CUSTOMER")) score += 1;
  if (hasCloseAmountMatch(params.similarQuotes, params.targetAmount)) score += 1;

  if (score >= 8) {
    return {
      level: "high" as const,
      label: "High confidence context",
      riskNote:
        "AI had strong tenant context from saved jobs, customer history, or similar successful quotes.",
    };
  }

  if (score >= 4) {
    return {
      level: "medium" as const,
      label: "Moderate confidence context",
      riskNote:
        "AI had partial tenant context, but some line items or pricing may still rely on inference. Review before sending.",
    };
  }

  return {
    level: "low" as const,
    label: "Low confidence context",
    riskNote:
      "AI had limited saved context and relied more heavily on the prompt alone. Review scope, quantities, and pricing carefully.",
  };
}

function buildAiSuggestionInsight(params: {
  summary?: string | null;
  reasons?: string[];
  currentQuoteUsed: boolean;
  customer?: {
    fullName: string;
    notes?: string | null;
  } | null;
  customerActivityCount: number;
  presetCount: number;
  standardPresetCount?: number;
  similarQuotes: SimilarQuoteContext[];
  retrievalCitations?: AiRetrievalResult["citations"];
  targetAmount?: number | null;
  patch: AiQuotePatchResult;
}): AiSuggestionInsight {
  const confidence = assessAiSuggestionConfidence({
    currentQuoteUsed: params.currentQuoteUsed,
    customer: params.customer,
    customerActivityCount: params.customerActivityCount,
    presetCount: params.presetCount,
    standardPresetCount: params.standardPresetCount,
    similarQuotes: params.similarQuotes,
    targetAmount: params.targetAmount,
  });

  const summary =
    params.summary?.trim() ||
    [
      params.patch.updated ? `updated ${params.patch.updated} line${params.patch.updated === 1 ? "" : "s"}` : null,
      params.patch.added ? `added ${params.patch.added}` : null,
      params.patch.removed ? `removed ${params.patch.removed}` : null,
    ]
      .filter(Boolean)
      .join(", ") ||
    "AI reviewed the quote context and prepared an update.";

  const sources: AiSuggestionInsight["sources"] = [];

  if (params.currentQuoteUsed) {
    sources.push({
      type: "current_quote",
      label: "Used the current quote sheet as the editing baseline",
    });
  }

  if (params.customer) {
    sources.push({
      type: "customer",
      label: `Customer: ${params.customer.fullName}`,
    });
  }

  if (params.customer?.notes?.trim()) {
    sources.push({
      type: "customer_notes",
      label: "Used saved customer notes as internal context",
    });
  }

  if (params.customerActivityCount > 0) {
    sources.push({
      type: "customer_activity",
      label: `${params.customerActivityCount} recent customer activity event${params.customerActivityCount === 1 ? "" : "s"}`,
    });
  }

  if (params.presetCount > 0) {
    sources.push({
      type: "saved_jobs",
      label: `${params.presetCount} saved job${params.presetCount === 1 ? "" : "s"} and pricing hints`,
    });
  }

  if ((params.standardPresetCount ?? 0) > 0) {
    sources.push({
      type: "trade_catalog",
      label: `${params.standardPresetCount} standard trade catalog match${params.standardPresetCount === 1 ? "" : "es"}`,
    });
  }

  for (const quote of params.similarQuotes.slice(0, 2)) {
    sources.push({
      type: "similar_quote",
      label: `${formatAiSourceStatus(quote.status)} quote: ${quote.title}`,
    });
  }

  if (params.retrievalCitations?.length) {
    for (const citation of params.retrievalCitations.slice(0, 2)) {
      sources.push({
        type: "retrieved_context",
        label: `Retrieved source ${citation.key}: ${citation.label}`,
      });
    }
  }

  return {
    summary,
    reasons: (params.reasons ?? []).filter(Boolean).slice(0, 3),
    sources: sources.slice(0, 5),
    confidence: {
      level: confidence.level,
      label: confidence.label,
    },
    riskNote: confidence.riskNote,
    patch: {
      added: params.patch.added,
      updated: params.patch.updated,
      removed: params.patch.removed,
    },
  };
}

function buildAiUsageTraceFromInsight(
  insight: AiSuggestionInsight,
  options?: {
    serviceType?: z.infer<typeof ServiceTypeSchema> | null;
    retryApplied?: boolean;
  },
) {
  const insightReasons = [...insight.reasons];
  if (options?.retryApplied) {
    insightReasons.unshift("Guardrail retry applied after initial no-op draft.");
  }
  if (insightReasons.length > 3) {
    insightReasons.length = 3;
  }

  const sourceLabels = insight.sources.map((source) => source.label);
  if (options?.serviceType) {
    sourceLabels.unshift(`Trade: ${options.serviceType}`);
  }

  return {
    insightSummary: insight.summary,
    insightReasons,
    insightSourceLabels: sourceLabels,
    sourceTypes: insight.sources.map((source) => source.type),
    confidenceLevel: insight.confidence.level,
    confidenceLabel: insight.confidence.label,
    riskNote: insight.riskNote,
    patch: {
      added: insight.patch.added,
      updated: insight.patch.updated,
      removed: insight.patch.removed,
    },
  };
}

function buildAiRevisionContextPrompt(
  contextPrompt: string,
  currentQuoteContext: AiCurrentQuoteContextForDiff,
  baselineSuggestion: AiSuggestedQuoteDraft,
  options?: {
    includeFinancialContext?: boolean;
  },
) {
  const includeFinancialContext = options?.includeFinancialContext ?? false;
  return [
    contextPrompt,
    "Current quote lines:",
    ...(currentQuoteContext?.lineItems.map(
      (lineItem, index) =>
        `${index + 1}. ${lineItem.description} | qty ${lineItem.quantity}${includeFinancialContext ? ` | cost ${lineItem.unitCost.toFixed(
          2,
        )}` : ""} | price ${lineItem.unitPrice.toFixed(2)}`,
    ) ?? []),
    "",
    "Baseline AI draft:",
    `- Trade: ${baselineSuggestion.serviceType}`,
    `- Title: ${baselineSuggestion.title}`,
    `- Scope: ${baselineSuggestion.scopeText}`,
    ...baselineSuggestion.lineItems.map(
      (lineItem, index) =>
        `  ${index + 1}. ${lineItem.description} | qty ${lineItem.quantity}${includeFinancialContext ? ` | cost ${lineItem.unitCost.toFixed(
          2,
        )}` : ""} | price ${lineItem.unitPrice.toFixed(2)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

const AI_PROGRESS_STEPS: Record<
  AiProgressStep,
  { value: number; label: string }
> = {
  analyzing_prompt: { value: 16, label: "Reading prompt" },
  loading_customer_context: { value: 34, label: "Loading customer context" },
  retrieving_workspace_context: { value: 56, label: "Matching saved jobs + similar quotes" },
  drafting_quote_patch: { value: 78, label: "Preparing line changes" },
  reviewing_line_changes: { value: 88, label: "Reviewing patch impact" },
  finalizing_suggestion: { value: 94, label: "Applying the quote patch" },
};

function buildAiContextSourceHints(params: {
  customer?: {
    notes?: string | null;
  } | null;
  customerActivityCount: number;
  presetCount: number;
  standardPresetCount?: number;
  similarQuotes: SimilarQuoteContext[];
}) {
  const hints: string[] = [];
  if (params.customer?.notes?.trim()) {
    hints.push("customer notes");
  }
  if (params.customerActivityCount > 0) {
    hints.push(`${params.customerActivityCount} recent activity`);
  }
  if (params.presetCount > 0) {
    hints.push(`${params.presetCount} saved jobs`);
  }
  if ((params.standardPresetCount ?? 0) > 0) {
    hints.push(`${params.standardPresetCount} catalog matches`);
  }
  if (params.similarQuotes.length > 0) {
    hints.push(`${params.similarQuotes.length} similar quotes`);
  }
  return hints.slice(0, 4);
}

function buildStandardCatalogMatchesForAiContext(params: {
  serviceType: z.infer<typeof ServiceTypeSchema>;
  prompt: string;
  title?: string | null;
  scopeText?: string | null;
  lineItemDescriptions?: string[];
  tenantPresets?: Array<{
    catalogKey: string | null;
    name: string;
    description: string | null;
    unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
    unitCost: Prisma.Decimal | number;
    unitPrice: Prisma.Decimal | number;
  }>;
  minimumScore?: number;
  limit?: number;
}) {
  const normalizedContextText = [
    params.prompt,
    params.title ?? "",
    params.scopeText ?? "",
    ...(params.lineItemDescriptions ?? []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(" ");

  if (!normalizedContextText) {
    return [];
  }

  const tenantCatalogPresetMap = new Map<
    string,
    {
      name: string;
      description: string | null;
      unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
      unitCost: Prisma.Decimal | number;
      unitPrice: Prisma.Decimal | number;
    }
  >();
  for (const preset of params.tenantPresets ?? []) {
    if (preset.catalogKey) {
      tenantCatalogPresetMap.set(preset.catalogKey, preset);
    }
  }

  return findStandardWorkPresetMatches(params.serviceType, normalizedContextText, {
    minimumScore: params.minimumScore ?? 3,
  })
    .slice(0, params.limit ?? 6)
    .map((match) => {
      const tenantPreset = tenantCatalogPresetMap.get(match.preset.catalogKey);
      return {
        name: tenantPreset?.name ?? match.preset.name,
        description: tenantPreset?.description ?? match.preset.description,
        unitType: tenantPreset?.unitType ?? match.preset.unitType,
        unitCost: Number(tenantPreset?.unitCost ?? match.preset.unitCost),
        unitPrice: Number(tenantPreset?.unitPrice ?? match.preset.unitPrice),
        score: match.score,
      };
    });
}

function startAiSuggestionStream(reply: FastifyReply) {
  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-store");
  reply.raw.setHeader("X-Accel-Buffering", "no");

  const write = (event: AiSuggestionStreamEvent) => {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  return {
    write,
    progress(
      step: AiProgressStep,
      detail: string,
      options?: {
        sourceHints?: string[];
        patchCounts?: {
          added: number;
          updated: number;
          removed: number;
        };
      },
    ) {
      const config = AI_PROGRESS_STEPS[step];
      write({
        type: "progress",
        step,
        value: config.value,
        label: config.label,
        detail,
        ...(options?.sourceHints?.length ? { sourceHints: options.sourceHints } : {}),
        ...(options?.patchCounts ? { patchCounts: options.patchCounts } : {}),
      });
    },
    end() {
      reply.raw.end();
    },
  };
}

function resolveChatQuoteScopeText(
  parsedScopeText: string,
  rawPrompt: string,
  fallbackDescription?: string | null,
): string {
  const normalizedScope = normalizeTextForComparison(parsedScopeText);
  const normalizedPrompt = normalizeTextForComparison(rawPrompt);
  if (!normalizedScope || normalizedScope === normalizedPrompt) {
    return fallbackDescription?.trim() || parsedScopeText;
  }
  return parsedScopeText;
}

type AiSuggestedLineItem = {
  description: string;
  sectionType: z.infer<typeof QuoteLineSectionTypeSchema>;
  sectionLabel: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
};

type AiSuggestedQuoteDraft = {
  serviceType: z.infer<typeof ServiceTypeSchema>;
  title: string;
  scopeText: string;
  internalCostSubtotal: number;
  customerPriceSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  lineItems: AiSuggestedLineItem[];
  model: string;
};

type AiCurrentLineItem = {
  id?: string | null;
  description: string;
  sectionType: z.infer<typeof QuoteLineSectionTypeSchema>;
  sectionLabel: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
};

type AiSuggestedLinePatch = {
  action: "ADD" | "UPDATE" | "REMOVE";
  targetLineId: string | null;
  previousDescription: string | null;
  description: string;
  sectionType: z.infer<typeof QuoteLineSectionTypeSchema>;
  sectionLabel: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  reason: string;
};

type AiQuotePatchResult = {
  lineChanges: AiSuggestedLinePatch[];
  added: number;
  updated: number;
  removed: number;
  resolvedLines: AiSuggestedLineItem[];
};

type AiSuggestionInsight = {
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
  riskNote: string | null;
  patch: {
    added: number;
    updated: number;
    removed: number;
  };
};

const AI_GUARDRAIL_RETRY_HINT = [
  "AI guardrail retry requirements:",
  "- Produce concrete quote edits that can be applied immediately.",
  "- Return at least one meaningful line item with non-empty description and positive quantity.",
  "- If the user request includes multiple areas, phases, or options, keep them as separate lines.",
  "- Do not return a no-op response.",
].join("\n");

type AiCurrentQuoteContextForDiff = {
  serviceType: z.infer<typeof ServiceTypeSchema>;
  title?: string;
  scopeText?: string;
  lineItems: AiCurrentLineItem[];
} | null;

function hasAiPatchMutations(patch: AiQuotePatchResult) {
  return patch.added + patch.updated + patch.removed > 0;
}

function hasAiSuggestionMetadataMutation(params: {
  hasCurrentSheetContext: boolean;
  currentQuoteContext: AiCurrentQuoteContextForDiff;
  suggestion: Pick<AiSuggestedQuoteDraft, "serviceType" | "title" | "scopeText">;
}) {
  if (!params.hasCurrentSheetContext || !params.currentQuoteContext) {
    return false;
  }

  const currentTitle = normalizeTextForComparison(params.currentQuoteContext.title ?? "");
  const nextTitle = normalizeTextForComparison(params.suggestion.title ?? "");
  const currentScope = normalizeTextForComparison(params.currentQuoteContext.scopeText ?? "");
  const nextScope = normalizeTextForComparison(params.suggestion.scopeText ?? "");

  return (
    params.currentQuoteContext.serviceType !== params.suggestion.serviceType ||
    currentTitle !== nextTitle ||
    currentScope !== nextScope
  );
}

function resolveAiSuggestionFromPatch(params: {
  baselineSuggestion: AiSuggestedQuoteDraft;
  revisionPlan: Awaited<ReturnType<typeof aiBuildQuoteRevisionPlan>> | null;
  hasCurrentSheetContext: boolean;
  currentQuoteContext: AiCurrentQuoteContextForDiff;
  patch: AiQuotePatchResult;
}): {
  serviceType: z.infer<typeof ServiceTypeSchema>;
  title: string;
  scopeText: string;
  suggestion: AiSuggestedQuoteDraft;
} {
  const serviceType = params.revisionPlan?.serviceType ?? params.baselineSuggestion.serviceType;
  const title =
    params.revisionPlan?.title?.trim() ||
    (params.hasCurrentSheetContext && params.currentQuoteContext?.title?.trim()
      ? params.currentQuoteContext.title.trim()
      : params.baselineSuggestion.title);
  const scopeText =
    params.revisionPlan?.scopeText?.trim() ||
    (params.hasCurrentSheetContext && params.currentQuoteContext?.scopeText?.trim()
      ? params.currentQuoteContext.scopeText.trim()
      : params.baselineSuggestion.scopeText);

  const internalCostSubtotal = roundCurrency(
    params.patch.resolvedLines.reduce(
      (sum, lineItem) =>
        isIncludedQuoteLineSection(lineItem.sectionType)
          ? sum + lineItem.quantity * lineItem.unitCost
          : sum,
      0,
    ),
  );
  const customerPriceSubtotal = roundCurrency(
    params.patch.resolvedLines.reduce(
      (sum, lineItem) =>
        isIncludedQuoteLineSection(lineItem.sectionType)
          ? sum + lineItem.quantity * lineItem.unitPrice
          : sum,
      0,
    ),
  );

  return {
    serviceType,
    title,
    scopeText,
    suggestion: {
      ...params.baselineSuggestion,
      serviceType,
      title,
      scopeText,
      internalCostSubtotal,
      customerPriceSubtotal,
      totalAmount: calculateQuoteTotal(customerPriceSubtotal, params.baselineSuggestion.taxAmount),
      lineItems: params.patch.resolvedLines.length
        ? params.patch.resolvedLines
        : params.baselineSuggestion.lineItems,
    },
  };
}

type AiProgressStep =
  | "analyzing_prompt"
  | "loading_customer_context"
  | "retrieving_workspace_context"
  | "drafting_quote_patch"
  | "reviewing_line_changes"
  | "finalizing_suggestion";

type AiProgressEvent = {
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
  | {
      type: "complete";
      result: {
        customer: {
          id: string;
          fullName: string;
          phone: string;
          email: string | null;
          notes?: string | null;
        } | null;
        parsed: {
          customerName: string | undefined;
          customerPhone: string | undefined;
          customerEmail: string | undefined;
          serviceType: z.infer<typeof ServiceTypeSchema>;
          squareFeetEstimate: number | null;
          squareFeetVariancePercent: number | null;
          squareFeetEstimateLow: number | null;
          squareFeetEstimateHigh: number | null;
          estimatedTotalAmount: number | null;
        };
        suggestion: AiSuggestedQuoteDraft;
        patch: AiQuotePatchResult;
        insight: AiSuggestionInsight;
        aiRunId: string;
        usage: ReturnType<typeof buildAiUsageResponse>;
      };
    }
  | { type: "error"; error: string };

type SimilarQuoteContext = {
  id: string;
  title: string;
  scopeText: string;
  totalAmount: number;
  status: z.infer<typeof QuoteStatusSchema>;
  updatedAt: Date;
  lineItems: Array<{
    description: string;
    sectionType: z.infer<typeof QuoteLineSectionTypeSchema>;
    sectionLabel: string | null;
    quantity: number;
    unitPrice: number;
  }>;
};

function buildAiQuoteContext(params: {
  customer?: {
    fullName: string;
    phone: string;
    email?: string | null;
    notes?: string | null;
  } | null;
  customerActivity?: Array<{
    title: string;
    detail?: string | null;
    occurredAt: Date;
  }>;
  currentQuote?: {
    serviceType: z.infer<typeof ServiceTypeSchema>;
    title?: string;
    scopeText?: string;
    lineItems?: AiSuggestedLineItem[];
  } | null;
  presets?: Array<{
    name: string;
    description?: string | null;
    unitType: string;
    unitCost: number;
    unitPrice: number;
  }>;
  standardCatalogMatches?: Array<{
    name: string;
    description?: string | null;
    unitType: string;
    unitCost: number;
    unitPrice: number;
    score?: number;
  }>;
  pricingProfile?: {
    laborRate: number;
    materialMarkup: number;
  } | null;
  similarQuotes?: SimilarQuoteContext[];
  retrievalContext?: string;
  includeFinancialContext?: boolean;
}) {
  const sections: string[] = [];
  const includeFinancialContext = params.includeFinancialContext ?? false;

  if (params.customer) {
    sections.push(
      [
        "Customer context:",
        `- Name: ${params.customer.fullName}`,
        `- Phone: ${params.customer.phone}`,
        params.customer.email ? `- Email: ${params.customer.email}` : null,
        params.customer.notes?.trim() ? `- Notes: ${params.customer.notes.trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (params.customerActivity?.length) {
    sections.push(
      [
        "Recent customer activity:",
        ...params.customerActivity.map(
          (event, index) =>
            `- ${index + 1}. ${event.occurredAt.toISOString().slice(0, 10)} | ${event.title}${event.detail ? ` | ${event.detail.slice(0, 180)}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  if (params.currentQuote) {
    sections.push(
      [
        "Current quote draft:",
        `- Trade: ${params.currentQuote.serviceType}`,
        params.currentQuote.title ? `- Title: ${params.currentQuote.title}` : null,
        params.currentQuote.scopeText ? `- Scope: ${params.currentQuote.scopeText}` : null,
        params.currentQuote.lineItems?.length
          ? `- Current lines:\n${params.currentQuote.lineItems
              .map(
                (line, index) =>
                  `  ${index + 1}. ${line.sectionType === "ALTERNATE" ? `${line.sectionLabel?.trim() || "Alternate option"} | ` : ""}${line.description} | qty ${line.quantity}${includeFinancialContext ? ` | cost ${line.unitCost}` : ""} | price ${line.unitPrice}`,
              )
              .join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (params.pricingProfile && includeFinancialContext) {
    sections.push(
      [
        "Pricing hints:",
        `- Labor rate: ${params.pricingProfile.laborRate.toFixed(2)}`,
        `- Material markup: ${(params.pricingProfile.materialMarkup * 100).toFixed(1)}%`,
      ].join("\n"),
    );
  }

  if (params.presets?.length) {
    sections.push(
      [
        "Saved jobs and pricing:",
        ...params.presets.map(
          (preset) =>
            `- ${preset.name} | ${preset.description ?? "No description"} | ${preset.unitType}${includeFinancialContext ? ` | cost ${preset.unitCost.toFixed(
              2,
            )}` : ""} | price ${preset.unitPrice.toFixed(2)}`,
        ),
      ].join("\n"),
    );
  }

  if (params.standardCatalogMatches?.length) {
    sections.push(
      [
        "Standard trade catalog matches:",
        ...params.standardCatalogMatches.map(
          (preset) =>
            `- ${preset.name} | ${preset.description ?? "No description"} | ${preset.unitType}${includeFinancialContext ? ` | cost ${preset.unitCost.toFixed(
              2,
            )}` : ""} | price ${preset.unitPrice.toFixed(2)}${typeof preset.score === "number" ? ` | match ${preset.score}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  if (params.similarQuotes?.length) {
    sections.push(
      [
        "Similar tenant quotes:",
        ...params.similarQuotes.map((quote, index) => {
          const scopePreview = quote.scopeText.trim().slice(0, 180);
          const linesPreview = quote.lineItems
            .slice(0, 3)
            .map(
              (lineItem, lineIndex) =>
                `    ${lineIndex + 1}. ${lineItem.sectionType === "ALTERNATE" ? `${lineItem.sectionLabel?.trim() || "Alternate option"} | ` : ""}${lineItem.description} | qty ${lineItem.quantity} | price ${lineItem.unitPrice.toFixed(2)}`,
            )
            .join("\n");
          return [
            `- Example ${index + 1}: [${quote.status}] ${quote.title} | total ${quote.totalAmount.toFixed(2)} | updated ${quote.updatedAt.toISOString().slice(0, 10)}`,
            scopePreview ? `  Scope: ${scopePreview}` : null,
            linesPreview ? `  Lines:\n${linesPreview}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        }),
      ].join("\n"),
    );
  }

  if (params.retrievalContext?.trim()) {
    sections.push(params.retrievalContext.trim());
  }

  return sections.join("\n\n");
}

function appendAiPromptStructureHints(context: string, prompt: string) {
  const sections = [context];

  if (promptRequestsSeparateLineOptions(prompt)) {
    sections.push(
      [
        "Prompt structure requirements:",
        "- The user explicitly asked for separate lines or alternative options.",
        "- Preserve that request in the line item structure.",
        "- Do not collapse repair and replacement into one generic line.",
      ].join("\n"),
    );
  }

  if (promptIncludesRoofingDetailCues(prompt)) {
    sections.push(
      [
        "Roofing interpretation hints:",
        "- Material/system wording matters (asphalt, architectural shingles, Spanish/clay/concrete tile, metal, TPO, EPDM, modified bitumen/torch-down).",
        "- If roofing squares are present, treat 1 square as 100 sq ft.",
      ].join("\n"),
    );
  }

  if (promptIncludesFlooringDetailCues(prompt)) {
    sections.push(
      [
        "Flooring interpretation hints:",
        "- Preserve material/system wording (LVP/LVT, linoleum or sheet vinyl, laminate, hardwood, tile, carpet).",
        "- Keep prep/finish terms explicit when present (underlayment, moisture barrier, subfloor leveling, trim/transition).",
      ].join("\n"),
    );
  }

  if (promptIncludesHvacDetailCues(prompt)) {
    sections.push(
      [
        "HVAC interpretation hints:",
        "- Preserve equipment/system wording (condenser, evaporator coil, furnace, heat pump, mini-split, refrigerant repair/recharge, duct sealing).",
        "- Keep diagnostics/controls terms explicit when present (thermostat, airflow, static pressure).",
      ].join("\n"),
    );
  }

  if (promptIncludesPlumbingDetailCues(prompt)) {
    sections.push(
      [
        "Plumbing interpretation hints:",
        "- Preserve system wording (repipe PEX/copper, water heater/tankless, sewer camera, hydro-jetting, trenchless sewer repair, slab leak, fixture reset/replacement, PRV/backflow, sump pump).",
        "- Keep phase/option lines separate when repair vs replacement or optional allowances are requested.",
      ].join("\n"),
    );
  }

  if (promptIncludesGardeningDetailCues(prompt)) {
    sections.push(
      [
        "Gardening interpretation hints:",
        "- Preserve job mode and terminology (maintenance vs install; sod, aeration/overseed, fertilization/pre-emergent, irrigation/drip/sprinkler, mulch, pruning, cleanup, drainage).",
      ].join("\n"),
    );
  }

  return sections.filter(Boolean).join("\n\n");
}

const AI_CONTEXT_STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "then",
  "your",
  "will",
  "have",
  "about",
  "include",
  "includes",
  "need",
  "new",
  "quote",
  "customer",
  "install",
  "replace",
  "replacement",
  "service",
]);

function aiContextTokens(...values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .flatMap((value) =>
          normalizeTextForComparison(value ?? "")
            .split(" ")
            .filter((token) => token.length >= 3 && !AI_CONTEXT_STOP_WORDS.has(token)),
        )
        .filter(Boolean),
    ),
  );
}

function promptRequestsSeparateLineOptions(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\btwo line\b/,
    /\btwo lines\b/,
    /\bseparate line\b/,
    /\banother line\b/,
    /\boption 1\b/,
    /\boption 2\b/,
    /\boption a\b/,
    /\boption b\b/,
    /\brepair or replace\b/,
    /\brepair and replace\b/,
    /\bif repairs? are not possible\b/,
    /\bif repair is not possible\b/,
    /\bif not possible\b/,
    /\bif replacement is better\b/,
    /\bfallback\b/,
    /\balternative\b/,
    /\bcontingenc(?:y|ies)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function promptIncludesRoofingDetailCues(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\broof\b/,
    /\broofing\b/,
    /\bshingle\b/,
    /\basphalt\b/,
    /\barchitectural\b/,
    /\bspanish tile\b/,
    /\bclay tile\b/,
    /\bconcrete tile\b/,
    /\bmetal roof\b/,
    /\bstanding seam\b/,
    /\btpo\b/,
    /\bepdm\b/,
    /\bmodified bitumen\b/,
    /\btorch down\b/,
    /\bsquares?\b/,
  ].some((pattern) => pattern.test(normalized));
}

function promptIncludesFlooringDetailCues(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\bfloor\b/,
    /\bflooring\b/,
    /\blvp\b/,
    /\blvt\b/,
    /\blinoleum\b/,
    /\bsheet vinyl\b/,
    /\blaminate\b/,
    /\bhardwood\b/,
    /\bcarpet\b/,
    /\btile\b/,
    /\buncoupling membrane\b/,
    /\bditra\b/,
    /\bthinset\b/,
    /\bgrout\b/,
    /\bunderlayment\b/,
    /\bmoisture barrier\b/,
    /\bsubfloor\b/,
    /\bnail down\b/,
    /\bglue down\b/,
    /\bfloating floor\b/,
    /\btransition\b/,
    /\bbaseboard\b/,
  ].some((pattern) => pattern.test(normalized));
}

function promptIncludesHvacDetailCues(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\bhvac\b/,
    /\bcondenser\b/,
    /\bevaporator coil\b/,
    /\ba[-\s]?coil\b/,
    /\bfurnace\b/,
    /\bheat pump\b/,
    /\bmini[-\s]?split\b/,
    /\bductless\b/,
    /\bair handler\b/,
    /\brefrigerant\b/,
    /\bseer2\b/,
    /\bhspf2\b/,
    /\bcompressor\b/,
    /\bcapacitor\b/,
    /\bcontactor\b/,
    /\bthermostat\b/,
    /\bstatic pressure\b/,
    /\bairflow\b/,
  ].some((pattern) => pattern.test(normalized));
}

function promptIncludesPlumbingDetailCues(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\bplumbing\b/,
    /\brepipe\b/,
    /\bpex\b/,
    /\bcopper\b/,
    /\bwater heater\b/,
    /\btankless\b/,
    /\bsewer\b/,
    /\bdrain\b/,
    /\bhydro[-\s]?jet\b/,
    /\bcamera\b/,
    /\btrenchless\b/,
    /\bpipe bursting\b/,
    /\bcipp\b/,
    /\bslab leak\b/,
    /\btoilet\b/,
    /\bfaucet\b/,
    /\bgarbage disposal\b/,
    /\bprv\b/,
    /\bpressure regulator\b/,
    /\bbackflow\b/,
    /\bsump pump\b/,
  ].some((pattern) => pattern.test(normalized));
}

function promptIncludesGardeningDetailCues(prompt: string) {
  const normalized = normalizeTextForComparison(prompt);
  if (!normalized) return false;

  return [
    /\bgarden\b/,
    /\bgardening\b/,
    /\blawn\b/,
    /\byard\b/,
    /\bsod\b/,
    /\baeration\b/,
    /\boverseed\b/,
    /\bfertili[sz]ation\b/,
    /\bpre[-\s]?emergent\b/,
    /\bpreemergence\b/,
    /\birrigation\b/,
    /\bsprinkler\b/,
    /\bdrip\b/,
    /\bcontroller\b/,
    /\bhydrozone\b/,
    /\bmulch\b/,
    /\bhedge\b/,
    /\bprun\w*\b/,
    /\bcleanup\b/,
    /\bdrainage\b/,
  ].some((pattern) => pattern.test(normalized));
}

function isGenericAiDraftLineDescription(description: string, serviceType: z.infer<typeof ServiceTypeSchema>) {
  const normalized = normalizeTextForComparison(description);
  if (!normalized) return true;

  const genericCandidates = new Set([
    normalizeTextForComparison(`${serviceType} labor`),
    normalizeTextForComparison(`${serviceType} labor and installation`),
    normalizeTextForComparison(`${serviceType} service`),
    normalizeTextForComparison("labor and installation"),
    normalizeTextForComparison("materials and supplies"),
    normalizeTextForComparison("materials and install supplies"),
    normalizeTextForComparison("hvac equipment fittings and install materials"),
    normalizeTextForComparison("plumbing fixtures piping and install materials"),
    normalizeTextForComparison("roofing materials underlayment and accessories"),
    normalizeTextForComparison("construction materials consumables and site supplies"),
    normalizeTextForComparison("flooring materials trim and install supplies"),
  ]);

  return genericCandidates.has(normalized);
}

function shouldPreserveExplicitAiLineStructure(params: {
  prompt: string;
  parsedDraft: ParsedChatToQuoteDraft;
  serviceType: z.infer<typeof ServiceTypeSchema>;
}) {
  if (promptRequestsSeparateLineOptions(params.prompt)) return true;
  if (params.parsedDraft.lineItems.length >= 3) return true;

  const specificLineCount = params.parsedDraft.lineItems.filter(
    (lineItem) => !isGenericAiDraftLineDescription(lineItem.description, params.serviceType),
  ).length;

  return specificLineCount >= 2;
}

function scoreSimilarQuote(
  queryTokens: string[],
  quote: {
    title: string;
    scopeText: string;
    totalAmount: number;
    lineItems: Array<{ description: string }>;
    status: z.infer<typeof QuoteStatusSchema>;
    updatedAt: Date;
  },
  targetAmount?: number | null,
) {
  const titleText = normalizeTextForComparison(quote.title);
  const scopeText = normalizeTextForComparison(quote.scopeText);
  const linesText = normalizeTextForComparison(quote.lineItems.map((line) => line.description).join(" "));

  let score = 0;
  for (const token of queryTokens) {
    if (titleText.includes(token)) score += 4;
    if (scopeText.includes(token)) score += 2;
    if (linesText.includes(token)) score += 2;
  }

  if (quote.status === "ACCEPTED") score += 18;
  else if (quote.status === "SENT_TO_CUSTOMER") score += 12;
  else if (quote.status === "READY_FOR_REVIEW") score += 4;
  else if (quote.status === "DRAFT") score -= 2;

  const ageInDays = Math.max(
    0,
    Math.floor((Date.now() - quote.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
  );
  if (ageInDays <= 14) score += 4;
  else if (ageInDays <= 45) score += 2;
  else if (ageInDays <= 90) score += 1;

  if (targetAmount && targetAmount > 0 && quote.totalAmount > 0) {
    const deltaRatio = Math.abs(quote.totalAmount - targetAmount) / targetAmount;
    if (deltaRatio <= 0.1) score += 6;
    else if (deltaRatio <= 0.2) score += 3;
    else if (deltaRatio <= 0.35) score += 1;
    else if (deltaRatio >= 0.75) score -= 2;
  }

  return score;
}

async function loadSimilarQuoteContext(
  prisma: Prisma.TransactionClient | PrismaClient,
  access: AccessContext,
  params: {
    serviceType: z.infer<typeof ServiceTypeSchema>;
    prompt: string;
    title?: string | null;
    scopeText?: string | null;
    targetAmount?: number | null;
    excludeQuoteId?: string | null;
  },
): Promise<SimilarQuoteContext[]> {
  const recentQuotes = await prisma.quote.findMany({
    where: {
      tenantId: access.tenantId,
      ...assignedRecordScope(access),
      serviceType: params.serviceType,
      deletedAtUtc: null,
      status: {
        in: ["ACCEPTED", "SENT_TO_CUSTOMER", "READY_FOR_REVIEW", "DRAFT"],
      },
      ...(params.excludeQuoteId ? { id: { not: params.excludeQuoteId } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 24,
    select: {
      id: true,
      title: true,
      scopeText: true,
      totalAmount: true,
      status: true,
      updatedAt: true,
      lineItems: {
        where: { deletedAtUtc: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          description: true,
          sectionType: true,
          sectionLabel: true,
          quantity: true,
          unitPrice: true,
        },
      },
    },
  });

  const queryTokens = aiContextTokens(params.prompt, params.title, params.scopeText);

  return recentQuotes
    .map((quote) => ({
      id: quote.id,
      title: quote.title,
      scopeText: quote.scopeText,
      totalAmount: Number(quote.totalAmount),
      status: quote.status,
      updatedAt: quote.updatedAt,
      lineItems: quote.lineItems.map((lineItem) => ({
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel ?? null,
        quantity: Number(lineItem.quantity),
        unitPrice: Number(lineItem.unitPrice),
      })),
      score: scoreSimilarQuote(queryTokens, {
        title: quote.title,
        scopeText: quote.scopeText,
        totalAmount: Number(quote.totalAmount),
        lineItems: quote.lineItems.map((lineItem) => ({ description: lineItem.description })),
        status: quote.status,
        updatedAt: quote.updatedAt,
      }, params.targetAmount),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    })
    .filter((quote, index) => quote.score > 0 || index < 3)
    .slice(0, 4)
    .map(({ score: _score, ...quote }) => quote);
}

function buildExplicitAiLineItems(params: {
  serviceType: z.infer<typeof ServiceTypeSchema>;
  prompt: string;
  parsedDraft: ParsedChatToQuoteDraft;
  tenantPresets: Array<{
    catalogKey: string | null;
    name: string;
    description: string | null;
    unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH";
    defaultQuantity: Prisma.Decimal | number;
    unitCost: Prisma.Decimal | number;
    unitPrice: Prisma.Decimal | number;
  }>;
  customerPriceSubtotal: number;
  internalCostSubtotal: number;
}) {
  const suggestions =
    params.parsedDraft.lineItems.length > 0
      ? params.parsedDraft.lineItems
      : [
          { description: `${params.serviceType} service`, quantity: 1 },
          { description: "Materials and install supplies", quantity: 1 },
        ];

  const seededLines = suggestions.map((lineItem) => {
    const matchedStandardPreset = findBestStandardWorkPresetMatch(
      params.serviceType,
      `${lineItem.description} ${params.prompt}`,
      { minimumScore: 3 },
    );
    const matchedTenantPreset = matchedStandardPreset
      ? params.tenantPresets.find((preset) => preset.catalogKey === matchedStandardPreset.catalogKey) ?? null
      : null;
    const matchedPreset = matchedTenantPreset
      ? {
          unitType: matchedTenantPreset.unitType,
          defaultQuantity: Number(matchedTenantPreset.defaultQuantity),
          unitCost: Number(matchedTenantPreset.unitCost),
          unitPrice: Number(matchedTenantPreset.unitPrice),
          quantityMode: matchedStandardPreset?.quantityMode ?? "default",
        }
      : matchedStandardPreset
        ? {
            unitType: matchedStandardPreset.unitType,
            defaultQuantity: matchedStandardPreset.defaultQuantity,
            unitCost: matchedStandardPreset.unitCost,
            unitPrice: matchedStandardPreset.unitPrice,
            quantityMode: matchedStandardPreset.quantityMode ?? "default",
          }
        : null;

    const quantity = matchedPreset
      ? inferPresetQuantity(
          matchedPreset.unitType,
          matchedPreset.defaultQuantity,
          params.parsedDraft.squareFeetEstimate,
          matchedPreset.quantityMode,
        )
      : Number(Math.max(1, lineItem.quantity).toFixed(2));

    return {
      description: lineItem.description,
      sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
      sectionLabel: lineItem.sectionLabel ?? null,
      quantity,
      matched: Boolean(matchedPreset),
      baseUnitCost: matchedPreset ? roundCurrency(matchedPreset.unitCost) : 0,
      baseUnitPrice: matchedPreset ? roundCurrency(matchedPreset.unitPrice) : 0,
    };
  });

  const rawMatchedCustomerSubtotal = seededLines.reduce(
    (sum, lineItem) => sum + lineItem.quantity * lineItem.baseUnitPrice,
    0,
  );
  const rawMatchedInternalSubtotal = seededLines.reduce(
    (sum, lineItem) => sum + lineItem.quantity * lineItem.baseUnitCost,
    0,
  );
  const unmatchedLines = seededLines.filter((lineItem) => !lineItem.matched);
  const unmatchedQuantityTotal = Math.max(
    unmatchedLines.reduce((sum, lineItem) => sum + Math.max(lineItem.quantity, 1), 0),
    1,
  );

  const remainingCustomerSubtotal =
    unmatchedLines.length > 0
      ? Math.max(params.customerPriceSubtotal - rawMatchedCustomerSubtotal, 0)
      : params.customerPriceSubtotal;
  const remainingInternalSubtotal =
    unmatchedLines.length > 0
      ? Math.max(params.internalCostSubtotal - rawMatchedInternalSubtotal, 0)
      : params.internalCostSubtotal;

  const rawLines = seededLines.map((lineItem) => {
    if (lineItem.matched) {
      return {
        description: lineItem.description,
        sectionType: lineItem.sectionType,
        sectionLabel: lineItem.sectionLabel,
        quantity: lineItem.quantity,
        unitCost: lineItem.baseUnitCost,
        unitPrice: lineItem.baseUnitPrice,
      };
    }

    const quantityShare = Math.max(lineItem.quantity, 1) / unmatchedQuantityTotal;
    return {
      description: lineItem.description,
      sectionType: lineItem.sectionType,
      sectionLabel: lineItem.sectionLabel,
      quantity: lineItem.quantity,
      unitCost: roundCurrency(remainingInternalSubtotal * quantityShare / Math.max(lineItem.quantity, 1)),
      unitPrice: roundCurrency(remainingCustomerSubtotal * quantityShare / Math.max(lineItem.quantity, 1)),
    };
  });

  const rawCustomerSubtotal = rawLines.reduce((sum, lineItem) => sum + lineItem.quantity * lineItem.unitPrice, 0);
  const rawInternalSubtotal = rawLines.reduce((sum, lineItem) => sum + lineItem.quantity * lineItem.unitCost, 0);

  return rawLines.map((lineItem) => ({
    ...lineItem,
    unitCost:
      rawInternalSubtotal > 0
        ? roundCurrency(lineItem.unitCost * (params.internalCostSubtotal / rawInternalSubtotal))
        : lineItem.unitCost,
    unitPrice:
      rawCustomerSubtotal > 0
        ? roundCurrency(lineItem.unitPrice * (params.customerPriceSubtotal / rawCustomerSubtotal))
        : lineItem.unitPrice,
  }));
}

async function buildAiSuggestedQuoteDraft(
  prisma: Prisma.TransactionClient | PrismaClient,
  tenantId: string,
  params: {
    prompt: string;
    parsedDraft: ParsedChatToQuoteDraft;
    serviceTypeOverride?: z.infer<typeof ServiceTypeSchema>;
  },
): Promise<AiSuggestedQuoteDraft> {
  const serviceType = params.serviceTypeOverride ?? params.parsedDraft.serviceType;
  const pricingProfile = await prisma.pricingProfile.findFirst({
    where: {
      tenantId,
      serviceType,
    },
    orderBy: {
      isDefault: "desc",
    },
  });

  const tenantPresets = await prisma.workPreset.findMany({
    where: {
      tenantId,
      serviceType,
      deletedAtUtc: null,
    },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const laborRate = Number(pricingProfile?.laborRate ?? defaultLaborRate(serviceType));
  const materialMarkup = Number(pricingProfile?.materialMarkup ?? defaultMaterialMarkup(serviceType));
  const estimatedUnits = params.parsedDraft.squareFeetEstimate ?? 100;
  const taxAmount = roundCurrency(params.parsedDraft.estimatedTaxAmount ?? 0);

  const matchedStandardPreset = findBestStandardWorkPresetMatch(
    serviceType,
    `${params.prompt} ${params.parsedDraft.title} ${params.parsedDraft.scopeText}`,
    { primaryOnly: true },
  );
  const matchedTenantPreset = matchedStandardPreset
    ? tenantPresets.find((preset) => preset.catalogKey === matchedStandardPreset.catalogKey) ?? null
    : null;
  const matchedPreset = matchedTenantPreset
    ? {
        name: matchedTenantPreset.name,
        description: matchedTenantPreset.description,
        unitType: matchedTenantPreset.unitType,
        defaultQuantity: Number(matchedTenantPreset.defaultQuantity),
        unitCost: Number(matchedTenantPreset.unitCost),
        unitPrice: Number(matchedTenantPreset.unitPrice),
        quantityMode: matchedStandardPreset?.quantityMode ?? "default",
      }
    : matchedStandardPreset
      ? {
          name: matchedStandardPreset.name,
          description: matchedStandardPreset.description,
          unitType: matchedStandardPreset.unitType,
          defaultQuantity: matchedStandardPreset.defaultQuantity,
          unitCost: matchedStandardPreset.unitCost,
          unitPrice: matchedStandardPreset.unitPrice,
          quantityMode: matchedStandardPreset.quantityMode ?? "default",
        }
      : null;
  const preferExplicitAiLines = shouldPreserveExplicitAiLineStructure({
    prompt: params.prompt,
    parsedDraft: params.parsedDraft,
    serviceType,
  });

  const hasExplicitSubtotalTarget =
    (params.parsedDraft.estimatedTotalAmount ?? 0) > 0 || (params.parsedDraft.estimatedInternalCostAmount ?? 0) > 0;

  const supplementalPresetMatches =
    matchedStandardPreset && !hasExplicitSubtotalTarget && !preferExplicitAiLines
      ? findStandardWorkPresetMatches(
          serviceType,
          `${params.prompt} ${params.parsedDraft.title} ${params.parsedDraft.scopeText}`,
          {
            excludeCatalogKeys: [matchedStandardPreset.catalogKey],
            minimumScore: 4,
          },
        )
          .map((match) => match.preset)
          .filter((preset) => !preset.isPrimaryJob)
          .slice(0, 3)
      : [];

  const supplementalPresets = supplementalPresetMatches.map((preset) => {
    const tenantPreset = tenantPresets.find((tenantItem) => tenantItem.catalogKey === preset.catalogKey);
    return tenantPreset
      ? {
          name: tenantPreset.name,
          description: tenantPreset.description,
          unitType: tenantPreset.unitType,
          defaultQuantity: Number(tenantPreset.defaultQuantity),
          unitCost: Number(tenantPreset.unitCost),
          unitPrice: Number(tenantPreset.unitPrice),
          quantityMode: preset.quantityMode ?? "default",
        }
      : {
          name: preset.name,
          description: preset.description,
          unitType: preset.unitType,
          defaultQuantity: preset.defaultQuantity,
          unitCost: preset.unitCost,
          unitPrice: preset.unitPrice,
          quantityMode: preset.quantityMode ?? "default",
        };
  });

  let customerPriceSubtotal = roundCurrency(params.parsedDraft.estimatedTotalAmount ?? 0);
  if (customerPriceSubtotal <= 0 && matchedPreset && !preferExplicitAiLines) {
    const matchedQuantity = inferPresetQuantity(
      matchedPreset.unitType,
      matchedPreset.defaultQuantity,
      params.parsedDraft.squareFeetEstimate,
      matchedPreset.quantityMode,
    );
    customerPriceSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitPrice);
  }
  if (customerPriceSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset && !preferExplicitAiLines) {
    const primaryQuantity = inferPresetQuantity(
      matchedPreset.unitType,
      matchedPreset.defaultQuantity,
      params.parsedDraft.squareFeetEstimate,
      matchedPreset.quantityMode,
    );
    const supplementalSubtotal = supplementalPresets.reduce((sum, preset) => {
      const quantity = inferPresetQuantity(
        preset.unitType,
        preset.defaultQuantity,
        params.parsedDraft.squareFeetEstimate,
        preset.quantityMode,
      );
      return sum + quantity * preset.unitPrice;
    }, 0);
    customerPriceSubtotal = roundCurrency(primaryQuantity * matchedPreset.unitPrice + supplementalSubtotal);
  }
  if (customerPriceSubtotal <= 0) {
    const baselineInternalCost = roundCurrency(estimatedUnits * laborRate);
    customerPriceSubtotal = roundCurrency(baselineInternalCost * (1 + materialMarkup));
  }

  let internalCostSubtotal = roundCurrency(params.parsedDraft.estimatedInternalCostAmount ?? 0);
  if (internalCostSubtotal <= 0 && matchedPreset && !preferExplicitAiLines) {
    const matchedQuantity = inferPresetQuantity(
      matchedPreset.unitType,
      matchedPreset.defaultQuantity,
      params.parsedDraft.squareFeetEstimate,
      matchedPreset.quantityMode,
    );
    internalCostSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitCost);
  }
  if (internalCostSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset && !preferExplicitAiLines) {
    const primaryQuantity = inferPresetQuantity(
      matchedPreset.unitType,
      matchedPreset.defaultQuantity,
      params.parsedDraft.squareFeetEstimate,
      matchedPreset.quantityMode,
    );
    const supplementalSubtotal = supplementalPresets.reduce((sum, preset) => {
      const quantity = inferPresetQuantity(
        preset.unitType,
        preset.defaultQuantity,
        params.parsedDraft.squareFeetEstimate,
        preset.quantityMode,
      );
      return sum + quantity * preset.unitCost;
    }, 0);
    internalCostSubtotal = roundCurrency(primaryQuantity * matchedPreset.unitCost + supplementalSubtotal);
  }
  if (internalCostSubtotal <= 0) {
    const divisor = 1 + Math.max(materialMarkup, 0.05);
    internalCostSubtotal = roundCurrency(customerPriceSubtotal / divisor);
  }

  const totalAmount = calculateQuoteTotal(customerPriceSubtotal, taxAmount);
  const title = matchedPreset?.name ?? params.parsedDraft.title;
  const scopeText = resolveChatQuoteScopeText(
    params.parsedDraft.scopeText,
    params.prompt,
    matchedPreset?.description,
  );

  const lineItems = matchedPreset && !preferExplicitAiLines
    ? (() => {
        const primaryQuantity = inferPresetQuantity(
          matchedPreset.unitType,
          matchedPreset.defaultQuantity,
          params.parsedDraft.squareFeetEstimate,
          matchedPreset.quantityMode,
        );
        const primaryLineItems = [
          {
            description: matchedPreset.name,
            quantity: primaryQuantity,
            unitCost: roundCurrency(matchedPreset.unitCost),
            unitPrice: roundCurrency(matchedPreset.unitPrice),
          },
        ];

        const supplementalLineItems = supplementalPresets.map((preset) => ({
          description: preset.name,
          quantity: inferPresetQuantity(
            preset.unitType,
            preset.defaultQuantity,
            params.parsedDraft.squareFeetEstimate,
            preset.quantityMode,
          ),
          unitCost: roundCurrency(preset.unitCost),
          unitPrice: roundCurrency(preset.unitPrice),
        }));

        const allLineItems = [...primaryLineItems, ...supplementalLineItems];
        const rawCustomerSubtotal = allLineItems.reduce((sum, lineItem) => sum + lineItem.quantity * lineItem.unitPrice, 0);
        const rawInternalSubtotal = allLineItems.reduce((sum, lineItem) => sum + lineItem.quantity * lineItem.unitCost, 0);

        return allLineItems.map((lineItem) => ({
          ...lineItem,
          sectionType: "INCLUDED" as const,
          sectionLabel: null,
          unitCost:
            rawInternalSubtotal > 0
              ? roundCurrency(lineItem.unitCost * (internalCostSubtotal / rawInternalSubtotal))
              : lineItem.unitCost,
          unitPrice:
            rawCustomerSubtotal > 0
              ? roundCurrency(lineItem.unitPrice * (customerPriceSubtotal / rawCustomerSubtotal))
              : lineItem.unitPrice,
        }));
      })()
    : (() => {
        return buildExplicitAiLineItems({
          serviceType,
          prompt: params.prompt,
          parsedDraft: params.parsedDraft,
          tenantPresets,
          customerPriceSubtotal,
          internalCostSubtotal,
        });
      })();

  return {
    serviceType,
    title,
    scopeText,
    internalCostSubtotal,
    customerPriceSubtotal,
    taxAmount,
    totalAmount,
    lineItems,
    model: getAiQuoteRuntimeInfo().model,
  };
}

function inferPresetQuantity(
  unitType: "FLAT" | "SQ_FT" | "HOUR" | "EACH",
  defaultQuantity: number,
  squareFeetEstimate: number | null,
  quantityMode: "default" | "project_area" = "default",
): number {
  if (quantityMode === "project_area" && unitType === "SQ_FT" && squareFeetEstimate && squareFeetEstimate > 0) {
    return Number(squareFeetEstimate.toFixed(2));
  }

  return Number(Math.max(defaultQuantity, 1).toFixed(2));
}

/**
 * Defense-in-depth for historical rows created before prompt minimization.
 * Quote handlers return several different Prisma projections, so the scoped
 * serialization hook removes raw prompt fields from every JSON shape without
 * changing dates, decimals, streams, or binary PDF responses.
 */
function stripRestrictedAiPromptFields(payload: unknown, seen = new WeakSet<object>()): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (payload instanceof Date || Buffer.isBuffer(payload)) return payload;
  if (seen.has(payload)) return payload;
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (const value of payload) stripRestrictedAiPromptFields(value, seen);
    return payload;
  }

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return payload;

  const record = payload as Record<string, unknown>;
  delete record.aiPromptText;
  delete record.promptText;
  for (const value of Object.values(record)) {
    stripRestrictedAiPromptFields(value, seen);
  }
  return payload;
}

const MEMBER_RESTRICTED_FINANCIAL_FIELDS = new Set([
  "internalCostSubtotal",
  "unitCost",
  "grossCost",
  "grossProfit",
  "grossMarginPercent",
  "estimatedProfit",
  "estimatedMarginPercent",
]);

function stripInternalFinancialFields(payload: unknown, seen = new WeakSet<object>()): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (payload instanceof Date || Buffer.isBuffer(payload)) return payload;
  if (seen.has(payload)) return payload;
  seen.add(payload);
  if (Array.isArray(payload)) {
    for (const value of payload) stripInternalFinancialFields(value, seen);
    return payload;
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return payload;
  const record = payload as Record<string, unknown>;
  for (const field of MEMBER_RESTRICTED_FINANCIAL_FIELDS) delete record[field];
  for (const value of Object.values(record)) stripInternalFinancialFields(value, seen);
  return payload;
}

async function resolveRequestedQuoteAssignee(
  prisma: PrismaClient,
  access: AccessContext,
  requested: string | null | undefined,
  inherited: string | null | undefined,
): Promise<{ allowed: true; assignedTenantUserId: string | null } | { allowed: false }> {
  if (!hasCapability(access, "manageAssignments")) {
    if (requested !== undefined && requested !== access.tenantUserId) return { allowed: false };
    return { allowed: true, assignedTenantUserId: access.tenantUserId };
  }
  if (requested === null) return { allowed: true, assignedTenantUserId: null };
  const candidate = requested ?? inherited ?? defaultAssigneeForCreatedRecord(access);
  if (!candidate) return { allowed: true, assignedTenantUserId: null };
  const valid = await validateActiveTenantAssignee(prisma, {
    tenantId: access.tenantId,
    tenantUserId: candidate,
  });
  return valid ? { allowed: true, assignedTenantUserId: candidate } : { allowed: false };
}

async function resolveMemberLineUnitCost(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { access: AccessContext; sourcePresetId?: string; requestedUnitCost: number },
): Promise<number> {
  if (hasCapability(input.access, "viewInternalCosts")) return input.requestedUnitCost;
  if (!input.sourcePresetId) return 0;
  const preset = await prisma.workPreset.findFirst({
    where: {
      id: input.sourcePresetId,
      tenantId: input.access.tenantId,
      deletedAtUtc: null,
    },
    select: { unitCost: true },
  });
  return preset ? Number(preset.unitCost) : 0;
}

export const quoteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preSerialization", async (request, _reply, payload) => {
    stripRestrictedAiPromptFields(payload);
    const membership = request.liveAuthMembership;
    if (membership && !hasCapability(buildAccessContext(request), "viewInternalCosts")) {
      stripInternalFinancialFields(payload);
    }
    return payload;
  });

  app.post("/quotes/ai-suggest", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = SuggestQuoteWithAiSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "useAiQuoteDrafting")) {
      return reply.code(403).send({ error: "AI quote drafting is not enabled for this role." });
    }
    const includeFinancialContext = hasCapability(access, "viewInternalCosts");
    const actor = await resolveActivityActor(app.prisma, claims);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const { blocked, blockedBy, snapshot } = await assertAiUsageAvailable(
      app.prisma,
      claims.tenantId,
      entitlements,
    );

    if (blocked) {
      const requiredPlan =
        entitlements.planCode === "starter" ? "professional" : "enterprise";
      const blockedBySpend = blockedBy === "aiSpendUsdPerMonth";
      return reply.code(403).send({
        code: "PLAN_LIMIT_EXCEEDED",
        error: blockedBySpend
          ? `${entitlements.planName} includes up to $${formatUsdValue(snapshot.monthlySpendLimitUsd ?? 0)} AI usage per month. This workspace has used $${formatUsdValue(snapshot.monthlySpendUsedUsd)} this month. AI usage renews on ${formatAiRenewalDate(snapshot.periodEndUtc)}.`
          : `${entitlements.planName} includes up to ${snapshot.monthlyCreditsLimit ?? entitlements.limits.aiQuotesPerMonth ?? 0} AI requests per month. This workspace has used ${snapshot.monthlyCreditsUsed} AI requests this month. AI usage renews on ${formatAiRenewalDate(snapshot.periodEndUtc)}.`,
        feature: blockedBySpend ? "aiSpendUsdPerMonth" : "aiQuotesPerMonth",
        currentPlan: entitlements.planCode,
        requiredPlan,
        limit: blockedBySpend ? snapshot.monthlySpendLimitUsd : entitlements.limits.aiQuotesPerMonth,
        used: blockedBySpend ? snapshot.monthlySpendUsedUsd : snapshot.monthlyCreditsUsed,
        renewsAtUtc: snapshot.periodEndUtc,
        usage: buildAiUsageResponse(snapshot, { consumedCredits: 0, consumedSpendUsd: 0 }),
      });
    }

    const stream = startAiSuggestionStream(reply);

    try {
      const aiTelemetry = createAiTelemetryAccumulator();
      stream.progress(
        "analyzing_prompt",
        "Parsing the request and checking whether this is a new draft or a revision.",
      );

      const existingQuote = payload.quoteId
        ? await app.prisma.quote.findFirst({
            where: {
              id: payload.quoteId,
              ...tenantActiveQuoteScope(claims.tenantId),
              ...assignedRecordScope(access),
            },
            include: {
              customer: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  phone: true,
                  notes: true,
                },
              },
              lineItems: {
                where: tenantActiveScope(claims.tenantId),
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  description: true,
                  sectionType: true,
                  sectionLabel: true,
                  quantity: true,
                  unitCost: true,
                  unitPrice: true,
                },
              },
            },
          })
        : null;

      if (payload.quoteId && !existingQuote) {
        stream.write({ type: "error", error: "Quote not found for tenant." });
        stream.end();
        return reply;
      }

      const hadExplicitCustomerContext = Boolean(payload.customerId || existingQuote?.customerId);

      stream.progress(
        "loading_customer_context",
        existingQuote?.customer
          ? "Using the quote's current customer and line items as context."
          : payload.customerId
            ? "Using the selected customer as context for drafting."
            : "No customer is locked yet. AI will try to infer customer details from the prompt.",
      );

      let selectedCustomer = payload.customerId
        ? await app.prisma.customer.findFirst({
            where: {
              id: payload.customerId,
              ...tenantActiveCustomerScope(claims.tenantId),
              ...assignedRecordScope(access),
            },
          })
        : existingQuote?.customer ?? null;

    const preflightDraft = parseChatToQuotePrompt(payload.prompt);
    const preliminaryServiceType =
      existingQuote?.serviceType ?? payload.serviceType ?? preflightDraft.serviceType;
    const currentQuoteEstimatedTotal = payload.currentLineItems?.length
      ? roundCurrency(
          payload.currentLineItems.reduce(
            (sum, lineItem) => sum + lineItem.quantity * lineItem.unitPrice,
            0,
          ),
        )
      : existingQuote
        ? Number(existingQuote.totalAmount)
        : null;

    const contextPresets = await app.prisma.workPreset.findMany({
      where: {
        tenantId: claims.tenantId,
        serviceType: preliminaryServiceType,
        deletedAtUtc: null,
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      take: 8,
    });

    const contextPricingProfile = await app.prisma.pricingProfile.findFirst({
      where: {
        tenantId: claims.tenantId,
        serviceType: preliminaryServiceType,
      },
      orderBy: {
        isDefault: "desc",
      },
    });

    let customerActivityContext = selectedCustomer
      ? await app.prisma.customerActivityEvent.findMany({
          where: {
            tenantId: claims.tenantId,
            customerId: selectedCustomer.id,
            deletedAtUtc: null,
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            title: true,
            detail: true,
            createdAt: true,
          },
        })
          .then((events) =>
            events.map((event) => ({
              title: event.title,
              detail: event.detail,
              occurredAt: event.createdAt,
            })),
          )
      : [];

    const similarQuotes = await loadSimilarQuoteContext(app.prisma, access, {
      serviceType: preliminaryServiceType,
      prompt: payload.prompt,
      title: existingQuote?.title ?? payload.currentTitle ?? preflightDraft.title,
      scopeText: existingQuote?.scopeText ?? payload.currentScopeText ?? preflightDraft.scopeText,
      targetAmount: preflightDraft.estimatedTotalAmount ?? currentQuoteEstimatedTotal,
      excludeQuoteId: existingQuote?.id ?? payload.quoteId ?? null,
    });

    const standardCatalogMatches = buildStandardCatalogMatchesForAiContext({
      serviceType: preliminaryServiceType,
      prompt: payload.prompt,
      title: existingQuote?.title ?? payload.currentTitle ?? preflightDraft.title,
      scopeText: existingQuote?.scopeText ?? payload.currentScopeText ?? preflightDraft.scopeText,
      lineItemDescriptions:
        payload.currentLineItems?.map((lineItem) => lineItem.description) ??
        existingQuote?.lineItems.map((lineItem) => lineItem.description) ??
        [],
      tenantPresets: contextPresets.map((preset) => ({
        catalogKey: preset.catalogKey ?? null,
        name: preset.name,
        description: preset.description ?? null,
        unitType: preset.unitType,
        unitCost: preset.unitCost,
        unitPrice: preset.unitPrice,
      })),
      minimumScore: 2,
      limit: 7,
    });

    stream.progress(
      "retrieving_workspace_context",
      `Loaded ${contextPresets.length} saved job${contextPresets.length === 1 ? "" : "s"}, ${standardCatalogMatches.length} catalog match${standardCatalogMatches.length === 1 ? "" : "es"}, and ${similarQuotes.length} similar quote${similarQuotes.length === 1 ? "" : "s"} for ${preliminaryServiceType.toLowerCase()}.`,
      {
        sourceHints: buildAiContextSourceHints({
          customer: selectedCustomer
            ? {
                notes: selectedCustomer.notes,
              }
            : null,
          customerActivityCount: customerActivityContext.length,
          presetCount: contextPresets.length,
          standardPresetCount: standardCatalogMatches.length,
          similarQuotes,
        }),
      },
    );

    const currentQuoteContext =
      payload.currentTitle || payload.currentScopeText || payload.currentLineItems?.length
        ? {
            serviceType: existingQuote?.serviceType ?? preliminaryServiceType,
            title: payload.currentTitle ?? existingQuote?.title,
            scopeText: payload.currentScopeText ?? existingQuote?.scopeText,
            lineItems: payload.currentLineItems?.length
              ? payload.currentLineItems.map((lineItem) => ({
                  id: lineItem.id ?? null,
                  description: lineItem.description,
                  sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
                  sectionLabel: lineItem.sectionLabel ?? null,
                  quantity: lineItem.quantity,
                  unitCost: lineItem.unitCost,
                  unitPrice: lineItem.unitPrice,
                }))
              : (existingQuote?.lineItems ?? []).map((lineItem) => ({
                  id: lineItem.id,
                  description: lineItem.description,
                  sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
                  sectionLabel: lineItem.sectionLabel,
                  quantity: Number(lineItem.quantity),
                  unitCost: Number(lineItem.unitCost),
                  unitPrice: Number(lineItem.unitPrice),
                })),
          }
        : existingQuote
          ? {
              serviceType: existingQuote.serviceType,
              title: existingQuote.title,
              scopeText: existingQuote.scopeText,
              lineItems: existingQuote.lineItems.map((lineItem) => ({
                id: lineItem.id,
                description: lineItem.description,
                sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
                sectionLabel: lineItem.sectionLabel,
                quantity: Number(lineItem.quantity),
                unitCost: Number(lineItem.unitCost),
                unitPrice: Number(lineItem.unitPrice),
              })),
            }
        : null;

    let governedRetrieval: AiRetrievalResult | null = null;
    try {
      governedRetrieval = await buildGovernedQuoteAiContext(app.prisma, {
        access,
        query: payload.prompt,
        purpose: currentQuoteContext || existingQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
        serviceType: preliminaryServiceType,
        requestId: request.id,
        customerId: selectedCustomer?.id ?? null,
        quoteId: existingQuote?.id ?? payload.quoteId ?? null,
      });
      accumulateAiUsageTelemetry(aiTelemetry, governedRetrieval.telemetry);
    } catch (retrievalErr) {
      request.log.warn({ err: retrievalErr }, "[quotes/ai-suggest] governed retrieval context unavailable");
    }

    let contextPrompt = appendAiPromptStructureHints(buildAiQuoteContext({
      customer: selectedCustomer
          ? {
              fullName: selectedCustomer.fullName,
              phone: selectedCustomer.phone,
              email: selectedCustomer.email,
              notes: selectedCustomer.notes,
            }
          : null,
      customerActivity: customerActivityContext,
      currentQuote: currentQuoteContext
        ? {
            serviceType: currentQuoteContext.serviceType,
            title: currentQuoteContext.title,
            scopeText: currentQuoteContext.scopeText,
            lineItems: currentQuoteContext.lineItems.map((lineItem) => ({
              description: lineItem.description,
              sectionType: lineItem.sectionType,
              sectionLabel: lineItem.sectionLabel,
              quantity: lineItem.quantity,
              unitCost: lineItem.unitCost,
              unitPrice: lineItem.unitPrice,
            })),
          }
        : null,
      presets: contextPresets.map((preset) => ({
        name: preset.name,
        description: preset.description,
        unitType: preset.unitType,
        unitCost: Number(preset.unitCost),
        unitPrice: Number(preset.unitPrice),
      })),
      standardCatalogMatches,
      pricingProfile: contextPricingProfile
        ? {
            laborRate: Number(contextPricingProfile.laborRate),
            materialMarkup: Number(contextPricingProfile.materialMarkup),
          }
          : null,
      similarQuotes,
      retrievalContext: governedRetrieval?.context,
      includeFinancialContext,
    }), payload.prompt);

    stream.progress(
      "drafting_quote_patch",
      "Interpreting the request and preparing line-by-line quote changes.",
      {
        sourceHints: buildAiContextSourceHints({
          customer: selectedCustomer
            ? {
                notes: selectedCustomer.notes,
              }
            : null,
          customerActivityCount: customerActivityContext.length,
          presetCount: contextPresets.length,
          standardPresetCount: standardCatalogMatches.length,
          similarQuotes,
        }),
      },
    );

    let parsedDraft = await aiParseChatToQuotePrompt(payload.prompt, {
      context: contextPrompt,
      telemetry: aiTelemetry,
    });

    const customerPhone = normalizeNullablePhone(parsedDraft.customerPhone);
    const customerEmail = normalizeNullableEmail(parsedDraft.customerEmail);

    if (!selectedCustomer && customerPhone) {
      selectedCustomer = await findActiveCustomerByPhone(app.prisma, claims.tenantId, customerPhone);
    }

    if (!selectedCustomer && customerEmail) {
      selectedCustomer = await app.prisma.customer.findFirst({
        where: {
          email: customerEmail,
          ...tenantActiveCustomerScope(claims.tenantId),
        },
      });
    }

    if (!selectedCustomer && customerPhone) {
      selectedCustomer = await findOrCreatePromptCustomer(app.prisma, claims.tenantId, {
        fullName: parsedDraft.customerName,
        phone: customerPhone,
        email: customerEmail,
      });

      if (selectedCustomer) {
        stream.progress(
          "loading_customer_context",
          `Matched the prompt to ${selectedCustomer.fullName} and attached the draft to that customer.`,
        );
      }
    }

    if (selectedCustomer && !hadExplicitCustomerContext) {
      customerActivityContext = await app.prisma.customerActivityEvent.findMany({
        where: {
          tenantId: claims.tenantId,
          customerId: selectedCustomer.id,
          deletedAtUtc: null,
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          title: true,
          detail: true,
          createdAt: true,
        },
      }).then((events) =>
        events.map((event) => ({
          title: event.title,
          detail: event.detail,
          occurredAt: event.createdAt,
        })),
      );

      try {
        governedRetrieval = await buildGovernedQuoteAiContext(app.prisma, {
          access,
          query: payload.prompt,
          purpose: currentQuoteContext || existingQuote ? "QUOTE_REVISION" : "QUOTE_DRAFT",
          serviceType: preliminaryServiceType,
          requestId: request.id,
          customerId: selectedCustomer.id,
          quoteId: existingQuote?.id ?? payload.quoteId ?? null,
        });
        accumulateAiUsageTelemetry(aiTelemetry, governedRetrieval.telemetry);
      } catch (retrievalErr) {
        request.log.warn({ err: retrievalErr }, "[quotes/ai-suggest] customer-specific retrieval context unavailable");
      }

      contextPrompt = appendAiPromptStructureHints(buildAiQuoteContext({
        customer: {
          fullName: selectedCustomer.fullName,
          phone: selectedCustomer.phone,
          email: selectedCustomer.email,
          notes: selectedCustomer.notes,
        },
        customerActivity: customerActivityContext,
        currentQuote: currentQuoteContext
          ? {
              serviceType: currentQuoteContext.serviceType,
              title: currentQuoteContext.title,
              scopeText: currentQuoteContext.scopeText,
              lineItems: currentQuoteContext.lineItems.map((lineItem) => ({
                description: lineItem.description,
                sectionType: lineItem.sectionType,
                sectionLabel: lineItem.sectionLabel,
                quantity: lineItem.quantity,
                unitCost: lineItem.unitCost,
                unitPrice: lineItem.unitPrice,
              })),
            }
          : null,
        presets: contextPresets.map((preset) => ({
          name: preset.name,
          description: preset.description,
          unitType: preset.unitType,
          unitCost: Number(preset.unitCost),
          unitPrice: Number(preset.unitPrice),
        })),
        standardCatalogMatches,
        pricingProfile: contextPricingProfile
          ? {
              laborRate: Number(contextPricingProfile.laborRate),
              materialMarkup: Number(contextPricingProfile.materialMarkup),
            }
          : null,
        similarQuotes,
        retrievalContext: governedRetrieval?.context,
        includeFinancialContext,
      }), payload.prompt);

      parsedDraft = await aiParseChatToQuotePrompt(payload.prompt, {
        context: contextPrompt,
        telemetry: aiTelemetry,
      });

      stream.progress(
        "drafting_quote_patch",
        `Matched customer context from the prompt: ${selectedCustomer.fullName}. Refining the suggestion with saved notes and recent activity.`,
        {
          sourceHints: buildAiContextSourceHints({
            customer: {
              notes: selectedCustomer.notes,
            },
            customerActivityCount: customerActivityContext.length,
            presetCount: contextPresets.length,
            standardPresetCount: standardCatalogMatches.length,
            similarQuotes,
          }),
        },
      );
    }

    let baselineSuggestion = await buildAiSuggestedQuoteDraft(app.prisma, claims.tenantId, {
      prompt: payload.prompt,
      parsedDraft,
      serviceTypeOverride: existingQuote?.serviceType ?? payload.serviceType,
    });

    const hasCurrentSheetContext = currentQuoteContext
      ? hasMeaningfulCurrentQuoteContext(currentQuoteContext)
      : false;
    const currentLinesForPatch = currentQuoteContext?.lineItems ?? [];

    let revisionPlan = hasCurrentSheetContext
      ? await aiBuildQuoteRevisionPlan(payload.prompt, {
          context: buildAiRevisionContextPrompt(contextPrompt, currentQuoteContext, baselineSuggestion, {
            includeFinancialContext,
          }),
          telemetry: aiTelemetry,
        })
      : null;

    const hasMeaningfulCurrentLines = Boolean(
      currentLinesForPatch.some((lineItem) => isMeaningfulAiLine(lineItem)),
    );
    const revisionPatch = revisionPlan
      ? applyAiRevisionPlan(currentLinesForPatch, baselineSuggestion, revisionPlan)
      : null;
    const shouldFallbackToDeterministicPatch = Boolean(
      revisionPlan &&
        !hasMeaningfulCurrentLines &&
        revisionPatch &&
        revisionPatch.lineChanges.length === 0,
    );
    let patch = shouldFallbackToDeterministicPatch
      ? buildDeterministicAiPatch(currentLinesForPatch, baselineSuggestion.lineItems)
      : (revisionPatch ?? buildDeterministicAiPatch(currentLinesForPatch, baselineSuggestion.lineItems));
    let suggestion = resolveAiSuggestionFromPatch({
      baselineSuggestion,
      revisionPlan,
      hasCurrentSheetContext,
      currentQuoteContext,
      patch,
    }).suggestion;
    let guardrailRetryApplied = false;

    if (
      !hasAiPatchMutations(patch) &&
      !hasAiSuggestionMetadataMutation({
        hasCurrentSheetContext,
        currentQuoteContext,
        suggestion,
      })
    ) {
      stream.progress(
        "reviewing_line_changes",
        "No concrete quote edits detected from the first pass. Retrying once with stricter line-level constraints.",
      );

      try {
        const retryContextPrompt = appendAiPromptStructureHints(
          `${contextPrompt}\n\n${AI_GUARDRAIL_RETRY_HINT}`,
          payload.prompt,
        );
        const retryParsedDraft = await aiParseChatToQuotePrompt(payload.prompt, {
          context: retryContextPrompt,
          telemetry: aiTelemetry,
          strictAi: true,
        });
        const retryBaselineSuggestion = await buildAiSuggestedQuoteDraft(app.prisma, claims.tenantId, {
          prompt: payload.prompt,
          parsedDraft: retryParsedDraft,
          serviceTypeOverride: existingQuote?.serviceType ?? payload.serviceType,
        });
        const retryRevisionPlan = hasCurrentSheetContext
          ? await aiBuildQuoteRevisionPlan(payload.prompt, {
              context: buildAiRevisionContextPrompt(
                retryContextPrompt,
                currentQuoteContext,
                retryBaselineSuggestion,
                { includeFinancialContext },
              ),
              telemetry: aiTelemetry,
            })
          : null;
        const retryRevisionPatch = retryRevisionPlan
          ? applyAiRevisionPlan(currentLinesForPatch, retryBaselineSuggestion, retryRevisionPlan)
          : null;
        const retryPatch = retryRevisionPatch ?? buildDeterministicAiPatch(currentLinesForPatch, retryBaselineSuggestion.lineItems);
        const retrySuggestionResolution = resolveAiSuggestionFromPatch({
          baselineSuggestion: retryBaselineSuggestion,
          revisionPlan: retryRevisionPlan,
          hasCurrentSheetContext,
          currentQuoteContext,
          patch: retryPatch,
        });
        const retrySuggestion = retrySuggestionResolution.suggestion;
        const retryProducedMutation =
          hasAiPatchMutations(retryPatch) ||
          hasAiSuggestionMetadataMutation({
            hasCurrentSheetContext,
            currentQuoteContext,
            suggestion: retrySuggestion,
          });

        if (retryProducedMutation) {
          parsedDraft = retryParsedDraft;
          baselineSuggestion = retryBaselineSuggestion;
          revisionPlan = retryRevisionPlan;
          patch = retryPatch;
          suggestion = retrySuggestion;
          guardrailRetryApplied = true;
          stream.progress(
            "reviewing_line_changes",
            `Guardrail retry recovered actionable edits: ${patch.updated} updated, ${patch.added} added, ${patch.removed} removed.`,
            {
              patchCounts: {
                added: patch.added,
                updated: patch.updated,
                removed: patch.removed,
              },
            },
          );
        }
      } catch (retryErr) {
        request.log.warn({ err: retryErr }, "[quotes/ai-suggest] guardrail retry failed");
      }
    }

    if (
      !hasAiPatchMutations(patch) &&
      !hasAiSuggestionMetadataMutation({
        hasCurrentSheetContext,
        currentQuoteContext,
        suggestion,
      })
    ) {
      stream.write({
        type: "error",
        error:
          "AI could not produce a concrete quote update from that prompt. Add explicit scope, quantities, or requested line edits and try again.",
      });
      stream.end();
      return reply;
    }

    const insight = buildAiSuggestionInsight({
      summary: revisionPlan?.summary,
      reasons: revisionPlan?.reasons,
      currentQuoteUsed: hasCurrentSheetContext,
      customer: selectedCustomer
        ? {
            fullName: selectedCustomer.fullName,
            notes: selectedCustomer.notes,
          }
        : null,
      customerActivityCount: customerActivityContext.length,
      presetCount: contextPresets.length,
      standardPresetCount: standardCatalogMatches.length,
      similarQuotes,
      retrievalCitations: governedRetrieval?.citations,
      targetAmount: suggestion.totalAmount,
      patch,
    });

    stream.progress(
      "reviewing_line_changes",
      `Line patch ready: ${patch.updated} updated, ${patch.added} added, ${patch.removed} removed.`,
      {
        sourceHints: insight.sources.map((source) => source.label).slice(0, 4),
        patchCounts: {
          added: patch.added,
          updated: patch.updated,
          removed: patch.removed,
        },
      },
    );

    stream.progress(
      "finalizing_suggestion",
      `Prepared ${patch.updated} update${patch.updated === 1 ? "" : "s"}, ${patch.added} add${patch.added === 1 ? "" : "s"}, and ${patch.removed} removal${patch.removed === 1 ? "" : "s"} for review.`,
      {
        sourceHints: insight.sources.map((source) => source.label).slice(0, 4),
        patchCounts: {
          added: patch.added,
          updated: patch.updated,
          removed: patch.removed,
        },
      },
    );

    let aiRunId = "untracked";
    try {
      const aiUsageEvent = await createAiUsageEvent(app.prisma, {
        tenantId: claims.tenantId,
        quoteId: existingQuote?.id ?? payload.quoteId ?? null,
        customerId: selectedCustomer?.id ?? existingQuote?.customerId ?? null,
        actor,
        eventType: hasCurrentSheetContext || existingQuote ? "REVISE" : "DRAFT",
        promptText: payload.prompt,
        requestId: request.id,
        serviceType: suggestion.serviceType,
        sensitiveValues: selectedCustomer
          ? [selectedCustomer.fullName, selectedCustomer.email, selectedCustomer.phone]
          : [],
        model: suggestion.model,
        telemetry: aiTelemetry,
        trace: buildAiUsageTraceFromInsight(insight, {
          serviceType: suggestion.serviceType,
          retryApplied: guardrailRetryApplied,
        }),
        retrievalAuditEventId: governedRetrieval?.auditEventId ?? null,
      });
      aiRunId = aiUsageEvent.id;
    } catch (eventErr) {
      request.log.error(
        { err: eventErr },
        "[quotes/ai-suggest] failed to persist AI usage event; returning suggestion anyway",
      );
    }

      stream.write({
        type: "complete",
        result: {
          customer: selectedCustomer,
          parsed: {
            customerName: parsedDraft.customerName,
            customerPhone: parsedDraft.customerPhone,
            customerEmail: parsedDraft.customerEmail,
            serviceType: suggestion.serviceType,
            squareFeetEstimate: parsedDraft.squareFeetEstimate,
            squareFeetVariancePercent: parsedDraft.squareFeetVariancePercent,
            squareFeetEstimateLow: parsedDraft.squareFeetEstimateLow,
            squareFeetEstimateHigh: parsedDraft.squareFeetEstimateHigh,
            estimatedTotalAmount: parsedDraft.estimatedTotalAmount,
          },
          suggestion,
          patch,
          insight,
          aiRunId,
          usage: buildAiUsageResponse(snapshot, {
            consumedCredits: 1,
            consumedSpendUsd: aiTelemetry.estimatedCostUsd,
          }),
        },
      });
      stream.end();
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed applying AI suggestion.";
      try {
        stream.write({ type: "error", error: message });
      } finally {
        stream.end();
      }
      request.log.error({ err }, "[quotes/ai-suggest] streamed AI suggestion failed");
      return reply;
    }
  });

  app.post("/quotes/chat-draft", { preHandler: [app.authenticate] }, async (request, reply) => {
    CreateQuoteFromChatSchema.parse(request.body);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "useAiQuoteDrafting")) {
      return reply.code(403).send({ error: "AI quote drafting is not enabled for this role." });
    }
    return reply.code(410).send({
      code: "REVIEW_REQUIRED",
      error:
        "Chat to Quote now opens the quote builder review flow. Generate the AI draft in the builder, review every customer, scope, cost, price, and line item, then click Create Quote.",
    });
  });

  app.post("/quotes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const recordScope = assignedRecordScope(access);
    const totalAmount = calculateQuoteTotal(payload.customerPriceSubtotal, payload.taxAmount);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const periodStart = startOfCurrentUtcMonth();
    const periodEnd = startOfNextUtcMonth();
    const [monthlyQuoteCount, customer, actor] = await Promise.all([
      entitlements.limits.quotesPerMonth !== null
        ? app.prisma.quote.count({
            where: {
              tenantId: claims.tenantId,
              createdAt: {
                gte: periodStart,
                lt: periodEnd,
              },
            },
          })
        : Promise.resolve<number | null>(null),
      app.prisma.customer.findFirst({
        where: {
          id: payload.customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
          ...recordScope,
        },
        select: {
          id: true,
          assignedTenantUserId: true,
          preferredLocale: true,
          tenant: { select: { defaultCustomerLocale: true } },
        },
      }),
      resolveActivityActor(app.prisma, claims),
    ]);

    if (
      entitlements.limits.quotesPerMonth !== null &&
      monthlyQuoteCount !== null &&
      monthlyQuoteCount >= entitlements.limits.quotesPerMonth
    ) {
      const requiredPlan =
        entitlements.planCode === "starter" ? "professional" : "enterprise";
      return reply.code(403).send({
        code: "PLAN_LIMIT_EXCEEDED",
        error: `${entitlements.planName} allows up to ${entitlements.limits.quotesPerMonth} quotes per month.`,
        feature: "quotesPerMonth",
        currentPlan: entitlements.planCode,
        requiredPlan,
        limit: entitlements.limits.quotesPerMonth,
        used: monthlyQuoteCount,
      });
    }

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    const assignee = await resolveRequestedQuoteAssignee(
      app.prisma,
      access,
      payload.assignedTenantUserId,
      customer.assignedTenantUserId,
    );
    if (!assignee.allowed) {
      return reply.code(403).send({ error: "Choose an active member from this workspace." });
    }
    const resolvedLineItems = payload.lineItems
      ? await Promise.all(payload.lineItems.map(async (lineItem) => ({
          ...lineItem,
          unitCost: await resolveMemberLineUnitCost(app.prisma, {
            access,
            sourcePresetId: lineItem.sourcePresetId,
            requestedUnitCost: lineItem.unitCost,
          }),
        })))
      : [];
    const internalCostSubtotal = resolvedLineItems.length
      ? roundCurrency(resolvedLineItems.reduce((sum, lineItem) =>
          sum + (isIncludedQuoteLineSection(lineItem.sectionType) ? lineItem.quantity * lineItem.unitCost : 0), 0))
      : hasCapability(access, "viewInternalCosts")
        ? payload.internalCostSubtotal
        : 0;

    const quote = await app.prisma.$transaction(async (tx) => {
      if (
        assignee.assignedTenantUserId
        && !await lockActiveTenantAssignee(tx, {
          tenantId: claims.tenantId,
          tenantUserId: assignee.assignedTenantUserId,
        })
      ) {
        return null;
      }
      const createdQuote = await tx.quote.create({
        data: {
          tenantId: claims.tenantId,
          customerId: payload.customerId,
          assignedTenantUserId: assignee.assignedTenantUserId,
          serviceType: payload.serviceType,
          title: payload.title,
          scopeText: payload.scopeText,
          documentLocale: normalizeSupportedLocale(
            payload.documentLocale ??
              customer.preferredLocale ??
              customer.tenant.defaultCustomerLocale,
          ),
          internalCostSubtotal,
          customerPriceSubtotal: payload.customerPriceSubtotal,
          taxAmount: payload.taxAmount,
          totalAmount,
        },
      });

      if (payload.aiUsageEventId) {
        await tx.aiUsageEvent.updateMany({
          where: {
            id: payload.aiUsageEventId,
            tenantId: claims.tenantId,
            deletedAtUtc: null,
            quoteId: null,
          },
          data: {
            quoteId: createdQuote.id,
            customerId: payload.customerId,
          },
        });
      }

      if (resolvedLineItems.length) {
        await tx.quoteLineItem.createMany({
          data: resolvedLineItems.map((lineItem, position) => ({
            tenantId: claims.tenantId,
            quoteId: createdQuote.id,
            description: lineItem.description,
            sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
            sectionLabel: lineItem.sectionLabel?.trim() || null,
            position,
            quantity: lineItem.quantity,
            unitCost: lineItem.unitCost,
            unitPrice: lineItem.unitPrice,
          })),
        });
      }

      await createQuoteRevision(tx, {
        tenantId: claims.tenantId,
        quoteId: createdQuote.id,
        eventType: "CREATED",
        actor,
        changedFields: [
          "customerId",
          "serviceType",
          "title",
          "scopeText",
          "internalCostSubtotal",
          "customerPriceSubtotal",
          "taxAmount",
          "totalAmount",
          ...(payload.lineItems?.length
            ? [
                "lineItems.description",
                "lineItems.sectionType",
                "lineItems.sectionLabel",
                "lineItems.quantity",
                "lineItems.unitCost",
                "lineItems.unitPrice",
              ]
            : []),
        ],
      });

      return createdQuote;
    });

    if (!quote) {
      return reply.code(409).send({
        code: "ASSIGNEE_INACTIVE",
        error: "That team member is no longer active. Choose another assignee.",
      });
    }

    return reply.code(201).send({ quote });
  });

  app.get("/quotes", { preHandler: [app.authenticate] }, async (request) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const query = ListQuotesQuerySchema.parse(request.query);
    const quoteIdSearch = query.search?.replace(/^QF-/i, "");

    const summaryWhere: Prisma.QuoteWhereInput = {
      ...tenantActiveQuoteScope(claims.tenantId),
      ...assignedRecordScope(access),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.search
        ? {
            OR: [
              ...(quoteIdSearch ? [{ id: { contains: quoteIdSearch, mode: "insensitive" as const } }] : []),
              { title: { contains: query.search, mode: "insensitive" } },
              { scopeText: { contains: query.search, mode: "insensitive" } },
              { customer: { fullName: { contains: query.search, mode: "insensitive" } } },
              { customer: { phone: { contains: query.search } } },
              { customer: { email: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const where: Prisma.QuoteWhereInput = query.stage
      ? { AND: [summaryWhere, quoteLifecycleWhere(query.stage)] }
      : summaryWhere;

    const [quotes, total, statusGroups, invoicedCount] = await measureRequestPerformance(request, "db", () => app.prisma.$transaction([
      app.prisma.quote.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: query.limit,
        skip: query.offset,
        include: {
          assignedTenantUser: { select: WorkspaceAssigneeSelect },
          customer: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              followUpStatus: true,
              followUpUpdatedAtUtc: true,
              createdAt: true,
              updatedAt: true,
              tenantId: true,
            },
          },
          quickBooksInvoiceSyncs: {
            where: {
              deletedAtUtc: null,
            },
            orderBy: [
              { syncedAtUtc: "desc" },
              { createdAt: "desc" },
            ],
            take: 1,
            select: {
              id: true,
              quickBooksInvoiceId: true,
              quickBooksDocNumber: true,
              status: true,
              syncedAtUtc: true,
              lastAttemptedAtUtc: true,
              lastError: true,
            },
          },
        },
      }),
      app.prisma.quote.count({ where }),
      app.prisma.quote.groupBy({
        by: ["status"],
        where: summaryWhere,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      app.prisma.quote.count({
        where: {
          AND: [summaryWhere, quoteLifecycleWhere("INVOICED")],
        },
      }),
    ]));

    const statusSummary = new Map(statusGroups.map((group) => [group.status, {
      count: group._count._all,
      amount: Number(group._sum.totalAmount ?? 0),
    }]));
    const acceptedCount = statusSummary.get("ACCEPTED")?.count ?? 0;

    return {
      quotes,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      summary: {
        stageCounts: {
          DRAFT: statusSummary.get("DRAFT")?.count ?? 0,
          READY: statusSummary.get("READY_FOR_REVIEW")?.count ?? 0,
          SENT: statusSummary.get("SENT_TO_CUSTOMER")?.count ?? 0,
          ACCEPTED: Math.max(0, acceptedCount - invoicedCount),
          DECLINED: statusSummary.get("REJECTED")?.count ?? 0,
          INVOICED: invoicedCount,
        },
        readyToSendCount: statusSummary.get("READY_FOR_REVIEW")?.count ?? 0,
        awaitingResponseCount: statusSummary.get("SENT_TO_CUSTOMER")?.count ?? 0,
        awaitingResponseAmount: statusSummary.get("SENT_TO_CUSTOMER")?.amount ?? 0,
        acceptedAmount: statusSummary.get("ACCEPTED")?.amount ?? 0,
      },
    };
  });

  app.post("/quotes/invoices/export-csv", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const payload = ExportQuickBooksInvoicesCsvSchema.parse(request.body);
    const quoteIds = Array.from(new Set(payload.quoteIds));

    const quotes = await app.prisma.quote.findMany({
      where: {
        id: { in: quoteIds },
        ...tenantActiveQuoteScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      include: {
        customer: {
          select: {
            fullName: true,
            email: true,
            phone: true,
          },
        },
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: {
            description: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    });

    if (quotes.length === 0) {
      return reply.code(404).send({ error: "No matching quotes found for tenant." });
    }

    if (quotes.length !== quoteIds.length) {
      const foundIds = new Set(quotes.map((quote) => quote.id));
      const missingQuoteIds = quoteIds.filter((quoteId) => !foundIds.has(quoteId));
      return reply.code(404).send({
        error: `${missingQuoteIds.length} selected quote(s) were not found for tenant.`,
        missingQuoteIds,
      });
    }

    const quotesById = new Map(quotes.map((quote) => [quote.id, quote]));
    const orderedQuotes = quoteIds
      .map((quoteId) => quotesById.get(quoteId))
      .filter((quote): quote is NonNullable<typeof quote> => Boolean(quote));

    const csv = buildQuickBooksInvoiceCsv(
      orderedQuotes.map((quote) => ({
        id: quote.id,
        title: quote.title,
        serviceType: quote.serviceType,
        status: quote.status,
        scopeText: quote.scopeText,
        customerPriceSubtotal: Number(quote.customerPriceSubtotal),
        taxAmount: Number(quote.taxAmount),
        totalAmount: Number(quote.totalAmount),
        createdAt: quote.createdAt,
        sentAt: quote.sentAt,
        customer: {
          fullName: quote.customer.fullName,
          email: quote.customer.email,
          phone: quote.customer.phone,
        },
        lineItems: quote.lineItems.map((lineItem) => ({
          description: lineItem.description,
          quantity: Number(lineItem.quantity),
          unitPrice: Number(lineItem.unitPrice),
        })),
      })),
      {
        dueInDays: payload.dueInDays,
        exportedAt: new Date(),
      },
    );

    const fileDate = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Disposition",
      `attachment; filename="quotefly-quickbooks-invoices-${fileDate}.csv"`,
    );

    return reply.send(csv);
  });

  app.get("/quotes/history", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const query = QuoteHistoryQuerySchema.parse(request.query);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    if (!entitlements.features.quoteVersionHistory) {
      return reply.code(403).send({
        code: "PLAN_FEATURE_REQUIRED",
        feature: "quoteVersionHistory",
        currentPlan: entitlements.planCode,
        requiredPlan: requiredPlanForFeature("quoteVersionHistory"),
        error: "Quote revision history is available on Professional and Enterprise plans.",
      });
    }

    const historyWindowStart =
      entitlements.limits.quoteHistoryDays === null
        ? null
        : new Date(Date.now() - entitlements.limits.quoteHistoryDays * 24 * 60 * 60 * 1000);

    if (query.customerId) {
      const customer = await app.prisma.customer.findFirst({
        where: {
          id: query.customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true },
      });

      if (!customer) {
        return reply.code(404).send({ error: "Customer not found for tenant." });
      }
    }

    if (query.quoteId) {
      const quote = await app.prisma.quote.findFirst({
        where: {
          id: query.quoteId,
          ...tenantActiveQuoteScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true },
      });

      if (!quote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }
    }

    const where: Prisma.QuoteRevisionWhereInput = {
      ...tenantActiveScope(claims.tenantId),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.quoteId ? { quoteId: query.quoteId } : {}),
      ...(!hasCapability(access, "viewAllWorkspaceRecords")
        ? { quote: { assignedTenantUserId: access.tenantUserId } }
        : {}),
      ...(historyWindowStart ? { createdAt: { gte: historyWindowStart } } : {}),
    };

    const [revisions, total] = await app.prisma.$transaction([
      app.prisma.quoteRevision.findMany({
        where,
        select: QuoteRevisionListSelect,
        orderBy: [{ createdAt: "desc" }, { version: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      app.prisma.quoteRevision.count({ where }),
    ]);

    return {
      revisions,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      policy: {
        quoteHistoryDays: entitlements.limits.quoteHistoryDays,
      },
    };
  });

  app.get("/quotes/:quoteId/history", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const query = QuoteHistoryByQuoteQuerySchema.parse(request.query);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    if (!entitlements.features.quoteVersionHistory) {
      return reply.code(403).send({
        code: "PLAN_FEATURE_REQUIRED",
        feature: "quoteVersionHistory",
        currentPlan: entitlements.planCode,
        requiredPlan: requiredPlanForFeature("quoteVersionHistory"),
        error: "Quote revision history is available on Professional and Enterprise plans.",
      });
    }

    const historyWindowStart =
      entitlements.limits.quoteHistoryDays === null
        ? null
        : new Date(Date.now() - entitlements.limits.quoteHistoryDays * 24 * 60 * 60 * 1000);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      select: { id: true },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    const where: Prisma.QuoteRevisionWhereInput = {
      quoteId: quote.id,
      ...tenantActiveScope(claims.tenantId),
      ...(!hasCapability(access, "viewAllWorkspaceRecords")
        ? {
            quote: {
              ...tenantActiveQuoteScope(claims.tenantId),
              assignedTenantUserId: access.tenantUserId,
            },
          }
        : {}),
      ...(historyWindowStart ? { createdAt: { gte: historyWindowStart } } : {}),
    };

    const [revisions, total] = await app.prisma.$transaction([
      app.prisma.quoteRevision.findMany({
        where,
        select: QuoteRevisionListSelect,
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      app.prisma.quoteRevision.count({ where }),
    ]);

    return {
      revisions,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      policy: {
        quoteHistoryDays: entitlements.limits.quoteHistoryDays,
      },
    };
  });

  app.get("/quotes/:quoteId/ai-runs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const query = QuoteAiRunsByQuoteQuerySchema.parse(request.query);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(access.tenantId),
        ...assignedRecordScope(access),
      },
      select: { id: true },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    const where: Prisma.AiUsageEventWhereInput = {
      tenantId: access.tenantId,
      quoteId: quote.id,
      deletedAtUtc: null,
      ...(!hasCapability(access, "viewAiRunAudit")
        ? { actorUserId: access.userId }
        : {}),
    };

    const [runs, total] = await app.prisma.$transaction([
      app.prisma.aiUsageEvent.findMany({
        where,
        select: AiUsageTraceSelect,
        orderBy: { createdAt: "desc" },
        take: query.limit,
        skip: query.offset,
      }),
      app.prisma.aiUsageEvent.count({ where }),
    ]);

    return {
      runs: runs.map((run) => ({
        id: run.id,
        quoteId: run.quoteId,
        customerId: run.customerId,
        actorUserId: run.actorUserId,
        actorEmail: run.actorEmail,
        actorName: run.actorName,
        eventType: run.eventType,
        purpose: run.purpose,
        classification: run.classification,
        serviceType: run.serviceType,
        creditsConsumed: run.creditsConsumed,
        requestCount: run.requestCount,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        totalTokens: run.totalTokens,
        ...(hasCapability(access, "viewInternalCosts")
          ? {
              estimatedCostUsd:
                run.estimatedCostUsd === null || run.estimatedCostUsd === undefined
                  ? null
                  : Number(run.estimatedCostUsd),
            }
          : {}),
        promptRedacted: run.promptRedacted,
        model: run.model,
        insightSummary: run.insightSummary,
        insightReasons: run.insightReasons,
        insightSourceLabels: run.insightSourceLabels,
        confidenceLevel: run.confidenceLevel,
        confidenceLabel: run.confidenceLabel,
        riskNote: run.riskNote,
        patchAdded: run.patchAdded,
        patchUpdated: run.patchUpdated,
        patchRemoved: run.patchRemoved,
        sourceCount: run.sourceCount,
        createdAt: run.createdAt,
      })),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
    };
  });

  app.post(
    "/quotes/:quoteId/history/:revisionId/restore",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      if (!hasCapability(access, "manageRecordRetention")) {
        return reply.code(403).send({ error: "Only a workspace owner or admin can restore quote revisions." });
      }
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId, revisionId } = QuoteRevisionParamsSchema.parse(request.params);
      const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
        userEmail: claims.email,
      });

      if (!entitlements) {
        return reply.code(404).send({ error: "Tenant not found for account." });
      }

      if (!entitlements.features.quoteVersionHistory) {
        return reply.code(403).send({
          code: "PLAN_FEATURE_REQUIRED",
          feature: "quoteVersionHistory",
          currentPlan: entitlements.planCode,
          requiredPlan: requiredPlanForFeature("quoteVersionHistory"),
          error: "Restoring a quote revision is available on Professional and Enterprise plans.",
        });
      }

      const authorizedQuote = await app.prisma.quote.findFirst({
        where: {
          id: quoteId,
          ...tenantActiveQuoteScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true },
      });
      if (!authorizedQuote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      let result: Awaited<ReturnType<typeof restoreQuoteRevision>>;
      try {
        result = await app.prisma.$transaction((tx) =>
          restoreQuoteRevision(tx, {
            tenantId: claims.tenantId,
            quoteId,
            revisionId,
            actor,
          }),
        );
      } catch (error) {
        if (error instanceof JobServiceError) {
          return reply.code(error.statusCode).send({ code: error.code, error: error.message });
        }
        throw error;
      }

      if (result.status === "quote_missing") {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      if (result.status === "revision_missing") {
        return reply.code(404).send({ error: "Revision not found for quote." });
      }

      if (result.status === "snapshot_invalid") {
        return reply.code(409).send({ error: "The selected revision could not be restored." });
      }

      if (result.status === "customer_missing") {
        return reply.code(409).send({
          error: "The customer referenced by that revision is no longer active, so the revision cannot be restored.",
        });
      }

      const restoredQuote = await app.prisma.quote.findFirst({
        where: {
          id: quoteId,
          ...tenantActiveQuoteScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        include: {
          customer: true,
          lineItems: {
            where: tenantActiveScope(claims.tenantId),
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          },
        },
      });

      if (!restoredQuote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      return reply.send({
        message: "Quote restored from revision history.",
        quote: restoredQuote,
      });
    },
  );

  app.get("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      include: {
        assignedTenantUser: { select: WorkspaceAssigneeSelect },
        customer: true,
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            tenantId: true,
            quoteId: true,
            description: true,
            sectionType: true,
            sectionLabel: true,
            quantity: true,
            unitCost: true,
            unitPrice: true,
            createdAt: true,
            deletedAtUtc: true,
          },
        },
      },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    return { quote };
  });

  app.get("/quotes/:quoteId/pdf", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const query = QuotePdfQuerySchema.parse(request.query);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
      include: {
        customer: true,
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        },
        revisions: {
          where: {
            ...tenantActiveScope(claims.tenantId),
            status: "SENT_TO_CUSTOMER",
            changedFields: { has: "documentSnapshot" },
          },
          orderBy: { version: "desc" },
          take: 1,
          select: { snapshot: true },
        },
        tenant: {
          select: {
            name: true,
            timezone: true,
            branding: {
              select: {
                templateId: true,
                primaryColor: true,
                logoUrl: true,
                logoPosition: true,
                hideQuoteFlyAttribution: true,
                businessEmail: true,
                businessPhone: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
                postalCode: true,
                componentColors: true,
              },
            },
          },
        },
      },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });
    const parsedSentSnapshot = quote.revisions[0]
      ? RevisionSnapshotSchema.safeParse(quote.revisions[0].snapshot)
      : null;
    const sentSnapshot =
      quote.sentAt &&
      quote.status !== "DRAFT" &&
      quote.status !== "READY_FOR_REVIEW" &&
      parsedSentSnapshot?.success &&
      parsedSentSnapshot.data.document
        ? parsedSentSnapshot.data
        : null;
    const currentComponentColors =
      (quote.tenant.branding?.componentColors as QuoteComponentColors | null | undefined) ?? null;
    const currentBranding: QuotePdfData["branding"] = {
      templateId: quote.tenant.branding?.templateId ?? "modern",
      primaryColor: quote.tenant.branding?.primaryColor ?? "#5B85AA",
      logoUrl: quote.tenant.branding?.logoUrl ?? null,
      logoPosition:
        quote.tenant.branding?.logoPosition === "center" || quote.tenant.branding?.logoPosition === "right"
          ? quote.tenant.branding.logoPosition
          : "left",
      showQuoteFlyAttribution:
        (entitlements?.planCode ?? "starter") === "starter"
          ? true
          : !Boolean(quote.tenant.branding?.hideQuoteFlyAttribution),
      businessEmail: quote.tenant.branding?.businessEmail ?? null,
      businessPhone: quote.tenant.branding?.businessPhone ?? null,
      addressLine1: quote.tenant.branding?.addressLine1 ?? null,
      addressLine2: quote.tenant.branding?.addressLine2 ?? null,
      city: quote.tenant.branding?.city ?? null,
      state: quote.tenant.branding?.state ?? null,
      postalCode: quote.tenant.branding?.postalCode ?? null,
      componentColors: currentComponentColors,
    };
    const pdfQuote = sentSnapshot?.quote;
    const pdfCustomer = sentSnapshot?.customer;
    const pdfLineItems = sentSnapshot?.lineItems;
    let sentSnapshotBranding: QuotePdfData["branding"] | undefined;
    if (sentSnapshot?.document) {
      try {
        sentSnapshotBranding = await resolveRevisionDocumentBranding(
          app.prisma,
          claims.tenantId,
          sentSnapshot.document,
        );
      } catch (error) {
        if (!(error instanceof QuoteBrandAssetUnavailableError)) throw error;
        request.log.error(
          { quoteId: quote.id, tenantId: claims.tenantId },
          "Stored quote branding asset could not be resolved",
        );
        return reply.code(500).send({ error: "Stored quote branding asset is unavailable." });
      }
    }

    const pdfBuffer = await generateQuotePdfBuffer({
      quoteId: quote.id,
      documentLocale: normalizeSupportedLocale(
        sentSnapshot?.document?.locale ??
          pdfQuote?.documentLocale ??
          quote.documentLocale,
      ),
      serviceType: pdfQuote?.serviceType ?? quote.serviceType,
      status: pdfQuote?.status ?? quote.status,
      title: pdfQuote?.title ?? quote.title,
      scopeText: pdfQuote?.scopeText ?? quote.scopeText,
      createdAt: quote.createdAt,
      sentAt: pdfQuote?.sentAtUtc ? new Date(pdfQuote.sentAtUtc) : quote.sentAt,
      customerPriceSubtotal: pdfQuote?.customerPriceSubtotal ?? Number(quote.customerPriceSubtotal),
      taxAmount: pdfQuote?.taxAmount ?? Number(quote.taxAmount),
      totalAmount: pdfQuote?.totalAmount ?? Number(quote.totalAmount),
      customer: {
        fullName: pdfCustomer?.fullName ?? quote.customer.fullName,
        email: pdfCustomer?.email ?? quote.customer.email,
        phone: pdfCustomer?.phone ?? quote.customer.phone,
      },
      tenant: sentSnapshot?.document?.tenant ?? {
        name: quote.tenant.name,
        timezone: quote.tenant.timezone,
      },
      branding: sentSnapshotBranding ?? currentBranding,
      lineItems: (pdfLineItems ?? quote.lineItems).map((lineItem) => ({
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel,
        quantity: Number(lineItem.quantity),
        unitPrice: Number(lineItem.unitPrice),
      })),
    });

    const label = safeFileLabel(quote.title || `quote-${quote.id.slice(0, 8)}`);
    reply.header("Content-Type", "application/pdf");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Disposition",
      `${query.download ? "attachment" : "inline"}; filename="${label}.pdf"`,
    );

    return reply.send(pdfBuffer);
  });

  app.patch("/quotes/:quoteId/sheet", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const payload = SaveQuoteSheetSchema.parse(request.body);

    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const existingQuote = await lockActiveQuoteForMutation(tx, {
          quoteId,
          tenantId: claims.tenantId,
          assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
        });
        if (!existingQuote) return null;

        if (
          payload.quote.documentLocale !== undefined &&
          payload.quote.documentLocale !== existingQuote.documentLocale &&
          !canEditQuoteDocumentLocale(existingQuote.status)
        ) {
          throw new QuoteDocumentLocaleLockedError();
        }

        await assertAcceptedQuoteJobMutationAllowed(tx, {
          tenantId: claims.tenantId,
          quoteId: existingQuote.id,
          existingQuote,
          payload: payload.quote,
          lineItemsChanged: payload.lineItems.length > 0 || payload.newLineItems.length > 0,
        });

        const lifecycleUpdate = resolveLifecycleUpdate(existingQuote, payload.quote);
        const followUpStatusUpdate = mapQuoteStatusToFollowUpStatus(payload.quote.status);
        const updatedQuote = await tx.quote.update({
          where: { id: existingQuote.id },
          data: {
            serviceType: payload.quote.serviceType,
            status: payload.quote.status,
            title: payload.quote.title,
            scopeText: payload.quote.scopeText,
            documentLocale: payload.quote.documentLocale,
            taxAmount: payload.quote.taxAmount,
            sentAt:
              payload.quote.status === "SENT_TO_CUSTOMER"
                ? existingQuote.sentAt ?? new Date()
                : payload.quote.status === "DRAFT" || payload.quote.status === "READY_FOR_REVIEW"
                  ? null
                  : existingQuote.sentAt,
            ...lifecycleUpdate.data,
          },
        });

        const existingLineCosts = hasCapability(access, "viewInternalCosts")
          ? new Map<string, number>()
          : new Map((await tx.quoteLineItem.findMany({
              where: {
                quoteId: existingQuote.id,
                ...tenantActiveScope(claims.tenantId),
              },
              select: { id: true, unitCost: true },
            })).map((line) => [line.id, Number(line.unitCost)]));
        const lineItems = await Promise.all(payload.lineItems.map(async (line) => ({
          ...line,
          unitCost: hasCapability(access, "viewInternalCosts")
            ? line.unitCost
            : existingLineCosts.get(line.id) ?? 0,
        })));
        const newLineItems = await Promise.all(payload.newLineItems.map(async (line) => ({
          ...line,
          unitCost: await resolveMemberLineUnitCost(tx, {
            access,
            sourcePresetId: line.sourcePresetId,
            requestedUnitCost: line.unitCost,
          }),
        })));
        await applyQuoteSheetLineMutations(tx, {
          tenantId: claims.tenantId,
          quoteId: updatedQuote.id,
          updates: lineItems,
          creates: newLineItems,
        });

        const recalculatedQuote = await recalculateQuoteFromLineItems(tx, updatedQuote.id, claims.tenantId);
        if (!recalculatedQuote) return null;

        const lineFields =
          payload.lineItems.length > 0 || payload.newLineItems.length > 0
            ? [
                "lineItems",
                "internalCostSubtotal",
                "customerPriceSubtotal",
                "totalAmount",
              ]
            : ["totalAmount"];
        await createQuoteRevision(tx, {
          tenantId: claims.tenantId,
          quoteId: recalculatedQuote.id,
          eventType:
            payload.quote.status !== existingQuote.status ||
            payload.quote.jobStatus !== existingQuote.jobStatus ||
            payload.quote.afterSaleFollowUpStatus !== existingQuote.afterSaleFollowUpStatus
              ? "STATUS_CHANGED"
              : payload.lineItems.length > 0 || payload.newLineItems.length > 0
                ? "LINE_ITEM_CHANGED"
                : "UPDATED",
          actor,
          changedFields: Array.from(
            new Set([
              ...quoteChangedFields(payload.quote),
              ...lifecycleUpdate.changedFields,
              "sentAt",
              ...lineFields,
            ]),
          ),
        });

        if (followUpStatusUpdate) {
          await tx.customer.updateMany({
            where: {
              id: recalculatedQuote.customerId,
              ...tenantActiveCustomerScope(claims.tenantId),
            },
            data: {
              followUpStatus: followUpStatusUpdate,
              followUpUpdatedAtUtc: new Date(),
            },
          });
        }

        await markQuoteAiRetrievalSourcesDeleted(tx, {
          tenantId: claims.tenantId,
          quoteIds: [recalculatedQuote.id],
        });

        let acceptedJob: JobPublic | null = null;
        if (recalculatedQuote.status === "ACCEPTED") {
          acceptedJob = await ensureJobForAcceptedQuote(tx, access, {
            quoteId: recalculatedQuote.id,
            actorTenantUserId: access.tenantUserId,
            requestId: request.id,
          });
        }

        const quote = await tx.quote.findFirst({
          where: {
            id: recalculatedQuote.id,
            ...tenantActiveQuoteScope(claims.tenantId),
          },
          include: {
            customer: true,
            lineItems: {
              where: tenantActiveScope(claims.tenantId),
              orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            },
          },
        });
        return {
          quote,
          job: serializeAcceptedJobSummary(acceptedJob),
        };
      });

      if (!result?.quote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      return reply.send({ quote: result.quote, job: result.job });
    } catch (error) {
      if (error instanceof QuoteSheetLineNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof QuoteDocumentLocaleLockedError) {
        return reply.code(409).send({
          code: "QUOTE_DOCUMENT_LOCALE_LOCKED",
          error: error.message,
        });
      }
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send({ code: error.code, error: error.message });
      }
      throw error;
    }
  });

  app.patch("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const payload = UpdateQuoteSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);

    const existingQuote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
        ...assignedRecordScope(access),
      },
    });

    if (!existingQuote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    if (payload.customerId) {
      const customer = await app.prisma.customer.findFirst({
        where: {
          id: payload.customerId,
          ...tenantActiveCustomerScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true },
      });

      if (!customer) {
        return reply.code(404).send({ error: "Customer not found for tenant." });
      }
    }

    if (
      payload.documentLocale !== undefined &&
      payload.documentLocale !== existingQuote.documentLocale &&
      !canEditQuoteDocumentLocale(existingQuote.status)
    ) {
      return reply.code(409).send({
        code: "QUOTE_DOCUMENT_LOCALE_LOCKED",
        error: "Customer document language cannot change after the quote has been sent.",
      });
    }

    const assignee = payload.assignedTenantUserId !== undefined
      ? await resolveRequestedQuoteAssignee(
          app.prisma,
          access,
          payload.assignedTenantUserId,
          existingQuote.assignedTenantUserId,
        )
      : null;
    if (assignee && !assignee.allowed) {
      return reply.code(403).send({ error: "Choose an active member from this workspace." });
    }

    let result: { quote: typeof existingQuote; job: AcceptedJobSummary | null } | null;
    let inactiveAssignee = false;
    try {
      result = await app.prisma.$transaction(async (tx) => {
        if (
          assignee?.assignedTenantUserId
          && !await lockActiveTenantAssignee(tx, {
            tenantId: claims.tenantId,
            tenantUserId: assignee.assignedTenantUserId,
          })
        ) {
          inactiveAssignee = true;
          return null;
        }

        const lockedQuote = await lockActiveQuoteForMutation(tx, {
          quoteId: existingQuote.id,
          tenantId: claims.tenantId,
          assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
        });
        if (!lockedQuote) return null;

        if (
          payload.documentLocale !== undefined &&
          payload.documentLocale !== lockedQuote.documentLocale &&
          !canEditQuoteDocumentLocale(lockedQuote.status)
        ) {
          throw new QuoteDocumentLocaleLockedError();
        }

        await assertAcceptedQuoteJobMutationAllowed(tx, {
          tenantId: claims.tenantId,
          quoteId: lockedQuote.id,
          existingQuote: lockedQuote,
          payload,
        });

        const nextCustomerPriceSubtotal =
          payload.customerPriceSubtotal ?? Number(lockedQuote.customerPriceSubtotal);
        const nextTaxAmount = payload.taxAmount ?? Number(lockedQuote.taxAmount);

        const shouldRecalculateTotal =
          payload.customerPriceSubtotal !== undefined || payload.taxAmount !== undefined;
        const lifecycleUpdate = resolveLifecycleUpdate(lockedQuote, payload);

        const revisionChangedFields = [
          ...quoteChangedFields(payload),
          ...(shouldRecalculateTotal ? ["totalAmount"] : []),
          ...lifecycleUpdate.changedFields,
          ...(payload.status ? ["sentAt"] : []),
        ];
        const revisionEventType: QuoteRevisionEventType =
          payload.status !== undefined || payload.jobStatus !== undefined || payload.afterSaleFollowUpStatus !== undefined
            ? "STATUS_CHANGED"
            : "UPDATED";
        const followUpStatusUpdate = mapQuoteStatusToFollowUpStatus(payload.status);

        const updateData: Prisma.QuoteUncheckedUpdateInput = {
          ...(payload.customerId ? { customerId: payload.customerId } : {}),
          serviceType: payload.serviceType,
          status: payload.status,
          title: payload.title,
          scopeText: payload.scopeText,
          documentLocale: payload.documentLocale,
          internalCostSubtotal: hasCapability(access, "viewInternalCosts")
            ? payload.internalCostSubtotal
            : undefined,
          customerPriceSubtotal: payload.customerPriceSubtotal,
          taxAmount: payload.taxAmount,
          ...(shouldRecalculateTotal
            ? { totalAmount: calculateQuoteTotal(nextCustomerPriceSubtotal, nextTaxAmount) }
            : {}),
          ...(payload.status
            ? {
                sentAt:
                  payload.status === "SENT_TO_CUSTOMER"
                    ? lockedQuote.sentAt ?? new Date()
                    : payload.status === "DRAFT" || payload.status === "READY_FOR_REVIEW"
                      ? null
                      : lockedQuote.sentAt,
              }
            : {}),
          ...lifecycleUpdate.data,
          ...(assignee ? { assignedTenantUserId: assignee.assignedTenantUserId } : {}),
        };

        const updatedQuote = await tx.quote.update({
          where: { id: lockedQuote.id },
          data: updateData,
        });

        await createQuoteRevision(tx, {
          tenantId: claims.tenantId,
          quoteId: updatedQuote.id,
          eventType: revisionEventType,
          actor,
          changedFields: Array.from(new Set(revisionChangedFields)),
        });

        if (followUpStatusUpdate) {
          await tx.customer.updateMany({
            where: {
              id: updatedQuote.customerId,
              ...tenantActiveCustomerScope(claims.tenantId),
            },
            data: {
              followUpStatus: followUpStatusUpdate,
              followUpUpdatedAtUtc: new Date(),
            },
          });
        }

        await markQuoteAiRetrievalSourcesDeleted(tx, {
          tenantId: claims.tenantId,
          quoteIds: [updatedQuote.id],
        });

        let acceptedJob: JobPublic | null = null;
        if (updatedQuote.status === "ACCEPTED") {
          acceptedJob = await ensureJobForAcceptedQuote(tx, access, {
            quoteId: updatedQuote.id,
            actorTenantUserId: access.tenantUserId,
            requestId: request.id,
          });
        }

        return {
          quote: updatedQuote,
          job: serializeAcceptedJobSummary(acceptedJob),
        };
      });
    } catch (error) {
      if (error instanceof QuoteDocumentLocaleLockedError) {
        return reply.code(409).send({
          code: "QUOTE_DOCUMENT_LOCALE_LOCKED",
          error: error.message,
        });
      }
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send({ code: error.code, error: error.message });
      }
      throw error;
    }

    if (!result) {
      if (!inactiveAssignee) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }
      return reply.code(409).send({
        code: "ASSIGNEE_INACTIVE",
        error: "That team member is no longer active. Choose another assignee.",
      });
    }

    return result;
  });

  app.delete("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageRecordRetention")) {
      return reply.code(403).send({ error: "Only a workspace owner or admin can delete quotes." });
    }
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const now = new Date();

    const deleted = await withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
      const assignedTenantUserId = assignedRecordScope(access).assignedTenantUserId;
      const lockedQuote = await lockActiveQuoteForRetention(tx, {
        quoteId,
        tenantId: claims.tenantId,
        assignedTenantUserId,
      });
      if (!lockedQuote) return { kind: "not_found" as const };
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId, assignedTenantUserId);
      if (!quote) return { kind: "not_found" as const };

      const activeTaskCount = await tx.activityTask.count({
        where: {
          tenantId: claims.tenantId,
          quoteId: quote.id,
          deletedAtUtc: null,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      });
      if (activeTaskCount > 0) {
        return { kind: "active_tasks" as const, activeTaskCount };
      }

      const activeJobCount = await countActiveJobsForQuote(tx, {
        tenantId: claims.tenantId,
        quoteId: quote.id,
      });
      if (activeJobCount > 0) {
        return { kind: "active_jobs" as const, activeJobCount };
      }

      await createCustomerActivityEvent(tx, {
        tenantId: claims.tenantId,
        customerId: quote.customerId,
        actor,
        eventType: "QUOTE_DELETED",
        title: "Quote deleted",
        detail: `${quote.title} was removed from the active workspace but retained in history.`,
        metadata: {
          quoteId: quote.id,
          status: quote.status,
        },
      });

      await tx.quote.update({
        where: { id: quote.id },
        data: {
          archivedAtUtc: null,
          deletedAtUtc: now,
        },
      });

      await tx.quoteLineItem.updateMany({
        where: {
          quoteId: quote.id,
          ...tenantActiveScope(claims.tenantId),
        },
        data: { deletedAtUtc: now },
      });

      await tx.quoteDecisionSession.updateMany({
        where: {
          quoteId: quote.id,
          ...tenantActiveScope(claims.tenantId),
        },
        data: { deletedAtUtc: now },
      });

      await markQuoteAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        quoteIds: [quote.id],
        now,
      });
      await enqueueQuoteAiIndexJobs(tx, {
        tenantId: claims.tenantId,
        quoteId: quote.id,
        operation: "DELETE",
      });

      return { kind: "changed" as const };
    });

    if (deleted.kind === "not_found") {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }
    if (deleted.kind === "active_tasks") {
      return reply.code(409).send({
        code: "ACTIVE_ACTIVITY_TASKS",
        error: `Complete, cancel, or remove ${deleted.activeTaskCount} active task(s) before deleting this quote.`,
        activeTaskCount: deleted.activeTaskCount,
      });
    }
    if (deleted.kind === "active_jobs") {
      return reply.code(409).send({
        code: "ACTIVE_JOBS",
        error: `Complete or cancel ${deleted.activeJobCount} active job(s) before deleting this quote.`,
        activeJobCount: deleted.activeJobCount,
      });
    }

    return reply.code(204).send();
  });

  app.post("/quotes/:quoteId/archive", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    if (!hasCapability(access, "manageRecordRetention")) {
      return reply.code(403).send({ error: "Only a workspace owner or admin can archive quotes." });
    }
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const now = new Date();

    const archived = await withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
      const assignedTenantUserId = assignedRecordScope(access).assignedTenantUserId;
      const lockedQuote = await lockActiveQuoteForRetention(tx, {
        quoteId,
        tenantId: claims.tenantId,
        assignedTenantUserId,
      });
      if (!lockedQuote) return { kind: "not_found" as const };
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId, assignedTenantUserId);
      if (!quote) return { kind: "not_found" as const };

      const activeTaskCount = await tx.activityTask.count({
        where: {
          tenantId: claims.tenantId,
          quoteId: quote.id,
          deletedAtUtc: null,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      });
      if (activeTaskCount > 0) {
        return { kind: "active_tasks" as const, activeTaskCount };
      }

      const activeJobCount = await countActiveJobsForQuote(tx, {
        tenantId: claims.tenantId,
        quoteId: quote.id,
      });
      if (activeJobCount > 0) {
        return { kind: "active_jobs" as const, activeJobCount };
      }

      await createCustomerActivityEvent(tx, {
        tenantId: claims.tenantId,
        customerId: quote.customerId,
        actor,
        eventType: "QUOTE_ARCHIVED",
        title: "Quote archived",
        detail: `${quote.title} was archived and removed from the active workspace.`,
        metadata: {
          quoteId: quote.id,
          status: quote.status,
        },
      });

      await tx.quote.update({
        where: { id: quote.id },
        data: {
          archivedAtUtc: now,
          deletedAtUtc: null,
        },
      });

      await markQuoteAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        quoteIds: [quote.id],
        now,
      });
      await enqueueQuoteAiIndexJobs(tx, {
        tenantId: claims.tenantId,
        quoteId: quote.id,
        operation: "DELETE",
      });

      return { kind: "changed" as const };
    });

    if (archived.kind === "not_found") {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }
    if (archived.kind === "active_tasks") {
      return reply.code(409).send({
        code: "ACTIVE_ACTIVITY_TASKS",
        error: `Complete, cancel, or remove ${archived.activeTaskCount} active task(s) before archiving this quote.`,
        activeTaskCount: archived.activeTaskCount,
      });
    }
    if (archived.kind === "active_jobs") {
      return reply.code(409).send({
        code: "ACTIVE_JOBS",
        error: `Complete or cancel ${archived.activeJobCount} active job(s) before archiving this quote.`,
        activeJobCount: archived.activeJobCount,
      });
    }

    return reply.code(204).send();
  });

  app.post("/quotes/:quoteId/decision", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const { decision } = QuoteDecisionSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const actor = await resolveActivityActor(app.prisma, claims);

    const status = decision === "send" ? "SENT_TO_CUSTOMER" : "READY_FOR_REVIEW";
    const sentAt = decision === "send" ? new Date() : null;
    const decisionStatus = decision === "send" ? "APPROVED" : "REVISION_REQUESTED";

    let quote: Awaited<ReturnType<typeof getActiveQuoteForTenant>>;
    try {
      quote = await app.prisma.$transaction(async (tx) => {
      const existingQuote = await lockActiveQuoteForMutation(tx, {
        quoteId,
        tenantId: claims.tenantId,
        assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
      });
      if (!existingQuote) return null;
      await assertNoRetainedJobForQuote(tx, {
        tenantId: claims.tenantId,
        quoteId: existingQuote.id,
      });

      const updatedQuote = await tx.quote.update({
        where: { id: existingQuote.id },
        data: {
          status,
          sentAt,
        },
      });

      await tx.quoteDecisionSession.updateMany({
        where: {
          quoteId: existingQuote.id,
          ...tenantActiveScope(claims.tenantId),
          status: "AWAITING_APPROVAL",
        },
        data: {
          status: decisionStatus,
        },
      });

      await createQuoteRevision(tx, {
        tenantId: claims.tenantId,
        quoteId: updatedQuote.id,
        eventType: "DECISION",
        actor,
        changedFields: ["status", "sentAt", "decisionSession.status"],
      });

      if (decision === "send") {
        await tx.customer.updateMany({
          where: {
            id: updatedQuote.customerId,
            ...tenantActiveCustomerScope(claims.tenantId),
          },
          data: {
            followUpStatus: "NEEDS_FOLLOW_UP",
            followUpUpdatedAtUtc: new Date(),
          },
        });
      }

      return updatedQuote;
      });
    } catch (error) {
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send({ code: error.code, error: error.message });
      }
      throw error;
    }

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    return reply.send({
      quote,
      message:
        decision === "send"
          ? "Quote marked sent to customer"
          : "Quote marked for revision",
    });
  });

  app.get(
    "/quotes/:quoteId/outbound-events",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      const { quoteId } = QuoteParamsSchema.parse(request.params);
      const query = QuoteOutboundEventQuerySchema.parse(request.query);
      const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
        userEmail: claims.email,
      });

      if (!entitlements) {
        return reply.code(404).send({ error: "Tenant not found for account." });
      }

      if (!entitlements.features.communicationLog) {
        return reply.code(403).send({
          code: "PLAN_FEATURE_REQUIRED",
          feature: "communicationLog",
          currentPlan: entitlements.planCode,
          requiredPlan: requiredPlanForFeature("communicationLog"),
          error: "Communication logs are available on Professional and Enterprise plans.",
        });
      }

      const quote = await app.prisma.quote.findFirst({
        where: {
          id: quoteId,
          ...tenantActiveQuoteScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: { id: true },
      });

      if (!quote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      const where: Prisma.QuoteOutboundEventWhereInput = {
        quoteId: quote.id,
        ...tenantActiveScope(claims.tenantId),
      };

      const [events, total] = await app.prisma.$transaction([
        app.prisma.quoteOutboundEvent.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.limit,
          skip: query.offset,
        }),
        app.prisma.quoteOutboundEvent.count({ where }),
      ]);

      return {
        events,
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total,
        },
      };
    },
  );

  app.post(
    "/quotes/:quoteId/confirm-send",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId } = QuoteParamsSchema.parse(request.params);
      const payload = ConfirmQuoteSendSchema.parse(request.body);

      const findConfirmedSend = () =>
        app.prisma.quoteOutboundEvent.findFirst({
          where: {
            tenantId: claims.tenantId,
            idempotencyKey: payload.idempotencyKey,
          },
        });

      try {
        const result = await app.prisma.$transaction(async (tx) => {
          const existingEvent = await tx.quoteOutboundEvent.findFirst({
            where: {
              tenantId: claims.tenantId,
              idempotencyKey: payload.idempotencyKey,
            },
          });

          if (existingEvent) {
            if (existingEvent.quoteId !== quoteId) {
              return { conflict: true as const };
            }

            const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId, assignedRecordScope(access).assignedTenantUserId);
            return quote
              ? { quote, event: existingEvent, duplicate: true as const }
              : null;
          }

          const lockedQuote = await lockActiveQuoteForMutation(tx, {
            quoteId,
            tenantId: claims.tenantId,
            assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
          });
          if (!lockedQuote) return null;
          await assertNoRetainedJobForQuote(tx, {
            tenantId: claims.tenantId,
            quoteId: lockedQuote.id,
          });

          const existingQuote = await tx.quote.findFirst({
            where: { id: lockedQuote.id },
            include: {
              customer: {
                select: {
                  email: true,
                  phone: true,
                },
              },
            },
          });

          if (!existingQuote) return null;

          const sentAt = existingQuote.sentAt ?? new Date();
          const quote =
            existingQuote.status === "SENT_TO_CUSTOMER"
              ? existingQuote
              : await tx.quote.update({
                  where: { id: existingQuote.id },
                  data: {
                    status: "SENT_TO_CUSTOMER",
                    sentAt,
                  },
                });

          if (existingQuote.status !== "SENT_TO_CUSTOMER") {
            await tx.quoteDecisionSession.updateMany({
              where: {
                quoteId: existingQuote.id,
                ...tenantActiveScope(claims.tenantId),
                status: "AWAITING_APPROVAL",
              },
              data: { status: "APPROVED" },
            });

            await createQuoteRevision(tx, {
              tenantId: claims.tenantId,
              quoteId: quote.id,
              eventType: "DECISION",
              actor,
              changedFields: ["status", "sentAt", "decisionSession.status"],
            });

            await tx.customer.updateMany({
              where: {
                id: quote.customerId,
                ...tenantActiveCustomerScope(claims.tenantId),
              },
              data: {
                followUpStatus: "NEEDS_FOLLOW_UP",
                followUpUpdatedAtUtc: new Date(),
              },
            });
          }

          const destination =
            payload.destination ??
            (payload.channel === "EMAIL_APP"
              ? existingQuote.customer.email ?? undefined
              : payload.channel === "SMS_APP"
                ? existingQuote.customer.phone
                : undefined);

          const event = await tx.quoteOutboundEvent.create({
            data: {
              tenantId: claims.tenantId,
              quoteId: quote.id,
              customerId: quote.customerId,
              actorUserId: actor.actorUserId,
              actorEmail: actor.actorEmail,
              actorName: actor.actorName,
              channel: payload.channel as QuoteOutboundChannel,
              destination,
              subject: payload.subject,
              bodyPreview: payload.body?.slice(0, 500),
              idempotencyKey: payload.idempotencyKey,
            },
          });

          return { quote, event, duplicate: false as const };
        });

        if (!result) {
          return reply.code(404).send({ error: "Quote not found for tenant." });
        }

        if ("conflict" in result) {
          return reply.code(409).send({ error: "This send confirmation key was already used." });
        }

        return reply.send(result);
      } catch (error) {
        if (error instanceof JobServiceError) {
          return reply.code(error.statusCode).send({ code: error.code, error: error.message });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existingEvent = await findConfirmedSend();
          if (existingEvent?.quoteId === quoteId) {
            const quote = await app.prisma.quote.findFirst({
              where: {
                id: quoteId,
                ...tenantActiveQuoteScope(claims.tenantId),
                ...assignedRecordScope(access),
              },
            });
            if (quote) return reply.send({ quote, event: existingEvent, duplicate: true });
          }
        }

        throw error;
      }
    },
  );

  app.post(
    "/quotes/:quoteId/outbound-events",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId } = QuoteParamsSchema.parse(request.params);
      const payload = CreateQuoteOutboundEventSchema.parse(request.body);
      const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
        userEmail: claims.email,
      });

      if (!entitlements) {
        return reply.code(404).send({ error: "Tenant not found for account." });
      }

      if (!entitlements.features.communicationLog) {
        return reply.code(403).send({
          code: "PLAN_FEATURE_REQUIRED",
          feature: "communicationLog",
          currentPlan: entitlements.planCode,
          requiredPlan: requiredPlanForFeature("communicationLog"),
          error: "Communication logs are available on Professional and Enterprise plans.",
        });
      }

      const quote = await app.prisma.quote.findFirst({
        where: {
          id: quoteId,
          ...tenantActiveQuoteScope(claims.tenantId),
          ...assignedRecordScope(access),
        },
        select: {
          id: true,
          customerId: true,
          customer: {
            select: {
              email: true,
              phone: true,
            },
          },
        },
      });

      if (!quote) {
        return reply.code(404).send({ error: "Quote not found for tenant." });
      }

      const destination =
        payload.destination ??
        (payload.channel === "EMAIL_APP"
          ? quote.customer.email ?? undefined
          : payload.channel === "SMS_APP"
            ? quote.customer.phone
            : undefined);

      const event = await app.prisma.quoteOutboundEvent.create({
        data: {
          tenantId: claims.tenantId,
          quoteId: quote.id,
          customerId: quote.customerId,
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          actorName: actor.actorName,
          channel: payload.channel as QuoteOutboundChannel,
          destination,
          subject: payload.subject,
          bodyPreview: payload.body?.slice(0, 500),
        },
      });

      return reply.code(201).send({ event });
    },
  );

  app.post("/quotes/:quoteId/line-items", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const payload = CreateLineItemSchema.parse(request.body);

    let result;
    try {
      result = await app.prisma.$transaction(async (tx) => {
      const quote = await lockActiveQuoteForMutation(tx, {
        quoteId,
        tenantId: claims.tenantId,
        assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
      });
      if (!quote) return null;
      await assertNoRetainedJobForQuote(tx, {
        tenantId: claims.tenantId,
        quoteId: quote.id,
      });

      const lastLineItem = await tx.quoteLineItem.findFirst({
        where: {
          quoteId: quote.id,
          ...tenantActiveScope(claims.tenantId),
        },
        orderBy: [{ position: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: { position: true },
      });

      const lineItem = await tx.quoteLineItem.create({
        data: {
          tenantId: claims.tenantId,
          quoteId: quote.id,
          description: payload.description,
          sectionType: normalizeQuoteLineSectionType(payload.sectionType),
          sectionLabel: payload.sectionLabel?.trim() || null,
          position: (lastLineItem?.position ?? -1) + 1,
          quantity: payload.quantity,
          unitCost: await resolveMemberLineUnitCost(tx, {
            access,
            sourcePresetId: payload.sourcePresetId,
            requestedUnitCost: payload.unitCost,
          }),
          unitPrice: payload.unitPrice,
        },
      });

      const updatedQuote = await recalculateQuoteFromLineItems(tx, quote.id, claims.tenantId);
      if (!updatedQuote) return null;

      await createQuoteRevision(tx, {
        tenantId: claims.tenantId,
        quoteId: updatedQuote.id,
        eventType: "LINE_ITEM_CHANGED",
        actor,
        changedFields: [
          "lineItems.description",
          "lineItems.quantity",
          "lineItems.unitCost",
          "lineItems.unitPrice",
          "internalCostSubtotal",
          "customerPriceSubtotal",
          "totalAmount",
        ],
      });

      await markQuoteAiRetrievalSourcesDeleted(tx, {
        tenantId: claims.tenantId,
        quoteIds: [updatedQuote.id],
      });

      return { lineItem, quote: updatedQuote };
      });
    } catch (error) {
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send({ code: error.code, error: error.message });
      }
      throw error;
    }

    if (!result) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    return reply.code(201).send(result);
  });

  app.patch(
    "/quotes/:quoteId/line-items/:lineItemId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId, lineItemId } = QuoteLineItemParamsSchema.parse(request.params);
      const payload = UpdateLineItemSchema.parse(request.body);

      let result;
      try {
        result = await app.prisma.$transaction(async (tx) => {
        const quote = await lockActiveQuoteForMutation(tx, {
          quoteId,
          tenantId: claims.tenantId,
          assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
        });
        if (!quote) return null;
        await assertNoRetainedJobForQuote(tx, {
          tenantId: claims.tenantId,
          quoteId: quote.id,
        });

        const lineItem = await tx.quoteLineItem.findFirst({
          where: {
            id: lineItemId,
            quoteId: quote.id,
            ...tenantActiveScope(claims.tenantId),
          },
        });

        if (!lineItem) {
          return null;
        }

        const updatedLineItem = await tx.quoteLineItem.update({
          where: { id: lineItem.id },
          data: {
            description: payload.description,
            sectionType: payload.sectionType ? normalizeQuoteLineSectionType(payload.sectionType) : undefined,
            sectionLabel: payload.sectionLabel !== undefined ? payload.sectionLabel?.trim() || null : undefined,
            quantity: payload.quantity,
            unitCost: hasCapability(access, "viewInternalCosts") ? payload.unitCost : undefined,
            unitPrice: payload.unitPrice,
          },
        });

        const updatedQuote = await recalculateQuoteFromLineItems(tx, quote.id, claims.tenantId);
        if (!updatedQuote) return null;

        await createQuoteRevision(tx, {
          tenantId: claims.tenantId,
          quoteId: updatedQuote.id,
          eventType: "LINE_ITEM_CHANGED",
          actor,
          changedFields: [
            "lineItems.description",
            "lineItems.quantity",
            "lineItems.unitCost",
            "lineItems.unitPrice",
            "internalCostSubtotal",
            "customerPriceSubtotal",
            "totalAmount",
          ],
        });

        await markQuoteAiRetrievalSourcesDeleted(tx, {
          tenantId: claims.tenantId,
          quoteIds: [updatedQuote.id],
        });

        return { lineItem: updatedLineItem, quote: updatedQuote };
        });
      } catch (error) {
        if (error instanceof JobServiceError) {
          return reply.code(error.statusCode).send({ code: error.code, error: error.message });
        }
        throw error;
      }

      if (!result) {
        return reply.code(404).send({ error: "Quote or line item not found for tenant." });
      }

      return reply.send(result);
    },
  );

  app.delete(
    "/quotes/:quoteId/line-items/:lineItemId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const access = buildAccessContext(request);
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId, lineItemId } = QuoteLineItemParamsSchema.parse(request.params);
      const now = new Date();

      let deleted;
      try {
        deleted = await app.prisma.$transaction(async (tx) => {
        const quote = await lockActiveQuoteForMutation(tx, {
          quoteId,
          tenantId: claims.tenantId,
          assignedTenantUserId: assignedRecordScope(access).assignedTenantUserId,
        });
        if (!quote) return false;
        await assertNoRetainedJobForQuote(tx, {
          tenantId: claims.tenantId,
          quoteId: quote.id,
        });

        const lineItem = await tx.quoteLineItem.findFirst({
          where: {
            id: lineItemId,
            quoteId: quote.id,
            ...tenantActiveScope(claims.tenantId),
          },
          select: { id: true },
        });

        if (!lineItem) return false;

        await tx.quoteLineItem.update({
          where: { id: lineItem.id },
          data: { deletedAtUtc: now },
        });

        const updatedQuote = await recalculateQuoteFromLineItems(tx, quote.id, claims.tenantId);
        if (!updatedQuote) return false;

        await createQuoteRevision(tx, {
          tenantId: claims.tenantId,
          quoteId: updatedQuote.id,
          eventType: "LINE_ITEM_CHANGED",
          actor,
          changedFields: [
            "lineItems",
            "internalCostSubtotal",
            "customerPriceSubtotal",
            "totalAmount",
          ],
        });

        await markQuoteAiRetrievalSourcesDeleted(tx, {
          tenantId: claims.tenantId,
          quoteIds: [updatedQuote.id],
          now,
        });

        return true;
        });
      } catch (error) {
        if (error instanceof JobServiceError) {
          return reply.code(error.statusCode).send({ code: error.code, error: error.message });
        }
        throw error;
      }

      if (!deleted) {
        return reply.code(404).send({ error: "Quote or line item not found for tenant." });
      }

      return reply.code(204).send();
    },
  );
};
