import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITIES, capabilitiesForRole } from "../lib/access-policy";
import {
  getDataClassificationCatalog,
  validateDataGovernanceSchema,
} from "../lib/data-governance-catalog";
import {
  recordSuperuserAuditEvent,
  requireSuperuserAccess,
} from "../lib/superuser-access";

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
