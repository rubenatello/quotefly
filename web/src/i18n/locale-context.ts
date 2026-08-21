import { createContext, useContext } from "react";
import type { SupportedLocale } from "./supported-locales";

export interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => Promise<void>;
  reconcileLocale: (locale: SupportedLocale | null | undefined) => Promise<void>;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used within LocaleProvider");
  return context;
}
