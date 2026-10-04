import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createQuickBooksInvoice as createInvoice, createQuickBooksInvoiceWriteControl, classifyQuickBooksInvoiceWriteFailure, QuickBooksProviderError, quickBooksInvoicePrecreateFailureMessage } from "../../src/services/quickbooks";
import { quickBooksInvoiceRetryAvailable, type QuickBooksInvoiceOperationPublic } from "../../src/services/quickbooks-invoices";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";

const env: QuickBooksCredentialRuntimeEnv = {
  QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1000, QUICKBOOKS_PROVIDER_READ_RETRIES: 0,
  QUICKBOOKS_CLIENT_ID: "synthetic-client", QUICKBOOKS_CLIENT_SECRET: "synthetic-secret",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-key", QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "", JWT_SECRET: "synthetic-jwt",
};
const realm = "123456789";
const token = "synthetic-token";
const payload = { DocNumber: "QF-000001", CustomerRef: { value: "customer" }, Line: [] };
const enabled = { Preferences: { SalesFormsPrefs: { CustomTxnNumbers: true } } };
function control(beforeCreate = async () => {}, claimDeadlineAtMs = Date.now() + 120_000) {
  return createQuickBooksInvoiceWriteControl({ payload, providerRequestId: "stable-request-id", realmId: realm, claimDeadlineAtMs, beforeCreate });
}
function createQuickBooksInvoice(runtime: typeof env, realmId: string, accessToken: string, body: Record<string, unknown>, requestId = "stable-request-id") {
  return createInvoice(runtime, realmId, accessToken, body, requestId, createQuickBooksInvoiceWriteControl({
    payload: body, providerRequestId: requestId, realmId, claimDeadlineAtMs: Date.now() + 120_000, beforeCreate: async () => {},
  }));
}
type Scenario = { preferences?: unknown; query?: unknown; failureAt?: "preferences" | "query" | "create"; failureStatus?: number; invalidJson?: boolean; mutate?: () => void };
function provider(t: TestContext, scenario: Scenario = {}) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const parsed = new URL(url); calls.push({ url: parsed, init });
    const step = parsed.pathname.endsWith("/preferences") ? "preferences" : parsed.pathname.endsWith("/query") ? "query" : "create";
    if (scenario.failureAt === step) {
      if (scenario.failureStatus) return new Response("synthetic private provider details", { status: scenario.failureStatus });
      throw new Error("synthetic private provider details");
    }
    if (step === "preferences") scenario.mutate?.();
    if (scenario.invalidJson && step === "preferences") return new Response("synthetic private invalid JSON", { status: 200 });
    const body = step === "preferences" ? (scenario.preferences ?? enabled) : step === "query" ? (scenario.query ?? { QueryResponse: {} }) : { Invoice: { Id: "invoice-created" } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

test("fresh numbering and strict zero match checks precede the exact requestid/body POST", async (t) => {
  const original = structuredClone(payload);
  const calls = provider(t, { mutate: () => { original.DocNumber = "changed-after-snapshot"; } });
  await createQuickBooksInvoice(env, realm, token, original, "stable-request-id");
  assert.deepEqual(calls.map(({ url }) => url.pathname), [`/v3/company/${realm}/preferences`, `/v3/company/${realm}/query`, `/v3/company/${realm}/invoice`]);
  assert.match(calls[1].url.searchParams.get("query") ?? "", /DocNumber = 'QF-000001' MAXRESULTS 1$/);
  assert.equal(calls[2].url.searchParams.get("requestid"), "stable-request-id");
  assert.equal(calls[2].init?.body, JSON.stringify(payload));
  assert.deepEqual(calls.map(({ init }) => init?.method ?? "GET"), ["GET", "GET", "POST"]);
  for (const { init } of calls) assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
});

test("disabled, missing, malformed and unavailable preferences never reach query or CREATE", async (t) => {
  const cases: Array<[Scenario, string]> = [
    [{ preferences: { Preferences: { SalesFormsPrefs: { CustomTxnNumbers: false } } } }, "QUICKBOOKS_CUSTOM_NUMBERING_REQUIRED"],
    [{ preferences: { Preferences: {} } }, "QUICKBOOKS_CUSTOM_NUMBERING_REQUIRED"],
    [{ preferences: { Preferences: { SalesFormsPrefs: { CustomTxnNumbers: "true" } } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ preferences: {} }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ invalidJson: true }, "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE"],
    [{ failureAt: "preferences" }, "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE"],
    [{ failureAt: "preferences", failureStatus: 503 }, "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE"],
  ];
  for (const [scenario, code] of cases) {
    const calls = provider(t, scenario);
    await assert.rejects(createQuickBooksInvoice(env, realm, token, payload), { code, ambiguous: false, message: code });
    assert.equal(calls.length, 1);
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
    t.mock.restoreAll();
  }
});

test("any collision or malformed/unavailable query blocks CREATE", async (t) => {
  const cases: Array<[Scenario, string]> = [
    [{ query: { QueryResponse: { Invoice: [{ Id: "existing" }] } } }, "QUICKBOOKS_DOC_NUMBER_COLLISION"],
    [{ query: { QueryResponse: { Invoice: [], totalCount: 1 } } }, "QUICKBOOKS_DOC_NUMBER_COLLISION"],
    [{ query: {} }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ query: { QueryResponse: {}, Fault: { Error: "synthetic secret" } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ query: { QueryResponse: { UnexpectedInvoice: [{ Id: "unexpected" }] } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ query: { QueryResponse: { Invoice: null } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ query: { QueryResponse: { Invoice: [{}] } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ query: { QueryResponse: { Invoice: [], maxResults: 1 } } }, "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID"],
    [{ failureAt: "query" }, "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE"],
    [{ failureAt: "query", failureStatus: 503 }, "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE"],
  ];
  for (const [scenario, code] of cases) {
    const calls = provider(t, scenario);
    await assert.rejects(createQuickBooksInvoice(env, realm, token, payload), { code, ambiguous: false });
    assert.equal(calls.length, 2);
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
    t.mock.restoreAll();
  }
});

test("invalid document numbers fail before provider reads and empty explicit query counts are valid", async (t) => {
  const calls = provider(t, { query: { QueryResponse: { Invoice: [], totalCount: 0, maxResults: 0 } } });
  for (const DocNumber of [undefined, "", " ", "x".repeat(22)]) {
    await assert.rejects(createQuickBooksInvoice(env, realm, token, { ...payload, DocNumber }), { code: "QUICKBOOKS_NUMBERING_PREFLIGHT_INVALID" });
  }
  assert.equal(calls.length, 0);
  await createQuickBooksInvoice(env, realm, token, payload);
  assert.equal(calls.length, 3);
});

test("401 preflight errors preserve credential refresh classification without a CREATE", async (t) => {
  for (const failureAt of ["preferences", "query"] as const) {
    const calls = provider(t, { failureAt, failureStatus: 401 });
    await assert.rejects(createQuickBooksInvoice(env, realm, token, payload), { code: "QUICKBOOKS_HTTP_401", statusCode: 401, ambiguous: false });
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
    t.mock.restoreAll();
  }
});

test("network and HTTP503 failures after CREATE keep the existing uncertain-write classification", async (t) => {
  for (const failureStatus of [undefined, 503]) {
    const calls = provider(t, { failureAt: "create", failureStatus });
    await assert.rejects(createQuickBooksInvoice(env, realm, token, payload), (error) => error instanceof QuickBooksProviderError && error.ambiguous);
    assert.equal(calls.filter(({ init }) => init?.method === "POST").length, 1);
    t.mock.restoreAll();
  }
});

test("pre-CREATE retry codes never bypass retained identity or ambiguity fences", () => {
  const operation = { status: "FAILED", providerInvoiceId: null, providerSyncToken: null, providerInvoiceLink: null,
    providerBalance: null, succeededAtUtc: null, lastReconciledAtUtc: null, claimExpiresAtUtc: null,
    lastFailureCode: "QUICKBOOKS_CUSTOM_NUMBERING_REQUIRED" } as QuickBooksInvoiceOperationPublic;
  assert.equal(quickBooksInvoiceRetryAvailable(operation), true);
  for (const fence of [
    { providerInvoiceId: "retained" }, { providerSyncToken: "0" }, { providerInvoiceLink: "retained" }, { providerBalance: 0 },
    { succeededAtUtc: new Date() }, { lastReconciledAtUtc: new Date() }, { claimExpiresAtUtc: new Date() },
    { status: "RECONCILIATION_REQUIRED" }, { lastFailureCode: "QUICKBOOKS_MUTATION_RESULT_UNKNOWN" },
  ]) assert.equal(quickBooksInvoiceRetryAvailable({ ...operation, ...fence } as QuickBooksInvoiceOperationPublic), false);
  assert.equal(quickBooksInvoicePrecreateFailureMessage("arbitrary-provider-secret"), null);
});

test("awaited final fence runs after reads and denial never reaches POST", async (t) => {
  const calls = provider(t);
  let release!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const attempt = control(async () => { entered(); await blocked; throw new Error("stale synthetic state"); });
  const writing = createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt);
  await entering;
  assert.equal(calls.length, 2);
  release();
  await assert.rejects(writing);
  assert.equal(calls.length, 2);
  assert.equal(attempt.postAttempted, false);
});

test("maximum configured timeout/retries remain inside one 20-second numbering budget", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (timeout: number) => { timeouts.push(timeout); return new AbortController().signal; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    now += 20_000;
    throw new Error("synthetic network timeout");
  });
  const attempt = control();
  await assert.rejects(createInvoice({ ...env, QUICKBOOKS_PROVIDER_TIMEOUT_MS: 30_000, QUICKBOOKS_PROVIDER_READ_RETRIES: 3 },
    realm, token, payload, attempt.providerRequestId, attempt), { code: "QUICKBOOKS_NUMBERING_PREFLIGHT_UNAVAILABLE" });
  assert.deepEqual(timeouts, [20_000]);
  assert.equal(calls, 1);
  assert.equal(attempt.postAttempted, false);
});

test("deferred query cannot consume the POST and identity-bind reservation", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let posts = 0;
  let fences = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preferences")) return new Response(JSON.stringify(enabled));
    if (init?.method === "POST") { posts++; return new Response(JSON.stringify({ Invoice: { Id: "created" } })); }
    now += 5_000;
    return new Response(JSON.stringify({ QueryResponse: {} }));
  });
  const attempt = control(async () => { fences++; }, now + 25_000);
  await assert.rejects(createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt), { code: "QUICKBOOKS_PUBLISH_DEADLINE" });
  assert.equal(fences, 1);
  assert.equal(posts, 0);
});

