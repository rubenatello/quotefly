export type CookieConsentChoice = "accepted" | "essential";

export type CookieConsentRecord = {
  choice: CookieConsentChoice;
  version: 1;
  updatedAtUtc: string;
  expiresAtUtc: string;
};

const COOKIE_CONSENT_STORAGE_KEY = "qf_cookie_consent";
const COOKIE_CONSENT_EVENT = "qf:cookie-consent-change";
const COOKIE_CONSENT_VERSION = 1 as const;
const COOKIE_CONSENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function isConsentChoice(value: unknown): value is CookieConsentChoice {
  return value === "accepted" || value === "essential";
}

function parseStoredConsent(value: string | null): CookieConsentRecord | null {
  if (!value) return null;

  // Preserve the choice made before consent records became versioned.
  if (isConsentChoice(value)) {
    const updatedAtUtc = new Date().toISOString();
    return {
      choice: value,
      version: COOKIE_CONSENT_VERSION,
      updatedAtUtc,
      expiresAtUtc: new Date(Date.now() + COOKIE_CONSENT_TTL_MS).toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(value) as Partial<CookieConsentRecord>;
    if (
      parsed.version !== COOKIE_CONSENT_VERSION ||
      !isConsentChoice(parsed.choice) ||
      typeof parsed.updatedAtUtc !== "string" ||
      typeof parsed.expiresAtUtc !== "string"
    ) {
      return null;
    }

    const expiresAt = Date.parse(parsed.expiresAtUtc);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

    return parsed as CookieConsentRecord;
  } catch {
    return null;
  }
}

function readStoredConsent(): CookieConsentRecord | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredConsent(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY));
  } catch {
    // Storage can be blocked by browser privacy settings. Fail closed.
    return null;
  }
}

function notifyConsentChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
}

export function getStoredCookieConsentRecord(): CookieConsentRecord | null {
  return readStoredConsent();
}

export function getStoredCookieConsent(): CookieConsentChoice | null {
  return readStoredConsent()?.choice ?? null;
}

export function setStoredCookieConsent(choice: CookieConsentChoice) {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const record: CookieConsentRecord = {
    choice,
    version: COOKIE_CONSENT_VERSION,
    updatedAtUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + COOKIE_CONSENT_TTL_MS).toISOString(),
  };

  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A blocked write means optional analytics remain disabled.
  }
  notifyConsentChanged();
}

export function clearStoredCookieConsent() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
  } catch {
    // Treat unavailable storage as no saved choice.
  }
  notifyConsentChanged();
}

export function subscribeToCookieConsent(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key === COOKIE_CONSENT_STORAGE_KEY) listener();
  };
  window.addEventListener(COOKIE_CONSENT_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(COOKIE_CONSENT_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function hasCookieConsentChoice(): boolean {
  return getStoredCookieConsent() !== null;
}

export function canTrackAnalytics(): boolean {
  return getStoredCookieConsent() === "accepted";
}
