import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildQuickBooksInvoiceCsv } from "../src/services/quickbooks-csv";
import {
  createSignedQuickBooksState,
  verifyQuickBooksWebhookSignature,
  verifySignedQuickBooksState,
} from "../src/services/quickbooks";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/quotefly_test?schema=public";
process.env.JWT_SECRET = "security-test-jwt-secret-that-is-long-enough";
process.env.APP_URL = "http://localhost:5173";
process.env.API_URL = "http://localhost:4000";
process.env.CORS_ALLOWED_ORIGINS = "http://127.0.0.1:5173";
process.env.ENABLE_TWILIO_SMS = "false";
process.env.RESEND_API_KEY = "re_security_test";
process.env.PASSWORD_RESET_EMAIL_FROM = "QuoteFly <support@quotefly.us>";
process.env.SUPPORT_EMAIL = "support@quotefly.us";

test("Railway keeps migration-owner execution isolated from the long-running API", () => {
  const apiConfig = JSON.parse(
    readFileSync(new URL("../railway.json", import.meta.url), "utf8"),
  ) as { deploy?: Record<string, unknown> };
  const migrationConfig = JSON.parse(
    readFileSync(new URL("../railway.migrations.json", import.meta.url), "utf8"),
  ) as { deploy?: Record<string, unknown> };

  assert.equal(apiConfig.deploy?.startCommand, "npm start");
  assert.equal(apiConfig.deploy?.healthcheckPath, "/v1/ready");
  assert.equal(migrationConfig.deploy?.startCommand, "npm run prisma:migrate:deploy");
  assert.equal(migrationConfig.deploy?.healthcheckPath, null);
  assert.equal(migrationConfig.deploy?.restartPolicyType, "NEVER");
});

test("credentialed CORS never reflects an untrusted origin", async () => {
  const { buildServer } = await import("../src/app");
  const app = buildServer();
  await app.ready();
  try {
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(blocked.headers["access-control-allow-origin"], undefined);

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
    assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  } finally {
    await app.close();
  }
});

