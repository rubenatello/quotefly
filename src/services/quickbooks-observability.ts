import {
  evaluateQuickBooksProviderWindow,
  QUICKBOOKS_PROVIDER_SLOW_MS,
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  type QuickBooksOperationalHealth,
  QuickBooksProviderOperationalEventCode,
  QuickBooksProviderOperationalSignal,
  QuickBooksRetentionOperationalEventCode,
  QuickBooksRetentionOperationalSignal,
  QuickBooksWorkerOperationalSignal,
} from "./quickbooks-worker-operational";

export type QuickBooksSignalLevel = "info" | "warn" | "error";

export type QuickBooksSignalWriter = (
  level: QuickBooksSignalLevel,
  signal: QuickBooksOAuthCallbackSignal | QuickBooksTokenRefreshSignal | QuickBooksWorkerOperationalSignal,
) => void;

type StructuredLogger = Readonly<{
  info: (fields: object, message?: string) => unknown;
  warn: (fields: object, message?: string) => unknown;
  error: (fields: object, message?: string) => unknown;
}>;

export type QuickBooksOAuthCallbackStage =
  | "QUERY_VALIDATION"
  | "STATE_VALIDATION"
  | "STATE_LOOKUP"
  | "SESSION_VALIDATION"
  | "STATE_CONSUMPTION"
  | "CALLBACK_VALIDATION"
  | "RUNTIME_VALIDATION"
  | "AUTHORIZATION_REVALIDATION"
  | "REALM_OWNERSHIP_CHECK"
  | "TENANT_CONNECTION_LOOKUP"
  | "TOKEN_EXCHANGE"
  | "COMPANY_LOOKUP"
  | "AUTHORIZATION_RECHECK"
  | "CREDENTIAL_PERSISTENCE"
  | "ORPHAN_CLEANUP"
  | "COMPLETED";

export type QuickBooksOAuthCallbackOutcome =
  | "SUCCEEDED"
  | "DENIED"
  | "REJECTED"
  | "FAILED";

const QUICKBOOKS_OAUTH_PROVIDER_EVENT_CODES = [
  "QUICKBOOKS_TOKEN_EXCHANGE_INVALID_CLIENT",
  "QUICKBOOKS_TOKEN_EXCHANGE_INVALID_GRANT",
  "QUICKBOOKS_TOKEN_EXCHANGE_RESPONSE_INVALID",
  "QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID",
  "QUICKBOOKS_COMPANY_INFO_REALM_MISMATCH",
  "QUICKBOOKS_COMPANY_REALM_MISMATCH",
  "QUICKBOOKS_MUTATION_RESULT_UNKNOWN",
  "QUICKBOOKS_READ_TIMEOUT",
] as const;

type QuickBooksOAuthProviderEventCode = typeof QUICKBOOKS_OAUTH_PROVIDER_EVENT_CODES[number];

export type QuickBooksOAuthCallbackEventCode =
  | "QUICKBOOKS_OAUTH_CALLBACK_COMPLETED"
  | "QUICKBOOKS_OAUTH_CALLBACK_DENIED"
  | "QUICKBOOKS_OAUTH_CALLBACK_MALFORMED"
  | "QUICKBOOKS_OAUTH_CALLBACK_INCOMPLETE"
  | "QUICKBOOKS_OAUTH_STATE_INVALID"
  | "QUICKBOOKS_OAUTH_STATE_REPLAYED"
  | "QUICKBOOKS_OAUTH_SESSION_INVALID"
  | "QUICKBOOKS_OAUTH_BILLING_REQUIRED"
  | "QUICKBOOKS_OAUTH_WORKFLOWS_DISABLED"
  | "QUICKBOOKS_OAUTH_NOT_CONFIGURED"
  | "QUICKBOOKS_OAUTH_AUTHORIZATION_REVOKED"
  | "QUICKBOOKS_OAUTH_REALM_IN_USE"
  | "QUICKBOOKS_OAUTH_REALM_CHANGE_BLOCKED"
  | "QUICKBOOKS_OAUTH_CREDENTIAL_LIFECYCLE_BUSY"
  | "QUICKBOOKS_OAUTH_ORPHAN_CLEANUP_FAILED"
  | "QUICKBOOKS_OAUTH_DATABASE_WRITE_FAILED"
  | "QUICKBOOKS_OAUTH_DATABASE_UNAVAILABLE"
  | "QUICKBOOKS_OAUTH_PROVIDER_FAILURE"
  | "QUICKBOOKS_OAUTH_CALLBACK_UNKNOWN"
  | "QUICKBOOKS_TOKEN_EXCHANGE_HTTP_FAILURE"
  | "QUICKBOOKS_COMPANY_INFO_HTTP_FAILURE"
  | QuickBooksOAuthProviderEventCode;

