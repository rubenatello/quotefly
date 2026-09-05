import assert from "node:assert/strict";
import test from "node:test";
import {
  createQuickBooksExternalSignalSink,
  emitQuickBooksOAuthCallbackSignal,
  emitQuickBooksTokenRefreshSignal,
  emitQuickBooksWorkerOperationalSignal,
  resolveQuickBooksExternalSignalSinkConfig,
  safeQuickBooksOAuthProviderEventCode,
  type QuickBooksSignalLevel,
  type QuickBooksSignalWriter,
} from "../../src/services/quickbooks-observability";

const successfulResponse = { ok: true } as Response;

function testSinkConfig(runtimeRole: "api" | "worker" = "api") {
  return {
    ingestUrl: `https://${runtimeRole}-signals.example.test/`,
    sourceToken: `${runtimeRole}-source-token-test-only`,
    runtimeRole,
    timeoutMs: 250,
  } as const;
}

test("QuickBooks OAuth signals use a closed severity map and discard extra fields", () => {
  const writes: Array<{ level: QuickBooksSignalLevel; signal: unknown }> = [];
  const writer: QuickBooksSignalWriter = (level, signal) => writes.push({ level, signal });

  emitQuickBooksOAuthCallbackSignal(writer, {
    eventCode: "QUICKBOOKS_OAUTH_CALLBACK_COMPLETED",
    callbackStage: "COMPLETED",
    outcome: "SUCCEEDED",
    state: "state-secret-must-not-log",
    code: "authorization-code-must-not-log",
    realmId: "realm-must-not-log",
    token: "token-must-not-log",
    error_description: "provider-description-must-not-log",
  } as Parameters<typeof emitQuickBooksOAuthCallbackSignal>[1] & Record<string, string>);

  assert.deepEqual(writes, [{
    level: "info",
    signal: {
      eventCode: "QUICKBOOKS_OAUTH_CALLBACK_COMPLETED",
      callbackStage: "COMPLETED",
      outcome: "SUCCEEDED",
    },
  }]);
  assert.deepEqual(Object.keys(writes[0]?.signal as object).sort(), [
    "callbackStage",
    "eventCode",
    "outcome",
  ]);
  assert.doesNotMatch(JSON.stringify(writes), /must-not-log/);
});

test("QuickBooks provider callback codes normalize to a closed diagnostic vocabulary", () => {
  assert.equal(
    safeQuickBooksOAuthProviderEventCode("QUICKBOOKS_TOKEN_EXCHANGE_HTTP_429"),
    "QUICKBOOKS_TOKEN_EXCHANGE_HTTP_FAILURE",
  );
  assert.equal(
    safeQuickBooksOAuthProviderEventCode("QUICKBOOKS_COMPANY_INFO_HTTP_503"),
    "QUICKBOOKS_COMPANY_INFO_HTTP_FAILURE",
  );
  assert.equal(
    safeQuickBooksOAuthProviderEventCode("QUICKBOOKS_TOKEN_EXCHANGE_HTTP_429_secret-token"),
    "QUICKBOOKS_OAUTH_PROVIDER_FAILURE",
  );
  assert.equal(
    safeQuickBooksOAuthProviderEventCode({ code: "QUICKBOOKS_TOKEN_EXCHANGE_INVALID_CLIENT" }),
    "QUICKBOOKS_OAUTH_PROVIDER_FAILURE",
  );
});

