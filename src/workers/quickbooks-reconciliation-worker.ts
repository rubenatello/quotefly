import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { resolveRuntimeReleaseSha } from "../lib/release-identity";
import { assertAiRetrievalRlsReady, withTenantRlsContext } from "../lib/tenant-rls";
import {
  fetchQuickBooksPayment,
  fetchQuickBooksRefundReceipt,
  QuickBooksProviderError,
} from "../services/quickbooks";
import {
  getSerializedQuickBooksAccessToken,
  isQuickBooksReauthorizationError,
  retryQuickBooksRevocation,
  runQuickBooksProviderRequestWithRefresh,
} from "../services/quickbooks-credentials";
import {
  pageQuickBooksProviderEntityIds,
  QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM,
  recoverQuickBooksChanges,
} from "../services/quickbooks-cdc";
import { reconcileQuickBooksInvoice } from "../services/quickbooks-reconciliation";
import {
  runQuickBooksRetentionForTenant,
  runQuickBooksUnknownRealmQuarantineRetention,
} from "../services/quickbooks-retention";
import { classifyQuickBooksWorkerFailure } from "../services/quickbooks-worker-failures";
import { visitQuickBooksWorkerTenantPage } from "../services/quickbooks-worker-scheduler";
import {
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
  runWorkerHeartbeatInstanceRetention,
  type WorkerHeartbeatStatus,
} from "../services/worker-heartbeats";
import {
  claimQuickBooksWebhookEvent,
  completeQuickBooksWebhookEvent,
  failQuickBooksWebhookEvent,
  renewQuickBooksWebhookClaim,
} from "../services/quickbooks-webhook-inbox";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const QUICKBOOKS_REVOCATION_SCAN_INTERVAL_MS = 5_000;
const QUICKBOOKS_CDC_SCAN_INTERVAL_MS = 15_000;
const QUICKBOOKS_RETENTION_SCAN_INTERVAL_MS = 60 * 60 * 1_000;
const QUICKBOOKS_ACTIVE_TICK_PAUSE_MS = 100;
const QUICKBOOKS_IDLE_TICK_PAUSE_MS = 1_000;
const QUICKBOOKS_HEARTBEAT_REFRESH_MS = 15_000;
const QUICKBOOKS_WEBHOOK_CLAIM_RENEW_MS = 30_000;
const WORKER_STARTED_AT_UTC = new Date();
const WORKER_INSTANCE_REF_HASH = createHash("sha256")
  .update(randomUUID(), "utf8")
  .digest("hex");
const WORKER_RELEASE_SHA = resolveRuntimeReleaseSha();
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
    metrics: WORKER_RELEASE_SHA && metrics && typeof metrics === "object" && !Array.isArray(metrics)
      ? { releaseSha: WORKER_RELEASE_SHA, ...metrics }
      : metrics,
  });
  lastHeartbeatWriteAt = now.getTime();
}

