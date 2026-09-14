import { createCipheriv, createHash, randomBytes } from "crypto";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

const JWT_SECRET = "quickbooks-unit-jwt-secret-that-is-long-enough";
const CURRENT_KEY = "quickbooks-current-token-key-000000000001";
const PREVIOUS_KEY = "quickbooks-previous-token-key-00000000001";

let parseEnv: typeof import("../../src/config/env.js").parseEnv;
let decryptQuickBooksSecret: typeof import("../../src/services/quickbooks.js").decryptQuickBooksSecret;
let encryptQuickBooksSecret: typeof import("../../src/services/quickbooks.js").encryptQuickBooksSecret;
let decryptQuickBooksHostedPaymentLink: typeof import("../../src/services/quickbooks.js").decryptQuickBooksHostedPaymentLink;
let encryptQuickBooksHostedPaymentLink: typeof import("../../src/services/quickbooks.js").encryptQuickBooksHostedPaymentLink;
let createSignedQuickBooksState: typeof import("../../src/services/quickbooks.js").createSignedQuickBooksState;
let verifySignedQuickBooksState: typeof import("../../src/services/quickbooks.js").verifySignedQuickBooksState;
let fetchQuickBooksCdc: typeof import("../../src/services/quickbooks.js").fetchQuickBooksCdc;
let fetchQuickBooksCompanyInfo: typeof import("../../src/services/quickbooks.js").fetchQuickBooksCompanyInfo;
let fetchQuickBooksCustomer: typeof import("../../src/services/quickbooks.js").fetchQuickBooksCustomer;
let fetchQuickBooksInvoice: typeof import("../../src/services/quickbooks.js").fetchQuickBooksInvoice;
let fetchQuickBooksItem: typeof import("../../src/services/quickbooks.js").fetchQuickBooksItem;
let fetchQuickBooksPayment: typeof import("../../src/services/quickbooks.js").fetchQuickBooksPayment;
let fetchQuickBooksRefundReceipt: typeof import("../../src/services/quickbooks.js").fetchQuickBooksRefundReceipt;
let refreshQuickBooksAccessToken: typeof import("../../src/services/quickbooks.js").refreshQuickBooksAccessToken;
let QuickBooksProviderError: typeof import("../../src/services/quickbooks.js").QuickBooksProviderError;
let QUICKBOOKS_INVOICE_LINK_MINOR_VERSION: typeof import("../../src/services/quickbooks.js").QUICKBOOKS_INVOICE_LINK_MINOR_VERSION;
let searchQuickBooksCustomers: typeof import("../../src/services/quickbooks.js").searchQuickBooksCustomers;
let searchQuickBooksItems: typeof import("../../src/services/quickbooks.js").searchQuickBooksItems;
let classifyQuickBooksWorkerFailure: typeof import("../../src/services/quickbooks-worker-failures.js").classifyQuickBooksWorkerFailure;
let QuickBooksReconciliationError: typeof import("../../src/services/quickbooks-reconciliation.js").QuickBooksReconciliationError;
let isQuickBooksReauthorizationError: typeof import("../../src/services/quickbooks-credentials.js").isQuickBooksReauthorizationError;

before(async () => {
  process.env.DATABASE_URL ||= "postgresql://unit:unit@127.0.0.1:1/quotefly_unit";
  process.env.JWT_SECRET ||= JWT_SECRET;
  ({ parseEnv } = await import("../../src/config/env.js"));
  ({
    decryptQuickBooksSecret,
    encryptQuickBooksSecret,
    decryptQuickBooksHostedPaymentLink,
    encryptQuickBooksHostedPaymentLink,
    createSignedQuickBooksState,
    fetchQuickBooksCdc,
    fetchQuickBooksCompanyInfo,
    fetchQuickBooksCustomer,
    fetchQuickBooksInvoice,
    fetchQuickBooksItem,
    fetchQuickBooksPayment,
    fetchQuickBooksRefundReceipt,
    refreshQuickBooksAccessToken,
    QUICKBOOKS_INVOICE_LINK_MINOR_VERSION,
    QuickBooksProviderError,
    searchQuickBooksCustomers,
    searchQuickBooksItems,
    verifySignedQuickBooksState,
  } = await import("../../src/services/quickbooks.js"));
  ({ classifyQuickBooksWorkerFailure } = await import("../../src/services/quickbooks-worker-failures.js"));
  ({ QuickBooksReconciliationError } = await import("../../src/services/quickbooks-reconciliation.js"));
  ({ isQuickBooksReauthorizationError } = await import("../../src/services/quickbooks-credentials.js"));
});

function runtimeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/quotefly_unit",
    JWT_SECRET,
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: CURRENT_KEY,
    ...overrides,
  });
}

function encryptLegacyJwtEnvelope(value: string) {
  const key = createHash("sha256").update(JWT_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function encryptVersionedEnvelope(value: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v2",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

describe("QuickBooks token encryption", () => {
  it("writes a versioned envelope with the dedicated key", () => {
    const env = runtimeEnv();
    const encrypted = encryptQuickBooksSecret(env, "access-token-value");

    assert.equal(encrypted.startsWith("v2."), true);
    assert.equal(encrypted.includes("access-token-value"), false);
    assert.equal(decryptQuickBooksSecret(env, encrypted), "access-token-value");
  });

  it("decrypts current envelopes with the previous key during rotation", () => {
    const oldEnv = runtimeEnv({ QUICKBOOKS_TOKEN_ENCRYPTION_KEY: PREVIOUS_KEY });
    const encryptedWithOldKey = encryptQuickBooksSecret(oldEnv, "refresh-token-value");
    const rotatedEnv = runtimeEnv({
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: CURRENT_KEY,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
    });

    assert.equal(decryptQuickBooksSecret(rotatedEnv, encryptedWithOldKey), "refresh-token-value");
    assert.throws(
      () => decryptQuickBooksSecret(runtimeEnv(), encryptedWithOldKey),
      /payload is invalid/i,
    );
  });

  it("never writes or reads current envelopes through the JWT key", () => {
    const envWithoutDedicatedKey = runtimeEnv({ QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "" });
    const jwtEncryptedCurrentEnvelope = encryptVersionedEnvelope("must-not-decrypt", JWT_SECRET);

    assert.throws(
      () => encryptQuickBooksSecret(envWithoutDedicatedKey, "must-not-encrypt"),
      /token encryption key is not configured/i,
    );
    assert.throws(
      () => decryptQuickBooksSecret(envWithoutDedicatedKey, jwtEncryptedCurrentEnvelope),
      /payload is invalid/i,
    );
    assert.throws(
      () => decryptQuickBooksSecret(runtimeEnv(), jwtEncryptedCurrentEnvelope),
      /payload is invalid/i,
    );
  });

  it("retains read compatibility for legacy JWT-derived ciphertext", () => {
    const legacyCiphertext = encryptLegacyJwtEnvelope("legacy-refresh-token");
    assert.equal(decryptQuickBooksSecret(runtimeEnv(), legacyCiphertext), "legacy-refresh-token");
  });

  it("fails closed for malformed or tampered envelopes", () => {
    const env = runtimeEnv();
    const encrypted = encryptQuickBooksSecret(env, "protected-token");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    assert.throws(() => decryptQuickBooksSecret(env, tampered), /payload is invalid/i);
    assert.throws(() => decryptQuickBooksSecret(env, "v2.not-valid"), /payload is invalid/i);
  });
});

describe("QuickBooks hosted payment-link encryption", () => {
  const hostedPaymentUrl = "https://app.qbo.intuit.com/app/invoice?txnId=invoice-link-test";

  it("persists a purpose-bound envelope instead of the capability URL", () => {
    const env = runtimeEnv();
    const encrypted = encryptQuickBooksHostedPaymentLink(env, hostedPaymentUrl);

    assert.equal(encrypted.startsWith("qbl1."), true);
    assert.equal(encrypted.includes(hostedPaymentUrl), false);
    assert.equal(decryptQuickBooksHostedPaymentLink(env, encrypted), hostedPaymentUrl);
    assert.throws(() => decryptQuickBooksSecret(env, encrypted), /payload is invalid/i);
  });

  it("supports key rotation and fails closed for the wrong key or tampering", () => {
    const encryptedWithOldKey = encryptQuickBooksHostedPaymentLink(
      runtimeEnv({ QUICKBOOKS_TOKEN_ENCRYPTION_KEY: PREVIOUS_KEY }),
      hostedPaymentUrl,
    );
    const rotatedEnv = runtimeEnv({
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: CURRENT_KEY,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
    });
    const tamperedParts = encryptedWithOldKey.split(".");
    const encryptedPayload = tamperedParts[3] as string;
    tamperedParts[3] = `${encryptedPayload.startsWith("A") ? "B" : "A"}${encryptedPayload.slice(1)}`;
    const tampered = tamperedParts.join(".");

    assert.equal(decryptQuickBooksHostedPaymentLink(rotatedEnv, encryptedWithOldKey), hostedPaymentUrl);
    assert.throws(
      () => decryptQuickBooksHostedPaymentLink(runtimeEnv(), encryptedWithOldKey),
      /payload is invalid/i,
    );
    assert.throws(
      () => decryptQuickBooksHostedPaymentLink(rotatedEnv, tampered),
      /payload is invalid/i,
    );
    assert.throws(
      () => encryptQuickBooksHostedPaymentLink(rotatedEnv, "https://example.com/not-intuit"),
      /link is invalid/i,
    );
    assert.throws(
      () => encryptQuickBooksHostedPaymentLink(rotatedEnv, `https://app.qbo.intuit.com/${"a".repeat(2_100)}`),
      /link is invalid/i,
    );
  });
});

describe("QuickBooks OAuth state", () => {
  it("encrypts internal actor data and fails closed for tampering", () => {
    const env = runtimeEnv();
    const input = {
      tenantId: "tenant-internal-identity",
      userId: "user-internal-identity",
      role: "owner",
    };
    const state = createSignedQuickBooksState(env, input);

    assert.equal(state.startsWith("qbo2."), true);
    assert.equal(state.includes(input.tenantId), false);
    assert.equal(state.includes(input.userId), false);
    const verified = verifySignedQuickBooksState(env, state);
    assert.equal(verified?.tenantId, input.tenantId);
    assert.equal(verified?.userId, input.userId);
    assert.equal(verified?.role, input.role);
    assert.match(verified?.nonce ?? "", /^[a-f0-9]{24}$/);
    assert.equal(typeof verified?.exp, "number");

    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    assert.equal(verifySignedQuickBooksState(env, tampered), null);
  });
});

describe("QuickBooks runtime feature dependencies", () => {
  const providerBase = {
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
    QUICKBOOKS_CLIENT_ID: "unit-quickbooks-client",
    QUICKBOOKS_CLIENT_SECRET: "unit-quickbooks-secret",
    QUICKBOOKS_WEBHOOK_VERIFIER: "unit-quickbooks-webhook-verifier",
  } satisfies Partial<NodeJS.ProcessEnv>;

  it("rejects hosted payments without the reconciliation worker", () => {
    assert.throws(
      () => runtimeEnv({
        ...providerBase,
        QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true",
        QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      }),
      /hosted payments require the reconciliation worker/i,
    );
  });

  it("rejects CDC recovery without the reconciliation worker", () => {
    assert.throws(
      () => runtimeEnv({
        ...providerBase,
        QUICKBOOKS_CDC_WORKER_ENABLED: "true",
        QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      }),
      /CDC recovery requires the reconciliation worker/i,
    );
  });

  it("accepts the complete provider, reconciliation, hosted-payment, and CDC dependency chain", () => {
    assert.doesNotThrow(() => runtimeEnv({
      ...providerBase,
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    }));
  });

  it("allows connection-only validation and rejects accounting workers in OAuth-only mode", () => {
    assert.doesNotThrow(() => runtimeEnv({
      ...providerBase,
      QUICKBOOKS_ENVIRONMENT: "sandbox",
      QUICKBOOKS_WEBHOOK_VERIFIER: "",
      QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    }));
    assert.throws(
      () => runtimeEnv({
        ...providerBase,
        QUICKBOOKS_ENVIRONMENT: "sandbox",
        QUICKBOOKS_OAUTH_ONLY_MODE: "true",
        QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      }),
      /must remain disabled in OAuth-only mode/i,
    );
  });

  it("restricts OAuth-only mode to sandbox staging", () => {
    assert.throws(
      () => runtimeEnv({
        ...providerBase,
        QUICKBOOKS_ENVIRONMENT: "production",
        QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      }),
      /restricted to sandbox staging/i,
    );
  });

  it("requires an explicit redirect override to exactly match the API callback", () => {
    assert.doesNotThrow(() => runtimeEnv({
      ...providerBase,
      QUICKBOOKS_REDIRECT_URI: "http://localhost:4000/v1/integrations/quickbooks/callback",
    }));
    for (const redirectUri of [
      "http://other-host.test/v1/integrations/quickbooks/callback",
      "http://localhost:4000/v1/integrations/quickbooks/connect",
      "http://localhost:4000/v1/integrations/quickbooks/callback?source=test",
      "http://localhost:4000/v1/integrations/quickbooks/callback#fragment",
    ]) {
      assert.throws(
        () => runtimeEnv({
          ...providerBase,
          QUICKBOOKS_REDIRECT_URI: redirectUri,
        }),
        /must exactly match/i,
      );
    }
  });
});

describe("QuickBooks provider response validation", () => {
  async function rejectsMalformedPayload(
    payload: unknown,
    expectedCode: string,
    operation: () => Promise<unknown>,
  ) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      await assert.rejects(operation, (error: unknown) =>
        error instanceof QuickBooksProviderError && error.code === expectedCode
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("classifies invalid_grant token refresh responses as a reconnect requirement without retaining provider text", async () => {
    const env = runtimeEnv({
      QUICKBOOKS_CLIENT_ID: "sandbox-client-id",
      QUICKBOOKS_CLIENT_SECRET: "sandbox-client-secret",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "provider detail must not cross the boundary",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    try {
      await assert.rejects(
        () => refreshQuickBooksAccessToken(env, "revoked-refresh-token"),
        (error: unknown) => error instanceof QuickBooksProviderError
          && error.code === "QUICKBOOKS_REAUTH_REQUIRED"
          && error.statusCode === 400
          && !error.message.includes("provider detail"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed with stable codes for malformed invoice, payment, customer, item, company, CDC, and search payloads", async () => {
    const env = runtimeEnv();
    await rejectsMalformedPayload(
      { Invoice: { Id: 42 } },
      "QUICKBOOKS_INVOICE_RESPONSE_INVALID",
      () => fetchQuickBooksInvoice(env, "realm", "token", "invoice"),
    );
    await rejectsMalformedPayload(
      { Payment: { Id: 42 } },
      "QUICKBOOKS_PAYMENT_RESPONSE_INVALID",
      () => fetchQuickBooksPayment(env, "realm", "token", "payment"),
    );
    await rejectsMalformedPayload(
      { RefundReceipt: { Id: "refund-without-canonical-evidence" } },
      "QUICKBOOKS_REFUND_RECEIPT_RESPONSE_INVALID",
      () => fetchQuickBooksRefundReceipt(env, "realm", "token", "refund-receipt"),
    );
    await rejectsMalformedPayload(
      { Customer: { Id: 42 } },
      "QUICKBOOKS_CUSTOMER_RESPONSE_INVALID",
      () => fetchQuickBooksCustomer(env, "realm", "token", "customer"),
    );
    await rejectsMalformedPayload(
      { Item: { Id: 42 } },
      "QUICKBOOKS_ITEM_RESPONSE_INVALID",
      () => fetchQuickBooksItem(env, "realm", "token", "item"),
    );
    await rejectsMalformedPayload(
      { CompanyInfo: { Id: 42, CompanyName: "Bad realm" } },
      "QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID",
      () => fetchQuickBooksCompanyInfo(env, "realm", "token"),
    );
    await rejectsMalformedPayload(
      { CDCResponse: "invalid" },
      "QUICKBOOKS_CDC_RESPONSE_INVALID",
      () => fetchQuickBooksCdc(env, "realm", "token", new Date("2026-08-27T00:00:00.000Z")),
    );
    await rejectsMalformedPayload(
      { QueryResponse: { Customer: [{ Id: 42 }] } },
      "QUICKBOOKS_CUSTOMER_QUERY_RESPONSE_INVALID",
      () => searchQuickBooksCustomers(env, "realm", "token", "customer", 10),
    );
  });

  it("pages customer matches with lookahead without losing the first match of the next page", async () => {
    const originalFetch = globalThis.fetch;
    const queries: string[] = [];
    const responses = [
      { QueryResponse: { Customer: [
        { Id: "11", DisplayName: "O'Neil A", Active: true },
        { Id: "12", DisplayName: "O'Neil B", Active: true },
        { Id: "13", DisplayName: "O'Neil C", Active: true },
      ] } },
      { QueryResponse: { Customer: [{ Id: "13", DisplayName: "O'Neil C", Active: true }] } },
    ];
    globalThis.fetch = async (_url, init) => {
      queries.push(String(init?.body));
      return Response.json(responses.shift());
    };
    try {
      const first = await searchQuickBooksCustomers(runtimeEnv(), "realm", "token", "O'Neil", 2);
      assert.deepEqual(first.candidates.map(({ Id }) => Id), ["11", "12"]);
      assert.deepEqual(first.page, { startPosition: 1, limit: 2, hasMore: true, nextStartPosition: 3 });
      const second = await searchQuickBooksCustomers(runtimeEnv(), "realm", "token", "O'Neil", 2, first.page.nextStartPosition!);
      assert.deepEqual(second.candidates.map(({ Id }) => Id), ["13"]);
      assert.deepEqual(second.page, { startPosition: 3, limit: 2, hasMore: false, nextStartPosition: null });
      assert.deepEqual(queries, [
        "SELECT * FROM Customer WHERE DisplayName LIKE '%O\\'Neil%' AND Active = true STARTPOSITION 1 MAXRESULTS 3",
        "SELECT * FROM Customer WHERE DisplayName LIKE '%O\\'Neil%' AND Active = true STARTPOSITION 3 MAXRESULTS 3",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sorts item lookup pages by the supported Name field and treats an exact-sized or empty last page as terminal", async () => {
    const originalFetch = globalThis.fetch;
    const queries: string[] = [];
    const responses = [
      { QueryResponse: { Item: [
        { Id: "1", Name: "Service A", Active: true },
        { Id: "2", Name: "Service B", Active: true },
      ] } },
      { QueryResponse: {} },
    ];
    globalThis.fetch = async (_url, init) => {
      queries.push(String(init?.body));
      return Response.json(responses.shift());
    };
    try {
      const exact = await searchQuickBooksItems(runtimeEnv(), "realm", "token", "Service", 2, 11);
      assert.equal(exact.candidates.length, 2);
      assert.deepEqual(exact.page, { startPosition: 11, limit: 2, hasMore: false, nextStartPosition: null });
      const empty = await searchQuickBooksItems(runtimeEnv(), "realm", "token", "Service", 2, 13);
      assert.deepEqual(empty.candidates, []);
      assert.deepEqual(empty.page, { startPosition: 13, limit: 2, hasMore: false, nextStartPosition: null });
      assert.deepEqual(queries, [
        "SELECT * FROM Item WHERE Name LIKE '%Service%' AND Active = true ORDERBY Name STARTPOSITION 11 MAXRESULTS 3",
        "SELECT * FROM Item WHERE Name LIKE '%Service%' AND Active = true ORDERBY Name STARTPOSITION 13 MAXRESULTS 3",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects malformed mapping pages including invalid lookahead records instead of reporting no more matches", async () => {
    const env = runtimeEnv();
    for (const search of [searchQuickBooksCustomers, searchQuickBooksItems]) {
      const entity = search === searchQuickBooksCustomers ? "Customer" : "Item";
      for (const payload of [null, {}, { QueryResponse: null }, { QueryResponse: [] }, { QueryResponse: { [entity]: {} } }]) {
        await rejectsMalformedPayload(payload, "QUICKBOOKS_QUERY_RESPONSE_INVALID", () => search(env, "realm", "token", "search", 1));
      }
      for (const records of [
        [{ Id: "valid" }, { Id: 123 }],
        [{ Id: "inactive", Active: false }],
        [{ Id: "1" }, { Id: "2" }, { Id: "too-many" }],
      ]) {
        await rejectsMalformedPayload(
          { QueryResponse: { [entity]: records } },
          `QUICKBOOKS_${entity.toUpperCase()}_QUERY_RESPONSE_INVALID`,
          () => search(env, "realm", "token", "search", 1),
        );
      }
    }
  });

  it("validates mapping pagination and query bounds before sending any provider request", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return Response.json({ QueryResponse: {} }); };
    try {
      for (const search of [searchQuickBooksCustomers, searchQuickBooksItems]) {
        for (const start of [0, -1, 1.1, 1_000_001, Infinity, NaN]) {
          await assert.rejects(() => search(runtimeEnv(), "realm", "token", "search", 10, start));
        }
        for (const limit of [0, -1, 1.1, 26, Infinity, NaN]) {
          await assert.rejects(() => search(runtimeEnv(), "realm", "token", "search", limit));
        }
        for (const query of ["a", "  ", "a".repeat(81)]) {
          await assert.rejects(() => search(runtimeEnv(), "realm", "token", query, 10));
        }
      }
      assert.equal(calls, 0);
      const upper = await searchQuickBooksCustomers(runtimeEnv(), "realm", "token", "search", 25, 1_000_000);
      assert.deepEqual(upper.page, { startPosition: 1_000_000, limit: 25, hasMore: false, nextStartPosition: null });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps observed more matches visible at the position guard without returning an invalid continuation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ QueryResponse: { Customer: [{ Id: "1" }, { Id: "2" }] } });
    try {
      const result = await searchQuickBooksCustomers(runtimeEnv(), "realm", "token", "search", 1, 1_000_000);
      assert.equal(result.candidates.length, 1);
      assert.deepEqual(result.page, { startPosition: 1_000_000, limit: 1, hasMore: true, nextStartPosition: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads a canonical RefundReceipt and includes refund transactions in the bounded CDC response", async () => {
    const env = runtimeEnv();
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const refundReceipt = {
        Id: "refund-1",
        TotalAmt: 40,
        CustomerRef: { value: "customer-1" },
        CurrencyRef: { value: "USD" },
        MetaData: { LastUpdatedTime: "2026-08-27T20:04:00.000Z" },
        LinkedTxn: [
          { TxnId: "payment-1", TxnType: "Payment" },
          { TxnId: "invoice-1", TxnType: "Invoice" },
        ],
      };
      return new Response(JSON.stringify(url.includes("/cdc?")
        ? {
            CDCResponse: [{
              QueryResponse: [{ RefundReceipt: [refundReceipt] }],
              time: "2026-08-27T20:05:00.000Z",
            }],
          }
        : { RefundReceipt: refundReceipt }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await assert.doesNotReject(async () => {
        const refund = await fetchQuickBooksRefundReceipt(env, "realm", "token", "refund-1");
        assert.equal(refund.Id, "refund-1");
        const cdc = await fetchQuickBooksCdc(env, "realm", "token", new Date("2026-08-27T20:00:00.000Z"));
        assert.equal(cdc.refundReceipts.length, 1);
        assert.equal(cdc.refundReceipts[0]?.Id, "refund-1");
      });
      assert.equal(requestedUrls.some((url) => url.includes("/refundreceipt/refund-1")), true);
      assert.equal(requestedUrls.some((url) => url.includes("entities=Invoice,Payment,RefundReceipt")), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("pins InvoiceLink retrieval to the reviewed QuickBooks minor-version contract", async () => {
    const env = runtimeEnv();
    const originalFetch = globalThis.fetch;
    let requestedUrl: URL | null = null;
    globalThis.fetch = async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ Invoice: { Id: "invoice/with spaces" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await fetchQuickBooksInvoice(env, "realm", "token", "invoice/with spaces");
      assert.ok(requestedUrl);
      assert.equal(requestedUrl.pathname.endsWith("/invoice/invoice%2Fwith%20spaces"), true);
      assert.equal(requestedUrl.searchParams.get("include"), "invoiceLink");
      assert.equal(requestedUrl.searchParams.get("minorversion"), QUICKBOOKS_INVOICE_LINK_MINOR_VERSION);
      assert.equal(QUICKBOOKS_INVOICE_LINK_MINOR_VERSION, "36");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("QuickBooks reconciliation worker failure policy", () => {
  it("requires an explicit terminal refresh-token code before reconnecting", () => {
    assert.equal(isQuickBooksReauthorizationError(new QuickBooksProviderError(
      "QUICKBOOKS_PROVIDER_REQUEST_FAILED",
      false,
      403,
    )), false);
    assert.equal(isQuickBooksReauthorizationError(new QuickBooksProviderError(
      "QUICKBOOKS_REAUTH_REQUIRED",
      false,
      400,
    )), true);
    assert.equal(isQuickBooksReauthorizationError(new QuickBooksProviderError(
      "QUICKBOOKS_PROVIDER_REQUEST_FAILED",
      false,
      401,
    )), false);
  });

  it("preserves canonical retryability and sanitizes unknown failures", () => {
    assert.deepEqual(
      classifyQuickBooksWorkerFailure(new QuickBooksReconciliationError(
        "QUICKBOOKS_INVOICE_TOTAL_DRIFT",
        "Provider detail must never be persisted.",
        false,
      )),
      { code: "QUICKBOOKS_INVOICE_TOTAL_DRIFT", retryable: false },
    );
    assert.deepEqual(
      classifyQuickBooksWorkerFailure(new QuickBooksReconciliationError(
        "QUICKBOOKS_NOT_CONNECTED",
        "Reconnect QuickBooks.",
        true,
      )),
      { code: "QUICKBOOKS_NOT_CONNECTED", retryable: true },
    );
    assert.deepEqual(
      classifyQuickBooksWorkerFailure(new QuickBooksProviderError(
        "QUICKBOOKS_REAUTH_REQUIRED",
        false,
        401,
      )),
      { code: "QUICKBOOKS_REAUTH_REQUIRED", retryable: false },
    );
    assert.deepEqual(
      classifyQuickBooksWorkerFailure(new Error("customer@example.com should not escape")),
      { code: "QUICKBOOKS_WORKER_FAILURE", retryable: true },
    );
  });
});
