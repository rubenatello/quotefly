import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickBooksIntegrationHealthReport,
  type QuickBooksIntegrationHealthRuntime,
} from "../../src/services/quickbooks-integration-health";
import {
  QUICKBOOKS_MONITOR_CRITICAL_AGE_MS,
  QUICKBOOKS_MONITOR_WARNING_AGE_MS,
  type QuickBooksOperationalAggregate,
  type QuickBooksOperationalSnapshot,
} from "../../src/services/quickbooks-operational-health";
import type { WorkerHeartbeatFleetSnapshot } from "../../src/services/worker-heartbeats";
import {
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
} from "../../src/services/quickbooks-worker-operational";

const NOW = new Date("2026-09-05T20:00:00.000Z");

const EMPTY_OPERATIONS: QuickBooksOperationalAggregate = {
  webhookOutstandingCount: 0,
  webhookDeadCount: 0,
  oldestWebhookOutstandingAgeMs: null,
  reconciliationRequiredCount: 0,
  oldestReconciliationRequiredAgeMs: null,
  cdcCursorCount: 0,
  cdcTerminalCount: 0,
  cdcOverdueCount: 0,
  maximumCdcLagMs: null,
  connectionRevocationPendingCount: 0,
  connectionRevocationDeadCount: 0,
  oldestConnectionRevocationPendingAgeMs: null,
  orphanRevocationPendingCount: 0,
  orphanRevocationDeadCount: 0,
  oldestOrphanRevocationPendingAgeMs: null,
  tokenRefreshFailureConnectionCount: 0,
  tokenRefreshReauthRequiredCount: 0,
  oldestTokenRefreshFailureAgeMs: null,
};

const OAUTH_RUNTIME: QuickBooksIntegrationHealthRuntime = {
  environment: "sandbox",
  providerWorkflowsEnabled: true,
  oauthOnlyMode: true,
  hostedPaymentsEnabled: false,
  reconciliationWorkerEnabled: false,
  cdcWorkerEnabled: false,
  webhookConfigured: false,
  requireWorkerReleaseIdentity: false,
  monitorBearer: "monitor-bearer-must-never-be-rendered-0001",
  apiSignalIngestUrl: "https://signals.example.test/api",
  apiSignalSourceToken: "api-signal-token-must-never-be-rendered",
};

function snapshot(
  operations: QuickBooksOperationalAggregate = EMPTY_OPERATIONS,
): QuickBooksOperationalSnapshot {
  return { operations, workerFleet: null };
}

function workerFleet(
  overrides: Partial<WorkerHeartbeatFleetSnapshot> = {},
): WorkerHeartbeatFleetSnapshot {
  const releaseSha = "a".repeat(40);
  const operationalMetrics = {
    quickBooksOperational: {
      schema: QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
      environment: "sandbox" as const,
      providerWindow: {
        windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
        callCount: 0,
        failureCount: 0,
        throttleCount: 0,
        timeoutCount: 0,
        slowCount: 0,
        degradedCallCount: 0,
        maximumDurationMs: 0,
      },
      retention: {
        startupAtUtc: NOW.toISOString(),
        lastSucceededAtUtc: NOW.toISOString(),
        unresolvedFailure: false,
        consecutiveFailureCount: 0,
      },
    },
  };
  return {
    representative: {
      status: "RUNNING",
      fresh: true,
      heartbeatAtUtc: NOW,
      observedAtUtc: NOW,
      startedAtUtc: NOW,
      cycleStartedAtUtc: NOW,
      lastCycleDurationMs: 25,
      metrics: operationalMetrics,
    },
    ready: true,
    counts: {
      totalInstanceCount: 1,
      freshLiveInstanceCount: 1,
      capacityInstanceCount: 1,
      stoppingInstanceCount: 0,
      staleInstanceCount: 0,
      terminalInstanceCount: 0,
      missingReleaseShaInstanceCount: 0,
      releaseMismatchInstanceCount: 0,
      overflowedFreshLiveInstanceCount: 0,
    },
    freshLiveLimit: 100,
    freshLiveOverflowed: false,
    releaseIdentity: {
      apiReleaseSha: releaseSha,
      workerReleaseSha: releaseSha,
      matches: true,
    },
    ...overrides,
  };
}

