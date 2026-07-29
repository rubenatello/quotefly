import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildQuickBooksInvoiceCsv } from "../src/services/quickbooks-csv";
import {
  createSignedQuickBooksState,
  verifyQuickBooksWebhookSignature,
  verifySignedQuickBooksState,
} from "../src/services/quickbooks";

test("credentialed CORS never reflects an untrusted origin", async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/quotefly_test?schema=public";
  process.env.JWT_SECRET = "security-test-jwt-secret-that-is-long-enough";
  process.env.APP_URL = "http://localhost:5173";
  process.env.API_URL = "http://localhost:4000";
  process.env.CORS_ALLOWED_ORIGINS = "http://127.0.0.1:5173";
  process.env.ENABLE_TWILIO_SMS = "false";

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
