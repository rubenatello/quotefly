import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";
import {
  fetchQuickBooksCanonicalTaxEstimate,
  fetchQuickBooksCanonicalTaxInvoice,
  QuickBooksProviderError,
} from "../../src/services/quickbooks";
import { QuickBooksTaxCanonicalProjectionError } from "../../src/services/quickbooks-tax-provider-projections";

const env: QuickBooksCredentialRuntimeEnv = {
  QUICKBOOKS_ENVIRONMENT: "sandbox",
  QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1_000,
  QUICKBOOKS_PROVIDER_READ_RETRIES: 0,
  QUICKBOOKS_CLIENT_ID: "synthetic-client",
  QUICKBOOKS_CLIENT_SECRET: "synthetic-secret",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-key",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "",
  JWT_SECRET: "synthetic-jwt",
};
const realmId = "123456789";
const estimateId = "estimate_123";
const invoiceId = "invoice_456";
const address = {
  Line1: "100 Main Street", Line2: "Suite 2", City: "Austin",
  CountrySubDivisionCode: "TX", PostalCode: "78701", Country: "US",
  Id: "provider-address-field-is-stripped",
};
const lines = [
  {
    Id: "provider-line-field-is-stripped",
    Description: "Synthetic service",
    DetailType: "SalesItemLineDetail",
    Amount: 100,
    SalesItemLineDetail: {
      ItemRef: { value: "item_1", name: "private provider label is stripped" },
      Qty: 2,
      UnitPrice: 50,
      TaxCodeRef: { value: "TAX", name: "Tax" },
    },
  },
  { DetailType: "SubTotalLineDetail", Amount: 100, SubTotalLineDetail: {} },
];

function common(id: string) {
  return {
    Id: id,
    SyncToken: "0",
    MetaData: { LastUpdatedTime: "2026-10-03T12:34:56.123-07:00", CreateTime: "private-stripped" },
    CustomerRef: { value: "customer_1", name: "private provider label is stripped" },
    TxnDate: "2026-10-03",
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    ShipFromAddr: address,
    ShipAddr: address,
    Line: lines,
    TxnTaxDetail: { TotalTax: 8.25, TaxLine: [{ private: true }] },
    TotalAmt: 108.25,
    PrivateNote: "private provider content is stripped",
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    ...common(invoiceId),
    EmailStatus: "NotSet",
    AllowOnlineACHPayment: false,
    AllowOnlineCreditCardPayment: false,
    AllowOnlinePayPalPayment: false,
    AllowOnlineAffirmPayment: false,
    AllowOnlinePayment: false,
    LinkedTxn: [{ TxnId: estimateId, TxnType: "Estimate", private: "stripped" }],
    ...overrides,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { status: 200, ...init });
}

function provider(t: TestContext, response: () => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: new URL(url), init });
    return response();
  });
  return calls;
}

test("canonical Estimate GET is bounded, GET-only, stripped, normalized and deeply frozen", async (t) => {
  const calls = provider(t, () => jsonResponse({ Estimate: common(estimateId), time: "private envelope field" }));
  const result = await fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.pathname, `/v3/company/${realmId}/estimate/${estimateId}`);
  assert.equal(calls[0]?.init?.method ?? "GET", "GET");
  assert.equal(calls[0]?.init?.redirect, "error");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer synthetic-token");
  assert.equal(result.MetaData.LastUpdatedTime, "2026-10-03T19:34:56.123Z");
  assert.equal(result.Line.length, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "CurrencyRef", "CustomerRef", "Id", "Line", "MetaData", "ShipAddr", "ShipFromAddr",
    "SyncToken", "TotalAmt", "TxnDate", "TxnTaxDetail",
  ].sort());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.Line), true);
  assert.equal(Object.isFrozen(result.Line[0]!.SalesItemLineDetail), true);
});

