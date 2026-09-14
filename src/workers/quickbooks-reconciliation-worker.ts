import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { assertAiRetrievalRlsReady, withTenantRlsContext } from "../lib/tenant-rls";
import {
  getSerializedQuickBooksAccessToken,
  retryQuickBooksRevocation,
} from "../services/quickbooks-credentials";
import {
  QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM,
  recoverQuickBooksChanges,
} from "../services/quickbooks-cdc";
import {
  runQuickBooksRetentionForTenant,
  runQuickBooksUnknownRealmQuarantineRetention,
} from "../services/quickbooks-retention";
import { nextQuickBooksWorkerScanAt, visitQuickBooksWorkerTenantPage } from "../services/quickbooks-worker-scheduler";
import {
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
  type WorkerHeartbeatStatus,
} from "../services/worker-heartbeats";
import { processQuickBooksWebhookForTenant } from "../services/quickbooks-webhook-processing";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const QUICKBOOKS_REVOCATION_SCAN_INTERVAL_MS = 5_000;
const QUICKBOOKS_CDC_SCAN_INTERVAL_MS = 15_000;
const QUICKBOOKS_RETENTION_SCAN_INTERVAL_MS = 60 * 60 * 1_000;
const QUICKBOOKS_ACTIVE_TICK_PAUSE_MS = 100;
const QUICKBOOKS_IDLE_TICK_PAUSE_MS = 1_000;
const QUICKBOOKS_HEARTBEAT_REFRESH_MS = 15_000;
const WORKER_STARTED_AT_UTC = new Date();
const WORKER_INSTANCE_REF_HASH = createHash("sha256")
  .update(randomUUID(), "utf8")
  .digest("hex");
let currentCycleStartedAtUtc = WORKER_STARTED_AT_UTC;
let lastHeartbeatWriteAt = 0;

async function persistWorkerHeartbeat(
  status: WorkerHeartbeatStatus,
  metrics: Prisma.InputJsonValue = {},
  options: { force?: boolean; lastCycleDurationMs?: number | null } = {},
) {
  const now = new Date();
  if (!options.force && now.getTime() - lastHeartbeatWriteAt < QUICKBOOKS_HEARTBEAT_REFRESH_MS) return;
  await recordWorkerHeartbeat(prisma, {
    workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
    instanceRefHash: WORKER_INSTANCE_REF_HASH,
    status,
    startedAtUtc: WORKER_STARTED_AT_UTC,
    cycleStartedAtUtc: currentCycleStartedAtUtc,
    heartbeatAtUtc: now,
    lastCycleDurationMs: options.lastCycleDurationMs,
    metrics,
  });
  lastHeartbeatWriteAt = now.getTime();
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function tenantRefHash(tenantId: string) {
  return createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 16);
}

function writeWorkerLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, boolean | number | string>> = {},
) {
  const record = JSON.stringify({
    level,
    event,
    workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
    occurredAtUtc: new Date().toISOString(),
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${record}\n`);
}

function recordProviderWorkflowDuration(
  metrics: {
    providerWorkflowCount: number;
    providerWorkflowTotalDurationMs: number;
    providerWorkflowMaxDurationMs: number;
  },
  startedAtMs: number,
) {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  metrics.providerWorkflowCount += 1;
  metrics.providerWorkflowTotalDurationMs += durationMs;
  metrics.providerWorkflowMaxDurationMs = Math.max(metrics.providerWorkflowMaxDurationMs, durationMs);
}

async function processTenant(tenantId: string) {
  const outcome = await processQuickBooksWebhookForTenant({ prisma, runtimeEnv: env, tenantId });
  if (outcome.failureCode) {
    writeWorkerLog("warn", "quickbooks_reconciliation_work_item_failed", {
      tenantRefHash: tenantRefHash(tenantId),
      failureCode: outcome.failureCode,
      outcome: outcome.status,
    });
  }
  return outcome;
}

async function inspectDueWebhookBacklog(tenantId: string) {
  return withTenantRlsContext(prisma, tenantId, async (transaction) => {
    const now = new Date();
    const dueWhere = {
      tenantId,
      quickBooksConnectionId: { not: null },
      entityId: { not: null },
      OR: [
        { status: "RECEIVED" as const },
        { status: "FAILED" as const, nextAttemptAtUtc: { lte: now } },
        { status: "PROCESSING" as const, claimExpiresAtUtc: { lte: now } },
      ],
    };
    const [dueCount, oldest] = await Promise.all([
      transaction.quickBooksWebhookEvent.count({ where: dueWhere }),
      transaction.quickBooksWebhookEvent.findFirst({
        where: dueWhere,
        orderBy: [{ receivedAtUtc: "asc" }, { id: "asc" }],
        select: { receivedAtUtc: true },
      }),
    ]);
    return { dueCount, oldestReceivedAtUtc: oldest?.receivedAtUtc ?? null };
  });
}

async function run() {
  if (!env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED || !env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
    throw new Error("QuickBooks reconciliation worker is rollout-gated and default-off.");
  }
  await assertAiRetrievalRlsReady(prisma, { requireRuntimeRole: env.NODE_ENV === "production" });
  await persistWorkerHeartbeat("STARTING", { rolloutEnabled: true }, { force: true });
  let webhookAfterTenantId: string | null = null;
  let revocationAfterTenantId: string | null = null;
  let cdcAfterTenantId: string | null = null;
  let retentionAfterTenantId: string | null = null;
  let nextRevocationScanAt = 0;
  let nextCdcScanAt = 0;
  let nextRetentionScanAt = 0;
  const loadTenantPage = (afterTenantId: string | null, take: number) => prisma.tenant.findMany({
    where: {
      deletedAtUtc: null,
      ...(afterTenantId ? { id: { gt: afterTenantId } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" as const },
    take,
  });

  while (!stopping) {
    const tickStartedAt = Date.now();
    currentCycleStartedAtUtc = new Date(tickStartedAt);
    await persistWorkerHeartbeat("RUNNING", { phase: "cycle_start" }, { force: true });
    const metrics = {
      processed: 0,
      failed: 0,
      dead: 0,
      dueTenantCount: 0,
      dueEventCount: 0,
      oldestBacklogAgeMs: 0,
      failureCodes: {} as Record<string, number>,
      providerWorkflowCount: 0,
      providerWorkflowTotalDurationMs: 0,
      providerWorkflowMaxDurationMs: 0,
    };
    const webhookPage = await visitQuickBooksWorkerTenantPage({
      afterTenantId: webhookAfterTenantId,
      loadPage: loadTenantPage,
      visit: async (tenant) => {
        if (stopping) return;
        const backlog = await inspectDueWebhookBacklog(tenant.id);
        if (backlog.dueCount > 0) {
          metrics.dueTenantCount += 1;
          metrics.dueEventCount += backlog.dueCount;
          if (backlog.oldestReceivedAtUtc) {
            metrics.oldestBacklogAgeMs = Math.max(
              metrics.oldestBacklogAgeMs,
              Math.max(0, Date.now() - backlog.oldestReceivedAtUtc.getTime()),
            );
          }
          const providerWorkflowStartedAtMs = Date.now();
          const outcome = await processTenant(tenant.id);
          recordProviderWorkflowDuration(metrics, providerWorkflowStartedAtMs);
          if (outcome.status !== "idle") metrics[outcome.status] += 1;
          if (outcome.failureCode) {
            metrics.failureCodes[outcome.failureCode] = (metrics.failureCodes[outcome.failureCode] ?? 0) + 1;
          }
        }
        await persistWorkerHeartbeat("RUNNING", {
          phase: "webhook_scan",
          processed: metrics.processed,
          failed: metrics.failed,
          dead: metrics.dead,
          dueEventCount: metrics.dueEventCount,
        });
      },
    });
    webhookAfterTenantId = webhookPage.nextAfterTenantId;

    let revocationTenantCount = 0;
    let revocationCycleComplete = false;
    if (!stopping && tickStartedAt >= nextRevocationScanAt) {
      const revocationPage = await visitQuickBooksWorkerTenantPage({
        afterTenantId: revocationAfterTenantId,
        loadPage: loadTenantPage,
        visit: async (tenant) => {
          if (stopping) return;
        const providerWorkflowStartedAtMs = Date.now();
        await retryQuickBooksRevocation({ prisma, runtimeEnv: env, tenantId: tenant.id }).catch((error) => {
          writeWorkerLog("warn", "quickbooks_token_revocation_retry_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        });
        recordProviderWorkflowDuration(metrics, providerWorkflowStartedAtMs);
        await persistWorkerHeartbeat("RUNNING", { phase: "revocation_scan" });
        },
      });
      revocationAfterTenantId = revocationPage.nextAfterTenantId;
      revocationTenantCount = revocationPage.tenantCount;
      revocationCycleComplete = revocationPage.cycleComplete;
      nextRevocationScanAt = nextQuickBooksWorkerScanAt(revocationPage, QUICKBOOKS_REVOCATION_SCAN_INTERVAL_MS, Date.now());
    }

    let cdcTenantCount = 0;
    let cdcCycleComplete = false;
    if (!stopping && env.QUICKBOOKS_CDC_WORKER_ENABLED && tickStartedAt >= nextCdcScanAt) {
      const cdcPage = await visitQuickBooksWorkerTenantPage({
        afterTenantId: cdcAfterTenantId,
        loadPage: loadTenantPage,
        visit: async (tenant) => {
          if (stopping) return;
          const providerWorkflowStartedAtMs = Date.now();
          await recoverQuickBooksChanges({
            prisma,
            runtimeEnv: env,
            tenantId: tenant.id,
            getAccessToken: (connection) => getSerializedQuickBooksAccessToken({ prisma, runtimeEnv: env, connection }),
          }).catch((error) => {
            writeWorkerLog("warn", "quickbooks_cdc_recovery_failed", {
              tenantRefHash: tenantRefHash(tenant.id),
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          });
          recordProviderWorkflowDuration(metrics, providerWorkflowStartedAtMs);
          await persistWorkerHeartbeat("RUNNING", { phase: "cdc_scan" });
        },
      });
      cdcAfterTenantId = cdcPage.nextAfterTenantId;
      cdcTenantCount = cdcPage.tenantCount;
      cdcCycleComplete = cdcPage.cycleComplete;
      nextCdcScanAt = nextQuickBooksWorkerScanAt(cdcPage, QUICKBOOKS_CDC_SCAN_INTERVAL_MS, Date.now());
    }

    let retentionTenantCount = 0;
    let retentionCycleComplete = false;
    let retentionDeletedCount = 0;
    let retentionFailedTenantCount = 0;
    let retentionHasMoreTenantCount = 0;
    let unknownRealmQuarantineDeletedCount = 0;
    let unknownRealmQuarantineHasMore = false;
    let unknownRealmQuarantineRetentionFailed = false;
    if (!stopping && tickStartedAt >= nextRetentionScanAt) {
      try {
        const quarantineResult = await runQuickBooksUnknownRealmQuarantineRetention(prisma);
        unknownRealmQuarantineDeletedCount = quarantineResult.deletedCount;
        unknownRealmQuarantineHasMore = quarantineResult.hasMore;
      } catch (error) {
        unknownRealmQuarantineRetentionFailed = true;
        writeWorkerLog("warn", "quickbooks_unknown_realm_retention_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      const retentionPage = await visitQuickBooksWorkerTenantPage({
        afterTenantId: retentionAfterTenantId,
        loadPage: loadTenantPage,
        visit: async (tenant) => {
          if (stopping) return;
          try {
            const result = await runQuickBooksRetentionForTenant(prisma, {
              tenantId: tenant.id,
              now: new Date(),
            });
            retentionDeletedCount += result.oauthStatesDeleted
              + result.processedWebhookEventsDeleted
              + result.deadWebhookEventsDeleted;
            if (result.hasMore || result.lockSkipped) retentionHasMoreTenantCount += 1;
          } catch (error) {
            retentionFailedTenantCount += 1;
            writeWorkerLog("warn", "quickbooks_security_retention_failed", {
              tenantRefHash: tenantRefHash(tenant.id),
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          }
          await persistWorkerHeartbeat("RUNNING", { phase: "retention_scan" });
        },
      });
      retentionAfterTenantId = retentionPage.nextAfterTenantId;
      retentionTenantCount = retentionPage.tenantCount;
      retentionCycleComplete = retentionPage.cycleComplete;
      nextRetentionScanAt = nextQuickBooksWorkerScanAt(retentionPage, QUICKBOOKS_RETENTION_SCAN_INTERVAL_MS, Date.now());
    }

    writeWorkerLog("info", "quickbooks_reconciliation_worker_heartbeat", {
        processed: metrics.processed,
        failed: metrics.failed,
        dead: metrics.dead,
        dueTenantCount: metrics.dueTenantCount,
        dueEventCount: metrics.dueEventCount,
        oldestBacklogAgeMs: metrics.oldestBacklogAgeMs,
        providerWorkflowCount: metrics.providerWorkflowCount,
        providerWorkflowTotalDurationMs: metrics.providerWorkflowTotalDurationMs,
        providerWorkflowMaxDurationMs: metrics.providerWorkflowMaxDurationMs,
        webhookTenantCount: webhookPage.tenantCount,
        webhookCycleComplete: webhookPage.cycleComplete,
        revocationTenantCount,
        revocationCycleComplete,
        cdcTenantCount,
        cdcCycleComplete,
        retentionTenantCount,
        retentionCycleComplete,
        retentionDeletedCount,
        retentionFailedTenantCount,
        retentionHasMoreTenantCount,
        unknownRealmQuarantineDeletedCount,
        unknownRealmQuarantineHasMore,
        unknownRealmQuarantineRetentionFailed,
        maxRetentionRowsPerTenant: 100,
        maxWebhookEventsPerTenant: 1,
        maxReconciliationsPerWorkItem: QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM,
        tickDurationMs: Date.now() - tickStartedAt,
      });
    await persistWorkerHeartbeat("RUNNING", {
      processed: metrics.processed,
      failed: metrics.failed,
      dead: metrics.dead,
      dueTenantCount: metrics.dueTenantCount,
      dueEventCount: metrics.dueEventCount,
      oldestBacklogAgeMs: metrics.oldestBacklogAgeMs,
      failureCodes: metrics.failureCodes,
      providerWorkflowCount: metrics.providerWorkflowCount,
      providerWorkflowTotalDurationMs: metrics.providerWorkflowTotalDurationMs,
      providerWorkflowMaxDurationMs: metrics.providerWorkflowMaxDurationMs,
      webhookTenantCount: webhookPage.tenantCount,
      cdcTenantCount,
      retentionFailedTenantCount,
      unknownRealmQuarantineRetentionFailed,
    }, { force: true, lastCycleDurationMs: Date.now() - tickStartedAt });
    await pause(metrics.dueEventCount > 0
      ? QUICKBOOKS_ACTIVE_TICK_PAUSE_MS
      : QUICKBOOKS_IDLE_TICK_PAUSE_MS);
  }
  await persistWorkerHeartbeat("STOPPED", { stopping: true }, { force: true });
}

run()
  .catch(async (error: unknown) => {
    writeWorkerLog("error", "quickbooks_reconciliation_worker_stopped", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    await persistWorkerHeartbeat("FAILED", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, { force: true }).catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
