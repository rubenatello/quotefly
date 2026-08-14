import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyResolvedTheme,
  normalizeThemePreference,
  readThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  writeThemePreference,
  type ThemePreference,
} from "../../lib/theme";
import { ThemeContext } from "./theme-context";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function currentSystemPreference() {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readThemePreference(window.localStorage),
  );
  const [prefersDark, setPrefersDark] = useState(currentSystemPreference);
  const resolvedTheme = resolveThemePreference(preference, prefersDark);

  useLayoutEffect(() => {
    applyResolvedTheme(document.documentElement, resolvedTheme);
    document.documentElement.dataset.themePreference = preference;
  }, [preference, resolvedTheme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
    const syncSystemPreference = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    mediaQuery.addEventListener("change", syncSystemPreference);
    return () => mediaQuery.removeEventListener("change", syncSystemPreference);
  }, []);

  useEffect(() => {
    const syncStoredPreference = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      setPreferenceState(normalizeThemePreference(event.newValue));
    };
    window.addEventListener("storage", syncStoredPreference);
    return () => window.removeEventListener("storage", syncStoredPreference);
  }, []);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    writeThemePreference(window.localStorage, nextPreference);
    setPreferenceState(nextPreference);
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
