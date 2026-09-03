import { config } from "dotenv";

config({ quiet: true });

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
// Migration credentials must not leak into the API runtime fixtures exercised by
// integration tests. Tests that verify the production rejection add it explicitly.
delete process.env.DIRECT_DATABASE_URL;
process.env.JWT_SECRET = "test-jwt-secret-for-quotefly-integration-suite";
process.env.APP_URL = "http://localhost:5173";
process.env.API_URL = "http://localhost:4000";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";
process.env.PUBLIC_SIGNUP_ENABLED = "true";
// Integration tests must never inherit a developer or CI provider secret.
// Provider behavior is injected explicitly where a test needs it.
process.env.OPENAI_API_KEY = "";
process.env.RESEND_API_KEY = "";
process.env.PASSWORD_RESET_EMAIL_FROM = "";
process.env.STRIPE_SECRET_KEY = ["sk", "test", "quotefly", "integration"].join("_");
process.env.STRIPE_WEBHOOK_SECRET = ["whsec", "quotefly", "integration"].join("_");
process.env.STRIPE_PRICE_ID_STARTER = "price_test_starter";
process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF = "quotefly_basic_first_month_half_off";
process.env.STRIPE_PRICE_ID_PROFESSIONAL = "price_test_professional";
process.env.STRIPE_PRICE_ID_ENTERPRISE = "price_test_enterprise";
process.env.QUICKBOOKS_CLIENT_ID = "quickbooks-integration-client";
process.env.QUICKBOOKS_CLIENT_SECRET = "quickbooks-integration-secret";
process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";
process.env.QUICKBOOKS_REDIRECT_URI = "http://localhost:4000/v1/integrations/quickbooks/callback";
// QuickBooks route integration coverage exercises the explicitly enabled
// workflow path. Individual containment tests override app.env to cover the
// production-safe default-off behavior.
process.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = "true";
process.env.QUICKBOOKS_OAUTH_ONLY_MODE = "false";
process.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED = "false";
process.env.QUICKBOOKS_CDC_WORKER_ENABLED = "false";
process.env.QUICKBOOKS_WEBHOOK_VERIFIER = "quotefly-integration-webhook-verifier";
process.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED = "true";
process.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY = "quickbooks-integration-encryption-key-v2";
process.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS = "";
process.env.ENABLE_TWILIO_SMS = "true";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.TWILIO_WEBHOOK_AUTH_TOKEN = "twilio-integration-webhook-auth-token";
process.env.RATE_LIMIT_REDIS_URL = "";
// The integration suite exercises the governed retrieval path with provider
// calls stubbed at the route boundary. Keep RAG enabled here without inheriting
// a developer OpenAI secret.
process.env.AI_RAG_ROLLOUT_MODE = "all";
process.env.ENABLE_AI_INDEX_WORKER = "false";
process.env.ENABLE_NOTIFICATION_RETENTION_WORKER = "false";
process.env.SUPERUSER_EMAILS = "superuser-integration@example.com";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL or TEST_DATABASE_URL is required for integration tests.");
}

let parsedDatabaseUrl: URL;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("DATABASE_URL must be a valid PostgreSQL URL for integration tests.");
}

const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, "");
if (!databaseName.toLowerCase().includes("test")) {
  throw new Error(
    `Refusing to run integration tests against database "${databaseName}". Use a dedicated test database such as quotefly_test.`,
  );
}
