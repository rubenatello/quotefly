import assert from "node:assert/strict";
import test from "node:test";
import { applyE2eEnv } from "../../scripts/e2e-env";

test("browser-test setup replaces inherited credentials and disables provider work", () => {
  const original = { ...process.env };
  try {
    process.env.TEST_DATABASE_URL = "postgresql://test:test@localhost:5432/quotefly_test";
    const credentials = [
      "DATABASE_URL", "DIRECT_DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY", "OPEN_API_KEY",
      "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "PASSWORD_RESET_EMAIL_FROM",
      "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
      "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS", "QUICKBOOKS_WEBHOOK_VERIFIER",
      "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_AUTH_TOKEN", "RATE_LIMIT_REDIS_URL",
    ];
    for (const name of credentials) process.env[name] = "inherited-provider-secret-sentinel";
    const flags = [
      "ENABLE_TWILIO_SMS", "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", "QUICKBOOKS_OAUTH_ONLY_MODE",
      "QUICKBOOKS_HOSTED_PAYMENTS_ENABLED", "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED",
      "QUICKBOOKS_CDC_WORKER_ENABLED", "ENABLE_AI_INDEX_WORKER", "ENABLE_NOTIFICATION_RETENTION_WORKER",
    ];
    for (const name of flags) process.env[name] = "true";
    process.env.SESSION_COOKIE_DOMAIN = "production.example";
    process.env.PUBLIC_SIGNUP_ENABLED = "false";

    applyE2eEnv();

    for (const name of credentials) assert.notEqual(process.env[name], "inherited-provider-secret-sentinel", name);
    for (const name of flags) assert.equal(process.env[name], "false", name);
    assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
    assert.equal(process.env.DIRECT_DATABASE_URL, undefined);
    assert.equal(process.env.QUICKBOOKS_ENVIRONMENT, "sandbox");
    assert.equal(process.env.SESSION_COOKIE_DOMAIN, "");
    assert.equal(process.env.PUBLIC_SIGNUP_ENABLED, "true");
    assert.equal(process.env.OPENAI_API_KEY, "");
    assert.equal(process.env.RESEND_API_KEY, "");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
  }
});

test("browser-test setup rejects a non-test database before changing the runtime", () => {
  const original = { ...process.env };
  try {
    process.env.TEST_DATABASE_URL = "postgresql://example:example@localhost:5432/quotefly";
    process.env.DATABASE_URL = "unchanged-sentinel";
    assert.throws(() => applyE2eEnv(), /Refusing to run E2E/);
    assert.equal(process.env.DATABASE_URL, "unchanged-sentinel");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
  }
});
