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
  TotalAmt?: number;
  Balance?: number;
  EmailStatus?: string;
  CurrencyRef?: { name?: string };
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
  const response = await fetch(`${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`QuickBooks API request failed: ${response.status} ${responseBody}`);
  }

  return responseBody ? (JSON.parse(responseBody) as T) : (undefined as T);
}

export async function queryQuickBooksEntity<T>(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  query: string,
  entityName: string,
): Promise<T[]> {
  const response = await fetch(`${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/text",
    },
    body: query,
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`QuickBooks query failed: ${response.status} ${responseBody}`);
  }

  const payload = responseBody
    ? (JSON.parse(responseBody) as { QueryResponse?: Record<string, T[] | undefined> })
    : {};

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
): Promise<QuickBooksInvoiceEntity> {
  const response = await quickBooksApiRequest<{ Invoice: QuickBooksInvoiceEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    "/invoice",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  return response.Invoice;
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