export type QuickBooksOAuthCallbackSignal = Readonly<{
  eventCode: QuickBooksOAuthCallbackEventCode;
  callbackStage: QuickBooksOAuthCallbackStage;
  outcome: QuickBooksOAuthCallbackOutcome;
}>;

const QUICKBOOKS_OAUTH_CALLBACK_LEVEL: Readonly<Record<QuickBooksOAuthCallbackEventCode, QuickBooksSignalLevel>> = {
  QUICKBOOKS_OAUTH_CALLBACK_COMPLETED: "info",
  QUICKBOOKS_OAUTH_CALLBACK_DENIED: "info",
  QUICKBOOKS_OAUTH_CALLBACK_MALFORMED: "warn",
  QUICKBOOKS_OAUTH_CALLBACK_INCOMPLETE: "warn",
  QUICKBOOKS_OAUTH_STATE_INVALID: "warn",
  QUICKBOOKS_OAUTH_STATE_REPLAYED: "warn",
  QUICKBOOKS_OAUTH_SESSION_INVALID: "warn",
  QUICKBOOKS_OAUTH_BILLING_REQUIRED: "warn",
  QUICKBOOKS_OAUTH_WORKFLOWS_DISABLED: "error",
  QUICKBOOKS_OAUTH_NOT_CONFIGURED: "error",
  QUICKBOOKS_OAUTH_AUTHORIZATION_REVOKED: "warn",
  QUICKBOOKS_OAUTH_REALM_IN_USE: "warn",
  QUICKBOOKS_OAUTH_REALM_CHANGE_BLOCKED: "warn",
  QUICKBOOKS_OAUTH_CREDENTIAL_LIFECYCLE_BUSY: "warn",
  QUICKBOOKS_OAUTH_ORPHAN_CLEANUP_FAILED: "error",
  QUICKBOOKS_OAUTH_DATABASE_WRITE_FAILED: "error",
  QUICKBOOKS_OAUTH_DATABASE_UNAVAILABLE: "error",
  QUICKBOOKS_OAUTH_PROVIDER_FAILURE: "error",
  QUICKBOOKS_OAUTH_CALLBACK_UNKNOWN: "error",
  QUICKBOOKS_TOKEN_EXCHANGE_HTTP_FAILURE: "error",
  QUICKBOOKS_COMPANY_INFO_HTTP_FAILURE: "error",
  QUICKBOOKS_TOKEN_EXCHANGE_INVALID_CLIENT: "error",
  QUICKBOOKS_TOKEN_EXCHANGE_INVALID_GRANT: "error",
  QUICKBOOKS_TOKEN_EXCHANGE_RESPONSE_INVALID: "error",
  QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID: "error",
  QUICKBOOKS_COMPANY_INFO_REALM_MISMATCH: "error",
  QUICKBOOKS_COMPANY_REALM_MISMATCH: "error",
  QUICKBOOKS_MUTATION_RESULT_UNKNOWN: "error",
  QUICKBOOKS_READ_TIMEOUT: "error",
};

const QUICKBOOKS_OAUTH_PROVIDER_EVENT_CODE_SET = new Set<string>(QUICKBOOKS_OAUTH_PROVIDER_EVENT_CODES);

export function safeQuickBooksOAuthProviderEventCode(value: unknown): QuickBooksOAuthCallbackEventCode {
  if (typeof value !== "string") return "QUICKBOOKS_OAUTH_PROVIDER_FAILURE";
  if (QUICKBOOKS_OAUTH_PROVIDER_EVENT_CODE_SET.has(value)) return value as QuickBooksOAuthProviderEventCode;
  if (/^QUICKBOOKS_TOKEN_EXCHANGE_HTTP_[1-5][0-9]{2}$/.test(value)) {
    return "QUICKBOOKS_TOKEN_EXCHANGE_HTTP_FAILURE";
  }
  if (/^QUICKBOOKS_COMPANY_INFO_HTTP_[1-5][0-9]{2}$/.test(value)) {
    return "QUICKBOOKS_COMPANY_INFO_HTTP_FAILURE";
  }
  return "QUICKBOOKS_OAUTH_PROVIDER_FAILURE";
}

