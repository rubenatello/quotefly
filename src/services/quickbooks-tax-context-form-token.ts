import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";

export const QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_TTL_SECONDS = 900;
export const QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_BYTES = 2_048;
const PURPOSE = "quotefly.quickbooks.tax-context-form/v1";
const encoded = /^[A-Za-z0-9_-]+$/;

const payloadSchema = z.strictObject({
  v: z.literal(1), p: z.literal(PURPOSE), kid: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tid: z.string().min(1).max(191), uid: z.string().min(1).max(191), mid: z.string().min(1).max(191),
  av: z.number().int().min(0).max(2_147_483_647), iid: z.string().min(1).max(191),
  rev: z.number().int().min(0).max(2_147_483_647), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
});
export type QuickBooksTaxContextFormTokenClaims = z.infer<typeof payloadSchema>;

export class QuickBooksTaxContextFormTokenError extends Error {
  readonly statusCode: number;
  constructor(readonly code: "QUICKBOOKS_TAX_CONTEXT_FORM_INVALID" | "QUICKBOOKS_TAX_CONTEXT_FORM_EXPIRED" | "QUICKBOOKS_TAX_CONTEXT_FORM_STALE") {
    super(code); this.name = "QuickBooksTaxContextFormTokenError";
    this.statusCode = code === "QUICKBOOKS_TAX_CONTEXT_FORM_INVALID" ? 400 : 409;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function purposeKey(material: string): Buffer {
  if (Buffer.byteLength(material.trim()) < 32) throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  return Buffer.from(hkdfSync("sha256", Buffer.from(material), Buffer.alloc(0), Buffer.from(PURPOSE), 32));
}
const keyId = (key: Buffer) => createHash("sha256").update(key).digest("base64url").slice(0, 16);
const signature = (key: Buffer, payload: string, binding: unknown) => createHmac("sha256", key)
  .update(`${PURPOSE}\n${payload}\n${canonical(binding)}`).digest();

export function issueQuickBooksTaxContextFormToken(environment: QuickBooksCredentialRuntimeEnv,
  claims: Omit<QuickBooksTaxContextFormTokenClaims, "v" | "p" | "kid" | "iat" | "exp">,
  binding: unknown, now = new Date()) {
  const key = purposeKey(environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY);
  const iat = Math.floor(now.getTime() / 1000);
  const payload: QuickBooksTaxContextFormTokenClaims = { v: 1, p: PURPOSE, kid: keyId(key), ...claims,
    iat, exp: iat + QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_TTL_SECONDS };
  const payloadPart = Buffer.from(canonical(payload)).toString("base64url");
  const token = `qbt1.${payloadPart}.${signature(key, payloadPart, binding).toString("base64url")}`;
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  return { token, expiresAtUtc: new Date(payload.exp * 1000).toISOString() };
}

export function verifyQuickBooksTaxContextFormToken(environment: QuickBooksCredentialRuntimeEnv, token: unknown,
  expected: Omit<QuickBooksTaxContextFormTokenClaims, "v" | "p" | "kid" | "iat" | "exp">,
  binding: unknown, now = new Date()) {
  if (typeof token !== "string" || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "qbt1" || !encoded.test(parts[1]) || !encoded.test(parts[2])) {
    throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  }
  let payload: QuickBooksTaxContextFormTokenClaims;
  let actual: Buffer;
  try {
    const decoded = Buffer.from(parts[1], "base64url");
    if (decoded.toString("base64url") !== parts[1]) throw new Error("non-canonical encoding");
    const parsed = payloadSchema.safeParse(JSON.parse(decoded.toString("utf8")));
    if (!parsed.success) throw new Error("invalid payload");
    payload = parsed.data;
    actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== 32 || actual.toString("base64url") !== parts[2]) throw new Error("invalid signature encoding");
  } catch { throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID"); }
  const materials = [environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY,
    environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim()].filter((value): value is string => Boolean(value));
  const keys = materials.map(purposeKey).filter((key) => keyId(key) === payload.kid);
  if (keys.length !== 1) throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  const computed = signature(keys[0], parts[1], binding);
  if (!timingSafeEqual(computed, actual)) throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_STALE");
  if (payload.exp - payload.iat !== QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_TTL_SECONDS) {
    throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.iat > nowSeconds + QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_INVALID");
  }
  if (nowSeconds > payload.exp + QUICKBOOKS_TAX_CONTEXT_FORM_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_EXPIRED");
  }
  const expectedPayload = { ...expected };
  for (const [short, value] of Object.entries(expectedPayload)) {
    if (payload[short as keyof QuickBooksTaxContextFormTokenClaims] !== value) {
      throw new QuickBooksTaxContextFormTokenError("QUICKBOOKS_TAX_CONTEXT_FORM_STALE");
    }
  }
  return payload;
}
