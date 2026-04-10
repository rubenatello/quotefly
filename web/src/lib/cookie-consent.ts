export type CookieConsentChoice = "accepted" | "essential";

const COOKIE_CONSENT_STORAGE_KEY = "qf_cookie_consent";

export function getStoredCookieConsent(): CookieConsentChoice | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
  return value === "accepted" || value === "essential" ? value : null;
}

export function setStoredCookieConsent(choice: CookieConsentChoice) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, choice);
}

export function clearStoredCookieConsent() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
}

export function hasCookieConsentChoice(): boolean {
  return getStoredCookieConsent() !== null;
}

export function canTrackAnalytics(): boolean {
  if (import.meta.env.DEV) return true;
  return getStoredCookieConsent() === "accepted";
}