export function emitQuickBooksOAuthCallbackSignal(
  writer: QuickBooksSignalWriter,
  signal: QuickBooksOAuthCallbackSignal,
): void {
  const contentFreeSignal: QuickBooksOAuthCallbackSignal = {
    eventCode: signal.eventCode,
    callbackStage: signal.callbackStage,
    outcome: signal.outcome,
  };
  writer(QUICKBOOKS_OAUTH_CALLBACK_LEVEL[contentFreeSignal.eventCode], contentFreeSignal);
}

export type QuickBooksTokenRefreshEventCode =
  | "QUICKBOOKS_TOKEN_REFRESH_REAUTH_REQUIRED"
  | "QUICKBOOKS_TOKEN_REFRESH_TRANSIENT_FAILURE"
  | "QUICKBOOKS_TOKEN_REFRESH_PERSISTENCE_FAILED";

export type QuickBooksTokenRefreshSignal = Readonly<{
  eventCode: QuickBooksTokenRefreshEventCode;
  refreshStage: "TOKEN_REFRESH" | "FAILURE_PERSISTENCE";
  outcome: "REAUTH_REQUIRED" | "FAILED";
}>;

const QUICKBOOKS_TOKEN_REFRESH_LEVEL: Readonly<Record<QuickBooksTokenRefreshEventCode, QuickBooksSignalLevel>> = {
  QUICKBOOKS_TOKEN_REFRESH_REAUTH_REQUIRED: "error",
  QUICKBOOKS_TOKEN_REFRESH_TRANSIENT_FAILURE: "warn",
  QUICKBOOKS_TOKEN_REFRESH_PERSISTENCE_FAILED: "error",
};

const QUICKBOOKS_PROVIDER_OPERATIONAL_LEVEL: Readonly<
  Record<QuickBooksProviderOperationalEventCode, QuickBooksSignalLevel>
> = {
  QUICKBOOKS_PROVIDER_HEALTH_SUMMARY: "info",
  QUICKBOOKS_PROVIDER_HEALTH_WARNING: "warn",
  QUICKBOOKS_PROVIDER_HEALTH_CRITICAL: "error",
  QUICKBOOKS_PROVIDER_HEALTH_RECOVERED: "info",
};

const QUICKBOOKS_RETENTION_OPERATIONAL_LEVEL: Readonly<
  Record<QuickBooksRetentionOperationalEventCode, QuickBooksSignalLevel>
> = {
  QUICKBOOKS_RETENTION_HEALTH_WARNING: "warn",
  QUICKBOOKS_RETENTION_HEALTH_CRITICAL: "error",
  QUICKBOOKS_RETENTION_HEALTH_RECOVERED: "info",
  QUICKBOOKS_RETENTION_HEALTH_WARNING_REMINDER: "warn",
  QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER: "error",
};

export function emitQuickBooksTokenRefreshSignal(
  writer: QuickBooksSignalWriter = writeQuickBooksSignalToProcess,
  signal: QuickBooksTokenRefreshSignal,
): void {
  const contentFreeSignal: QuickBooksTokenRefreshSignal = {
    eventCode: signal.eventCode,
    refreshStage: signal.refreshStage,
    outcome: signal.outcome,
  };
  writer(QUICKBOOKS_TOKEN_REFRESH_LEVEL[contentFreeSignal.eventCode], contentFreeSignal);
}

export type QuickBooksSignalSinkRuntimeRole = "api" | "worker";

export type QuickBooksExternalSignalSinkConfig = Readonly<{
  ingestUrl: string;
  sourceToken: string;
  runtimeRole: QuickBooksSignalSinkRuntimeRole;
  timeoutMs: number;
}>;

type QuickBooksTerminalExternalSignalPayload = Readonly<{
  schema: "quotefly.quickbooks.signal/v1";
  message: "QuickBooks integration terminal signal.";
  runtimeRole: QuickBooksSignalSinkRuntimeRole;
  level: QuickBooksSignalLevel;
  eventCode: QuickBooksOAuthCallbackEventCode | QuickBooksTokenRefreshEventCode;
  outcome: QuickBooksOAuthCallbackOutcome | QuickBooksTokenRefreshSignal["outcome"];
  callbackStage?: QuickBooksOAuthCallbackStage;
  refreshStage?: QuickBooksTokenRefreshSignal["refreshStage"];
}>;

