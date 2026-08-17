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

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.JWT_SECRET ||= "test-jwt-secret-for-quotefly-integration-suite";
process.env.APP_URL ||= "http://localhost:5173";
process.env.API_URL ||= "http://localhost:4000";
process.env.CORS_ALLOWED_ORIGINS ||= "http://localhost:5173";
// Integration tests must never inherit a developer or CI provider secret.
// Provider behavior is injected explicitly where a test needs it.
process.env.OPENAI_API_KEY = "";
process.env.STRIPE_SECRET_KEY ||= "sk_test_quotefly_integration";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_quotefly_integration";
process.env.STRIPE_PRICE_ID_STARTER ||= "price_test_starter";
process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF ||= "quotefly_basic_first_month_half_off";
process.env.STRIPE_PRICE_ID_PROFESSIONAL ||= "price_test_professional";
process.env.STRIPE_PRICE_ID_ENTERPRISE ||= "price_test_enterprise";
process.env.QUICKBOOKS_CLIENT_ID ||= "quickbooks-integration-client";
process.env.QUICKBOOKS_CLIENT_SECRET ||= "quickbooks-integration-secret";
process.env.QUICKBOOKS_ENVIRONMENT ||= "sandbox";
process.env.QUICKBOOKS_WEBHOOK_VERIFIER ||= "quotefly-integration-webhook-verifier";
process.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY ||= "quickbooks-integration-encryption-key-v2";
process.env.ENABLE_TWILIO_SMS = "true";
process.env.TWILIO_WEBHOOK_AUTH_TOKEN ||= "twilio-integration-webhook-auth-token";
appendEnvList("SUPERUSER_EMAILS", ["superuser-integration@example.com"]);

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
