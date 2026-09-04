import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
process.env.PUBLIC_SIGNUP_ENABLED = "true";
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

test("isolated staging can disable public tenant registration before request parsing", async () => {
  const { buildServer } = await import("../src/app");
  const app = buildServer();
  app.env.PUBLIC_SIGNUP_ENABLED = false;
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { intentionally: "invalid" },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: "New account registration is temporarily unavailable.",
      code: "PUBLIC_SIGNUP_DISABLED",
    });
  } finally {
    await app.close();
  }
});

test("QuickBooks provider workflows require an independent token-encryption key in every environment", async () => {
  const { parseEnv } = await import("../src/config/env");
  const base = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/quotefly_test?schema=public",
    JWT_SECRET: "quickbooks-workflow-jwt-secret-that-is-long-enough",
    APP_URL: "http://localhost:5173",
    API_URL: "http://localhost:4000",
    QUICKBOOKS_CLIENT_ID: "quickbooks-development-client",
    QUICKBOOKS_CLIENT_SECRET: "quickbooks-development-secret",
    QUICKBOOKS_ENVIRONMENT: "sandbox",
    QUICKBOOKS_REDIRECT_URI: "http://localhost:4000/v1/integrations/quickbooks/callback",
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
    QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
    QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
    QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "",
  } satisfies NodeJS.ProcessEnv;

  assert.throws(
    () => parseEnv(base),
    /must be at least 32 characters and independent from JWT_SECRET when QuickBooks provider workflows are enabled/i,
  );
  assert.throws(
    () => parseEnv({ ...base, QUICKBOOKS_TOKEN_ENCRYPTION_KEY: base.JWT_SECRET }),
    /must be independent from JWT_SECRET/i,
  );
  assert.doesNotThrow(() => parseEnv({
    ...base,
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-encryption-key-000001",
  }));
  assert.throws(
    () => parseEnv({
      ...base,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-encryption-key-000001",
      APP_URL: "https://www.quotefly.us",
      API_URL: "https://api.quotefly.us",
    }),
    /QuickBooks sandbox workflows are forbidden on QuoteFly production origins/i,
  );
});

test("QuickBooks OAuth routes set no-store and no-referrer before callback parsing", () => {
  const source = readFileSync(new URL("../src/routes/quickbooks.ts", import.meta.url), "utf8");
  const connectStart = source.indexOf('"/integrations/quickbooks/connect"');
  const callbackStart = source.indexOf('app.get("/integrations/quickbooks/callback"', connectStart);
  assert.ok(connectStart >= 0 && callbackStart > connectStart, "QuickBooks OAuth connect route must remain discoverable");
  const connectSource = source.slice(connectStart, callbackStart);
  assert.match(connectSource, /reply\.header\("Cache-Control", "private, no-store"\)/);

  const callbackEnd = source.indexOf("let issuedRefreshToken", callbackStart);
  assert.ok(callbackEnd > callbackStart, "QuickBooks OAuth callback parser must remain discoverable");
  const callbackPreamble = source.slice(callbackStart, callbackEnd);
  assert.match(callbackPreamble, /reply\.header\("Cache-Control", "private, no-store"\)/);
  assert.match(callbackPreamble, /reply\.header\("Referrer-Policy", "no-referrer"\)/);
  assert.ok(
    callbackPreamble.indexOf('reply.header("Cache-Control", "private, no-store")')
      < callbackPreamble.indexOf("QuickBooksCallbackQuerySchema.parse(request.query)"),
    "callback cache policy must be set before parsing",
  );
});

