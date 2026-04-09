import { z } from "zod";

const BooleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return value;
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32).default("change-me-in-production-must-be-32-chars-min"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_ID_STARTER: z.string().default(""),
  STRIPE_PRICE_ID_PROFESSIONAL: z.string().default(""),
  STRIPE_PRICE_ID_ENTERPRISE: z.string().default(""),
  APP_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  ENABLE_TWILIO_SMS: BooleanFromEnv.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WEBHOOK_AUTH_TOKEN: z.string().default(""),
});

export const env = EnvSchema.parse(process.env);
