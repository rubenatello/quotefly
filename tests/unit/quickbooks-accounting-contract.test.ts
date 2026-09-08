import assert from "node:assert/strict";
import { before, test } from "node:test";

const JWT_SECRET = "quickbooks-accounting-contract-jwt-secret-long-enough";
const ACCOUNTING_TOKEN = "accounting-contract-access-token";
const REALM_ID = "123456789";

let parseEnv: typeof import("../../src/config/env.js").parseEnv;
let quickBooks: typeof import("../../src/services/quickbooks.js");

type RuntimeEnv = ReturnType<typeof runtimeEnv>;
type CapturedRequest = {
  url: URL;
  init: RequestInit;
  headers: Headers;
};

before(async () => {
  process.env.DATABASE_URL ||= "postgresql://unit:unit@127.0.0.1:1/quotefly_unit";
  process.env.JWT_SECRET ||= JWT_SECRET;
  ({ parseEnv } = await import("../../src/config/env.js"));
  quickBooks = await import("../../src/services/quickbooks.js");
});

function runtimeEnv(environment: "sandbox" | "production" = "sandbox") {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/quotefly_unit",
    JWT_SECRET,
    QUICKBOOKS_ENVIRONMENT: environment,
    QUICKBOOKS_CLIENT_ID: "quickbooks-contract-client",
    QUICKBOOKS_CLIENT_SECRET: "quickbooks-contract-secret",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "quickbooks-accounting-contract-key-000001",
    QUICKBOOKS_PROVIDER_READ_RETRIES: "1",
    QUICKBOOKS_PROVIDER_TIMEOUT_MS: "1000",
  });
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

function customer() {
  return { Id: "customer-1", DisplayName: "Contract Customer", Active: true, futureCustomerField: "accepted" };
}

function item() {
  return { Id: "item-1", Name: "Contract Item", Active: true, Type: "Service", futureItemField: "accepted" };
}

function invoice() {
  return {
    Id: "invoice-1",
    CustomerRef: { value: "customer-1", futureRefField: "accepted" },
    TotalAmt: 10,
    Balance: 10,
    futureInvoiceField: "accepted",
  };
}

function payment() {
  return { Id: "payment-1", TotalAmt: 10, futurePaymentField: "accepted" };
}

function refundReceipt() {
  return {
    Id: "refund-1",
    TotalAmt: 10,
    CustomerRef: { value: "customer-1" },
    LinkedTxn: [{ TxnId: "payment-1", TxnType: "Payment" }],
    futureRefundField: "accepted",
  };
}

function queryResponse(query: string): Response {
  const entityName = query.includes("Customer")
    ? "Customer"
    : query.includes("Item")
      ? "Item"
      : query.includes("Account")
        ? "Account"
        : "Invoice";
  const entity = entityName === "Customer"
    ? customer()
    : entityName === "Item"
      ? item()
      : entityName === "Account"
        ? { Id: "income-1", Name: "Services", futureAccountField: "accepted" }
        : invoice();
  return jsonResponse({ QueryResponse: { [entityName]: [entity] } });
}

function representativeAccountingResponse(request: CapturedRequest): Response {
  const { pathname } = request.url;
  if (pathname.endsWith("/query")) return queryResponse(String(request.init.body ?? ""));
  if (pathname.includes("/companyinfo/")) {
    return jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "QuoteFly Contract", futureCompanyField: "accepted" } });
  }
  if (pathname.endsWith("/cdc")) {
    return jsonResponse({
      CDCResponse: [{
        QueryResponse: [{ Invoice: [invoice()], Payment: [payment()], RefundReceipt: [refundReceipt()] }],
        time: "2026-09-08T20:00:00.000Z",
      }],
    });
  }
  if (pathname.includes("/refundreceipt/")) return jsonResponse({ RefundReceipt: refundReceipt() });
  if (pathname.includes("/payment/")) return jsonResponse({ Payment: payment() });
  if (pathname.includes("/customer")) return jsonResponse({ Customer: customer() });
  if (pathname.includes("/item")) return jsonResponse({ Item: item() });
  return jsonResponse({ Invoice: invoice() });
}