test("preflight 401 replay shares the original deadline and writes once after a fresh fence", async (t) => {
  let calls = 0;
  let posts = 0;
  let fences = 0;
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls++;
    if (calls === 1) return new Response("", { status: 401 });
    if (url.endsWith("/preferences")) return new Response(JSON.stringify(enabled));
    if (init?.method === "POST") { posts++; bodies.push(String(init.body)); return new Response(JSON.stringify({ Invoice: { Id: "created" } })); }
    return new Response(JSON.stringify({ QueryResponse: {} }));
  });
  const attempt = control(async () => { fences++; });
  const originalDeadline = attempt.numberingDeadlineAtMs;
  await assert.rejects(createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt), { statusCode: 401 });
  await createInvoice(env, realm, "refreshed-token", payload, attempt.providerRequestId, attempt);
  assert.equal(attempt.numberingDeadlineAtMs, originalDeadline);
  assert.equal(posts, 1); assert.equal(fences, 1);
  assert.deepEqual(bodies, [JSON.stringify(payload)]);
});

test("POST 401 then a denied replay fence remains uncertain and never posts twice", async (t) => {
  let posts = 0;
  let fences = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preferences")) return new Response(JSON.stringify(enabled));
    if (init?.method === "POST") { posts++; return new Response("", { status: 401 }); }
    return new Response(JSON.stringify({ QueryResponse: {} }));
  });
  const attempt = control(async () => { if (++fences === 2) throw new Error("stale synthetic claim"); });
  await assert.rejects(createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt), { statusCode: 401 });
  await assert.rejects(createInvoice(env, realm, "refreshed-token", payload, attempt.providerRequestId, attempt), (error) => {
    assert.deepEqual(classifyQuickBooksInvoiceWriteFailure(error, attempt), { code: "QUICKBOOKS_MUTATION_RESULT_UNKNOWN", ambiguous: true });
    return true;
  });
  assert.equal(posts, 1); assert.equal(fences, 2);
});