test("canonical Invoice GET requires the exact Estimate link and fail-closed delivery flags", async (t) => {
  const calls = provider(t, () => jsonResponse({ Invoice: invoice() }));
  const result = await fetchQuickBooksCanonicalTaxInvoice(env, realmId, "synthetic-token", invoiceId,
    { deadlineAtMs: Date.now() + 5_000, expectedEstimateId: estimateId });
  assert.deepEqual(result.LinkedTxn, [{ TxnId: estimateId, TxnType: "Estimate" }]);
  assert.equal("EmailStatus" in result, false);
  assert.equal("AllowOnlineACHPayment" in result, false);
  assert.equal(calls.some(({ init }) => (init?.method ?? "GET") !== "GET"), false);

  for (const unsafe of [
    { EmailStatus: "EmailSent" },
    { EmailStatus: undefined },
    { AllowOnlineACHPayment: true },
    { AllowOnlineCreditCardPayment: undefined },
    { AllowOnlinePayPalPayment: true },
    { AllowOnlineAffirmPayment: undefined },
    { AllowOnlinePayment: true },
    { AllowIPNPayment: true },
  ]) {
    t.mock.restoreAll();
    provider(t, () => jsonResponse({ Invoice: invoice(unsafe) }));
    await assert.rejects(fetchQuickBooksCanonicalTaxInvoice(env, realmId, "synthetic-token", invoiceId,
      { deadlineAtMs: Date.now() + 5_000, expectedEstimateId: estimateId }),
    (error: unknown) => error instanceof QuickBooksTaxCanonicalProjectionError
      && error.code === "QUICKBOOKS_TAX_CANONICAL_DELIVERY_UNSAFE");
  }

  t.mock.restoreAll();
  provider(t, () => jsonResponse({ Invoice: invoice({ AllowOnlinePayment: undefined }) }));
  await fetchQuickBooksCanonicalTaxInvoice(env, realmId, "synthetic-token", invoiceId,
    { deadlineAtMs: Date.now() + 5_000, expectedEstimateId: estimateId });
  t.mock.restoreAll();
  provider(t, () => jsonResponse({ Invoice: invoice({ AllowIPNPayment: false }) }));
  await fetchQuickBooksCanonicalTaxInvoice(env, realmId, "synthetic-token", invoiceId,
    { deadlineAtMs: Date.now() + 5_000, expectedEstimateId: estimateId });
});

test("canonical projections reject identity, link, unsupported lines and inexact arithmetic", async (t) => {
  const cases: Array<[unknown, string]> = [
    [{ Invoice: invoice({ Id: "another_invoice" }) }, "QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID"],
    [{ Invoice: invoice({ LinkedTxn: [] }) }, "QUICKBOOKS_TAX_CANONICAL_LINK_INVALID"],
    [{ Invoice: invoice({ LinkedTxn: [{ TxnId: "another_estimate", TxnType: "Estimate" }] }) }, "QUICKBOOKS_TAX_CANONICAL_LINK_INVALID"],
    [{ Invoice: invoice({ LinkedTxn: [{ TxnId: estimateId, TxnType: "Estimate" }, { TxnId: "x", TxnType: "Payment" }] }) }, "QUICKBOOKS_TAX_CANONICAL_LINK_INVALID"],
    [{ Invoice: invoice({ Line: [{ DetailType: "DiscountLineDetail", Amount: 1, DiscountLineDetail: {} }] }) }, "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"],
    [{ Invoice: invoice({ Line: [{ ...lines[0], Amount: 99 }] }) }, "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"],
    [{ Invoice: invoice({ TotalAmt: 108.251 }) }, "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"],
    [{ Invoice: invoice({ TotalAmt: 108.24 }) }, "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"],
    [{ Invoice: invoice({ SyncToken: "01" }) }, "QUICKBOOKS_TAX_CANONICAL_RESPONSE_INVALID"],
    [{ Invoice: invoice({ MetaData: { LastUpdatedTime: "not-a-timestamp" } }) }, "QUICKBOOKS_TAX_CANONICAL_IDENTITY_INVALID"],
  ];
  for (const [payload, code] of cases) {
    const calls = provider(t, () => jsonResponse(payload));
    await assert.rejects(fetchQuickBooksCanonicalTaxInvoice(env, realmId, "synthetic-token", invoiceId,
      { deadlineAtMs: Date.now() + 5_000, expectedEstimateId: estimateId }),
    (error: unknown) => error instanceof QuickBooksTaxCanonicalProjectionError && error.code === code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method ?? "GET", "GET");
    t.mock.restoreAll();
  }
});

test("canonical line arithmetic uses exact cents and the reviewed half-up quantity multiplication", async (t) => {
  provider(t, () => jsonResponse({ Estimate: {
    ...common(estimateId),
    Line: [{
      Description: "Fractional synthetic service", DetailType: "SalesItemLineDetail", Amount: 1.56,
      SalesItemLineDetail: {
        ItemRef: { value: "item_1" }, Qty: 1.25, UnitPrice: 1.25, TaxCodeRef: { value: "TAX" },
      },
    }],
    TxnTaxDetail: { TotalTax: 0.13 }, TotalAmt: 1.69,
  } }));
  const result = await fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 });
  assert.equal(result.Line[0]?.Amount, 1.56);
  assert.equal(result.TotalAmt, 1.69);
});

