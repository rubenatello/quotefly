import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const synthetic: NodeJS.ProcessEnv = {
  NODE_ENV: "production", DATABASE_URL: "postgresql://quotefly_runtime@db.example.com/audit_test",
  JWT_SECRET: "synthetic-credential-sentinel-jwt", APP_URL: "https://staging.quotefly.us",
  API_URL: "https://api-staging.quotefly.us", QUICKBOOKS_ENVIRONMENT: "sandbox",
  QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://staging.quotefly.us,https://api-staging.quotefly.us",
  QUICKBOOKS_CLIENT_ID: "synthetic-client-id", QUICKBOOKS_CLIENT_SECRET: "synthetic-credential-sentinel-client",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-credential-sentinel-encryption",
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true", QUICKBOOKS_OAUTH_ONLY_MODE: "false",
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true", QUICKBOOKS_CDC_WORKER_ENABLED: "false",
};
function audit(profile: string, env: NodeJS.ProcessEnv) {
  // Explicit synthetic environment; never inherit a provider credential.
  const result = spawnSync(process.execPath, [resolve("scripts/infrastructure-variable-audit.mjs"), "--profile", profile], { env, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("synthetic-credential-sentinel"), false);
  assert.equal(result.stdout.includes("postgresql://"), false);
  return { code: result.status, report: JSON.parse(result.stdout) };
}
test("worker presence profile matches the narrow initial sandbox configuration", () => {
  assert.equal(audit("quickbooks-worker", synthetic).code, 0);
  assert.equal(audit("quickbooks-worker", { ...synthetic, QUICKBOOKS_CDC_WORKER_ENABLED: "true" }).code, 0);
  for (const key of ["DIRECT_DATABASE_URL", "QUICKBOOKS_WEBHOOK_VERIFIER", "STRIPE_SECRET_KEY", "RESEND_API_KEY", "OPENAI_API_KEY", "TWILIO_AUTH_TOKEN", "RATE_LIMIT_REDIS_URL"]) {
    assert.equal(audit("quickbooks-worker", { ...synthetic, [key]: "synthetic-credential-sentinel-forbidden" }).code, 1, key);
  }
  for (const key of ["QUICKBOOKS_SANDBOX_STAGING_ORIGINS", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY"]) {
    assert.equal(audit("quickbooks-worker", { ...synthetic, [key]: "" }).code, 1, key);
  }
  assert.equal(audit("quickbooks-worker", { ...synthetic, QUICKBOOKS_OAUTH_ONLY_MODE: "true" }).code, 1);
});
test("initial accounting API profile requires verifier while payments and CDC stay off", () => {
  const api = { ...synthetic, QUICKBOOKS_WEBHOOK_VERIFIER: "synthetic-credential-sentinel-verifier",
    QUICKBOOKS_REDIRECT_URI: "https://api-staging.quotefly.us/v1/integrations/quickbooks/callback",
    QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false" };
  assert.equal(audit("quickbooks-staging-accounting", api).code, 0);
  assert.equal(audit("quickbooks-staging-accounting", { ...api, QUICKBOOKS_WEBHOOK_VERIFIER: "" }).code, 1);
  assert.equal(audit("quickbooks-staging-accounting", { ...api, QUICKBOOKS_CDC_WORKER_ENABLED: "true" }).code, 1);
  assert.equal(audit("quickbooks-staging-accounting", { ...api, QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "true" }).code, 1);
});
test("monitor presence profile requires its fixed sender and recipient without QBO secrets", () => {
  const env = { NODE_ENV: "production", DATABASE_URL: synthetic.DATABASE_URL,
    RESEND_API_KEY: "synthetic-credential-sentinel-resend", PASSWORD_RESET_EMAIL_FROM: "ops@example.invalid",
    QUICKBOOKS_ALERT_EMAIL: "recipient@example.invalid", QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL: "staging",
    QUICKBOOKS_MONITOR_ENABLED: "true", QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: "true", QUICKBOOKS_MONITOR_EXPECT_CDC: "false" };
  assert.equal(audit("quickbooks-monitor", env).code, 0);
  assert.equal(audit("quickbooks-monitor", { ...env, JWT_SECRET: "synthetic-credential-sentinel-jwt" }).code, 1);
  assert.equal(audit("quickbooks-monitor", { ...env, QUICKBOOKS_MONITOR_ENABLED: "false" }).code, 1);
});
