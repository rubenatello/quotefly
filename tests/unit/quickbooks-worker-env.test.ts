import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, createCipheriv, createHash, randomBytes } from "node:crypto";
import { parseQuickBooksWorkerEnv, QUICKBOOKS_WORKER_FORBIDDEN_SECRETS } from "../../src/config/quickbooks-worker-env";
import { decryptQuickBooksSecret, encryptQuickBooksSecret, verifyQuickBooksWebhookSignature } from "../../src/services/quickbooks";
import { assertQuickBooksWorkerArtifactHasNoEnvFiles, startQuickBooksReconciliationWorker } from "../../src/workers/quickbooks-reconciliation-bootstrap";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const minimal: NodeJS.ProcessEnv = {
  NODE_ENV: "production", DATABASE_URL: "postgresql://quotefly_runtime@db.example.com/quotefly_test",
  JWT_SECRET: "synthetic-worker-legacy-jwt-secret-for-tests-only",
  APP_URL: "https://app.quotefly.us", API_URL: "https://api.quotefly.us",
  QUICKBOOKS_CLIENT_ID: "synthetic-worker-client", QUICKBOOKS_CLIENT_SECRET: "synthetic-worker-secret",
  QUICKBOOKS_ENVIRONMENT: "production", QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-worker-encryption-key-for-tests-only",
};
const staging: NodeJS.ProcessEnv = {
  ...minimal, APP_URL: "https://staging.quotefly.us", API_URL: "https://api-staging.quotefly.us",
  QUICKBOOKS_ENVIRONMENT: "sandbox",
  QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://staging.quotefly.us,https://api-staging.quotefly.us",
};

test("minimal production worker needs no Stripe, Resend, OpenAI, or webhook verifier", () => {
  const parsed = parseQuickBooksWorkerEnv(minimal);
  assert.equal(parsed.NODE_ENV, "production");
  assert.equal(parsed.QUICKBOOKS_OAUTH_ONLY_MODE, false);
  assert.equal(parsed.QUICKBOOKS_CDC_WORKER_ENABLED, false);
  assert.equal(parsed.QUICKBOOKS_PROVIDER_TIMEOUT_MS, 10000);
  assert.equal(parsed.QUICKBOOKS_PROVIDER_READ_RETRIES, 2);
  for (const key of QUICKBOOKS_WORKER_FORBIDDEN_SECRETS) assert.equal(key in parsed, false);
});

test("worker preserves API credential bytes and decrypts legacy JWT envelopes", () => {
  const jwt = `  ${minimal.JWT_SECRET}  `;
  const parsed = parseQuickBooksWorkerEnv({ ...minimal, JWT_SECRET: jwt, QUICKBOOKS_CLIENT_ID: " client-id ", QUICKBOOKS_CLIENT_SECRET: " client-secret " });
  assert.equal(parsed.JWT_SECRET, jwt);
  assert.equal(parsed.QUICKBOOKS_CLIENT_ID, " client-id ");
  assert.equal(parsed.QUICKBOOKS_CLIENT_SECRET, " client-secret ");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(jwt).digest(), iv);
  const encrypted = Buffer.concat([cipher.update("synthetic-legacy-token", "utf8"), cipher.final()]);
  const envelope = [iv, cipher.getAuthTag(), encrypted].map(value => value.toString("base64url")).join(".");
  assert.equal(decryptQuickBooksSecret(parsed, envelope), "synthetic-legacy-token");
});

test("bootstrap rejects forbidden configuration before loading the Prisma-backed runner", async () => {
  let loaded = 0;
  const loader = async () => { loaded++; return { runQuickBooksReconciliationWorker: async () => {} }; };
  await assert.rejects(startQuickBooksReconciliationWorker({ ...minimal, STRIPE_SECRET_KEY: "synthetic-forbidden" }, loader));
  await assert.rejects(startQuickBooksReconciliationWorker({}, loader));
  assert.equal(loaded, 0);
  let ran = false;
  await startQuickBooksReconciliationWorker(minimal, async () => {
    loaded++;
    return { runQuickBooksReconciliationWorker: async env => { ran = true; assert.equal(env.JWT_SECRET, minimal.JWT_SECRET); assert.equal("STRIPE_SECRET_KEY" in env, false); } };
  });
  assert.equal(loaded, 1);
  assert.equal(ran, true);
});

test("worker rejects env files Prisma could implicitly load from its artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "quotefly-worker-artifact-test-"));
  const prisma = join(root, "prisma");
  mkdirSync(prisma);
  try {
    writeFileSync(join(root, ".env.example"), "# safe template");
    assert.doesNotThrow(() => assertQuickBooksWorkerArtifactHasNoEnvFiles(root));
    for (const file of [join(root, ".env"), join(root, ".env.local"), join(prisma, ".env")]) {
      writeFileSync(file, "# synthetic forbidden artifact");
      try { assert.throws(() => assertQuickBooksWorkerArtifactHasNoEnvFiles(root), /QUICKBOOKS_WORKER_ENV_FILE_FORBIDDEN/); }
      finally { unlinkSync(file); }
    }
  } finally {
    unlinkSync(join(root, ".env.example"));
    rmdirSync(prisma);
    rmdirSync(root);
  }
});

test("missing required worker values fail closed and diagnostics contain only keys", () => {
  const required = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "APP_URL", "API_URL", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_ENVIRONMENT", "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY"];
  for (const key of required) {
    const missing = { ...minimal };
    delete missing[key];
    assert.throws(() => parseQuickBooksWorkerEnv(missing), (error: unknown) => error instanceof Error && error.message.includes(key));
  }
  for (const key of ["DATABASE_URL", "APP_URL", "API_URL"]) {
    assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: "never-display-this-malformed-secret" }), (error: unknown) => error instanceof Error && error.message.includes(key) && !error.message.includes("never-display"));
  }
});

