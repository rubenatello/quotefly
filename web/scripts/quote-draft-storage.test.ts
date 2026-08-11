import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuoteDraftTimestampFresh,
  prepareQuoteBuilderDraftStorage,
  purgeQuoteBuilderDraftStorage,
  QUOTE_DRAFT_MAX_AGE_MS,
  quoteBuilderDraftStorageKey,
  quoteDeskDraftStorageKey,
  readQuoteBuilderDraft,
  writeQuoteBuilderDraft,
} from "../src/lib/quote-builder-draft-storage";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function installWindow() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const documentTarget = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" };
  documentTarget.visibilityState = "visible";
  const intervalCallbacks: Array<() => void> = [];
  const clearedIntervalIds: number[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
      setInterval(callback: () => void) {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      },
      clearInterval(intervalId: number) {
        clearedIntervalIds.push(intervalId);
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentTarget,
  });
  return { localStorage, sessionStorage, documentTarget, intervalCallbacks, clearedIntervalIds };
}

test("draft keys bind tenant, user, and quote scope", () => {
  assert.equal(quoteBuilderDraftStorageKey("tenant a", "user/1"), "qf:quote-draft:v1:tenant%20a:user%2F1:new");
  assert.equal(quoteDeskDraftStorageKey("tenant a", "user/1", "quote#9"), "qf:quote-draft:v1:tenant%20a:user%2F1:quote:quote%239");
});

test("draft timestamps expire after the bounded recovery window", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  assert.equal(isQuoteDraftTimestampFresh("2026-08-10T01:00:00.000Z", now), true);
  assert.equal(isQuoteDraftTimestampFresh("2026-08-09T23:00:00.000Z", now), false);
});

test("session preparation retains only fresh drafts for the active identity", () => {
  const { localStorage, sessionStorage } = installWindow();
  const activeKey = quoteDeskDraftStorageKey("tenant-1", "user-1", "quote-1");
  const otherKey = quoteDeskDraftStorageKey("tenant-2", "user-2", "quote-2");
  const fresh = JSON.stringify({ savedAtUtc: new Date().toISOString(), value: "fresh" });
  localStorage.setItem(activeKey, fresh);
  localStorage.setItem(otherKey, fresh);
  sessionStorage.setItem("qf:quote-builder-draft:v2:legacy", fresh);

  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");

  assert.equal(localStorage.getItem(activeKey), fresh);
  assert.equal(localStorage.getItem(otherKey), null);
  assert.equal(sessionStorage.length, 0);
});

test("write, read, and logout purge enforce the draft lifecycle", () => {
  const { localStorage } = installWindow();
  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");
  const key = quoteBuilderDraftStorageKey("tenant-1", "user-1");
  const value = JSON.stringify({ savedAtUtc: new Date().toISOString(), title: "Repair" });

  assert.equal(writeQuoteBuilderDraft(key, value), true);
  assert.equal(readQuoteBuilderDraft(key), value);
  purgeQuoteBuilderDraftStorage();
  assert.equal(localStorage.length, 0);
  assert.equal(writeQuoteBuilderDraft(key, value), false);
});

test("visibility and bounded timer sweeps physically remove expired drafts", () => {
  const { localStorage, documentTarget, intervalCallbacks } = installWindow();
  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");
  const visibilityExpiredKey = quoteDeskDraftStorageKey("tenant-1", "user-1", "visibility-expired");
  const timerExpiredKey = quoteDeskDraftStorageKey("tenant-1", "user-1", "timer-expired");
  const freshKey = quoteDeskDraftStorageKey("tenant-1", "user-1", "fresh");
  const expired = JSON.stringify({ savedAtUtc: new Date(Date.now() - QUOTE_DRAFT_MAX_AGE_MS - 1).toISOString() });
  const fresh = JSON.stringify({ savedAtUtc: new Date().toISOString() });

  localStorage.setItem(visibilityExpiredKey, expired);
  localStorage.setItem(freshKey, fresh);
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(localStorage.getItem(visibilityExpiredKey), null);
  assert.equal(localStorage.getItem(freshKey), fresh);

  localStorage.setItem(timerExpiredKey, expired);
  assert.ok(intervalCallbacks.length > 0);
  intervalCallbacks.at(-1)?.();
  assert.equal(localStorage.getItem(timerExpiredKey), null);
  assert.equal(localStorage.getItem(freshKey), fresh);
  purgeQuoteBuilderDraftStorage();
});
