import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { setTenantRlsContext } from "../lib/tenant-rls";
import { quickBooksInvoiceFingerprint } from "./quickbooks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";

type Transaction = Prisma.TransactionClient;

const CLAIM_TTL_MS = 2 * 60 * 1000;

export class QuickBooksInvoiceOperationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const QuickBooksInvoiceOperationPublicSelect = {
  id: true,
  invoiceId: true,
  quickBooksConnectionId: true,
  providerRealmId: true,
  status: true,
  payloadHash: true,
  providerInvoiceId: true,
  providerDocNumber: true,
  providerInvoiceStatus: true,
  providerBalance: true,
  providerInvoiceLink: true,
  providerSyncToken: true,
  providerUpdatedAtUtc: true,
  invoiceLinkFetchedAtUtc: true,
  allowOnlineAchPayment: true,
  allowOnlineCardPayment: true,
  attemptCount: true,
  reconciliationCount: true,
  processingStartedAtUtc: true,
  claimExpiresAtUtc: true,
  lastAttemptAtUtc: true,
  lastReconciledAtUtc: true,
  succeededAtUtc: true,
  failedAtUtc: true,
  lastFailureCode: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.QuickBooksInvoiceOperationSelect;

export type QuickBooksInvoiceOperationPublic = Prisma.QuickBooksInvoiceOperationGetPayload<{
  select: typeof QuickBooksInvoiceOperationPublicSelect;
}>;

type ProviderLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  itemKey: string;
  quickBooksItemId: string | null;
  quickBooksItemName: string | null;
  reviewedAtUtc: Date | null;
};

export type QuickBooksHostedPaymentReview = Readonly<{
  billingEmail?: string | null;
  allowOnlineAchPayment?: boolean;
  allowOnlineCardPayment?: boolean;
}>;

function roundProviderMoney(value: number) {
  return Number(value.toFixed(2));
}

function providerQuantityAndUnitPrice(line: ProviderLine) {
  if (roundProviderMoney(line.quantity * line.unitPrice) === line.amount) {
    return { quantity: line.quantity, unitPrice: line.unitPrice };
  }

  // QuoteFly's immutable amount is authoritative when aggregate currency
  // rounding creates a one-cent residual. Normalize only the provider detail
  // for that line so QuickBooks Qty x UnitPrice remains equal to Amount.
  return { quantity: 1, unitPrice: line.amount };
}

type SyncContext = {
  invoice: {
    id: string;
    invoiceNumber: number;
    version: number;
    status: string;
    titleSnapshot: string;
    scopeSnapshot: string | null;
    currency: string;
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    createdAt: Date;
    dueAtUtc: Date | null;
    customerId: string;
    sourceQuoteId: string;
    customerName: string;
    billingEmail: string | null;
  };
  connection: null | {
    id: string;
    tenantId: string;
    realmId: string;
    companyName: string | null;
    status: string;
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted: string | null;
    accessTokenExpiresAtUtc: Date | null;
  };
  operation: QuickBooksInvoiceOperationPublic | null;
  lineItems: ProviderLine[];
  providerDocNumber: string;
  providerPayload: Record<string, unknown> | null;
  payloadHash: string | null;
  blockers: string[];
  paymentReview: {
    billingEmail: string | null;
    allowOnlineAchPayment: boolean;
    allowOnlineCardPayment: boolean;
  };
  customerMapping: {
    quickBooksCustomerId: string;
    quickBooksDisplayName: string | null;
    reviewedAtUtc: Date;
  } | null;
};

export type QuickBooksInvoiceSyncPreview = {
  invoice: {
    id: string;
    invoiceNumber: number;
    version: number;
    status: string;
    customerName: string;
    currency: string;
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    dueAtUtc: Date | null;
  };
  connection: null | {
    companyName: string | null;
    status: string;
  };
  quickBooksCustomerName: string | null;
  customerMapping: SyncContext["customerMapping"];
  billingEmail: string | null;
  paymentMethods: { ach: boolean; card: boolean };
  providerDocNumber: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    mapped: boolean;
    quickBooksItemName: string | null;
    itemKey: string;
    quickBooksItemId: string | null;
    reviewedAtUtc: Date | null;
  }>;
  blockers: string[];
  ready: boolean;
  reviewBinding: string | null;
  operation: QuickBooksInvoiceOperationPublic | null;
};

export type QuickBooksInvoicePublishClaim =
  | {
      duplicate: true;
      requiresReconciliation: boolean;
      claimToken: null;
      operation: QuickBooksInvoiceOperationPublic;
    }
  | {
      duplicate: false;
      requiresReconciliation: true;
      claimToken: null;
      operation: QuickBooksInvoiceOperationPublic;
    }
  | {
      duplicate: false;
      requiresReconciliation: false;
      claimToken: string;
      operation: QuickBooksInvoiceOperationPublic;
      connection: NonNullable<SyncContext["connection"]>;
      providerPayload: Record<string, unknown>;
      providerRequestId: string;
    };

