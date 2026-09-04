import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { CAPABILITIES, capabilitiesForRole } from "../lib/access-policy";
import { mapWithConcurrency } from "../lib/bounded-concurrency";
import { isAiRagEnabledForTenant, summarizeAiRagRollout } from "../lib/ai-rag-rollout";
import {
  getDataClassificationCatalog,
  validateDataGovernanceSchema,
} from "../lib/data-governance-catalog";
import { resolveRuntimeReleaseSha } from "../lib/release-identity";
import {
  recordSuperuserAuditEvent,
  requireSuperuserAccess,
} from "../lib/superuser-access";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  deriveQuickBooksSetupReadiness,
  QUICKBOOKS_SETUP_CHECKLIST_VERSION,
} from "../services/quickbooks-setup";
import { isQuickBooksConfigured, isQuickBooksWebhookConfigured } from "../services/quickbooks";
import {
  loadWorkerHeartbeatFleet,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  serializeWorkerHeartbeatFleet,
} from "../services/worker-heartbeats";

const TenantLifecycleSchema = z.enum(["active", "deleted", "all"]);
const TenantQuickBooksSchema = z.enum(["all", "connected", "confirmed", "attention", "not_connected"]);
const TenantListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  search: z.string().trim().min(1).max(120).optional(),
  lifecycle: TenantLifecycleSchema.default("active"),
  quickBooks: TenantQuickBooksSchema.default("all"),
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

type QuickBooksControlPlaneRow = Readonly<{
  tenantId: string;
  status: string;
  environment: string;
  setupConfirmedAtUtc: Date | null;
  setupConfirmedByTenantUserId: string | null;
  setupChecklistVersion: string | null;
  connectedAtUtc: Date;
  lastSyncAtUtc: Date | null;
  lastWebhookAtUtc: Date | null;
  accountingScopeGranted: boolean;
  credentialsAvailable: boolean;
  realmBindingActive: boolean;
  cdcCursorInitialized: boolean;
  customerMaps: number;
  itemMaps: number;
  invoiceSyncs: number;
}>;

type QuickBooksOperationalRow = Readonly<{
  webhookOutstandingCount: number;
  webhookDeadCount: number;
  oldestWebhookOutstandingAtUtc: Date | null;
  reconciliationRequiredCount: number;
  oldestReconciliationRequiredAtUtc: Date | null;
  cdcCursorCount: number;
  cdcTerminalCount: number;
  cdcOverdueCount: number;
  oldestCdcChangedSinceUtc: Date | null;
  connectionRevocationPendingCount: number;
  connectionRevocationDeadCount: number;
  oldestConnectionRevocationPendingAtUtc: Date | null;
  orphanRevocationPendingCount: number;
  orphanRevocationDeadCount: number;
  oldestOrphanRevocationPendingAtUtc: Date | null;
}>;

type QuickBooksOperationalAggregate = Readonly<{
  webhookOutstandingCount: number;
  webhookDeadCount: number;
  oldestWebhookOutstandingAgeMs: number | null;
  reconciliationRequiredCount: number;
  oldestReconciliationRequiredAgeMs: number | null;
  cdcCursorCount: number;
  cdcTerminalCount: number;
  cdcOverdueCount: number;
  maximumCdcLagMs: number | null;
  connectionRevocationPendingCount: number;
  connectionRevocationDeadCount: number;
  oldestConnectionRevocationPendingAgeMs: number | null;
  orphanRevocationPendingCount: number;
  orphanRevocationDeadCount: number;
  oldestOrphanRevocationPendingAgeMs: number | null;
}>;

const ControlPlaneTenantSelect = Prisma.validator<Prisma.TenantSelect>()({
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
});

