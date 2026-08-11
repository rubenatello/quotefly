const QUOTE_DRAFT_STORAGE_BASE = "qf:quote-draft:";
const LEGACY_QUOTE_DRAFT_STORAGE_BASE = "qf:quote-builder-draft:";
export const QUOTE_DRAFT_STORAGE_PREFIX = `${QUOTE_DRAFT_STORAGE_BASE}v1:`;
export const QUOTE_DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const QUOTE_DRAFT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

let writesEnabled = true;
let activeIdentityPrefix: string | null = null;
let cleanupTimerId: number | null = null;
let visibilityCleanup: (() => void) | null = null;

function localStorageTarget() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function identityPrefix(tenantId: string, userId: string) {
  return `${QUOTE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:`;
}

export function quoteBuilderDraftStorageKey(tenantId: string, userId: string) {
  return `${identityPrefix(tenantId, userId)}new`;
}

export function quoteDeskDraftStorageKey(tenantId: string, userId: string, quoteId: string) {
  return `${identityPrefix(tenantId, userId)}quote:${encodeURIComponent(quoteId)}`;
}

export function isQuoteDraftTimestampFresh(savedAtUtc: string, now = Date.now()) {
  const savedAt = Date.parse(savedAtUtc);
  return Number.isFinite(savedAt) && savedAt <= now + 60_000 && now - savedAt <= QUOTE_DRAFT_MAX_AGE_MS;
}

function storedDraftIsFresh(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const savedAtUtc = (value as { savedAtUtc?: unknown }).savedAtUtc;
    return typeof savedAtUtc === "string" && isQuoteDraftTimestampFresh(savedAtUtc);
  } catch {
    return false;
  }
}

function removeQuoteDraftKeys(target: Storage, options?: { keepIdentityPrefix?: string }) {
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const key = target.key(index);
    if (!key) continue;

    if (key.startsWith(LEGACY_QUOTE_DRAFT_STORAGE_BASE)) {
      target.removeItem(key);
      continue;
    }

    if (!key.startsWith(QUOTE_DRAFT_STORAGE_BASE)) continue;
    const raw = target.getItem(key);
    const belongsToCurrentIdentity = Boolean(options?.keepIdentityPrefix && key.startsWith(options.keepIdentityPrefix));
    if (!belongsToCurrentIdentity || !raw || !storedDraftIsFresh(raw)) target.removeItem(key);
  }
}

function stopQuoteDraftCleanup() {
  if (typeof window !== "undefined" && cleanupTimerId !== null) window.clearInterval(cleanupTimerId);
  cleanupTimerId = null;
  if (typeof document !== "undefined" && visibilityCleanup) {
    document.removeEventListener("visibilitychange", visibilityCleanup);
  }
  visibilityCleanup = null;
}

function cleanupActiveIdentityDrafts() {
  if (!activeIdentityPrefix) return;
  try {
    const target = localStorageTarget();
    if (target) removeQuoteDraftKeys(target, { keepIdentityPrefix: activeIdentityPrefix });
    if (typeof window !== "undefined") removeQuoteDraftKeys(window.sessionStorage);
  } catch {
    // Browser storage restrictions must not interrupt the authenticated workspace.
  }
}

function startQuoteDraftCleanup() {
  stopQuoteDraftCleanup();
  if (typeof window === "undefined") return;

  visibilityCleanup = () => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") cleanupActiveIdentityDrafts();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibilityCleanup);
  cleanupTimerId = window.setInterval(cleanupActiveIdentityDrafts, QUOTE_DRAFT_CLEANUP_INTERVAL_MS);
}

export function prepareQuoteBuilderDraftStorage(tenantId: string, userId: string) {
  const currentIdentityPrefix = identityPrefix(tenantId, userId);
  activeIdentityPrefix = currentIdentityPrefix;
  try {
    const target = localStorageTarget();
    if (target) removeQuoteDraftKeys(target, { keepIdentityPrefix: currentIdentityPrefix });
    if (typeof window !== "undefined") removeQuoteDraftKeys(window.sessionStorage);
  } catch {
    // Storage restrictions must not prevent a valid session from loading.
  } finally {
    writesEnabled = true;
  }
  startQuoteDraftCleanup();
  return quoteBuilderDraftStorageKey(tenantId, userId);
}

export function purgeQuoteBuilderDraftStorage() {
  writesEnabled = false;
  stopQuoteDraftCleanup();
  activeIdentityPrefix = null;
  try {
    const target = localStorageTarget();
    if (target) removeQuoteDraftKeys(target);
    if (typeof window !== "undefined") removeQuoteDraftKeys(window.sessionStorage);
  } catch {
    // Session cleanup must continue when browser storage is unavailable.
  }
}

export function readQuoteBuilderDraft(storageKey: string) {
  try {
    const target = localStorageTarget();
    const raw = target?.getItem(storageKey) ?? null;
    if (!raw) return null;
    if (storedDraftIsFresh(raw)) return raw;
    target?.removeItem(storageKey);
    return null;
  } catch {
    return null;
  }
}

export function writeQuoteBuilderDraft(storageKey: string, value: string) {
  if (!writesEnabled || !storedDraftIsFresh(value)) return false;
  try {
    const target = localStorageTarget();
    if (!target) return false;
    target.setItem(storageKey, value);
    return true;
  } catch {
    return false;
  }
}

export function removeQuoteBuilderDraft(storageKey: string) {
  try {
    localStorageTarget()?.removeItem(storageKey);
  } catch {
    // The in-memory quote editor remains usable when browser storage is unavailable.
  }
}

export const readQuoteDeskDraft = readQuoteBuilderDraft;
export const writeQuoteDeskDraft = writeQuoteBuilderDraft;
export const removeQuoteDeskDraft = removeQuoteBuilderDraft;
