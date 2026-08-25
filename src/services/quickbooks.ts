import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { QuickBooksConnection } from "@prisma/client";
import type { env } from "../config/env";

const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QUICKBOOKS_SECRET_ENVELOPE_VERSION = "v2";

type RuntimeEnv = typeof env;

export type QuickBooksTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

export type QuickBooksApiRef = {
  value: string;
  name?: string | null;
};

export type QuickBooksCustomerEntity = {
  Id: string;
  DisplayName?: string;
  Active?: boolean;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
};

export type QuickBooksItemEntity = {
  Id: string;
  Name?: string;
  Active?: boolean;
  Type?: string;
  IncomeAccountRef?: QuickBooksApiRef;
};

export type QuickBooksAccountEntity = {
  Id: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
};

export type QuickBooksInvoiceEntity = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  PrivateNote?: string;
  CustomerRef?: QuickBooksApiRef;
  TotalAmt?: number;
  Balance?: number;
  EmailStatus?: string;
  CurrencyRef?: QuickBooksApiRef;
  Line?: Array<{
    Description?: string;
    Amount?: number;
    DetailType?: string;
    SalesItemLineDetail?: {
      Qty?: number;
      UnitPrice?: number;
      ItemRef?: QuickBooksApiRef;
    };
  }>;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
};

export type QuickBooksInvoiceStatus = {
  invoiceId: string;
  docNumber: string | null;
  txnDate: string | null;
  dueDate: string | null;
  totalAmount: number;
  balance: number;
  currency: string | null;
  emailStatus: string | null;
  linkedPayments: Array<{ txnId: string; txnType: string }>;
  paid: boolean;
};

export class QuickBooksProviderError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous: boolean,
    readonly statusCode?: number,
  ) {
    super(code);
  }
}

export function classifyQuickBooksProviderFailure(error: unknown): {
  code: string;
  ambiguous: boolean;
} {
  if (error instanceof QuickBooksProviderError) {
    return { code: error.code, ambiguous: error.ambiguous };
  }
  return { code: "QUICKBOOKS_PROVIDER_RESULT_UNKNOWN", ambiguous: true };
}

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

export function isQuickBooksWebhookConfigured(runtimeEnv: RuntimeEnv): boolean {
  return runtimeEnv.QUICKBOOKS_WEBHOOK_VERIFIER.trim().length > 0;
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

export function escapeQuickBooksQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function normalizeQuickBooksName(value: string, maxLength = 100): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

async function quickBooksApiRequest<T>(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const mutation = (init.method ?? "GET").toUpperCase() !== "GET";
  let response: Response;
  try {
    response = await fetch(`${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new QuickBooksProviderError(
      mutation ? "QUICKBOOKS_MUTATION_RESULT_UNKNOWN" : "QUICKBOOKS_NETWORK_ERROR",
      mutation,
    );
  }

  const responseBody = await response.text();
  if (!response.ok) {
    const ambiguous = mutation && (response.status === 408 || response.status === 429 || response.status >= 500);
    throw new QuickBooksProviderError(`QUICKBOOKS_HTTP_${response.status}`, ambiguous, response.status);
  }

  try {
    return responseBody ? (JSON.parse(responseBody) as T) : (undefined as T);
  } catch {
    throw new QuickBooksProviderError(
      mutation ? "QUICKBOOKS_MUTATION_RESPONSE_INVALID" : "QUICKBOOKS_RESPONSE_INVALID",
      mutation,
      response.status,
    );
  }
}

export async function queryQuickBooksEntity<T>(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  query: string,
  entityName: string,
): Promise<T[]> {
  let response: Response;
  try {
    response = await fetch(`${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/text",
      },
      body: query,
    });
  } catch {
    throw new QuickBooksProviderError("QUICKBOOKS_QUERY_NETWORK_ERROR", false);
  }

  const responseBody = await response.text();
  if (!response.ok) {
    throw new QuickBooksProviderError(`QUICKBOOKS_QUERY_HTTP_${response.status}`, false, response.status);
  }

  let payload: { QueryResponse?: Record<string, T[] | undefined> };
  try {
    payload = responseBody
      ? (JSON.parse(responseBody) as { QueryResponse?: Record<string, T[] | undefined> })
      : {};
  } catch {
    throw new QuickBooksProviderError("QUICKBOOKS_QUERY_RESPONSE_INVALID", false, response.status);
  }

  const results = payload.QueryResponse?.[entityName];
  return Array.isArray(results) ? results : [];
}

