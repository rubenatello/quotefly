import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const CreateQuoteSchema = z.object({
  customerId: z.string().min(1),
  serviceType: z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING"]),
  title: z.string().min(3),
  scopeText: z.string().min(3),
  internalCostSubtotal: z.number().nonnegative(),
  customerPriceSubtotal: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().default(0),
});

export const quoteRoutes: FastifyPluginAsync = async (app) => {
  app.post("/quotes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = CreateQuoteSchema.parse(request.body);
    const claims = getJwtClaims(request);
    const totalAmount = payload.customerPriceSubtotal + payload.taxAmount;
    const customer = await app.prisma.customer.findFirst({
      where: {
        id: payload.customerId,
        tenantId: claims.tenantId,
      },
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

  app.post("/quotes/:quoteId/decision", { preHandler: [app.authenticate] }, async (request, reply) => {
    const ParamsSchema = z.object({ quoteId: z.string().min(1) });
    const BodySchema = z.object({ decision: z.enum(["send", "revise"]) });

    const { quoteId } = ParamsSchema.parse(request.params);
    const { decision } = BodySchema.parse(request.body);
    const claims = getJwtClaims(request);

    const status = decision === "send" ? "SENT_TO_CUSTOMER" : "READY_FOR_REVIEW";
    const sentAt = decision === "send" ? new Date() : null;
    const decisionStatus = decision === "send" ? "APPROVED" : "REVISION_REQUESTED";

    const quote = await app.prisma.$transaction(async (tx) => {
      const existingQuote = await tx.quote.findFirst({
        where: {
          id: quoteId,
          tenantId: claims.tenantId,
        },
      });

      if (!existingQuote) {
        return null;
      }

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
          tenantId: claims.tenantId,
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
};