type QuickBooksProviderExternalSignalPayload = Readonly<{
  schema: "quotefly.quickbooks.worker-operational-signal/v1";
  message: "QuickBooks provider health signal.";
  runtimeRole: QuickBooksSignalSinkRuntimeRole;
  level: QuickBooksSignalLevel;
  eventCode: QuickBooksProviderOperationalEventCode;
  outcome: QuickBooksProviderOperationalSignal["outcome"];
  providerWorkflowCount: number;
  providerFailureCount: number;
  providerThrottleCount: number;
  providerTimeoutCount: number;
  providerSlowCount: number;
  providerDegradedCallCount: number;
  providerMaxDurationMs: number;
}>;

type QuickBooksRetentionExternalSignalPayload = Readonly<{
  schema: "quotefly.quickbooks.worker-operational-signal/v1";
  message: "QuickBooks retention health signal.";
  runtimeRole: QuickBooksSignalSinkRuntimeRole;
  level: QuickBooksSignalLevel;
  eventCode: QuickBooksRetentionOperationalEventCode;
  outcome: QuickBooksRetentionOperationalSignal["outcome"];
}>;

type QuickBooksExternalSignalPayload =
  | QuickBooksTerminalExternalSignalPayload
  | QuickBooksProviderExternalSignalPayload
  | QuickBooksRetentionExternalSignalPayload;

type QuickBooksSignalSinkFailureCode =
  | "QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED"
  | "QUICKBOOKS_SIGNAL_SINK_QUEUE_FULL"
  | "QUICKBOOKS_SIGNAL_SINK_SIGNAL_REJECTED";

type QuickBooksSignalSinkFailure = Readonly<{
  eventCode: QuickBooksSignalSinkFailureCode;
  runtimeRole: QuickBooksSignalSinkRuntimeRole;
  outcome: "FAILED";
}>;

type QuickBooksSignalSinkFailureWriter = (failure: QuickBooksSignalSinkFailure) => void;
type QuickBooksFetch = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<globalThis.Response>;

const QUICKBOOKS_SIGNAL_SCHEMA = "quotefly.quickbooks.signal/v1" as const;
const QUICKBOOKS_SIGNAL_MESSAGE = "QuickBooks integration terminal signal." as const;
const QUICKBOOKS_WORKER_OPERATIONAL_SIGNAL_SCHEMA = "quotefly.quickbooks.worker-operational-signal/v1" as const;
const QUICKBOOKS_PROVIDER_SIGNAL_MESSAGE = "QuickBooks provider health signal." as const;
const QUICKBOOKS_RETENTION_SIGNAL_MESSAGE = "QuickBooks retention health signal." as const;
const QUICKBOOKS_SIGNAL_MAX_PENDING = 32;
const QUICKBOOKS_SIGNAL_DEFAULT_TIMEOUT_MS = 1_250;
const QUICKBOOKS_SIGNAL_FLUSH_TIMEOUT_MS = 3_000;
const QUICKBOOKS_SIGNAL_LEVELS = new Set<QuickBooksSignalLevel>(["info", "warn", "error"]);
const QUICKBOOKS_OAUTH_CALLBACK_STAGES = new Set<QuickBooksOAuthCallbackStage>([
  "QUERY_VALIDATION",
  "STATE_VALIDATION",
  "STATE_LOOKUP",
  "SESSION_VALIDATION",
  "STATE_CONSUMPTION",
  "CALLBACK_VALIDATION",
  "RUNTIME_VALIDATION",
  "AUTHORIZATION_REVALIDATION",
  "REALM_OWNERSHIP_CHECK",
  "TENANT_CONNECTION_LOOKUP",
  "TOKEN_EXCHANGE",
  "COMPANY_LOOKUP",
  "AUTHORIZATION_RECHECK",
  "CREDENTIAL_PERSISTENCE",
  "ORPHAN_CLEANUP",
  "COMPLETED",
]);
const QUICKBOOKS_OAUTH_CALLBACK_OUTCOMES = new Set<QuickBooksOAuthCallbackOutcome>([
  "SUCCEEDED",
  "DENIED",
  "REJECTED",
  "FAILED",
]);
const QUICKBOOKS_TOKEN_REFRESH_STAGES = new Set<QuickBooksTokenRefreshSignal["refreshStage"]>([
  "TOKEN_REFRESH",
  "FAILURE_PERSISTENCE",
]);
const QUICKBOOKS_TOKEN_REFRESH_OUTCOMES = new Set<QuickBooksTokenRefreshSignal["outcome"]>([
  "REAUTH_REQUIRED",
  "FAILED",
]);