export type QuickBooksInvoiceReconciliationClaim =
  | {
      duplicate: true;
      claimToken: null;
      operation: QuickBooksInvoiceOperationPublic;
    }
  | {
      duplicate: false;
      claimToken: string;
      operation: QuickBooksInvoiceOperationPublic;
      connection: NonNullable<SyncContext["connection"]>;
      providerRealmId: string;
      providerInvoiceId: string | null;
      providerDocNumber: string;
      payloadHash: string;
    };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function reviewBindingForContext(
  reviewSecret: string,
  tenantId: string,
  context: SyncContext,
): string | null {
  if (!context.connection || !context.providerPayload || !context.payloadHash) return null;
  const exactPayloadHash = sha256(canonicalJson(context.providerPayload));
  return createHmac("sha256", reviewSecret)
    .update(canonicalJson({
      version: 1,
      tenantId,
      invoiceId: context.invoice.id,
      invoiceVersion: context.invoice.version,
      exactPayloadHash,
      reconciliationFingerprint: context.payloadHash,
      connectionId: context.connection.id,
      realmId: context.connection.realmId,
    }), "utf8")
    .digest("base64url");
}

function reviewBindingsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeItemKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function providerDocNumber(invoiceNumber: number): string {
  return `QF-${String(invoiceNumber).padStart(6, "0")}`;
}

function providerMarker(tenantId: string, invoiceId: string): string {
  return `QuoteFly:${sha256(`${tenantId}:${invoiceId}`).slice(0, 24)}`;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeBillingEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 320
    ? normalized
    : null;
}

function requireManager(access: AccessContext) {
  if (!hasCapability(access, "manageIntegrations")) {
    throw new QuickBooksInvoiceOperationError(
      403,
      "QUICKBOOKS_INVOICE_FORBIDDEN",
      "Only owners or admins can manage QuickBooks invoice publishing.",
    );
  }
}

async function lockInvoiceOperation(transaction: Transaction, access: AccessContext, invoiceId: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`quickbooks-invoice:${access.tenantId}:${invoiceId}`}, 0)
      )
    ) acquired
  `);
}

async function lockCommandKey(transaction: Transaction, access: AccessContext, commandKeyHash: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`quickbooks-command:${access.tenantId}:${commandKeyHash}`}, 0)
      )
    ) acquired
  `);
}

function toPublicOperation(
  operation: Prisma.QuickBooksInvoiceOperationGetPayload<{
    select: typeof QuickBooksInvoiceOperationPublicSelect;
  }>,
): QuickBooksInvoiceOperationPublic {
  return operation;
}

/**
 * Canonical reconciliation is the proof that the provider identity,
 * immutable invoice fingerprint, and provider generation were reviewed as
 * one snapshot. A publish completion alone must never satisfy this gate.
 */
export function quickBooksInvoiceHasCanonicalReconciliation(
  operation: QuickBooksInvoiceOperationPublic,
): boolean {
  const hasProviderGeneration = Boolean(
    operation.providerSyncToken
    && /^(0|[1-9][0-9]*)$/.test(operation.providerSyncToken)
    && operation.providerUpdatedAtUtc
    && Number.isFinite(operation.providerUpdatedAtUtc.getTime()),
  );
  return operation.status === "SUCCEEDED"
    && Boolean(operation.providerInvoiceId)
    && /^[0-9a-f]{64}$/.test(operation.payloadHash)
    && Boolean(operation.lastReconciledAtUtc)
    && hasProviderGeneration;
}

export function quickBooksInvoiceLinkAvailable(
  operation: QuickBooksInvoiceOperationPublic,
): boolean {
  if (
    !quickBooksInvoiceHasCanonicalReconciliation(operation)
    || !operation.providerInvoiceLink
    || !operation.invoiceLinkFetchedAtUtc
    || !operation.lastReconciledAtUtc
  ) return false;

  // Both timestamps are written from the same `now` value in the atomic
  // reconciliation projection. Inequality means the link belongs to a stale
  // or only partially persisted provider generation.
  return operation.invoiceLinkFetchedAtUtc.getTime()
    === operation.lastReconciledAtUtc.getTime();
}

export function quickBooksInvoiceReconciliationAvailable(
  operation: QuickBooksInvoiceOperationPublic,
  nowMs = Date.now(),
): boolean {
  if (operation.status === "RECONCILIATION_REQUIRED") return true;
  if (operation.status === "SUCCEEDED") {
    return !quickBooksInvoiceHasCanonicalReconciliation(operation);
  }
  return (operation.status === "PROCESSING" || operation.status === "RECONCILING")
    && Boolean(operation.claimExpiresAtUtc && operation.claimExpiresAtUtc.getTime() <= nowMs);
}