function startWorkerHeartbeatRefreshLoop() {
  let stopped = false;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending
      .then(() => persistWorkerHeartbeat("RUNNING", { phase: "active_work" }))
      .catch((error) => {
        writeWorkerLog("warn", "quickbooks_worker_heartbeat_refresh_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
  }, QUICKBOOKS_HEARTBEAT_REFRESH_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}

function startQuickBooksWebhookClaimRenewal(
  claim: NonNullable<Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>>,
) {
  let stopped = false;
  let current = true;
  let pending = Promise.resolve();
  const renew = () => {
    pending = pending
      .then(async () => {
        if (stopped || !current) return;
        current = await renewQuickBooksWebhookClaim(prisma, claim);
      })
      .catch((error) => {
        current = false;
        writeWorkerLog("warn", "quickbooks_webhook_claim_renewal_failed", {
          tenantRefHash: tenantRefHash(claim.tenantId),
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
  };
  const timer = setInterval(renew, QUICKBOOKS_WEBHOOK_CLAIM_RENEW_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    return current;
  };
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

const WEBHOOK_PROVIDER_WORKLIST_KEY = "quoteflyPendingProviderInvoiceIds";
const WEBHOOK_INVOICE_WORKLIST_KEY = "quoteflyPendingInvoiceIds";

function webhookPayloadStringArray(payload: Prisma.JsonValue, key: string): string[] | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = (payload as Prisma.JsonObject)[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function webhookPayloadWithContinuation(
  payload: Prisma.JsonValue,
  remainingProviderInvoiceIds: readonly string[],
  remainingInvoiceIds: readonly string[],
): Prisma.JsonObject {
  const existing = payload && !Array.isArray(payload) && typeof payload === "object"
    ? payload as Prisma.JsonObject
    : {};
  return {
    ...existing,
    [WEBHOOK_PROVIDER_WORKLIST_KEY]: [...remainingProviderInvoiceIds],
    [WEBHOOK_INVOICE_WORKLIST_KEY]: [...remainingInvoiceIds],
  } as Prisma.JsonObject;
}

async function persistQuickBooksWebhookWorklist(
  claim: NonNullable<Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>>,
  payload: Prisma.JsonValue,
  providerInvoiceIds: readonly string[],
  invoiceIds: readonly string[],
): Promise<Prisma.JsonObject> {
  const stablePayload = webhookPayloadWithContinuation(payload, providerInvoiceIds, invoiceIds);
  const claimTokenHash = createHash("sha256").update(claim.claimToken, "utf8").digest("hex");
  const persisted = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
    transaction.quickBooksWebhookEvent.updateMany({
      where: { id: claim.id, tenantId: claim.tenantId, status: "PROCESSING", claimTokenHash },
      data: { payload: stablePayload },
    }),
  );
  if (persisted.count !== 1) throw new Error("QUICKBOOKS_WEBHOOK_CLAIM_STALE");
  return stablePayload;
}

async function invoiceIdsForClaim(claim: Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>) {
  if (!claim) return {
    invoiceIds: [] as string[],
    remainingProviderInvoiceIds: [] as string[],
    remainingInvoiceIds: [] as string[],
    payload: {} as Prisma.JsonValue,
    trigger: "WEBHOOK" as const,
  };
  const event = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
    transaction.quickBooksWebhookEvent.findFirst({
      where: { id: claim.id, tenantId: claim.tenantId },
      select: { payload: true },
    }),
  );
  const payload = event?.payload ?? {};
  const trigger = payload && !Array.isArray(payload) && typeof payload === "object"
    && (payload as Prisma.JsonObject).quoteflyTrigger === "CDC"
    ? "CDC" as const
    : "WEBHOOK" as const;
  if (claim.eventType === "Invoice") {
    const invoiceIds = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
      transaction.quickBooksInvoiceOperation.findMany({
        where: {
          tenantId: claim.tenantId,
          quickBooksConnectionId: claim.quickBooksConnectionId,
          providerInvoiceId: claim.entityId,
          archivedAtUtc: null,
        },
        select: { invoiceId: true },
        orderBy: { invoiceId: "asc" },
        take: 1,
      }).then((rows) => rows.map((row) => row.invoiceId)),
    );
    return {
      invoiceIds,
      remainingProviderInvoiceIds: [],
      remainingInvoiceIds: [],
      payload,
      trigger,
    };
  }

  const connection = { id: claim.quickBooksConnectionId, tenantId: claim.tenantId, realmId: claim.realmId };
  const invoiceIdsForProviderWorklist = async (
    providerInvoiceIds: readonly string[],
    persistBeforeProcessing = false,
  ) => {
    const providerPage = pageQuickBooksProviderEntityIds(providerInvoiceIds);
    const stableProviderInvoiceIds = [
      ...providerPage.providerEntityIds,
      ...providerPage.remainingProviderEntityIds,
    ];
    const stablePayload = persistBeforeProcessing
      ? await persistQuickBooksWebhookWorklist(claim, payload, stableProviderInvoiceIds, [])
      : payload;
    const invoiceIds = providerPage.providerEntityIds.length === 0
      ? []
      : await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
          transaction.quickBooksInvoiceOperation.findMany({
            where: {
              tenantId: claim.tenantId,
              quickBooksConnectionId: claim.quickBooksConnectionId,
              providerInvoiceId: { in: [...providerPage.providerEntityIds] },
              archivedAtUtc: null,
            },
            select: { invoiceId: true },
            orderBy: { invoiceId: "asc" },
          }).then((rows) => rows.map((row) => row.invoiceId)),
        );
    return {
      invoiceIds,
      remainingProviderInvoiceIds: [...providerPage.remainingProviderEntityIds],
      remainingInvoiceIds: [] as string[],
      payload: stablePayload,
      trigger,
    };
  };
  const storedProviderInvoiceIds = webhookPayloadStringArray(payload, WEBHOOK_PROVIDER_WORKLIST_KEY);
  if (storedProviderInvoiceIds?.length) return invoiceIdsForProviderWorklist(storedProviderInvoiceIds);
  const storedInvoiceIds = webhookPayloadStringArray(payload, WEBHOOK_INVOICE_WORKLIST_KEY);
  if (storedInvoiceIds?.length) {
    const invoicePage = pageQuickBooksProviderEntityIds(storedInvoiceIds);
    return {
      invoiceIds: [...invoicePage.providerEntityIds],
      remainingProviderInvoiceIds: [] as string[],
      remainingInvoiceIds: [...invoicePage.remainingProviderEntityIds],
      payload,
      trigger,
    };
  }
  if (claim.eventType === "RefundReceipt") {
    const refundReceipt = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksRefundReceipt(env, claim.realmId, accessToken, claim.entityId),
    });
    const linkedPayments = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "payment" && linked.TxnId?.trim()
    );
    const linkedInvoices = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "invoice" && linked.TxnId?.trim()
    );
    const hasUnsupportedLink = refundReceipt.LinkedTxn.some((linked) => {
      const type = linked.TxnType?.trim().toLowerCase();
      return type !== "payment" && type !== "invoice";
    });
    if (hasUnsupportedLink || linkedPayments.length !== 1 || linkedInvoices.length !== 1) {
      throw new QuickBooksProviderError("QUICKBOOKS_REFUND_APPLICATION_UNSUPPORTED", false);
    }
    const providerInvoiceId = linkedInvoices[0]!.TxnId!.trim();
    const payment = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksPayment(
        env,
        claim.realmId,
        accessToken,
        linkedPayments[0]!.TxnId!.trim(),
      ),
    });
    const paymentInvoiceIds = new Set((payment.Line ?? [])
      .flatMap((line) => line.LinkedTxn ?? [])
      .filter((linked) => linked.TxnType?.trim().toLowerCase() === "invoice" && linked.TxnId?.trim())
      .map((linked) => linked.TxnId!.trim()));
    if (!paymentInvoiceIds.has(providerInvoiceId)) {
      throw new QuickBooksProviderError("QUICKBOOKS_REFUND_PAYMENT_NOT_LINKED_TO_INVOICE", false);
    }
    return invoiceIdsForProviderWorklist([providerInvoiceId], true);
  }
  if (claim.eventType !== "Payment") {
    throw new QuickBooksProviderError("QUICKBOOKS_WEBHOOK_ENTITY_UNSUPPORTED", false);
  }
  try {
    const payment = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksPayment(env, claim.realmId, accessToken, claim.entityId),
    });
    const providerInvoiceIds = (payment.Line ?? [])
      .flatMap((line) => line.LinkedTxn ?? [])
      .filter((linked) => linked.TxnType === "Invoice" && linked.TxnId)
      .map((linked) => linked.TxnId as string);
    return invoiceIdsForProviderWorklist(providerInvoiceIds, true);
  } catch (error) {
    if (!(error instanceof QuickBooksProviderError) || error.statusCode !== 404) throw error;
    const invoiceIds = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
      transaction.invoicePayment.findMany({
        where: {
          tenantId: claim.tenantId,
          provider: "QUICKBOOKS",
          providerPaymentId: claim.entityId,
          deletedAtUtc: null,
        },
        select: { invoiceId: true },
        orderBy: { invoiceId: "asc" },
        distinct: ["invoiceId"],
        take: 1_001,
      }).then((rows) => [...new Set(rows.map((row) => row.invoiceId))]),
    );
    const invoicePage = pageQuickBooksProviderEntityIds(invoiceIds);
    const stableInvoiceIds = [...invoicePage.providerEntityIds, ...invoicePage.remainingProviderEntityIds];
    const stablePayload = await persistQuickBooksWebhookWorklist(claim, payload, [], stableInvoiceIds);
    return {
      invoiceIds: [...invoicePage.providerEntityIds],
      remainingProviderInvoiceIds: [],
      remainingInvoiceIds: [...invoicePage.remainingProviderEntityIds],
      payload: stablePayload,
      trigger,
    };
  }
}