function isOwnString(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && typeof record[key] === "string";
}

function isOwnNonnegativeSafeInteger(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
    && Number.isSafeInteger(record[key])
    && (record[key] as number) >= 0;
}

function buildQuickBooksExternalSignalPayload(
  runtimeRole: QuickBooksSignalSinkRuntimeRole,
  level: QuickBooksSignalLevel,
  signal: QuickBooksOAuthCallbackSignal | QuickBooksTokenRefreshSignal | QuickBooksWorkerOperationalSignal,
): QuickBooksExternalSignalPayload | null {
  if (!QUICKBOOKS_SIGNAL_LEVELS.has(level) || typeof signal !== "object" || signal === null) return null;
  const candidate = signal as unknown as Record<string, unknown>;
  if (!isOwnString(candidate, "eventCode") || !isOwnString(candidate, "outcome")) return null;

  if (isOwnString(candidate, "callbackStage")) {
    const eventCode = candidate.eventCode as QuickBooksOAuthCallbackEventCode;
    const callbackStage = candidate.callbackStage as QuickBooksOAuthCallbackStage;
    const outcome = candidate.outcome as QuickBooksOAuthCallbackOutcome;
    if (
      QUICKBOOKS_OAUTH_CALLBACK_LEVEL[eventCode] !== level
      || !QUICKBOOKS_OAUTH_CALLBACK_STAGES.has(callbackStage)
      || !QUICKBOOKS_OAUTH_CALLBACK_OUTCOMES.has(outcome)
    ) return null;
    return {
      schema: QUICKBOOKS_SIGNAL_SCHEMA,
      message: QUICKBOOKS_SIGNAL_MESSAGE,
      runtimeRole,
      level,
      eventCode,
      callbackStage,
      outcome,
    };
  }

  if (isOwnString(candidate, "refreshStage")) {
    const eventCode = candidate.eventCode as QuickBooksTokenRefreshEventCode;
    const refreshStage = candidate.refreshStage as QuickBooksTokenRefreshSignal["refreshStage"];
    const outcome = candidate.outcome as QuickBooksTokenRefreshSignal["outcome"];
    if (
      QUICKBOOKS_TOKEN_REFRESH_LEVEL[eventCode] !== level
      || !QUICKBOOKS_TOKEN_REFRESH_STAGES.has(refreshStage)
      || !QUICKBOOKS_TOKEN_REFRESH_OUTCOMES.has(outcome)
    ) return null;
    return {
      schema: QUICKBOOKS_SIGNAL_SCHEMA,
      message: QUICKBOOKS_SIGNAL_MESSAGE,
      runtimeRole,
      level,
      eventCode,
      refreshStage,
      outcome,
    };
  }

  const providerEventCode = candidate.eventCode as QuickBooksProviderOperationalEventCode;
  if (Object.prototype.hasOwnProperty.call(candidate, "providerWorkflowCount")) {
    const numericFields = [
      "providerWorkflowCount",
      "providerFailureCount",
      "providerThrottleCount",
      "providerTimeoutCount",
      "providerSlowCount",
      "providerDegradedCallCount",
      "providerMaxDurationMs",
    ] as const;
    if (
      runtimeRole !== "worker"
      || QUICKBOOKS_PROVIDER_OPERATIONAL_LEVEL[providerEventCode] !== level
      || numericFields.some((field) => !isOwnNonnegativeSafeInteger(candidate, field))
    ) return null;
    const outcome = candidate.outcome as QuickBooksProviderOperationalSignal["outcome"];
    const expectedOutcome = providerEventCode === "QUICKBOOKS_PROVIDER_HEALTH_RECOVERED"
      ? "RECOVERED"
      : providerEventCode === "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL"
        ? "CRITICAL"
        : providerEventCode === "QUICKBOOKS_PROVIDER_HEALTH_WARNING"
          ? "WARNING"
          : "HEALTHY";
    if (outcome !== expectedOutcome) return null;
    const providerWorkflowCount = candidate.providerWorkflowCount as number;
    const providerFailureCount = candidate.providerFailureCount as number;
    const providerThrottleCount = candidate.providerThrottleCount as number;
    const providerTimeoutCount = candidate.providerTimeoutCount as number;
    const providerSlowCount = candidate.providerSlowCount as number;
    const providerDegradedCallCount = candidate.providerDegradedCallCount as number;
    const providerMaxDurationMs = candidate.providerMaxDurationMs as number;
    if (
      providerFailureCount > providerWorkflowCount
      || providerThrottleCount + providerTimeoutCount > providerFailureCount
      || providerSlowCount > providerWorkflowCount
      || providerDegradedCallCount < Math.max(providerFailureCount, providerSlowCount)
      || providerDegradedCallCount > Math.min(
        providerWorkflowCount,
        providerFailureCount + providerSlowCount,
      )
      || (providerWorkflowCount === 0 && providerMaxDurationMs !== 0)
      || (providerSlowCount > 0 && providerMaxDurationMs < QUICKBOOKS_PROVIDER_SLOW_MS)
      || (providerSlowCount === 0 && providerMaxDurationMs >= QUICKBOOKS_PROVIDER_SLOW_MS)
    ) return null;
    const evaluatedHealth = evaluateQuickBooksProviderWindow({
      windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
      callCount: providerWorkflowCount,
      failureCount: providerFailureCount,
      throttleCount: providerThrottleCount,
      timeoutCount: providerTimeoutCount,
      slowCount: providerSlowCount,
      degradedCallCount: providerDegradedCallCount,
      maximumDurationMs: providerMaxDurationMs,
    });
    const expectedHealth: QuickBooksOperationalHealth =
      providerEventCode === "QUICKBOOKS_PROVIDER_HEALTH_WARNING"
        ? "WARNING"
        : providerEventCode === "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL"
          ? "CRITICAL"
          : "HEALTHY";
    if (evaluatedHealth !== expectedHealth) return null;
    return {
      schema: QUICKBOOKS_WORKER_OPERATIONAL_SIGNAL_SCHEMA,
      message: QUICKBOOKS_PROVIDER_SIGNAL_MESSAGE,
      runtimeRole,
      level,
      eventCode: providerEventCode,
      outcome,
      providerWorkflowCount,
      providerFailureCount,
      providerThrottleCount,
      providerTimeoutCount,
      providerSlowCount,
      providerDegradedCallCount,
      providerMaxDurationMs,
    };
  }

  const retentionEventCode = candidate.eventCode as QuickBooksRetentionOperationalEventCode;
  if (
    runtimeRole === "worker"
    && QUICKBOOKS_RETENTION_OPERATIONAL_LEVEL[retentionEventCode] === level
  ) {
    const outcome = candidate.outcome as QuickBooksRetentionOperationalSignal["outcome"];
    const expectedOutcome = retentionEventCode === "QUICKBOOKS_RETENTION_HEALTH_RECOVERED"
      ? "RECOVERED"
      : retentionEventCode === "QUICKBOOKS_RETENTION_HEALTH_WARNING"
          || retentionEventCode === "QUICKBOOKS_RETENTION_HEALTH_WARNING_REMINDER"
        ? "WARNING"
        : "CRITICAL";
    if (outcome !== expectedOutcome) return null;
    return {
      schema: QUICKBOOKS_WORKER_OPERATIONAL_SIGNAL_SCHEMA,
      message: QUICKBOOKS_RETENTION_SIGNAL_MESSAGE,
      runtimeRole,
      level,
      eventCode: retentionEventCode,
      outcome,
    };
  }

  return null;
}