async function loadQuickBooksControlPlaneRow(
  prisma: PrismaClient,
  tenantId: string,
): Promise<QuickBooksControlPlaneRow | null> {
  const rows = await withTenantRlsContext(prisma, tenantId, (transaction) =>
    transaction.$queryRaw<QuickBooksControlPlaneRow[]>(Prisma.sql`
      SELECT
        connection."tenantId",
        connection."status"::text AS "status",
        connection."environment",
        connection."setupConfirmedAtUtc",
        connection."setupConfirmedByTenantUserId",
        connection."setupChecklistVersion",
        connection."connectedAtUtc",
        connection."lastSyncAtUtc",
        connection."lastWebhookAtUtc",
        (${"com.intuit.quickbooks.accounting"} = ANY(connection."scopes")) AS "accountingScopeGranted",
        (
          connection."accessTokenEncrypted" IS NOT NULL
          AND connection."refreshTokenEncrypted" IS NOT NULL
          AND connection."accessTokenExpiresAtUtc" IS NOT NULL
        ) AS "credentialsAvailable",
        EXISTS (
          SELECT 1 FROM "QuickBooksRealmBinding" binding
          WHERE binding."tenantId" = connection."tenantId"
            AND binding."quickBooksConnectionId" = connection."id"
            AND binding."active" = true
        ) AS "realmBindingActive",
        EXISTS (
          SELECT 1 FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = connection."tenantId"
            AND cursor."quickBooksConnectionId" = connection."id"
        ) AS "cdcCursorInitialized",
        (
          SELECT count(*)::int FROM "QuickBooksCustomerMap" customer_map
          WHERE customer_map."tenantId" = connection."tenantId"
            AND customer_map."quickBooksConnectionId" = connection."id"
            AND customer_map."deletedAtUtc" IS NULL
        ) AS "customerMaps",
        (
          SELECT count(*)::int FROM "QuickBooksItemMap" item_map
          WHERE item_map."tenantId" = connection."tenantId"
            AND item_map."quickBooksConnectionId" = connection."id"
            AND item_map."deletedAtUtc" IS NULL
        ) AS "itemMaps",
        (
          SELECT count(*)::int FROM "QuickBooksInvoiceOperation" invoice_operation
          WHERE invoice_operation."tenantId" = connection."tenantId"
            AND invoice_operation."quickBooksConnectionId" = connection."id"
            AND invoice_operation."archivedAtUtc" IS NULL
        ) AS "invoiceSyncs"
      FROM "QuickBooksConnection" connection
      WHERE connection."tenantId" = ${tenantId}
        AND connection."deletedAtUtc" IS NULL
      LIMIT 1
    `),
  );
  return rows[0] ?? null;
}

