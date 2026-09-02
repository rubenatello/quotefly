#!/usr/bin/env node

/**
 * Presence-only evidence for one QuoteFly runtime profile.
 *
 * This script deliberately does not load .env files, access provider APIs, or
 * print environment values. Its evidence is limited to the current process;
 * it cannot prove remote Railway, Vercel, Neon, or provider configuration.
 */

const SECRET = "secret";
const CONFIGURATION = "configuration";
const ORIGIN = "origin";

const ALL_RUNTIME_SECRETS = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "RATE_LIMIT_REDIS_URL",
  "JWT_SECRET",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WEBHOOK_AUTH_TOKEN",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_WEBHOOK_VERIFIER",
  "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
  "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS",
];

const CLASSIFICATIONS = Object.fromEntries([
  ...ALL_RUNTIME_SECRETS.map((name) => [name, SECRET]),
  ["NODE_ENV", CONFIGURATION],
  ["APP_URL", ORIGIN],
  ["API_URL", ORIGIN],
  ["VITE_API_BASE_URL", ORIGIN],
  ["QUICKBOOKS_CLIENT_ID", CONFIGURATION],
  ["QUICKBOOKS_ENVIRONMENT", CONFIGURATION],
  ["QUICKBOOKS_SANDBOX_STAGING_ORIGINS", ORIGIN],
  ["QUICKBOOKS_REDIRECT_URI", ORIGIN],
  ["QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", CONFIGURATION],
  ["QUICKBOOKS_OAUTH_ONLY_MODE", CONFIGURATION],
  ["QUICKBOOKS_HOSTED_PAYMENTS_ENABLED", CONFIGURATION],
  ["QUICKBOOKS_RECONCILIATION_WORKER_ENABLED", CONFIGURATION],
  ["QUICKBOOKS_CDC_WORKER_ENABLED", CONFIGURATION],
]);

const PROFILES = {
  api: {
    required: ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "APP_URL", "API_URL"],
    forbidden: ["DIRECT_DATABASE_URL"],
  },
  worker: {
    required: ["NODE_ENV", "DATABASE_URL", "JWT_SECRET"],
    forbidden: ["DIRECT_DATABASE_URL"],
  },
  migrations: {
    required: ["NODE_ENV", "DIRECT_DATABASE_URL"],
    forbidden: ALL_RUNTIME_SECRETS.filter((name) => name !== "DIRECT_DATABASE_URL"),
  },
  web: {
    required: ["VITE_API_BASE_URL"],
    forbidden: ALL_RUNTIME_SECRETS,
  },
  quickbooks: {
    required: [
      "NODE_ENV",
      "DATABASE_URL",
      "JWT_SECRET",
      "QUICKBOOKS_CLIENT_ID",
      "QUICKBOOKS_CLIENT_SECRET",
      "QUICKBOOKS_ENVIRONMENT",
      "QUICKBOOKS_REDIRECT_URI",
      "QUICKBOOKS_WEBHOOK_VERIFIER",
      "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
      "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED",
      "QUICKBOOKS_OAUTH_ONLY_MODE",
    ],
    forbidden: ["DIRECT_DATABASE_URL"],
  },
  "quickbooks-oauth": {
    required: [
      "NODE_ENV",
      "DATABASE_URL",
      "JWT_SECRET",
      "QUICKBOOKS_CLIENT_ID",
      "QUICKBOOKS_CLIENT_SECRET",
      "QUICKBOOKS_ENVIRONMENT",
      "QUICKBOOKS_REDIRECT_URI",
      "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
      "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED",
      "QUICKBOOKS_OAUTH_ONLY_MODE",
    ],
    forbidden: [
      "DIRECT_DATABASE_URL",
      "QUICKBOOKS_WEBHOOK_VERIFIER",
    ],
  },
};

function usage() {
  process.stdout.write(
    "Usage: node scripts/infrastructure-variable-audit.mjs --profile <api|worker|migrations|web|quickbooks|quickbooks-oauth>\n"
    + "Emits current-process presence metadata only; it never prints environment values.\n",
  );
}

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  usage();
  process.exit(0);
}

if (args.length !== 2 || args[0] !== "--profile" || !(args[1] in PROFILES)) {
  process.stderr.write("Invalid audit profile. Use --help for the fixed profile list.\n");
  process.exit(2);
}

const profile = args[1];
const registry = PROFILES[profile];
const describe = (name) => ({
  name,
  classification: CLASSIFICATIONS[name] ?? CONFIGURATION,
  status: process.env[name]?.trim() ? "configured" : "missing",
});
const required = registry.required.map(describe);
const forbidden = registry.forbidden.map(describe);
const outcome = required.every((entry) => entry.status === "configured")
  && forbidden.every((entry) => entry.status === "missing")
  ? "pass"
  : "fail";

process.stdout.write(`${JSON.stringify({
  schema: "quotefly.infrastructure-variable-audit/v1",
  evidenceScope: "current-runtime-only",
  profile,
  outcome,
  required,
  forbidden,
}, null, 2)}\n`);
process.exitCode = outcome === "pass" ? 0 : 1;