async function loadSyncContext(
  transaction: Transaction,
  access: AccessContext,
  invoiceId: string,
  paymentReview: QuickBooksHostedPaymentReview = {},
): Promise<SyncContext> {
  const invoice = await transaction.invoice.findFirst({
    where: {
      id: invoiceId,
      tenantId: access.tenantId,
      archivedAtUtc: null,
      deletedAtUtc: null,
      customer: { archivedAtUtc: null, deletedAtUtc: null },
      job: { archivedAtUtc: null, deletedAtUtc: null },
      sourceQuote: { archivedAtUtc: null, deletedAtUtc: null },
    },
    select: {
      id: true,
      invoiceNumber: true,
      version: true,
      status: true,
      titleSnapshot: true,
      scopeSnapshot: true,
      billingEmailSnapshot: true,
      currency: true,
      subtotalAmount: true,
      taxAmount: true,
      totalAmount: true,
      createdAt: true,
      dueAtUtc: true,
      customerId: true,
      sourceQuoteId: true,
      customer: { select: { fullName: true, email: true } },
      lineItems: {
        where: { sectionType: "INCLUDED" },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          description: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
        },
      },
      sourceQuote: {
        select: {
          status: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new QuickBooksInvoiceOperationError(404, "INVOICE_NOT_FOUND", "Invoice not found for tenant.");
  }

  const [connection, operation] = await Promise.all([
    transaction.quickBooksConnection.findFirst({
      where: {
        tenantId: access.tenantId,
        deletedAtUtc: null,
        status: "CONNECTED",
        setupConfirmedAtUtc: { not: null },
        setupConfirmedByTenantUserId: { not: null },
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
      select: {
        id: true,
        tenantId: true,
        realmId: true,
        companyName: true,
        status: true,
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        accessTokenExpiresAtUtc: true,
        allowOnlineAchPayment: true,
        allowOnlineCardPayment: true,
      },
    }),
    transaction.quickBooksInvoiceOperation.findFirst({
      where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
      select: QuickBooksInvoiceOperationPublicSelect,
    }),
  ]);

  const docNumber = providerDocNumber(invoice.invoiceNumber);
  const rawLines = invoice.lineItems.length
    ? invoice.lineItems.map((line) => ({
        description: line.description,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        amount: Number(line.lineTotal),
      }))
    : [{
        description: invoice.titleSnapshot,
        quantity: 1,
        unitPrice: Number(invoice.subtotalAmount),
        amount: Number(invoice.subtotalAmount),
      }];

  const itemKeys = rawLines.map((line) => normalizeItemKey(line.description));
  const [customerMap, itemMaps, legacySync] = connection
    ? await Promise.all([
        transaction.quickBooksCustomerMap.findFirst({
          where: {
            tenantId: access.tenantId,
            quickBooksConnectionId: connection.id,
            customerId: invoice.customerId,
            deletedAtUtc: null,
          },
          select: { quickBooksCustomerId: true, quickBooksDisplayName: true, reviewedAtUtc: true },
        }),
        transaction.quickBooksItemMap.findMany({
          where: {
            tenantId: access.tenantId,
            quickBooksConnectionId: connection.id,
            itemKey: { in: itemKeys },
            deletedAtUtc: null,
          },
          select: { itemKey: true, quickBooksItemId: true, quickBooksItemName: true, reviewedAtUtc: true },
        }),
        transaction.quickBooksInvoiceSync.findFirst({
          where: {
            tenantId: access.tenantId,
            quickBooksConnectionId: connection.id,
            quoteId: invoice.sourceQuoteId,
            deletedAtUtc: null,
            quickBooksInvoiceId: { not: null },
          },
          select: { quickBooksInvoiceId: true },
        }),
      ])
    : [null, [], null] as const;

  const itemMapByKey = new Map(itemMaps.map((item) => [item.itemKey, item]));
  const lineItems: ProviderLine[] = rawLines.map((line) => {
    const itemKey = normalizeItemKey(line.description);
    const mapped = itemMapByKey.get(itemKey);
    return {
      ...line,
      itemKey,
      quickBooksItemId: mapped?.quickBooksItemId ?? null,
      quickBooksItemName: mapped?.quickBooksItemName ?? null,
      reviewedAtUtc: mapped?.reviewedAtUtc ?? null,
    };
  });

  const blockers: string[] = [];
  if (!connection) blockers.push("QUICKBOOKS_NOT_CONNECTED");
  if (invoice.sourceQuote.status !== "ACCEPTED") blockers.push("INVOICE_SOURCE_NOT_ACCEPTED");
  if (invoice.status === "VOID" || invoice.status === "UNCOLLECTIBLE") blockers.push("INVOICE_STATUS_UNSUPPORTED");
  if (invoice.currency !== "USD") blockers.push("QUICKBOOKS_CURRENCY_UNSUPPORTED");
  if (Number(invoice.taxAmount) > 0) blockers.push("QUICKBOOKS_TAX_SYNC_UNSUPPORTED");
  if (!invoice.dueAtUtc) blockers.push("INVOICE_DUE_DATE_REQUIRED");
  if (connection && !customerMap) blockers.push("QUICKBOOKS_CUSTOMER_MAPPING_REQUIRED");
  if (connection && customerMap && !customerMap.reviewedAtUtc) blockers.push("QUICKBOOKS_CUSTOMER_MAPPING_REVIEW_REQUIRED");
  if (connection && lineItems.some((line) => !line.quickBooksItemId)) {
    blockers.push("QUICKBOOKS_ITEM_MAPPING_REQUIRED");
  }
  if (connection && lineItems.some((line) => line.quickBooksItemId && !line.reviewedAtUtc)) {
    blockers.push("QUICKBOOKS_ITEM_MAPPING_REVIEW_REQUIRED");
  }
  if (legacySync?.quickBooksInvoiceId) blockers.push("LEGACY_QUICKBOOKS_INVOICE_EXISTS");

  const lineSubtotal = Number(lineItems.reduce((sum, line) => sum + line.amount, 0).toFixed(2));
  if (lineSubtotal !== Number(invoice.subtotalAmount)) blockers.push("INVOICE_LINE_TOTAL_MISMATCH");

  const billingEmail = normalizeBillingEmail(
    paymentReview.billingEmail ?? invoice.billingEmailSnapshot ?? invoice.customer.email,
  );
  const allowOnlineAchPayment = paymentReview.allowOnlineAchPayment
    ?? connection?.allowOnlineAchPayment
    ?? false;
  const allowOnlineCardPayment = paymentReview.allowOnlineCardPayment
    ?? connection?.allowOnlineCardPayment
    ?? false;
  if ((allowOnlineAchPayment || allowOnlineCardPayment) && !billingEmail) {
    blockers.push("QUICKBOOKS_BILLING_EMAIL_REQUIRED");
  }

  const providerPayload = connection && customerMap && blockers.length === 0
    ? {
        DocNumber: docNumber,
        TxnDate: dateOnly(invoice.createdAt),
        DueDate: dateOnly(invoice.dueAtUtc as Date),
        PrivateNote: providerMarker(access.tenantId, invoice.id),
        CustomerRef: {
          value: customerMap.quickBooksCustomerId,
          name: customerMap.quickBooksDisplayName ?? invoice.customer.fullName,
        },
        ...(billingEmail ? { BillEmail: { Address: billingEmail } } : {}),
        AllowOnlinePayment: allowOnlineAchPayment || allowOnlineCardPayment,
        AllowOnlineACHPayment: allowOnlineAchPayment,
        AllowOnlineCreditCardPayment: allowOnlineCardPayment,
        Line: lineItems.map((line) => {
          const providerPricing = providerQuantityAndUnitPrice(line);
          return {
            Description: line.description,
            Amount: line.amount,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
              Qty: providerPricing.quantity,
              UnitPrice: providerPricing.unitPrice,
              ItemRef: {
                value: line.quickBooksItemId,
                name: line.quickBooksItemName,
              },
            },
          };
        }),
      }
    : null;

  return {
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      version: invoice.version,
      status: invoice.status,
      titleSnapshot: invoice.titleSnapshot,
      scopeSnapshot: invoice.scopeSnapshot,
      currency: invoice.currency,
      subtotalAmount: Number(invoice.subtotalAmount),
      taxAmount: Number(invoice.taxAmount),
      totalAmount: Number(invoice.totalAmount),
      createdAt: invoice.createdAt,
      dueAtUtc: invoice.dueAtUtc,
      customerId: invoice.customerId,
      sourceQuoteId: invoice.sourceQuoteId,
      customerName: invoice.customer.fullName,
      billingEmail,
    },
    connection,
    operation: operation ? toPublicOperation(operation) : null,
    lineItems,
    providerDocNumber: docNumber,
    providerPayload,
    payloadHash: providerPayload ? quickBooksInvoiceFingerprint(providerPayload) : null,
    blockers,
    paymentReview: { billingEmail, allowOnlineAchPayment, allowOnlineCardPayment },
    customerMapping: customerMap?.reviewedAtUtc
      ? {
          quickBooksCustomerId: customerMap.quickBooksCustomerId,
          quickBooksDisplayName: customerMap.quickBooksDisplayName,
          reviewedAtUtc: customerMap.reviewedAtUtc,
        }
      : null,
  };
}

function previewFromContext(
  context: SyncContext,
  tenantId: string,
  reviewSecret: string,
): QuickBooksInvoiceSyncPreview {
  return {
    invoice: {
      id: context.invoice.id,
      invoiceNumber: context.invoice.invoiceNumber,
      version: context.invoice.version,
      status: context.invoice.status,
      customerName: context.invoice.customerName,
      currency: context.invoice.currency,
      subtotalAmount: context.invoice.subtotalAmount,
      taxAmount: context.invoice.taxAmount,
      totalAmount: context.invoice.totalAmount,
      dueAtUtc: context.invoice.dueAtUtc,
    },
    connection: context.connection
      ? { companyName: context.connection.companyName, status: context.connection.status }
      : null,
    quickBooksCustomerName: context.providerPayload
      ? ((context.providerPayload.CustomerRef as { name?: string | null }).name ?? null)
      : null,
    customerMapping: context.customerMapping,
    billingEmail: context.paymentReview.billingEmail,
    paymentMethods: {
      ach: context.paymentReview.allowOnlineAchPayment,
      card: context.paymentReview.allowOnlineCardPayment,
    },
    providerDocNumber: context.providerDocNumber,
    lineItems: context.lineItems.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      mapped: Boolean(line.quickBooksItemId),
      quickBooksItemName: line.quickBooksItemName,
      itemKey: line.itemKey,
      quickBooksItemId: line.quickBooksItemId,
      reviewedAtUtc: line.reviewedAtUtc,
    })),
    blockers: context.blockers,
    ready: context.blockers.length === 0 && Boolean(context.providerPayload),
    reviewBinding: reviewBindingForContext(reviewSecret, tenantId, context),
    operation: context.operation,
  };
}