export function resolveQuickBooksExternalSignalSinkConfig(
  runtimeRole: QuickBooksSignalSinkRuntimeRole,
  input: NodeJS.ProcessEnv = process.env,
): QuickBooksExternalSignalSinkConfig | null {
  const prefix = runtimeRole === "api" ? "QUICKBOOKS_API_SIGNAL" : "QUICKBOOKS_WORKER_SIGNAL";
  const ingestUrl = input[`${prefix}_INGEST_URL`]?.trim() ?? "";
  const sourceToken = input[`${prefix}_SOURCE_TOKEN`]?.trim() ?? "";
  if (!ingestUrl || sourceToken.length < 16 || /\s/.test(sourceToken)) return null;
  const peerSourceToken = input[
    runtimeRole === "api"
      ? "QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN"
      : "QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN"
  ]?.trim() ?? "";
  if (
    [
      input.JWT_SECRET,
      input.QUICKBOOKS_CLIENT_SECRET,
      input.QUICKBOOKS_WEBHOOK_VERIFIER,
      input.QUICKBOOKS_MONITOR_BEARER,
      input.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
      input.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS,
      peerSourceToken,
    ].some((secret) => secret?.trim() && secret.trim() === sourceToken)
  ) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(ingestUrl);
  } catch {
    return null;
  }
  if (
    parsedUrl.protocol !== "https:"
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) return null;

  const parsedTimeoutMs = Number(input.QUICKBOOKS_SIGNAL_INGEST_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(parsedTimeoutMs) && parsedTimeoutMs >= 250 && parsedTimeoutMs <= 3_000
    ? parsedTimeoutMs
    : QUICKBOOKS_SIGNAL_DEFAULT_TIMEOUT_MS;
  return {
    ingestUrl: parsedUrl.toString(),
    sourceToken,
    runtimeRole,
    timeoutMs,
  };
}