async function captureFetch<T>(
  respond: (request: CapturedRequest, callIndex: number) => Response | Promise<Response>,
  operation: () => Promise<T>,
): Promise<{ result: T; calls: CapturedRequest[] }> {
  const originalFetch = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const request: CapturedRequest = {
      url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
      init,
      headers: new Headers(init.headers),
    };
    calls.push(request);
    return respond(request, calls.length);
  };
  try {
    return { result: await operation(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function exerciseEveryAccountingTransport(runtime: RuntimeEnv) {
  await quickBooks.queryQuickBooksEntity(runtime, REALM_ID, ACCOUNTING_TOKEN, "SELECT * FROM Customer", "Customer");
  await quickBooks.findQuickBooksCustomerByDisplayName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Customer");
  await quickBooks.createQuickBooksCustomer(runtime, REALM_ID, ACCOUNTING_TOKEN, {
    displayName: "Contract Customer",
    email: "customer@example.test",
    phone: "555-0100",
  });
  await quickBooks.findQuickBooksItemByName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Item");
  await quickBooks.resolveQuickBooksIncomeAccount(runtime, REALM_ID, ACCOUNTING_TOKEN);
  await quickBooks.createQuickBooksServiceItem(runtime, REALM_ID, ACCOUNTING_TOKEN, {
    name: "Contract Item",
    description: "Representative synthetic item",
    unitPrice: 10,
    incomeAccountRef: { value: "income-1" },
  });
  await quickBooks.createQuickBooksInvoice(
    runtime,
    REALM_ID,
    ACCOUNTING_TOKEN,
    { CustomerRef: { value: "customer-1" }, Line: [] },
    "request id / preserved",
  );
  await quickBooks.findQuickBooksInvoicesByDocNumber(runtime, REALM_ID, ACCOUNTING_TOKEN, "INV-' 1");
  await quickBooks.fetchQuickBooksInvoice(runtime, REALM_ID, ACCOUNTING_TOKEN, "invoice/with spaces");
  await quickBooks.fetchQuickBooksPayment(runtime, REALM_ID, ACCOUNTING_TOKEN, "payment/with spaces");
  await quickBooks.fetchQuickBooksRefundReceipt(runtime, REALM_ID, ACCOUNTING_TOKEN, "refund/with spaces");
  await quickBooks.fetchQuickBooksCustomer(runtime, REALM_ID, ACCOUNTING_TOKEN, "customer/with spaces");
  await quickBooks.fetchQuickBooksItem(runtime, REALM_ID, ACCOUNTING_TOKEN, "item/with spaces");
  await quickBooks.searchQuickBooksCustomers(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract", 5);
  await quickBooks.searchQuickBooksItems(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract", 5);
  await quickBooks.fetchQuickBooksCdc(runtime, REALM_ID, ACCOUNTING_TOKEN, new Date("2026-09-08T20:00:00.000Z"));
  await quickBooks.fetchQuickBooksCompanyInfo(runtime, REALM_ID, ACCOUNTING_TOKEN);
}

test("QBO-API-CONTRACT-75 appends exactly one minorversion=75 to every Accounting transport in sandbox and production", async () => {
  assert.equal(quickBooks.QUICKBOOKS_ACCOUNTING_MINOR_VERSION, "75");

  for (const environment of ["sandbox", "production"] as const) {
    const expectedOrigin = environment === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";
    const { calls } = await captureFetch(representativeAccountingResponse, async () => {
      await exerciseEveryAccountingTransport(runtimeEnv(environment));
    });

    assert.ok(calls.length >= 17, `expected all public Accounting entry points for ${environment}`);
    for (const { url, headers } of calls) {
      assert.equal(url.origin, expectedOrigin);
      assert.deepEqual(url.searchParams.getAll("minorversion"), ["75"]);
      assert.equal(headers.get("authorization"), `Bearer ${ACCOUNTING_TOKEN}`);
      assert.equal(headers.get("accept"), "application/json");
    }

    for (const encodedEntityPath of [
      "/invoice/invoice%2Fwith%20spaces",
      "/payment/payment%2Fwith%20spaces",
      "/refundreceipt/refund%2Fwith%20spaces",
      "/customer/customer%2Fwith%20spaces",
      "/item/item%2Fwith%20spaces",
    ]) {
      assert.equal(calls.some(({ url }) => url.pathname.endsWith(encodedEntityPath)), true);
    }

    const queryCalls = calls.filter(({ url }) => url.pathname.endsWith("/query"));
    assert.ok(queryCalls.length >= 7);
    for (const request of queryCalls) {
      assert.equal(request.init.method, "POST");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCOUNTING_TOKEN}`);
      assert.equal(request.headers.get("accept"), "application/json");
      assert.equal(request.headers.get("content-type"), "application/text");
      assert.match(String(request.init.body), /^SELECT /);
    }

    const createdInvoice = calls.find(({ url, init }) => url.pathname.endsWith("/invoice") && init.method === "POST");
    assert.ok(createdInvoice);
    assert.equal(createdInvoice.url.searchParams.get("requestid"), "request id / preserved");
    assert.deepEqual(JSON.parse(String(createdInvoice.init.body)), { CustomerRef: { value: "customer-1" }, Line: [] });
    assert.equal(createdInvoice.headers.get("content-type"), "application/json");

    const fetchedInvoice = calls.find(({ url }) => url.pathname.endsWith("/invoice/invoice%2Fwith%20spaces"));
    assert.ok(fetchedInvoice);
    assert.equal(fetchedInvoice.url.searchParams.get("include"), "invoiceLink");

    const cdc = calls.find(({ url }) => url.pathname.endsWith("/cdc"));
    assert.ok(cdc);
    assert.equal(cdc.url.searchParams.get("entities"), "Invoice,Payment,RefundReceipt");
    assert.equal(cdc.url.searchParams.get("changedSince"), "2026-09-08T20:00:00.000Z");
  }
});

test("QBO-API-CONTRACT-75 keeps read retry behavior and prevents mutation retries while retaining minorversion=75", async () => {
  const runtime = runtimeEnv();
  const retried = await captureFetch((request, callIndex) => {
    if (callIndex === 1) return jsonResponse({}, 429, { "retry-after": "0" });
    return representativeAccountingResponse(request);
  }, () => quickBooks.fetchQuickBooksCompanyInfo(runtime, REALM_ID, ACCOUNTING_TOKEN));
  assert.equal(retried.calls.length, 2);
  assert.equal(retried.calls[0]?.url.href, retried.calls[1]?.url.href);
  assert.deepEqual(retried.calls[0]?.url.searchParams.getAll("minorversion"), ["75"]);

  const failedMutation = await captureFetch(() => jsonResponse({}, 503), async () => {
    await assert.rejects(
      () => quickBooks.createQuickBooksInvoice(runtime, REALM_ID, ACCOUNTING_TOKEN, { Line: [] }),
      (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_HTTP_503",
    );
  });
  assert.equal(failedMutation.calls.length, 1);
  assert.deepEqual(failedMutation.calls[0]?.url.searchParams.getAll("minorversion"), ["75"]);
});

test("QBO-API-CONTRACT-75 keeps OAuth token exchange, refresh, and revoke outside the Accounting minor-version contract", async () => {
  const runtime = runtimeEnv();
  const { calls } = await captureFetch((request) => {
    if (request.url.hostname === "oauth.platform.intuit.com") {
      return jsonResponse({
        access_token: "replacement-access-token",
        refresh_token: "replacement-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 200 });
  }, async () => {
    await quickBooks.exchangeQuickBooksAuthorizationCode(runtime, "authorization-code");
    await quickBooks.refreshQuickBooksAccessToken(runtime, "refresh-token");
    await quickBooks.revokeQuickBooksToken(runtime, "refresh-token");
  });

  assert.equal(calls.length, 3);
  for (const { url } of calls) {
    assert.equal(url.searchParams.has("minorversion"), false);
    assert.ok(
      url.origin === "https://oauth.platform.intuit.com" || url.origin === "https://developer.api.intuit.com",
    );
  }
});

test("QBO-API-CONTRACT-75 accepts additive provider fields but closes malformed known Accounting entities", async () => {
  const runtime = runtimeEnv();
  await captureFetch(representativeAccountingResponse, async () => {
    await assert.doesNotReject(() => exerciseEveryAccountingTransport(runtime));
  });

  const malformedCases: Array<{
    payload: unknown;
    code: string;
    operation: () => Promise<unknown>;
  }> = [
    { payload: { Invoice: { Id: 42 } }, code: "QUICKBOOKS_INVOICE_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksInvoice(runtime, REALM_ID, ACCOUNTING_TOKEN, "invoice") },
    { payload: { Payment: { Id: 42 } }, code: "QUICKBOOKS_PAYMENT_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksPayment(runtime, REALM_ID, ACCOUNTING_TOKEN, "payment") },
    { payload: { RefundReceipt: { Id: "refund" } }, code: "QUICKBOOKS_REFUND_RECEIPT_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksRefundReceipt(runtime, REALM_ID, ACCOUNTING_TOKEN, "refund") },
    { payload: { Customer: { Id: 42 } }, code: "QUICKBOOKS_CUSTOMER_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksCustomer(runtime, REALM_ID, ACCOUNTING_TOKEN, "customer") },
    { payload: { Item: { Id: 42 } }, code: "QUICKBOOKS_ITEM_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksItem(runtime, REALM_ID, ACCOUNTING_TOKEN, "item") },
    { payload: { CompanyInfo: { Id: 42, CompanyName: "Malformed" } }, code: "QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksCompanyInfo(runtime, REALM_ID, ACCOUNTING_TOKEN) },
    { payload: { CDCResponse: "wrong" }, code: "QUICKBOOKS_CDC_RESPONSE_INVALID", operation: () => quickBooks.fetchQuickBooksCdc(runtime, REALM_ID, ACCOUNTING_TOKEN, new Date("2026-09-08T20:00:00.000Z")) },
    { payload: { QueryResponse: { Customer: [{ Id: 42 }] } }, code: "QUICKBOOKS_CUSTOMER_QUERY_RESPONSE_INVALID", operation: () => quickBooks.searchQuickBooksCustomers(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract", 5) },
  ];
  for (const fixture of malformedCases) {
    await captureFetch(() => jsonResponse(fixture.payload), async () => {
      await assert.rejects(fixture.operation, (error: unknown) => (error as { code?: unknown }).code === fixture.code);
    });
  }
});

test("QBO-API-CONTRACT-75 validates query envelopes and normalizes malformed CompanyInfo JSON to stable provider codes", async () => {
  const runtime = runtimeEnv();
  for (const payload of [{}, { QueryResponse: [] }, { QueryResponse: { Customer: {} } }]) {
    await captureFetch(() => jsonResponse(payload), async () => {
      await assert.rejects(
        () => quickBooks.queryQuickBooksEntity(runtime, REALM_ID, ACCOUNTING_TOKEN, "SELECT * FROM Customer", "Customer"),
        (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_QUERY_RESPONSE_INVALID",
      );
    });
  }

  const validEmpty = await captureFetch(() => jsonResponse({ QueryResponse: {} }), () =>
    quickBooks.queryQuickBooksEntity(runtime, REALM_ID, ACCOUNTING_TOKEN, "SELECT * FROM Customer", "Customer"),
  );
  assert.deepEqual(validEmpty.result, []);

  await captureFetch(() => new Response("not JSON", { status: 200, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(
      () => quickBooks.fetchQuickBooksCompanyInfo(runtime, REALM_ID, ACCOUNTING_TOKEN),
      (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID",
    );
  });
});

test("QBO-API-CONTRACT-75 rejects present but malformed legacy query entries without treating them as empty", async () => {
  const runtime = runtimeEnv();
  for (const malformedEntry of [null, false, 0, ""]) {
    await captureFetch(() => jsonResponse({ QueryResponse: { Customer: [malformedEntry] } }), async () => {
      await assert.rejects(
        () => quickBooks.findQuickBooksCustomerByDisplayName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Customer"),
        (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_CUSTOMER_QUERY_RESPONSE_INVALID",
      );
    });
    await captureFetch(() => jsonResponse({ QueryResponse: { Item: [malformedEntry] } }), async () => {
      await assert.rejects(
        () => quickBooks.findQuickBooksItemByName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Item"),
        (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_ITEM_QUERY_RESPONSE_INVALID",
      );
    });
    const malformedPreferredAccount = await captureFetch(
      () => jsonResponse({ QueryResponse: { Account: [malformedEntry] } }),
      async () => {
        await assert.rejects(
          () => quickBooks.resolveQuickBooksIncomeAccount(runtime, REALM_ID, ACCOUNTING_TOKEN),
          (error: unknown) => (error as { code?: unknown }).code === "QUICKBOOKS_QUERY_RESPONSE_INVALID",
        );
      },
    );
    assert.equal(malformedPreferredAccount.calls.length, 1, "a malformed preferred account must not trigger fallback");
  }
});

test("QBO-API-CONTRACT-75 preserves legitimate empty legacy query semantics", async () => {
  const runtime = runtimeEnv();
  const emptyCustomer = await captureFetch(
    () => jsonResponse({ QueryResponse: { Customer: [] } }),
    () => quickBooks.findQuickBooksCustomerByDisplayName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Customer"),
  );
  assert.equal(emptyCustomer.result, null);
  const emptyItem = await captureFetch(
    () => jsonResponse({ QueryResponse: { Item: [] } }),
    () => quickBooks.findQuickBooksItemByName(runtime, REALM_ID, ACCOUNTING_TOKEN, "Contract Item"),
  );
  assert.equal(emptyItem.result, null);

  const fallbackAccount = await captureFetch((_, callIndex) => jsonResponse({
    QueryResponse: { Account: callIndex === 1 ? [] : [{ Id: "income-fallback", Name: "Fallback income" }] },
  }), () => quickBooks.resolveQuickBooksIncomeAccount(runtime, REALM_ID, ACCOUNTING_TOKEN));
  assert.deepEqual(fallbackAccount.result, { value: "income-fallback", name: "Fallback income" });
  assert.equal(fallbackAccount.calls.length, 2);

  const noIncomeAccount = await captureFetch(
    () => jsonResponse({ QueryResponse: { Account: [] } }),
    async () => {
      await assert.rejects(
        () => quickBooks.resolveQuickBooksIncomeAccount(runtime, REALM_ID, ACCOUNTING_TOKEN),
        /QuickBooks income account not found/,
      );
    },
  );
  assert.equal(noIncomeAccount.calls.length, 2);
});
