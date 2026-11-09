import { z } from "zod";

export const QUICKBOOKS_MONITOR_FORBIDDEN_KEYS = [
  "DIRECT_DATABASE_URL", "JWT_SECRET", "RATE_LIMIT_REDIS_URL", "OPENAI_API_KEY", "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET", "TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_AUTH_TOKEN", "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_WEBHOOK_VERIFIER", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
  "QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS",
] as const;
const boolean = z.enum(["true", "false"]).transform((value) => value === "true");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(ql)?:/.test(value)),
  RESEND_API_KEY: z.string().trim().min(1),
  PASSWORD_RESET_EMAIL_FROM: z.string().trim().min(3).max(200).refine((value) => !/[\r\n]/.test(value)),
  QUICKBOOKS_ALERT_EMAIL: z.email().max(254),
  QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL: z.enum(["staging", "production", "test"]),
  QUICKBOOKS_MONITOR_ENABLED: boolean.default(false),
  QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: boolean,
  QUICKBOOKS_MONITOR_EXPECT_CDC: boolean,
}).refine((value) => !value.QUICKBOOKS_MONITOR_EXPECT_CDC || value.QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION);
export type QuickBooksMonitorEnv = z.infer<typeof schema>;
/** Deliberately does not import global env or dotenv and never includes values in an error. */
export function parseQuickBooksMonitorEnv(source: NodeJS.ProcessEnv): QuickBooksMonitorEnv {
  const allowedCredentialKeys = new Set(["DATABASE_URL", "RESEND_API_KEY", "PASSWORD_RESET_EMAIL_FROM"]);
  const unexpectedCredential = Object.keys(source).some((key) => !allowedCredentialKeys.has(key)
    && /(?:SECRET|TOKEN|PASSWORD|API_KEY|(?:DATABASE|POSTGRES(?:QL)?|PG|DB|REDIS)(?:_[A-Z0-9]+)*_(?:URL|URI|CONNECTION_STRING)|PRIVATE_KEY|CREDENTIAL)/i.test(key)
    && Boolean(source[key]?.trim()));
  if (unexpectedCredential || QUICKBOOKS_MONITOR_FORBIDDEN_KEYS.some((key) => Boolean(source[key]?.trim()))) {
    throw new Error("QUICKBOOKS_MONITOR_FORBIDDEN_CONFIGURATION");
  }
  const result = schema.safeParse(source);
  if (!result.success) throw new Error("QUICKBOOKS_MONITOR_INVALID_CONFIGURATION");
  return result.data;
}