export type QuickBooksExternalSignalSink = Readonly<{
  enqueue: (
    level: QuickBooksSignalLevel,
    signal: QuickBooksOAuthCallbackSignal | QuickBooksTokenRefreshSignal | QuickBooksWorkerOperationalSignal,
  ) => void;
  flush: (timeoutMs?: number) => Promise<void>;
}>;

async function discardQuickBooksExternalSignalResponse(response: Response): Promise<void> {
  // Undici leaves the connection unavailable for reuse until a response body
  // is consumed or cancelled. Signal delivery is intentionally content-free,
  // so cancellation is both sufficient and safer than reading a body that a
  // remote sink could make unexpectedly large.
  await response.body?.cancel();
}

export function createQuickBooksExternalSignalSink(
  config: QuickBooksExternalSignalSinkConfig,
  failureWriter: QuickBooksSignalSinkFailureWriter,
  options: Readonly<{
    fetch?: QuickBooksFetch;
    maxPending?: number;
  }> = {},
): QuickBooksExternalSignalSink {
  const fetchSignal = options.fetch ?? globalThis.fetch;
  const maxPending = Math.max(1, Math.min(options.maxPending ?? QUICKBOOKS_SIGNAL_MAX_PENDING, 128));
  const pending = new Set<Promise<void>>();

  const reportFailure = (eventCode: QuickBooksSignalSinkFailureCode) => {
    try {
      failureWriter({ eventCode, runtimeRole: config.runtimeRole, outcome: "FAILED" });
    } catch {
      // Observability is never allowed to alter OAuth or accounting outcomes.
    }
  };

  const enqueue: QuickBooksExternalSignalSink["enqueue"] = (level, signal) => {
    try {
      const payload = buildQuickBooksExternalSignalPayload(config.runtimeRole, level, signal);
      if (!payload) {
        reportFailure("QUICKBOOKS_SIGNAL_SINK_SIGNAL_REJECTED");
        return;
      }
      if (pending.size >= maxPending) {
        reportFailure("QUICKBOOKS_SIGNAL_SINK_QUEUE_FULL");
        return;
      }

      let delivery!: Promise<void>;
      delivery = (async () => {
        const response = await fetchSignal(config.ingestUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.sourceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: "error",
        });
        await discardQuickBooksExternalSignalResponse(response);
        if (!response.ok) throw new Error("QUICKBOOKS_SIGNAL_SINK_HTTP_FAILURE");
      })()
        .catch(() => reportFailure("QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED"))
        .finally(() => pending.delete(delivery));
      pending.add(delivery);
    } catch {
      reportFailure("QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED");
    }
  };

  const flush: QuickBooksExternalSignalSink["flush"] = async (
    timeoutMs = QUICKBOOKS_SIGNAL_FLUSH_TIMEOUT_MS,
  ) => {
    const deliveries = [...pending];
    if (deliveries.length === 0) return;
    const boundedTimeoutMs = Math.max(0, Math.min(timeoutMs, QUICKBOOKS_SIGNAL_FLUSH_TIMEOUT_MS));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(deliveries),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundedTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  return { enqueue, flush };
}

const registeredExternalSignalSinks = new Set<QuickBooksExternalSignalSink>();
let defaultApiSignalSink: QuickBooksExternalSignalSink | null | undefined;
let defaultWorkerSignalSink: QuickBooksExternalSignalSink | null | undefined;