test("infrastructure variable audit uses fixed profiles and never emits secret values", () => {
  const auditPath = fileURLToPath(new URL("../scripts/infrastructure-variable-audit.mjs", import.meta.url));
  const allSecretNames = [
    "DATABASE_URL", "DIRECT_DATABASE_URL", "RATE_LIMIT_REDIS_URL", "JWT_SECRET", "OPENAI_API_KEY",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "TWILIO_AUTH_TOKEN",
    "TWILIO_WEBHOOK_AUTH_TOKEN", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_WEBHOOK_VERIFIER",
    "QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS",
  ];
  const clearedSecrets = Object.fromEntries(allSecretNames.map((name) => [name, ""]));
  const runAudit = (profile, env) => spawnSync(
    process.execPath,
    [auditPath, "--profile", profile],
    { encoding: "utf8", env: { ...process.env, ...clearedSecrets, ...env } },
  );
  const requiredEnvironment = {
    api: {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
    },
    worker: { NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel" },
    migrations: { NODE_ENV: "test", DIRECT_DATABASE_URL: "direct-database-sentinel" },
    web: { VITE_API_BASE_URL: "https://api.example.test" },
    quickbooks: {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
      QUICKBOOKS_CLIENT_ID: "client-id", QUICKBOOKS_CLIENT_SECRET: "client-secret-sentinel",
      QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_REDIRECT_URI: "https://api.example.test/callback",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://app.example.test,https://api.example.test",
      QUICKBOOKS_WEBHOOK_VERIFIER: "verifier-sentinel", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "encryption-key-sentinel",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
    "quickbooks-oauth": {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
      QUICKBOOKS_CLIENT_ID: "client-id", QUICKBOOKS_CLIENT_SECRET: "client-secret-sentinel",
      QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_REDIRECT_URI: "https://api.example.test/callback",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://app.example.test,https://api.example.test",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "encryption-key-sentinel",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true", QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false", QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    },
    "quickbooks-reconciliation": {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
      QUICKBOOKS_CLIENT_ID: "client-id", QUICKBOOKS_CLIENT_SECRET: "client-secret-sentinel",
      QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_REDIRECT_URI: "https://api.example.test/callback",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://app.example.test,https://api.example.test",
      QUICKBOOKS_WEBHOOK_VERIFIER: "verifier-sentinel", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "encryption-key-sentinel",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true", QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false", QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    },
    "quickbooks-cdc": {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
      QUICKBOOKS_CLIENT_ID: "client-id", QUICKBOOKS_CLIENT_SECRET: "client-secret-sentinel",
      QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_REDIRECT_URI: "https://api.example.test/callback",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://app.example.test,https://api.example.test",
      QUICKBOOKS_WEBHOOK_VERIFIER: "verifier-sentinel", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "encryption-key-sentinel",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true", QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false", QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
    "quickbooks-hosted-payments": {
      NODE_ENV: "test", DATABASE_URL: "database-sentinel", JWT_SECRET: "jwt-sentinel",
      APP_URL: "https://app.example.test", API_URL: "https://api.example.test",
      QUICKBOOKS_CLIENT_ID: "client-id", QUICKBOOKS_CLIENT_SECRET: "client-secret-sentinel",
      QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_REDIRECT_URI: "https://api.example.test/callback",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://app.example.test,https://api.example.test",
      QUICKBOOKS_WEBHOOK_VERIFIER: "verifier-sentinel", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "encryption-key-sentinel",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true", QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true", QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
  };

  const quickBooksStageExpectations = {
    "quickbooks-oauth": {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    },
    "quickbooks-reconciliation": {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    },
    "quickbooks-cdc": {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
    "quickbooks-hosted-payments": {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
    quickbooks: {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_OAUTH_ONLY_MODE: "false",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
      QUICKBOOKS_CDC_WORKER_ENABLED: "true",
    },
  };

  const assertNoSecretValues = (result, environment) => {
    for (const name of allSecretNames) {
      const value = environment[name];
      if (!value) continue;
      assert.doesNotMatch(result.stdout, new RegExp(value));
      assert.doesNotMatch(result.stderr, new RegExp(value));
    }
  };

  for (const [profile, env] of Object.entries(requiredEnvironment)) {
    const result = runAudit(profile, env);
    assert.equal(result.status, 0, `${profile}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report), ["schema", "evidenceScope", "profile", "outcome", "required", "forbidden"]);
    assert.equal(report.schema, "quotefly.infrastructure-variable-audit/v1");
    assert.equal(report.evidenceScope, "current-runtime-only");
    assert.equal(report.profile, profile);
    assert.equal(report.outcome, "pass");
    assert.ok(report.required.every((entry) => entry.status === "configured"));
    assert.ok(report.required.every((entry) => !entry.expectationStatus || entry.expectationStatus === "matched"));
    assert.ok(report.forbidden.every((entry) => entry.status === "missing"));
    assertNoSecretValues(result, env);
  }

  for (const [profile, expectations] of Object.entries(quickBooksStageExpectations)) {
    for (const [variableName, expectedValue] of Object.entries(expectations)) {
      const wrongValue = expectedValue === "true" ? "false" : "true";
      const environment = { ...requiredEnvironment[profile], [variableName]: wrongValue };
      const result = runAudit(profile, environment);
      assert.equal(result.status, 1, `${profile}:${variableName}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, "fail");
      assert.equal(
        report.required.find((entry) => entry.name === variableName)?.expectationStatus,
        "mismatched",
      );
      assertNoSecretValues(result, environment);
    }
  }

  for (const profile of Object.keys(quickBooksStageExpectations)) {
    const configured = runAudit(profile, requiredEnvironment[profile]);
    const configuredReport = JSON.parse(configured.stdout);
    for (const { name: variableName } of configuredReport.required) {
      const incompleteEnvironment = { ...requiredEnvironment[profile], [variableName]: "" };
      const result = runAudit(profile, incompleteEnvironment);
      assert.equal(result.status, 1, `${profile}:${variableName}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, "fail");
      assert.equal(
        report.required.find((entry) => entry.name === variableName)?.status,
        "missing",
      );
      assertNoSecretValues(result, incompleteEnvironment);
    }
  }

  for (const profile of ["quickbooks-reconciliation", "quickbooks-cdc", "quickbooks-hosted-payments", "quickbooks"]) {
    const productionEnvironment = {
      ...requiredEnvironment[profile],
      QUICKBOOKS_ENVIRONMENT: "production",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "",
    };
    const result = runAudit(profile, productionEnvironment);
    assert.equal(result.status, 0, `${profile}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "pass");
    assert.equal(
      report.required.some((entry) => entry.name === "QUICKBOOKS_SANDBOX_STAGING_ORIGINS"),
      false,
    );
    assertNoSecretValues(result, productionEnvironment);
  }

  const productionOauthEnvironment = {
    ...requiredEnvironment["quickbooks-oauth"],
    QUICKBOOKS_ENVIRONMENT: "production",
    QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "",
  };
  const productionOauthResult = runAudit("quickbooks-oauth", productionOauthEnvironment);
  assert.equal(productionOauthResult.status, 1);
  const productionOauthReport = JSON.parse(productionOauthResult.stdout);
  assert.equal(
    productionOauthReport.required.find((entry) => entry.name === "QUICKBOOKS_ENVIRONMENT")?.expectationStatus,
    "mismatched",
  );
  assert.equal(
    productionOauthReport.required.some((entry) => entry.name === "QUICKBOOKS_SANDBOX_STAGING_ORIGINS"),
    false,
  );
  assertNoSecretValues(productionOauthResult, productionOauthEnvironment);

  assert.deepEqual(
    runAudit("quickbooks", requiredEnvironment.quickbooks).stdout
      .replace('"profile": "quickbooks"', '"profile": "quickbooks-hosted-payments"'),
    runAudit("quickbooks-hosted-payments", requiredEnvironment["quickbooks-hosted-payments"]).stdout,
  );

  const secretEnvironment = Object.fromEntries(allSecretNames.map((name, index) => [name, `secret-sentinel-${index}`]));
  const webResult = runAudit("web", { VITE_API_BASE_URL: "https://api.example.test", ...secretEnvironment });
  assert.equal(webResult.status, 1);
  const webReport = JSON.parse(webResult.stdout);
  assert.equal(webReport.outcome, "fail");
  assert.deepEqual(webReport.forbidden.map((entry) => entry.name), allSecretNames);
  assert.ok(webReport.forbidden.every((entry) => entry.classification === "secret" && entry.status === "configured"));
  for (const value of Object.values(secretEnvironment)) {
    assert.doesNotMatch(webResult.stdout, new RegExp(value));
    assert.doesNotMatch(webResult.stderr, new RegExp(value));
  }

  const forbiddenByProfile = {
    api: ["DIRECT_DATABASE_URL"],
    worker: ["DIRECT_DATABASE_URL"],
    migrations: ["DATABASE_URL"],
    "quickbooks-oauth": ["DIRECT_DATABASE_URL", "QUICKBOOKS_WEBHOOK_VERIFIER"],
    "quickbooks-reconciliation": ["DIRECT_DATABASE_URL"],
    "quickbooks-cdc": ["DIRECT_DATABASE_URL"],
    "quickbooks-hosted-payments": ["DIRECT_DATABASE_URL"],
    quickbooks: ["DIRECT_DATABASE_URL"],
  };
  for (const [profile, forbiddenNames] of Object.entries(forbiddenByProfile)) {
    for (const forbiddenName of forbiddenNames) {
      const environment = { ...requiredEnvironment[profile], [forbiddenName]: "forbidden-sentinel" };
      const result = runAudit(profile, environment);
      assert.equal(result.status, 1, `${profile}:${forbiddenName}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, "fail");
      assert.deepEqual(
        report.forbidden.find((entry) => entry.name === forbiddenName),
        { name: forbiddenName, classification: "secret", status: "configured" },
      );
      assertNoSecretValues(result, environment);
    }
  }

  const unknownProfile = "untrusted-profile-sentinel";
  const unknown = spawnSync(process.execPath, [auditPath, "--profile", unknownProfile], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.doesNotMatch(unknown.stdout, new RegExp(unknownProfile));
  assert.doesNotMatch(unknown.stderr, new RegExp(unknownProfile));

  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^\.railway\/$/m);
  assert.match(gitignore, /^\.vercel\/$/m);
  assert.match(gitignore, /^\.neon\/$/m);

  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--", ".env.staging.local"], { cwd: repositoryRoot }).status,
    0,
    ".env.staging.local must be ignored",
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--", ".env.example"], { cwd: repositoryRoot }).status,
    1,
    ".env.example must remain trackable",
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--", ".neon/local-state.json"], { cwd: repositoryRoot }).status,
    0,
    ".neon local state must be ignored",
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--", ".neon"], { cwd: repositoryRoot }).status,
    0,
    ".neon local state file must be ignored",
  );
});

test("integration setup replaces ambient provider credentials with deterministic fixtures", () => {
  const source = readFileSync(new URL("../tests/setup-env.ts", import.meta.url), "utf8");
  const overwrittenNames = [
    "JWT_SECRET",
    "APP_URL",
    "API_URL",
    "CORS_ALLOWED_ORIGINS",
    "OPENAI_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "QUICKBOOKS_CLIENT_ID",
    "QUICKBOOKS_CLIENT_SECRET",
    "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED",
    "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED",
    "QUICKBOOKS_HOSTED_PAYMENTS_ENABLED",
    "QUICKBOOKS_CDC_WORKER_ENABLED",
    "QUICKBOOKS_WEBHOOK_VERIFIER",
    "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_WEBHOOK_AUTH_TOKEN",
    "RATE_LIMIT_REDIS_URL",
  ];

  for (const name of overwrittenNames) {
    assert.match(source, new RegExp(`process\\.env\\.${name}\\s*=`), `${name} must be overwritten for integration tests`);
    assert.doesNotMatch(source, new RegExp(`process\\.env\\.${name}\\s*\\|\\|=`), `${name} must not inherit ambient credentials`);
  }
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

test("QuickBooks OAuth actor migration restores forced RLS before its transaction commits", () => {
  const source = readFileSync(
    new URL(
      "../prisma/migrations/20260831213000_bind_quickbooks_oauth_state_actor/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const begin = source.indexOf("BEGIN;");
  const relax = source.indexOf('ALTER TABLE "QuickBooksOAuthState" NO FORCE ROW LEVEL SECURITY;');
  const cleanup = source.indexOf('DELETE FROM "QuickBooksOAuthState"');
  const foreignKey = source.indexOf('ADD CONSTRAINT "QuickBooksOAuthState_tenantId_userId_fkey"');
  const restore = source.indexOf('ALTER TABLE "QuickBooksOAuthState" FORCE ROW LEVEL SECURITY;');
  const commit = source.indexOf("COMMIT;");

  assert.ok(begin >= 0);
  assert.ok(begin < relax);
  assert.ok(relax < cleanup);
  assert.ok(cleanup < foreignKey);
  assert.ok(foreignKey < restore);
  assert.ok(restore < commit);
});

test("QuickBooks hosted-link migration deterministically fences active rows before clearing every remaining capability", () => {
  const source = readFileSync(
    new URL(
      "../prisma/migrations/20260902173500_add_quickbooks_reauth_connection_event/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /WITH\s+"clearedHostedLinks"/i);

  const fenceStart = source.indexOf("-- Fence active provider-bound rows first.");
  const clearStart = source.indexOf("-- Clear every remaining plaintext capability", fenceStart);
  assert.ok(fenceStart >= 0 && clearStart > fenceStart, "hosted-link fence and clearing statements must remain ordered");

  const fenceSource = source.slice(fenceStart, clearStart);
  assert.match(fenceSource, /"status"\s*=\s*'RECONCILIATION_REQUIRED'/i);
  assert.match(fenceSource, /"providerInvoiceLink"\s*=\s*NULL/i);
  assert.match(fenceSource, /"providerInvoiceLink"\s+IS\s+NOT\s+NULL/i);
  assert.match(fenceSource, /"archivedAtUtc"\s+IS\s+NULL/i);
  assert.match(fenceSource, /"providerInvoiceId"\s+IS\s+NOT\s+NULL/i);

  const clearSource = source.slice(clearStart);
  assert.match(clearSource, /"providerInvoiceLink"\s*=\s*NULL/i);
  assert.match(clearSource, /"invoiceLinkFetchedAtUtc"\s*=\s*NULL/i);
  assert.match(clearSource, /WHERE\s+"providerInvoiceLink"\s+IS\s+NOT\s+NULL/i);
  assert.doesNotMatch(clearSource, /"archivedAtUtc"\s+IS\s+NULL/i);
});