test("POST 401 then expired numbering budget cannot become safe prewrite failure", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const calls = provider(t, { failureAt: "create", failureStatus: 401 });
  const attempt = control();
  await assert.rejects(createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt), { statusCode: 401 });
  now += 20_001;
  await assert.rejects(createInvoice(env, realm, "refreshed-token", payload, attempt.providerRequestId, attempt), (error) => {
    assert.deepEqual(classifyQuickBooksInvoiceWriteFailure(error, attempt), { code: "QUICKBOOKS_MUTATION_RESULT_UNKNOWN", ambiguous: true });
    return true;
  });
  assert.equal(calls.length, 3);
  assert.equal(attempt.postAttempted, true);
});

test("oversized CREATE identities fail as ambiguous instead of reaching persistence", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(JSON.stringify(
    url.endsWith("/preferences") ? enabled : url.includes("/query?") ? { QueryResponse: {} } : { Invoice: { Id: "x".repeat(192) } },
  )));
  const attempt = control();
  await assert.rejects(createInvoice(env, realm, token, payload, attempt.providerRequestId, attempt), (error) => {
    assert.deepEqual(classifyQuickBooksInvoiceWriteFailure(error, attempt), { code: "QUICKBOOKS_MUTATION_RESULT_UNKNOWN", ambiguous: true });
    return true;
  });
});