test("QuickBooks refresh failure signals contain no provider or tenant context", () => {
  const writes: Array<{ level: QuickBooksSignalLevel; signal: unknown }> = [];
  const writer: QuickBooksSignalWriter = (level, signal) => writes.push({ level, signal });

  emitQuickBooksTokenRefreshSignal(writer, {
    eventCode: "QUICKBOOKS_TOKEN_REFRESH_PERSISTENCE_FAILED",
    refreshStage: "FAILURE_PERSISTENCE",
    outcome: "FAILED",
    tenantId: "tenant-secret-must-not-log",
    realmId: "realm-secret-must-not-log",
    providerError: "provider-secret-must-not-log",
  } as Parameters<typeof emitQuickBooksTokenRefreshSignal>[1] & Record<string, string>);

  assert.deepEqual(writes, [{
    level: "error",
    signal: {
      eventCode: "QUICKBOOKS_TOKEN_REFRESH_PERSISTENCE_FAILED",
      refreshStage: "FAILURE_PERSISTENCE",
      outcome: "FAILED",
    },
  }]);
  assert.deepEqual(Object.keys(writes[0]?.signal as object).sort(), [
    "eventCode",
    "outcome",
    "refreshStage",
  ]);
  assert.doesNotMatch(JSON.stringify(writes), /secret-must-not-log/);
});

test("worker operational emitter applies a closed severity map and strips unsafe fields", () => {
  const writes: Array<{ level: QuickBooksSignalLevel; signal: unknown }> = [];
  const writer: QuickBooksSignalWriter = (level, signal) => writes.push({ level, signal });

  emitQuickBooksWorkerOperationalSignal({
    eventCode: "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL",
    outcome: "CRITICAL",
    providerWorkflowCount: 10,
    providerFailureCount: 3,
    providerThrottleCount: 1,
    providerTimeoutCount: 1,
    providerSlowCount: 1,
    providerDegradedCallCount: 3,
    providerMaxDurationMs: 8_000,
    failureCodes: { secret: 3 },
    errorName: "provider-secret-must-not-log",
    tenantRefHash: "tenant-hash-must-not-log",
    realmId: "realm-secret-must-not-log",
  } as Parameters<typeof emitQuickBooksWorkerOperationalSignal>[0] & Record<string, unknown>, writer);

  assert.deepEqual(writes, [{
    level: "error",
    signal: {
      eventCode: "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL",
      outcome: "CRITICAL",
      providerWorkflowCount: 10,
      providerFailureCount: 3,
      providerThrottleCount: 1,
      providerTimeoutCount: 1,
      providerSlowCount: 1,
      providerDegradedCallCount: 3,
      providerMaxDurationMs: 8_000,
    },
  }]);
  assert.doesNotMatch(JSON.stringify(writes), /secret-must-not-log|failureCodes|errorName|tenantRefHash/);
});

test("external OAuth delivery sends only the fixed Better Stack-compatible schema", async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig("api"),
    (failure) => failures.push(failure),
    {
      fetch: async (input, init) => {
        requests.push({ input, init });
        return successfulResponse;
      },
    },
  );

  sink.enqueue("warn", {
    eventCode: "QUICKBOOKS_OAUTH_STATE_REPLAYED",
    callbackStage: "STATE_CONSUMPTION",
    outcome: "REJECTED",
    requestId: "request-secret-must-not-forward",
    sessionId: "session-secret-must-not-forward",
    userId: "user-secret-must-not-forward",
    tenantId: "tenant-secret-must-not-forward",
    realmId: "realm-secret-must-not-forward",
    companyName: "company-secret-must-not-forward",
    entityId: "entity-secret-must-not-forward",
    hash: "hash-secret-must-not-forward",
    url: "https://example.test/callback?code=must-not-forward",
    providerText: "provider-secret-must-not-forward",
    token: "oauth-token-must-not-forward",
    error: new Error("generic-error-must-not-forward"),
  } as Parameters<typeof sink.enqueue>[1] & Record<string, unknown>);
  await sink.flush();

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), "https://api-signals.example.test/");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.deepEqual(requests[0]?.init?.headers, {
    authorization: "Bearer api-source-token-test-only",
    "content-type": "application/json",
  });
  assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    schema: "quotefly.quickbooks.signal/v1",
    message: "QuickBooks integration terminal signal.",
    runtimeRole: "api",
    level: "warn",
    eventCode: "QUICKBOOKS_OAUTH_STATE_REPLAYED",
    callbackStage: "STATE_CONSUMPTION",
    outcome: "REJECTED",
  });
  assert.deepEqual(failures, []);
  assert.doesNotMatch(String(requests[0]?.init?.body), /must-not-forward/);
});