test("serializes OAuth-only health as a closed presence-only operator report", () => {
  const report = buildQuickBooksIntegrationHealthReport(OAUTH_RUNTIME, snapshot(), NOW);

  assert.deepEqual(report, {
    schema: "quotefly.integration-health/v1",
    observedAtUtc: NOW.toISOString(),
    environment: "sandbox",
    mode: "oauth_only",
    state: "healthy",
    automation: {
      providerActionsEnabled: false,
      hostedPaymentsEnabled: false,
      reconciliationEnabled: false,
      cdcEnabled: false,
      webhookConfigured: false,
    },
    monitors: {
      bearerConfigured: true,
      apiSignalSinkConfigured: true,
      workerSignalSinkConfigured: null,
      deliveryVerified: false,
    },
    worker: {
      required: false,
      status: "not_required",
      ready: false,
      lastObservedAtUtc: null,
      releaseMatches: null,
    },
    operations: EMPTY_OPERATIONS,
  });

  const serialized = JSON.stringify(report);
  for (const sensitive of [
    OAUTH_RUNTIME.monitorBearer,
    OAUTH_RUNTIME.apiSignalIngestUrl,
    OAUTH_RUNTIME.apiSignalSourceToken,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("uses exactly the machine-monitor warning and critical classifications", () => {
  const warning = buildQuickBooksIntegrationHealthReport(OAUTH_RUNTIME, snapshot({
    ...EMPTY_OPERATIONS,
    webhookOutstandingCount: 1,
    oldestWebhookOutstandingAgeMs: QUICKBOOKS_MONITOR_WARNING_AGE_MS,
  }), NOW);
  assert.equal(warning.state, "warning");

  const critical = buildQuickBooksIntegrationHealthReport(OAUTH_RUNTIME, snapshot({
    ...EMPTY_OPERATIONS,
    tokenRefreshFailureConnectionCount: 1,
    tokenRefreshReauthRequiredCount: 1,
    oldestTokenRefreshFailureAgeMs: QUICKBOOKS_MONITOR_CRITICAL_AGE_MS,
  }), NOW);
  assert.equal(critical.state, "critical");
});

test("distinguishes disabled configuration from OAuth-only health", () => {
  const report = buildQuickBooksIntegrationHealthReport({
    ...OAUTH_RUNTIME,
    providerWorkflowsEnabled: false,
    oauthOnlyMode: false,
    monitorBearer: "",
    apiSignalIngestUrl: "",
    apiSignalSourceToken: "",
  }, snapshot(), NOW);

  assert.equal(report.mode, "disabled");
  assert.equal(report.state, "healthy");
  assert.deepEqual(report.monitors, {
    bearerConfigured: false,
    apiSignalSinkConfigured: false,
    workerSignalSinkConfigured: null,
    deliveryVerified: false,
  });
});

test("fails closed instead of presenting malformed operational data", () => {
  assert.throws(
    () => buildQuickBooksIntegrationHealthReport(OAUTH_RUNTIME, snapshot({
      ...EMPTY_OPERATIONS,
      webhookDeadCount: -1,
    }), NOW),
    /operational count is invalid/i,
  );
});

test("whitelists operation fields when a future snapshot adds internal data", () => {
  const futureSnapshot = {
    operations: {
      ...EMPTY_OPERATIONS,
      futureInternalCanary: "must-not-cross-the-route-boundary",
    },
    workerFleet: null,
  };
  const report = buildQuickBooksIntegrationHealthReport(OAUTH_RUNTIME, futureSnapshot, NOW);

  assert.equal(Object.keys(report.operations).length, 18);
  assert.doesNotMatch(JSON.stringify(report), /futureInternalCanary|must-not-cross-the-route-boundary/);
});

test("reports worker readiness without exposing release identity or heartbeat metrics", () => {
  const accountingRuntime: QuickBooksIntegrationHealthRuntime = {
    ...OAUTH_RUNTIME,
    oauthOnlyMode: false,
    reconciliationWorkerEnabled: true,
    webhookConfigured: true,
  };
  const report = buildQuickBooksIntegrationHealthReport(
    accountingRuntime,
    { operations: EMPTY_OPERATIONS, workerFleet: workerFleet() },
    NOW,
  );

  assert.equal(report.mode, "accounting");
  assert.equal(report.state, "healthy");
  assert.deepEqual(report.worker, {
    required: true,
    status: "running",
    ready: true,
    lastObservedAtUtc: NOW.toISOString(),
    releaseMatches: true,
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /"apiReleaseSha"|"workerReleaseSha"|"metrics"/);
  assert.doesNotMatch(serialized, new RegExp("a".repeat(40)));

  const mismatchFleet = workerFleet({
    ready: false,
    counts: {
      ...workerFleet().counts,
      releaseMismatchInstanceCount: 1,
    },
    releaseIdentity: {
      ...workerFleet().releaseIdentity,
      workerReleaseSha: "b".repeat(40),
      matches: false,
    },
  });
  const mismatch = buildQuickBooksIntegrationHealthReport(
    accountingRuntime,
    { operations: EMPTY_OPERATIONS, workerFleet: mismatchFleet },
    NOW,
  );
  assert.equal(mismatch.state, "critical");
  assert.equal(mismatch.worker.status, "release_mismatch");
  assert.equal(mismatch.worker.releaseMatches, false);
  assert.doesNotMatch(JSON.stringify(mismatch), new RegExp("b".repeat(40)));
});