test("public feature requests are bounded, escaped, rate-limited, and provider-safe", async () => {
  const originalFetch = globalThis.fetch;
  const providerCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    providerCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "email-feature-request" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { buildServer } = await import("../src/app");
  const app = buildServer();
  await app.ready();

  const requestBody = {
    requestId: "ef9f2ef8-8f44-4db2-b7ac-287ddf56ed6f",
    name: "Ruben Tester",
    email: "ruben@example.com",
    company: "Field Test Co",
    category: "MOBILE",
    priority: "IMPORTANT",
    title: "Faster mobile search\nfor the field",
    details: "Let me find jobs quickly without exposing <script>alert('x')</script>.",
    source: "PUBLIC",
    website: "",
  };

  try {
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/feedback/feature-requests",
      payload: requestBody,
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(providerCalls.length, 1);

    const providerRequest = providerCalls[0];
    assert.equal(String(providerRequest.input), "https://api.resend.com/emails");
    const providerPayload = JSON.parse(String(providerRequest.init?.body)) as Record<string, unknown>;
    assert.deepEqual(providerPayload.to, ["support@quotefly.us"]);
    assert.equal(providerPayload.reply_to, "ruben@example.com");
    assert.equal(providerPayload.subject, "[Feature request] Faster mobile search for the field");
    assert.ok(String(providerPayload.html).includes("&lt;script&gt;"));
    assert.ok(!String(providerPayload.html).includes("<script>alert"));
    assert.equal(
      new Headers(providerRequest.init?.headers).get("Idempotency-Key"),
      `feature-request-${requestBody.requestId}`,
    );

    const honeypot = await app.inject({
      method: "POST",
      url: "/v1/feedback/feature-requests",
      payload: {
        ...requestBody,
        requestId: "a191cadf-bb77-45bb-b3c7-c1c02a0cff5c",
        website: "https://spam.example",
      },
    });
    assert.equal(honeypot.statusCode, 202);
    assert.equal(providerCalls.length, 1, "honeypot submissions must not consume provider quota");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/feedback/feature-requests",
      payload: {
        ...requestBody,
        requestId: "bf850785-8109-48b9-84a8-25a2e7378a54",
        email: "not-an-email",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(providerCalls.length, 1);

    globalThis.fetch = (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch;
    const providerFailure = await app.inject({
      method: "POST",
      url: "/v1/feedback/feature-requests",
      payload: {
        ...requestBody,
        requestId: "8462e059-b307-482a-917f-b1176b8a7449",
      },
    });
    assert.equal(providerFailure.statusCode, 503);
    assert.deepEqual(providerFailure.json(), {
      error: "Feature request could not be sent right now. Please email support@quotefly.us.",
    });

    const limited = await app.inject({
      method: "POST",
      url: "/v1/feedback/feature-requests",
      payload: {
        ...requestBody,
        requestId: "3df72495-5c46-4ffb-a3a2-35ed4fe3cbd3",
      },
    });
    assert.equal(limited.statusCode, 429);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("QuickBooks CSV neutralizes spreadsheet formulas in user-controlled text", () => {
  const csv = buildQuickBooksInvoiceCsv(
    [
      {
        id: "quote-security-test",
        title: "+CMD|' /C calc'!A0",
        serviceType: "HVAC",
        status: "ACCEPTED",
        scopeText: "@SUM(1+1)",
        customerPriceSubtotal: 125,
        taxAmount: 10,
        totalAmount: 135,
        createdAt: new Date("2026-07-29T00:00:00.000Z"),
        customer: {
          fullName: "=WEBSERVICE(\"https://attacker.example\")",
          email: "@SUM(1+1)",
          phone: "-1+2",
        },
        lineItems: [{ description: "\t=HYPERLINK(\"https://attacker.example\")", quantity: 1, unitPrice: 125 }],
      },
    ],
    { exportedAt: new Date("2026-07-29T00:00:00.000Z") },
  );

  assert.ok(csv.includes("'=WEBSERVICE"));
  assert.ok(csv.includes("'@SUM(1+1)"));
  assert.ok(csv.includes("'-1+2"));
  assert.ok(csv.includes("'+CMD|'"));
  assert.ok(csv.includes("'\t=HYPERLINK"));
  assert.ok(csv.includes(",1.00,125.00,125.00,"), "numeric cells must remain numeric");
});

test("QuickBooks signatures reject malformed or tampered values without throwing", () => {
  const runtimeEnv = {
    JWT_SECRET: "security-test-jwt-secret-that-is-long-enough",
    QUICKBOOKS_WEBHOOK_VERIFIER: "security-test-webhook-verifier",
  } as unknown as Parameters<typeof createSignedQuickBooksState>[0];

  const state = createSignedQuickBooksState(runtimeEnv, {
    tenantId: "tenant-security",
    userId: "user-security",
    role: "owner",
  });
  assert.equal(verifySignedQuickBooksState(runtimeEnv, state)?.tenantId, "tenant-security");
  assert.equal(verifySignedQuickBooksState(runtimeEnv, `${state}extra`), null);
  assert.equal(verifySignedQuickBooksState(runtimeEnv, "malformed"), null);

  const payload = "[]";
  const validSignature = createHmac("sha256", runtimeEnv.QUICKBOOKS_WEBHOOK_VERIFIER)
    .update(payload, "utf8")
    .digest("base64");
  assert.equal(verifyQuickBooksWebhookSignature(runtimeEnv, payload, validSignature), true);
  assert.equal(verifyQuickBooksWebhookSignature(runtimeEnv, payload, "invalid"), false);
  assert.equal(
    verifyQuickBooksWebhookSignature(runtimeEnv, payload, `${validSignature.slice(0, -1)}A`),
    false,
  );
});

test("QuickBooks quote preview keeps protected reads inside its tenant RLS transaction", () => {
  const source = readFileSync(new URL("../src/routes/quickbooks.ts", import.meta.url), "utf8");
  const contextStart = source.indexOf("async function loadQuickBooksSyncContext");
  const contextEnd = source.indexOf("async function getAccessToken", contextStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart, "QuickBooks sync context helper must remain discoverable");

  const contextSource = source.slice(contextStart, contextEnd);
  assert.match(contextSource, /const quote = await transaction\.quote\.findFirst\(/);
  assert.doesNotMatch(contextSource, /app\.prisma\.quote\./);
});