test("external refresh delivery uses the independent worker source and closed refresh fields", async () => {
  const bodies: string[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig("worker"),
    () => assert.fail("delivery should not fail"),
    {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return successfulResponse;
      },
    },
  );

  sink.enqueue("error", {
    eventCode: "QUICKBOOKS_TOKEN_REFRESH_REAUTH_REQUIRED",
    refreshStage: "TOKEN_REFRESH",
    outcome: "REAUTH_REQUIRED",
    tenantId: "tenant-secret-must-not-forward",
    providerError: "provider-secret-must-not-forward",
  } as Parameters<typeof sink.enqueue>[1] & Record<string, string>);
  await sink.flush();

  assert.deepEqual(JSON.parse(bodies[0] ?? "null"), {
    schema: "quotefly.quickbooks.signal/v1",
    message: "QuickBooks integration terminal signal.",
    runtimeRole: "worker",
    level: "error",
    eventCode: "QUICKBOOKS_TOKEN_REFRESH_REAUTH_REQUIRED",
    refreshStage: "TOKEN_REFRESH",
    outcome: "REAUTH_REQUIRED",
  });
  assert.doesNotMatch(bodies[0] ?? "", /must-not-forward/);
});

test("external worker health delivery allowlists only provider aggregates and fixed retention state", async () => {
  const bodies: string[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig("worker"),
    () => assert.fail("delivery should not fail"),
    {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return successfulResponse;
      },
    },
  );

  sink.enqueue("warn", {
    eventCode: "QUICKBOOKS_PROVIDER_HEALTH_WARNING",
    outcome: "WARNING",
    providerWorkflowCount: 8,
    providerFailureCount: 1,
    providerThrottleCount: 1,
    providerTimeoutCount: 0,
    providerSlowCount: 1,
    providerDegradedCallCount: 2,
    providerMaxDurationMs: 8_100,
    failureCodes: { "raw-provider-code-must-not-forward": 1 },
    errorName: "error-name-must-not-forward",
    tenantRefHash: "tenant-hash-must-not-forward",
    realmId: "realm-must-not-forward",
    companyId: "company-must-not-forward",
    url: "https://example.test/?token=must-not-forward",
    error: new Error("generic-error-must-not-forward"),
  } as Parameters<typeof sink.enqueue>[1] & Record<string, unknown>);
  sink.enqueue("error", {
    eventCode: "QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER",
    outcome: "CRITICAL",
    lastRetentionSucceededAtUtc: "identifier-must-not-forward",
    unresolvedFailureCount: 3,
    errorName: "retention-error-must-not-forward",
  } as Parameters<typeof sink.enqueue>[1] & Record<string, unknown>);
  await sink.flush();

  assert.deepEqual(bodies.map((body) => JSON.parse(body)), [
    {
      schema: "quotefly.quickbooks.worker-operational-signal/v1",
      message: "QuickBooks provider health signal.",
      runtimeRole: "worker",
      level: "warn",
      eventCode: "QUICKBOOKS_PROVIDER_HEALTH_WARNING",
      outcome: "WARNING",
      providerWorkflowCount: 8,
      providerFailureCount: 1,
      providerThrottleCount: 1,
      providerTimeoutCount: 0,
      providerSlowCount: 1,
      providerDegradedCallCount: 2,
      providerMaxDurationMs: 8_100,
    },
    {
      schema: "quotefly.quickbooks.worker-operational-signal/v1",
      message: "QuickBooks retention health signal.",
      runtimeRole: "worker",
      level: "error",
      eventCode: "QUICKBOOKS_RETENTION_HEALTH_CRITICAL_REMINDER",
      outcome: "CRITICAL",
    },
  ]);
  assert.doesNotMatch(bodies.join("\n"), /must-not-forward|failureCodes|errorName|tenantRefHash/);
});