export async function getQuickBooksInvoiceSyncPreview(
  transaction: Transaction,
  access: AccessContext,
  invoiceId: string,
  reviewSecret: string,
  paymentReview: QuickBooksHostedPaymentReview = {},
): Promise<QuickBooksInvoiceSyncPreview> {
  requireManager(access);
  await setTenantRlsContext(transaction, access.tenantId);
  return previewFromContext(
    await loadSyncContext(transaction, access, invoiceId, paymentReview),
    access.tenantId,
    reviewSecret,
  );
}

export async function claimQuickBooksInvoicePublish(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    invoiceVersion: number;
    idempotencyKey: string;
    reviewBinding: string;
    reviewSecret: string;
    paymentReview?: QuickBooksHostedPaymentReview;
  },
): Promise<QuickBooksInvoicePublishClaim> {
  requireManager(access);
  await setTenantRlsContext(transaction, access.tenantId);
  const commandKeyHash = sha256(`quickbooks-invoice:${access.tenantId}:${params.idempotencyKey}`);
  await lockCommandKey(transaction, access, commandKeyHash);
  await lockInvoiceOperation(transaction, access, params.invoiceId);
  const context = await loadSyncContext(transaction, access, params.invoiceId, params.paymentReview);

  const reusedCommand = await transaction.invoiceEvent.findFirst({
    where: { tenantId: access.tenantId, commandKeyHash },
    select: { invoiceId: true },
  });
  if (reusedCommand && reusedCommand.invoiceId !== params.invoiceId) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for another invoice.",
    );
  }

  if (context.operation) {
    if (context.operation.status === "SUCCEEDED") {
      return {
        duplicate: true,
        requiresReconciliation: !quickBooksInvoiceHasCanonicalReconciliation(context.operation),
        claimToken: null,
        operation: context.operation,
      };
    }

    if (context.operation.status === "PROCESSING") {
      const expired = Boolean(
        context.operation.claimExpiresAtUtc
        && context.operation.claimExpiresAtUtc.getTime() <= Date.now(),
      );
      if (expired) {
        const now = new Date();
        const operation = await transaction.quickBooksInvoiceOperation.update({
          where: { tenantId_invoiceId: { tenantId: access.tenantId, invoiceId: params.invoiceId } },
          data: {
            status: "RECONCILIATION_REQUIRED",
            claimTokenHash: null,
            claimExpiresAtUtc: null,
            failedAtUtc: now,
            lastFailureCode: "PUBLISH_CLAIM_EXPIRED",
          },
          select: QuickBooksInvoiceOperationPublicSelect,
        });
        await transaction.invoiceEvent.create({
          data: {
            tenantId: access.tenantId,
            invoiceId: params.invoiceId,
            actorTenantUserId: access.tenantUserId,
            type: "PROVIDER_RECONCILIATION_REQUIRED",
            requestId: access.requestId.slice(0, 191),
          },
        });
        return {
          duplicate: false,
          requiresReconciliation: true,
          claimToken: null,
          operation,
        };
      }
      throw new QuickBooksInvoiceOperationError(
        409,
        "QUICKBOOKS_SYNC_IN_PROGRESS",
        "QuickBooks invoice publishing is already in progress.",
      );
    }

    const code = context.operation.status === "FAILED"
      ? "QUICKBOOKS_SYNC_FAILED_TERMINAL"
      : "QUICKBOOKS_RECONCILIATION_REQUIRED";
    throw new QuickBooksInvoiceOperationError(
      409,
      code,
      context.operation.status === "FAILED"
        ? "The QuickBooks publish failed safely. Review the failure before starting a replacement operation."
        : "Reconcile the uncertain QuickBooks result before attempting another publish.",
    );
  }

  if (context.invoice.version !== params.invoiceVersion) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "INVOICE_VERSION_CONFLICT",
      "The invoice changed. Review the current invoice before publishing.",
      { currentVersion: context.invoice.version },
    );
  }

  const expectedReviewBinding = reviewBindingForContext(params.reviewSecret, access.tenantId, context);
  if (!expectedReviewBinding || !reviewBindingsEqual(expectedReviewBinding, params.reviewBinding)) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_REVIEW_STALE",
      "The QuickBooks destination or mappings changed. Review the current draft before publishing.",
    );
  }

  if (context.blockers.length || !context.connection || !context.providerPayload || !context.payloadHash) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_SYNC_NOT_READY",
      "The invoice is not ready for QuickBooks publishing.",
      { blockers: context.blockers },
    );
  }

  const now = new Date();
  const claimToken = randomBytes(32).toString("hex");
  const providerRequestId = randomUUID();
  const claimExpiresAtUtc = new Date(now.getTime() + CLAIM_TTL_MS);
  const operation = await transaction.quickBooksInvoiceOperation.create({
    data: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      quickBooksConnectionId: context.connection.id,
      requestedByTenantUserId: access.tenantUserId,
      status: "PROCESSING",
      commandKeyHash,
      payloadHash: context.payloadHash,
      providerRealmId: context.connection.realmId,
      claimTokenHash: sha256(claimToken),
      providerRequestId,
      providerDocNumber: context.providerDocNumber,
      allowOnlineAchPayment: context.paymentReview.allowOnlineAchPayment,
      allowOnlineCardPayment: context.paymentReview.allowOnlineCardPayment,
      attemptCount: 1,
      reconciliationCount: 0,
      processingStartedAtUtc: now,
      claimExpiresAtUtc,
      lastAttemptAtUtc: now,
    },
    select: QuickBooksInvoiceOperationPublicSelect,
  });

  await transaction.invoiceEvent.create({
    data: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      actorTenantUserId: access.tenantUserId,
      type: "PROVIDER_SYNC_STARTED",
      requestId: access.requestId.slice(0, 191),
      commandKeyHash,
      commandPayloadHash: context.payloadHash,
    },
  });
  await transaction.invoice.update({
    where: { id: context.invoice.id },
    data: { billingEmailSnapshot: context.paymentReview.billingEmail },
  });

  return {
    duplicate: false,
    requiresReconciliation: false,
    claimToken,
    operation,
    connection: context.connection,
    providerPayload: context.providerPayload,
    providerRequestId,
  };
}

