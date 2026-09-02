import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { QuickBooksConnection } from "@prisma/client";
import type { env } from "../config/env";
import { z } from "zod";

const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QUICKBOOKS_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const QUICKBOOKS_SECRET_ENVELOPE_VERSION = "v2";
const QUICKBOOKS_OAUTH_STATE_ENVELOPE_VERSION = "qbo2";

type RuntimeEnv = typeof env;

const QuickBooksRefSchema = z.object({
  value: z.string().min(1),
  name: z.string().nullable().optional(),
}).passthrough();

const QuickBooksCustomerSchema = z.object({
  Id: z.string().min(1),
  DisplayName: z.string().optional(),
  Active: z.boolean().optional(),
  PrimaryEmailAddr: z.object({ Address: z.string().optional() }).passthrough().optional(),
  PrimaryPhone: z.object({ FreeFormNumber: z.string().optional() }).passthrough().optional(),
}).passthrough();

const QuickBooksItemSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().optional(),
  Active: z.boolean().optional(),
  Type: z.string().optional(),
  IncomeAccountRef: QuickBooksRefSchema.optional(),
}).passthrough();

const QuickBooksLinkedTxnSchema = z.object({
  TxnId: z.string().optional(),
  TxnType: z.string().optional(),
}).passthrough();

