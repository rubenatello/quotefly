import assert from "node:assert/strict";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { it } from "node:test";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";
import { issueQuickBooksTaxContextFormToken, QuickBooksTaxContextFormTokenError,
  verifyQuickBooksTaxContextFormToken } from "../../src/services/quickbooks-tax-context-form-token";

const current = "capture-current-key-material-that-is-at-least-32-characters";
const previous = "capture-previous-key-material-that-is-at-least-32-characters";
const env = (key = current, old = previous): QuickBooksCredentialRuntimeEnv => ({
  QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1_000, QUICKBOOKS_PROVIDER_READ_RETRIES: 0,
  QUICKBOOKS_CLIENT_ID: "client", QUICKBOOKS_CLIENT_SECRET: "secret", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: key,
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: old, JWT_SECRET: "jwt-secret-is-long-enough-for-this-synthetic-test",
});
const claims = { tid: "tenant", uid: "user", mid: "membership", av: 7, iid: "invoice", rev: 3 };
const binding = { price: "125.00", providerCustomerId: "provider-private", lines: [{ id: "line", mapVersion: 4 }] };
const now = new Date("2026-09-23T12:00:00.000Z");
const purpose = "quotefly.quickbooks.tax-context-form/v1";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function rejects(action: () => unknown, expected?: string) {
  assert.throws(action, (error: unknown) => error instanceof QuickBooksTaxContextFormTokenError
    && (expected === undefined || error.code === expected));
}

it("binds the actor, revision and private server source without embedding that source", () => {
  const issued = issueQuickBooksTaxContextFormToken(env(), claims, binding, now);
  assert.ok(Buffer.byteLength(issued.token) <= 2_048);
  assert.equal(issued.token.includes("provider-private"), false);
  assert.equal(issued.expiresAtUtc, "2026-09-23T12:15:00.000Z");
  assert.equal(verifyQuickBooksTaxContextFormToken(env(), issued.token, claims, binding, now).rev, 3);
  rejects(() => verifyQuickBooksTaxContextFormToken(env(), issued.token, { ...claims, uid: "copied-user" }, binding, now));
  rejects(() => verifyQuickBooksTaxContextFormToken(env(), issued.token, claims, { ...binding, price: "126.00" }, now));
  rejects(() => verifyQuickBooksTaxContextFormToken(env(), issued.token, { ...claims, rev: 4 }, binding, now));
});

it("supports only the explicitly configured previous key", () => {
  const oldToken = issueQuickBooksTaxContextFormToken(env(previous, ""), claims, binding, now).token;
  assert.equal(verifyQuickBooksTaxContextFormToken(env(current, previous), oldToken, claims, binding, now).iid, "invoice");
  rejects(() => verifyQuickBooksTaxContextFormToken(env(current, ""), oldToken, claims, binding, now));
});

it("rejects expired, future, malformed, oversized and tampered tokens", () => {
  const token = issueQuickBooksTaxContextFormToken(env(), claims, binding, now).token;
  rejects(() => verifyQuickBooksTaxContextFormToken(env(), token, claims, binding,
    new Date("2026-09-23T12:15:31.000Z")), "QUICKBOOKS_TAX_CONTEXT_FORM_EXPIRED");
  const future = issueQuickBooksTaxContextFormToken(env(), claims, binding, new Date("2026-09-23T12:01:00.000Z")).token;
  rejects(() => verifyQuickBooksTaxContextFormToken(env(), future, claims, binding, now));
  for (const malformed of ["", "qbt1.a.b=", "qbt1.a.b.c", `qbt1.${"a".repeat(2050)}.x`, token + "="]) {
    rejects(() => verifyQuickBooksTaxContextFormToken(env(), malformed, claims, binding, now));
  }
  const parts = token.split(".");
  rejects(() => verifyQuickBooksTaxContextFormToken(env(),
    `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`, claims, binding, now));
});

it("rejects a changed lifetime field even when the encoding remains valid", () => {
  const token = issueQuickBooksTaxContextFormToken(env(), claims, binding, now).token;
  const [prefix, payload] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); decoded.exp += 1;
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(current), Buffer.alloc(0), Buffer.from(purpose), 32));
  decoded.kid = createHash("sha256").update(key).digest("base64url").slice(0, 16);
  const changedPayload = Buffer.from(canonical(decoded)).toString("base64url");
  const signature = createHmac("sha256", key).update(`${purpose}\n${changedPayload}\n${canonical(binding)}`).digest("base64url");
  rejects(() => verifyQuickBooksTaxContextFormToken(env(),
    `${prefix}.${changedPayload}.${signature}`, claims, binding, now), "QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
});