async function finishOperation(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    claimToken: string;
    expectedStatus: "PROCESSING" | "RECONCILING";
    nextStatus: "SUCCEEDED" | "FAILED" | "RECONCILIATION_REQUIRED";
    providerInvoiceId?: string;
    providerInvoiceLink?: string | null;
    providerSyncToken?: string | null;
    providerInvoiceStatus?: string | null;
    providerBalance?: number | null;
    providerUpdatedAtUtc?: Date | null;
    failureCode?: string;
    eventType:
      | "PROVIDER_SYNC_SUCCEEDED"
      | "PROVIDER_SYNC_FAILED"
      | "PROVIDER_RECONCILIATION_REQUIRED"
      | "PROVIDER_RECONCILED";
  },
): Promise<QuickBooksInvoiceOperationPublic> {
  await setTenantRlsContext(transaction, access.tenantId);
  await lockInvoiceOperation(transaction, access, params.invoiceId);
  const current = await transaction.quickBooksInvoiceOperation.findFirst({
    where: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      status: params.expectedStatus,
      claimTokenHash: sha256(params.claimToken),
      archivedAtUtc: null,
    },
    select: { id: true, providerRequestId: true },
  });
  if (!current) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_OPERATION_STALE",
      "The QuickBooks operation claim is no longer current.",
    );
  }

  const now = new Date();
  const succeeded = params.nextStatus === "SUCCEEDED";
  const failed = params.nextStatus === "FAILED" || params.nextStatus === "RECONCILIATION_REQUIRED";
  const operation = await transaction.quickBooksInvoiceOperation.update({
    where: { id: current.id },
    data: {
      status: params.nextStatus,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      ...(params.providerInvoiceId ? { providerInvoiceId: params.providerInvoiceId } : {}),
      ...(params.providerInvoiceLink !== undefined ? {
        providerInvoiceLink: params.providerInvoiceLink,
        invoiceLinkFetchedAtUtc: params.providerInvoiceLink ? now : null,
      } : {}),
      ...(params.providerSyncToken !== undefined ? { providerSyncToken: params.providerSyncToken } : {}),
      ...(params.providerInvoiceStatus !== undefined ? { providerInvoiceStatus: params.providerInvoiceStatus } : {}),
      ...(params.providerBalance !== undefined ? { providerBalance: params.providerBalance } : {}),
      ...(params.providerUpdatedAtUtc !== undefined ? { providerUpdatedAtUtc: params.providerUpdatedAtUtc } : {}),
      succeededAtUtc: succeeded ? now : null,
      failedAtUtc: failed ? now : null,
      lastFailureCode: failed ? (params.failureCode ?? "QUICKBOOKS_PROVIDER_ERROR").slice(0, 191) : null,
    },
    select: QuickBooksInvoiceOperationPublicSelect,
  });

  await transaction.invoiceEvent.create({
    data: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      actorTenantUserId: access.tenantUserId,
      type: params.eventType,
      requestId: current.providerRequestId.slice(0, 191),
    },
  });
  if (succeeded && params.eventType === "PROVIDER_SYNC_SUCCEEDED") {
    await transaction.invoice.update({
      where: { id: params.invoiceId },
      data: {
        status: "OPEN",
        issuedAtUtc: now,
        version: { increment: 1 },
      },
    });
  }
  return operation;
}

