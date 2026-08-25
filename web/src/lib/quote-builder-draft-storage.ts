import { api, type QuoteDraftRecoveryPayload } from "./api";

const QUOTE_DRAFT_STORAGE_BASE = "qf:quote-draft:";
const LEGACY_QUOTE_DRAFT_STORAGE_BASE = "qf:quote-builder-draft:";
export const QUOTE_DRAFT_STORAGE_PREFIX = `${QUOTE_DRAFT_STORAGE_BASE}v1:`;
export const QUOTE_DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let writesEnabled = true;
let activeIdentity: { tenantId: string; userId: string } | null = null;

export type QuoteDraftReadResult =
  | { status: "found"; raw: string }
  | { status: "not-found"; reason: "missing" | "expired" }
  | { status: "error" };

export type QuoteCreateRetryIdentity = {
  payloadHash: string;
  idempotencyKey: string;
};

export type QuoteAiProvenance = {
  auditEventId: string;
  customerId: string | null;
};

export function reconcileQuoteAiProvenanceCustomer(
  provenance: QuoteAiProvenance | null,
  customerId: string,
) {
  if (!provenance) return null;
  return provenance.customerId === (customerId || null) ? provenance : null;
}

export function clearQuoteAiProvenanceForAudit(
  provenance: QuoteAiProvenance | null,
  auditEventId: string | null,
) {
  return provenance && auditEventId && provenance.auditEventId === auditEventId ? null : provenance;
}

export function applyKodyQuoteAiProvenance(
  current: QuoteAiProvenance | null,
  handoff: { auditEventId: string | null; customerId: string | null },
  finalCustomerId: string,
) {
  if (!handoff.auditEventId) return current;
  if (handoff.customerId && handoff.customerId !== finalCustomerId) return current;
  return {
    auditEventId: handoff.auditEventId,
    customerId: finalCustomerId || null,
  };
}

export function readQuoteCreateRetryIdentity(value: unknown): QuoteCreateRetryIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { payloadHash?: unknown; idempotencyKey?: unknown };
  if (typeof candidate.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.payloadHash)) return null;
  if (
    typeof candidate.idempotencyKey !== "string"
    || candidate.idempotencyKey.length < 16
    || candidate.idempotencyKey.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(candidate.idempotencyKey)
  ) return null;
  return {
    payloadHash: candidate.payloadHash,
    idempotencyKey: candidate.idempotencyKey,
  };
}

export async function hashQuoteCreateCommand(serializedPayload: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedPayload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function resolveQuoteCreateRetryIdentity(
  payloadHash: string,
  existing: QuoteCreateRetryIdentity | null,
  randomUuid = () => crypto.randomUUID(),
): QuoteCreateRetryIdentity {
  // Once a create command may have crossed the network, only an explicit
  // draft reset or successful cleanup may release its idempotency key. A
  // changed form must never silently rotate the key and create a duplicate.
  if (existing) return existing;
  return {
    payloadHash,
    idempotencyKey: `qf-quote-${randomUuid()}`,
  };
}

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

export async function readQuoteBuilderDraft(storageKey: string): Promise<QuoteDraftReadResult> {
  try {
    const { draft } = await api.quoteDrafts.get(storageKey);
    if (!draft) return { status: "not-found", reason: "missing" };
    if (!isQuoteDraftTimestampFresh(draft.savedAtUtc)) {
      await api.quoteDrafts.remove(storageKey).catch(() => undefined);
      return { status: "not-found", reason: "expired" };
    }
    return {
      status: "found",
      raw: JSON.stringify({ ...draft.payload, savedAtUtc: draft.savedAtUtc }),
    };
  } catch {
    return { status: "error" };
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
  if (!writesEnabled) return false;
  try {
    await api.quoteDrafts.remove(storageKey, options);
    return true;
  } catch {
    return false;
  }
}

export const readQuoteDeskDraft = readQuoteBuilderDraft;
export const writeQuoteDeskDraft = writeQuoteBuilderDraft;
export const removeQuoteDeskDraft = removeQuoteBuilderDraft;
