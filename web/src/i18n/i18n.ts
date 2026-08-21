import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { translationResources } from "./resources";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, resolveInitialLocale } from "./supported-locales";

const initialLocale = typeof window === "undefined"
  ? DEFAULT_LOCALE
  : resolveInitialLocale({
      storedLocale: window.localStorage.getItem(LOCALE_STORAGE_KEY),
      navigatorLanguages: window.navigator.languages,
    });

if (typeof document !== "undefined") document.documentElement.lang = initialLocale;

void i18n.use(initReactI18next).init({
  initAsync: false,
  resources: translationResources,
  // Resolve before React mounts so a stored Spanish preference never paints an
  // English frame while LocaleProvider is starting.
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: ["en-US", "es-US"],
  load: "currentOnly",
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

export default i18n;