export function completeQuickBooksInvoicePublish(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    claimToken: string;
    providerInvoiceId: string;
    providerSyncToken: string | null;
    providerInvoiceStatus: string | null;
    providerBalance: number;
    providerUpdatedAtUtc: Date | null;
  },
) {
  return finishOperation(transaction, access, {
    ...params,
    // A capability URL becomes durable only inside the canonical
    // reconciliation projection, alongside its verified fingerprint and
    // provider generation.
    providerInvoiceLink: null,
    expectedStatus: "PROCESSING",
    nextStatus: "SUCCEEDED",
    eventType: "PROVIDER_SYNC_SUCCEEDED",
  });
}

export function retainCreatedQuickBooksInvoiceForReconciliation(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    claimToken: string;
    providerInvoiceId: string;
    failureCode: string;
  },
) {
  return finishOperation(transaction, access, {
    ...params,
    providerInvoiceLink: null,
    expectedStatus: "PROCESSING",
    nextStatus: "RECONCILIATION_REQUIRED",
    eventType: "PROVIDER_RECONCILIATION_REQUIRED",
  });
}

export async function markQuickBooksInitialReconciliationRequired(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    providerInvoiceId: string;
    payloadHash: string;
    failureCode: string;
  },
): Promise<QuickBooksInvoiceOperationPublic> {
  await setTenantRlsContext(transaction, access.tenantId);
  await lockInvoiceOperation(transaction, access, params.invoiceId);
  const current = await transaction.quickBooksInvoiceOperation.findFirst({
    where: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      archivedAtUtc: null,
    },
    select: QuickBooksInvoiceOperationPublicSelect,
  });
  if (!current) {
    throw new QuickBooksInvoiceOperationError(
      404,
      "QUICKBOOKS_OPERATION_NOT_FOUND",
      "No QuickBooks invoice operation exists for this invoice.",
    );
  }
  if (
    current.providerInvoiceId !== params.providerInvoiceId
    || current.payloadHash !== params.payloadHash
  ) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_OPERATION_STALE",
      "A newer QuickBooks invoice operation replaced this reconciliation result.",
    );
  }
  if (current.status === "RECONCILIATION_REQUIRED") return current;
  if (quickBooksInvoiceHasCanonicalReconciliation(current)) return current;
  if (current.status !== "SUCCEEDED") {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_OPERATION_STALE",
      "The QuickBooks publish operation is no longer awaiting initial reconciliation.",
    );
  }

  const now = new Date();
  const operation = await transaction.quickBooksInvoiceOperation.update({
    where: { id: current.id },
    data: {
      status: "RECONCILIATION_REQUIRED",
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      succeededAtUtc: null,
      failedAtUtc: now,
      lastFailureCode: params.failureCode.slice(0, 191),
    },
    select: QuickBooksInvoiceOperationPublicSelect,
  });
  await transaction.invoiceEvent.create({
    data: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      actorTenantUserId: access.tenantUserId,
      type: "PROVIDER_RECONCILIATION_REQUIRED",
      requestId: current.id.slice(0, 191),
    },
  });
  return operation;
}

