import { api, type QuoteDraftRecoveryPayload } from "./api";

const QUOTE_DRAFT_STORAGE_BASE = "qf:quote-draft:";
const LEGACY_QUOTE_DRAFT_STORAGE_BASE = "qf:quote-builder-draft:";
export const QUOTE_DRAFT_STORAGE_PREFIX = `${QUOTE_DRAFT_STORAGE_BASE}v1:`;
export const QUOTE_DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let writesEnabled = true;
let activeIdentity: { tenantId: string; userId: string } | null = null;

export function quoteBuilderDraftStorageKey(tenantId: string, userId: string) {
  void tenantId;
  void userId;
  return "new";
}

export function quoteDeskDraftStorageKey(tenantId: string, userId: string, quoteId: string) {
  void tenantId;
  void userId;
  return `quote:${quoteId}`;
}

export function isQuoteDraftTimestampFresh(savedAtUtc: string, now = Date.now()) {
  const savedAt = Date.parse(savedAtUtc);
  return Number.isFinite(savedAt) && savedAt <= now + 60_000 && now - savedAt <= QUOTE_DRAFT_MAX_AGE_MS;
}

function parseFreshDraft(raw: string): QuoteDraftRecoveryPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const savedAtUtc = (value as { savedAtUtc?: unknown }).savedAtUtc;
    const version = (value as { version?: unknown }).version;
    return version === 1 && typeof savedAtUtc === "string" && isQuoteDraftTimestampFresh(savedAtUtc)
      ? value as QuoteDraftRecoveryPayload
      : null;
  } catch {
    return null;
  }
}

function removeLegacyQuoteDraftKeys(target: Storage) {
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const key = target.key(index);
    if (!key) continue;
    if (key.startsWith(QUOTE_DRAFT_STORAGE_BASE) || key.startsWith(LEGACY_QUOTE_DRAFT_STORAGE_BASE)) {
      target.removeItem(key);
    }
  }
}

function purgeLegacyBrowserDrafts() {
  try {
    if (typeof window === "undefined") return;
    removeLegacyQuoteDraftKeys(window.localStorage);
    removeLegacyQuoteDraftKeys(window.sessionStorage);
  } catch {
    // Browser storage restrictions must not interrupt the authenticated workspace.
  }
}

export function prepareQuoteBuilderDraftStorage(tenantId: string, userId: string) {
  purgeLegacyBrowserDrafts();
  activeIdentity = { tenantId, userId };
  writesEnabled = true;
  return quoteBuilderDraftStorageKey(tenantId, userId);
}

export function purgeQuoteBuilderDraftStorage() {
  writesEnabled = false;
  activeIdentity = null;
  purgeLegacyBrowserDrafts();
}

export async function readQuoteBuilderDraft(storageKey: string) {
  try {
    const { draft } = await api.quoteDrafts.get(storageKey);
    if (!draft) return null;
    if (!isQuoteDraftTimestampFresh(draft.savedAtUtc)) {
      await api.quoteDrafts.remove(storageKey).catch(() => undefined);
      return null;
    }
    return JSON.stringify({ ...draft.payload, savedAtUtc: draft.savedAtUtc });
  } catch {
    return null;
  }
}

export async function writeQuoteBuilderDraft(storageKey: string, value: string, options?: { keepalive?: boolean }) {
  const payload = parseFreshDraft(value);
  if (!writesEnabled || !payload || !activeIdentity) return null;
  try {
    const { draft } = await api.quoteDrafts.save(storageKey, {
      ...payload,
      recoveryIdentity: activeIdentity,
    }, options);
    return draft.savedAtUtc;
  } catch {
    return null;
  }
}

export async function removeQuoteBuilderDraft(storageKey: string, options?: { keepalive?: boolean }) {
  if (!writesEnabled) return;
  await api.quoteDrafts.remove(storageKey, options).catch(() => undefined);
}

export const readQuoteDeskDraft = readQuoteBuilderDraft;
export const writeQuoteDeskDraft = writeQuoteBuilderDraft;
export const removeQuoteDeskDraft = removeQuoteBuilderDraft;
