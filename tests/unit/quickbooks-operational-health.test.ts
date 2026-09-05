import assert from "node:assert/strict";
import test from "node:test";
import { quickBooksMonitorBearerMatches } from "../../src/routes/quickbooks-operational-monitor";
import {
  aggregateQuickBooksOperationalRows,
  evaluateQuickBooksOperationalSnapshot,
  maskPausedQuickBooksProviderActionMetrics,
  QUICKBOOKS_MONITOR_CDC_CRITICAL_LAG_MS,
  QUICKBOOKS_MONITOR_CDC_WARNING_LAG_MS,
  QUICKBOOKS_MONITOR_CRITICAL_AGE_MS,
  QUICKBOOKS_MONITOR_WARNING_AGE_MS,
  QUICKBOOKS_MONITOR_WORKER_CRITICAL_AGE_MS,
  type QuickBooksOperationalAggregate,
  type QuickBooksOperationalRuntime,
} from "../../src/services/quickbooks-operational-health";
import type { WorkerHeartbeatFleetSnapshot } from "../../src/services/worker-heartbeats";
import {
  QUICKBOOKS_PROVIDER_SLOW_MS,
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  QUICKBOOKS_RETENTION_CRITICAL_AGE_MS,
  QUICKBOOKS_RETENTION_WARNING_AGE_MS,
  QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
  type QuickBooksProviderWindow,
  type QuickBooksRetentionHeartbeat,
} from "../../src/services/quickbooks-worker-operational";

const NOW = new Date("2026-09-04T20:00:00.000Z");

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

const OAUTH_RUNTIME: QuickBooksOperationalRuntime = {
  environment: "sandbox",
  providerWorkflowsEnabled: true,
  oauthOnlyMode: true,
  reconciliationWorkerEnabled: false,
  cdcWorkerEnabled: false,
  requireWorkerReleaseIdentity: false,
};

const RECONCILIATION_RUNTIME: QuickBooksOperationalRuntime = {
  ...OAUTH_RUNTIME,
  oauthOnlyMode: false,
  reconciliationWorkerEnabled: true,
};

function operationalMetrics(options: {
  environment?: "sandbox" | "production";
  providerWindow?: Partial<QuickBooksProviderWindow>;
  retention?: Partial<QuickBooksRetentionHeartbeat>;
} = {}) {
  return {
    quickBooksOperational: {
      schema: QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
      environment: options.environment ?? "sandbox",
      providerWindow: {
        windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
        callCount: 0,
        failureCount: 0,
        throttleCount: 0,
        timeoutCount: 0,
        slowCount: 0,
        degradedCallCount: 0,
        maximumDurationMs: 0,
        ...options.providerWindow,
      },
      retention: {
        startupAtUtc: NOW.toISOString(),
        lastSucceededAtUtc: NOW.toISOString(),
        unresolvedFailure: false,
        consecutiveFailureCount: 0,
        ...options.retention,
      },
    },
  };
}

