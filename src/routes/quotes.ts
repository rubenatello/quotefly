import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { PaginationQuerySchema, tenantActiveScope } from "../lib/query-scope";
import { generateQuotePdfBuffer } from "../services/quote-pdf";

const ServiceTypeSchema = z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING"]);
const QuoteStatusSchema = z.enum([
  "DRAFT",
  "READY_FOR_REVIEW",
  "SENT_TO_CUSTOMER",
  "ACCEPTED",
  "REJECTED",
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

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function calculateQuoteTotal(customerPriceSubtotal: number, taxAmount: number): number {
  return roundCurrency(customerPriceSubtotal + taxAmount);
}

function safeFileLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
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

export const quoteRoutes: FastifyPluginAsync = async (app) => {
  app.post("/quotes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const totalAmount = calculateQuoteTotal(payload.customerPriceSubtotal, payload.taxAmount);

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

    const quote = await app.prisma.quote.create({
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
        componentColors:
          (quote.tenant.branding?.componentColors as
            | {
                headerBgColor?: string;
                sectionTitleColor?: string;
                tableHeaderBgColor?: string;
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

    const quote = await app.prisma.quote.update({
      where: { id: existingQuote.id },
      data: {
        customerId: payload.customerId,
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
                  : null,
            }
          : {}),
      },
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

        await recalculateQuoteFromLineItems(tx, quote.id, claims.tenantId);
        return true;
      });

      if (!deleted) {
        return reply.code(404).send({ error: "Quote or line item not found for tenant." });
      }

      return reply.code(204).send();
    },
  );
};
