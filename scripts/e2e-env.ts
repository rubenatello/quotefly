import { config } from "dotenv";

config({ quiet: true });

function appendEnvList(name: string, values: string[]) {
  const existing = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...values]));
  process.env[name] = merged.join(",");
}

export function applyE2eEnv() {
  assertTestDatabaseUrl();
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for E2E. Use a dedicated database such as quotefly_test.");
  }

  const apiPort = process.env.E2E_API_PORT || "4100";
  const webPort = process.env.E2E_WEB_PORT || "4173";

  process.env.NODE_ENV = "test";
  process.env.PORT = apiPort;
  process.env.DATABASE_URL = testDatabaseUrl;
  delete process.env.DIRECT_DATABASE_URL;
  process.env.JWT_SECRET = "e2e-jwt-secret-for-quotefly-launch-readiness";
  process.env.APP_URL = process.env.E2E_WEB_URL || `http://127.0.0.1:${webPort}`;
  process.env.API_URL = process.env.E2E_API_URL || `http://127.0.0.1:${process.env.PORT}`;
  process.env.CORS_ALLOWED_ORIGINS = process.env.APP_URL;
  process.env.SESSION_COOKIE_NAME = "qf_session";
  process.env.SESSION_COOKIE_DOMAIN = "";
  process.env.SESSION_COOKIE_SAME_SITE = "lax";
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  // Browser tests use local fixtures and intercepted provider responses. Never
  // inherit credentials or background-worker flags from a developer's .env.
  for (const name of [
    "OPENAI_API_KEY", "OPEN_API_KEY", "RESEND_API_KEY", "PASSWORD_RESET_EMAIL_FROM",
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_AUTH_TOKEN",
    "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_WEBHOOK_VERIFIER",
    "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS", "QUICKBOOKS_SANDBOX_STAGING_ORIGINS",
    "RATE_LIMIT_REDIS_URL", "AI_RAG_TENANT_ALLOWLIST",
  ]) process.env[name] = "";
  for (const name of [
    "ENABLE_TWILIO_SMS", "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", "QUICKBOOKS_OAUTH_ONLY_MODE",
    "QUICKBOOKS_HOSTED_PAYMENTS_ENABLED", "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED",
    "QUICKBOOKS_CDC_WORKER_ENABLED", "ENABLE_AI_INDEX_WORKER",
    "ENABLE_NOTIFICATION_RETENTION_WORKER", "RATE_LIMIT_REQUIRE_SHARED_STORE",
  ]) process.env[name] = "false";
  process.env.AI_RAG_ROLLOUT_MODE = "off";
  process.env.AI_INDEX_INLINE_REFRESH = "false";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  process.env.STRIPE_SECRET_KEY = ["sk", "test", "quotefly", "e2e"].join("_");
  process.env.STRIPE_WEBHOOK_SECRET = ["whsec", "quotefly", "e2e"].join("_");
  process.env.STRIPE_PRICE_ID_STARTER = "price_test_starter";
  process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF = "quotefly_basic_first_month_half_off";
  process.env.STRIPE_PRICE_ID_PROFESSIONAL = "price_test_professional";
  process.env.STRIPE_PRICE_ID_ENTERPRISE = "price_test_enterprise";
  process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";
  process.env.QUICKBOOKS_REDIRECT_URI = `${process.env.API_URL}/v1/integrations/quickbooks/callback`;
  process.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY = "quickbooks-e2e-encryption-key-v2-value";
  process.env.SUPERUSER_EMAILS = "";
  appendEnvList("SUPERUSER_EMAILS", [
    "superuser-e2e@example.com",
    "superuser-integration@example.com",
  ]);
}

export function assertTestDatabaseUrl() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for E2E.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("E2E database URL must be a valid PostgreSQL URL.");
  }

  const databaseName = parsed.pathname.replace(/^\//, "");
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to run E2E against database "${databaseName}". Use a dedicated test database such as quotefly_test.`,
    );
  }
}
