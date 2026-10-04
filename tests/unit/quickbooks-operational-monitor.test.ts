import assert from "node:assert/strict";
import test from "node:test";
import { parseQuickBooksMonitorEnv, QUICKBOOKS_MONITOR_FORBIDDEN_KEYS } from "../../src/config/quickbooks-monitor-env";
import { observeQuickBooksHealth } from "../../src/services/quickbooks-monitor-contract";
import { aggregateQuickBooksOperationalRows } from "../../src/services/quickbooks-operational-health";
import { sendQuickBooksOperationalAlert } from "../../src/services/transactional-email";

const source = {
  DATABASE_URL: "postgresql://postgres@localhost:55432/quotefly_monitor_test",
  RESEND_API_KEY: "synthetic-test-only", PASSWORD_RESET_EMAIL_FROM: "QuoteFly <alerts@example.com>",
  QUICKBOOKS_ALERT_EMAIL: "operations@example.com", QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL: "test",
  QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: "true", QUICKBOOKS_MONITOR_EXPECT_CDC: "true",
};
const env = parseQuickBooksMonitorEnv(source);
const now = new Date("2026-09-20T00:00:00Z");
const healthyHeartbeat = { status: "RUNNING" as const, fresh: true, heartbeatAtUtc: now, startedAtUtc: now, cycleStartedAtUtc: now, lastCycleDurationMs: 0, metrics: {} };
const empty = aggregateQuickBooksOperationalRows([], now);

test("monitor defaults off, rejects unrelated secrets and emits no raw configuration", () => {
  assert.equal(env.QUICKBOOKS_MONITOR_ENABLED, false);
  for (const key of QUICKBOOKS_MONITOR_FORBIDDEN_KEYS) {
    assert.throws(() => parseQuickBooksMonitorEnv({ ...source, [key]: "never-print-this" }), { message: "QUICKBOOKS_MONITOR_FORBIDDEN_CONFIGURATION" });
  }
  assert.throws(() => parseQuickBooksMonitorEnv({ ...source, DATABASE_URL: "secret-malformed-url" }), { message: "QUICKBOOKS_MONITOR_INVALID_CONFIGURATION" });
  assert.throws(() => parseQuickBooksMonitorEnv({ ...source, QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: "false" }));
});

test("database credential URL aliases are rejected without rejecting Railway metadata", () => {
  for (const key of ["DATABASE_PUBLIC_URL", "DATABASE_PRIVATE_URL", "POSTGRES_URL", "POSTGRESQL_CONNECTION_URI", "PG_CONNECTION_URL", "DB_CONNECTION_STRING", "REDIS_PRIVATE_URL"]) {
    assert.throws(() => parseQuickBooksMonitorEnv({ ...source, [key]: "synthetic-forbidden-value" }), { message: "QUICKBOOKS_MONITOR_FORBIDDEN_CONFIGURATION" });
  }
  assert.doesNotThrow(() => parseQuickBooksMonitorEnv({ ...source, RAILWAY_SERVICE_ID: "synthetic-service", RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_PUBLIC_DOMAIN: "monitor.example.com" }));
});

test("heartbeat absence, stopped state, and >180s age are critical only when expected", () => {
  const first = (heartbeat: typeof healthyHeartbeat | null) => observeQuickBooksHealth(empty, heartbeat, env, now)[0];
  assert.equal(first(null).severity, "CRITICAL");
  assert.equal(first(healthyHeartbeat).severity, "HEALTHY");
  assert.equal(first({ ...healthyHeartbeat, heartbeatAtUtc: new Date(now.getTime() - 180001) }).severity, "CRITICAL");
  assert.equal(first({ ...healthyHeartbeat, heartbeatAtUtc: new Date(now.getTime() - 180000) }).severity, "HEALTHY");
  assert.equal(observeQuickBooksHealth(empty, { ...healthyHeartbeat, status: "STOPPED" }, env, now)[0].severity, "CRITICAL");
  assert.equal(observeQuickBooksHealth(empty, null, { ...env, QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: false }, now)[0].severity, "HEALTHY");
});

test("backlog thresholds are strict at 5 and 15 minutes; dead records alert immediately", () => {
  for (const [age, severity] of [[300000, "HEALTHY"], [300001, "WARNING"], [900000, "WARNING"], [900001, "CRITICAL"]] as const) {
    const observations = observeQuickBooksHealth({ ...empty, webhookOutstandingCount: 1, oldestWebhookOutstandingAgeMs: age,
      reconciliationRequiredCount: 1, oldestReconciliationRequiredAgeMs: age, tokenReauthCount: 1, oldestTokenFailureAgeMs: age,
      orphanRevocationPendingCount: 1, oldestOrphanRevocationPendingAgeMs: age }, healthyHeartbeat, env, now);
    for (const code of ["WEBHOOK_BACKLOG", "RECONCILIATION_REQUIRED", "TOKEN_FAILURE", "REVOCATION_PENDING"]) assert.equal(observations.find((value) => value.alertCode === code)?.severity, severity);
  }
  const dead = observeQuickBooksHealth({ ...empty, webhookDeadCount: 1, connectionRevocationDeadCount: 1, cdcTerminalCount: 1 }, healthyHeartbeat, env, now);
  for (const code of ["WEBHOOK_DEAD", "REVOCATION_DEAD", "CDC_RECOVERY"]) assert.equal(dead.find((value) => value.alertCode === code)?.severity, "CRITICAL");
});

test("CDC lag is expected-flag gated without suppressing terminal recovery incidents", () => {
  const flags = { ...env, QUICKBOOKS_MONITOR_EXPECT_CDC: false };
  const health = { ...empty, cdcCursorCount: 1, maximumCdcLagMs: 1020001 };
  assert.equal(observeQuickBooksHealth(health, healthyHeartbeat, flags, now).find((v) => v.alertCode === "CDC_RECOVERY")?.severity, "HEALTHY");
  assert.equal(observeQuickBooksHealth(health, healthyHeartbeat, env, now).find((v) => v.alertCode === "CDC_RECOVERY")?.severity, "CRITICAL");
});

test("fixed-recipient email uses stable idempotency and rejects arbitrary content before network", async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init!); return new Response("", { status: 200 }); };
  const message = { alertCode: "WORKER_HEARTBEAT" as const, transition: "OPEN" as const, severity: "CRITICAL" as const, incidentGeneration: 1, observedAtUtc: now, metrics: { count: 0, ageMs: null } };
  try {
    await sendQuickBooksOperationalAlert(env, message, "a".repeat(64));
    await sendQuickBooksOperationalAlert(env, message, "a".repeat(64));
    assert.equal(requests[0].body, requests[1].body);
    assert.equal((requests[0].headers as Record<string, string>)["Idempotency-Key"], `quickbooks-monitor-${"a".repeat(64)}`);
    assert.deepEqual(JSON.parse(requests[0].body as string).to, [source.QUICKBOOKS_ALERT_EMAIL]);
    await assert.rejects(sendQuickBooksOperationalAlert(env, { ...message, metrics: { ...message.metrics, customer: "private" } } as never, "b".repeat(64)));
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});
