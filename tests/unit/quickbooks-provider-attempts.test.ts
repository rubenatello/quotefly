import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  fetchQuickBooksCompanyInfo,
  resolveQuickBooksIncomeAccount,
} from "../../src/services/quickbooks";
import {
  createQuickBooksWorkerOperationalTracker,
  registerQuickBooksProviderAttemptObserver,
  type QuickBooksProviderAttemptObservation,
} from "../../src/services/quickbooks-worker-operational";

type RuntimeEnv = Parameters<typeof fetchQuickBooksCompanyInfo>[0];

function runtimeEnv(readRetries = 0): RuntimeEnv {
  return {
    QUICKBOOKS_ENVIRONMENT: "sandbox",
    QUICKBOOKS_PROVIDER_READ_RETRIES: readRetries,
    QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1_000,
  } as RuntimeEnv;
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function collectProviderAttempts() {
  const startupAtUtc = new Date(Date.now() - 1_000);
  const tracker = createQuickBooksWorkerOperationalTracker({
    environment: "sandbox",
    startupAtUtc,
  });
  const observations: QuickBooksProviderAttemptObservation[] = [];
  const unregister = registerQuickBooksProviderAttemptObserver((observation) => {
    observations.push(observation);
    tracker.recordProviderAttempt(observation);
  });
  return { observations, tracker, unregister };
}

test("worker health remains at zero when no Intuit HTTP attempt occurs", () => {
  const { observations, tracker, unregister } = collectProviderAttempts();
  try {
    assert.deepEqual(observations, []);
    assert.equal(tracker.heartbeat().providerWindow.callCount, 0);

    const workerSource = readFileSync(
      new URL("../../src/workers/quickbooks-reconciliation-worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(workerSource, /registerQuickBooksProviderAttemptObserver/);
    assert.doesNotMatch(workerSource, /recordProviderWorkflowDuration|providerWorkflowStartedAtMs/);
  } finally {
    unregister();
  }
});

test("one high-level provider workflow counts each of its actual HTTP attempts", async () => {
  const originalFetch = globalThis.fetch;
  const { observations, tracker, unregister } = collectProviderAttempts();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return jsonResponse(fetchCount === 1
      ? { QueryResponse: { Account: [] } }
      : { QueryResponse: { Account: [{ Id: "income-1", Name: "Services" }] } });
  };
  try {
    const account = await resolveQuickBooksIncomeAccount(
      runtimeEnv(),
      "private-realm",
      "private-access-token",
    );
    assert.equal(account.value, "income-1");
    assert.equal(fetchCount, 2);
    assert.deepEqual(observations.map(({ outcome }) => outcome), ["success", "success"]);
    assert.equal(tracker.heartbeat().providerWindow.callCount, 2);
    for (const observation of observations) {
      assert.deepEqual(Object.keys(observation).sort(), ["durationMs", "outcome"]);
      assert.doesNotMatch(
        JSON.stringify(observation),
        /private-realm|private-access-token|intuit|https?:|error|status/i,
      );
    }
  } finally {
    unregister();
    globalThis.fetch = originalFetch;
  }
});

test("a retried 429 records the throttled attempt and the successful attempt separately", async () => {
  const originalFetch = globalThis.fetch;
  const { observations, tracker, unregister } = collectProviderAttempts();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) return jsonResponse({}, 429, { "retry-after": "0" });
    return jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Sandbox" } });
  };
  try {
    await assert.doesNotReject(() => fetchQuickBooksCompanyInfo(
      runtimeEnv(1),
      "private-realm",
      "private-access-token",
    ));
    assert.equal(fetchCount, 2);
    assert.deepEqual(observations.map(({ outcome }) => outcome), ["throttle", "success"]);
    const window = tracker.heartbeat().providerWindow;
    assert.equal(window.callCount, 2);
    assert.equal(window.failureCount, 1);
    assert.equal(window.throttleCount, 1);
  } finally {
    unregister();
    globalThis.fetch = originalFetch;
  }
});