export function failQuickBooksInvoicePublish(
  transaction: Transaction,
  access: AccessContext,
  params: { invoiceId: string; claimToken: string; failureCode: string; ambiguous: boolean },
) {
  return finishOperation(transaction, access, {
    ...params,
    expectedStatus: "PROCESSING",
    nextStatus: params.ambiguous ? "RECONCILIATION_REQUIRED" : "FAILED",
    eventType: params.ambiguous ? "PROVIDER_RECONCILIATION_REQUIRED" : "PROVIDER_SYNC_FAILED",
  });
}

export async function claimQuickBooksInvoiceReconciliation(
  transaction: Transaction,
  access: AccessContext,
  invoiceId: string,
): Promise<QuickBooksInvoiceReconciliationClaim> {
  requireManager(access);
  await setTenantRlsContext(transaction, access.tenantId);
  await lockInvoiceOperation(transaction, access, invoiceId);
  const context = await loadSyncContext(transaction, access, invoiceId);
  if (!context.operation) {
    throw new QuickBooksInvoiceOperationError(404, "QUICKBOOKS_OPERATION_NOT_FOUND", "No QuickBooks invoice operation exists for this invoice.");
  }
  if (
    context.operation.status === "SUCCEEDED"
    && quickBooksInvoiceHasCanonicalReconciliation(context.operation)
  ) {
    return {
      duplicate: true,
      claimToken: null,
      operation: context.operation,
    };
  }
  if (!context.connection) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_NOT_CONNECTED",
      "Reconnect QuickBooks before reconciling this invoice.",
    );
  }
  if (
    context.operation.quickBooksConnectionId !== context.connection.id
    || context.operation.providerRealmId !== context.connection.realmId
  ) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_CONNECTION_CHANGED",
      "Reconnect the original QuickBooks company before reconciling this invoice.",
    );
  }
  const activeClaimExpired = Boolean(
    context.operation.claimExpiresAtUtc
    && context.operation.claimExpiresAtUtc.getTime() <= Date.now(),
  );
  const reconcilable = context.operation.status === "RECONCILIATION_REQUIRED"
    || (
      context.operation.status === "SUCCEEDED"
      && !quickBooksInvoiceHasCanonicalReconciliation(context.operation)
    )
    || (
      (context.operation.status === "PROCESSING" || context.operation.status === "RECONCILING")
      && activeClaimExpired
    );
  if (!reconcilable) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_RECONCILIATION_NOT_READY",
      "This QuickBooks operation is not ready for reconciliation.",
    );
  }

  const internal = await transaction.quickBooksInvoiceOperation.findUniqueOrThrow({
    where: { tenantId_invoiceId: { tenantId: access.tenantId, invoiceId } },
    select: { id: true, providerInvoiceId: true, payloadHash: true, providerRealmId: true },
  });
  const now = new Date();
  const claimToken = randomBytes(32).toString("hex");
  if (
    context.operation.status === "PROCESSING"
    || context.operation.status === "SUCCEEDED"
  ) {
    await transaction.invoiceEvent.create({
      data: {
        tenantId: access.tenantId,
        invoiceId,
        actorTenantUserId: access.tenantUserId,
        type: "PROVIDER_RECONCILIATION_REQUIRED",
        requestId: context.operation.id.slice(0, 191),
      },
    });
  }
  const operation = await transaction.quickBooksInvoiceOperation.update({
    where: { id: internal.id },
    data: {
      status: "RECONCILING",
      claimTokenHash: sha256(claimToken),
      processingStartedAtUtc: now,
      claimExpiresAtUtc: new Date(now.getTime() + CLAIM_TTL_MS),
      reconciliationCount: { increment: 1 },
      failedAtUtc: null,
      lastFailureCode: null,
    },
    select: QuickBooksInvoiceOperationPublicSelect,
  });
  return {
    duplicate: false,
    claimToken,
    operation,
    connection: context.connection,
    providerRealmId: internal.providerRealmId,
    providerInvoiceId: internal.providerInvoiceId,
    providerDocNumber: context.operation.providerDocNumber,
    payloadHash: internal.payloadHash,
  };
}

