import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { authorized, initialState, loadConfig, MAX_QUEUE, probe, receiveSignal, recordProbe, selfHealthy, sendNotification, validateState } from "../../src/watchdog/core";
import { WatchdogStore } from "../../src/watchdog/store";
import { createWatchdogServer } from "../../src/watchdog/server";
import { parseQuickBooksExternalSignalPayload } from "../../src/services/quickbooks-observability";

const environment = {
  WATCHDOG_ENVIRONMENT: "staging", WATCHDOG_MONITOR_BEARER: "m".repeat(40),
  WATCHDOG_API_SOURCE_TOKEN: "a".repeat(40), WATCHDOG_WORKER_SOURCE_TOKEN: "w".repeat(40),
  WATCHDOG_RESEND_API_KEY: "r".repeat(40), WATCHDOG_EMAIL_FROM: "monitor@example.com",
  WATCHDOG_EMAIL_TO: "owner@example.com", WATCHDOG_STATE_DIRECTORY: os.tmpdir(),
};
const config = loadConfig(environment);
const clock = 2_000_000_000_000;
const signal = {
  schema: "quotefly.quickbooks.signal/v1", message: "QuickBooks integration terminal signal.",
  runtimeRole: "api", level: "warn", eventCode: "QUICKBOOKS_OAUTH_STATE_REPLAYED",
  callbackStage: "STATE_CONSUMPTION", outcome: "REJECTED",
};
function tempStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quotefly-watchdog-test-"));
  fs.chmodSync(directory, 0o700);
  const store = new WatchdogStore(directory, config.destination);
  return { directory, store, cleanup: () => { store.close(); fs.rmSync(directory, { recursive: true }); } };
}