const QuickBooksInvoiceSchema = z.object({
  Id: z.string().min(1),
  SyncToken: z.string().optional(),
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  DueDate: z.string().optional(),
  PrivateNote: z.string().optional(),
  CustomerRef: QuickBooksRefSchema.optional(),
  TotalAmt: z.number().finite().optional(),
  Balance: z.number().finite().optional(),
  EmailStatus: z.string().optional(),
  TxnStatus: z.string().optional(),
  InvoiceLink: z.string().optional(),
  AllowOnlinePayment: z.boolean().optional(),
  AllowOnlineACHPayment: z.boolean().optional(),
  AllowOnlineCreditCardPayment: z.boolean().optional(),
  CurrencyRef: QuickBooksRefSchema.optional(),
  MetaData: z.object({ CreateTime: z.string().optional(), LastUpdatedTime: z.string().optional() }).passthrough().optional(),
  Line: z.array(z.object({
    Description: z.string().optional(),
    Amount: z.number().finite().optional(),
    DetailType: z.string().optional(),
    SalesItemLineDetail: z.object({
      Qty: z.number().finite().optional(),
      UnitPrice: z.number().finite().optional(),
      ItemRef: QuickBooksRefSchema.optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
  LinkedTxn: z.array(QuickBooksLinkedTxnSchema).optional(),
}).passthrough();

const QuickBooksReconciliationInvoiceSchema = QuickBooksInvoiceSchema.extend({
  SyncToken: z.string().regex(/^(0|[1-9][0-9]*)$/),
  TotalAmt: z.number().finite().nonnegative(),
  Balance: z.number().finite().nonnegative(),
  MetaData: z.object({
    CreateTime: z.string().optional(),
    LastUpdatedTime: z.string().datetime({ offset: true }),
  }).passthrough(),
}).passthrough();

const QuickBooksPaymentSchema = z.object({
  Id: z.string().min(1),
  SyncToken: z.string().optional(),
  TotalAmt: z.number().finite().optional(),
  UnappliedAmt: z.number().finite().optional(),
  TxnDate: z.string().optional(),
  CurrencyRef: QuickBooksRefSchema.optional(),
  MetaData: z.object({ CreateTime: z.string().optional(), LastUpdatedTime: z.string().optional() }).passthrough().optional(),
  Line: z.array(z.object({
    Amount: z.number().finite().optional(),
    LinkedTxn: z.array(QuickBooksLinkedTxnSchema).optional(),
  }).passthrough()).optional(),
}).passthrough();

// A RefundReceipt is a separate QuickBooks sales transaction. QuoteFly only
// accepts it as reconciliation evidence when the provider returns a positive
// amount, a customer identity, and a bounded set of canonical transaction
// links. The reconciliation layer applies the stricter invoice/payment link
// rules; this boundary prevents malformed or unbounded provider payloads from
// reaching that logic.
const QuickBooksRefundReceiptSchema = z.object({
  Id: z.string().min(1),
  SyncToken: z.string().optional(),
  TotalAmt: z.number().finite().nonnegative().optional(),
  TxnDate: z.string().optional(),
  CustomerRef: QuickBooksRefSchema.optional(),
  CurrencyRef: QuickBooksRefSchema.optional(),
  MetaData: z.object({ CreateTime: z.string().optional(), LastUpdatedTime: z.string().optional() }).passthrough().optional(),
  LinkedTxn: z.array(QuickBooksLinkedTxnSchema).max(100).optional(),
}).passthrough();

const QuickBooksRefundReceiptEvidenceSchema = QuickBooksRefundReceiptSchema.extend({
  TotalAmt: z.number().finite().positive(),
  CustomerRef: QuickBooksRefSchema,
  LinkedTxn: z.array(QuickBooksLinkedTxnSchema).min(1).max(100),
}).passthrough();

const QuickBooksTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  x_refresh_token_expires_in: z.number().int().positive().optional(),
}).passthrough();

const QuickBooksCdcSchema = z.object({
  CDCResponse: z.array(z.object({
    QueryResponse: z.array(z.object({
      Invoice: z.array(QuickBooksInvoiceSchema).optional(),
      Payment: z.array(QuickBooksPaymentSchema).optional(),
      RefundReceipt: z.array(QuickBooksRefundReceiptSchema).optional(),
    }).passthrough()).optional().default([]),
    time: z.string().optional(),
  }).passthrough()),
}).passthrough();

function parseQuickBooksEntity<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new QuickBooksProviderError(code, false);
  return parsed.data;
}

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
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  PrivateNote?: string;
  CustomerRef?: QuickBooksApiRef;
  TotalAmt?: number;
  Balance?: number;
  EmailStatus?: string;
  TxnStatus?: string;
  InvoiceLink?: string;
  AllowOnlinePayment?: boolean;
  AllowOnlineACHPayment?: boolean;
  AllowOnlineCreditCardPayment?: boolean;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
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

export type QuickBooksReconciliationInvoiceEntity = QuickBooksInvoiceEntity & {
  SyncToken: string;
  TotalAmt: number;
  Balance: number;
  MetaData: { CreateTime?: string; LastUpdatedTime: string };
};

export type QuickBooksPaymentEntity = {
  Id: string;
  SyncToken?: string;
  TotalAmt?: number;
  UnappliedAmt?: number;
  TxnDate?: string;
  CurrencyRef?: QuickBooksApiRef;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  Line?: Array<{
    Amount?: number;
    LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  }>;
};

export type QuickBooksRefundReceiptEntity = {
  Id: string;
  SyncToken?: string;
  TotalAmt?: number;
  TxnDate?: string;
  CustomerRef?: QuickBooksApiRef;
  CurrencyRef?: QuickBooksApiRef;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
};

export type QuickBooksRefundReceiptEvidenceEntity = QuickBooksRefundReceiptEntity & {
  TotalAmt: number;
  CustomerRef: QuickBooksApiRef;
  LinkedTxn: Array<{ TxnId?: string; TxnType?: string }>;
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

// InvoiceLink is available from minor version 36 onward. Keep this centrally
// pinned so provider contract changes are deliberate, reviewed, and tested.
export const QUICKBOOKS_INVOICE_LINK_MINOR_VERSION = "36";

/**
 * Reconciliation has a stricter boundary than previews or create responses:
 * financial projection requires an ordered provider generation and complete
 * totals. Keep this explicit so mocked/provider-adapter callers cannot bypass
 * the same fail-closed checks used for live QuickBooks responses.
 */
export function validateQuickBooksReconciliationInvoice(
  value: unknown,
): QuickBooksReconciliationInvoiceEntity {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
  if (!record || typeof record.TotalAmt !== "number" || !Number.isFinite(record.TotalAmt) || record.TotalAmt < 0) {
    throw new QuickBooksProviderError("QUICKBOOKS_INVOICE_TOTAL_INVALID", false);
  }
  if (typeof record.Balance !== "number" || !Number.isFinite(record.Balance)) {
    throw new QuickBooksProviderError("QUICKBOOKS_INVOICE_BALANCE_INVALID", false);
  }
  if (record.Balance < 0 || record.Balance > record.TotalAmt) {
    throw new QuickBooksProviderError("QUICKBOOKS_INVOICE_BALANCE_RANGE_INVALID", false);
  }
  const metadata = record.MetaData && typeof record.MetaData === "object"
    ? record.MetaData as Record<string, unknown>
    : null;
  const lastUpdatedTime = metadata?.LastUpdatedTime;
  const parsedLastUpdatedTime = typeof lastUpdatedTime === "string"
    ? new Date(lastUpdatedTime)
    : null;
  if (
    typeof record.SyncToken !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(record.SyncToken)
    || !parsedLastUpdatedTime
    || Number.isNaN(parsedLastUpdatedTime.getTime())
  ) {
    throw new QuickBooksProviderError("QUICKBOOKS_INVOICE_FRESHNESS_INVALID", false);
  }
  return parseQuickBooksEntity(
    QuickBooksReconciliationInvoiceSchema,
    value,
    "QUICKBOOKS_INVOICE_RECONCILIATION_RESPONSE_INVALID",
  ) as QuickBooksReconciliationInvoiceEntity;
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

const SignedStatePayloadSchema = z.object({
  tenantId: z.string().min(1).max(191),
  userId: z.string().min(1).max(191),
  role: z.string().min(1).max(32),
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
  exp: z.number().int().positive(),
}).strict();

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

const QUICKBOOKS_TRANSIENT_READ_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function quickBooksRetryDelayMs(response: Response, attempt: number): number | null {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      const delay = Math.max(0, seconds * 1_000);
      return delay <= 2_000 ? delay : null;
    }
    const target = Date.parse(retryAfter);
    if (Number.isFinite(target)) {
      const delay = Math.max(0, target - Date.now());
      return delay <= 2_000 ? delay : null;
    }
  }
  return Math.min(2_000, 200 * (2 ** attempt));
}

function waitForQuickBooksRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function quickBooksFetch(
  runtimeEnv: RuntimeEnv,
  url: string,
  init: RequestInit,
  retryRead: boolean,
): Promise<Response> {
  const maxAttempts = retryRead ? runtimeEnv.QUICKBOOKS_PROVIDER_READ_RETRIES + 1 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(runtimeEnv.QUICKBOOKS_PROVIDER_TIMEOUT_MS),
      });
    } catch {
      if (retryRead && attempt + 1 < maxAttempts) {
        await waitForQuickBooksRetry(Math.min(2_000, 200 * (2 ** attempt)));
        continue;
      }
      throw new QuickBooksProviderError(
        retryRead ? "QUICKBOOKS_READ_TIMEOUT" : "QUICKBOOKS_MUTATION_RESULT_UNKNOWN",
        !retryRead,
      );
    }
    if (
      retryRead
      && QUICKBOOKS_TRANSIENT_READ_STATUSES.has(response.status)
      && attempt + 1 < maxAttempts
    ) {
      const retryDelayMs = quickBooksRetryDelayMs(response, attempt);
      if (retryDelayMs === null) return response;
      await response.body?.cancel().catch(() => undefined);
      await waitForQuickBooksRetry(retryDelayMs);
      continue;
    }
    return response;
  }
  throw new QuickBooksProviderError("QUICKBOOKS_READ_RETRY_EXHAUSTED", false);
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
    response = await quickBooksFetch(runtimeEnv, `${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    }, !mutation);
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
    response = await quickBooksFetch(runtimeEnv, `${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/text",
      },
      body: query,
    }, true);
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

  return parseQuickBooksEntity(QuickBooksInvoiceSchema, response.Invoice, "QUICKBOOKS_INVOICE_RESPONSE_INVALID");
}