export async function findQuickBooksCustomerByDisplayName(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  displayName: string,
): Promise<QuickBooksCustomerEntity | null> {
  const normalizedName = normalizeQuickBooksName(displayName);
  const activeCustomers = await queryQuickBooksEntity<QuickBooksCustomerEntity>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Customer WHERE DisplayName = '${escapeQuickBooksQueryValue(normalizedName)}' AND Active = true MAXRESULTS 1`,
    "Customer",
  );

  if (activeCustomers[0]) {
    return activeCustomers[0];
  }

  return null;
}

export async function createQuickBooksCustomer(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  input: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
  },
): Promise<QuickBooksCustomerEntity> {
  const payload = await quickBooksApiRequest<{ Customer: QuickBooksCustomerEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    "/customer",
    {
      method: "POST",
      body: JSON.stringify({
        DisplayName: normalizeQuickBooksName(input.displayName),
        ...(input.email ? { PrimaryEmailAddr: { Address: input.email.trim().toLowerCase() } } : {}),
        ...(input.phone ? { PrimaryPhone: { FreeFormNumber: input.phone.trim() } } : {}),
      }),
    },
  );

  return payload.Customer;
}

export async function findQuickBooksItemByName(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  itemName: string,
): Promise<QuickBooksItemEntity | null> {
  const normalizedName = normalizeQuickBooksName(itemName);
  const activeItems = await queryQuickBooksEntity<QuickBooksItemEntity>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Item WHERE Name = '${escapeQuickBooksQueryValue(normalizedName)}' AND Active = true MAXRESULTS 1`,
    "Item",
  );

  if (activeItems[0]) {
    return activeItems[0];
  }

  return null;
}

export async function resolveQuickBooksIncomeAccount(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
): Promise<QuickBooksApiRef> {
  const preferredAccounts = await queryQuickBooksEntity<QuickBooksAccountEntity>(
    runtimeEnv,
    realmId,
    accessToken,
    "SELECT * FROM Account WHERE AccountSubType = 'SalesOfProductIncome' AND Active = true MAXRESULTS 1",
    "Account",
  );

  const fallbackAccounts =
    preferredAccounts[0]
      ? preferredAccounts
      : await queryQuickBooksEntity<QuickBooksAccountEntity>(
          runtimeEnv,
          realmId,
          accessToken,
          "SELECT * FROM Account WHERE AccountType = 'Income' AND Active = true MAXRESULTS 1",
          "Account",
        );

  const account = fallbackAccounts[0];
  if (!account?.Id) {
    throw new Error("QuickBooks income account not found. Create or enable an income account in QuickBooks first.");
  }

  return {
    value: account.Id,
    name: account.Name ?? null,
  };
}

export async function createQuickBooksServiceItem(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  input: {
    name: string;
    description?: string | null;
    unitPrice?: number | null;
    incomeAccountRef: QuickBooksApiRef;
  },
): Promise<QuickBooksItemEntity> {
  const payload = await quickBooksApiRequest<{ Item: QuickBooksItemEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    "/item",
    {
      method: "POST",
      body: JSON.stringify({
        Name: normalizeQuickBooksName(input.name),
        Active: true,
        Type: "Service",
        ...(input.description ? { Description: input.description.slice(0, 4000) } : {}),
        ...(typeof input.unitPrice === "number" && Number.isFinite(input.unitPrice)
          ? { UnitPrice: Number(input.unitPrice.toFixed(2)) }
          : {}),
        IncomeAccountRef: input.incomeAccountRef,
      }),
    },
  );

  return payload.Item;
}

export async function createQuickBooksInvoice(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  payload: Record<string, unknown>,
  providerRequestId?: string,
): Promise<QuickBooksInvoiceEntity> {
  const requestQuery = providerRequestId
    ? `?requestid=${encodeURIComponent(providerRequestId)}`
    : "";
  const response = await quickBooksApiRequest<{ Invoice: QuickBooksInvoiceEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/invoice${requestQuery}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  return response.Invoice;
}

export async function findQuickBooksInvoicesByDocNumber(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  docNumber: string,
): Promise<QuickBooksInvoiceEntity[]> {
  return queryQuickBooksEntity<QuickBooksInvoiceEntity>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Invoice WHERE DocNumber = '${escapeQuickBooksQueryValue(docNumber)}' MAXRESULTS 100`,
    "Invoice",
  );
}

function normalizedFingerprintText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizedFingerprintNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

type QuickBooksInvoiceFingerprintInput = Record<string, unknown> | QuickBooksInvoiceEntity;

/**
 * Hashes only the immutable business fields QuoteFly reviewed before publishing.
 * QuickBooks-generated IDs, sync tokens, payment links, and response metadata are
 * deliberately excluded so reconciliation cannot bind a same-number collision.
 */
export function quickBooksInvoiceFingerprint(input: QuickBooksInvoiceFingerprintInput): string {
  const record = input as Record<string, unknown>;
  const customerRef = (record.CustomerRef ?? {}) as Record<string, unknown>;
  const currencyRef = (record.CurrencyRef ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(record.Line)
    ? record.Line
      .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === "object")
      .filter((line) => line.DetailType === "SalesItemLineDetail")
      .map((line) => {
        const detail = (line.SalesItemLineDetail ?? {}) as Record<string, unknown>;
        const itemRef = (detail.ItemRef ?? {}) as Record<string, unknown>;
        return {
          description: normalizedFingerprintText(line.Description),
          amount: normalizedFingerprintNumber(line.Amount),
          quantity: normalizedFingerprintNumber(detail.Qty),
          unitPrice: normalizedFingerprintNumber(detail.UnitPrice),
          itemRef: normalizedFingerprintText(itemRef.value),
        };
      })
    : [];
  const calculatedTotal = Number(lines.reduce((sum, line) => sum + (line.amount ?? 0), 0).toFixed(2));
  const canonical = {
    docNumber: normalizedFingerprintText(record.DocNumber),
    txnDate: normalizedFingerprintText(record.TxnDate),
    dueDate: normalizedFingerprintText(record.DueDate),
    marker: normalizedFingerprintText(record.PrivateNote),
    customerRef: normalizedFingerprintText(customerRef.value),
    currency: normalizedFingerprintText(currencyRef.value ?? currencyRef.name) ?? "USD",
    totalAmount: normalizedFingerprintNumber(record.TotalAmt) ?? calculatedTotal,
    lines,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export async function fetchQuickBooksInvoice(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  invoiceId: string,
): Promise<QuickBooksInvoiceEntity> {
  const response = await quickBooksApiRequest<{ Invoice: QuickBooksInvoiceEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/invoice/${invoiceId}`,
  );

  return response.Invoice;
}