export async function bindQuickBooksInvoiceReconciliationIdentity(
  transaction: Transaction,
  access: AccessContext,
  params: {
    invoiceId: string;
    claimToken: string;
    providerInvoiceId: string;
  },
) {
  await setTenantRlsContext(transaction, access.tenantId);
  await lockInvoiceOperation(transaction, access, params.invoiceId);
  const current = await transaction.quickBooksInvoiceOperation.findFirst({
    where: {
      tenantId: access.tenantId,
      invoiceId: params.invoiceId,
      status: "RECONCILING",
      claimTokenHash: sha256(params.claimToken),
      archivedAtUtc: null,
    },
    select: { id: true, providerInvoiceId: true },
  });
  if (!current) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_OPERATION_STALE",
      "The QuickBooks reconciliation claim is no longer current.",
    );
  }
  if (current.providerInvoiceId && current.providerInvoiceId !== params.providerInvoiceId) {
    throw new QuickBooksInvoiceOperationError(
      409,
      "QUICKBOOKS_INVOICE_ID_MISMATCH",
      "The QuickBooks invoice identity no longer matches this reconciliation.",
    );
  }
  return transaction.quickBooksInvoiceOperation.update({
    where: { id: current.id },
    data: { providerInvoiceId: params.providerInvoiceId },
    select: QuickBooksInvoiceOperationPublicSelect,
  });
}

export function retainQuickBooksInvoiceReconciliation(
  transaction: Transaction,
  access: AccessContext,
  params: { invoiceId: string; claimToken: string; failureCode: string },
) {
  return finishOperation(transaction, access, {
    ...params,
    expectedStatus: "RECONCILING",
    nextStatus: "RECONCILIATION_REQUIRED",
    eventType: "PROVIDER_RECONCILIATION_REQUIRED",
  });
}