function fleet(
  overrides: Partial<WorkerHeartbeatFleetSnapshot> = {},
): WorkerHeartbeatFleetSnapshot {
  const releaseSha = "a".repeat(40);
  return {
    representative: {
      status: "RUNNING",
      fresh: true,
      heartbeatAtUtc: NOW,
      observedAtUtc: NOW,
      startedAtUtc: NOW,
      cycleStartedAtUtc: NOW,
      lastCycleDurationMs: 10,
      metrics: operationalMetrics(),
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

function evaluateOperationalMetrics(
  metrics: ReturnType<typeof operationalMetrics>,
  now = NOW,
) {
  const startedAtUtc = new Date(metrics.quickBooksOperational.retention.startupAtUtc);
  const workerFleet = fleet({
    representative: {
      ...fleet().representative!,
      startedAtUtc,
      observedAtUtc: now,
      heartbeatAtUtc: now,
      metrics,
    },
  });
  return evaluateQuickBooksOperationalSnapshot(
    RECONCILIATION_RUNTIME,
    { operations: EMPTY_OPERATIONS, workerFleet },
    now,
  );
}

test("aggregates tenant-safe QuickBooks operational inventory and oldest ages", () => {
  const aggregated = aggregateQuickBooksOperationalRows([
    {
      webhookOutstandingCount: 1,
      webhookDeadCount: 0,
      oldestWebhookOutstandingAtUtc: new Date(NOW.getTime() - 60_000),
      reconciliationRequiredCount: 0,
      oldestReconciliationRequiredAtUtc: null,
      cdcCursorCount: 1,
      cdcTerminalCount: 0,
      cdcOverdueCount: 1,
      oldestCdcChangedSinceUtc: new Date(NOW.getTime() - 120_000),
      connectionRevocationPendingCount: 1,
      connectionRevocationDeadCount: 0,
      oldestConnectionRevocationPendingAtUtc: new Date(NOW.getTime() - 30_000),
      orphanRevocationPendingCount: 0,
      orphanRevocationDeadCount: 0,
      oldestOrphanRevocationPendingAtUtc: null,
      tokenRefreshFailureConnectionCount: 0,
      tokenRefreshReauthRequiredCount: 0,
      oldestTokenRefreshFailureStartedAtUtc: null,
    },
    {
      webhookOutstandingCount: 2,
      webhookDeadCount: 1,
      oldestWebhookOutstandingAtUtc: new Date(NOW.getTime() - 180_000),
      reconciliationRequiredCount: 1,
      oldestReconciliationRequiredAtUtc: new Date(NOW.getTime() - 90_000),
      cdcCursorCount: 0,
      cdcTerminalCount: 0,
      cdcOverdueCount: 0,
      oldestCdcChangedSinceUtc: null,
      connectionRevocationPendingCount: 0,
      connectionRevocationDeadCount: 1,
      oldestConnectionRevocationPendingAtUtc: null,
      orphanRevocationPendingCount: 1,
      orphanRevocationDeadCount: 1,
      oldestOrphanRevocationPendingAtUtc: new Date(NOW.getTime() - 45_000),
      tokenRefreshFailureConnectionCount: 1,
      tokenRefreshReauthRequiredCount: 1,
      oldestTokenRefreshFailureStartedAtUtc: new Date(NOW.getTime() - 75_000),
    },
  ], NOW);

  assert.deepEqual(aggregated, {
    webhookOutstandingCount: 3,
    webhookDeadCount: 1,
    oldestWebhookOutstandingAgeMs: 180_000,
    reconciliationRequiredCount: 1,
    oldestReconciliationRequiredAgeMs: 90_000,
    cdcCursorCount: 1,
    cdcTerminalCount: 0,
    cdcOverdueCount: 1,
    maximumCdcLagMs: 120_000,
    connectionRevocationPendingCount: 1,
    connectionRevocationDeadCount: 1,
    oldestConnectionRevocationPendingAgeMs: 30_000,
    orphanRevocationPendingCount: 1,
    orphanRevocationDeadCount: 1,
    oldestOrphanRevocationPendingAgeMs: 45_000,
    tokenRefreshFailureConnectionCount: 1,
    tokenRefreshReauthRequiredCount: 1,
    oldestTokenRefreshFailureAgeMs: 75_000,
  });
});

test("masks paused provider queues while preserving lifecycle and security signals", () => {
  const row = maskPausedQuickBooksProviderActionMetrics({
    webhookOutstandingCount: 4,
    webhookDeadCount: 2,
    oldestWebhookOutstandingAtUtc: new Date(NOW.getTime() - 60_000),
    reconciliationRequiredCount: 3,
    oldestReconciliationRequiredAtUtc: new Date(NOW.getTime() - 120_000),
    cdcCursorCount: 2,
    cdcTerminalCount: 1,
    cdcOverdueCount: 1,
    oldestCdcChangedSinceUtc: new Date(NOW.getTime() - 180_000),
    connectionRevocationPendingCount: 1,
    connectionRevocationDeadCount: 1,
    oldestConnectionRevocationPendingAtUtc: new Date(NOW.getTime() - 240_000),
    orphanRevocationPendingCount: 2,
    orphanRevocationDeadCount: 1,
    oldestOrphanRevocationPendingAtUtc: new Date(NOW.getTime() - 300_000),
    tokenRefreshFailureConnectionCount: 1,
    tokenRefreshReauthRequiredCount: 1,
    oldestTokenRefreshFailureStartedAtUtc: new Date(NOW.getTime() - 360_000),
  });

  assert.deepEqual(row, {
    webhookOutstandingCount: 0,
    webhookDeadCount: 2,
    oldestWebhookOutstandingAtUtc: null,
    reconciliationRequiredCount: 0,
    oldestReconciliationRequiredAtUtc: null,
    cdcCursorCount: 0,
    cdcTerminalCount: 0,
    cdcOverdueCount: 0,
    oldestCdcChangedSinceUtc: null,
    connectionRevocationPendingCount: 1,
    connectionRevocationDeadCount: 1,
    oldestConnectionRevocationPendingAtUtc: new Date(NOW.getTime() - 240_000),
    orphanRevocationPendingCount: 2,
    orphanRevocationDeadCount: 1,
    oldestOrphanRevocationPendingAtUtc: new Date(NOW.getTime() - 300_000),
    tokenRefreshFailureConnectionCount: 1,
    tokenRefreshReauthRequiredCount: 1,
    oldestTokenRefreshFailureStartedAtUtc: new Date(NOW.getTime() - 360_000),
  });
});

test("OAuth-only phase does not require a worker or evaluate dormant CDC lag", () => {
  const evaluation = evaluateQuickBooksOperationalSnapshot(OAUTH_RUNTIME, {
    operations: {
      ...EMPTY_OPERATIONS,
      cdcCursorCount: 1,
      cdcOverdueCount: 1,
      maximumCdcLagMs: QUICKBOOKS_MONITOR_CRITICAL_AGE_MS,
    },
    workerFleet: null,
  }, NOW);
  assert.deepEqual(evaluation, { warningUnhealthy: false, criticalUnhealthy: false });
});

test("uses the documented five-minute warning and fifteen-minute critical ages", () => {
  const warning = evaluateQuickBooksOperationalSnapshot(OAUTH_RUNTIME, {
    operations: {
      ...EMPTY_OPERATIONS,
      webhookOutstandingCount: 1,
      oldestWebhookOutstandingAgeMs: QUICKBOOKS_MONITOR_WARNING_AGE_MS,
    },
    workerFleet: null,
  }, NOW);
  assert.deepEqual(warning, { warningUnhealthy: true, criticalUnhealthy: false });

  const critical = evaluateQuickBooksOperationalSnapshot(OAUTH_RUNTIME, {
    operations: {
      ...EMPTY_OPERATIONS,
      orphanRevocationPendingCount: 1,
      oldestOrphanRevocationPendingAgeMs: QUICKBOOKS_MONITOR_CRITICAL_AGE_MS,
    },
    workerFleet: null,
  }, NOW);
  assert.deepEqual(critical, { warningUnhealthy: true, criticalUnhealthy: true });
});

test("CDC warning and critical boundaries stay above the normal seven-minute horizon", () => {
  const runtime: QuickBooksOperationalRuntime = {
    ...RECONCILIATION_RUNTIME,
    cdcWorkerEnabled: true,
  };
  const evaluateLag = (lagMs: number, overdue = 1) => evaluateQuickBooksOperationalSnapshot(runtime, {
    operations: {
      ...EMPTY_OPERATIONS,
      cdcCursorCount: 1,
      cdcOverdueCount: overdue,
      maximumCdcLagMs: lagMs,
    },
    workerFleet: fleet(),
  }, NOW);

  assert.deepEqual(evaluateLag(7 * 60 * 1_000), { warningUnhealthy: false, criticalUnhealthy: false });
  assert.deepEqual(
    evaluateLag(QUICKBOOKS_MONITOR_CDC_WARNING_LAG_MS - 1),
    { warningUnhealthy: false, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateLag(QUICKBOOKS_MONITOR_CDC_WARNING_LAG_MS),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateLag(QUICKBOOKS_MONITOR_CDC_CRITICAL_LAG_MS),
    { warningUnhealthy: true, criticalUnhealthy: true },
  );
  assert.deepEqual(
    evaluateLag(QUICKBOOKS_MONITOR_CDC_CRITICAL_LAG_MS, 0),
    { warningUnhealthy: false, criticalUnhealthy: false },
    "a scheduled cursor that is not overdue must not page before its next attempt",
  );
});

test("dead, reauthorization-required, and terminal recovery inventory is immediately critical", () => {
  for (const operations of [
    { ...EMPTY_OPERATIONS, webhookDeadCount: 1 },
    { ...EMPTY_OPERATIONS, connectionRevocationDeadCount: 1 },
    { ...EMPTY_OPERATIONS, orphanRevocationDeadCount: 1 },
    { ...EMPTY_OPERATIONS, tokenRefreshReauthRequiredCount: 1 },
    { ...EMPTY_OPERATIONS, cdcCursorCount: 1, cdcTerminalCount: 1 },
  ]) {
    assert.deepEqual(
      evaluateQuickBooksOperationalSnapshot(OAUTH_RUNTIME, { operations, workerFleet: null }, NOW),
      { warningUnhealthy: true, criticalUnhealthy: true },
    );
  }
});

test("reconciliation warns on lost capacity and becomes critical after three minutes", () => {
  const twoMinutesStale = fleet({
    ready: false,
    representative: {
      ...fleet().representative!,
      fresh: false,
      observedAtUtc: new Date(NOW.getTime() - QUICKBOOKS_MONITOR_WORKER_CRITICAL_AGE_MS + 1),
    },
    counts: {
      ...fleet().counts,
      freshLiveInstanceCount: 0,
      capacityInstanceCount: 0,
      staleInstanceCount: 1,
    },
  });
  assert.deepEqual(
    evaluateQuickBooksOperationalSnapshot(
      RECONCILIATION_RUNTIME,
      { operations: EMPTY_OPERATIONS, workerFleet: twoMinutesStale },
      NOW,
    ),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );

  const threeMinutesStale = fleet({
    ...twoMinutesStale,
    representative: {
      ...twoMinutesStale.representative!,
      observedAtUtc: new Date(NOW.getTime() - QUICKBOOKS_MONITOR_WORKER_CRITICAL_AGE_MS),
    },
  });
  assert.deepEqual(
    evaluateQuickBooksOperationalSnapshot(
      RECONCILIATION_RUNTIME,
      { operations: EMPTY_OPERATIONS, workerFleet: threeMinutesStale },
      NOW,
    ),
    { warningUnhealthy: true, criticalUnhealthy: true },
  );
});

test("required worker absence, terminal capacity, SHA mismatch, missing SHA, and overflow are critical", () => {
  const terminalFleet = fleet({
    ready: false,
    representative: { ...fleet().representative!, status: "FAILED", fresh: false },
    counts: { ...fleet().counts, freshLiveInstanceCount: 0, capacityInstanceCount: 0, terminalInstanceCount: 1 },
  });
  const mismatchFleet = fleet({
    ready: false,
    counts: { ...fleet().counts, releaseMismatchInstanceCount: 1 },
    releaseIdentity: { ...fleet().releaseIdentity, matches: false },
  });
  const missingShaFleet = fleet({
    ready: false,
    counts: { ...fleet().counts, missingReleaseShaInstanceCount: 1 },
    releaseIdentity: { apiReleaseSha: "a".repeat(40), workerReleaseSha: null, matches: false },
  });
  const overflowFleet = fleet({
    ready: false,
    freshLiveOverflowed: true,
    counts: { ...fleet().counts, freshLiveInstanceCount: 101, capacityInstanceCount: 101, overflowedFreshLiveInstanceCount: 1 },
  });
  for (const workerFleet of [null, terminalFleet, mismatchFleet, missingShaFleet, overflowFleet]) {
    assert.equal(evaluateQuickBooksOperationalSnapshot(
      RECONCILIATION_RUNTIME,
      {
        operations: EMPTY_OPERATIONS,
        workerFleet,
        ...(workerFleet === overflowFleet
          ? {
              workerOperationalInstances: Array.from({ length: 101 }, () => ({
                startedAtUtc: NOW,
                observedAtUtc: NOW,
                metrics: operationalMetrics(),
              })),
            }
          : {}),
      },
      NOW,
    ).criticalUnhealthy, true);
  }
});

test("provider health uses the five-minute warning, burst, and degraded-ratio boundaries", () => {
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 1,
      failureCount: 1,
      throttleCount: 1,
      degradedCallCount: 1,
      maximumDurationMs: 100,
    },
  })), { warningUnhealthy: true, criticalUnhealthy: false });
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 3,
      failureCount: 3,
      throttleCount: 2,
      timeoutCount: 1,
      degradedCallCount: 3,
      maximumDurationMs: 100,
    },
  })), { warningUnhealthy: true, criticalUnhealthy: true });
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 10,
      failureCount: 2,
      degradedCallCount: 2,
      maximumDurationMs: 100,
    },
  })), { warningUnhealthy: false, criticalUnhealthy: false });
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 10,
      failureCount: 3,
      degradedCallCount: 3,
      maximumDurationMs: 100,
    },
  })), { warningUnhealthy: true, criticalUnhealthy: true });
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 1,
      slowCount: 1,
      degradedCallCount: 1,
      maximumDurationMs: QUICKBOOKS_PROVIDER_SLOW_MS,
    },
  })), { warningUnhealthy: true, criticalUnhealthy: false });
});

