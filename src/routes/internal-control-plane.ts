import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITIES, capabilitiesForRole } from "../lib/access-policy";
import { mapWithConcurrency } from "../lib/bounded-concurrency";
import {
  getDataClassificationCatalog,
  validateDataGovernanceSchema,
} from "../lib/data-governance-catalog";
import {
  recordSuperuserAuditEvent,
  requireSuperuserAccess,
} from "../lib/superuser-access";
import { withTenantRlsContext } from "../lib/tenant-rls";

const TenantLifecycleSchema = z.enum(["active", "deleted", "all"]);
const TenantListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  search: z.string().trim().min(1).max(120).optional(),
  lifecycle: TenantLifecycleSchema.default("active"),
});

const CatalogQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  classification: z.enum([
    "C0_PUBLIC",
    "C1_BUSINESS_INTERNAL",
    "C2_CUSTOMER_CONFIDENTIAL",
    "C3_FINANCIAL_CONFIDENTIAL",
    "C4_RESTRICTED",
  ]).optional(),
  ragStatus: z.enum(["ELIGIBLE", "EXCLUDED", "REVIEW_REQUIRED"]).optional(),
});

const BoundedListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const ValidationRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  },
};
const RagIndexSummaryRateLimit = {
  config: {
    rateLimit: {
      max: 6,
      timeWindow: "1 minute",
    },
  },
};
const RagIndexTransactionOptions = {
  maxWait: 5_000,
  timeout: 15_000,
} as const;

function tenantLifecycleWhere(lifecycle: z.infer<typeof TenantLifecycleSchema>) {
  if (lifecycle === "deleted") return { deletedAtUtc: { not: null } } as const;
  if (lifecycle === "active") return { deletedAtUtc: null } as const;
  return {};
}