test("unrelated provider, webhook, cache and migration credentials are forbidden", () => {
  for (const key of QUICKBOOKS_WORKER_FORBIDDEN_SECRETS) {
    assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: "never-display-this-secret" }), (error: unknown) => error instanceof Error && error.message.includes(key) && !error.message.includes("never-display"));
    assert.doesNotThrow(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: "  " }));
  }
});

test("worker requires both enablement flags and disallows OAuth-only execution", () => {
  for (const key of ["QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED"]) {
    for (const value of ["false", "0", "no", "not-a-boolean"]) assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: value }));
  }
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_OAUTH_ONLY_MODE: "true" }));
  assert.equal(parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_CDC_WORKER_ENABLED: "yes" }).QUICKBOOKS_CDC_WORKER_ENABLED, true);
  assert.equal(parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: " YES " }).QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED, true);
});

test("JWT/encryption keys are sufficiently long and independent including rotation", () => {
  for (const key of ["JWT_SECRET", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS"]) {
    assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: "x".repeat(31) }));
  }
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, JWT_SECRET: "change-me-production-secret-that-is-not-unique" }));
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_TOKEN_ENCRYPTION_KEY: minimal.JWT_SECRET }));
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: minimal.JWT_SECRET }));
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: minimal.QUICKBOOKS_TOKEN_ENCRYPTION_KEY }));
  assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_TOKEN_ENCRYPTION_KEY: ` ${minimal.JWT_SECRET} ` }));
  const old = parseQuickBooksWorkerEnv(minimal);
  const encrypted = encryptQuickBooksSecret(old, "synthetic-provider-token");
  const rotated = parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-new-independent-encryption-key-for-tests", QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: minimal.QUICKBOOKS_TOKEN_ENCRYPTION_KEY });
  assert.equal(decryptQuickBooksSecret(rotated, encrypted), "synthetic-provider-token");
});

test("production DB uses PostgreSQL and the exact runtime role", () => {
  for (const url of ["mysql://quotefly_runtime@db.example.com/test", "https://db.example.com/test", "postgresql://postgres@db.example.com/test", "postgresql://neondb_owner@db.example.com/test"]) {
    assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, DATABASE_URL: url }));
  }
  assert.doesNotThrow(() => parseQuickBooksWorkerEnv({ ...minimal, DATABASE_URL: "postgres://quotefly_runtime@db.example.com/test" }));
  assert.doesNotThrow(() => parseQuickBooksWorkerEnv({ ...minimal, NODE_ENV: "test", DATABASE_URL: "postgresql://postgres@localhost/worker_test" }));
});

test("sandbox production mode requires both explicitly approved bare HTTPS origins", () => {
  assert.doesNotThrow(() => parseQuickBooksWorkerEnv(staging));
  for (const origins of ["", "https://staging.quotefly.us", "https://staging.quotefly.us/path,https://api-staging.quotefly.us", "http://staging.quotefly.us,https://api-staging.quotefly.us", "https://user:secret@staging.quotefly.us,https://api-staging.quotefly.us"]) {
    assert.throws(() => parseQuickBooksWorkerEnv({ ...staging, QUICKBOOKS_SANDBOX_STAGING_ORIGINS: origins }));
  }
});

test("sandbox never binds QuoteFly production hosts, including case and trailing-dot aliases", () => {
  for (const hostname of ["quotefly.us", "www.quotefly.us", "app.quotefly.us", "api.quotefly.us", "API.QUOTEFLY.US", "api.quotefly.us."]) {
    const origin = `https://${hostname}`;
    assert.throws(() => parseQuickBooksWorkerEnv({ ...staging, API_URL: origin, QUICKBOOKS_SANDBOX_STAGING_ORIGINS: `https://staging.quotefly.us,${origin}` }));
  }
});

test("production runtime rejects localhost, insecure transport, credentials and non-origin URLs", () => {
  for (const key of ["APP_URL", "API_URL"]) {
    for (const url of ["https://localhost", "https://localhost.", "https://127.0.0.1", "https://[::1]", "http://api.example.com", "ftp://api.example.com", "https://user:secret@api.example.com", "https://api.example.com/path", "https://api.example.com?secret=value", "https://api.example.com#fragment"]) {
      assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, [key]: url }));
    }
  }
  assert.doesNotThrow(() => parseQuickBooksWorkerEnv({ ...minimal, NODE_ENV: "test", QUICKBOOKS_ENVIRONMENT: "sandbox", APP_URL: "http://localhost:5173", API_URL: "http://localhost:4000" }));
});

test("provider retry and timeout budgets remain bounded", () => {
  for (const timeout of ["0", "999", "30001", "NaN"]) assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_PROVIDER_TIMEOUT_MS: timeout }));
  for (const retries of ["-1", "4", "1.5", "NaN"]) assert.throws(() => parseQuickBooksWorkerEnv({ ...minimal, QUICKBOOKS_PROVIDER_READ_RETRIES: retries }));
});

test("signature verification accepts only its narrow verifier contract", () => {
  const verifier = { QUICKBOOKS_WEBHOOK_VERIFIER: "synthetic-signature-verifier" };
  const body = '{"synthetic":true}';
  const signature = createHmac("sha256", verifier.QUICKBOOKS_WEBHOOK_VERIFIER).update(body).digest("base64");
  assert.equal(verifyQuickBooksWebhookSignature(verifier, body, signature), true);
  assert.equal(verifyQuickBooksWebhookSignature(verifier, `${body} `, signature), false);
  assert.equal(verifyQuickBooksWebhookSignature({ QUICKBOOKS_WEBHOOK_VERIFIER: "" }, body, signature), false);
});