test("provider burst and degraded-ratio thresholds reduce across the fresh fleet", () => {
  const evaluateFleet = (providerWindows: readonly Partial<QuickBooksProviderWindow>[]) => {
    const metrics = providerWindows.map((providerWindow) => operationalMetrics({ providerWindow }));
    return evaluateQuickBooksOperationalSnapshot(RECONCILIATION_RUNTIME, {
      operations: EMPTY_OPERATIONS,
      workerFleet: fleet({
        counts: {
          ...fleet().counts,
          totalInstanceCount: metrics.length,
          freshLiveInstanceCount: metrics.length,
          capacityInstanceCount: metrics.length,
        },
      }),
      workerOperationalInstances: metrics.map((instanceMetrics) => ({
        startedAtUtc: NOW,
        observedAtUtc: NOW,
        metrics: instanceMetrics,
      })),
    }, NOW);
  };

  assert.deepEqual(evaluateFleet([
    {
      callCount: 2,
      failureCount: 2,
      timeoutCount: 2,
      degradedCallCount: 2,
      maximumDurationMs: 100,
    },
    {
      callCount: 2,
      failureCount: 2,
      timeoutCount: 2,
      degradedCallCount: 2,
      maximumDurationMs: 100,
    },
  ]), { warningUnhealthy: true, criticalUnhealthy: true });

  assert.deepEqual(evaluateFleet([
    {
      callCount: 6,
      failureCount: 2,
      degradedCallCount: 2,
      maximumDurationMs: 100,
    },
    {
      callCount: 6,
      failureCount: 2,
      degradedCallCount: 2,
      maximumDurationMs: 100,
    },
  ]), { warningUnhealthy: true, criticalUnhealthy: true });
});

