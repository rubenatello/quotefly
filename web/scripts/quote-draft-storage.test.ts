import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuoteDraftTimestampFresh,
  prepareQuoteBuilderDraftStorage,
  purgeQuoteBuilderDraftStorage,
  quoteBuilderDraftStorageKey,
  quoteDeskDraftStorageKey,
  readQuoteBuilderDraft,
  removeQuoteBuilderDraft,
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
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, sessionStorage },
  });
  return { localStorage, sessionStorage };
}

function installDraftApi() {
  const drafts = new Map<string, { payload: Record<string, unknown>; savedAtUtc: string; expiresAtUtc: string }>();
  const calls: Array<{ method: string; scope: string; keepalive: boolean }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const scope = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, scope, keepalive: Boolean(init?.keepalive) });
      if (method === "DELETE") {
        drafts.delete(scope);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { payload: Record<string, unknown> };
        const savedAtUtc = new Date().toISOString();
        const draft = {
          payload: { ...body.payload, savedAtUtc },
          savedAtUtc,
          expiresAtUtc: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
        };
        drafts.set(scope, draft);
        return Response.json({ draft });
      }
      return Response.json({ draft: drafts.get(scope) ?? null });
    },
  });
  return { calls, drafts };
}

test("draft scopes reveal no tenant, user, or customer information", () => {
  assert.equal(quoteBuilderDraftStorageKey("tenant a", "user/1"), "new");
  assert.equal(quoteDeskDraftStorageKey("tenant a", "user/1", "quote_9"), "quote:quote_9");
});

test("draft timestamps expire after the bounded recovery window", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  assert.equal(isQuoteDraftTimestampFresh("2026-08-10T01:00:00.000Z", now), true);
  assert.equal(isQuoteDraftTimestampFresh("2026-08-09T23:00:00.000Z", now), false);
});

test("session preparation physically removes every legacy plaintext browser draft", () => {
  const { localStorage, sessionStorage } = installWindow();
  localStorage.setItem("qf:quote-draft:v1:tenant:user:new", "sensitive quote data");
  localStorage.setItem("qf:quote-builder-draft:v1:legacy", "sensitive customer data");
  sessionStorage.setItem("qf:quote-draft:v1:session", "sensitive pricing data");
  localStorage.setItem("unrelated", "preserved");

  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");

  assert.equal(localStorage.length, 1);
  assert.equal(localStorage.getItem("unrelated"), "preserved");
  assert.equal(sessionStorage.length, 0);
});

test("write, read, remove, and keepalive use only the authenticated server recovery API", async () => {
  const { localStorage, sessionStorage } = installWindow();
  const { calls, drafts } = installDraftApi();
  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");
  const scope = quoteBuilderDraftStorageKey("tenant-1", "user-1");
  const value = JSON.stringify({ version: 1, savedAtUtc: new Date().toISOString(), title: "Repair" });

  const savedAtUtc = await writeQuoteBuilderDraft(scope, value, { keepalive: true });
  assert.ok(savedAtUtc);
  assert.match(await readQuoteBuilderDraft(scope) ?? "", /Repair/);
  assert.equal(localStorage.length, 0);
  assert.equal(sessionStorage.length, 0);
  assert.equal(drafts.size, 1);
  assert.deepEqual(calls.map(({ method, scope: calledScope }) => [method, calledScope]), [
    ["PUT", "new"],
    ["GET", "new"],
  ]);
  assert.equal(calls[0]?.keepalive, true);

  await removeQuoteBuilderDraft(scope);
  assert.equal(drafts.size, 0);
});

test("logout disables new recovery writes and still purges legacy browser keys", async () => {
  const { localStorage } = installWindow();
  const { calls } = installDraftApi();
  prepareQuoteBuilderDraftStorage("tenant-1", "user-1");
  localStorage.setItem("qf:quote-draft:v1:tenant:user:new", "sensitive");
  purgeQuoteBuilderDraftStorage();

  const value = JSON.stringify({ version: 1, savedAtUtc: new Date().toISOString(), title: "Repair" });
  assert.equal(await writeQuoteBuilderDraft("new", value), null);
  assert.equal(localStorage.length, 0);
  assert.equal(calls.length, 0);
});
