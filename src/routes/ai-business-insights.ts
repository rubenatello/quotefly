import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import {
  AI_BUSINESS_INSIGHT_TOOLS,
  AiBusinessInsightForbiddenError,
  generateAiBusinessInsight,
} from "../lib/ai-business-insights";
import { authenticatedAiRateLimit } from "../lib/ai-rate-limit";
import { resolveActivityActor } from "../lib/activity";
import { getJwtClaims } from "../lib/auth";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { loadTenantEntitlements } from "../lib/subscription";
import {
  AiUsageLedgerError,
  AI_IDEMPOTENCY_COMPATIBILITY_HEADER,
  aiUsageLedgerErrorResponse,
  hashAiUsageRequest,
  resolveAiRequestIdempotencyKey,
  runWithAiUsageOperation,
} from "../services/ai-usage-ledger";

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
  app.post("/ai/business-insights", {
    preHandler: [app.authenticate],
    config: authenticatedAiRateLimit("ai-business-insights", app.env.NODE_ENV === "test" ? 10_000 : 12),
  }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const payload = BusinessInsightSchema.parse(request.body);

    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });
    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const actor = await resolveActivityActor(app.prisma, claims);
    const idempotency = resolveAiRequestIdempotencyKey(request.headers["idempotency-key"], request.id);
    if (!idempotency) {
      return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED", error: "A valid Idempotency-Key header is required for paid AI requests." });
    }
    if (idempotency.usedLegacyFallback) {
      reply.header(AI_IDEMPOTENCY_COMPATIBILITY_HEADER, "synthesized-request-key");
      request.log.warn(
        { route: "/v1/ai/business-insights", requestId: request.id, compatibility: "legacy-missing-ai-idempotency-key" },
        "Accepted a missing paid-AI Idempotency-Key through the one-release compatibility fallback.",
      );
    }

    try {
      const insight = await runWithAiUsageOperation(app.prisma, {
        tenantId: claims.tenantId,
        userEmail: claims.email,
        actorTenantUserId: access.tenantUserId,
        operation: "BUSINESS_INSIGHT",
        idempotencyKey: idempotency.idempotencyKey,
        requestHash: hashAiUsageRequest(payload),
        credits: 1,
      }, () => generateAiBusinessInsight(app.prisma, {
          access,
          actor,
          prompt: payload.prompt,
          tool: payload.tool,
          dateFrom: payload.dateFrom ?? null,
          dateTo: payload.dateTo ?? null,
          serviceType: payload.serviceType ?? null,
          limit: payload.limit,
          includeArchived: payload.includeArchived,
        }));
      const finalEntitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
        userEmail: claims.email,
      });
      if (!finalEntitlements) {
        return reply.code(503).send({ code: "AI_USAGE_ACCOUNTING_UNAVAILABLE", error: "AI usage accounting is temporarily unavailable." });
      }
      const finalSnapshot = (await assertAiUsageAvailable(app.prisma, claims.tenantId, finalEntitlements)).snapshot;

      return {
        insight,
        usage: buildAiUsageResponse(finalSnapshot, {
          consumedCredits: 1,
          consumedSpendUsd: insight.telemetry?.estimatedCostUsd ?? 0,
        }, { viewInternalCosts: hasCapability(access, "viewInternalCosts") }),
      };
    } catch (error) {
      if (error instanceof AiUsageLedgerError) {
        return reply.code(error.statusCode).send(aiUsageLedgerErrorResponse(error));
      }
      if (error instanceof AiBusinessInsightForbiddenError) {
        return reply.code(403).send({ error: error.message });
      }
      throw error;
    }
  });
};
