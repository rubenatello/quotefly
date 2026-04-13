import { LeadFollowUpStatus, Prisma, QuoteOutboundChannel, QuoteRevisionEventType } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { PaginationQuerySchema, tenantActiveScope } from "../lib/query-scope";
import {
  loadTenantEntitlements,
  startOfCurrentUtcMonth,
  startOfNextUtcMonth,
} from "../lib/subscription";
import { parseChatToQuotePrompt } from "../services/chat-to-quote";
import { aiParseChatToQuotePrompt, getAiQuoteRuntimeInfo } from "../services/ai-quote";
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

const CreateQuoteSchema = z.object({
  customerId: z.string().min(1),
  serviceType: ServiceTypeSchema,
  title: z.string().min(3),
  scopeText: z.string().min(3),
  internalCostSubtotal: z.number().nonnegative(),
  customerPriceSubtotal: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().default(0),
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

const QuoteDecisionSchema = z.object({
  decision: z.enum(["send", "revise"]),
});

const CreateLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
});

const UpdateLineItemSchema = z
  .object({
    description: z.string().min(1).optional(),
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


const QuoteRevisionSelect = {
  id: true,
  quoteId: true,
  customerId: true,
  version: true,
  eventType: true,
  changedFields: true,
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

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function calculateQuoteTotal(customerPriceSubtotal: number, taxAmount: number): number {
  return roundCurrency(customerPriceSubtotal + taxAmount);
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
      ...tenantActiveScope(tenantId),
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
      quantity: true,
      unitCost: true,
      unitPrice: true,
    },
  });

  let internalCostSubtotal = 0;
  let customerPriceSubtotal = 0;

  for (const lineItem of lineItems) {
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

async function getQuoteRevisionContext(
  tx: Prisma.TransactionClient,
  quoteId: string,
  tenantId: string,
) {
  return tx.quote.findFirst({
    where: {
      id: quoteId,
      ...tenantActiveScope(tenantId),
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
      title: context.title,
      status: context.status,
      customerPriceSubtotal: Number(context.customerPriceSubtotal),
      totalAmount: Number(context.totalAmount),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
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
  app.post("/quotes/chat-draft", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteFromChatSchema.parse(request.body);
    const claims = getJwtClaims(request);
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
          ...tenantActiveScope(claims.tenantId),
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

    if (entitlements.limits.aiQuotesPerMonth !== null) {
      const periodStart = startOfCurrentUtcMonth();
      const periodEnd = startOfNextUtcMonth();
      const monthlyAiQuoteCount = await app.prisma.quote.count({
        where: {
          ...tenantActiveScope(claims.tenantId),
          aiGeneratedAtUtc: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
      });

      if (monthlyAiQuoteCount >= entitlements.limits.aiQuotesPerMonth) {
        const requiredPlan =
          entitlements.planCode === "starter" ? "professional" : "enterprise";
        return reply.code(403).send({
          code: "PLAN_LIMIT_EXCEEDED",
          error: `${entitlements.planName} includes up to ${entitlements.limits.aiQuotesPerMonth} AI-generated quotes per month. You can still revise existing quotes manually.`,
          feature: "aiQuotesPerMonth",
          currentPlan: entitlements.planCode,
          requiredPlan,
          limit: entitlements.limits.aiQuotesPerMonth,
          used: monthlyAiQuoteCount,
        });
      }
    }

    const parsedDraft = await aiParseChatToQuotePrompt(payload.prompt);
    const aiRuntime = getAiQuoteRuntimeInfo();
    const detectedCustomerName = payload.customerName?.trim() || parsedDraft.customerName;
    const customerPhone = normalizeNullablePhone(payload.customerPhone) ?? normalizeNullablePhone(parsedDraft.customerPhone);
    const customerEmail = normalizeNullableEmail(payload.customerEmail) ?? normalizeNullableEmail(parsedDraft.customerEmail);

    let customer = customerPhone
      ? await app.prisma.customer.findFirst({
          where: {
            phone: customerPhone,
            ...tenantActiveScope(claims.tenantId),
          },
        })
      : null;

    if (!customer && customerEmail) {
      customer = await app.prisma.customer.findFirst({
        where: {
          email: customerEmail,
          ...tenantActiveScope(claims.tenantId),
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

    const hasExplicitSubtotalTarget =
      (parsedDraft.estimatedTotalAmount ?? 0) > 0 || (parsedDraft.estimatedInternalCostAmount ?? 0) > 0;

    const supplementalPresetMatches =
      matchedStandardPreset && !hasExplicitSubtotalTarget
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
    if (customerPriceSubtotal <= 0 && matchedPreset) {
      const matchedQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      customerPriceSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitPrice);
    }
    if (customerPriceSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset) {
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
    if (internalCostSubtotal <= 0 && matchedPreset) {
      const matchedQuantity = inferPresetQuantity(
        matchedPreset.unitType,
        matchedPreset.defaultQuantity,
        parsedDraft.squareFeetEstimate,
        matchedPreset.quantityMode,
      );
      internalCostSubtotal = roundCurrency(matchedQuantity * matchedPreset.unitCost);
    }
    if (internalCostSubtotal <= 0 && supplementalPresets.length > 0 && matchedPreset) {
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

    const lineItemDrafts = matchedPreset
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
          const laborPercent = laborSplit(parsedDraft.serviceType);
          const laborCustomerTotal = roundCurrency(customerPriceSubtotal * laborPercent);
          const materialCustomerTotal = roundCurrency(customerPriceSubtotal - laborCustomerTotal);
          const laborInternalTotal = roundCurrency(internalCostSubtotal * laborPercent);
          const materialInternalTotal = roundCurrency(internalCostSubtotal - laborInternalTotal);

          const laborSuggestion = parsedDraft.lineItems.find((lineItem) => lineItem.kind === "LABOR");
          const materialSuggestion = parsedDraft.lineItems.find((lineItem) => lineItem.kind === "MATERIAL");
          const laborQuantity = Number(Math.max(1, laborSuggestion?.quantity ?? 1).toFixed(2));
          const materialQuantity = Number(Math.max(1, materialSuggestion?.quantity ?? 1).toFixed(2));
          const laborUnitCost = roundCurrency(laborInternalTotal / laborQuantity);
          const laborUnitPrice = roundCurrency(laborCustomerTotal / laborQuantity);
          const materialUnitCost = roundCurrency(materialInternalTotal / materialQuantity);
          const materialUnitPrice = roundCurrency(materialCustomerTotal / materialQuantity);

          return [
            {
              description: laborSuggestion?.description ?? `${parsedDraft.serviceType} labor`,
              quantity: laborQuantity,
              unitCost: laborUnitCost,
              unitPrice: laborUnitPrice,
            },
            {
              description: materialSuggestion?.description ?? "Materials and install supplies",
              quantity: materialQuantity,
              unitCost: materialUnitCost,
              unitPrice: materialUnitPrice,
            },
          ];
        })();

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

      return tx.quote.findFirst({
        where: {
          id: createdQuote.id,
          ...tenantActiveScope(claims.tenantId),
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
    });
  });

  app.post("/quotes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteSchema.parse(request.body);
    const claims = getJwtClaims(request);
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
          ...tenantActiveScope(claims.tenantId),
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
        ...tenantActiveScope(claims.tenantId),
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

      await createQuoteRevision(tx, {
        tenantId: claims.tenantId,
        quoteId: createdQuote.id,
        eventType: "CREATED",
        changedFields: [
          "customerId",
          "serviceType",
          "title",
          "scopeText",
          "internalCostSubtotal",
          "customerPriceSubtotal",
          "taxAmount",
          "totalAmount",
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
      ...tenantActiveScope(claims.tenantId),
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
        ...tenantActiveScope(claims.tenantId),
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
          ...tenantActiveScope(claims.tenantId),
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
          ...tenantActiveScope(claims.tenantId),
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
        ...tenantActiveScope(claims.tenantId),
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

  app.get("/quotes/:quoteId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { quoteId } = QuoteParamsSchema.parse(request.params);

    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveScope(claims.tenantId),
      },
      include: {
        customer: true,
        lineItems: {
          where: tenantActiveScope(claims.tenantId),
          orderBy: { createdAt: "asc" },
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
        ...tenantActiveScope(claims.tenantId),
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
            branding: {
              select: {
                templateId: true,
                primaryColor: true,
                logoUrl: true,
                logoPosition: true,
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

    const existingQuote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveScope(claims.tenantId),
      },
    });

    if (!existingQuote) {
      return reply.code(404).send({ error: "Quote not found for tenant." });
    }

    if (payload.customerId) {
      const customer = await app.prisma.customer.findFirst({
        where: {
          id: payload.customerId,
          ...tenantActiveScope(claims.tenantId),
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
        changedFields: Array.from(new Set(revisionChangedFields)),
      });

      if (followUpStatusUpdate) {
        await tx.customer.updateMany({
          where: {
            id: updatedQuote.customerId,
            ...tenantActiveScope(claims.tenantId),
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
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const now = new Date();

    const deleted = await app.prisma.$transaction(async (tx) => {
      const quote = await getActiveQuoteForTenant(tx, quoteId, claims.tenantId);
      if (!quote) return false;

      await tx.quote.update({
        where: { id: quote.id },
        data: { deletedAtUtc: now },
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

  app.post("/quotes/:quoteId/decision", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { quoteId } = QuoteParamsSchema.parse(request.params);
    const { decision } = QuoteDecisionSchema.parse(request.body);
    const claims = getJwtClaims(request);

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
        changedFields: ["status", "sentAt", "decisionSession.status"],
      });

      if (decision === "send") {
        await tx.customer.updateMany({
          where: {
            id: updatedQuote.customerId,
            ...tenantActiveScope(claims.tenantId),
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
          ...tenantActiveScope(claims.tenantId),
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
          ...tenantActiveScope(claims.tenantId),
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
