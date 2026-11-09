import { z } from "zod";

// This module has no process-level side effects and does not import the API env.
export const QUICKBOOKS_WORKER_FORBIDDEN_SECRETS = [
  "DIRECT_DATABASE_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY", "OPENAI_API_KEY", "OPEN_API_KEY", "TWILIO_AUTH_TOKEN",
  "TWILIO_WEBHOOK_AUTH_TOKEN", "RATE_LIMIT_REDIS_URL", "QUICKBOOKS_WEBHOOK_VERIFIER",
] as const;

const booleanFromEnv = z.preprocess((input) => {
  if (typeof input !== "string") return input;
  const normalized = input.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return input;
}, z.boolean());
const productionHosts = new Set(["quotefly.us", "www.quotefly.us", "app.quotefly.us", "api.quotefly.us"]);
const workerSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32).refine(value => value.trim().length >= 32),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  QUICKBOOKS_SANDBOX_STAGING_ORIGINS: z.string().max(4_096).default(""),
  QUICKBOOKS_CLIENT_ID: z.string().min(1).refine(value => value.trim().length > 0),
  QUICKBOOKS_CLIENT_SECRET: z.string().min(1).refine(value => value.trim().length > 0),
  QUICKBOOKS_ENVIRONMENT: z.enum(["sandbox", "production"]),
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: booleanFromEnv,
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: booleanFromEnv,
  QUICKBOOKS_CDC_WORKER_ENABLED: booleanFromEnv.default(false),
  QUICKBOOKS_OAUTH_ONLY_MODE: booleanFromEnv.default(false),
  QUICKBOOKS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  QUICKBOOKS_PROVIDER_READ_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: z.string().trim().min(32),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: z.string().trim().default(""),
}).superRefine((value, ctx) => {
  const issue = (key: string, message: string) => ctx.addIssue({ code: "custom", path: [key], message });
  if (!value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) issue("QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED", "Provider workflows must be enabled for the worker.");
  if (!value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED) issue("QUICKBOOKS_RECONCILIATION_WORKER_ENABLED", "Reconciliation must be enabled for the worker.");
  if (value.QUICKBOOKS_OAUTH_ONLY_MODE) issue("QUICKBOOKS_OAUTH_ONLY_MODE", "The worker cannot run in OAuth-only mode.");
  if (value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY === value.JWT_SECRET) issue("QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "Encryption and JWT keys must be independent.");
  const previous = value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (previous && (previous.length < 32 || previous === value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY || previous === value.JWT_SECRET)) {
    issue("QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS", "The previous key must be at least 32 characters and independent.");
  }
  const parseUrl = (input: string): URL | null => { try { return new URL(input); } catch { return null; } };
  const database = parseUrl(value.DATABASE_URL);
  if (!database || !["postgres:", "postgresql:"].includes(database.protocol)) issue("DATABASE_URL", "A PostgreSQL database is required.");
  if (value.NODE_ENV === "production" && database?.username !== "quotefly_runtime") issue("DATABASE_URL", "Production workers must use quotefly_runtime.");
  if (value.NODE_ENV === "production" && value.JWT_SECRET.includes("change-me")) issue("JWT_SECRET", "A unique production secret is required.");
  const approved = new Set(value.QUICKBOOKS_SANDBOX_STAGING_ORIGINS.split(",").map(origin => origin.trim()).filter(Boolean));
  for (const origin of approved) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) throw new Error();
    } catch { issue("QUICKBOOKS_SANDBOX_STAGING_ORIGINS", "Approved staging origins must be bare HTTPS origins."); }
  }
  for (const key of ["APP_URL", "API_URL"] as const) {
    const url = parseUrl(value[key]);
    if (!url) { issue(key, "A valid origin is required."); continue; }
    if (!["http:", "https:"].includes(url.protocol)) issue(key, "An HTTP or HTTPS origin is required.");
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) issue(key, "A bare origin is required.");
    if (value.NODE_ENV === "production" && (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.replace(/\.$/, "")))) issue(key, "A non-local HTTPS origin is required.");
    if (value.QUICKBOOKS_ENVIRONMENT === "sandbox") {
      if (productionHosts.has(url.hostname.replace(/\.$/, ""))) issue(key, "Sandbox workflows are forbidden on QuoteFly production origins.");
      if (value.NODE_ENV === "production" && !approved.has(url.origin)) issue(key, "Sandbox workers require explicitly approved staging origins.");
    }
  }
});

export type QuickBooksWorkerEnv = z.infer<typeof workerSchema>;

export function parseQuickBooksWorkerEnv(input: NodeJS.ProcessEnv): QuickBooksWorkerEnv {
  // Report only key names, never values, including for rejected configuration.
  for (const key of QUICKBOOKS_WORKER_FORBIDDEN_SECRETS) {
    if (input[key]?.trim()) throw new Error(`${key} must not be present in the QuickBooks worker.`);
  }
  const parsed = workerSchema.safeParse(input);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "configuration")))].sort();
    throw new Error(`Invalid QuickBooks worker configuration: ${keys.join(", ")}.`);
  }
  return parsed.data;
}
