import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { AI_ASSISTANT_TOOLS, runAiAssistant } from "../lib/ai-assistant";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { getJwtClaims } from "../lib/auth";
import { measureRequestPerformance } from "../lib/request-performance";
import { loadTenantEntitlements } from "../lib/subscription";

const ServiceTypeSchema = z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

const AssistantContextSchema = z.object({
  currentPage: z.enum(["quotes", "customers", "analytics", "products", "dashboard"]).optional(),
  customerId: z.string().trim().min(1).optional(),
  quoteId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  serviceType: ServiceTypeSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  includeArchived: z.boolean().optional(),
});

const AssistantRequestSchema = z.object({
  message: z.string().trim().min(3).max(2_000),
  tool: z.enum(AI_ASSISTANT_TOOLS).default("AUTO"),
  context: AssistantContextSchema.optional(),
});

export const aiAssistantRoutes: FastifyPluginAsync = async (app) => {
  app.post("/ai/assistant", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const payload = AssistantRequestSchema.parse(request.body);

    const entitlements = await measureRequestPerformance(request, "db", () => loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    }));
    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const { blocked, blockedBy, snapshot } = await measureRequestPerformance(request, "db", () => assertAiUsageAvailable(
      app.prisma,
      claims.tenantId,
      entitlements,
    ));
    if (blocked) {
      return reply.code(402).send({
        code: "AI_USAGE_LIMIT_REACHED",
        error: "This workspace has reached its AI usage limit for the current billing period.",
        feature: blockedBy,
        usage: buildAiUsageResponse(snapshot, { consumedCredits: 0, consumedSpendUsd: 0 }),
      });
    }

    const actor = await measureRequestPerformance(request, "db", () => resolveActivityActor(app.prisma, claims));
    const result = await measureRequestPerformance(request, "ai", () => runAiAssistant(app.prisma, {
      access,
      actor,
      message: payload.message,
      tool: payload.tool,
      context: payload.context
        ? {
            currentPage: payload.context.currentPage,
            customerId: payload.context.customerId,
            quoteId: payload.context.quoteId,
            search: payload.context.search,
            serviceType: payload.context.serviceType,
            dateFrom: payload.context.dateFrom ?? null,
            dateTo: payload.context.dateTo ?? null,
            limit: payload.context.limit,
            includeArchived: payload.context.includeArchived,
          }
        : undefined,
      usageSnapshot: snapshot,
    }));

    return {
      assistant: result.assistant,
      usage: buildAiUsageResponse(snapshot, {
        consumedCredits: result.consumedCredits,
        consumedSpendUsd: 0,
      }),
    };
  });
};
