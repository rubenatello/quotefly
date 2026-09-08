export const QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA = "quotefly.quickbooks-worker-operational/v1" as const;
export const QUICKBOOKS_PROVIDER_WINDOW_MS = 5 * 60 * 1_000;
export const QUICKBOOKS_PROVIDER_SLOW_MS = 8_000;
export const QUICKBOOKS_PROVIDER_SIGNAL_INTERVAL_MS = 60_000;
export const QUICKBOOKS_RETENTION_WARNING_AGE_MS = 75 * 60 * 1_000;
export const QUICKBOOKS_RETENTION_CRITICAL_AGE_MS = 90 * 60 * 1_000;
export const QUICKBOOKS_RETENTION_STARTUP_WARNING_AGE_MS = 5 * 60 * 1_000;
export const QUICKBOOKS_RETENTION_STARTUP_CRITICAL_AGE_MS = 15 * 60 * 1_000;
export const QUICKBOOKS_RETENTION_TRANSITION_INTERVAL_MS = 60_000;
export const QUICKBOOKS_RETENTION_REMINDER_INTERVAL_MS = 15 * 60 * 1_000;

const QUICKBOOKS_PROVIDER_MAX_OBSERVATIONS = 4_096;

export type QuickBooksWorkerEnvironment = "sandbox" | "production";
export type QuickBooksProviderAttemptOutcome = "success" | "failure" | "throttle" | "timeout";
export type QuickBooksOperationalHealth = "HEALTHY" | "WARNING" | "CRITICAL";

export type QuickBooksProviderAttemptObservation = Readonly<{
  outcome: QuickBooksProviderAttemptOutcome;
  durationMs: number;
}>;

export type QuickBooksProviderWindow = Readonly<{
  windowMs: typeof QUICKBOOKS_PROVIDER_WINDOW_MS;
  callCount: number;
  failureCount: number;
  throttleCount: number;
  timeoutCount: number;
  slowCount: number;
  degradedCallCount: number;
  maximumDurationMs: number;
}>;

export type QuickBooksRetentionHeartbeat = Readonly<{
  startupAtUtc: string;
  lastSucceededAtUtc: string | null;
  unresolvedFailure: boolean;
  consecutiveFailureCount: number;
}>;

export type QuickBooksWorkerOperationalHeartbeat = Readonly<{
  schema: typeof QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA;
  environment: QuickBooksWorkerEnvironment;
  providerWindow: QuickBooksProviderWindow;
  retention: QuickBooksRetentionHeartbeat;
}>;

export type QuickBooksProviderOperationalEventCode =
  | "QUICKBOOKS_PROVIDER_HEALTH_SUMMARY"
  | "QUICKBOOKS_PROVIDER_HEALTH_WARNING"
  | "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL"
  | "QUICKBOOKS_PROVIDER_HEALTH_RECOVERED";

export type QuickBooksProviderOperationalSignal = Readonly<{
  eventCode: QuickBooksProviderOperationalEventCode;
  outcome: QuickBooksOperationalHealth | "RECOVERED";
  /** Compatibility name: this is the count of actual outbound HTTP attempts. */
  providerWorkflowCount: number;
  providerFailureCount: number;
  providerThrottleCount: number;
  providerTimeoutCount: number;
  providerSlowCount: number;
  providerDegradedCallCount: number;
  providerMaxDurationMs: number;
}>;

export type QuickBooksRetentionOperationalEventCode =
  | "QUICKBOOKS_RETENTION_HEALTH_WARNING"
  | "QUICKBOOKS_RETENTION_HEALTH_CRITICAL"
  | "QUICKBOOKS_RETENTION_HEALTH_RECOVERED"
  | "QUICKBOOKS_RETENTION_HEALTH_WARNING_REMINDER"
  | "QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER";

export type QuickBooksRetentionOperationalSignal = Readonly<{
  eventCode: QuickBooksRetentionOperationalEventCode;
  outcome: Exclude<QuickBooksOperationalHealth, "HEALTHY"> | "RECOVERED";
}>;

export type QuickBooksWorkerOperationalSignal =
  | QuickBooksProviderOperationalSignal
  | QuickBooksRetentionOperationalSignal;

type ProviderObservation = Readonly<{
  occurredAtMs: number;
  durationMs: number;
  failed: boolean;
  throttled: boolean;
  timedOut: boolean;
  slow: boolean;
}>;