test("HTTP and thrown timeout classes stay closed while generic network failures stay generic", async () => {
  const originalFetch = globalThis.fetch;
  const { observations, unregister } = collectProviderAttempts();
  const results: Array<"http-timeout" | "TimeoutError" | "AbortError" | "TypeError"> = [
    "http-timeout",
    "TimeoutError",
    "AbortError",
    "TypeError",
  ];
  globalThis.fetch = async () => {
    const result = results.shift();
    if (result === "http-timeout") return jsonResponse({}, 504);
    const error = new Error("raw provider failure text must not escape");
    error.name = result ?? "TypeError";
    throw error;
  };
  try {
    for (let index = 0; index < 4; index += 1) {
      await assert.rejects(() => fetchQuickBooksCompanyInfo(
        runtimeEnv(),
        "private-realm",
        "private-access-token",
      ));
    }
    assert.deepEqual(
      observations.map(({ outcome }) => outcome),
      ["timeout", "timeout", "timeout", "failure"],
    );
    assert.doesNotMatch(JSON.stringify(observations), /raw provider|TimeoutError|AbortError|TypeError/);
  } finally {
    unregister();
    globalThis.fetch = originalFetch;
  }
});

test("an eight-second HTTP attempt is recorded as slow at the transport boundary", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const { observations, tracker, unregister } = collectProviderAttempts();
  let clockMs = 1_000;
  Date.now = () => clockMs;
  globalThis.fetch = async () => {
    clockMs = 9_000;
    return jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Sandbox" } });
  };
  try {
    await fetchQuickBooksCompanyInfo(runtimeEnv(), "private-realm", "private-access-token");
    assert.deepEqual(observations, [{ outcome: "success", durationMs: 8_000 }]);
    const window = tracker.heartbeat().providerWindow;
    assert.equal(window.callCount, 1);
    assert.equal(window.slowCount, 1);
    assert.equal(window.degradedCallCount, 1);
    assert.equal(window.maximumDurationMs, 8_000);
  } finally {
    unregister();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

test("throwing and unregistered observers cannot change provider outcomes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    CompanyInfo: { Id: "1", CompanyName: "Sandbox" },
  });
  let throwingObserverCallCount = 0;
  let postUnregisterObservationCount = 0;
  const unregisterThrowing = registerQuickBooksProviderAttemptObserver(() => {
    throwingObserverCallCount += 1;
    throw new Error("observer failure");
  });
  try {
    await assert.doesNotReject(() => fetchQuickBooksCompanyInfo(
      runtimeEnv(),
      "private-realm",
      "private-access-token",
    ));
    assert.equal(throwingObserverCallCount, 1);
    const unregisterSecond = registerQuickBooksProviderAttemptObserver(() => {
      postUnregisterObservationCount += 1;
    });
    unregisterThrowing();
    await assert.doesNotReject(() => fetchQuickBooksCompanyInfo(
      runtimeEnv(),
      "private-realm",
      "private-access-token",
    ));
    assert.equal(postUnregisterObservationCount, 1);
    unregisterSecond();
    unregisterSecond();
    await assert.doesNotReject(() => fetchQuickBooksCompanyInfo(
      runtimeEnv(),
      "private-realm",
      "private-access-token",
    ));
    assert.equal(postUnregisterObservationCount, 1);
  } finally {
    unregisterThrowing();
    globalThis.fetch = originalFetch;
  }
});

test("a 2xx response with invalid provider JSON remains a transport success", async () => {
  const originalFetch = globalThis.fetch;
  const { observations, unregister } = collectProviderAttempts();
  globalThis.fetch = async () => jsonResponse({ CompanyInfo: { Id: 42 } });
  try {
    await assert.rejects(() => fetchQuickBooksCompanyInfo(
      runtimeEnv(),
      "private-realm",
      "private-access-token",
    ));
    assert.deepEqual(observations.map(({ outcome }) => outcome), ["success"]);
  } finally {
    unregister();
    globalThis.fetch = originalFetch;
  }
});
