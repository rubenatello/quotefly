import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { isSuperuserEmail } from "../lib/superuser";

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
      models: modelBreakdown,
    };
  });

  app.get("/internal/ai-quality/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!requireSuperuser(request, reply)) return reply;
    const query = AiQualityTenantsQuerySchema.parse(request.query);
    const windowStartUtc = daysAgoUtc(query.days);

    const grouped = await app.prisma.aiUsageEvent.groupBy({
      by: ["tenantId"],
      where: {
        deletedAtUtc: null,
        createdAt: {
          gte: windowStartUtc,
        },
      },
      _count: {
        _all: true,
      },
      _sum: {
        estimatedCostUsd: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
      },
    });

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

    return {
      windowDays: query.days,
      windowStartUtc,
      tenants: sorted.map((row) => {
        const tenant = tenantMap.get(row.tenantId);
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
        };
      }),
    };
  });
};
