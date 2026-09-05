import assert from "node:assert/strict";
import test from "node:test";
import {
  createQuickBooksWorkerOperationalTracker,
  evaluateQuickBooksProviderWindow,
  evaluateQuickBooksRetentionHeartbeat,
  parseQuickBooksWorkerOperationalHeartbeat,
  QUICKBOOKS_PROVIDER_SLOW_MS,
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  QUICKBOOKS_RETENTION_CRITICAL_AGE_MS,
  QUICKBOOKS_RETENTION_STARTUP_CRITICAL_AGE_MS,
  QUICKBOOKS_RETENTION_STARTUP_WARNING_AGE_MS,
  QUICKBOOKS_RETENTION_WARNING_AGE_MS,
  QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
  type QuickBooksProviderWindow,
  type QuickBooksRetentionHeartbeat,
} from "../../src/services/quickbooks-worker-operational";

const STARTUP = new Date("2026-09-04T20:00:00.000Z");
const at = (milliseconds: number) => new Date(STARTUP.getTime() + milliseconds);

function providerWindow(
  overrides: Partial<QuickBooksProviderWindow> = {},
): QuickBooksProviderWindow {
  return {
    windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
    callCount: 0,
    failureCount: 0,
    throttleCount: 0,
    timeoutCount: 0,
    slowCount: 0,
    degradedCallCount: 0,
    maximumDurationMs: 0,
    ...overrides,
  };
}

function retentionHeartbeat(
  overrides: Partial<QuickBooksRetentionHeartbeat> = {},
): QuickBooksRetentionHeartbeat {
  return {
    startupAtUtc: STARTUP.toISOString(),
    lastSucceededAtUtc: STARTUP.toISOString(),
    unresolvedFailure: false,
    consecutiveFailureCount: 0,
    ...overrides,
  };
}

test("five-minute provider window counts degraded calls once and expires observations", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "sandbox", startupAtUtc: STARTUP });
  tracker.recordProviderAttempt({ outcome: "timeout", durationMs: QUICKBOOKS_PROVIDER_SLOW_MS, occurredAtUtc: at(1) });
  for (let index = 0; index < 9; index += 1) {
    tracker.recordProviderAttempt({ outcome: "success", durationMs: 25 + index, occurredAtUtc: at(2 + index) });
  }

  assert.deepEqual(tracker.heartbeat(at(10)).providerWindow, {
    windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
    callCount: 10,
    failureCount: 1,
    throttleCount: 0,
    timeoutCount: 1,
    slowCount: 1,
    degradedCallCount: 1,
    maximumDurationMs: QUICKBOOKS_PROVIDER_SLOW_MS,
  });
  assert.equal(evaluateQuickBooksProviderWindow(tracker.heartbeat(at(10)).providerWindow), "WARNING");
  assert.deepEqual(tracker.heartbeat(at(QUICKBOOKS_PROVIDER_WINDOW_MS + 11)).providerWindow, providerWindow());
});

test("provider severity uses burst and union-ratio thresholds", () => {
  assert.equal(evaluateQuickBooksProviderWindow(providerWindow({
    callCount: 3,
    failureCount: 3,
    throttleCount: 2,
    timeoutCount: 1,
    degradedCallCount: 3,
    maximumDurationMs: 100,
  })), "CRITICAL");
  assert.equal(evaluateQuickBooksProviderWindow(providerWindow({
    callCount: 10,
    failureCount: 3,
    degradedCallCount: 3,
    maximumDurationMs: 100,
  })), "CRITICAL");
  assert.equal(evaluateQuickBooksProviderWindow(providerWindow({
    callCount: 10,
    failureCount: 2,
    degradedCallCount: 2,
    maximumDurationMs: 100,
  })), "HEALTHY");
  assert.equal(evaluateQuickBooksProviderWindow(providerWindow({
    callCount: 1,
    slowCount: 1,
    degradedCallCount: 1,
    maximumDurationMs: QUICKBOOKS_PROVIDER_SLOW_MS,
  })), "WARNING");
});

