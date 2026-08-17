import { z } from "zod";

const DEFAULT_JWT_SECRET = "change-me-in-production-must-be-32-chars-min";

const BooleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return value;
}, z.boolean());

const OptionalUrlFromEnv = z.union([z.string().url(), z.literal("")]).default("");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  RATE_LIMIT_REDIS_URL: z.string().default(""),
  RATE_LIMIT_REQUIRE_SHARED_STORE: BooleanFromEnv.default(false),
  JWT_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_ASSISTANT_MODEL: z.string().default(""),
  OPENAI_ASSISTANT_COMPOSITION_ENABLED: BooleanFromEnv.default(true),
  OPENAI_ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  ENABLE_AI_INDEX_WORKER: BooleanFromEnv.default(false),
  AI_INDEX_INLINE_REFRESH: BooleanFromEnv.default(true),
  OPENAI_COST_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0.15),
  OPENAI_COST_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0.6),
  OPENAI_EMBEDDING_COST_PER_1M_USD: z.coerce.number().nonnegative().default(0.02),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_ID_STARTER: z.string().default(""),
  STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF: z.string().default(""),
  STRIPE_PRICE_ID_PROFESSIONAL: z.string().default(""),
  STRIPE_PRICE_ID_ENTERPRISE: z.string().default(""),
  SUPERUSER_EMAILS: z.string().default(""),
  APP_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  RESEND_API_KEY: z.string().default(""),
  PASSWORD_RESET_EMAIL_FROM: z.string().default(""),
  SUPPORT_EMAIL: z.string().trim().email().default("support@quotefly.us"),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(10).max(60).default(30),
  SESSION_COOKIE_NAME: z.string().min(1).default("qf_session"),
  SESSION_COOKIE_DOMAIN: z.string().default(""),
  SESSION_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  QUICKBOOKS_CLIENT_ID: z.string().default(""),
  QUICKBOOKS_CLIENT_SECRET: z.string().default(""),
  QUICKBOOKS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
  QUICKBOOKS_REDIRECT_URI: OptionalUrlFromEnv,
  QUICKBOOKS_WEBHOOK_VERIFIER: z.string().default(""),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: z.string().default(""),
  ENABLE_TWILIO_SMS: BooleanFromEnv.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WEBHOOK_AUTH_TOKEN: z.string().default(""),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") return;

  let runtimeDatabaseUrl: URL | null = null;
  try {
    runtimeDatabaseUrl = new URL(value.DATABASE_URL);
  } catch {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL must be a valid PostgreSQL connection URL.",
    });
  }
  if (runtimeDatabaseUrl?.username !== "quotefly_runtime") {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "Production DATABASE_URL must use the dedicated quotefly_runtime role so AI retrieval RLS cannot be bypassed.",
    });
  }
  if (value.DIRECT_DATABASE_URL?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["DIRECT_DATABASE_URL"],
      message: "DIRECT_DATABASE_URL must not be present in the production API runtime; provide it only to the isolated migration job.",
    });
  }
  const rateLimitRedisUrl = value.RATE_LIMIT_REDIS_URL.trim();
  if (rateLimitRedisUrl) {
    try {
      const parsedRateLimitUrl = new URL(rateLimitRedisUrl);
      if (parsedRateLimitUrl.protocol !== "redis:" && parsedRateLimitUrl.protocol !== "rediss:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_REDIS_URL"],
        message: "RATE_LIMIT_REDIS_URL must be a valid redis:// or rediss:// connection URL.",
      });
    }
  }
  if (value.RATE_LIMIT_REQUIRE_SHARED_STORE && !rateLimitRedisUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["RATE_LIMIT_REDIS_URL"],
      message: "RATE_LIMIT_REDIS_URL is required when shared rate limiting is enforced.",
    });
  }
  if (value.JWT_SECRET === DEFAULT_JWT_SECRET || value.JWT_SECRET.includes("change-me")) {
    ctx.addIssue({
      code: "custom",
      path: ["JWT_SECRET"],
      message: "JWT_SECRET must be set to a unique production secret.",
    });
  }

  for (const key of ["APP_URL", "API_URL"] as const) {
    const url = new URL(value[key]);
    const hostname = url.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must be a production URL when NODE_ENV=production.`,
      });
    }

    if (url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must use HTTPS when NODE_ENV=production.`,
      });
    }

    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must be a bare production origin without credentials, a path, query, or fragment.`,
      });
    }
  }

  if (value.SESSION_COOKIE_SAME_SITE === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["SESSION_COOKIE_SAME_SITE"],
      message: "SESSION_COOKIE_SAME_SITE=none is not allowed until explicit CSRF protection is implemented.",
    });
  }

  if (Boolean(value.RESEND_API_KEY) !== Boolean(value.PASSWORD_RESET_EMAIL_FROM.trim())) {
    ctx.addIssue({
      code: "custom",
      path: [value.RESEND_API_KEY ? "PASSWORD_RESET_EMAIL_FROM" : "RESEND_API_KEY"],
      message: "RESEND_API_KEY and PASSWORD_RESET_EMAIL_FROM must be configured together.",
    });
  }

  const quickBooksClientConfigured = Boolean(value.QUICKBOOKS_CLIENT_ID.trim());
  const quickBooksSecretConfigured = Boolean(value.QUICKBOOKS_CLIENT_SECRET.trim());
  if (quickBooksClientConfigured !== quickBooksSecretConfigured) {
    ctx.addIssue({
      code: "custom",
      path: [quickBooksClientConfigured ? "QUICKBOOKS_CLIENT_SECRET" : "QUICKBOOKS_CLIENT_ID"],
      message: "QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be configured together.",
    });
  }

  const quickBooksEncryptionKey = value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim();
  const quickBooksPreviousEncryptionKey = value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS.trim();
  if (quickBooksClientConfigured && quickBooksSecretConfigured && quickBooksEncryptionKey.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY"],
      message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY must be at least 32 characters when QuickBooks is configured.",
    });
  }
  if (quickBooksEncryptionKey && quickBooksEncryptionKey === value.JWT_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY"],
      message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY must be independent from JWT_SECRET.",
    });
  }
  if (quickBooksPreviousEncryptionKey) {
    if (quickBooksPreviousEncryptionKey.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS"],
        message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS must be at least 32 characters when provided.",
      });
    }
    if (!quickBooksEncryptionKey) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY"],
        message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY is required when a previous rotation key is configured.",
      });
    }
    if (
      quickBooksPreviousEncryptionKey === quickBooksEncryptionKey ||
      quickBooksPreviousEncryptionKey === value.JWT_SECRET
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS"],
        message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS must be independent from current encryption and JWT keys.",
      });
    }
  }

  const requiredPaidLaunchValues = [
    ["STRIPE_SECRET_KEY", value.STRIPE_SECRET_KEY, /^(?:sk|rk)_(?:test|live)_/],
    ["STRIPE_WEBHOOK_SECRET", value.STRIPE_WEBHOOK_SECRET, /^whsec_/],
    ["STRIPE_PRICE_ID_STARTER", value.STRIPE_PRICE_ID_STARTER, /^price_/],
    [
      "STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF",
      value.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF,
      /\S/,
    ],
    ["RESEND_API_KEY", value.RESEND_API_KEY, /\S/],
    ["PASSWORD_RESET_EMAIL_FROM", value.PASSWORD_RESET_EMAIL_FROM, /\S/],
  ] as const;
  for (const [key, configuredValue, expectedPattern] of requiredPaidLaunchValues) {
    if (!configuredValue.trim() || !expectedPattern.test(configuredValue.trim())) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must be configured for a paid production launch.`,
      });
    }
  }

  const configuredPriceIds = [
    value.STRIPE_PRICE_ID_STARTER,
    value.STRIPE_PRICE_ID_PROFESSIONAL,
    value.STRIPE_PRICE_ID_ENTERPRISE,
  ].filter(Boolean);
  if (new Set(configuredPriceIds).size !== configuredPriceIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_PRICE_ID_STARTER"],
      message: "Configured Stripe plan price ids must be unique.",
    });
  }

  if (value.ENABLE_TWILIO_SMS) {
    ctx.addIssue({
      code: "custom",
      path: ["ENABLE_TWILIO_SMS"],
      message: "ENABLE_TWILIO_SMS cannot be enabled in production until sender authorization is implemented.",
    });
  }
});

export function parseEnv(input: NodeJS.ProcessEnv) {
  return EnvSchema.parse({
    ...input,
    OPENAI_API_KEY: input.OPENAI_API_KEY ?? input.OPEN_API_KEY ?? "",
  });
}

export const env = parseEnv(process.env);
