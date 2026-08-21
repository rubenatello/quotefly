import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import i18n from "./i18n";
import { LocaleContext } from "./locale-context";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  resolveInitialLocale,
  type SupportedLocale,
} from "./supported-locales";

function browserLocale(): SupportedLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const initializedLocale = normalizeLocale(i18n.resolvedLanguage);
  if (initializedLocale) return initializedLocale;
  return resolveInitialLocale({
    storedLocale: window.localStorage.getItem(LOCALE_STORAGE_KEY),
    navigatorLanguages: window.navigator.languages,
  });
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(browserLocale);

  const applyLocale = useCallback(async (nextLocale: SupportedLocale, persist: boolean) => {
    setLocaleState(nextLocale);
    if (typeof document !== "undefined") document.documentElement.lang = nextLocale;
    if (persist && typeof window !== "undefined") window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    if (i18n.resolvedLanguage !== nextLocale) await i18n.changeLanguage(nextLocale);
  }, []);

  const setLocale = useCallback(async (nextLocale: SupportedLocale) => {
    await applyLocale(nextLocale, true);
  }, [applyLocale]);

  const reconcileLocale = useCallback(async (preferredLocale: SupportedLocale | null | undefined) => {
    const normalized = normalizeLocale(preferredLocale);
    if (normalized) await applyLocale(normalized, true);
  }, [applyLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, reconcileLocale }), [locale, reconcileLocale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
