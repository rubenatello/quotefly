import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";
import type { QuickBooksConnection } from "@prisma/client";
import type { env } from "../config/env";

const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

type RuntimeEnv = typeof env;

export type QuickBooksTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

type SignedStatePayload = {
  tenantId: string;
  userId: string;
  role: string;
  nonce: string;
  exp: number;
};

export function isQuickBooksConfigured(runtimeEnv: RuntimeEnv): boolean {
  return runtimeEnv.QUICKBOOKS_CLIENT_ID.trim().length > 0 && runtimeEnv.QUICKBOOKS_CLIENT_SECRET.trim().length > 0;
}

export function getQuickBooksRedirectUri(runtimeEnv: RuntimeEnv): string {
  if (runtimeEnv.QUICKBOOKS_REDIRECT_URI.trim()) {
    return runtimeEnv.QUICKBOOKS_REDIRECT_URI.trim();
  }

  return `${runtimeEnv.API_URL.replace(/\/$/, "")}/v1/integrations/quickbooks/callback`;
}

export function getQuickBooksApiBaseUrl(runtimeEnv: RuntimeEnv): string {
  return runtimeEnv.QUICKBOOKS_ENVIRONMENT === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

export function buildQuickBooksAuthorizationUrl(runtimeEnv: RuntimeEnv, state: string): string {
  const url = new URL(QUICKBOOKS_AUTHORIZE_URL);
  url.searchParams.set("client_id", runtimeEnv.QUICKBOOKS_CLIENT_ID);
  url.searchParams.set("redirect_uri", getQuickBooksRedirectUri(runtimeEnv));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ACCOUNTING_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export function createSignedQuickBooksState(
  runtimeEnv: RuntimeEnv,
  input: { tenantId: string; userId: string; role: string },
): string {
  const payload: SignedStatePayload = {
    tenantId: input.tenantId,
    userId: input.userId,
    role: input.role,
    nonce: randomBytes(12).toString("hex"),
    exp: Date.now() + 10 * 60 * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", runtimeEnv.JWT_SECRET).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifySignedQuickBooksState(runtimeEnv: RuntimeEnv, state: string): SignedStatePayload | null {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createHmac("sha256", runtimeEnv.JWT_SECRET).update(encodedPayload).digest("base64url");
  if (signature !== expectedSignature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SignedStatePayload;
    if (!payload?.tenantId || !payload?.userId || !payload?.role || !payload?.nonce || !payload?.exp) return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function exchangeQuickBooksAuthorizationCode(
  runtimeEnv: RuntimeEnv,
  code: string,
): Promise<QuickBooksTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getQuickBooksRedirectUri(runtimeEnv),
  });

  const credentials = Buffer.from(
    `${runtimeEnv.QUICKBOOKS_CLIENT_ID}:${runtimeEnv.QUICKBOOKS_CLIENT_SECRET}`,
    "utf8",
  ).toString("base64");

  const response = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QuickBooks token exchange failed: ${response.status} ${errorBody}`);
  }

  return (await response.json()) as QuickBooksTokenResponse;
}

export async function fetchQuickBooksCompanyInfo(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
): Promise<{ companyName: string | null }> {
  const response = await fetch(
    `${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}/companyinfo/${realmId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    return { companyName: null };
  }

  const payload = (await response.json()) as {
    CompanyInfo?: {
      CompanyName?: string;
      LegalName?: string;
    };
  };

  return {
    companyName: payload.CompanyInfo?.CompanyName ?? payload.CompanyInfo?.LegalName ?? null,
  };
}

export async function refreshQuickBooksAccessToken(
  runtimeEnv: RuntimeEnv,
  refreshToken: string,
): Promise<QuickBooksTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const credentials = Buffer.from(
    `${runtimeEnv.QUICKBOOKS_CLIENT_ID}:${runtimeEnv.QUICKBOOKS_CLIENT_SECRET}`,
    "utf8",
  ).toString("base64");

  const response = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QuickBooks token refresh failed: ${response.status} ${errorBody}`);
  }

  return (await response.json()) as QuickBooksTokenResponse;
}

export async function ensureQuickBooksAccessToken(
  runtimeEnv: RuntimeEnv,
  connection: Pick<
    QuickBooksConnection,
    | "id"
    | "accessTokenEncrypted"
    | "refreshTokenEncrypted"
    | "accessTokenExpiresAtUtc"
    | "tenantId"
  >,
  save: (input: {
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    accessTokenExpiresAtUtc: Date;
    lastTokenRefreshAtUtc: Date;
    refreshTokenRotatedAtUtc: Date;
  }) => Promise<void>,
): Promise<string> {
  const accessToken = connection.accessTokenEncrypted ? decryptQuickBooksSecret(runtimeEnv, connection.accessTokenEncrypted) : null;
  const refreshToken = connection.refreshTokenEncrypted
    ? decryptQuickBooksSecret(runtimeEnv, connection.refreshTokenEncrypted)
    : null;

  if (!refreshToken) {
    throw new Error("QuickBooks refresh token is missing. Reconnect the workspace.");
  }

  const expiresAt = connection.accessTokenExpiresAtUtc?.getTime() ?? 0;
  if (accessToken && expiresAt > Date.now() + 60_000) {
    return accessToken;
  }

  const refreshed = await refreshQuickBooksAccessToken(runtimeEnv, refreshToken);
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + refreshed.expires_in * 1000);

  await save({
    accessTokenEncrypted: encryptQuickBooksSecret(runtimeEnv, refreshed.access_token),
    refreshTokenEncrypted: encryptQuickBooksSecret(runtimeEnv, refreshed.refresh_token),
    accessTokenExpiresAtUtc: nextExpiry,
    lastTokenRefreshAtUtc: now,
    refreshTokenRotatedAtUtc: now,
  });

  return refreshed.access_token;
}

export function encryptQuickBooksSecret(runtimeEnv: RuntimeEnv, value: string): string {
  const key = createHash("sha256").update(runtimeEnv.JWT_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${authTag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptQuickBooksSecret(runtimeEnv: RuntimeEnv, encryptedValue: string): string {
  const [ivPart, authTagPart, payloadPart] = encryptedValue.split(".");
  if (!ivPart || !authTagPart || !payloadPart) {
    throw new Error("QuickBooks secret payload is invalid.");
  }

  const key = createHash("sha256").update(runtimeEnv.JWT_SECRET).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadPart, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function buildQuickBooksAdminRedirect(runtimeEnv: RuntimeEnv, state: string): string {
  return `${runtimeEnv.APP_URL.replace(/\/$/, "")}/app/admin?integrations=${encodeURIComponent(state)}`;
}

export const QUICKBOOKS_ACCOUNTING_SCOPE = ACCOUNTING_SCOPE;