test("provider storage remains bounded under a burst", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "production", startupAtUtc: STARTUP });
  for (let index = 0; index < 5_000; index += 1) {
    tracker.recordProviderAttempt({ outcome: "throttle", durationMs: 1, occurredAtUtc: at(index) });
  }
  const snapshot = tracker.heartbeat(at(5_001));
  assert.equal(snapshot.providerWindow.callCount, 4_096);
  assert.equal(snapshot.providerWindow.throttleCount, 4_096);
  assert.equal(snapshot.providerWindow.degradedCallCount, 4_096);
});

test("retention health has exact startup and steady-state cadence boundaries", () => {
  const startupPending = retentionHeartbeat({ lastSucceededAtUtc: null });
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(startupPending, at(QUICKBOOKS_RETENTION_STARTUP_WARNING_AGE_MS)),
    "HEALTHY",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(startupPending, at(QUICKBOOKS_RETENTION_STARTUP_WARNING_AGE_MS + 1)),
    "WARNING",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(startupPending, at(QUICKBOOKS_RETENTION_STARTUP_CRITICAL_AGE_MS)),
    "WARNING",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(startupPending, at(QUICKBOOKS_RETENTION_STARTUP_CRITICAL_AGE_MS + 1)),
    "CRITICAL",
  );

  const succeeded = retentionHeartbeat();
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(succeeded, at(QUICKBOOKS_RETENTION_WARNING_AGE_MS)),
    "HEALTHY",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(succeeded, at(QUICKBOOKS_RETENTION_WARNING_AGE_MS + 1)),
    "WARNING",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(succeeded, at(QUICKBOOKS_RETENTION_CRITICAL_AGE_MS)),
    "WARNING",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat(succeeded, at(QUICKBOOKS_RETENTION_CRITICAL_AGE_MS + 1)),
    "CRITICAL",
  );
  assert.equal(
    evaluateQuickBooksRetentionHeartbeat({
      ...succeeded,
      unresolvedFailure: true,
      consecutiveFailureCount: 1,
    }, STARTUP),
    "CRITICAL",
  );
});

test("retention state remains in every heartbeat until a successful pass clears it", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "production", startupAtUtc: STARTUP });
  tracker.recordRetentionRun({ unresolvedFailureCount: 4, occurredAtUtc: at(1) });
  assert.deepEqual(tracker.heartbeat(at(2)).retention, {
    startupAtUtc: STARTUP.toISOString(),
    lastSucceededAtUtc: null,
    unresolvedFailure: true,
    consecutiveFailureCount: 1,
  });
  assert.equal(tracker.heartbeat(at(2)).environment, "production");

  tracker.recordRetentionRun({ unresolvedFailureCount: 1, occurredAtUtc: at(3) });
  assert.equal(tracker.heartbeat(at(4)).retention.consecutiveFailureCount, 2);
  tracker.recordRetentionRun({ unresolvedFailureCount: 0, occurredAtUtc: at(5) });
  assert.deepEqual(tracker.heartbeat(at(6)).retention, {
    startupAtUtc: STARTUP.toISOString(),
    lastSucceededAtUtc: at(5).toISOString(),
    unresolvedFailure: false,
    consecutiveFailureCount: 0,
  });
});

test("strict heartbeat parser accepts the closed contract and rejects unsafe or inconsistent fields", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "sandbox", startupAtUtc: STARTUP });
  tracker.recordProviderAttempt({ outcome: "throttle", durationMs: 9_000, occurredAtUtc: at(1) });
  tracker.recordRetentionRun({ unresolvedFailureCount: 2, occurredAtUtc: at(2) });
  const heartbeat = tracker.heartbeat(at(3));
  assert.deepEqual(parseQuickBooksWorkerOperationalHeartbeat({
    phase: "active_work",
    failureCodes: { "raw-code-must-not-be-read": 1 },
    quickBooksOperational: heartbeat,
  }), heartbeat);
  assert.equal(heartbeat.schema, QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA);

  const unsafe = structuredClone(heartbeat) as unknown as Record<string, unknown>;
  unsafe.errorName = "ErrorWithSecret";
  assert.equal(parseQuickBooksWorkerOperationalHeartbeat(unsafe), null);

  const inconsistent = structuredClone(heartbeat);
  inconsistent.providerWindow.degradedCallCount = 0;
  assert.equal(parseQuickBooksWorkerOperationalHeartbeat(inconsistent), null);

  const hiddenSlowCall = structuredClone(heartbeat);
  hiddenSlowCall.providerWindow.slowCount = 0;
  hiddenSlowCall.providerWindow.maximumDurationMs = QUICKBOOKS_PROVIDER_SLOW_MS;
  assert.equal(parseQuickBooksWorkerOperationalHeartbeat(hiddenSlowCall), null);

  const wrongEnvironment = structuredClone(heartbeat) as unknown as { environment: string };
  wrongEnvironment.environment = "staging";
  assert.equal(parseQuickBooksWorkerOperationalHeartbeat(wrongEnvironment), null);

  const noncanonicalTime = structuredClone(heartbeat);
  noncanonicalTime.retention.startupAtUtc = "2026-09-04 20:00:00Z";
  assert.equal(parseQuickBooksWorkerOperationalHeartbeat(noncanonicalTime), null);
});