test("watchdog config fails closed and isolates role/monitor/mail credentials", () => {
  assert.equal(config.origin, "https://api-staging.quotefly.us");
  assert.equal(loadConfig({ ...environment, WATCHDOG_ENVIRONMENT: "production" }).origin, "https://api.quotefly.us");
  for (const override of [{ WATCHDOG_ENVIRONMENT: "preview" }, { WATCHDOG_API_SOURCE_TOKEN: environment.WATCHDOG_MONITOR_BEARER }, { WATCHDOG_API_SOURCE_TOKEN: "short" }, { WATCHDOG_EMAIL_TO: "victim@example.com\r\nBcc:x@example.com" }, { PORT: "NaN" }]) {
    assert.throws(() => loadConfig({ ...environment, ...override }), /WATCHDOG_CONFIGURATION_INVALID/);
  }
});
test("exact authorization does not accept query/basic/bare/cross-role tokens", () => {
  assert(authorized(`Bearer ${config.apiToken}`, config.apiToken));
  for (const header of [null, [config.apiToken], config.apiToken, `bearer ${config.apiToken}`, `Bearer ${config.workerToken}`, `Bearer ${config.apiToken} `]) assert(!authorized(header, config.apiToken));
});
test("strict shared signal parser rejects content, unknown fields, level/role mismatch", () => {
  const parsed = parseQuickBooksExternalSignalPayload(signal, "api");
  assert.deepEqual(parsed, signal);
  assert.notEqual(parsed, signal);
  for (const item of [null, [], { ...signal, token: "never retain" }, { ...signal, runtimeRole: "worker" }, { ...signal, level: "info" }, { ...signal, eventCode: "QUICKBOOKS_UNTRUSTED" }, JSON.parse(JSON.stringify(signal).replace('"outcome":"REJECTED"', '"__proto__":{},"outcome":"REJECTED"'))]) {
    assert.equal(parseQuickBooksExternalSignalPayload(item, "api"), null);
  }
});
test("worker pushed recovery cannot clear the authoritative fleet incident", () => {
  const state = initialState(config.destination);
  recordProbe(state, "critical", clock);
  assert(receiveSignal(state, { schema: "quotefly.quickbooks.worker-operational-signal/v1", message: "QuickBooks retention health signal.", runtimeRole: "worker", level: "info", eventCode: "QUICKBOOKS_RETENTION_HEALTH_RECOVERED", outcome: "RECOVERED" }, "worker", clock));
  assert.equal(state.incident, "critical");
});
test("terminal duplicate and replay bounded to fixed code reminders; successes never clear", () => {
  const state = initialState(config.destination);
  assert(receiveSignal(state, signal, "api", clock));
  assert(receiveSignal(state, signal, "api", clock + 1));
  assert.equal(state.queue.length, 1);
  assert(receiveSignal(state, { ...signal, eventCode: "QUICKBOOKS_OAUTH_CALLBACK_COMPLETED", level: "info", callbackStage: "COMPLETED", outcome: "SUCCEEDED" }, "api", clock + 2));
  assert.equal(state.queue.length, 1);
  receiveSignal(state, signal, "api", clock + 3_600_000);
  assert.equal(state.queue.length, 2);
  assert.equal(JSON.stringify(state).includes("callbackStage"), false);
});
test("two consecutive clean fleet probes required for recovery; startup canary is explicit", () => {
  const state = initialState(config.destination);
  recordProbe(state, "critical", clock);
  recordProbe(state, "healthy", clock + 60_000);
  assert.equal(state.incident, "critical");
  recordProbe(state, "healthy", clock + 120_000);
  assert.equal(state.incident, "healthy");
  assert.deepEqual(state.queue.map(item => item.code), ["MONITOR_CRITICAL", "DAILY_CANARY", "MONITOR_RECOVERED"]);
  assert(validateState(state, config.destination));
});
test("self-readiness never passes stale probes, stale queue, missing mail acceptance", () => {
  const state = initialState(config.destination);
  assert(!selfHealthy(state, clock));
  recordProbe(state, "healthy", clock);
  state.lastAcceptedAt = clock;
  assert(selfHealthy(state, clock));
  assert(!selfHealthy(state, clock + 180_001));
  state.lastProbeAt = clock + 300_001;
  assert(!selfHealthy(state, clock + 300_001));
});
test("all poll result combinations fail closed with no redirect or response retention", async () => {
  for (const [warning, critical, result] of [[204,204,"healthy"],[503,204,"warning"],[204,503,"critical"],[503,503,"critical"],[401,204,"critical"],[204,429,"critical"],[302,204,"critical"],[200,204,"critical"]] as const) {
    let calls = 0;
    const fetcher = (async (_url, init) => {
      assert.equal(init?.redirect, "error");
      assert(init?.signal);
      return new Response(null, { status: calls++ === 0 ? warning : critical });
    }) as typeof fetch;
    assert.equal(await probe(config, fetcher), result);
    assert.equal(calls, 2);
  }
  assert.equal(await probe(config, (async () => { throw new Error("private response"); }) as typeof fetch), "critical");
  assert.equal(await probe(config, (async () => new Response("private body", { status: 503 })) as typeof fetch), "critical");
});
test("email retries preserve fixed body/idempotency and reject failures without response text", async () => {
  const state = initialState(config.destination);
  receiveSignal(state, signal, "api", clock);
  const requests: RequestInit[] = [];
  const fetcher = (async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    requests.push(init!);
    return new Response("not retained", { status: requests.length === 1 ? 500 : 200 });
  }) as typeof fetch;
  await assert.rejects(sendNotification(config, state.queue[0], fetcher), /WATCHDOG_EMAIL_NOT_ACCEPTED/);
  await sendNotification(config, state.queue[0], fetcher);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  assert.equal(requests[0].redirect, "error");
  for (const secret of [config.apiToken, config.workerToken, config.monitorBearer, config.mailKey]) assert(!String(requests[0].body).includes(secret));
});
test("one-instance lock, durable queue restart, destination binding, and corrupt-state refusal", () => {
  const fixture = tempStore();
  try {
    assert.throws(() => new WatchdogStore(fixture.directory, config.destination));
    fixture.store.change(state => receiveSignal(state, signal, "api", clock));
    const before = fixture.store.snapshot();
    fixture.store.close();
    const resumed = new WatchdogStore(fixture.directory, config.destination);
    assert.deepEqual(resumed.snapshot(), before);
    resumed.close();
    assert.throws(() => new WatchdogStore(fixture.directory, "wrong-destination"), /WATCHDOG_STORAGE_UNAVAILABLE/);
    fs.writeFileSync(path.join(fixture.directory, "state.json"), "{bad-json}");
    assert.throws(() => new WatchdogStore(fixture.directory, config.destination), /WATCHDOG_STORAGE_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(fixture.directory, "state.json"), "utf8"), "{bad-json}");
  } finally { fixture.cleanup(); }
});
test("queue pressure cannot partially mutate durable state", () => {
  const fixture = tempStore();
  try {
    fixture.store.change(state => { for (let n = 0; n < MAX_QUEUE; n++) receiveSignal(state, signal, "api", clock + n * 3_600_000); });
    const before = fixture.store.snapshot();
    assert.throws(() => fixture.store.change(state => receiveSignal(state, signal, "api", clock + MAX_QUEUE * 3_600_000)), /WATCHDOG_QUEUE_FULL/);
    assert.deepEqual(fixture.store.snapshot(), before);
    assert.equal(fixture.store.healthy, true);
  } finally { fixture.cleanup(); }
});
test("restored state rejects unknown codes, oversized queue and extra data", () => {
  const state = initialState(config.destination);
  assert(!validateState({ ...state, secret: "discard" }, config.destination));
  assert(!validateState({ ...state, reminders: { "api:QUICKBOOKS_FAKE": clock } }, config.destination));
  assert(!validateState({ ...state, queue: Array(MAX_QUEUE + 1).fill({}) }, config.destination));
});
test("HTTP receiver enforces auth/role/path/type/body and content-free health", async () => {
  const fixture = tempStore();
  const server = createWatchdogServer(config, fixture.store, () => clock);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const request = async (route: string, headers = {}, body = JSON.stringify(signal), method = "POST") => {
    const response = await fetch(`${url}${route}`, { method, headers, body: method === "GET" ? undefined : body });
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.status;
  };
  try {
    const headers = { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" };
    assert.equal(await request("/health", {}, "", "GET"), 204);
    assert.equal(await request("/ready", {}, "", "GET"), 503);
    for (let n = 0; n < 245; n++) assert.equal(await request("/signals/api"), 401);
    assert.equal(await request("/health", {}, "", "GET"), 204);
    assert.equal(await request("/signals/api"), 401);
    assert.equal(await request("/signals/worker", headers), 401);
    assert.equal(await request("/signals/api?token=forbidden", headers), 404);
    assert.equal(await request("/signals/api", { ...headers, "content-type": "text/plain" }), 415);
    assert.equal(await request("/signals/api", headers, "{"), 400);
    assert.equal(await request("/signals/api", headers, "x".repeat(8193)), 413);
    assert.equal(await request("/signals/api", headers), 204);
    assert.equal(fixture.store.snapshot().queue.length, 1);
    for (let n = 0; n < 101; n++) await request("/signals/api", headers);
    assert.equal(await request("/signals/api", headers), 429);
    assert.equal(fixture.store.snapshot().queue.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }
});
test("standalone runtime imports only builtins and the two pure signal modules", () => {
  const worker = fs.readFileSync("src/services/quickbooks-worker-operational.ts", "utf8");
  assert(!/^import /m.test(worker));
  const observer = fs.readFileSync("src/services/quickbooks-observability.ts", "utf8");
  assert.deepEqual([...observer.matchAll(/from "([^"]+)"/g)].map(match => match[1]), ["./quickbooks-worker-operational"]);
  for (const file of ["core", "store", "server", "main", "process-lock"]) {
    const source = fs.readFileSync(`src/watchdog/${file}.ts`, "utf8");
    for (const match of source.matchAll(/from "([^"]+)"/g)) assert(match[1].startsWith("node:") || match[1].startsWith("./") || match[1] === "../services/quickbooks-observability");
  }
});
