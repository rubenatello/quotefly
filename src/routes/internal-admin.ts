import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { resolveActivityActor } from "../lib/activity";
import { assistantRequestConsumesAiBudget, runAiAssistant } from "../lib/ai-assistant";
import { hashSourceReference } from "../lib/ai-data-governance";
import {
  AssistantRequestSchema,
  normalizeAssistantContext,
  normalizeAssistantConversation,
  type AssistantRequestPayload,
} from "../lib/ai-assistant-request";
import { authenticatedAiRateLimit } from "../lib/ai-rate-limit";
import { assertAiUsageAvailable, buildAiUsageResponse } from "../lib/ai-usage";
import { measureRequestPerformance } from "../lib/request-performance";
import { loadTenantEntitlements } from "../lib/subscription";
import { recordSuperuserAuditEvent, requireSuperuserAccess } from "../lib/superuser-access";
import {
  AiUsageLedgerError,
  aiUsageLedgerErrorResponse,
  hashAiUsageRequest,
  normalizeAiIdempotencyHeader,
  runWithAiUsageOperation,
} from "../services/ai-usage-ledger";

const AiQualitySummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
});

const AiQualityTenantsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const AiQualityFeedbackQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  includeNotes: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
}).strict();

function daysAgoUtc(days: number): Date {
  const now = new Date();
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function roundPercent(value: number): number {
  return Number(value.toFixed(2));
}

function assistantTestAuditMetadata(
  payload: AssistantRequestPayload | null,
  extra: Record<string, string | number | boolean | null>,
) {
  return {
    requestedTool: payload?.tool ?? "UNKNOWN",
    includeArchivedRequested: Boolean(payload?.context?.includeArchived),
    promptRefHash: payload ? hashSourceReference("AiAssistantPrompt", payload.message) : null,
    ...extra,
  };
}

export const internalAdminRoutes: FastifyPluginAsync = async (app) => {
  const AssistantTestRateLimit = {
    config: authenticatedAiRateLimit("internal-ai-quality-assistant-test", app.env.NODE_ENV === "test" ? 10_000 : 12),
  } as const;

  app.post("/internal/ai-quality/assistant-test", { ...AssistantTestRateLimit, preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const access = buildAccessContext(request);
    let payload: AssistantRequestPayload;
    try {
      payload = AssistantRequestSchema.parse(request.body);
    } catch (error) {
      await recordSuperuserAuditEvent(app.prisma, {
        actorUserId: claims.userId,
        requestId: request.id,
        action: "AI_QUALITY_ASSISTANT_TEST_REJECTED",
        targetType: "AiAssistantTest",
        metadata: assistantTestAuditMetadata(null, {
          status: "REJECTED",
          reason: "INVALID_REQUEST_BODY",
        }),
      });
      throw error;
    }
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
    const idempotencyKey = normalizeAiIdempotencyHeader(request.headers["idempotency-key"]);
    if (consumesBudget && !idempotencyKey) {
      return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED", error: "A valid Idempotency-Key header is required for paid AI requests." });
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
      });
      result = await measureRequestPerformance(request, "ai", () => consumesBudget
        ? runWithAiUsageOperation(app.prisma, {
            tenantId: claims.tenantId,
            userEmail: claims.email,
            actorTenantUserId: access.tenantUserId,
            operation: "INTERNAL_AI_QUALITY_TEST",
            idempotencyKey: idempotencyKey!,
            requestHash: hashAiUsageRequest({ payload, context, conversation }),
            credits: 1,
            resolveSettledCredits: (assistantResult) => assistantResult.consumedCredits,
          }, execute)
        : execute());
    } catch (error) {
      await recordSuperuserAuditEvent(app.prisma, {
        actorUserId: claims.userId,
        requestId: request.id,
        action: "AI_QUALITY_ASSISTANT_TEST_FAILED",
        targetType: "AiAssistantTest",
        metadata: assistantTestAuditMetadata(payload, {
          status: "FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      });
      if (error instanceof AiUsageLedgerError) {
        return reply.code(error.statusCode).send(aiUsageLedgerErrorResponse(error));
      }
      throw error;
    }

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "AI_QUALITY_ASSISTANT_TEST_RUN",
      targetType: "AiUsageEvent",
      targetRefHash: hashSourceReference("AiUsageEvent", result.assistant.auditEventId),
      metadata: {
        requestedTool: payload.tool,
        resolvedTool: result.assistant.tool,
        maxClassification: result.assistant.maxClassification,
        answerMode: result.assistant.diagnostics.answerMode,
        answerModel: result.assistant.diagnostics.model,
        includeArchivedRequested: Boolean(payload.context?.includeArchived),
        resultCount: result.assistant.results.length,
        citationCount: result.assistant.citations.length,
        actionCount: result.assistant.actions.length,
        consumedSpendUsd: result.consumedSpendUsd,
        emptyResult: result.assistant.results.length === 0,
        promptRefHash: hashSourceReference("AiAssistantPrompt", payload.message),
      },
    });

    const finalEntitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, { userEmail: claims.email });
    if (!finalEntitlements) return reply.code(503).send({ code: "AI_USAGE_ACCOUNTING_UNAVAILABLE", error: "AI usage accounting is temporarily unavailable." });
    const finalSnapshot = (await assertAiUsageAvailable(app.prisma, claims.tenantId, finalEntitlements)).snapshot;
    return {
      assistant: result.assistant,
      usage: buildAiUsageResponse(finalSnapshot, {
        consumedCredits: result.consumedCredits,
        consumedSpendUsd: result.consumedSpendUsd,
      }, { viewInternalCosts: true }),
    };
  });

  app.get("/internal/ai-quality/summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = AiQualitySummaryQuerySchema.parse(request.query);
    const windowStartUtc = daysAgoUtc(query.days);

    const baseWhere = {
      deletedAtUtc: null,
      createdAt: {
        gte: windowStartUtc,
      },
    } as const;

    const [
      aggregate,
      highConfidenceCount,
      mediumConfidenceCount,
      lowConfidenceCount,
      activeTenantGroups,
      modelGroups,
      recentRuns,
      noPatchRuns,
      regexFallbackRuns,
    ] = await Promise.all([
      app.prisma.aiUsageEvent.aggregate({
        where: baseWhere,
        _count: {
          _all: true,
        },
        _sum: {
          estimatedCostUsd: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          creditsConsumed: true,
        },
      }),
      app.prisma.aiUsageEvent.count({
        where: {
          ...baseWhere,
          confidenceLevel: "high",
        },
      }),
      app.prisma.aiUsageEvent.count({
        where: {
          ...baseWhere,
          confidenceLevel: "medium",
        },
      }),
      app.prisma.aiUsageEvent.count({
        where: {
          ...baseWhere,
          confidenceLevel: "low",
        },
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["tenantId"],
        where: baseWhere,
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["model"],
        where: {
          ...baseWhere,
          model: {
            not: null,
          },
        },
        _count: {
          _all: true,
        },
        _sum: {
          estimatedCostUsd: true,
          totalTokens: true,
        },
      }),
      app.prisma.aiUsageEvent.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        select: {
          eventType: true,
          serviceType: true,
          model: true,
          confidenceLevel: true,
          patchAdded: true,
          patchUpdated: true,
          patchRemoved: true,
          totalTokens: true,
          estimatedCostUsd: true,
        },
        take: 5000,
      }),
      app.prisma.aiUsageEvent.count({
        where: {
          ...baseWhere,
          patchAdded: 0,
          patchUpdated: 0,
          patchRemoved: 0,
        },
      }),
      app.prisma.aiUsageEvent.count({
        where: {
          ...baseWhere,
          model: "regex-fallback",
        },
      }),
    ]);

    const totalRuns = aggregate._count._all ?? 0;
    const totalSpendUsd = Number(aggregate._sum.estimatedCostUsd ?? 0);
    const totalPromptTokens = aggregate._sum.promptTokens ?? 0;
    const totalCompletionTokens = aggregate._sum.completionTokens ?? 0;
    const totalTokens = aggregate._sum.totalTokens ?? 0;
    const totalCreditsConsumed = aggregate._sum.creditsConsumed ?? 0;

    const modelBreakdown = modelGroups
      .map((group) => ({
        model: group.model ?? "unknown",
        runCount: group._count._all ?? 0,
        spendUsd: roundMetric(Number(group._sum.estimatedCostUsd ?? 0)),
        averageTokensPerRun:
          (group._count._all ?? 0) > 0
            ? roundMetric(Number(group._sum.totalTokens ?? 0) / (group._count._all ?? 1))
            : 0,
      }))
      .sort((left, right) => right.runCount - left.runCount)
      .slice(0, 8);

    const tradeRows = new Map<
      "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
      {
        runCount: number;
        draftRuns: number;
        reviseRuns: number;
        noPatchRuns: number;
        lowConfidenceRuns: number;
        regexFallbackRuns: number;
        spendUsd: number;
        totalTokens: number;
      }
    >();

    for (const run of recentRuns) {
      const trade = run.serviceType;
      if (!trade) continue;
      const row = tradeRows.get(trade) ?? {
        runCount: 0,
        draftRuns: 0,
        reviseRuns: 0,
        noPatchRuns: 0,
        lowConfidenceRuns: 0,
        regexFallbackRuns: 0,
        spendUsd: 0,
        totalTokens: 0,
      };
      row.runCount += 1;
      row.spendUsd += Number(run.estimatedCostUsd ?? 0);
      row.totalTokens += run.totalTokens ?? 0;
      if (run.eventType === "DRAFT") row.draftRuns += 1;
      if (run.eventType === "REVISE") row.reviseRuns += 1;
      if ((run.patchAdded ?? 0) + (run.patchUpdated ?? 0) + (run.patchRemoved ?? 0) === 0) {
        row.noPatchRuns += 1;
      }
      if (run.confidenceLevel === "low") {
        row.lowConfidenceRuns += 1;
      }
      if ((run.model ?? "").toLowerCase() === "regex-fallback") {
        row.regexFallbackRuns += 1;
      }
      tradeRows.set(trade, row);
    }

    const tradeBreakdown = Array.from(tradeRows.entries())
      .map(([trade, row]) => ({
        trade,
        runCount: row.runCount,
        draftRuns: row.draftRuns,
        reviseRuns: row.reviseRuns,
        spendUsd: roundMetric(row.spendUsd),
        averageTokensPerRun: row.runCount > 0 ? roundMetric(row.totalTokens / row.runCount) : 0,
        noPatchRuns: row.noPatchRuns,
        noPatchRatePct: row.runCount > 0 ? roundPercent((row.noPatchRuns / row.runCount) * 100) : 0,
        lowConfidenceRuns: row.lowConfidenceRuns,
        lowConfidenceRatePct: row.runCount > 0 ? roundPercent((row.lowConfidenceRuns / row.runCount) * 100) : 0,
        regexFallbackRuns: row.regexFallbackRuns,
        regexFallbackRatePct:
          row.runCount > 0 ? roundPercent((row.regexFallbackRuns / row.runCount) * 100) : 0,
      }))
      .sort((left, right) => right.runCount - left.runCount);

    const qualitySignals = [
      {
        key: "no_patch_mutation",
        label: "No patch mutation",
        count: noPatchRuns,
      },
      {
        key: "low_confidence_context",
        label: "Low confidence context",
        count: lowConfidenceCount,
      },
      {
        key: "regex_fallback_runtime",
        label: "Regex fallback runtime",
        count: regexFallbackRuns,
      },
    ].map((signal) => ({
      ...signal,
      ratePct: totalRuns > 0 ? roundPercent((signal.count / totalRuns) * 100) : 0,
    }));

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "AI_QUALITY_SUMMARY_VIEWED",
      targetType: "AiUsageEvent",
      metadata: { windowDays: query.days, runCount: totalRuns },
    });

    return {
      windowDays: query.days,
      windowStartUtc,
      generatedAtUtc: new Date(),
      totals: {
        totalRuns,
        activeTenants: activeTenantGroups.length,
        totalCreditsConsumed,
        totalSpendUsd: roundMetric(totalSpendUsd),
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
      },
      averages: {
        spendUsdPerRun: totalRuns > 0 ? roundMetric(totalSpendUsd / totalRuns) : 0,
        promptTokensPerRun: totalRuns > 0 ? roundMetric(totalPromptTokens / totalRuns) : 0,
        completionTokensPerRun: totalRuns > 0 ? roundMetric(totalCompletionTokens / totalRuns) : 0,
        totalTokensPerRun: totalRuns > 0 ? roundMetric(totalTokens / totalRuns) : 0,
      },
      confidence: {
        high: highConfidenceCount,
        medium: mediumConfidenceCount,
        low: lowConfidenceCount,
      },
      quality: {
        noPatchRuns,
        noPatchRatePct: totalRuns > 0 ? roundPercent((noPatchRuns / totalRuns) * 100) : 0,
        lowConfidenceRuns: lowConfidenceCount,
        lowConfidenceRatePct: totalRuns > 0 ? roundPercent((lowConfidenceCount / totalRuns) * 100) : 0,
        regexFallbackRuns,
        regexFallbackRatePct: totalRuns > 0 ? roundPercent((regexFallbackRuns / totalRuns) * 100) : 0,
      },
      qualitySignals,
      models: modelBreakdown,
      tradeBreakdown,
    };
  });

  app.get(
    "/internal/ai-quality/feedback",
    {
      config: authenticatedAiRateLimit(
        "internal-ai-quality-feedback",
        app.env.NODE_ENV === "test" ? 10_000 : 30,
      ),
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const claims = requireSuperuserAccess(request, reply);
      if (!claims) return reply;
      const query = AiQualityFeedbackQuerySchema.parse(request.query);
      const windowStartUtc = daysAgoUtc(query.days);
      const where = {
        deletedAtUtc: null,
        createdAt: { gte: windowStartUtc },
        aiUsageEvent: { deletedAtUtc: null },
      } as const;

      const [ratingGroups, withNoteCount, feedbackRows] = await Promise.all([
        app.prisma.aiAssistantFeedback.groupBy({
          by: ["rating"],
          where,
          _count: { _all: true },
        }),
        app.prisma.aiAssistantFeedback.count({
          where: { ...where, note: { not: null } },
        }),
        query.includeNotes
          ? app.prisma.aiAssistantFeedback.findMany({
              where,
              orderBy: { createdAt: "desc" },
              take: query.limit,
              select: {
                id: true,
                rating: true,
                note: true,
                createdAt: true,
                tenant: { select: { id: true, name: true } },
                aiUsageEvent: {
                  select: {
                    eventType: true,
                    purpose: true,
                    model: true,
                    confidenceLevel: true,
                    createdAt: true,
                  },
                },
              },
            })
          : app.prisma.aiAssistantFeedback.findMany({
              where,
              orderBy: { createdAt: "desc" },
              take: query.limit,
              select: {
                id: true,
                rating: true,
                createdAt: true,
                tenant: { select: { id: true, name: true } },
                aiUsageEvent: {
                  select: {
                    eventType: true,
                    purpose: true,
                    model: true,
                    confidenceLevel: true,
                    createdAt: true,
                  },
                },
              },
            }),
      ]);

      const ratingCounts = new Map(ratingGroups.map((group) => [group.rating, group._count._all]));
      const total = Array.from(ratingCounts.values()).reduce((sum, value) => sum + value, 0);

      await recordSuperuserAuditEvent(app.prisma, {
        actorUserId: claims.userId,
        requestId: request.id,
        action: query.includeNotes ? "AI_QUALITY_FEEDBACK_NOTES_VIEWED" : "AI_QUALITY_FEEDBACK_VIEWED",
        targetType: "AiAssistantFeedback",
        metadata: {
          windowDays: query.days,
          includeNotes: query.includeNotes,
          returnedCount: feedbackRows.length,
          noteCount: withNoteCount,
        },
      });

      return {
        windowDays: query.days,
        windowStartUtc,
        generatedAtUtc: new Date(),
        summary: {
          total,
          up: ratingCounts.get("UP") ?? 0,
          down: ratingCounts.get("DOWN") ?? 0,
          withNote: withNoteCount,
        },
        notesIncluded: query.includeNotes,
        feedback: feedbackRows.map((feedback) => ({
          id: feedback.id,
          rating: feedback.rating,
          ...(query.includeNotes && "note" in feedback ? { note: feedback.note } : {}),
          createdAt: feedback.createdAt,
          tenant: feedback.tenant,
          usage: feedback.aiUsageEvent,
        })),
      };
    },
  );

  app.get("/internal/ai-quality/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = AiQualityTenantsQuerySchema.parse(request.query);
    const windowStartUtc = daysAgoUtc(query.days);

    const where = {
      deletedAtUtc: null,
      createdAt: {
        gte: windowStartUtc,
      },
    } as const;

    const [grouped, noPatchGroups, lowConfidenceGroups, regexFallbackGroups] = await Promise.all([
      app.prisma.aiUsageEvent.groupBy({
        by: ["tenantId"],
        where,
        _count: {
          _all: true,
        },
        _sum: {
          estimatedCostUsd: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
        },
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["tenantId"],
        where: {
          ...where,
          patchAdded: 0,
          patchUpdated: 0,
          patchRemoved: 0,
        },
        _count: {
          _all: true,
        },
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["tenantId"],
        where: {
          ...where,
          confidenceLevel: "low",
        },
        _count: {
          _all: true,
        },
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["tenantId"],
        where: {
          ...where,
          model: "regex-fallback",
        },
        _count: {
          _all: true,
        },
      }),
    ]);

    const sorted = grouped
      .map((group) => ({
        tenantId: group.tenantId,
        runCount: group._count._all ?? 0,
        spendUsd: Number(group._sum.estimatedCostUsd ?? 0),
        promptTokens: group._sum.promptTokens ?? 0,
        completionTokens: group._sum.completionTokens ?? 0,
        totalTokens: group._sum.totalTokens ?? 0,
      }))
      .sort((left, right) => {
        if (right.spendUsd !== left.spendUsd) return right.spendUsd - left.spendUsd;
        return right.runCount - left.runCount;
      })
      .slice(0, query.limit);

    const tenantIds = sorted.map((entry) => entry.tenantId);
    const tenantRows =
      tenantIds.length > 0
        ? await app.prisma.tenant.findMany({
            where: {
              id: { in: tenantIds },
            },
            select: {
              id: true,
              name: true,
              slug: true,
            },
          })
        : [];
    const tenantMap = new Map(tenantRows.map((tenant) => [tenant.id, tenant]));
    const noPatchByTenant = new Map(noPatchGroups.map((group) => [group.tenantId, group._count._all ?? 0]));
    const lowConfidenceByTenant = new Map(
      lowConfidenceGroups.map((group) => [group.tenantId, group._count._all ?? 0]),
    );
    const regexFallbackByTenant = new Map(
      regexFallbackGroups.map((group) => [group.tenantId, group._count._all ?? 0]),
    );

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "AI_QUALITY_TENANT_LIST_VIEWED",
      targetType: "Tenant",
      metadata: { windowDays: query.days, limit: query.limit, resultCount: sorted.length },
    });

    return {
      windowDays: query.days,
      windowStartUtc,
      tenants: sorted.map((row) => {
        const tenant = tenantMap.get(row.tenantId);
        const noPatchRuns = noPatchByTenant.get(row.tenantId) ?? 0;
        const lowConfidenceRuns = lowConfidenceByTenant.get(row.tenantId) ?? 0;
        const regexFallbackRuns = regexFallbackByTenant.get(row.tenantId) ?? 0;
        return {
          tenantId: row.tenantId,
          tenantName: tenant?.name ?? "Unknown tenant",
          tenantSlug: tenant?.slug ?? null,
          runCount: row.runCount,
          spendUsd: roundMetric(row.spendUsd),
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          averageSpendUsdPerRun: row.runCount > 0 ? roundMetric(row.spendUsd / row.runCount) : 0,
          averageTokensPerRun: row.runCount > 0 ? roundMetric(row.totalTokens / row.runCount) : 0,
          noPatchRuns,
          noPatchRatePct: row.runCount > 0 ? roundPercent((noPatchRuns / row.runCount) * 100) : 0,
          lowConfidenceRuns,
          lowConfidenceRatePct:
            row.runCount > 0 ? roundPercent((lowConfidenceRuns / row.runCount) * 100) : 0,
          regexFallbackRuns,
          regexFallbackRatePct:
            row.runCount > 0 ? roundPercent((regexFallbackRuns / row.runCount) * 100) : 0,
        };
      }),
    };
  });
};
