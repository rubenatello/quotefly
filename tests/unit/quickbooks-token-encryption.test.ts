import { createCipheriv, createHash, randomBytes } from "crypto";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

const JWT_SECRET = "quickbooks-unit-jwt-secret-that-is-long-enough";
const CURRENT_KEY = "quickbooks-current-token-key-000000000001";
const PREVIOUS_KEY = "quickbooks-previous-token-key-00000000001";

let parseEnv: typeof import("../../src/config/env.js").parseEnv;
let decryptQuickBooksSecret: typeof import("../../src/services/quickbooks.js").decryptQuickBooksSecret;
let encryptQuickBooksSecret: typeof import("../../src/services/quickbooks.js").encryptQuickBooksSecret;

before(async () => {
  process.env.DATABASE_URL ||= "postgresql://unit:unit@127.0.0.1:1/quotefly_unit";
  process.env.JWT_SECRET ||= JWT_SECRET;
  ({ parseEnv } = await import("../../src/config/env.js"));
  ({ decryptQuickBooksSecret, encryptQuickBooksSecret } = await import("../../src/services/quickbooks.js"));
});

function runtimeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/quotefly_unit",
    JWT_SECRET,
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: CURRENT_KEY,
    ...overrides,
  });
}

function encryptLegacyJwtEnvelope(value: string) {
  const key = createHash("sha256").update(JWT_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

describe("QuickBooks token encryption", () => {
  it("writes a versioned envelope with the dedicated key", () => {
    const env = runtimeEnv();
    const encrypted = encryptQuickBooksSecret(env, "access-token-value");

    assert.equal(encrypted.startsWith("v2."), true);
    assert.equal(encrypted.includes("access-token-value"), false);
    assert.equal(decryptQuickBooksSecret(env, encrypted), "access-token-value");
  });

  it("decrypts current envelopes with the previous key during rotation", () => {
    const oldEnv = runtimeEnv({ QUICKBOOKS_TOKEN_ENCRYPTION_KEY: PREVIOUS_KEY });
    const encryptedWithOldKey = encryptQuickBooksSecret(oldEnv, "refresh-token-value");
    const rotatedEnv = runtimeEnv({
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: CURRENT_KEY,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
    });

    assert.equal(decryptQuickBooksSecret(rotatedEnv, encryptedWithOldKey), "refresh-token-value");
    assert.throws(
      () => decryptQuickBooksSecret(runtimeEnv(), encryptedWithOldKey),
      /payload is invalid/i,
    );
  });

  it("retains read compatibility for legacy JWT-derived ciphertext", () => {
    const legacyCiphertext = encryptLegacyJwtEnvelope("legacy-refresh-token");
    assert.equal(decryptQuickBooksSecret(runtimeEnv(), legacyCiphertext), "legacy-refresh-token");
  });

  it("fails closed for malformed or tampered envelopes", () => {
    const env = runtimeEnv();
    const encrypted = encryptQuickBooksSecret(env, "protected-token");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    assert.throws(() => decryptQuickBooksSecret(env, tampered), /payload is invalid/i);
    assert.throws(() => decryptQuickBooksSecret(env, "v2.not-valid"), /payload is invalid/i);
  });
});
