import { z } from "zod";

export const SupportedLocaleSchema = z.enum(["en-US", "es-US"]);
export type SupportedLocale = z.infer<typeof SupportedLocaleSchema>;

export const DEFAULT_SUPPORTED_LOCALE: SupportedLocale = "en-US";

/**
 * Fail closed to the product default when reading legacy or untrusted locale
 * values. API writes still use SupportedLocaleSchema directly and reject invalid
 * input instead of silently normalizing it.
 */
export function normalizeSupportedLocale(value: unknown): SupportedLocale {
  const parsed = SupportedLocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SUPPORTED_LOCALE;
}