function createLoggerSinkFailureWriter(
  logger: StructuredLogger,
): QuickBooksSignalSinkFailureWriter {
  return (failure) => {
    logger.warn(failure, "QuickBooks signal sink failure.");
  };
}

const writeQuickBooksSinkFailureToProcess: QuickBooksSignalSinkFailureWriter = (failure) => {
  process.stderr.write(`${JSON.stringify(failure)}\n`);
};

function getDefaultExternalSignalSink(
  runtimeRole: QuickBooksSignalSinkRuntimeRole,
  failureWriter: QuickBooksSignalSinkFailureWriter,
): QuickBooksExternalSignalSink | null {
  const existing = runtimeRole === "api" ? defaultApiSignalSink : defaultWorkerSignalSink;
  if (existing !== undefined) return existing;
  const config = resolveQuickBooksExternalSignalSinkConfig(runtimeRole);
  const created = config ? createQuickBooksExternalSignalSink(config, failureWriter) : null;
  if (created) registeredExternalSignalSinks.add(created);
  if (runtimeRole === "api") defaultApiSignalSink = created;
  else defaultWorkerSignalSink = created;
  return created;
}

export async function flushQuickBooksExternalSignals(): Promise<void> {
  await Promise.allSettled(
    [...registeredExternalSignalSinks].map((sink) => sink.flush()),
  );
}

export function createQuickBooksSignalWriter(logger: StructuredLogger): QuickBooksSignalWriter {
  const externalSink = getDefaultExternalSignalSink("api", createLoggerSinkFailureWriter(logger));
  return (level, signal) => {
    try {
      logger[level](signal, QUICKBOOKS_SIGNAL_MESSAGE);
    } catch {
      // Logging and delivery are both best effort and independent.
    }
    try {
      externalSink?.enqueue(level, signal);
    } catch {
      // Observability is never allowed to alter provider or accounting outcomes.
    }
  };
}

export const writeQuickBooksSignalToProcess: QuickBooksSignalWriter = (level, signal) => {
  const stream = level === "error" ? process.stderr : process.stdout;
  try {
    stream.write(`${JSON.stringify(signal)}\n`);
  } catch {
    // A local logging failure must not suppress the independent external sink.
  }
  try {
    getDefaultExternalSignalSink("worker", writeQuickBooksSinkFailureToProcess)?.enqueue(level, signal);
  } catch {
    // Observability is never allowed to alter provider or accounting outcomes.
  }
};

export function emitQuickBooksWorkerOperationalSignal(
  signal: QuickBooksWorkerOperationalSignal,
  writer: QuickBooksSignalWriter = writeQuickBooksSignalToProcess,
): void {
  const candidate = signal as unknown as Record<string, unknown>;
  const providerEventCode = candidate.eventCode as QuickBooksProviderOperationalEventCode;
  const retentionEventCode = candidate.eventCode as QuickBooksRetentionOperationalEventCode;
  const level = QUICKBOOKS_PROVIDER_OPERATIONAL_LEVEL[providerEventCode]
    ?? QUICKBOOKS_RETENTION_OPERATIONAL_LEVEL[retentionEventCode];
  if (!level) return;
  const payload = buildQuickBooksExternalSignalPayload("worker", level, signal);
  if (!payload || payload.schema !== QUICKBOOKS_WORKER_OPERATIONAL_SIGNAL_SCHEMA) return;
  const contentFreeSignal: QuickBooksWorkerOperationalSignal =
    payload.message === QUICKBOOKS_PROVIDER_SIGNAL_MESSAGE
      ? {
          eventCode: payload.eventCode,
          outcome: payload.outcome,
          providerWorkflowCount: payload.providerWorkflowCount,
          providerFailureCount: payload.providerFailureCount,
          providerThrottleCount: payload.providerThrottleCount,
          providerTimeoutCount: payload.providerTimeoutCount,
          providerSlowCount: payload.providerSlowCount,
          providerDegradedCallCount: payload.providerDegradedCallCount,
          providerMaxDurationMs: payload.providerMaxDurationMs,
        }
      : {
          eventCode: payload.eventCode,
          outcome: payload.outcome,
        };
  try {
    writer(level, contentFreeSignal);
  } catch {
    // A caller-supplied writer remains strictly best effort.
  }
}
