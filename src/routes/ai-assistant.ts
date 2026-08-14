import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { assistantToolConsumesAiBudget, resolveAssistantTool, runAiAssistant } from "../lib/ai-assistant";
import {
  AssistantRequestSchema,
  normalizeAssistantContext,
  normalizeAssistantConversation,
} from "../lib/ai-assistant-request";
import { authenticatedAiRateLimit } from "../lib/ai-rate-limit";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { getJwtClaims } from "../lib/auth";
import { measureRequestPerformance } from "../lib/request-performance";
import { loadTenantEntitlements } from "../lib/subscription";

const AssistantFeedbackParamsSchema = z.object({
  auditEventId: z.string().trim().min(1).max(191),
}).strict();

const AssistantFeedbackBodySchema = z.object({
  rating: z.enum(["UP", "DOWN"]),
}).strict();

export const aiAssistantRoutes: FastifyPluginAsync = async (app) => {
  const AssistantRateLimit = {
    config: authenticatedAiRateLimit("ai-assistant", app.env.NODE_ENV === "test" ? 10_000 : 20),
  } as const;

  app.post("/ai/assistant", { ...AssistantRateLimit, preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const payload = AssistantRequestSchema.parse(request.body);
    const context = normalizeAssistantContext(payload.context);
    const conversation = normalizeAssistantConversation(payload.conversation);
    const resolvedTool = resolveAssistantTool(payload.message, payload.tool, context, conversation);

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
    if (blocked && assistantToolConsumesAiBudget(resolvedTool)) {
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
      context,
      conversation,
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

  app.post(
    "/ai/assistant/:auditEventId/feedback",
    {
      bodyLimit: 2_000,
      config: authenticatedAiRateLimit(
        "ai-assistant-feedback",
        app.env.NODE_ENV === "test" ? 10_000 : 60,
      ),
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      const { auditEventId } = AssistantFeedbackParamsSchema.parse(request.params);
      const { rating } = AssistantFeedbackBodySchema.parse(request.body);

      const feedback = await measureRequestPerformance(request, "db", () => app.prisma.$transaction(async (tx) => {
        const usageEvent = await tx.aiUsageEvent.findFirst({
          where: {
            id: auditEventId,
            tenantId: claims.tenantId,
            actorUserId: claims.userId,
            deletedAtUtc: null,
          },
          select: { id: true },
        });

        if (!usageEvent) return null;

        return tx.aiAssistantFeedback.upsert({
          where: {
            tenantId_aiUsageEventId_actorUserId: {
              tenantId: claims.tenantId,
              aiUsageEventId: usageEvent.id,
              actorUserId: claims.userId,
            },
          },
          create: {
            tenantId: claims.tenantId,
            aiUsageEventId: usageEvent.id,
            actorUserId: claims.userId,
            rating,
          },
          update: {
            rating,
            deletedAtUtc: null,
          },
          select: {
            rating: true,
            updatedAt: true,
          },
        });
      }));

      if (!feedback) {
        return reply.code(404).send({ error: "Kody response was not found for this account." });
      }

      return {
        feedback: {
          rating: feedback.rating,
          updatedAt: feedback.updatedAt,
        },
      };
    },
  );
};
