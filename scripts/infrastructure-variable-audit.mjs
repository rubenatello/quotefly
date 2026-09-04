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

const QUICKBOOKS_BASE_REQUIRED = [
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "APP_URL",
  "API_URL",
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_ENVIRONMENT",
  "QUICKBOOKS_REDIRECT_URI",
  "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
];

const quickBooksProfile = ({
  environment = ["sandbox", "production"],
  oauthOnly,
  hostedPayments,
  reconciliation,
  cdc,
}) => ({
  required: [
    ...QUICKBOOKS_BASE_REQUIRED,
    ...(reconciliation ? ["QUICKBOOKS_WEBHOOK_VERIFIER"] : []),
    "QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED",
    "QUICKBOOKS_OAUTH_ONLY_MODE",
    "QUICKBOOKS_HOSTED_PAYMENTS_ENABLED",
    "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED",
    "QUICKBOOKS_CDC_WORKER_ENABLED",
  ],
  forbidden: [
    "DIRECT_DATABASE_URL",
    ...(!reconciliation ? ["QUICKBOOKS_WEBHOOK_VERIFIER"] : []),
  ],
  expected: {
    QUICKBOOKS_ENVIRONMENT: environment,
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: ["true"],
    QUICKBOOKS_OAUTH_ONLY_MODE: [oauthOnly ? "true" : "false"],
    QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: [hostedPayments ? "true" : "false"],
    QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: [reconciliation ? "true" : "false"],
    QUICKBOOKS_CDC_WORKER_ENABLED: [cdc ? "true" : "false"],
  },
});

const QUICKBOOKS_FULL_PROFILE = quickBooksProfile({
  oauthOnly: false,
  hostedPayments: true,
  reconciliation: true,
  cdc: true,
});

const QUICKBOOKS_PROFILE_NAMES = new Set([
  "quickbooks-oauth",
  "quickbooks-reconciliation",
  "quickbooks-cdc",
  "quickbooks-hosted-payments",
  "quickbooks",
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
  "quickbooks-oauth": quickBooksProfile({
    environment: ["sandbox"],
    oauthOnly: true,
    hostedPayments: false,
    reconciliation: false,
    cdc: false,
  }),
  "quickbooks-reconciliation": quickBooksProfile({
    oauthOnly: false,
    hostedPayments: false,
    reconciliation: true,
    cdc: false,
  }),
  "quickbooks-cdc": quickBooksProfile({
    oauthOnly: false,
    hostedPayments: false,
    reconciliation: true,
    cdc: true,
  }),
  "quickbooks-hosted-payments": QUICKBOOKS_FULL_PROFILE,
  // Backward-compatible alias for the complete hosted-payments runtime.
  quickbooks: QUICKBOOKS_FULL_PROFILE,
};

function usage() {
  process.stdout.write(
    "Usage: node scripts/infrastructure-variable-audit.mjs --profile <api|worker|migrations|web|quickbooks-oauth|quickbooks-reconciliation|quickbooks-cdc|quickbooks-hosted-payments|quickbooks>\n"
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
const requiredNames = [...registry.required];
if (
  QUICKBOOKS_PROFILE_NAMES.has(profile)
  && process.env.QUICKBOOKS_ENVIRONMENT?.trim() === "sandbox"
) {
  requiredNames.push("QUICKBOOKS_SANDBOX_STAGING_ORIGINS");
}
const describe = (name) => {
  const configuredValue = process.env[name]?.trim();
  const expectedValues = registry.expected?.[name];
  return {
    name,
    classification: CLASSIFICATIONS[name] ?? CONFIGURATION,
    status: configuredValue ? "configured" : "missing",
    ...(expectedValues
      ? { expectationStatus: configuredValue && expectedValues.includes(configuredValue) ? "matched" : "mismatched" }
      : {}),
  };
};
const describeForbidden = (name) => ({
  name,
  classification: CLASSIFICATIONS[name] ?? CONFIGURATION,
  status: process.env[name]?.trim() ? "configured" : "missing",
});
const required = requiredNames.map(describe);
const forbidden = registry.forbidden.map(describeForbidden);
const outcome = required.every((entry) => entry.status === "configured")
  && required.every((entry) => entry.expectationStatus === undefined || entry.expectationStatus === "matched")
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
