import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { isSuperuserEmail } from "../lib/superuser";
import { parseChatToQuotePrompt } from "../services/chat-to-quote";

const AiQualitySummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
});

const AiQualityTenantsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

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

function requireSuperuser(request: FastifyRequest, reply: FastifyReply) {
  const claims = getJwtClaims(request);
  if (!isSuperuserEmail(claims.email)) {
    reply.code(403).send({ error: "Superuser access required." });
    return null;
  }
  return claims;
}

export const internalAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/internal/ai-quality/summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!requireSuperuser(request, reply)) return reply;
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
          promptText: true,
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
      const trade = parseChatToQuotePrompt(run.promptText).serviceType;
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

  app.get("/internal/ai-quality/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!requireSuperuser(request, reply)) return reply;
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
