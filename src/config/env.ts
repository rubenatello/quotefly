import { z } from "zod";
import { AI_RAG_ROLLOUT_MODES, parseAiRagTenantAllowlist } from "../lib/ai-rag-rollout";

const DEFAULT_JWT_SECRET = "change-me-in-production-must-be-32-chars-min";
const APPROVED_OPENAI_PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
} as const;

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
  AI_RAG_ROLLOUT_MODE: z.enum(AI_RAG_ROLLOUT_MODES).default("all"),
  AI_RAG_TENANT_ALLOWLIST: z.string().max(8_192).default(""),
  ENABLE_AI_INDEX_WORKER: BooleanFromEnv.default(false),
  AI_INDEX_INLINE_REFRESH: BooleanFromEnv.default(true),
  ENABLE_NOTIFICATION_RETENTION_WORKER: BooleanFromEnv.default(false),
  NOTIFICATION_RETENTION_READ_DAYS: z.coerce.number().int().min(30).max(3_650).default(90),
  NOTIFICATION_RETENTION_UNREAD_DAYS: z.coerce.number().int().min(180).max(3_650).default(365),
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
  PUBLIC_SIGNUP_ENABLED: BooleanFromEnv.default(true),
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
  QUICKBOOKS_SANDBOX_STAGING_ORIGINS: z.string().max(4_096).default(""),
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: BooleanFromEnv.default(false),
  QUICKBOOKS_OAUTH_ONLY_MODE: BooleanFromEnv.default(false),
  QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: BooleanFromEnv.default(false),
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: BooleanFromEnv.default(false),
  QUICKBOOKS_CDC_WORKER_ENABLED: BooleanFromEnv.default(false),
  QUICKBOOKS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  QUICKBOOKS_PROVIDER_READ_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  QUICKBOOKS_REDIRECT_URI: OptionalUrlFromEnv,
  QUICKBOOKS_WEBHOOK_VERIFIER: z.string().default(""),
  QUICKBOOKS_MONITOR_BEARER: z.string().max(4_096).default(""),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: z.string().default(""),
  QUICKBOOKS_API_SIGNAL_INGEST_URL: OptionalUrlFromEnv,
  QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN: z.string().max(4_096).default(""),
  QUICKBOOKS_WORKER_SIGNAL_INGEST_URL: OptionalUrlFromEnv,
  QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN: z.string().max(4_096).default(""),
  QUICKBOOKS_SIGNAL_INGEST_TIMEOUT_MS: z.coerce.number().int().min(250).max(3_000).default(1_250),
  ENABLE_TWILIO_SMS: BooleanFromEnv.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WEBHOOK_AUTH_TOKEN: z.string().default(""),
}).superRefine((value, ctx) => {
  if (value.NOTIFICATION_RETENTION_UNREAD_DAYS <= value.NOTIFICATION_RETENTION_READ_DAYS) {
    ctx.addIssue({
      code: "custom",
      path: ["NOTIFICATION_RETENTION_UNREAD_DAYS"],
      message: "Unread notification retention must be longer than read notification retention.",
    });
  }
  const ragAllowlist = parseAiRagTenantAllowlist(value.AI_RAG_TENANT_ALLOWLIST);
  if (ragAllowlist.invalidTenantIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["AI_RAG_TENANT_ALLOWLIST"],
      message: "AI_RAG_TENANT_ALLOWLIST must contain only comma-separated tenant ids.",
    });
  }
  if (
    (value.AI_RAG_ROLLOUT_MODE === "allowlist" || value.AI_RAG_ROLLOUT_MODE === "shadow_allowlist")
    && ragAllowlist.tenantIds.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["AI_RAG_TENANT_ALLOWLIST"],
      message: "AI_RAG_TENANT_ALLOWLIST must contain at least one tenant id for allowlist rollout modes.",
    });
  }
  if (value.AI_RAG_ROLLOUT_MODE === "off" && value.ENABLE_AI_INDEX_WORKER) {
    ctx.addIssue({
      code: "custom",
      path: ["ENABLE_AI_INDEX_WORKER"],
      message: "ENABLE_AI_INDEX_WORKER cannot be enabled while AI_RAG_ROLLOUT_MODE=off.",
    });
  }
  if (
    value.AI_RAG_ROLLOUT_MODE !== "off"
    && !value.AI_INDEX_INLINE_REFRESH
    && !value.ENABLE_AI_INDEX_WORKER
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["AI_INDEX_INLINE_REFRESH"],
      message: "Enabled RAG requires AI_INDEX_INLINE_REFRESH=true or ENABLE_AI_INDEX_WORKER=true.",
    });
  }

  // Provider feature dependencies are runtime invariants, not production-only
  // recommendations. Validate them in development and test as well so a
  // mutable deployment flag cannot expose a workflow without its recovery
  // path.
  const quickBooksClientConfigured = Boolean(value.QUICKBOOKS_CLIENT_ID.trim());
  const quickBooksSecretConfigured = Boolean(value.QUICKBOOKS_CLIENT_SECRET.trim());
  if (quickBooksClientConfigured !== quickBooksSecretConfigured) {
    ctx.addIssue({
      code: "custom",
      path: [quickBooksClientConfigured ? "QUICKBOOKS_CLIENT_SECRET" : "QUICKBOOKS_CLIENT_ID"],
      message: "QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be configured together.",
    });
  }
  if (value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED && (!quickBooksClientConfigured || !quickBooksSecretConfigured)) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED"],
      message: "QuickBooks client credentials must be configured before provider workflows can be enabled.",
    });
  }
  if (value.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED && !value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_HOSTED_PAYMENTS_ENABLED"],
      message: "QuickBooks provider workflows must be enabled before hosted payments can be enabled.",
    });
  }
  if (
    (value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED || value.QUICKBOOKS_CDC_WORKER_ENABLED)
    && !value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED
  ) {
    ctx.addIssue({
      code: "custom",
      path: [value.QUICKBOOKS_CDC_WORKER_ENABLED
        ? "QUICKBOOKS_CDC_WORKER_ENABLED"
        : "QUICKBOOKS_RECONCILIATION_WORKER_ENABLED"],
      message: "QuickBooks workers require provider workflows to be enabled.",
    });
  }
  if (value.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED && !value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_HOSTED_PAYMENTS_ENABLED"],
      message: "QuickBooks hosted payments require the reconciliation worker to be enabled.",
    });
  }
  if (value.QUICKBOOKS_CDC_WORKER_ENABLED && !value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_CDC_WORKER_ENABLED"],
      message: "QuickBooks CDC recovery requires the reconciliation worker to be enabled.",
    });
  }
  if (
    (value.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED || value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED)
    && !value.QUICKBOOKS_WEBHOOK_VERIFIER.trim()
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_WEBHOOK_VERIFIER"],
      message: "A QuickBooks webhook verifier is required for hosted payments and reconciliation workers.",
    });
  }
  if (value.QUICKBOOKS_OAUTH_ONLY_MODE && !value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_OAUTH_ONLY_MODE"],
      message: "QuickBooks OAuth-only mode requires provider workflows so the connection handshake can run.",
    });
  }
  if (value.QUICKBOOKS_OAUTH_ONLY_MODE && value.QUICKBOOKS_ENVIRONMENT === "production") {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_OAUTH_ONLY_MODE"],
      message: "QuickBooks OAuth-only mode is restricted to sandbox staging; production connections require autonomous revocation recovery.",
    });
  }
  if (
    value.QUICKBOOKS_OAUTH_ONLY_MODE
    && (
      value.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED
      || value.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED
      || value.QUICKBOOKS_CDC_WORKER_ENABLED
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_OAUTH_ONLY_MODE"],
      message: "QuickBooks hosted payments and workers must remain disabled in OAuth-only mode.",
    });
  }
  if (value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
    const expectedRedirectUri = new URL(
      "/v1/integrations/quickbooks/callback",
      value.API_URL,
    ).toString();
    const effectiveRedirectUri = value.QUICKBOOKS_REDIRECT_URI.trim() || expectedRedirectUri;
    if (effectiveRedirectUri !== expectedRedirectUri) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_REDIRECT_URI"],
        message: `QUICKBOOKS_REDIRECT_URI must exactly match ${expectedRedirectUri} when QuickBooks provider workflows are enabled.`,
      });
    }
  }
  const quickBooksEncryptionKey = value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim();
  const quickBooksPreviousEncryptionKey = value.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS.trim();
  const quickBooksMonitorBearer = value.QUICKBOOKS_MONITOR_BEARER.trim();
  if (quickBooksMonitorBearer && quickBooksMonitorBearer.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_MONITOR_BEARER"],
      message: "QUICKBOOKS_MONITOR_BEARER must be at least 32 characters when configured.",
    });
  }
  if (
    quickBooksMonitorBearer
    && [
      value.JWT_SECRET,
      value.QUICKBOOKS_CLIENT_SECRET,
      value.QUICKBOOKS_WEBHOOK_VERIFIER,
      quickBooksEncryptionKey,
      quickBooksPreviousEncryptionKey,
    ].some((secret) => secret.trim() && secret.trim() === quickBooksMonitorBearer)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_MONITOR_BEARER"],
      message: "QUICKBOOKS_MONITOR_BEARER must be independent from application and provider secrets.",
    });
  }
  if (value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED && quickBooksEncryptionKey.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY"],
      message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY must be at least 32 characters and independent from JWT_SECRET when QuickBooks provider workflows are enabled.",
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
      quickBooksPreviousEncryptionKey === quickBooksEncryptionKey
      || quickBooksPreviousEncryptionKey === value.JWT_SECRET
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS"],
        message: "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS must be independent from current encryption and JWT keys.",
      });
    }
  }
  const quickBooksSignalSinks = [
    {
      runtimeRole: "API",
      urlKey: "QUICKBOOKS_API_SIGNAL_INGEST_URL",
      tokenKey: "QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN",
    },
    {
      runtimeRole: "worker",
      urlKey: "QUICKBOOKS_WORKER_SIGNAL_INGEST_URL",
      tokenKey: "QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN",
    },
  ] as const;
  for (const sink of quickBooksSignalSinks) {
    const ingestUrl = value[sink.urlKey].trim();
    const sourceToken = value[sink.tokenKey].trim();
    if (Boolean(ingestUrl) !== Boolean(sourceToken)) {
      ctx.addIssue({
        code: "custom",
        path: [ingestUrl ? sink.tokenKey : sink.urlKey],
        message: `QuickBooks ${sink.runtimeRole} signal ingest URL and source token must be configured together.`,
      });
      continue;
    }
    if (!ingestUrl) continue;
    const parsedIngestUrl = new URL(ingestUrl);
    if (
      parsedIngestUrl.protocol !== "https:"
      || parsedIngestUrl.username
      || parsedIngestUrl.password
      || parsedIngestUrl.search
      || parsedIngestUrl.hash
    ) {
      ctx.addIssue({
        code: "custom",
        path: [sink.urlKey],
        message: `QuickBooks ${sink.runtimeRole} signal ingest URL must use HTTPS without credentials, a query, or a fragment.`,
      });
    }
  }
  const quickBooksSignalSourceTokens = [
    {
      key: "QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN",
      value: value.QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN.trim(),
      peer: value.QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN.trim(),
    },
    {
      key: "QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN",
      value: value.QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN.trim(),
      peer: value.QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN.trim(),
    },
  ] as const;
  for (const sourceToken of quickBooksSignalSourceTokens) {
    if (!sourceToken.value) continue;
    if (sourceToken.value.length < 16 || /\s/.test(sourceToken.value)) {
      ctx.addIssue({
        code: "custom",
        path: [sourceToken.key],
        message: `${sourceToken.key} must be at least 16 characters without whitespace when configured.`,
      });
    }
    if (
      [
        value.JWT_SECRET,
        value.QUICKBOOKS_CLIENT_SECRET,
        value.QUICKBOOKS_WEBHOOK_VERIFIER,
        quickBooksMonitorBearer,
        quickBooksEncryptionKey,
        quickBooksPreviousEncryptionKey,
        sourceToken.peer,
      ].some((secret) => secret.trim() && secret.trim() === sourceToken.value)
    ) {
      ctx.addIssue({
        code: "custom",
        path: [sourceToken.key],
        message: `${sourceToken.key} must be independent from application, provider, monitor, and peer signal-source secrets.`,
      });
    }
  }
  if (
    value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED
    && value.QUICKBOOKS_ENVIRONMENT === "sandbox"
  ) {
    const quoteFlyProductionHosts = new Set([
      "quotefly.us",
      "www.quotefly.us",
      "app.quotefly.us",
      "api.quotefly.us",
    ]);
    const runtimeOrigins = [new URL(value.APP_URL).origin, new URL(value.API_URL).origin];
    if (runtimeOrigins.some((origin) => quoteFlyProductionHosts.has(new URL(origin).hostname))) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_ENVIRONMENT"],
        message: "QuickBooks sandbox workflows are forbidden on QuoteFly production origins.",
      });
    }
  }
  if (value.NODE_ENV !== "production") return;

  if (value.AI_RAG_ROLLOUT_MODE !== "off" && !value.OPENAI_API_KEY.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENAI_API_KEY"],
      message: "OPENAI_API_KEY is required before production RAG can be enabled.",
    });
  }

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

  if (value.OPENAI_API_KEY.trim()) {
    const chatModels = [value.OPENAI_MODEL, value.OPENAI_ASSISTANT_MODEL || value.OPENAI_MODEL];
    for (const model of chatModels) {
      const approved = APPROVED_OPENAI_PRICING[model as keyof typeof APPROVED_OPENAI_PRICING];
      if (
        !approved
        || approved.output <= 0
        || value.OPENAI_COST_INPUT_PER_1M_USD !== approved.input
        || value.OPENAI_COST_OUTPUT_PER_1M_USD !== approved.output
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENAI_MODEL"],
          message: "Configured OpenAI chat models and rates must match the approved pricing catalog.",
        });
        break;
      }
    }
    const embedding = APPROVED_OPENAI_PRICING[
      value.OPENAI_EMBEDDING_MODEL as keyof typeof APPROVED_OPENAI_PRICING
    ];
    if (
      !embedding
      || embedding.input <= 0
      || value.OPENAI_EMBEDDING_COST_PER_1M_USD !== embedding.input
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_EMBEDDING_MODEL"],
        message: "Configured OpenAI embedding model and rate must match the approved pricing catalog.",
      });
    }
  }

  if (value.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED && value.NODE_ENV === "production") {
    if (value.QUICKBOOKS_ENVIRONMENT === "sandbox") {
      const runtimeOrigins = [new URL(value.APP_URL).origin, new URL(value.API_URL).origin];
      const sandboxStagingOrigins = new Set(
        value.QUICKBOOKS_SANDBOX_STAGING_ORIGINS
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      );
      const malformedApprovedOrigin = [...sandboxStagingOrigins].some((origin) => {
        try {
          const parsed = new URL(origin);
          return parsed.protocol !== "https:" || parsed.origin !== origin || Boolean(parsed.username || parsed.password);
        } catch {
          return true;
        }
      });
      if (malformedApprovedOrigin) {
        ctx.addIssue({
          code: "custom",
          path: ["QUICKBOOKS_SANDBOX_STAGING_ORIGINS"],
          message: "QUICKBOOKS_SANDBOX_STAGING_ORIGINS must contain only comma-separated bare HTTPS origins.",
        });
      }
      if (runtimeOrigins.some((origin) => !sandboxStagingOrigins.has(origin))) {
        ctx.addIssue({
          code: "custom",
          path: ["QUICKBOOKS_SANDBOX_STAGING_ORIGINS"],
          message: "Production-mode QuickBooks sandbox workflows require APP_URL and API_URL to be explicitly approved staging origins.",
        });
      }
    }
    if (value.QUICKBOOKS_REDIRECT_URI && new URL(value.QUICKBOOKS_REDIRECT_URI).protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_REDIRECT_URI"],
        message: "QUICKBOOKS_REDIRECT_URI must use HTTPS when production QuickBooks provider workflows are enabled.",
      });
    }
    if (
      value.QUICKBOOKS_ENVIRONMENT === "sandbox"
      && value.QUICKBOOKS_REDIRECT_URI
      && !value.QUICKBOOKS_SANDBOX_STAGING_ORIGINS.split(",").map((origin) => origin.trim()).includes(
        new URL(value.QUICKBOOKS_REDIRECT_URI).origin,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["QUICKBOOKS_REDIRECT_URI"],
        message: "The QuickBooks sandbox redirect origin must be an explicitly approved staging origin.",
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
    AI_RAG_ROLLOUT_MODE: input.AI_RAG_ROLLOUT_MODE
      ?? (input.NODE_ENV === "production" ? "off" : "all"),
    OPENAI_API_KEY: input.OPENAI_API_KEY ?? input.OPEN_API_KEY ?? "",
  });
}

export const env = parseEnv(process.env);