async function requeueQuickBooksWebhookClaim(
  claim: NonNullable<Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>>,
  payload: Prisma.JsonValue,
  remainingProviderInvoiceIds: readonly string[],
  remainingInvoiceIds: readonly string[],
): Promise<boolean> {
  const claimTokenHash = createHash("sha256").update(claim.claimToken, "utf8").digest("hex");
  return withTenantRlsContext(prisma, claim.tenantId, async (transaction) => {
    const result = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        id: claim.id,
        tenantId: claim.tenantId,
        status: "PROCESSING",
        claimTokenHash,
      },
      data: {
        payload: webhookPayloadWithContinuation(payload, remainingProviderInvoiceIds, remainingInvoiceIds),
        status: "RECEIVED",
        // A successfully drained page is continuation, not a failed attempt.
        // Resetting the retry counter prevents legitimate large payments from
        // exhausting the dead-letter budget solely because they need pages.
        attemptCount: 0,
        claimTokenHash: null,
        claimExpiresAtUtc: null,
        nextAttemptAtUtc: null,
        lastError: null,
      },
    });
    return result.count === 1;
  });
}

type QuickBooksTenantProcessOutcome = Readonly<{
  status: "idle" | "processed" | "failed" | "dead";
  failureCode?: string;
}>;

async function processTenant(tenantId: string): Promise<QuickBooksTenantProcessOutcome> {
  const claim = await claimQuickBooksWebhookEvent(prisma, tenantId);
  if (!claim) return { status: "idle" };
  const stopClaimRenewal = startQuickBooksWebhookClaimRenewal(claim);
  try {
    const work = await invoiceIdsForClaim(claim);
    for (const invoiceId of work.invoiceIds) {
      await reconcileQuickBooksInvoice({
        prisma,
        runtimeEnv: env,
        tenantId,
        invoiceId,
        trigger: work.trigger,
        providerOperation: claim.operation,
        getAccessToken: (connection) => getSerializedQuickBooksAccessToken({ prisma, runtimeEnv: env, connection }),
      });
    }
    if (work.remainingProviderInvoiceIds.length > 0 || work.remainingInvoiceIds.length > 0) {
      if (!(await stopClaimRenewal())) {
        return { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
      }
      return (await requeueQuickBooksWebhookClaim(
        claim,
        work.payload,
        work.remainingProviderInvoiceIds,
        work.remainingInvoiceIds,
      )) ? { status: "processed" } : { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
    }
    if (!(await stopClaimRenewal())) {
      return { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
    }
    if (!(await completeQuickBooksWebhookEvent(prisma, claim))) {
      return { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
    }
    return { status: "processed" };
  } catch (error) {
    await stopClaimRenewal();
    const failure = classifyQuickBooksWorkerFailure(error);
    const outcome = await failQuickBooksWebhookEvent(prisma, claim, failure.code, {
      retryable: failure.retryable,
    });
    writeWorkerLog("warn", "quickbooks_reconciliation_work_item_failed", {
      tenantRefHash: tenantRefHash(tenantId),
      eventType: claim.eventType,
      failureCode: failure.code,
      retryable: failure.retryable,
      outcome,
    });
    return {
      status: outcome === "DEAD" ? "dead" : "failed",
      failureCode: failure.code,
    };
  }
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
  const stopHeartbeatRefreshLoop = startWorkerHeartbeatRefreshLoop();
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

  try {
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
      nextRevocationScanAt = Date.now() + QUICKBOOKS_REVOCATION_SCAN_INTERVAL_MS;
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
      nextCdcScanAt = Date.now() + QUICKBOOKS_CDC_SCAN_INTERVAL_MS;
    }

    let retentionTenantCount = 0;
    let retentionCycleComplete = false;
    let retentionDeletedCount = 0;
    let retentionFailedTenantCount = 0;
    let retentionHasMoreTenantCount = 0;
    let unknownRealmQuarantineDeletedCount = 0;
    let unknownRealmQuarantineHasMore = false;
    let unknownRealmQuarantineRetentionFailed = false;
    let workerHeartbeatInstanceDeletedCount = 0;
    let workerHeartbeatInstanceRetentionFailed = false;
    if (!stopping && tickStartedAt >= nextRetentionScanAt) {
      try {
        workerHeartbeatInstanceDeletedCount = await runWorkerHeartbeatInstanceRetention(prisma);
      } catch (error) {
        workerHeartbeatInstanceRetentionFailed = true;
        writeWorkerLog("warn", "worker_heartbeat_instance_retention_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
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
      nextRetentionScanAt = Date.now() + QUICKBOOKS_RETENTION_SCAN_INTERVAL_MS;
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
        workerHeartbeatInstanceDeletedCount,
        workerHeartbeatInstanceRetentionFailed,
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
      workerHeartbeatInstanceDeletedCount,
      workerHeartbeatInstanceRetentionFailed,
    }, { force: true, lastCycleDurationMs: Date.now() - tickStartedAt });
    await pause(metrics.dueEventCount > 0
      ? QUICKBOOKS_ACTIVE_TICK_PAUSE_MS
      : QUICKBOOKS_IDLE_TICK_PAUSE_MS);
  }
  } finally {
    await stopHeartbeatRefreshLoop();
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
