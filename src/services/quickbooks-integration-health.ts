import type { PrismaClient } from "@prisma/client";
import {
  evaluateQuickBooksOperationalSnapshot,
  loadQuickBooksOperationalSnapshot,
  type QuickBooksOperationalAggregate,
  type QuickBooksOperationalRuntime,
  type QuickBooksOperationalSnapshot,
} from "./quickbooks-operational-health";

export const QUICKBOOKS_INTEGRATION_HEALTH_SCHEMA = "quotefly.integration-health/v1" as const;

export type QuickBooksIntegrationMode = "disabled" | "oauth_only" | "accounting";
export type QuickBooksIntegrationState = "healthy" | "warning" | "critical";
export type QuickBooksIntegrationWorkerStatus =
  | "not_required"
  | "missing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "stale"
  | "release_mismatch"
  | "topology_invalid";

export type QuickBooksIntegrationHealthRuntime = QuickBooksOperationalRuntime & Readonly<{
  hostedPaymentsEnabled: boolean;
  webhookConfigured: boolean;
  monitorBearer: string;
  apiSignalIngestUrl: string;
  apiSignalSourceToken: string;
}>;

export type QuickBooksIntegrationHealthReport = Readonly<{
  schema: typeof QUICKBOOKS_INTEGRATION_HEALTH_SCHEMA;
  observedAtUtc: string;
  environment: "sandbox" | "production";
  mode: QuickBooksIntegrationMode;
  state: QuickBooksIntegrationState;
  automation: Readonly<{
    providerActionsEnabled: boolean;
    hostedPaymentsEnabled: boolean;
    reconciliationEnabled: boolean;
    cdcEnabled: boolean;
    webhookConfigured: boolean;
  }>;
  monitors: Readonly<{
    bearerConfigured: boolean;
    apiSignalSinkConfigured: boolean;
    workerSignalSinkConfigured: null;
    deliveryVerified: false;
  }>;
  worker: Readonly<{
    required: boolean;
    status: QuickBooksIntegrationWorkerStatus;
    ready: boolean;
    lastObservedAtUtc: string | null;
    releaseMatches: boolean | null;
  }>;
  operations: QuickBooksOperationalAggregate;
}>;

function integrationMode(runtime: QuickBooksIntegrationHealthRuntime): QuickBooksIntegrationMode {
  if (!runtime.providerWorkflowsEnabled) return "disabled";
  return runtime.oauthOnlyMode ? "oauth_only" : "accounting";
}

function integrationState(
  warningUnhealthy: boolean,
  criticalUnhealthy: boolean,
): QuickBooksIntegrationState {
  if (criticalUnhealthy) return "critical";
  return warningUnhealthy ? "warning" : "healthy";
}

function signalSinkConfigured(url: string, token: string): boolean {
  return url.trim().length > 0 && token.trim().length > 0;
}

function workerStatus(
  runtime: QuickBooksIntegrationHealthRuntime,
  snapshot: QuickBooksOperationalSnapshot,
): QuickBooksIntegrationWorkerStatus {
  const required = runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled;
  if (!required) return "not_required";

  const fleet = snapshot.workerFleet;
  const representative = fleet?.representative;
  if (!fleet || !representative) return "missing";
  if (fleet.freshLiveOverflowed) return "topology_invalid";
  if (fleet.releaseIdentity.matches === false) return "release_mismatch";

  if (representative.status === "FAILED") return "failed";
  if (representative.status === "STOPPED") return "stopped";
  if (representative.status === "STOPPING") return "stopping";
  if (!representative.fresh) return "stale";
  if (!fleet.ready) return "topology_invalid";
  return representative.status === "STARTING" ? "starting" : "running";
}

