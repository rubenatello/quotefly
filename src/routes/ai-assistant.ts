import type { FastifyPluginAsync } from "fastify";
import { buildAccessContext } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { runAiAssistant } from "../lib/ai-assistant";
import { AssistantRequestSchema, normalizeAssistantContext } from "../lib/ai-assistant-request";
import { authenticatedAiRateLimit } from "../lib/ai-rate-limit";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { getJwtClaims } from "../lib/auth";
import { measureRequestPerformance } from "../lib/request-performance";
import { loadTenantEntitlements } from "../lib/subscription";

export const aiAssistantRoutes: FastifyPluginAsync = async (app) => {
  const AssistantRateLimit = {
    config: authenticatedAiRateLimit("ai-assistant", app.env.NODE_ENV === "test" ? 10_000 : 20),
  } as const;

  app.post("/ai/assistant", { ...AssistantRateLimit, preHandler: [app.authenticate] }, async (request, reply) => {
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
      context: normalizeAssistantContext(payload.context),
      usageSnapshot: snapshot,
    }));

    return {
      assistant: result.assistant,
      usage: buildAiUsageResponse(snapshot, {
        consumedCredits: result.consumedCredits,
        consumedSpendUsd: result.consumedSpendUsd,
      }),
    };
  });
};