test("retention cadence honors startup grace and the 75/90-minute strict boundaries", () => {
  const startupAtUtc = new Date(NOW.getTime() - 5 * 60 * 1_000);
  const startupMetrics = (ageMs: number) => operationalMetrics({
    retention: {
      startupAtUtc: new Date(NOW.getTime() - ageMs).toISOString(),
      lastSucceededAtUtc: null,
    },
  });
  assert.deepEqual(
    evaluateOperationalMetrics(startupMetrics(NOW.getTime() - startupAtUtc.getTime())),
    { warningUnhealthy: false, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(startupMetrics(5 * 60 * 1_000 + 1)),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(startupMetrics(15 * 60 * 1_000)),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(startupMetrics(15 * 60 * 1_000 + 1)),
    { warningUnhealthy: true, criticalUnhealthy: true },
  );

  const succeededMetrics = (ageMs: number) => operationalMetrics({
    retention: {
      startupAtUtc: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000).toISOString(),
      lastSucceededAtUtc: new Date(NOW.getTime() - ageMs).toISOString(),
    },
  });
  assert.deepEqual(
    evaluateOperationalMetrics(succeededMetrics(QUICKBOOKS_RETENTION_WARNING_AGE_MS)),
    { warningUnhealthy: false, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(succeededMetrics(QUICKBOOKS_RETENTION_WARNING_AGE_MS + 1)),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(succeededMetrics(QUICKBOOKS_RETENTION_CRITICAL_AGE_MS)),
    { warningUnhealthy: true, criticalUnhealthy: false },
  );
  assert.deepEqual(
    evaluateOperationalMetrics(succeededMetrics(QUICKBOOKS_RETENTION_CRITICAL_AGE_MS + 1)),
    { warningUnhealthy: true, criticalUnhealthy: true },
  );
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({
    retention: { unresolvedFailure: true, consecutiveFailureCount: 1 },
  })), { warningUnhealthy: true, criticalUnhealthy: true });
});