test("provider summaries and transitions emit at most once per minute", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "sandbox", startupAtUtc: STARTUP });
  const first = tracker.drainExternalSignals(STARTUP);
  assert.equal(first.filter((signal) => signal.eventCode.startsWith("QUICKBOOKS_PROVIDER_")).length, 1);
  assert.equal(first[0]?.eventCode, "QUICKBOOKS_PROVIDER_HEALTH_SUMMARY");

  for (let index = 0; index < 3; index += 1) {
    tracker.recordProviderAttempt({ outcome: "throttle", durationMs: 10, occurredAtUtc: at(30_000 + index) });
  }
  assert.equal(tracker.drainExternalSignals(at(30_003)).length, 0);
  assert.equal(
    tracker.drainExternalSignals(at(60_000))[0]?.eventCode,
    "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL",
  );
  assert.equal(tracker.drainExternalSignals(at(119_999)).length, 0);
  assert.equal(
    tracker.drainExternalSignals(at(120_000))[0]?.eventCode,
    "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL",
  );
  assert.equal(
    tracker.drainExternalSignals(at(QUICKBOOKS_PROVIDER_WINDOW_MS + 30_003))[0]?.eventCode,
    "QUICKBOOKS_PROVIDER_HEALTH_RECOVERED",
  );
});

test("retention transitions are minute-limited and unresolved reminders are fifteen-minute limited", () => {
  const tracker = createQuickBooksWorkerOperationalTracker({ environment: "production", startupAtUtc: STARTUP });
  tracker.recordRetentionRun({ unresolvedFailureCount: 0, occurredAtUtc: STARTUP });
  tracker.drainExternalSignals(STARTUP);

  tracker.recordRetentionRun({ unresolvedFailureCount: 3, occurredAtUtc: at(1) });
  assert.equal(
    tracker.drainExternalSignals(at(1)).find((signal) => signal.eventCode.startsWith("QUICKBOOKS_RETENTION"))?.eventCode,
    "QUICKBOOKS_RETENTION_HEALTH_CRITICAL",
  );
  tracker.recordRetentionRun({ unresolvedFailureCount: 0, occurredAtUtc: at(30_000) });
  assert.equal(
    tracker.drainExternalSignals(at(30_000)).some((signal) => signal.eventCode.startsWith("QUICKBOOKS_RETENTION")),
    false,
  );
  assert.equal(
    tracker.drainExternalSignals(at(60_001)).find((signal) => signal.eventCode.startsWith("QUICKBOOKS_RETENTION"))?.eventCode,
    "QUICKBOOKS_RETENTION_HEALTH_RECOVERED",
  );

  const failed = createQuickBooksWorkerOperationalTracker({ environment: "sandbox", startupAtUtc: STARTUP });
  failed.recordRetentionRun({ unresolvedFailureCount: 1, occurredAtUtc: STARTUP });
  failed.drainExternalSignals(STARTUP);
  assert.equal(
    failed.drainExternalSignals(at(15 * 60 * 1_000 - 1))
      .some((signal) => signal.eventCode.includes("RETENTION")),
    false,
  );
  assert.equal(
    failed.drainExternalSignals(at(15 * 60 * 1_000))
      .find((signal) => signal.eventCode.includes("RETENTION"))?.eventCode,
    "QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER",
  );
});
