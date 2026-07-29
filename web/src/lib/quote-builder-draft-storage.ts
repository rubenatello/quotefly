const QUOTE_BUILDER_DRAFT_STORAGE_BASE = "qf:quote-builder-draft:";
export const QUOTE_BUILDER_DRAFT_STORAGE_PREFIX = `${QUOTE_BUILDER_DRAFT_STORAGE_BASE}v2:`;

let writesEnabled = true;

function storage() {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function quoteBuilderDraftStorageKey(tenantId: string, userId: string) {
  return `${QUOTE_BUILDER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}`;
}

function removeBuilderDraftKeys(target: Storage, keepKey?: string) {
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const key = target.key(index);
    if (key?.startsWith(QUOTE_BUILDER_DRAFT_STORAGE_BASE) && key !== keepKey) target.removeItem(key);
  }
}

export function prepareQuoteBuilderDraftStorage(tenantId: string, userId: string) {
  const currentKey = quoteBuilderDraftStorageKey(tenantId, userId);
  try {
    const target = storage();
    if (target) removeBuilderDraftKeys(target, currentKey);
    if (typeof window !== "undefined") removeBuilderDraftKeys(window.localStorage);
  } catch {
    // Storage restrictions must not prevent a valid session from loading.
  } finally {
    writesEnabled = true;
  }
  return currentKey;
}

export function purgeQuoteBuilderDraftStorage() {
  writesEnabled = false;
  try {
    const target = storage();
    if (target) removeBuilderDraftKeys(target);
    if (typeof window !== "undefined") removeBuilderDraftKeys(window.localStorage);
  } catch {
    // Session cleanup must continue when browser storage is unavailable.
  }
}

export function readQuoteBuilderDraft(storageKey: string) {
  try {
    return storage()?.getItem(storageKey) ?? null;
  } catch {
    return null;
  }
}

export function writeQuoteBuilderDraft(storageKey: string, value: string) {
  if (!writesEnabled) return false;
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(storageKey, value);
    return true;
  } catch {
    return false;
  }
}

export function removeQuoteBuilderDraft(storageKey: string) {
  try {
    storage()?.removeItem(storageKey);
  } catch {
    // The in-memory builder remains usable when browser storage is unavailable.
  }
}