export type QuickBooksWorkerOperationalTracker = Readonly<{
  recordProviderAttempt: (params: Readonly<{
    outcome: QuickBooksProviderAttemptOutcome;
    durationMs: number;
    occurredAtUtc?: Date;
  }>) => void;
  recordRetentionRun: (params: Readonly<{
    unresolvedFailureCount: number;
    occurredAtUtc?: Date;
  }>) => void;
  heartbeat: (now?: Date) => QuickBooksWorkerOperationalHeartbeat;
  drainExternalSignals: (now?: Date) => readonly QuickBooksWorkerOperationalSignal[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function boundedNonnegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

type ProviderAttemptObserverRegistration = Readonly<{
  marker: symbol;
  observer: (observation: QuickBooksProviderAttemptObservation) => void;
}>;

let providerAttemptObserverRegistration: ProviderAttemptObserverRegistration | null = null;

/**
 * Installs the process-local provider-attempt observer used only by the
 * reconciliation worker. API and OAuth processes deliberately leave it unset.
 * The returned cleanup is ownership-safe when tests or startup code replace an
 * older registration.
 */
export function registerQuickBooksProviderAttemptObserver(
  observer: (observation: QuickBooksProviderAttemptObservation) => void,
): () => void {
  if (typeof observer !== "function") {
    throw new TypeError("QuickBooks provider attempt observer must be a function.");
  }
  const registration = { marker: Symbol("quickbooks-provider-attempt-observer"), observer };
  providerAttemptObserverRegistration = registration;
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    if (providerAttemptObserverRegistration?.marker === registration.marker) {
      providerAttemptObserverRegistration = null;
    }
  };
}

/** Returns one closed transport outcome without retaining status or error text. */
export function classifyQuickBooksProviderAttempt(params: Readonly<{
  statusCode?: unknown;
  errorName?: unknown;
}>): QuickBooksProviderAttemptOutcome {
  if (params.statusCode === 429) return "throttle";
  if (params.statusCode === 408 || params.statusCode === 504) return "timeout";
  if (
    typeof params.statusCode === "number"
    && Number.isInteger(params.statusCode)
    && params.statusCode >= 200
    && params.statusCode < 300
  ) return "success";
  if (params.errorName === "TimeoutError" || params.errorName === "AbortError") return "timeout";
  return "failure";
}

/**
 * Reports a rebuilt, closed observation. Observer bugs are swallowed so
 * telemetry can never change an Intuit request's result or retry behavior.
 */
export function reportQuickBooksProviderAttempt(
  observation: QuickBooksProviderAttemptObservation,
): void {
  try {
    const registration = providerAttemptObserverRegistration;
    if (!registration) return;
    const outcome = observation.outcome === "success"
      || observation.outcome === "throttle"
      || observation.outcome === "timeout"
      || observation.outcome === "failure"
      ? observation.outcome
      : "failure";
    registration.observer(Object.freeze({
      outcome,
      durationMs: boundedNonnegativeInteger(observation.durationMs),
    }));
  } catch {
    // Provider availability and accounting correctness never depend on telemetry.
  }
}

export function evaluateQuickBooksProviderWindow(
  providerWindow: QuickBooksProviderWindow,
): QuickBooksOperationalHealth {
  const criticalBurst = providerWindow.throttleCount + providerWindow.timeoutCount >= 3;
  const criticalRatio = providerWindow.callCount >= 10
    && providerWindow.degradedCallCount / providerWindow.callCount >= 0.25;
  if (criticalBurst || criticalRatio) return "CRITICAL";
  if (
    providerWindow.throttleCount > 0
    || providerWindow.timeoutCount > 0
    || providerWindow.slowCount > 0
  ) return "WARNING";
  return "HEALTHY";
}

export function evaluateQuickBooksRetentionHeartbeat(
  retention: QuickBooksRetentionHeartbeat,
  now = new Date(),
): QuickBooksOperationalHealth {
  if (retention.unresolvedFailure) return "CRITICAL";
  const referenceAtMs = new Date(retention.lastSucceededAtUtc ?? retention.startupAtUtc).getTime();
  const ageMs = Math.max(0, now.getTime() - referenceAtMs);
  const criticalAgeMs = retention.lastSucceededAtUtc === null
    ? QUICKBOOKS_RETENTION_STARTUP_CRITICAL_AGE_MS
    : QUICKBOOKS_RETENTION_CRITICAL_AGE_MS;
  const warningAgeMs = retention.lastSucceededAtUtc === null
    ? QUICKBOOKS_RETENTION_STARTUP_WARNING_AGE_MS
    : QUICKBOOKS_RETENTION_WARNING_AGE_MS;
  if (ageMs > criticalAgeMs) return "CRITICAL";
  if (ageMs > warningAgeMs) return "WARNING";
  return "HEALTHY";
}

export function parseQuickBooksWorkerOperationalHeartbeat(
  value: unknown,
): QuickBooksWorkerOperationalHeartbeat | null {
  if (!isRecord(value)) return null;
  const candidate = Object.prototype.hasOwnProperty.call(value, "quickBooksOperational")
    ? value.quickBooksOperational
    : value;
  if (!isRecord(candidate) || !hasExactKeys(candidate, [
    "schema",
    "environment",
    "providerWindow",
    "retention",
  ])) return null;
  if (
    candidate.schema !== QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA
    || (candidate.environment !== "sandbox" && candidate.environment !== "production")
    || !isRecord(candidate.providerWindow)
    || !isRecord(candidate.retention)
  ) return null;

  const providerWindow = candidate.providerWindow;
  if (!hasExactKeys(providerWindow, [
    "windowMs",
    "callCount",
    "failureCount",
    "throttleCount",
    "timeoutCount",
    "slowCount",
    "degradedCallCount",
    "maximumDurationMs",
  ])) return null;
  const numericProviderFields = [
    providerWindow.callCount,
    providerWindow.failureCount,
    providerWindow.throttleCount,
    providerWindow.timeoutCount,
    providerWindow.slowCount,
    providerWindow.degradedCallCount,
    providerWindow.maximumDurationMs,
  ];
  if (
    providerWindow.windowMs !== QUICKBOOKS_PROVIDER_WINDOW_MS
    || numericProviderFields.some((field) => !isNonnegativeSafeInteger(field))
  ) return null;
  const callCount = providerWindow.callCount as number;
  const failureCount = providerWindow.failureCount as number;
  const throttleCount = providerWindow.throttleCount as number;
  const timeoutCount = providerWindow.timeoutCount as number;
  const slowCount = providerWindow.slowCount as number;
  const degradedCallCount = providerWindow.degradedCallCount as number;
  const maximumDurationMs = providerWindow.maximumDurationMs as number;
  if (
    failureCount > callCount
    || throttleCount > callCount
    || timeoutCount > callCount
    || slowCount > callCount
    || degradedCallCount > callCount
    || throttleCount + timeoutCount > failureCount
    || degradedCallCount < Math.max(failureCount, slowCount)
    || degradedCallCount > Math.min(callCount, failureCount + slowCount)
    || (callCount === 0 && maximumDurationMs !== 0)
    || (slowCount > 0 && maximumDurationMs < QUICKBOOKS_PROVIDER_SLOW_MS)
    || (slowCount === 0 && maximumDurationMs >= QUICKBOOKS_PROVIDER_SLOW_MS)
  ) return null;

  const retention = candidate.retention;
  if (!hasExactKeys(retention, [
    "startupAtUtc",
    "lastSucceededAtUtc",
    "unresolvedFailure",
    "consecutiveFailureCount",
  ])) return null;
  if (
    !canonicalUtcTimestamp(retention.startupAtUtc)
    || (retention.lastSucceededAtUtc !== null && !canonicalUtcTimestamp(retention.lastSucceededAtUtc))
    || typeof retention.unresolvedFailure !== "boolean"
    || !isNonnegativeSafeInteger(retention.consecutiveFailureCount)
    || (retention.unresolvedFailure && retention.consecutiveFailureCount === 0)
    || (!retention.unresolvedFailure && retention.consecutiveFailureCount !== 0)
    || (retention.lastSucceededAtUtc !== null
      && new Date(retention.lastSucceededAtUtc).getTime() < new Date(retention.startupAtUtc).getTime())
  ) return null;

  return {
    schema: QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
    environment: candidate.environment,
    providerWindow: {
      windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
      callCount,
      failureCount,
      throttleCount,
      timeoutCount,
      slowCount,
      degradedCallCount,
      maximumDurationMs,
    },
    retention: {
      startupAtUtc: retention.startupAtUtc,
      lastSucceededAtUtc: retention.lastSucceededAtUtc,
      unresolvedFailure: retention.unresolvedFailure,
      consecutiveFailureCount: retention.consecutiveFailureCount,
    },
  };
}

function providerEventCode(
  current: QuickBooksOperationalHealth,
  previous: QuickBooksOperationalHealth | null,
): QuickBooksProviderOperationalEventCode {
  if (current === "HEALTHY" && previous && previous !== "HEALTHY") {
    return "QUICKBOOKS_PROVIDER_HEALTH_RECOVERED";
  }
  if (current === "CRITICAL") return "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL";
  if (current === "WARNING") return "QUICKBOOKS_PROVIDER_HEALTH_WARNING";
  return "QUICKBOOKS_PROVIDER_HEALTH_SUMMARY";
}

function providerSignal(
  providerWindow: QuickBooksProviderWindow,
  current: QuickBooksOperationalHealth,
  previous: QuickBooksOperationalHealth | null,
): QuickBooksProviderOperationalSignal {
  const eventCode = providerEventCode(current, previous);
  return {
    eventCode,
    outcome: eventCode === "QUICKBOOKS_PROVIDER_HEALTH_RECOVERED" ? "RECOVERED" : current,
    providerWorkflowCount: providerWindow.callCount,
    providerFailureCount: providerWindow.failureCount,
    providerThrottleCount: providerWindow.throttleCount,
    providerTimeoutCount: providerWindow.timeoutCount,
    providerSlowCount: providerWindow.slowCount,
    providerDegradedCallCount: providerWindow.degradedCallCount,
    providerMaxDurationMs: providerWindow.maximumDurationMs,
  };
}

function retentionTransitionSignal(
  current: QuickBooksOperationalHealth,
): QuickBooksRetentionOperationalSignal | null {
  if (current === "HEALTHY") {
    return { eventCode: "QUICKBOOKS_RETENTION_HEALTH_RECOVERED", outcome: "RECOVERED" };
  }
  if (current === "CRITICAL") {
    return { eventCode: "QUICKBOOKS_RETENTION_HEALTH_CRITICAL", outcome: "CRITICAL" };
  }
  return { eventCode: "QUICKBOOKS_RETENTION_HEALTH_WARNING", outcome: "WARNING" };
}

function retentionReminderSignal(
  current: QuickBooksOperationalHealth,
): QuickBooksRetentionOperationalSignal | null {
  if (current === "CRITICAL") {
    return { eventCode: "QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER", outcome: "CRITICAL" };
  }
  if (current === "WARNING") {
    return { eventCode: "QUICKBOOKS_RETENTION_HEALTH_WARNING_REMINDER", outcome: "WARNING" };
  }
  return null;
}

export function createQuickBooksWorkerOperationalTracker(params: Readonly<{
  environment: QuickBooksWorkerEnvironment;
  startupAtUtc: Date;
}>): QuickBooksWorkerOperationalTracker {
  const startupAtUtc = new Date(params.startupAtUtc.getTime());
  if (!Number.isFinite(startupAtUtc.getTime())) throw new Error("QuickBooks worker startup time is invalid.");
  const providerObservations: ProviderObservation[] = [];
  let lastRetentionSucceededAtUtc: string | null = null;
  let unresolvedRetentionFailure = false;
  let consecutiveRetentionFailureCount = 0;
  let lastProviderEmissionAtMs: number | null = null;
  let lastProviderEmittedHealth: QuickBooksOperationalHealth | null = null;
  let lastRetentionEmissionAtMs: number | null = null;
  let lastRetentionEmittedHealth: QuickBooksOperationalHealth | null = null;

  const providerWindow = (now: Date): QuickBooksProviderWindow => {
    const nowMs = now.getTime();
    const cutoffMs = nowMs - QUICKBOOKS_PROVIDER_WINDOW_MS;
    let callCount = 0;
    let failureCount = 0;
    let throttleCount = 0;
    let timeoutCount = 0;
    let slowCount = 0;
    let degradedCallCount = 0;
    let maximumDurationMs = 0;
    for (const observation of providerObservations) {
      if (observation.occurredAtMs <= cutoffMs || observation.occurredAtMs > nowMs) continue;
      callCount += 1;
      if (observation.failed) failureCount += 1;
      if (observation.throttled) throttleCount += 1;
      if (observation.timedOut) timeoutCount += 1;
      if (observation.slow) slowCount += 1;
      if (observation.failed || observation.slow) degradedCallCount += 1;
      maximumDurationMs = Math.max(maximumDurationMs, observation.durationMs);
    }
    return {
      windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
      callCount,
      failureCount,
      throttleCount,
      timeoutCount,
      slowCount,
      degradedCallCount,
      maximumDurationMs,
    };
  };

  const retentionHeartbeat = (): QuickBooksRetentionHeartbeat => ({
    startupAtUtc: startupAtUtc.toISOString(),
    lastSucceededAtUtc: lastRetentionSucceededAtUtc,
    unresolvedFailure: unresolvedRetentionFailure,
    consecutiveFailureCount: consecutiveRetentionFailureCount,
  });

  const heartbeat = (now = new Date()): QuickBooksWorkerOperationalHeartbeat => ({
    schema: QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
    environment: params.environment,
    providerWindow: providerWindow(now),
    retention: retentionHeartbeat(),
  });

  const recordProviderAttempt: QuickBooksWorkerOperationalTracker["recordProviderAttempt"] = ({
    outcome,
    durationMs,
    occurredAtUtc = new Date(),
  }) => {
    const occurredAtMs = occurredAtUtc.getTime();
    if (!Number.isFinite(occurredAtMs)) return;
    const boundedDurationMs = boundedNonnegativeInteger(durationMs);
    providerObservations.push({
      occurredAtMs,
      durationMs: boundedDurationMs,
      failed: outcome !== "success",
      throttled: outcome === "throttle",
      timedOut: outcome === "timeout",
      slow: boundedDurationMs >= QUICKBOOKS_PROVIDER_SLOW_MS,
    });
    if (providerObservations.length > QUICKBOOKS_PROVIDER_MAX_OBSERVATIONS) {
      providerObservations.splice(0, providerObservations.length - QUICKBOOKS_PROVIDER_MAX_OBSERVATIONS);
    }
  };

  const recordRetentionRun: QuickBooksWorkerOperationalTracker["recordRetentionRun"] = ({
    unresolvedFailureCount,
    occurredAtUtc = new Date(),
  }) => {
    const occurredAtMs = occurredAtUtc.getTime();
    if (!Number.isFinite(occurredAtMs)) return;
    const failureCount = boundedNonnegativeInteger(unresolvedFailureCount);
    if (failureCount === 0) {
      lastRetentionSucceededAtUtc = new Date(occurredAtMs).toISOString();
      unresolvedRetentionFailure = false;
      consecutiveRetentionFailureCount = 0;
      return;
    }
    unresolvedRetentionFailure = true;
    consecutiveRetentionFailureCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      consecutiveRetentionFailureCount + 1,
    );
  };

  const drainExternalSignals: QuickBooksWorkerOperationalTracker["drainExternalSignals"] = (
    now = new Date(),
  ) => {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return [];
    const signals: QuickBooksWorkerOperationalSignal[] = [];
    const currentHeartbeat = heartbeat(now);
    const providerHealth = evaluateQuickBooksProviderWindow(currentHeartbeat.providerWindow);
    if (
      lastProviderEmissionAtMs === null
      || nowMs - lastProviderEmissionAtMs >= QUICKBOOKS_PROVIDER_SIGNAL_INTERVAL_MS
    ) {
      signals.push(providerSignal(
        currentHeartbeat.providerWindow,
        providerHealth,
        lastProviderEmittedHealth,
      ));
      lastProviderEmissionAtMs = nowMs;
      lastProviderEmittedHealth = providerHealth;
    }

    const retentionHealth = evaluateQuickBooksRetentionHeartbeat(currentHeartbeat.retention, now);
    if (lastRetentionEmittedHealth === null) {
      lastRetentionEmittedHealth = retentionHealth;
      if (retentionHealth !== "HEALTHY") {
        signals.push(retentionTransitionSignal(retentionHealth)!);
        lastRetentionEmissionAtMs = nowMs;
      }
    } else if (retentionHealth !== lastRetentionEmittedHealth) {
      if (
        lastRetentionEmissionAtMs === null
        || nowMs - lastRetentionEmissionAtMs >= QUICKBOOKS_RETENTION_TRANSITION_INTERVAL_MS
      ) {
        signals.push(retentionTransitionSignal(retentionHealth)!);
        lastRetentionEmissionAtMs = nowMs;
        lastRetentionEmittedHealth = retentionHealth;
      }
    } else if (
      retentionHealth !== "HEALTHY"
      && lastRetentionEmissionAtMs !== null
      && nowMs - lastRetentionEmissionAtMs >= QUICKBOOKS_RETENTION_REMINDER_INTERVAL_MS
    ) {
      signals.push(retentionReminderSignal(retentionHealth)!);
      lastRetentionEmissionAtMs = nowMs;
    }
    return signals;
  };

  return { recordProviderAttempt, recordRetentionRun, heartbeat, drainExternalSignals };
}