test("external worker health delivery rejects inconsistent or unknown aggregates", async () => {
  let requestCount = 0;
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig("worker"),
    (failure) => failures.push(failure),
    { fetch: async () => { requestCount += 1; return successfulResponse; } },
  );
  sink.enqueue("error", {
    eventCode: "QUICKBOOKS_PROVIDER_HEALTH_CRITICAL",
    outcome: "CRITICAL",
    providerWorkflowCount: 1,
    providerFailureCount: 2,
    providerThrottleCount: 2,
    providerTimeoutCount: 0,
    providerSlowCount: 0,
    providerDegradedCallCount: 2,
    providerMaxDurationMs: 1,
  });
  await sink.flush();
  assert.equal(requestCount, 0);
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_SIGNAL_REJECTED",
    runtimeRole: "worker",
    outcome: "FAILED",
  }]);
});

test("external sink rejects unknown vocabularies without making a request", async () => {
  let requestCount = 0;
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig(),
    (failure) => failures.push(failure),
    {
      fetch: async () => {
        requestCount += 1;
        return successfulResponse;
      },
    },
  );

  sink.enqueue("error", {
    eventCode: "QUICKBOOKS_UNKNOWN_TENANT_123",
    callbackStage: "COMPLETED",
    outcome: "FAILED",
  } as unknown as Parameters<typeof sink.enqueue>[1]);
  await sink.flush();

  assert.equal(requestCount, 0);
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_SIGNAL_REJECTED",
    runtimeRole: "api",
    outcome: "FAILED",
  }]);
});

test("external sink failure logs are fixed, content-free, and do not recurse", async () => {
  let requestCount = 0;
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig(),
    (failure) => failures.push(failure),
    {
      fetch: async () => {
        requestCount += 1;
        throw new Error("tenant-and-token-secret-must-not-log");
      },
    },
  );

  sink.enqueue("warn", {
    eventCode: "QUICKBOOKS_OAUTH_STATE_INVALID",
    callbackStage: "STATE_VALIDATION",
    outcome: "REJECTED",
  });
  await sink.flush();

  assert.equal(requestCount, 1);
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED",
    runtimeRole: "api",
    outcome: "FAILED",
  }]);
  assert.doesNotMatch(JSON.stringify(failures), /must-not-log/);
});

test("external sink cancels response bodies for both successful and failed HTTP delivery", async () => {
  const cancelled: string[] = [];
  const failures: unknown[] = [];
  let requestCount = 0;
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig(),
    (failure) => failures.push(failure),
    {
      fetch: async () => {
        requestCount += 1;
        const label = requestCount === 1 ? "success" : "failure";
        return {
          ok: label === "success",
          body: { cancel: async () => { cancelled.push(label); } },
        } as unknown as Response;
      },
    },
  );
  const signal = {
    eventCode: "QUICKBOOKS_OAUTH_STATE_INVALID",
    callbackStage: "STATE_VALIDATION",
    outcome: "REJECTED",
  } as const;

  sink.enqueue("warn", signal);
  sink.enqueue("warn", signal);
  await sink.flush();

  assert.deepEqual(cancelled, ["success", "failure"]);
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED",
    runtimeRole: "api",
    outcome: "FAILED",
  }]);
});

test("external sink body cleanup failures remain fail-open", async () => {
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig(),
    (failure) => failures.push(failure),
    {
      fetch: async () => ({
        ok: true,
        body: { cancel: async () => { throw new Error("response-cancel-failed"); } },
      } as unknown as Response),
    },
  );

  assert.doesNotThrow(() => sink.enqueue("warn", {
    eventCode: "QUICKBOOKS_OAUTH_STATE_INVALID",
    callbackStage: "STATE_VALIDATION",
    outcome: "REJECTED",
  }));
  await assert.doesNotReject(sink.flush());
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_DELIVERY_FAILED",
    runtimeRole: "api",
    outcome: "FAILED",
  }]);
});

