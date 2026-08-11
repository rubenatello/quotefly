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
  JWT_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_COST_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0.15),
  OPENAI_COST_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0.6),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_ID_STARTER: z.string().default(""),
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
  ENABLE_TWILIO_SMS: BooleanFromEnv.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WEBHOOK_AUTH_TOKEN: z.string().default(""),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") return;

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
