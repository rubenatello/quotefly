import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { assistantRequestConsumesAiBudget, runAiAssistant } from "../lib/ai-assistant";
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
import { withTenantRlsContext } from "../lib/tenant-rls";
import { normalizeSupportedLocale } from "../lib/supported-locale";
import {
  AiUsageLedgerError,
  AI_IDEMPOTENCY_COMPATIBILITY_HEADER,
  aiUsageLedgerErrorResponse,
  hashAiUsageRequest,
  resolveAiRequestIdempotencyKey,
  runWithAiUsageOperation,
} from "../services/ai-usage-ledger";

const AssistantFeedbackParamsSchema = z.object({
  auditEventId: z.string().trim().min(1).max(191),
}).strict();

const AssistantFeedbackBodySchema = z.object({
  rating: z.enum(["UP", "DOWN"]),
  note: z.string().trim().max(500).nullable().optional(),
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
    const entitlements = await measureRequestPerformance(request, "db", () => loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    }));
    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const { snapshot } = await measureRequestPerformance(request, "db", () => assertAiUsageAvailable(
      app.prisma,
      claims.tenantId,
      entitlements,
    ));

    const actor = await measureRequestPerformance(request, "db", () => resolveActivityActor(app.prisma, claims));
    const consumesBudget = assistantRequestConsumesAiBudget(payload.message, payload.tool, context, conversation);
    const idempotency = consumesBudget
      ? resolveAiRequestIdempotencyKey(request.headers["idempotency-key"], request.id)
      : null;
    if (consumesBudget && !idempotency) {
      return reply.code(400).send({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        error: "A valid Idempotency-Key header is required for paid AI requests.",
      });
    }
    if (idempotency?.usedLegacyFallback) {
      reply.header(AI_IDEMPOTENCY_COMPATIBILITY_HEADER, "synthesized-request-key");
      request.log.warn(
        { route: "/v1/ai/assistant", requestId: request.id, compatibility: "legacy-missing-ai-idempotency-key" },
        "Accepted a missing paid-AI Idempotency-Key through the one-release compatibility fallback.",
      );
    }
    let result;
    try {
      const execute = () => runAiAssistant(app.prisma, {
        access,
        actor,
        message: payload.message,
        tool: payload.tool,
        context,
        conversation,
        usageSnapshot: snapshot,
        preferredLocale: normalizeSupportedLocale(request.liveAuthMembership?.user.preferredLocale),
      });
      result = await measureRequestPerformance(request, "ai", () => consumesBudget
        ? runWithAiUsageOperation(app.prisma, {
            tenantId: claims.tenantId,
            userEmail: claims.email,
            actorTenantUserId: access.tenantUserId,
            operation: "AI_ASSISTANT",
            idempotencyKey: idempotency!.idempotencyKey,
            requestHash: hashAiUsageRequest({ payload, context, conversation }),
            credits: 1,
            resolveSettledCredits: (assistantResult) => assistantResult.consumedCredits,
          }, execute)
        : execute());
    } catch (error) {
      if (error instanceof AiUsageLedgerError) {
        return reply.code(error.statusCode).send(aiUsageLedgerErrorResponse(error));
      }
      throw error;
    }

    const finalEntitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });
    if (!finalEntitlements) {
      return reply.code(503).send({
        code: "AI_USAGE_ACCOUNTING_UNAVAILABLE",
        error: "AI usage accounting is temporarily unavailable.",
      });
    }
    const finalSnapshot = (await assertAiUsageAvailable(
      app.prisma,
      claims.tenantId,
      finalEntitlements,
    )).snapshot;

    return {
      assistant: result.assistant,
      usage: buildAiUsageResponse(finalSnapshot, {
        consumedCredits: result.consumedCredits,
        consumedSpendUsd: result.consumedSpendUsd,
      }, { viewInternalCosts: hasCapability(access, "viewInternalCosts") }),
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
      const payload = AssistantFeedbackBodySchema.parse(request.body);
      const noteProvided = Object.prototype.hasOwnProperty.call(payload, "note");
      const note = payload.note?.trim() || null;

      const feedback = await measureRequestPerformance(request, "db", () => withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
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
            rating: payload.rating,
            note,
          },
          update: {
            rating: payload.rating,
            ...(noteProvided ? { note } : {}),
            deletedAtUtc: null,
          },
          select: {
            rating: true,
            note: true,
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
          note: feedback.note,
          updatedAt: feedback.updatedAt,
        },
      };
    },
  );
};
