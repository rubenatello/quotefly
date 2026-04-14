import { LeadFollowUpStatus, Prisma, PrismaClient, QuoteOutboundChannel, QuoteRevisionEventType } from "@prisma/client";
import { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { assertAiUsageAvailable, buildAiUsageResponse, createAiUsageEvent } from "../lib/ai-usage";
import { createCustomerActivityEvent, resolveActivityActor, type ActivityActor } from "../lib/activity";
import {
  PaginationQuerySchema,
  tenantActiveCustomerScope,
  tenantActiveQuoteScope,
  tenantActiveScope,
} from "../lib/query-scope";
import {
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
import { generateQuotePdfBuffer } from "../services/quote-pdf";
import { buildQuickBooksInvoiceCsv } from "../services/quickbooks-csv";
import { findBestStandardWorkPresetMatch, findStandardWorkPresetMatches } from "../services/work-preset-catalog";

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
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1),
        sectionType: QuoteLineSectionTypeSchema.default("INCLUDED"),
        sectionLabel: z.string().trim().max(80).optional().nullable(),
        quantity: z.number().positive(),
        unitCost: z.number().nonnegative(),
        unitPrice: z.number().nonnegative(),
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
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required.",
  });

const ListQuotesQuerySchema = PaginationQuerySchema.extend({
  status: QuoteStatusSchema.optional(),
  customerId: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

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
  channel: z.enum(["EMAIL_APP", "SMS_APP", "COPY"]),
  destination: z.string().trim().min(1).max(320).optional(),
  subject: z.string().trim().min(1).max(220).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
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


const QuoteRevisionSelect = {
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
  snapshot: true,
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
  creditsConsumed: true,
  requestCount: true,
  promptTokens: true,
  completionTokens: true,
  totalTokens: true,
  estimatedCostUsd: true,
  promptText: true,
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
) {
  return tx.quote.findFirst({
    where: {
      id: quoteId,
      ...tenantActiveQuoteScope(tenantId),
    },
  });
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
}

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
        orderBy: { createdAt: "asc" },
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
): RevisionSnapshot {
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
    select: { version: true },
  });

  const snapshot = buildQuoteRevisionSnapshot(context);
  const version = (lastRevision?.version ?? 0) + 1;

  return tx.quoteRevision.create({
    data: {
      tenantId: params.tenantId,
      quoteId: context.id,
      customerId: context.customer.id,
      version,
      eventType: params.eventType,
      changedFields: params.changedFields ?? [],
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
  const quote = await getActiveQuoteForTenant(tx, params.quoteId, params.tenantId);
  if (!quote) return { status: "quote_missing" as const };

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

  for (const lineItem of snapshot.lineItems) {
    await tx.quoteLineItem.create({
      data: {
        tenantId: params.tenantId,
        quoteId: quote.id,
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel,
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

  return { status: "ok" as const };
}

function quoteChangedFields(payload: z.infer<typeof UpdateQuoteSchema>): string[] {
  const fields = Object.keys(payload);
  return fields.length ? fields : ["manual_update"];
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
  const normalized = value.trim();
  return normalized || undefined;
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
  similarQuotes: SimilarQuoteContext[];
  targetAmount?: number | null;
}) {
  let score = 0;

  if (params.currentQuoteUsed) score += 3;
  if (params.customer) score += 1;
  if (params.customer?.notes?.trim()) score += 1;
  if (params.customerActivityCount > 0) score += 1;
  if (params.presetCount > 0) score += 2;
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
  similarQuotes: SimilarQuoteContext[];
  targetAmount?: number | null;
  patch: AiQuotePatchResult;
}): AiSuggestionInsight {
  const confidence = assessAiSuggestionConfidence({
    currentQuoteUsed: params.currentQuoteUsed,
    customer: params.customer,
    customerActivityCount: params.customerActivityCount,
    presetCount: params.presetCount,
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

  for (const quote of params.similarQuotes.slice(0, 2)) {
    sources.push({
      type: "similar_quote",
      label: `${formatAiSourceStatus(quote.status)} quote: ${quote.title}`,
    });
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

function buildAiUsageTraceFromInsight(insight: AiSuggestionInsight) {
  return {
    insightSummary: insight.summary,
    insightReasons: insight.reasons,
    insightSourceLabels: insight.sources.map((source) => source.label),
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
  if (params.similarQuotes.length > 0) {
    hints.push(`${params.similarQuotes.length} similar quotes`);
  }
  return hints.slice(0, 4);
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
    type: "current_quote" | "customer" | "customer_notes" | "customer_activity" | "saved_jobs" | "similar_quote";
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
  pricingProfile?: {
    laborRate: number;
    materialMarkup: number;
  } | null;
  similarQuotes?: SimilarQuoteContext[];
}) {
  const sections: string[] = [];

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
                  `  ${index + 1}. ${line.sectionType === "ALTERNATE" ? `${line.sectionLabel?.trim() || "Alternate option"} | ` : ""}${line.description} | qty ${line.quantity} | cost ${line.unitCost} | price ${line.unitPrice}`,
              )
              .join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (params.pricingProfile) {
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
            `- ${preset.name} | ${preset.description ?? "No description"} | ${preset.unitType} | cost ${preset.unitCost.toFixed(
              2,
            )} | price ${preset.unitPrice.toFixed(2)}`,
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

  return sections.join("\n\n");
}

function appendAiPromptStructureHints(context: string, prompt: string) {
  if (!promptRequestsSeparateLineOptions(prompt)) {
    return context;
  }

  return [
    context,
    [
      "Prompt structure requirements:",
      "- The user explicitly asked for separate lines or alternative options.",
      "- Preserve that request in the line item structure.",
      "- Do not collapse repair and replacement into one generic line.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
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
  tenantId: string,
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
      tenantId,
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
        orderBy: { createdAt: "asc" },
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

export const quoteRoutes: FastifyPluginAsync = async (app) => {
  app.post("/quotes/ai-suggest", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = SuggestQuoteWithAiSchema.parse(request.body);
    const claims = getJwtClaims(request);
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
                orderBy: { createdAt: "asc" },
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

    const similarQuotes = await loadSimilarQuoteContext(app.prisma, claims.tenantId, {
      serviceType: preliminaryServiceType,
      prompt: payload.prompt,
      title: existingQuote?.title ?? payload.currentTitle ?? preflightDraft.title,
      scopeText: existingQuote?.scopeText ?? payload.currentScopeText ?? preflightDraft.scopeText,
      targetAmount: preflightDraft.estimatedTotalAmount ?? currentQuoteEstimatedTotal,
      excludeQuoteId: existingQuote?.id ?? payload.quoteId ?? null,
    });

    stream.progress(
      "retrieving_workspace_context",
      `Loaded ${contextPresets.length} saved job${contextPresets.length === 1 ? "" : "s"} and ${similarQuotes.length} similar quote${similarQuotes.length === 1 ? "" : "s"} for ${preliminaryServiceType.toLowerCase()}.`,
      {
        sourceHints: buildAiContextSourceHints({
          customer: selectedCustomer
            ? {
                notes: selectedCustomer.notes,
              }
            : null,
          customerActivityCount: customerActivityContext.length,
          presetCount: contextPresets.length,
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
      pricingProfile: contextPricingProfile
        ? {
            laborRate: Number(contextPricingProfile.laborRate),
            materialMarkup: Number(contextPricingProfile.materialMarkup),
          }
          : null,
      similarQuotes,
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
      selectedCustomer = await app.prisma.customer.findFirst({
        where: {
          phone: customerPhone,
          ...tenantActiveCustomerScope(claims.tenantId),
        },
      });
    }

    if (!selectedCustomer && customerEmail) {
      selectedCustomer = await app.prisma.customer.findFirst({
        where: {
          email: customerEmail,
          ...tenantActiveCustomerScope(claims.tenantId),
        },
      });
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
        pricingProfile: contextPricingProfile
          ? {
              laborRate: Number(contextPricingProfile.laborRate),
              materialMarkup: Number(contextPricingProfile.materialMarkup),
            }
          : null,
        similarQuotes,
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
            similarQuotes,
          }),
        },
      );
    }

    const baselineSuggestion = await buildAiSuggestedQuoteDraft(app.prisma, claims.tenantId, {
      prompt: payload.prompt,
      parsedDraft,
      serviceTypeOverride: existingQuote?.serviceType ?? payload.serviceType,
    });

    const hasCurrentSheetContext = currentQuoteContext
      ? hasMeaningfulCurrentQuoteContext(currentQuoteContext)
      : false;

    const revisionPlan = hasCurrentSheetContext
      ? await aiBuildQuoteRevisionPlan(payload.prompt, {
          context: [
            contextPrompt,
            "Current quote lines:",
            ...(currentQuoteContext?.lineItems.map(
              (lineItem, index) =>
                `${index + 1}. ${lineItem.description} | qty ${lineItem.quantity} | cost ${lineItem.unitCost.toFixed(
                  2,
                )} | price ${lineItem.unitPrice.toFixed(2)}`,
            ) ?? []),
            "",
            "Baseline AI draft:",
            `- Trade: ${baselineSuggestion.serviceType}`,
            `- Title: ${baselineSuggestion.title}`,
            `- Scope: ${baselineSuggestion.scopeText}`,
            ...baselineSuggestion.lineItems.map(
              (lineItem, index) =>
                `  ${index + 1}. ${lineItem.description} | qty ${lineItem.quantity} | cost ${lineItem.unitCost.toFixed(
                  2,
                )} | price ${lineItem.unitPrice.toFixed(2)}`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          telemetry: aiTelemetry,
        })
      : null;

    const patch = revisionPlan
      ? applyAiRevisionPlan(currentQuoteContext?.lineItems ?? [], baselineSuggestion, revisionPlan)
      : buildDeterministicAiPatch(currentQuoteContext?.lineItems ?? [], baselineSuggestion.lineItems);

    const resolvedServiceType = revisionPlan?.serviceType ?? baselineSuggestion.serviceType;
    const resolvedTitle =
      revisionPlan?.title?.trim() ||
      (hasCurrentSheetContext && currentQuoteContext?.title?.trim()
        ? currentQuoteContext.title.trim()
        : baselineSuggestion.title);
    const resolvedScopeText =
      revisionPlan?.scopeText?.trim() ||
      (hasCurrentSheetContext && currentQuoteContext?.scopeText?.trim()
        ? currentQuoteContext.scopeText.trim()
        : baselineSuggestion.scopeText);
    const resolvedInternalSubtotal = roundCurrency(
      patch.resolvedLines.reduce(
        (sum, lineItem) =>
          isIncludedQuoteLineSection(lineItem.sectionType)
            ? sum + lineItem.quantity * lineItem.unitCost
            : sum,
        0,
      ),
    );
    const resolvedCustomerSubtotal = roundCurrency(
      patch.resolvedLines.reduce(
        (sum, lineItem) =>
          isIncludedQuoteLineSection(lineItem.sectionType)
            ? sum + lineItem.quantity * lineItem.unitPrice
            : sum,
        0,
      ),
    );
    const suggestion: AiSuggestedQuoteDraft = {
      ...baselineSuggestion,
      serviceType: resolvedServiceType,
      title: resolvedTitle,
      scopeText: resolvedScopeText,
      internalCostSubtotal: resolvedInternalSubtotal,
      customerPriceSubtotal: resolvedCustomerSubtotal,
      totalAmount: calculateQuoteTotal(resolvedCustomerSubtotal, baselineSuggestion.taxAmount),
      lineItems: patch.resolvedLines.length ? patch.resolvedLines : baselineSuggestion.lineItems,
    };

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
      similarQuotes,
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

    const aiUsageEvent = await createAiUsageEvent(app.prisma, {
      tenantId: claims.tenantId,
      quoteId: existingQuote?.id ?? payload.quoteId ?? null,
      customerId: selectedCustomer?.id ?? existingQuote?.customerId ?? null,
      actor,
      eventType: hasCurrentSheetContext || existingQuote ? "REVISE" : "DRAFT",
      promptText: payload.prompt,
      model: suggestion.model,
      telemetry: aiTelemetry,
      trace: buildAiUsageTraceFromInsight(insight),
    });

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
            estimatedTotalAmount: parsedDraft.estimatedTotalAmount,
          },
          suggestion,
          patch,
          insight,
          aiRunId: aiUsageEvent.id,
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
    const payload = CreateQuoteFromChatSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    if (entitlements.limits.quotesPerMonth !== null) {
      const periodStart = startOfCurrentUtcMonth();
      const periodEnd = startOfNextUtcMonth();
      const monthlyQuoteCount = await app.prisma.quote.count({
        where: {
          tenantId: claims.tenantId,
          createdAt: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
      });

      if (monthlyQuoteCount >= entitlements.limits.quotesPerMonth) {
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
      });
    }

    const preflightDraft = parseChatToQuotePrompt(payload.prompt);
    const aiTelemetry = createAiTelemetryAccumulator();
    const aiRuntime = getAiQuoteRuntimeInfo();
    const detectedCustomerName = payload.customerName?.trim() || preflightDraft.customerName;
    const customerPhone = normalizeNullablePhone(payload.customerPhone) ?? normalizeNullablePhone(preflightDraft.customerPhone);
    const customerEmail = normalizeNullableEmail(payload.customerEmail) ?? normalizeNullableEmail(preflightDraft.customerEmail);

    let customer = customerPhone
      ? await app.prisma.customer.findFirst({
          where: {
            phone: customerPhone,
            ...tenantActiveCustomerScope(claims.tenantId),
          },
        })
      : null;

    if (!customer && customerEmail) {
      customer = await app.prisma.customer.findFirst({
        where: {
          email: customerEmail,
          ...tenantActiveCustomerScope(claims.tenantId),
        },
      });
    }

    if (!customer && !customerPhone) {
      return reply.code(400).send({
        error:
          "Include a customer phone number (or a known customer email) in the prompt so we can create the quote.",
      });
    }

    if (customer) {
      customer = await app.prisma.customer.update({
        where: { id: customer.id },
        data: {
          fullName: detectedCustomerName ?? customer.fullName,
          email: customerEmail ?? customer.email ?? undefined,
        },
      });
    } else {
      customer = await app.prisma.customer.create({
        data: {
          tenantId: claims.tenantId,
          fullName: detectedCustomerName ?? "New Customer",
          phone: customerPhone!,
          email: customerEmail,
        },
      });
    }

    const contextPricingProfile = await app.prisma.pricingProfile.findFirst({
      where: {
        tenantId: claims.tenantId,
        serviceType: preflightDraft.serviceType,
      },
      orderBy: {
        isDefault: "desc",
      },
    });

    const contextPresets = await app.prisma.workPreset.findMany({
      where: {
        tenantId: claims.tenantId,
        serviceType: preflightDraft.serviceType,
        deletedAtUtc: null,
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      take: 8,
    });

    const customerActivityContext = customer
      ? await app.prisma.customerActivityEvent.findMany({
          where: {
            tenantId: claims.tenantId,
            customerId: customer.id,
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

    const similarQuotes = await loadSimilarQuoteContext(app.prisma, claims.tenantId, {
      serviceType: preflightDraft.serviceType,
      prompt: payload.prompt,
      title: preflightDraft.title,
      scopeText: preflightDraft.scopeText,
      targetAmount: preflightDraft.estimatedTotalAmount,
    });

    const parsedDraft = await aiParseChatToQuotePrompt(payload.prompt, {
      context: appendAiPromptStructureHints(buildAiQuoteContext({
        customer: customer
          ? {
              fullName: customer.fullName,
              phone: customer.phone,
              email: customer.email,
              notes: customer.notes,
            }
          : null,
        customerActivity: customerActivityContext,
        presets: contextPresets.map((preset) => ({
          name: preset.name,
          description: preset.description,
          unitType: preset.unitType,
          unitCost: Number(preset.unitCost),
          unitPrice: Number(preset.unitPrice),
        })),
        pricingProfile: contextPricingProfile
          ? {
              laborRate: Number(contextPricingProfile.laborRate),
              materialMarkup: Number(contextPricingProfile.materialMarkup),
            }
          : null,
        similarQuotes,
      }), payload.prompt),
      telemetry: aiTelemetry,
    });

    const pricingProfile = await app.prisma.pricingProfile.findFirst({
      where: {
        tenantId: claims.tenantId,
        serviceType: parsedDraft.serviceType,
      },
      orderBy: {
        isDefault: "desc",
      },
    });

    const tenantPresets = await app.prisma.workPreset.findMany({
      where: {
        tenantId: claims.tenantId,
        serviceType: parsedDraft.serviceType,
        deletedAtUtc: null,
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    const laborRate = Number(pricingProfile?.laborRate ?? defaultLaborRate(parsedDraft.serviceType));
    const materialMarkup = Number(
      pricingProfile?.materialMarkup ?? defaultMaterialMarkup(parsedDraft.serviceType),
    );
    const estimatedUnits = parsedDraft.squareFeetEstimate ?? 100;
    const taxAmount = roundCurrency(parsedDraft.estimatedTaxAmount ?? 0);

    const matchedStandardPreset = findBestStandardWorkPresetMatch(
      parsedDraft.serviceType,
      `${payload.prompt} ${parsedDraft.title} ${parsedDraft.scopeText}`,
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
      prompt: payload.prompt,
      parsedDraft,
      serviceType: parsedDraft.serviceType,
    });

    const hasExplicitSubtotalTarget =
      (parsedDraft.estimatedTotalAmount ?? 0) > 0 || (parsedDraft.estimatedInternalCostAmount ?? 0) > 0;

    const supplementalPresetMatches =
      matchedStandardPreset && !hasExplicitSubtotalTarget && !preferExplicitAiLines
        ? findStandardWorkPresetMatches(
            parsedDraft.serviceType,
            `${payload.prompt} ${parsedDraft.title} ${parsedDraft.scopeText}`,
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

    let customerPriceSubtotal = roundCurrency(parsedDraft.estimatedTotalAmount ?? 0);
    if (customerPriceSubtotal <= 0 && matchedPreset && !preferExplicitAiLines) {
      const matchedQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      customerPriceSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitPrice);
    }
    if (customerPriceSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset && !preferExplicitAiLines) {
      const primaryQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      const supplementalSubtotal = supplementalPresets.reduce((sum, preset) => {
        const quantity = inferPresetQuantity(
          preset.unitType,
          preset.defaultQuantity,
          parsedDraft.squareFeetEstimate,
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

    let internalCostSubtotal = roundCurrency(parsedDraft.estimatedInternalCostAmount ?? 0);
    if (internalCostSubtotal <= 0 && matchedPreset && !preferExplicitAiLines) {
      const matchedQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      internalCostSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitCost);
    }
    if (internalCostSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset && !preferExplicitAiLines) {
      const primaryQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      const supplementalSubtotal = supplementalPresets.reduce((sum, preset) => {
        const quantity = inferPresetQuantity(
          preset.unitType,
          preset.defaultQuantity,
          parsedDraft.squareFeetEstimate,
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

    const title = matchedPreset?.name ?? parsedDraft.title;
    const scopeText = resolveChatQuoteScopeText(
      parsedDraft.scopeText,
      payload.prompt,
      matchedPreset?.description,
    );

    const lineItemDrafts = matchedPreset && !preferExplicitAiLines
      ? (() => {
          const primaryQuantity = inferPresetQuantity(
            matchedPreset.unitType,
            matchedPreset.defaultQuantity,
            parsedDraft.squareFeetEstimate,
            matchedPreset.quantityMode,
          );
          const primaryLineItems = [
            {
              description: matchedPreset.name,
              sectionType: "INCLUDED" as const,
              sectionLabel: null,
              quantity: primaryQuantity,
              unitCost: roundCurrency(matchedPreset.unitCost),
              unitPrice: roundCurrency(matchedPreset.unitPrice),
            },
          ];

          const supplementalLineItems = supplementalPresets.map((preset) => ({
            description: preset.name,
            sectionType: "INCLUDED" as const,
            sectionLabel: null,
            quantity: inferPresetQuantity(
              preset.unitType,
              preset.defaultQuantity,
              parsedDraft.squareFeetEstimate,
              preset.quantityMode,
            ),
            unitCost: roundCurrency(preset.unitCost),
            unitPrice: roundCurrency(preset.unitPrice),
          }));

          const allLineItems = [...primaryLineItems, ...supplementalLineItems];
          const rawCustomerSubtotal = allLineItems.reduce(
            (sum, lineItem) => sum + lineItem.quantity * lineItem.unitPrice,
            0,
          );
          const rawInternalSubtotal = allLineItems.reduce(
            (sum, lineItem) => sum + lineItem.quantity * lineItem.unitCost,
            0,
          );

          return allLineItems.map((lineItem) => ({
            ...lineItem,
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
            serviceType: parsedDraft.serviceType,
            prompt: payload.prompt,
            parsedDraft,
            tenantPresets,
            customerPriceSubtotal,
            internalCostSubtotal,
          });
        })();

    const draftInsight = buildAiSuggestionInsight({
      summary: `Prepared ${lineItemDrafts.length} starting line${lineItemDrafts.length === 1 ? "" : "s"} for the first draft.`,
      reasons: matchedPreset ? [`Anchored to ${matchedPreset.name} pricing and naming.`] : [],
      currentQuoteUsed: false,
      customer: customer
        ? {
            fullName: customer.fullName,
            notes: customer.notes,
          }
        : null,
      customerActivityCount: customerActivityContext.length,
      presetCount: contextPresets.length,
      similarQuotes,
      targetAmount: totalAmount,
      patch: {
        lineChanges: [],
        added: lineItemDrafts.length,
        updated: 0,
        removed: 0,
        resolvedLines: lineItemDrafts,
      },
    });

    const quote = await app.prisma.$transaction(async (tx) => {
      const createdQuote = await tx.quote.create({
        data: {
          tenantId: claims.tenantId,
          customerId: customer.id,
          serviceType: parsedDraft.serviceType,
          status: "READY_FOR_REVIEW",
          title,
          scopeText,
          internalCostSubtotal,
          customerPriceSubtotal,
          taxAmount,
          totalAmount,
          aiGeneratedAtUtc: new Date(),
          aiPromptText: payload.prompt,
          aiModel: aiRuntime.model,
        },
      });

      await tx.quoteLineItem.createMany({
        data: lineItemDrafts.map((lineItem) => ({
          tenantId: claims.tenantId,
          quoteId: createdQuote.id,
          description: lineItem.description,
          sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
          sectionLabel: lineItem.sectionLabel,
          quantity: lineItem.quantity,
          unitCost: lineItem.unitCost,
          unitPrice: lineItem.unitPrice,
        })),
      });

      await recalculateQuoteFromLineItems(tx, createdQuote.id, claims.tenantId);

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
          "lineItems",
        ],
      });

      await createAiUsageEvent(tx, {
        tenantId: claims.tenantId,
        quoteId: createdQuote.id,
        customerId: customer.id,
        actor,
        eventType: "DRAFT",
        promptText: payload.prompt,
        model: aiRuntime.model,
        telemetry: aiTelemetry,
        trace: buildAiUsageTraceFromInsight(draftInsight),
      });

      return tx.quote.findFirst({
        where: {
          id: createdQuote.id,
          ...tenantActiveQuoteScope(claims.tenantId),
        },
        include: {
          customer: true,
          lineItems: {
            where: tenantActiveScope(claims.tenantId),
            orderBy: { createdAt: "asc" },
          },
        },
      });
    });

    if (!quote) {
      return reply.code(500).send({ error: "Failed generating quote from chat prompt." });
    }

    return reply.code(201).send({
      quote,
      parsed: {
        customerName: parsedDraft.customerName,
        customerPhone: parsedDraft.customerPhone,
        customerEmail: parsedDraft.customerEmail,
        serviceType: parsedDraft.serviceType,
        squareFeetEstimate: parsedDraft.squareFeetEstimate,
        estimatedTotalAmount: parsedDraft.estimatedTotalAmount,
      },
      usage: buildAiUsageResponse(snapshot, {
        consumedCredits: 1,
        consumedSpendUsd: aiTelemetry.estimatedCostUsd,
      }),
    });
  });

  app.post("/quotes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const totalAmount = calculateQuoteTotal(payload.customerPriceSubtotal, payload.taxAmount);
    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });

    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    if (entitlements.limits.quotesPerMonth !== null) {
      const periodStart = startOfCurrentUtcMonth();
      const periodEnd = startOfNextUtcMonth();
      const monthlyQuoteCount = await app.prisma.quote.count({
        where: {
          tenantId: claims.tenantId,
          createdAt: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
      });

      if (monthlyQuoteCount >= entitlements.limits.quotesPerMonth) {
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
    }

    const customer = await app.prisma.customer.findFirst({
      where: {
        id: payload.customerId,
        ...tenantActiveCustomerScope(claims.tenantId),
      },
      select: { id: true },
    });

    if (!customer) {
      return reply.code(404).send({ error: "Customer not found for tenant." });
    }

    const quote = await app.prisma.$transaction(async (tx) => {
      const createdQuote = await tx.quote.create({
        data: {
          tenantId: claims.tenantId,
          customerId: payload.customerId,
          serviceType: payload.serviceType,
          title: payload.title,
          scopeText: payload.scopeText,
          internalCostSubtotal: payload.internalCostSubtotal,
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

      if (payload.lineItems?.length) {
        await tx.quoteLineItem.createMany({
          data: payload.lineItems.map((lineItem) => ({
            tenantId: claims.tenantId,
            quoteId: createdQuote.id,
            description: lineItem.description,
            sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
            sectionLabel: lineItem.sectionLabel?.trim() || null,
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

    return reply.code(201).send({ quote });
  });

  app.get("/quotes", { preHandler: [app.authenticate] }, async (request) => {
    const claims = getJwtClaims(request);
    const query = ListQuotesQuerySchema.parse(request.query);

    const where: Prisma.QuoteWhereInput = {
      ...tenantActiveQuoteScope(claims.tenantId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: "insensitive" } },
              { scopeText: { contains: query.search, mode: "insensitive" } },
              { customer: { fullName: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [quotes, total] = await app.prisma.$transaction([
      app.prisma.quote.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: query.limit,
        skip: query.offset,
        include: {
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
    ]);

    return {
      quotes,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
    };
  });

  app.post("/quotes/invoices/export-csv", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const payload = ExportQuickBooksInvoicesCsvSchema.parse(request.body);
    const quoteIds = Array.from(new Set(payload.quoteIds));

    const quotes = await app.prisma.quote.findMany({
      where: {
        id: { in: quoteIds },
        ...tenantActiveQuoteScope(claims.tenantId),
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
          orderBy: { createdAt: "asc" },
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
      ...(historyWindowStart ? { createdAt: { gte: historyWindowStart } } : {}),
    };

    const [revisions, total] = await app.prisma.$transaction([
      app.prisma.quoteRevision.findMany({
        where,
        select: QuoteRevisionSelect,
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
      },
      select: { id: true },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    const where: Prisma.QuoteRevisionWhereInput = {
      quoteId: quote.id,
      ...tenantActiveScope(claims.tenantId),
      ...(historyWindowStart ? { createdAt: { gte: historyWindowStart } } : {}),
    };

    const [revisions, total] = await app.prisma.$transaction([
      app.prisma.quoteRevision.findMany({
        where,
        select: QuoteRevisionSelect,
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
    const claims = getJwtClaims(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const query = QuoteAiRunsByQuoteQuerySchema.parse(request.query);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
      },
      select: { id: true },
    });

    if (!quote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    const where: Prisma.AiUsageEventWhereInput = {
      tenantId: claims.tenantId,
      quoteId: quote.id,
      deletedAtUtc: null,
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
        ...run,
        estimatedCostUsd:
          run.estimatedCostUsd === null || run.estimatedCostUsd === undefined
            ? null
            : Number(run.estimatedCostUsd),
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

      const result = await app.prisma.$transaction((tx) =>
        restoreQuoteRevision(tx, {
          tenantId: claims.tenantId,
          quoteId,
          revisionId,
          actor,
        }),
      );

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
        },
        include: {
          customer: true,
          lineItems: {
            where: tenantActiveScope(claims.tenantId),
            orderBy: { createdAt: "asc" },
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
    const { quoteId } = QuoteParamsSchema.parse(request.params);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
      },
      include: {
        customer: true,
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: { createdAt: "asc" },
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
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const query = QuotePdfQuerySchema.parse(request.query);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
      },
      include: {
        customer: true,
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: { createdAt: "asc" },
        },
        tenant: {
          select: {
            name: true,
            timezone: true,
            subscriptionPlanCode: true,
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

    const pdfBuffer = await generateQuotePdfBuffer({
      quoteId: quote.id,
      serviceType: quote.serviceType,
      status: quote.status,
      title: quote.title,
      scopeText: quote.scopeText,
      createdAt: quote.createdAt,
      sentAt: quote.sentAt,
      internalCostSubtotal: Number(quote.internalCostSubtotal),
      customerPriceSubtotal: Number(quote.customerPriceSubtotal),
      taxAmount: Number(quote.taxAmount),
      totalAmount: Number(quote.totalAmount),
      customer: {
        fullName: quote.customer.fullName,
        email: quote.customer.email,
        phone: quote.customer.phone,
      },
      tenant: {
        name: quote.tenant.name,
        timezone: quote.tenant.timezone,
      },
      branding: {
        templateId: quote.tenant.branding?.templateId ?? "modern",
        primaryColor: quote.tenant.branding?.primaryColor ?? "#5B85AA",
        logoUrl: quote.tenant.branding?.logoUrl ?? null,
        logoPosition:
          quote.tenant.branding?.logoPosition === "center" || quote.tenant.branding?.logoPosition === "right"
            ? quote.tenant.branding.logoPosition
            : "left",
        showQuoteFlyAttribution:
          (quote.tenant.subscriptionPlanCode ?? "starter") === "starter"
            ? true
            : !Boolean(quote.tenant.branding?.hideQuoteFlyAttribution),
        businessEmail: quote.tenant.branding?.businessEmail ?? null,
        businessPhone: quote.tenant.branding?.businessPhone ?? null,
        addressLine1: quote.tenant.branding?.addressLine1 ?? null,
        addressLine2: quote.tenant.branding?.addressLine2 ?? null,
        city: quote.tenant.branding?.city ?? null,
        state: quote.tenant.branding?.state ?? null,
        postalCode: quote.tenant.branding?.postalCode ?? null,
        componentColors:
          (quote.tenant.branding?.componentColors as
            | {
                headerBgColor?: string;
                headerTextColor?: string;
                sectionTitleColor?: string;
                tableHeaderBgColor?: string;
                tableHeaderTextColor?: string;
                totalsColor?: string;
                footerTextColor?: string;
              }
            | null
            | undefined) ?? null,
      },
      lineItems: quote.lineItems.map((lineItem) => ({
        description: lineItem.description,
        sectionType: normalizeQuoteLineSectionType(lineItem.sectionType),
        sectionLabel: lineItem.sectionLabel,
        quantity: Number(lineItem.quantity),
        unitCost: Number(lineItem.unitCost),
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

  app.patch("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const payload = UpdateQuoteSchema.parse(request.body);
    const actor = await resolveActivityActor(app.prisma, claims);

    const existingQuote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(claims.tenantId),
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
        },
        select: { id: true },
      });

      if (!customer) {
        return reply.code(404).send({ error: "Customer not found for tenant." });
      }
    }

    const nextCustomerPriceSubtotal =
      payload.customerPriceSubtotal ?? Number(existingQuote.customerPriceSubtotal);
    const nextTaxAmount = payload.taxAmount ?? Number(existingQuote.taxAmount);

    const shouldRecalculateTotal =
      payload.customerPriceSubtotal !== undefined || payload.taxAmount !== undefined;
    const lifecycleUpdate = resolveLifecycleUpdate(existingQuote, payload);

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

    const quote = await app.prisma.$transaction(async (tx) => {
      const updateData: Prisma.QuoteUncheckedUpdateInput = {
        ...(payload.customerId ? { customerId: payload.customerId } : {}),
        serviceType: payload.serviceType,
        status: payload.status,
        title: payload.title,
        scopeText: payload.scopeText,
        internalCostSubtotal: payload.internalCostSubtotal,
        customerPriceSubtotal: payload.customerPriceSubtotal,
        taxAmount: payload.taxAmount,
        ...(shouldRecalculateTotal
          ? { totalAmount: calculateQuoteTotal(nextCustomerPriceSubtotal, nextTaxAmount) }
          : {}),
        ...(payload.status
          ? {
              sentAt:
                payload.status === "SENT_TO_CUSTOMER"
                  ? existingQuote.sentAt ?? new Date()
                  : payload.status === "DRAFT" || payload.status === "READY_FOR_REVIEW"
                    ? null
                    : existingQuote.sentAt,
            }
          : {}),
        ...lifecycleUpdate.data,
      };

      const updatedQuote = await tx.quote.update({
        where: { id: existingQuote.id },
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

      return updatedQuote;
    });

    return { quote };
  });

  app.delete("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const now = new Date();

    const deleted = await app.prisma.$transaction(async (tx) => {
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
      if (!quote) return false;

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

      return true;
    });

    if (!deleted) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    return reply.code(204).send();
  });

  app.post("/quotes/:quoteId/archive", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const now = new Date();

    const archived = await app.prisma.$transaction(async (tx) => {
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
      if (!quote) return false;

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

      return true;
    });

    if (!archived) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    return reply.code(204).send();
  });

  app.post("/quotes/:quoteId/decision", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const { decision } = QuoteDecisionSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const actor = await resolveActivityActor(app.prisma, claims);

    const status = decision === "send" ? "SENT_TO_CUSTOMER" : "READY_FOR_REVIEW";
    const sentAt = decision === "send" ? new Date() : null;
    const decisionStatus = decision === "send" ? "APPROVED" : "REVISION_REQUESTED";

    const quote = await app.prisma.$transaction(async (tx) => {
      const existingQuote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
      if (!existingQuote) return null;

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
    "/quotes/:quoteId/outbound-events",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
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
    const actor = await resolveActivityActor(app.prisma, claims);
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const payload = CreateLineItemSchema.parse(request.body);

    const result = await app.prisma.$transaction(async (tx) => {
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
      if (!quote) return null;

      const lineItem = await tx.quoteLineItem.create({
        data: {
          tenantId: claims.tenantId,
          quoteId: quote.id,
          description: payload.description,
          sectionType: normalizeQuoteLineSectionType(payload.sectionType),
          sectionLabel: payload.sectionLabel?.trim() || null,
          quantity: payload.quantity,
          unitCost: payload.unitCost,
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

      return { lineItem, quote: updatedQuote };
    });

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
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId, lineItemId } = QuoteLineItemParamsSchema.parse(request.params);
      const payload = UpdateLineItemSchema.parse(request.body);

      const result = await app.prisma.$transaction(async (tx) => {
        const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
        if (!quote) return null;

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
            unitCost: payload.unitCost,
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

        return { lineItem: updatedLineItem, quote: updatedQuote };
      });

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
      const actor = await resolveActivityActor(app.prisma, claims);
      const { quoteId, lineItemId } = QuoteLineItemParamsSchema.parse(request.params);
      const now = new Date();

      const deleted = await app.prisma.$transaction(async (tx) => {
        const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
        if (!quote) return false;

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

        return true;
      });

      if (!deleted) {
        return reply.code(404).send({ error: "Quote or line item not found for tenant." });
      }

      return reply.code(204).send();
    },
  );
};