test("environment mismatch and nonrepresentative fleet degradation are critical", () => {
  assert.deepEqual(evaluateOperationalMetrics(operationalMetrics({ environment: "production" })), {
    warningUnhealthy: true,
    criticalUnhealthy: true,
  });

  const healthyMetrics = operationalMetrics();
  const degradedMetrics = operationalMetrics({
    providerWindow: {
      callCount: 3,
      failureCount: 3,
      timeoutCount: 3,
      degradedCallCount: 3,
      maximumDurationMs: 100,
    },
  });
  const twoWorkerFleet = fleet({
    counts: {
      ...fleet().counts,
      totalInstanceCount: 2,
      freshLiveInstanceCount: 2,
      capacityInstanceCount: 2,
    },
  });
  const evaluation = evaluateQuickBooksOperationalSnapshot(RECONCILIATION_RUNTIME, {
    operations: EMPTY_OPERATIONS,
    workerFleet: twoWorkerFleet,
    workerOperationalInstances: [healthyMetrics, degradedMetrics].map((metrics) => ({
      startedAtUtc: NOW,
      observedAtUtc: NOW,
      metrics,
    })),
  }, NOW);
  assert.deepEqual(evaluation, { warningUnhealthy: true, criticalUnhealthy: true });
});

test("malformed or incomplete worker operational health fails closed", () => {
  const missingMetricsFleet = fleet({
    representative: { ...fleet().representative!, metrics: {} },
  });
  assert.throws(() => evaluateQuickBooksOperationalSnapshot(RECONCILIATION_RUNTIME, {
    operations: EMPTY_OPERATIONS,
    workerFleet: missingMetricsFleet,
  }, NOW), /operational heartbeat is invalid/i);
  assert.throws(() => evaluateOperationalMetrics(operationalMetrics({
    providerWindow: {
      callCount: 1,
      failureCount: 2,
      degradedCallCount: 1,
      maximumDurationMs: 100,
    },
  })), /operational heartbeat is invalid/i);
  assert.throws(() => evaluateQuickBooksOperationalSnapshot(RECONCILIATION_RUNTIME, {
    operations: EMPTY_OPERATIONS,
    workerFleet: fleet({
      counts: { ...fleet().counts, totalInstanceCount: 2, freshLiveInstanceCount: 2, capacityInstanceCount: 2 },
    }),
    workerOperationalInstances: [{ startedAtUtc: NOW, observedAtUtc: NOW, metrics: operationalMetrics() }],
  }, NOW), /inventory is unavailable/i);
});

