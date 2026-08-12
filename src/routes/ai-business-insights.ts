import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import {
  AI_BUSINESS_INSIGHT_TOOLS,
  AiBusinessInsightForbiddenError,
  generateAiBusinessInsight,
} from "../lib/ai-business-insights";
import { resolveActivityActor } from "../lib/activity";
import { getJwtClaims } from "../lib/auth";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { loadTenantEntitlements } from "../lib/subscription";

const ServiceTypeSchema = z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

const BusinessInsightSchema = z.object({
  prompt: z.string().trim().min(3).max(1_000),
  tool: z.enum(AI_BUSINESS_INSIGHT_TOOLS),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  serviceType: ServiceTypeSchema.optional(),
  limit: z.number().int().min(1).max(20).optional(),
  includeArchived: z.boolean().default(false),
});

export const aiBusinessInsightRoutes: FastifyPluginAsync = async (app) => {
  app.post("/ai/business-insights", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const payload = BusinessInsightSchema.parse(request.body);

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
      return reply.code(402).send({
        code: "AI_USAGE_LIMIT_REACHED",
        error: "This workspace has reached its AI usage limit for the current billing period.",
        feature: blockedBy,
        usage: buildAiUsageResponse(snapshot, { consumedCredits: 0, consumedSpendUsd: 0 }),
      });
    }

    const actor = await resolveActivityActor(app.prisma, claims);

    try {
      const insight = await generateAiBusinessInsight(app.prisma, {
        access,
        actor,
        prompt: payload.prompt,
        tool: payload.tool,
        dateFrom: payload.dateFrom ?? null,
        dateTo: payload.dateTo ?? null,
        serviceType: payload.serviceType ?? null,
        limit: payload.limit,
        includeArchived: payload.includeArchived,
      });

      return {
        insight,
        usage: buildAiUsageResponse(snapshot),
      };
    } catch (error) {
      if (error instanceof AiBusinessInsightForbiddenError) {
        return reply.code(403).send({ error: error.message });
      }
      throw error;
    }
  });
};