function serializeOperations(
  operations: QuickBooksOperationalAggregate,
): QuickBooksOperationalAggregate {
  return {
    webhookOutstandingCount: operations.webhookOutstandingCount,
    webhookDeadCount: operations.webhookDeadCount,
    oldestWebhookOutstandingAgeMs: operations.oldestWebhookOutstandingAgeMs,
    reconciliationRequiredCount: operations.reconciliationRequiredCount,
    oldestReconciliationRequiredAgeMs: operations.oldestReconciliationRequiredAgeMs,
    cdcCursorCount: operations.cdcCursorCount,
    cdcTerminalCount: operations.cdcTerminalCount,
    cdcOverdueCount: operations.cdcOverdueCount,
    maximumCdcLagMs: operations.maximumCdcLagMs,
    connectionRevocationPendingCount: operations.connectionRevocationPendingCount,
    connectionRevocationDeadCount: operations.connectionRevocationDeadCount,
    oldestConnectionRevocationPendingAgeMs: operations.oldestConnectionRevocationPendingAgeMs,
    orphanRevocationPendingCount: operations.orphanRevocationPendingCount,
    orphanRevocationDeadCount: operations.orphanRevocationDeadCount,
    oldestOrphanRevocationPendingAgeMs: operations.oldestOrphanRevocationPendingAgeMs,
    tokenRefreshFailureConnectionCount: operations.tokenRefreshFailureConnectionCount,
    tokenRefreshReauthRequiredCount: operations.tokenRefreshReauthRequiredCount,
    oldestTokenRefreshFailureAgeMs: operations.oldestTokenRefreshFailureAgeMs,
  };
}

/**
 * Projects the same billing-masked, fleet-aware snapshot used by the external
 * machine monitors into a deliberately closed, secret-free operator DTO.
 */
export function buildQuickBooksIntegrationHealthReport(
  runtime: QuickBooksIntegrationHealthRuntime,
  snapshot: QuickBooksOperationalSnapshot,
  observedAtUtc: Date,
): QuickBooksIntegrationHealthReport {
  const evaluation = evaluateQuickBooksOperationalSnapshot(runtime, snapshot, observedAtUtc);
  const required = runtime.reconciliationWorkerEnabled || runtime.cdcWorkerEnabled;
  const fleet = snapshot.workerFleet;

  return {
    schema: QUICKBOOKS_INTEGRATION_HEALTH_SCHEMA,
    observedAtUtc: observedAtUtc.toISOString(),
    environment: runtime.environment,
    mode: integrationMode(runtime),
    state: integrationState(evaluation.warningUnhealthy, evaluation.criticalUnhealthy),
    automation: {
      providerActionsEnabled: runtime.providerWorkflowsEnabled && !runtime.oauthOnlyMode,
      hostedPaymentsEnabled: runtime.hostedPaymentsEnabled,
      reconciliationEnabled: runtime.reconciliationWorkerEnabled,
      cdcEnabled: runtime.cdcWorkerEnabled,
      webhookConfigured: runtime.webhookConfigured,
    },
    monitors: {
      bearerConfigured: runtime.monitorBearer.trim().length >= 32,
      apiSignalSinkConfigured: signalSinkConfigured(
        runtime.apiSignalIngestUrl,
        runtime.apiSignalSourceToken,
      ),
      // The API intentionally cannot inspect worker-only credentials.
      workerSignalSinkConfigured: null,
      deliveryVerified: false,
    },
    worker: {
      required,
      status: workerStatus(runtime, snapshot),
      ready: required && fleet?.ready === true,
      lastObservedAtUtc: required && fleet?.representative?.observedAtUtc
        ? fleet.representative.observedAtUtc.toISOString()
        : null,
      releaseMatches: required ? fleet?.releaseIdentity.matches ?? null : null,
    },
    operations: serializeOperations(snapshot.operations),
  };
}

export async function loadQuickBooksIntegrationHealthReport(
  prisma: PrismaClient,
  runtime: QuickBooksIntegrationHealthRuntime,
  options: { apiReleaseSha: string | null; now?: Date },
): Promise<QuickBooksIntegrationHealthReport> {
  const observedAtUtc = options.now ?? new Date();
  const snapshot = await loadQuickBooksOperationalSnapshot(prisma, runtime, {
    apiReleaseSha: options.apiReleaseSha,
    now: observedAtUtc,
  });
  return buildQuickBooksIntegrationHealthReport(runtime, snapshot, observedAtUtc);
}