export const internalControlPlaneRoutes: FastifyPluginAsync = async (app) => {
  app.get("/internal/control-plane/summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;

    const [
      activeTenants,
      deletedTenants,
      activeUsers,
      activeCustomers,
      activeQuotes,
      aiAggregate,
      observedModels,
      latestValidation,
    ] = await Promise.all([
      app.prisma.tenant.count({ where: { deletedAtUtc: null } }),
      app.prisma.tenant.count({ where: { deletedAtUtc: { not: null } } }),
      app.prisma.user.count({ where: { deletedAtUtc: null } }),
      app.prisma.customer.count({ where: { deletedAtUtc: null } }),
      app.prisma.quote.count({ where: { deletedAtUtc: null } }),
      app.prisma.aiUsageEvent.aggregate({
        where: { deletedAtUtc: null },
        _count: { _all: true },
        _sum: { totalTokens: true, estimatedCostUsd: true },
      }),
      app.prisma.aiUsageEvent.groupBy({
        by: ["model"],
        where: { deletedAtUtc: null, model: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { model: "desc" } },
        take: 20,
      }),
      app.prisma.dataGovernanceValidationRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          schemaHash: true,
          baselineHash: true,
          modelCount: true,
          fieldCount: true,
          issueCount: true,
          createdAt: true,
        },
      }),
    ]);
    const liveValidation = validateDataGovernanceSchema();

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "CONTROL_PLANE_SUMMARY_VIEWED",
      metadata: {
        liveValidationStatus: liveValidation.status,
      },
    });

    return {
      generatedAtUtc: new Date(),
      configuredAiModel: app.env.OPENAI_MODEL,
      totals: {
        activeTenants,
        deletedTenants,
        activeUsers,
        activeCustomers,
        activeQuotes,
        aiRuns: aiAggregate._count._all ?? 0,
        aiTokens: aiAggregate._sum.totalTokens ?? 0,
        aiSpendUsd: Number(aiAggregate._sum.estimatedCostUsd ?? 0),
      },
      observedModels: observedModels.map((row) => ({
        model: row.model ?? "unknown",
        runCount: row._count._all ?? 0,
      })),
      liveValidation,
      latestValidation,
      mutationPolicy: {
        enabled: false,
        reason: "Tenant and policy mutations require step-up authentication, reason capture, and audited approval controls.",
      },
    };
  });

  app.get("/internal/control-plane/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = TenantListQuerySchema.parse(request.query);
    const where: Prisma.TenantWhereInput = {
      ...tenantLifecycleWhere(query.lifecycle),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { slug: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [tenants, total] = await app.prisma.$transaction([
      app.prisma.tenant.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          name: true,
          slug: true,
          primaryTrade: true,
          subscriptionStatus: true,
          subscriptionPlanCode: true,
          onboardingCompletedAtUtc: true,
          trialEndsAtUtc: true,
          subscriptionCurrentPeriodStartUtc: true,
          subscriptionCurrentPeriodEndUtc: true,
          createdAt: true,
          updatedAt: true,
          deletedAtUtc: true,
          _count: {
            select: {
              users: { where: { deletedAtUtc: null, user: { deletedAtUtc: null } } },
              customers: { where: { deletedAtUtc: null } },
              quotes: { where: { deletedAtUtc: null } },
              workPresets: { where: { deletedAtUtc: null } },
              aiUsageEvents: { where: { deletedAtUtc: null } },
            },
          },
        },
      }),
      app.prisma.tenant.count({ where }),
    ]);

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "TENANT_METADATA_LIST_VIEWED",
      targetType: "Tenant",
      metadata: {
        lifecycle: query.lifecycle,
        searchApplied: Boolean(query.search),
        limit: query.limit,
        offset: query.offset,
        resultCount: tenants.length,
      },
    });

    return {
      tenants,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      fieldsExcluded: [
        "owner emails",
        "customer records",
        "provider identifiers",
        "credentials",
        "raw prompts",
      ],
    };
  });

  app.get("/internal/control-plane/data-catalog", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = CatalogQuerySchema.parse(request.query);
    const catalog = getDataClassificationCatalog();
    const search = query.search?.toLowerCase();
    const models = catalog.models
      .map((model) => ({
        ...model,
        fields: model.fields.filter((field) => {
          if (query.classification && field.classification !== query.classification) return false;
          if (query.ragStatus && field.ragStatus !== query.ragStatus) return false;
          if (search && !`${model.model}.${field.field} ${field.type}`.toLowerCase().includes(search)) return false;
          return true;
        }),
      }))
      .filter((model) => model.fields.length > 0);

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "DATA_CLASSIFICATION_CATALOG_VIEWED",
      targetType: "PrismaSchema",
      metadata: {
        searchApplied: Boolean(query.search),
        classification: query.classification ?? null,
        ragStatus: query.ragStatus ?? null,
        resultModelCount: models.length,
        resultFieldCount: models.reduce((sum, model) => sum + model.fields.length, 0),
      },
    });

    return {
      ...catalog,
      models,
      filters: query,
    };
  });

  app.get("/internal/control-plane/rag-index", { ...RagIndexSummaryRateLimit, preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;

    const tenantIds = await app.prisma.tenant.findMany({ select: { id: true } });
    const summaries = await mapWithConcurrency(tenantIds, 4, ({ id: tenantId }) => withTenantRlsContext(
      app.prisma,
      tenantId,
      async (tx) => {
        const activeChunkWhere = {
          deletedAtUtc: null,
          document: { status: "ACTIVE" as const, deletedAtUtc: null },
        };
        const [
          documentCount,
          activeDocumentCount,
          deletedDocumentCount,
          chunkCount,
          activeChunkCount,
          deletedChunkCount,
          documentsByStatus,
          activeChunksByClassification,
          activeChunksBySourceType,
          latestDocument,
          latestChunk,
          indexJobsByStatus,
          successfulJobMetrics,
          oldestPendingJob,
        ] = await Promise.all([
          tx.aiRetrievalDocument.count(),
          tx.aiRetrievalDocument.count({ where: { status: "ACTIVE", deletedAtUtc: null } }),
          tx.aiRetrievalDocument.count({ where: { OR: [{ status: "DELETED" }, { deletedAtUtc: { not: null } }] } }),
          tx.aiRetrievalChunk.count(),
          tx.aiRetrievalChunk.count({ where: activeChunkWhere }),
          tx.aiRetrievalChunk.count({ where: { deletedAtUtc: { not: null } } }),
          tx.aiRetrievalDocument.groupBy({ by: ["status"], _count: { _all: true } }),
          tx.aiRetrievalChunk.groupBy({
            by: ["classification"],
            where: activeChunkWhere,
            _count: { _all: true },
          }),
          tx.aiRetrievalChunk.groupBy({
            by: ["sourceType"],
            where: activeChunkWhere,
            _count: { _all: true },
          }),
          tx.aiRetrievalDocument.findFirst({
            orderBy: { indexedAtUtc: "desc" },
            select: { indexedAtUtc: true, policyVersion: true },
          }),
          tx.aiRetrievalChunk.findFirst({
            orderBy: { indexedAtUtc: "desc" },
            select: { indexedAtUtc: true, policyVersion: true },
          }),
          tx.aiIndexJob.groupBy({
            by: ["status"],
            _count: { _all: true },
          }),
          tx.aiIndexJob.aggregate({
            where: { status: "SUCCEEDED" },
            _count: { _all: true },
            _sum: {
              lastChunkCount: true,
              lastEmbeddingCacheHitCount: true,
              lastDurationMs: true,
            },
          }),
          tx.aiIndexJob.findFirst({
            where: { status: "PENDING" },
            orderBy: [{ availableAtUtc: "asc" }, { createdAt: "asc" }],
            select: { availableAtUtc: true, createdAt: true },
          }),
        ]);
        return {
          documentCount,
          activeDocumentCount,
          deletedDocumentCount,
          chunkCount,
          activeChunkCount,
          deletedChunkCount,
          documentsByStatus,
          activeChunksByClassification,
          activeChunksBySourceType,
          indexJobsByStatus,
          successfulJobMetrics,
          oldestPendingJob,
          latestRecord: [latestDocument, latestChunk]
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .sort((left, right) => right.indexedAtUtc.getTime() - left.indexedAtUtc.getTime())[0] ?? null,
        };
      },
      RagIndexTransactionOptions,
    ));

    const documentCount = summaries.reduce((sum, summary) => sum + summary.documentCount, 0);
    const activeDocumentCount = summaries.reduce((sum, summary) => sum + summary.activeDocumentCount, 0);
    const deletedDocumentCount = summaries.reduce((sum, summary) => sum + summary.deletedDocumentCount, 0);
    const chunkCount = summaries.reduce((sum, summary) => sum + summary.chunkCount, 0);
    const activeChunkCount = summaries.reduce((sum, summary) => sum + summary.activeChunkCount, 0);
    const deletedChunkCount = summaries.reduce((sum, summary) => sum + summary.deletedChunkCount, 0);
    const sumGroupedCounts = <T extends string>(rows: readonly { key: T; count: number }[]) => rows.reduce<Record<string, number>>(
      (counts, row) => {
        counts[row.key] = (counts[row.key] ?? 0) + row.count;
        return counts;
      },
      {},
    );
    const documentsByStatus = sumGroupedCounts(summaries.flatMap((summary) => summary.documentsByStatus.map(
      (row) => ({ key: row.status, count: row._count._all ?? 0 }),
    )));
    const activeChunksByClassification = sumGroupedCounts(summaries.flatMap((summary) => summary.activeChunksByClassification.map(
      (row) => ({ key: row.classification, count: row._count._all ?? 0 }),
    )));
    const activeChunksBySourceType = Object.entries(sumGroupedCounts(summaries.flatMap((summary) => summary.activeChunksBySourceType.map(
      (row) => ({ key: row.sourceType, count: row._count._all ?? 0 }),
    ))))
      .map(([sourceType, count]) => ({ sourceType, chunkCount: count }))
      .sort((left, right) => right.chunkCount - left.chunkCount)
      .slice(0, 20);
    const indexJobsByStatus = sumGroupedCounts(summaries.flatMap((summary) => summary.indexJobsByStatus.map(
      (row) => ({ key: row.status, count: row._count._all ?? 0 }),
    )));
    const successfulJobCount = summaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._count._all ?? 0),
      0,
    );
    const indexedChunkCount = summaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastChunkCount ?? 0),
      0,
    );
    const embeddingCacheHitCount = summaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastEmbeddingCacheHitCount ?? 0),
      0,
    );
    const successfulJobDurationMs = summaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastDurationMs ?? 0),
      0,
    );
    const oldestPendingAtUtc = summaries
      .map((summary) => summary.oldestPendingJob)
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => row.availableAtUtc < row.createdAt ? row.availableAtUtc : row.createdAt)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const latestRecord = summaries.map((summary) => summary.latestRecord).filter(
      (row): row is NonNullable<typeof row> => Boolean(row),
    ).sort(
      (left, right) => right.indexedAtUtc.getTime() - left.indexedAtUtc.getTime(),
    )[0] ?? null;

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "RAG_INDEX_SUMMARY_VIEWED",
      targetType: "AiRetrievalIndex",
      metadata: {
        documentCount,
        activeDocumentCount,
        activeChunkCount,
      },
    });

    return {
      generatedAtUtc: new Date(),
      policyVersion: latestRecord?.policyVersion ?? null,
      totals: {
        documents: documentCount,
        activeDocuments: activeDocumentCount,
        deletedDocuments: deletedDocumentCount,
        chunks: chunkCount,
        activeChunks: activeChunkCount,
        deletedChunks: deletedChunkCount,
      },
      documentsByStatus,
      activeChunksByClassification,
      activeChunksBySourceType,
      indexingQueue: {
        jobsByStatus: indexJobsByStatus,
        successfulJobs: successfulJobCount,
        averageSuccessfulDurationMs: successfulJobCount > 0
          ? Number((successfulJobDurationMs / successfulJobCount).toFixed(1))
          : null,
        embeddingCacheHitRate: indexedChunkCount > 0
          ? Number((embeddingCacheHitCount / indexedChunkCount).toFixed(4))
          : null,
        oldestPendingAtUtc,
      },
      latestIndexedAtUtc: latestRecord?.indexedAtUtc ?? null,
      fieldsExcluded: [
        "chunk content",
        "embedding vectors",
        "source row ids",
        "tenant ids",
        "customer data",
      ],
    };
  });

  app.get("/internal/control-plane/permissions", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const roles = ["owner", "admin", "member"] as const;
    const roleCapabilities = Object.fromEntries(
      roles.map((role) => {
        const capabilities = capabilitiesForRole(role);
        return [role, CAPABILITIES.filter((capability) => capabilities.has(capability))];
      }),
    );

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "PERMISSION_POLICY_VIEWED",
      targetType: "WorkspaceRolePolicy",
      metadata: { roleCount: roles.length, capabilityCount: CAPABILITIES.length },
    });

    return {
      capabilities: CAPABILITIES,
      roles: roleCapabilities,
      operatorCapabilities: {
        viewPlatformSummary: true,
        viewTenantMetadata: true,
        viewDataClassification: true,
        runDataValidation: true,
        viewRawTenantRows: false,
        mutateTenantState: false,
        mutateClassificationPolicy: false,
        changeProviderCredentials: false,
      },
    };
  });

  app.post(
    "/internal/control-plane/validation-runs",
    { ...ValidationRateLimit, preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = requireSuperuserAccess(request, reply);
      if (!claims) return reply;
      const validation = validateDataGovernanceSchema();

      const run = await app.prisma.$transaction(async (tx) => {
        const created = await tx.dataGovernanceValidationRun.create({
          data: {
            actorUserId: claims.userId,
            requestId: request.id.slice(0, 128),
            schemaHash: validation.schemaHash,
            baselineHash: validation.baselineHash,
            policyVersion: validation.policyVersion,
            status: validation.status,
            modelCount: validation.modelCount,
            fieldCount: validation.fieldCount,
            issueCount: validation.issueCount,
            issues: validation.issues as unknown as Prisma.InputJsonValue,
          },
        });
        await recordSuperuserAuditEvent(tx, {
          actorUserId: claims.userId,
          requestId: request.id,
          action: "DATA_GOVERNANCE_VALIDATION_RUN",
          targetType: "PrismaSchema",
          metadata: {
            validationRunId: created.id,
            status: validation.status,
            modelCount: validation.modelCount,
            fieldCount: validation.fieldCount,
            issueCount: validation.issueCount,
          },
        });
        return created;
      });

      return reply.code(201).send({
        run: {
          id: run.id,
          createdAt: run.createdAt,
          ...validation,
        },
      });
    },
  );

  app.get("/internal/control-plane/validation-runs", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = BoundedListQuerySchema.parse(request.query);
    const runs = await app.prisma.dataGovernanceValidationRun.findMany({
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: {
        id: true,
        actorUserId: true,
        schemaHash: true,
        baselineHash: true,
        policyVersion: true,
        status: true,
        modelCount: true,
        fieldCount: true,
        issueCount: true,
        issues: true,
        createdAt: true,
      },
    });

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "DATA_GOVERNANCE_VALIDATION_HISTORY_VIEWED",
      targetType: "DataGovernanceValidationRun",
      metadata: { limit: query.limit, resultCount: runs.length },
    });
    return { runs };
  });

  app.get("/internal/control-plane/audit-events", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    const query = BoundedListQuerySchema.parse(request.query);
    const events = await app.prisma.superuserAuditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: {
        id: true,
        requestId: true,
        action: true,
        targetType: true,
        targetRefHash: true,
        metadata: true,
        createdAt: true,
        actorUser: {
          select: { id: true, email: true, fullName: true },
        },
      },
    });
    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "SUPERUSER_AUDIT_HISTORY_VIEWED",
      targetType: "SuperuserAuditEvent",
      metadata: { limit: query.limit, resultCount: events.length },
    });
    return { events };
  });
};
