export const THEME_STORAGE_KEY = "qf_theme_preference";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : "system";
}

export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function readThemePreference(storage: Pick<Storage, "getItem">): ThemePreference {
  try {
    return normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(
  storage: Pick<Storage, "setItem">,
  preference: ThemePreference,
) {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A private or locked-down browser may deny storage. The in-memory
    // preference still applies for the current session.
  }
}

export function applyResolvedTheme(root: HTMLElement, theme: ResolvedTheme) {
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}