export async function findQuickBooksInvoicesByDocNumber(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  docNumber: string,
): Promise<QuickBooksInvoiceEntity[]> {
  const results = await queryQuickBooksEntity<QuickBooksInvoiceEntity>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Invoice WHERE DocNumber = '${escapeQuickBooksQueryValue(docNumber)}' MAXRESULTS 100`,
    "Invoice",
  );
  return results.map((result) => parseQuickBooksEntity(
    QuickBooksInvoiceSchema,
    result,
    "QUICKBOOKS_INVOICE_QUERY_RESPONSE_INVALID",
  ));
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
  const query = new URLSearchParams({
    include: "invoiceLink",
    minorversion: QUICKBOOKS_INVOICE_LINK_MINOR_VERSION,
  });
  const response = await quickBooksApiRequest<{ Invoice: QuickBooksInvoiceEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/invoice/${encodeURIComponent(invoiceId)}?${query.toString()}`,
  );

  return parseQuickBooksEntity(QuickBooksInvoiceSchema, response.Invoice, "QUICKBOOKS_INVOICE_RESPONSE_INVALID");
}

export function validateQuickBooksInvoiceLink(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const approved = hostname === "intuit.com"
      || hostname.endsWith(".intuit.com")
      || hostname === "quickbooks.com"
      || hostname.endsWith(".quickbooks.com");
    if (url.protocol !== "https:" || !approved || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function fetchQuickBooksPayment(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  paymentId: string,
): Promise<QuickBooksPaymentEntity> {
  const response = await quickBooksApiRequest<{ Payment: QuickBooksPaymentEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/payment/${encodeURIComponent(paymentId)}`,
  );
  return parseQuickBooksEntity(QuickBooksPaymentSchema, response?.Payment, "QUICKBOOKS_PAYMENT_RESPONSE_INVALID");
}

export async function fetchQuickBooksRefundReceipt(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  refundReceiptId: string,
): Promise<QuickBooksRefundReceiptEvidenceEntity> {
  const response = await quickBooksApiRequest<{ RefundReceipt: QuickBooksRefundReceiptEvidenceEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/refundreceipt/${encodeURIComponent(refundReceiptId)}`,
  );
  return parseQuickBooksEntity(
    QuickBooksRefundReceiptEvidenceSchema,
    response?.RefundReceipt,
    "QUICKBOOKS_REFUND_RECEIPT_RESPONSE_INVALID",
  ) as QuickBooksRefundReceiptEvidenceEntity;
}

export async function fetchQuickBooksCustomer(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  customerId: string,
): Promise<QuickBooksCustomerEntity> {
  const response = await quickBooksApiRequest<{ Customer: QuickBooksCustomerEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/customer/${encodeURIComponent(customerId)}`,
  );
  const customer = parseQuickBooksEntity(QuickBooksCustomerSchema, response?.Customer, "QUICKBOOKS_CUSTOMER_RESPONSE_INVALID");
  if (customer.Active === false) {
    throw new QuickBooksProviderError("QUICKBOOKS_CUSTOMER_NOT_ACTIVE", false);
  }
  return customer;
}

export async function fetchQuickBooksItem(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  itemId: string,
): Promise<QuickBooksItemEntity> {
  const response = await quickBooksApiRequest<{ Item: QuickBooksItemEntity }>(
    runtimeEnv,
    realmId,
    accessToken,
    `/item/${encodeURIComponent(itemId)}`,
  );
  const item = parseQuickBooksEntity(QuickBooksItemSchema, response?.Item, "QUICKBOOKS_ITEM_RESPONSE_INVALID");
  if (item.Active === false) {
    throw new QuickBooksProviderError("QUICKBOOKS_ITEM_NOT_ACTIVE", false);
  }
  return item;
}

export async function searchQuickBooksCustomers(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  queryText: string,
  limit: number,
): Promise<QuickBooksCustomerEntity[]> {
  const normalized = normalizeQuickBooksName(queryText, 80);
  const boundedLimit = Math.min(25, Math.max(1, Math.trunc(limit)));
  const results = await queryQuickBooksEntity<unknown>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Customer WHERE DisplayName LIKE '%${escapeQuickBooksQueryValue(normalized)}%' AND Active = true MAXRESULTS ${boundedLimit}`,
    "Customer",
  );
  return results.map((result) => parseQuickBooksEntity(
    QuickBooksCustomerSchema,
    result,
    "QUICKBOOKS_CUSTOMER_QUERY_RESPONSE_INVALID",
  ));
}

export async function searchQuickBooksItems(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  queryText: string,
  limit: number,
): Promise<QuickBooksItemEntity[]> {
  const normalized = normalizeQuickBooksName(queryText, 80);
  const boundedLimit = Math.min(25, Math.max(1, Math.trunc(limit)));
  const results = await queryQuickBooksEntity<unknown>(
    runtimeEnv,
    realmId,
    accessToken,
    `SELECT * FROM Item WHERE Name LIKE '%${escapeQuickBooksQueryValue(normalized)}%' AND Active = true MAXRESULTS ${boundedLimit}`,
    "Item",
  );
  return results.map((result) => parseQuickBooksEntity(
    QuickBooksItemSchema,
    result,
    "QUICKBOOKS_ITEM_QUERY_RESPONSE_INVALID",
  ));
}

export async function fetchQuickBooksCdc(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  changedSinceUtc: Date,
): Promise<{
  invoices: QuickBooksInvoiceEntity[];
  payments: QuickBooksPaymentEntity[];
  refundReceipts: QuickBooksRefundReceiptEntity[];
  providerTime: Date | null;
}> {
  const response = await quickBooksApiRequest<unknown>(
    runtimeEnv,
    realmId,
    accessToken,
    `/cdc?entities=Invoice,Payment,RefundReceipt&changedSince=${encodeURIComponent(changedSinceUtc.toISOString())}`,
  );
  const payload = parseQuickBooksEntity(QuickBooksCdcSchema, response, "QUICKBOOKS_CDC_RESPONSE_INVALID");
  const invoices: QuickBooksInvoiceEntity[] = [];
  const payments: QuickBooksPaymentEntity[] = [];
  const refundReceipts: QuickBooksRefundReceiptEntity[] = [];
  let providerTime: Date | null = null;
  for (const batch of payload.CDCResponse) {
    for (const queryResponse of batch.QueryResponse) {
      invoices.push(...(queryResponse.Invoice ?? []));
      payments.push(...(queryResponse.Payment ?? []));
      refundReceipts.push(...(queryResponse.RefundReceipt ?? []));
    }
    if (batch.time) {
      const parsed = new Date(batch.time);
      if (!Number.isNaN(parsed.getTime())) providerTime = parsed;
    }
  }
  return { invoices, payments, refundReceipts, providerTime };
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
  const key = createHash("sha256")
    .update("quotefly:quickbooks:oauth-state:qbo2\0", "utf8")
    .update(runtimeEnv.JWT_SECRET, "utf8")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(QUICKBOOKS_OAUTH_STATE_ENVELOPE_VERSION, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    QUICKBOOKS_OAUTH_STATE_ENVELOPE_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function verifySignedQuickBooksState(runtimeEnv: RuntimeEnv, state: string): SignedStatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 4 || parts[0] !== QUICKBOOKS_OAUTH_STATE_ENVELOPE_VERSION) return null;
  const [, ivPart, authTagPart, encryptedPart] = parts;
  if (
    !ivPart
    || !authTagPart
    || !encryptedPart
    || ![ivPart, authTagPart, encryptedPart].every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) return null;

  try {
    const iv = Buffer.from(ivPart, "base64url");
    const authTag = Buffer.from(authTagPart, "base64url");
    const encrypted = Buffer.from(encryptedPart, "base64url");
    if (iv.length !== 12 || authTag.length !== 16 || encrypted.length === 0) return null;
    const key = createHash("sha256")
      .update("quotefly:quickbooks:oauth-state:qbo2\0", "utf8")
      .update(runtimeEnv.JWT_SECRET, "utf8")
      .digest();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(QUICKBOOKS_OAUTH_STATE_ENVELOPE_VERSION, "utf8"));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = SignedStatePayloadSchema.safeParse(JSON.parse(decrypted.toString("utf8")));
    if (!parsed.success) return null;
    const now = Date.now();
    if (parsed.data.exp < now || parsed.data.exp > now + 10 * 60 * 1000 + 30_000) return null;
    return parsed.data;
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

  const response = await quickBooksFetch(runtimeEnv, QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  }, false);

  if (!response.ok) {
    throw new Error(`QuickBooks token exchange failed with status ${response.status}.`);
  }

  return parseQuickBooksEntity(
    QuickBooksTokenSchema,
    await response.json(),
    "QUICKBOOKS_TOKEN_EXCHANGE_RESPONSE_INVALID",
  );
}

export async function fetchQuickBooksCompanyInfo(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
): Promise<{ realmId: string; companyName: string }> {
  const response = await quickBooksFetch(
    runtimeEnv,
    `${getQuickBooksApiBaseUrl(runtimeEnv)}/v3/company/${realmId}/companyinfo/${realmId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    true,
  );

  if (!response.ok) {
    throw new QuickBooksProviderError(`QUICKBOOKS_COMPANY_INFO_HTTP_${response.status}`, false, response.status);
  }

  const payload = z.object({
    CompanyInfo: z.object({
      Id: z.string().min(1),
      CompanyName: z.string().optional(),
      LegalName: z.string().optional(),
    }).passthrough(),
  }).passthrough().safeParse(await response.json());
  if (!payload.success) {
    throw new QuickBooksProviderError("QUICKBOOKS_COMPANY_INFO_RESPONSE_INVALID", false);
  }

  const providerRealmId = payload.data.CompanyInfo.Id.trim();
  const companyName = (payload.data.CompanyInfo.CompanyName ?? payload.data.CompanyInfo.LegalName)?.trim();
  if (!providerRealmId || providerRealmId !== realmId || !companyName) {
    throw new QuickBooksProviderError("QUICKBOOKS_COMPANY_INFO_REALM_MISMATCH", false);
  }

  return {
    realmId: providerRealmId,
    companyName,
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

  const response = await quickBooksFetch(runtimeEnv, QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  }, false);

  if (!response.ok) {
    throw new Error(`QuickBooks token refresh failed with status ${response.status}.`);
  }

  return parseQuickBooksEntity(
    QuickBooksTokenSchema,
    await response.json(),
    "QUICKBOOKS_TOKEN_REFRESH_RESPONSE_INVALID",
  );
}

export async function revokeQuickBooksToken(
  runtimeEnv: RuntimeEnv,
  token: string,
): Promise<void> {
  const credentials = Buffer.from(
    `${runtimeEnv.QUICKBOOKS_CLIENT_ID}:${runtimeEnv.QUICKBOOKS_CLIENT_SECRET}`,
    "utf8",
  ).toString("base64");
  const response = await quickBooksFetch(runtimeEnv, QUICKBOOKS_REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  }, false);
  if (!response.ok) {
    throw new QuickBooksProviderError(`QUICKBOOKS_REVOKE_HTTP_${response.status}`, false, response.status);
  }
}

export async function ensureQuickBooksAccessToken(
  runtimeEnv: RuntimeEnv,
  connection: Pick<
    QuickBooksConnection,
    | "id"
    | "accessTokenEncrypted"
    | "refreshTokenEncrypted"
    | "accessTokenExpiresAtUtc"
    | "environment"
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
  if (connection.environment !== runtimeEnv.QUICKBOOKS_ENVIRONMENT) {
    throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_ENVIRONMENT_MISMATCH", false, 409);
  }
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

  const encryptionSecret = runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim();
  if (encryptionSecret.length < 32) {
    throw new Error("QuickBooks token encryption key is not configured.");
  }
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
        runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY.trim(),
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
  return `${runtimeEnv.APP_URL.replace(/\/$/, "")}/app/settings?integrations=${encodeURIComponent(state)}#admin-quickbooks`;
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