test("canonical GET rejects declared and streamed bodies above 512 KiB", async (t) => {
  provider(t, () => new Response("{}", { status: 200, headers: { "content-length": String(512 * 1024 + 1) } }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 }),
  (error: unknown) => error instanceof QuickBooksProviderError && error.code === "QUICKBOOKS_RESPONSE_TOO_LARGE");

  t.mock.restoreAll();
  const first = new Uint8Array(400 * 1024);
  const second = new Uint8Array(113 * 1024);
  provider(t, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(first); controller.enqueue(second); controller.close(); },
  }), { status: 200 }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 }),
  (error: unknown) => error instanceof QuickBooksProviderError && error.code === "QUICKBOOKS_RESPONSE_TOO_LARGE");
});

test("canonical GET rejects empty/malformed bodies, redirects, invalid IDs and expired deadlines without POST", async (t) => {
  const malformed = provider(t, () => new Response("not-json", { status: 200 }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 }), { code: "QUICKBOOKS_RESPONSE_INVALID" });
  assert.equal(malformed[0]?.init?.method ?? "GET", "GET");

  t.mock.restoreAll();
  provider(t, () => new Response(null, { status: 200 }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 }), { code: "QUICKBOOKS_RESPONSE_INVALID" });

  t.mock.restoreAll();
  const redirectCalls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    redirectCalls.push(init ?? {});
    throw new TypeError("redirect blocked");
  });
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 }), { code: "QUICKBOOKS_READ_TIMEOUT" });
  assert.equal(redirectCalls[0]?.redirect, "error");

  t.mock.restoreAll();
  const noCalls = provider(t, () => jsonResponse({ Estimate: common(estimateId) }));
  for (const [realm, entity, deadline] of [
    ["bad/realm", estimateId, Date.now() + 5_000],
    [realmId, "bad/id", Date.now() + 5_000],
    [realmId, estimateId, Date.now() - 1],
  ] as const) {
    await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realm, "synthetic-token", entity,
      { deadlineAtMs: deadline }), { code: "QUICKBOOKS_TAX_CANONICAL_READ_INPUT_INVALID" });
  }
  assert.equal(noCalls.length, 0);
});

test("one deadline covers response streaming", async (t) => {
  let cancelled = false;
  provider(t, () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (cancelled) return;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ Estimate: common(estimateId) })));
      controller.close();
    },
    cancel() { cancelled = true; },
  }), { status: 200 }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5 }), { code: "QUICKBOOKS_READ_DEADLINE" });
});

test("canonical deadline bounds a stream that never supplies a body and whose cancellation stalls", { timeout: 2_000 }, async (t) => {
  let cancellations = 0;
  provider(t, () => new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancellations += 1; return new Promise<void>(() => {}); },
  }), { status: 200 }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 25 }), { code: "QUICKBOOKS_READ_DEADLINE" });
  assert.equal(cancellations, 1);
});

test("declared oversized bodies cannot stall rejection through cancellation", { timeout: 2_000 }, async (t) => {
  let cancellations = 0;
  provider(t, () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancellations += 1; return new Promise<void>(() => {}); },
  }), { status: 200, headers: { "content-length": String(512 * 1024 + 1) } }));
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(env, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 25 }), { code: "QUICKBOOKS_RESPONSE_TOO_LARGE" });
  assert.equal(cancellations, 1);
});

test("canonical retry cleanup cannot exceed the caller's deadline", { timeout: 2_000 }, async (t) => {
  let calls = 0;
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(new ReadableStream<Uint8Array>({
      cancel() { cancellations += 1; return new Promise<void>(() => {}); },
    }), { status: 503, headers: { "retry-after": "0" } });
  });
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate({ ...env, QUICKBOOKS_PROVIDER_READ_RETRIES: 1 },
    realmId, "synthetic-token", estimateId, { deadlineAtMs: Date.now() + 25 }),
  { code: "QUICKBOOKS_READ_DEADLINE" });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
});

test("canonical reads retry only transient GETs within the caller's one deadline", async (t) => {
  const retryEnv = { ...env, QUICKBOOKS_PROVIDER_READ_RETRIES: 1 };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.method ?? "GET", "GET");
    return calls === 1
      ? new Response("{}", { status: 503, headers: { "retry-after": "0" } })
      : jsonResponse({ Estimate: common(estimateId) });
  });
  await fetchQuickBooksCanonicalTaxEstimate(retryEnv, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 5_000 });
  assert.equal(calls, 2);

  t.mock.restoreAll();
  calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.method ?? "GET", "GET");
    return new Response("{}", { status: 503, headers: { "retry-after": "2" } });
  });
  await assert.rejects(fetchQuickBooksCanonicalTaxEstimate(retryEnv, realmId, "synthetic-token", estimateId,
    { deadlineAtMs: Date.now() + 20 }), { code: "QUICKBOOKS_READ_DEADLINE" });
  assert.equal(calls, 1);
});
