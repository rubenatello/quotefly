export const SUPPORTED_LOCALES = ["en-US", "es-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en-US";
export const LOCALE_STORAGE_KEY = "qf_locale";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (isSupportedLocale(value)) return value;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === "es" || normalized.startsWith("es-")) return "es-US";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return null;
}

export function resolveInitialLocale({
  storedLocale,
  navigatorLanguages,
}: {
  storedLocale?: string | null;
  navigatorLanguages?: readonly string[];
} = {}): SupportedLocale {
  const stored = normalizeLocale(storedLocale);
  if (stored) return stored;

  for (const language of navigatorLanguages ?? []) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}