export function summarizeQuickBooksInvoice(invoice: QuickBooksInvoiceEntity): QuickBooksInvoiceStatus {
  const balance = Number(invoice.Balance ?? 0);
  return {
    invoiceId: invoice.Id,
    docNumber: invoice.DocNumber ?? null,
    txnDate: invoice.TxnDate ?? null,
    dueDate: invoice.DueDate ?? null,
    totalAmount: Number(invoice.TotalAmt ?? 0),
    balance,
    currency: invoice.CurrencyRef?.name ?? null,
    emailStatus: invoice.EmailStatus ?? null,
    linkedPayments: (invoice.LinkedTxn ?? [])
      .filter((txn) => txn.TxnId && txn.TxnType)
      .map((txn) => ({ txnId: txn.TxnId as string, txnType: txn.TxnType as string })),
    paid: balance <= 0,
  };
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
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createHmac("sha256", runtimeEnv.JWT_SECRET).update(encodedPayload).digest("base64url");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;

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
    throw new Error(`QuickBooks token exchange failed with status ${response.status}.`);
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
    throw new Error(`QuickBooks token refresh failed with status ${response.status}.`);
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
  if (!value) {
    throw new Error("QuickBooks secret value is required.");
  }

  const encryptionSecret = runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim() || runtimeEnv.JWT_SECRET;
  const key = createHash("sha256").update(encryptionSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    QUICKBOOKS_SECRET_ENVELOPE_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptQuickBooksSecret(runtimeEnv: RuntimeEnv, encryptedValue: string): string {
  const parts = encryptedValue.split(".");
  const isCurrentEnvelope = parts.length === 4 && parts[0] === QUICKBOOKS_SECRET_ENVELOPE_VERSION;
  const isLegacyEnvelope = parts.length === 3;
  if (!isCurrentEnvelope && !isLegacyEnvelope) {
    throw new Error("QuickBooks secret payload is invalid.");
  }

  const [ivPart, authTagPart, payloadPart] = isCurrentEnvelope ? parts.slice(1) : parts;
  if (
    !ivPart ||
    !authTagPart ||
    !payloadPart ||
    ![ivPart, authTagPart, payloadPart].every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error("QuickBooks secret payload is invalid.");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(authTagPart, "base64url");
  const encryptedPayload = Buffer.from(payloadPart, "base64url");
  if (iv.length !== 12 || authTag.length !== 16 || encryptedPayload.length === 0) {
    throw new Error("QuickBooks secret payload is invalid.");
  }

  const candidateSecrets = isCurrentEnvelope
    ? [
        runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim() || runtimeEnv.JWT_SECRET,
        runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS.trim(),
      ].filter((candidate, index, candidates) => candidate && candidates.indexOf(candidate) === index)
    : [runtimeEnv.JWT_SECRET];

  for (const candidateSecret of candidateSecrets) {
    try {
      const key = createHash("sha256").update(candidateSecret).digest();
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedPayload),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      // Rotation deliberately tries the previous key without exposing which key failed.
    }
  }

  throw new Error("QuickBooks secret payload is invalid.");
}

export function buildQuickBooksAdminRedirect(runtimeEnv: RuntimeEnv, state: string): string {
  return `${runtimeEnv.APP_URL.replace(/\/$/, "")}/app/admin?integrations=${encodeURIComponent(state)}`;
}

export function verifyQuickBooksWebhookSignature(
  runtimeEnv: RuntimeEnv,
  payload: string,
  signature: string,
): boolean {
  if (!isQuickBooksWebhookConfigured(runtimeEnv)) {
    return false;
  }

  const computed = createHmac("sha256", runtimeEnv.QUICKBOOKS_WEBHOOK_VERIFIER)
    .update(payload, "utf8")
    .digest("base64");

  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(computed, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export const QUICKBOOKS_ACCOUNTING_SCOPE = ACCOUNTING_SCOPE;