test("fails closed on invalid phase and inconsistent operational inventory", () => {
  assert.throws(() => evaluateQuickBooksOperationalSnapshot({
    ...OAUTH_RUNTIME,
    reconciliationWorkerEnabled: true,
  }, { operations: EMPTY_OPERATIONS, workerFleet: fleet() }, NOW), /phase is invalid/i);
  assert.throws(() => evaluateQuickBooksOperationalSnapshot(OAUTH_RUNTIME, {
    operations: { ...EMPTY_OPERATIONS, webhookOutstandingCount: 1 },
    workerFleet: null,
  }, NOW), /inventory age is unavailable/i);
});

test("monitor bearer validation accepts one exact header token only", () => {
  const bearer = "independent-quickbooks-monitor-bearer-000001";
  assert.equal(quickBooksMonitorBearerMatches(`Bearer ${bearer}`, bearer), true);
  assert.equal(quickBooksMonitorBearerMatches(`bearer ${bearer}`, bearer), false);
  assert.equal(quickBooksMonitorBearerMatches(`Bearer ${bearer} extra`, bearer), false);
  assert.equal(quickBooksMonitorBearerMatches(`Bearer ${bearer}-wrong`, bearer), false);
  assert.equal(quickBooksMonitorBearerMatches(undefined, bearer), false);
  assert.equal(quickBooksMonitorBearerMatches("Bearer short", "short"), false);
});
