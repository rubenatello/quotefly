(function initializeQuoteFlyTheme() {
  var storageKey = "qf_theme_preference";
  var preference = "system";

  try {
    var storedPreference = window.localStorage.getItem(storageKey);
    if (storedPreference === "light" || storedPreference === "dark" || storedPreference === "system") {
      preference = storedPreference;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browsers.
  }

  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var resolvedTheme = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
  var root = document.documentElement;

  root.classList.toggle("dark", resolvedTheme === "dark");
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;
})();