test("external sink failures cannot escape even when the local failure writer throws", async () => {
  const sink = createQuickBooksExternalSignalSink(
    testSinkConfig(),
    () => { throw new Error("local-logger-failed"); },
    { fetch: async () => { throw new Error("remote-delivery-failed"); } },
  );

  assert.doesNotThrow(() => sink.enqueue("error", {
    eventCode: "QUICKBOOKS_OAUTH_CALLBACK_UNKNOWN",
    callbackStage: "COMPLETED",
    outcome: "FAILED",
  }));
  await assert.doesNotReject(sink.flush());
});

test("external sink has a bounded queue and bounded best-effort flush", async () => {
  let releaseFirstRequest: (() => void) | undefined;
  const failures: unknown[] = [];
  const sink = createQuickBooksExternalSignalSink(
    { ...testSinkConfig(), timeoutMs: 20 },
    (failure) => failures.push(failure),
    {
      maxPending: 1,
      fetch: async () => new Promise<Response>((resolve) => {
        releaseFirstRequest = () => resolve(successfulResponse);
      }),
    },
  );
  const signal = {
    eventCode: "QUICKBOOKS_OAUTH_STATE_INVALID",
    callbackStage: "STATE_VALIDATION",
    outcome: "REJECTED",
  } as const;

  sink.enqueue("warn", signal);
  sink.enqueue("warn", signal);
  await sink.flush(5);
  assert.deepEqual(failures, [{
    eventCode: "QUICKBOOKS_SIGNAL_SINK_QUEUE_FULL",
    runtimeRole: "api",
    outcome: "FAILED",
  }]);
  releaseFirstRequest?.();
  await sink.flush();
});

test("signal sink configuration is optional, HTTPS-only, and role-isolated", () => {
  const input = {
    QUICKBOOKS_API_SIGNAL_INGEST_URL: "https://api-source.example.test",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "api-source-token-test-only",
    QUICKBOOKS_WORKER_SIGNAL_INGEST_URL: "https://worker-source.example.test",
    QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN: "worker-source-token-test-only",
    QUICKBOOKS_SIGNAL_INGEST_TIMEOUT_MS: "750",
  } satisfies NodeJS.ProcessEnv;

  assert.deepEqual(resolveQuickBooksExternalSignalSinkConfig("api", input), {
    ingestUrl: "https://api-source.example.test/",
    sourceToken: "api-source-token-test-only",
    runtimeRole: "api",
    timeoutMs: 750,
  });
  assert.deepEqual(resolveQuickBooksExternalSignalSinkConfig("worker", input), {
    ingestUrl: "https://worker-source.example.test/",
    sourceToken: "worker-source-token-test-only",
    runtimeRole: "worker",
    timeoutMs: 750,
  });
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("api", {}), null);
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("api", {
    QUICKBOOKS_API_SIGNAL_INGEST_URL: "http://insecure.example.test",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "api-source-token-test-only",
  }), null);
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("api", {
    QUICKBOOKS_API_SIGNAL_INGEST_URL: "https://user:password@example.test?token=secret",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "api-source-token-test-only",
  }), null);
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("api", {
    QUICKBOOKS_API_SIGNAL_INGEST_URL: "https://api-source.example.test",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "api source token with whitespace",
  }), null);
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("api", {
    QUICKBOOKS_API_SIGNAL_INGEST_URL: "https://api-source.example.test",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "shared-source-token-test-only",
    JWT_SECRET: "shared-source-token-test-only",
  }), null);
  assert.equal(resolveQuickBooksExternalSignalSinkConfig("worker", {
    QUICKBOOKS_WORKER_SIGNAL_INGEST_URL: "https://worker-source.example.test",
    QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN: "shared-source-token-test-only",
    QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: "shared-source-token-test-only",
  }), null);
});