async function loadQuickBooksOperationalRow(
  prisma: PrismaClient,
  tenantId: string,
  now: Date,
): Promise<QuickBooksOperationalRow> {
  const rows = await withTenantRlsContext(prisma, tenantId, (transaction) =>
    transaction.$queryRaw<QuickBooksOperationalRow[]>(Prisma.sql`
      SELECT
        (
          SELECT count(*)::int
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" IN ('RECEIVED', 'PROCESSING', 'FAILED')
        ) AS "webhookOutstandingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" = 'DEAD'
        ) AS "webhookDeadCount",
        (
          SELECT min(event."receivedAtUtc")
          FROM "QuickBooksWebhookEvent" event
          WHERE event."tenantId" = ${tenantId}
            AND event."status" IN ('RECEIVED', 'PROCESSING', 'FAILED')
        ) AS "oldestWebhookOutstandingAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksInvoiceOperation" operation
          WHERE operation."tenantId" = ${tenantId}
            AND operation."status" = 'RECONCILIATION_REQUIRED'
            AND operation."archivedAtUtc" IS NULL
        ) AS "reconciliationRequiredCount",
        (
          SELECT min(COALESCE(operation."failedAtUtc", operation."updatedAt"))
          FROM "QuickBooksInvoiceOperation" operation
          WHERE operation."tenantId" = ${tenantId}
            AND operation."status" = 'RECONCILIATION_REQUIRED'
            AND operation."archivedAtUtc" IS NULL
        ) AS "oldestReconciliationRequiredAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
        ) AS "cdcCursorCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NOT NULL
        ) AS "cdcTerminalCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
            AND (cursor."nextAttemptAtUtc" IS NULL OR cursor."nextAttemptAtUtc" <= ${now})
        ) AS "cdcOverdueCount",
        (
          SELECT min(cursor."changedSinceUtc")
          FROM "QuickBooksCdcCursor" cursor
          WHERE cursor."tenantId" = ${tenantId}
            AND cursor."terminalAtUtc" IS NULL
        ) AS "oldestCdcChangedSinceUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'REVOCATION_PENDING'
        ) AS "connectionRevocationPendingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'ERROR'
            AND connection."lastError" = 'QUICKBOOKS_TOKEN_REVOCATION_DEAD'
        ) AS "connectionRevocationDeadCount",
        (
          SELECT min(COALESCE(
            connection."revocationPendingAtUtc",
            connection."disconnectRequestedAtUtc",
            connection."updatedAt"
          ))
          FROM "QuickBooksConnection" connection
          WHERE connection."tenantId" = ${tenantId}
            AND connection."deletedAtUtc" IS NULL
            AND connection."status" = 'REVOCATION_PENDING'
        ) AS "oldestConnectionRevocationPendingAtUtc",
        (
          SELECT count(*)::int
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" IN ('PENDING', 'PROCESSING')
        ) AS "orphanRevocationPendingCount",
        (
          SELECT count(*)::int
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" = 'DEAD'
        ) AS "orphanRevocationDeadCount",
        (
          SELECT min(revocation."createdAt")
          FROM "QuickBooksOrphanCredentialRevocation" revocation
          WHERE revocation."tenantId" = ${tenantId}
            AND revocation."status" IN ('PENDING', 'PROCESSING')
        ) AS "oldestOrphanRevocationPendingAtUtc"
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("QuickBooks operational metrics query returned no row.");
  return row;
}

function ageMs(now: Date, value: Date | null): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

function aggregateQuickBooksOperationalRows(
  rows: readonly QuickBooksOperationalRow[],
  now: Date,
): QuickBooksOperationalAggregate {
  const oldestDate = (values: readonly (Date | null)[]) => values.reduce<Date | null>(
    (oldest, value) => !value || (oldest && oldest <= value) ? oldest : value,
    null,
  );
  return {
    webhookOutstandingCount: rows.reduce((total, row) => total + row.webhookOutstandingCount, 0),
    webhookDeadCount: rows.reduce((total, row) => total + row.webhookDeadCount, 0),
    oldestWebhookOutstandingAgeMs: ageMs(now, oldestDate(rows.map((row) => row.oldestWebhookOutstandingAtUtc))),
    reconciliationRequiredCount: rows.reduce((total, row) => total + row.reconciliationRequiredCount, 0),
    oldestReconciliationRequiredAgeMs: ageMs(now, oldestDate(rows.map((row) => row.oldestReconciliationRequiredAtUtc))),
    cdcCursorCount: rows.reduce((total, row) => total + row.cdcCursorCount, 0),
    cdcTerminalCount: rows.reduce((total, row) => total + row.cdcTerminalCount, 0),
    cdcOverdueCount: rows.reduce((total, row) => total + row.cdcOverdueCount, 0),
    maximumCdcLagMs: ageMs(now, oldestDate(rows.map((row) => row.oldestCdcChangedSinceUtc))),
    connectionRevocationPendingCount: rows.reduce((total, row) => total + row.connectionRevocationPendingCount, 0),
    connectionRevocationDeadCount: rows.reduce((total, row) => total + row.connectionRevocationDeadCount, 0),
    oldestConnectionRevocationPendingAgeMs: ageMs(
      now,
      oldestDate(rows.map((row) => row.oldestConnectionRevocationPendingAtUtc)),
    ),
    orphanRevocationPendingCount: rows.reduce((total, row) => total + row.orphanRevocationPendingCount, 0),
    orphanRevocationDeadCount: rows.reduce((total, row) => total + row.orphanRevocationDeadCount, 0),
    oldestOrphanRevocationPendingAgeMs: ageMs(
      now,
      oldestDate(rows.map((row) => row.oldestOrphanRevocationPendingAtUtc)),
    ),
  };
}

export const internalControlPlaneRoutes: FastifyPluginAsync = async (app) => {
  const apiReleaseSha = resolveRuntimeReleaseSha();

  app.get("/internal/control-plane/summary", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    reply.header("Cache-Control", "private, no-store");

    const [
      activeTenants,
      deletedTenants,
      activeUsers,
      activeCustomers,
      activeQuotes,
      activeTenantRows,
      aiAggregate,
      observedModels,
      latestValidation,
      quickBooksWorkerFleet,
    ] = await Promise.all([
      app.prisma.tenant.count({ where: { deletedAtUtc: null } }),
      app.prisma.tenant.count({ where: { deletedAtUtc: { not: null } } }),
      app.prisma.user.count({ where: { deletedAtUtc: null } }),
      app.prisma.customer.count({ where: { deletedAtUtc: null } }),
      app.prisma.quote.count({ where: { deletedAtUtc: null } }),
      app.prisma.tenant.findMany({ where: { deletedAtUtc: null }, select: { id: true } }),
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
      loadWorkerHeartbeatFleet(
        app.prisma,
        QUICKBOOKS_RECONCILIATION_WORKER_KEY,
        { apiReleaseSha, requireReleaseIdentity: app.env.NODE_ENV === "production" || apiReleaseSha !== null },
      ),
    ]);
    const quickBooksRuntime = {
      providerConfigured: isQuickBooksConfigured(app.env),
      providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
      oauthOnlyMode: app.env.QUICKBOOKS_OAUTH_ONLY_MODE,
      webhookConfigured: isQuickBooksWebhookConfigured(app.env),
      hostedPaymentsEnabled: app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED,
      reconciliationWorkerEnabled: app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
      reconciliationWorkerHealthy: quickBooksWorkerFleet.ready,
      cdcWorkerEnabled: app.env.QUICKBOOKS_CDC_WORKER_ENABLED,
      environment: app.env.QUICKBOOKS_ENVIRONMENT,
    } as const;
    const generatedAtUtc = new Date();
    const [quickBooksRows, quickBooksOperationalRows] = await Promise.all([
      mapWithConcurrency(
        activeTenantRows,
        4,
        ({ id }) => loadQuickBooksControlPlaneRow(app.prisma, id),
      ),
      mapWithConcurrency(
        activeTenantRows,
        4,
        ({ id }) => loadQuickBooksOperationalRow(app.prisma, id, generatedAtUtc),
      ),
    ]);
    const quickBooksOperations = aggregateQuickBooksOperationalRows(
      quickBooksOperationalRows,
      generatedAtUtc,
    );
    const quickBooksSetups = quickBooksRows.map((connection) => connection
      ? deriveQuickBooksSetupReadiness(quickBooksRuntime, {
          status: connection.status,
          environment: connection.environment,
          scopes: [],
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
          setupConfirmedAtUtc: connection.setupConfirmedAtUtc,
          setupConfirmedByTenantUserId: connection.setupConfirmedByTenantUserId,
          setupChecklistVersion: connection.setupChecklistVersion,
          realmBinding: null,
          cdcCursor: null,
          accountingScopeGranted: connection.accountingScopeGranted,
          credentialsAvailable: connection.credentialsAvailable,
          realmBindingActive: connection.realmBindingActive,
          cdcCursorInitialized: connection.cdcCursorInitialized,
        })
      : deriveQuickBooksSetupReadiness(quickBooksRuntime, null));
    const quickBooksConnectedTenants = quickBooksRows.filter((row) => row?.status === "CONNECTED").length;
    const quickBooksConfirmedTenants = quickBooksSetups.filter((setup) => setup.confirmed).length;
    const quickBooksReadyTenants = quickBooksSetups.filter((setup) => setup.ready).length;
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
      generatedAtUtc,
      configuredAiModel: app.env.OPENAI_MODEL,
      totals: {
        activeTenants,
        deletedTenants,
        activeUsers,
        activeCustomers,
        activeQuotes,
        quickBooksConnectedTenants,
        quickBooksConfirmedTenants,
        quickBooksReadyTenants,
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
      workers: {
        quickBooksReconciliation: serializeWorkerHeartbeatFleet(quickBooksWorkerFleet),
        quickBooksOperations,
      },
      mutationPolicy: {
        enabled: false,
        reason: "Tenant and policy mutations require step-up authentication, reason capture, and audited approval controls.",
      },
    };
  });

  app.get("/internal/control-plane/tenants", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = requireSuperuserAccess(request, reply);
    if (!claims) return reply;
    reply.header("Cache-Control", "private, no-store");
    const query = TenantListQuerySchema.parse(request.query);
    const where: Prisma.TenantWhereInput = {
      AND: [
        tenantLifecycleWhere(query.lifecycle),
        query.search
          ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { slug: { contains: query.search, mode: "insensitive" } },
            ],
          }
          : {},
      ],
    };
    const baseTotal = await app.prisma.tenant.count({ where });
    if (query.quickBooks !== "all" && baseTotal > 5_000) {
      return reply.code(422).send({
        error: "Refine the tenant search before filtering QuickBooks setup state.",
        code: "TENANT_FILTER_SCOPE_TOO_BROAD",
      });
    }
    const candidateTenants = query.quickBooks === "all"
      ? await app.prisma.tenant.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit,
          skip: query.offset,
          select: ControlPlaneTenantSelect,
        })
      : await app.prisma.tenant.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 5_000,
          select: ControlPlaneTenantSelect,
        });
    const quickBooksWorkerFleet = await loadWorkerHeartbeatFleet(
      app.prisma,
      QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      { apiReleaseSha, requireReleaseIdentity: app.env.NODE_ENV === "production" || apiReleaseSha !== null },
    );
    const quickBooksRuntime = {
      providerConfigured: isQuickBooksConfigured(app.env),
      providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
      webhookConfigured: isQuickBooksWebhookConfigured(app.env),
      hostedPaymentsEnabled: app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED,
      reconciliationWorkerEnabled: app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
      reconciliationWorkerHealthy: quickBooksWorkerFleet.ready,
      cdcWorkerEnabled: app.env.QUICKBOOKS_CDC_WORKER_ENABLED,
      environment: app.env.QUICKBOOKS_ENVIRONMENT,
    } as const;
    const candidateQuickBooksRows = await mapWithConcurrency(
      candidateTenants,
      4,
      (tenant) => loadQuickBooksControlPlaneRow(app.prisma, tenant.id),
    );
    const projectedCandidates = candidateTenants.map((tenant, index) => {
      const connection = candidateQuickBooksRows[index] ?? null;
      const setup = deriveQuickBooksSetupReadiness(quickBooksRuntime, connection ? {
        status: connection.status,
        environment: connection.environment,
        scopes: [],
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenExpiresAtUtc: null,
        setupConfirmedAtUtc: connection.setupConfirmedAtUtc,
        setupConfirmedByTenantUserId: connection.setupConfirmedByTenantUserId,
        setupChecklistVersion: connection.setupChecklistVersion,
        realmBinding: null,
        cdcCursor: null,
        accountingScopeGranted: connection.accountingScopeGranted,
        credentialsAvailable: connection.credentialsAvailable,
        realmBindingActive: connection.realmBindingActive,
        cdcCursorInitialized: connection.cdcCursorInitialized,
      } : null);
      return { tenant, connection, setup };
    });
    const filteredCandidates = query.quickBooks === "all"
      ? projectedCandidates
      : projectedCandidates.filter(({ connection, setup }) => {
          if (query.quickBooks === "connected") return connection?.status === "CONNECTED";
          if (query.quickBooks === "confirmed") return setup.confirmed;
          if (query.quickBooks === "attention") {
            return Boolean(connection) && setup.phase !== "CONFIRMED";
          }
          return !connection || connection.status === "DISCONNECTED";
        });
    const selectedCandidates = query.quickBooks === "all"
      ? filteredCandidates
      : filteredCandidates.slice(query.offset, query.offset + query.limit);
    const total = query.quickBooks === "all" ? baseTotal : filteredCandidates.length;

    await recordSuperuserAuditEvent(app.prisma, {
      actorUserId: claims.userId,
      requestId: request.id,
      action: "TENANT_METADATA_LIST_VIEWED",
      targetType: "Tenant",
      metadata: {
        lifecycle: query.lifecycle,
        quickBooks: query.quickBooks,
        searchApplied: Boolean(query.search),
        limit: query.limit,
        offset: query.offset,
        resultCount: selectedCandidates.length,
      },
    });

    return {
      tenants: selectedCandidates.map(({ tenant, connection, setup }) => {
        return {
          ...tenant,
          quickBooks: {
            present: Boolean(connection),
            status: connection?.status ?? null,
            setupPhase: setup.phase,
            setupConfirmedAtUtc: setup.confirmedAtUtc,
            environment: connection?.environment ?? null,
            connectedAtUtc: connection?.connectedAtUtc ?? null,
            lastSyncAtUtc: connection?.lastSyncAtUtc ?? null,
            lastWebhookAtUtc: connection?.lastWebhookAtUtc ?? null,
            counts: {
              customerMaps: connection?.customerMaps ?? 0,
              itemMaps: connection?.itemMaps ?? 0,
              invoiceSyncs: connection?.invoiceSyncs ?? 0,
            },
          },
        };
      }),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
      fieldsExcluded: [
        "owner emails",
        "customer records",
        "provider identifiers",
        "company names",
        "provider scopes and raw errors",
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

    const tenantIds = await app.prisma.tenant.findMany({
      where: { deletedAtUtc: null },
      select: { id: true },
    });
    const rollout = summarizeAiRagRollout(env, tenantIds.map(({ id }) => id));
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
          tx.aiRetrievalDocument.count({ where: { tenantId } }),
          tx.aiRetrievalDocument.count({ where: { tenantId, status: "ACTIVE", deletedAtUtc: null } }),
          tx.aiRetrievalDocument.count({ where: { tenantId, OR: [{ status: "DELETED" }, { deletedAtUtc: { not: null } }] } }),
          tx.aiRetrievalChunk.count({ where: { tenantId } }),
          tx.aiRetrievalChunk.count({ where: { tenantId, ...activeChunkWhere } }),
          tx.aiRetrievalChunk.count({ where: { tenantId, deletedAtUtc: { not: null } } }),
          tx.aiRetrievalDocument.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
          tx.aiRetrievalChunk.groupBy({
            by: ["classification"],
            where: { tenantId, ...activeChunkWhere },
            _count: { _all: true },
          }),
          tx.aiRetrievalChunk.groupBy({
            by: ["sourceType"],
            where: { tenantId, ...activeChunkWhere },
            _count: { _all: true },
          }),
          tx.aiRetrievalDocument.findFirst({
            where: { tenantId },
            orderBy: { indexedAtUtc: "desc" },
            select: { indexedAtUtc: true, policyVersion: true },
          }),
          tx.aiRetrievalChunk.findFirst({
            where: { tenantId },
            orderBy: { indexedAtUtc: "desc" },
            select: { indexedAtUtc: true, policyVersion: true },
          }),
          tx.aiIndexJob.groupBy({
            by: ["status"],
            where: { tenantId },
            _count: { _all: true },
          }),
          tx.aiIndexJob.aggregate({
            where: { tenantId, status: "SUCCEEDED" },
            _count: { _all: true },
            _sum: {
              lastChunkCount: true,
              lastEmbeddingCacheHitCount: true,
              lastDurationMs: true,
            },
          }),
          tx.aiIndexJob.findFirst({
            where: { tenantId, status: "PENDING" },
            orderBy: [{ availableAtUtc: "asc" }, { createdAt: "asc" }],
            select: { availableAtUtc: true, createdAt: true },
          }),
        ]);
        return {
          rolloutEnabled: isAiRagEnabledForTenant(env, tenantId),
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
    const rolloutEnabledSummaries = summaries.filter((summary) => summary.rolloutEnabled);
    const outOfRolloutSummaries = summaries.filter((summary) => !summary.rolloutEnabled);
    const indexJobsByStatus = sumGroupedCounts(rolloutEnabledSummaries.flatMap((summary) => summary.indexJobsByStatus.map(
      (row) => ({ key: row.status, count: row._count._all ?? 0 }),
    )));
    const outOfRolloutJobsByStatus = sumGroupedCounts(outOfRolloutSummaries.flatMap((summary) => summary.indexJobsByStatus.map(
      (row) => ({ key: row.status, count: row._count._all ?? 0 }),
    )));
    const successfulJobCount = rolloutEnabledSummaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._count._all ?? 0),
      0,
    );
    const indexedChunkCount = rolloutEnabledSummaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastChunkCount ?? 0),
      0,
    );
    const embeddingCacheHitCount = rolloutEnabledSummaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastEmbeddingCacheHitCount ?? 0),
      0,
    );
    const successfulJobDurationMs = rolloutEnabledSummaries.reduce(
      (sum, summary) => sum + (summary.successfulJobMetrics._sum.lastDurationMs ?? 0),
      0,
    );
    const oldestPendingAtUtc = rolloutEnabledSummaries
      .map((summary) => summary.oldestPendingJob)
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => row.availableAtUtc < row.createdAt ? row.availableAtUtc : row.createdAt)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const outOfRolloutOldestPendingAtUtc = outOfRolloutSummaries
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
        rolloutMode: rollout.mode,
        enabledActiveTenantCount: rollout.enabledActiveTenantCount,
        exposedActiveTenantCount: rollout.exposedActiveTenantCount,
      },
    });

    return {
      generatedAtUtc: new Date(),
      rollout: {
        ...rollout,
        inlineRefreshEnabled: env.AI_INDEX_INLINE_REFRESH,
        workerEnabled: env.ENABLE_AI_INDEX_WORKER,
      },
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
        scope: "rollout_enabled_active_tenants",
        activeTenantCount: rolloutEnabledSummaries.length,
        jobsByStatus: indexJobsByStatus,
        successfulJobs: successfulJobCount,
        averageSuccessfulDurationMs: successfulJobCount > 0
          ? Number((successfulJobDurationMs / successfulJobCount).toFixed(1))
          : null,
        embeddingCacheHitRate: indexedChunkCount > 0
          ? Number((embeddingCacheHitCount / indexedChunkCount).toFixed(4))
          : null,
        oldestPendingAtUtc,
        outOfRollout: {
          activeTenantCount: outOfRolloutSummaries.length,
          jobsByStatus: outOfRolloutJobsByStatus,
          oldestPendingAtUtc: outOfRolloutOldestPendingAtUtc,
          expectedWhileDisabled: true,
        },
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
