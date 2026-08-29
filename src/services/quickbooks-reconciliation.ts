import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  fetchQuickBooksInvoice,
  fetchQuickBooksPayment,
  fetchQuickBooksRefundReceipt,
  quickBooksInvoiceFingerprint,
  QuickBooksProviderError,
  validateQuickBooksReconciliationInvoice,
  validateQuickBooksInvoiceLink,
  type QuickBooksPaymentEntity,
  type QuickBooksRefundReceiptEvidenceEntity,
  type QuickBooksReconciliationInvoiceEntity,
} from "./quickbooks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";

type RuntimeEnv = typeof env;

type ReconciliationContext = {
  invoiceId: string;
  invoiceTotal: number;
  invoiceCurrency: string;
  connection: {
    id: string;
    tenantId: string;
    realmId: string;
  };
  operation: {
    id: string;
    providerInvoiceId: string;
    payloadHash: string;
    allowOnlineAchPayment: boolean;
    allowOnlineCardPayment: boolean;
    providerSyncToken: string | null;
    providerUpdatedAtUtc: Date | null;
    lastReconciledAtUtc: Date | null;
  };
};

export type QuickBooksReconciliationTrigger = "WEBHOOK" | "MANUAL" | "CDC" | "PUBLISH";

export type QuickBooksReconciliationResult = Readonly<{
  invoiceId: string;
  providerInvoiceId: string;
  invoiceStatus: "OPEN" | "PAID" | "VOID";
  paymentStatus: "PENDING" | "PARTIALLY_PAID" | "SUCCEEDED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "CANCELED";
  amountPaid: number;
  balanceDue: number;
  hostedPaymentUrlAvailable: boolean;
}>;

export class QuickBooksReconciliationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

type SupportedPaymentApplication = {
  providerPaymentId: string;
  grossAmount: number;
  amount: number;
  explicitRefundAmount: number;
  paidAtUtc: Date | null;
  refundedAtUtc: Date | null;
  providerSyncToken: string | null;
  providerUpdatedAtUtc: Date | null;
};

const QUICKBOOKS_PAYMENT_EVIDENCE_MAX_LINKS = 100;
const QUICKBOOKS_PAYMENT_EVIDENCE_CONCURRENCY = 5;

class QuickBooksEvidenceError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
  }
}

function cents(value: number): number {
  return Math.round(value * 100);
}

type QuickBooksEvidenceReferences = {
  paymentIds: string[];
  refundReceiptIds: string[];
};

function evidenceReferencesFromInvoice(invoice: QuickBooksReconciliationInvoiceEntity): QuickBooksEvidenceReferences {
  const paymentIds = new Set<string>();
  const refundReceiptIds = new Set<string>();
  for (const linked of invoice.LinkedTxn ?? []) {
    const transactionType = linked.TxnType?.trim().toLowerCase();
    const transactionId = linked.TxnId?.trim();
    if (transactionType !== "payment" && transactionType !== "refundreceipt") {
      throw new QuickBooksEvidenceError("QUICKBOOKS_UNSUPPORTED_BALANCE_ADJUSTMENT", false);
    }
    if (!transactionId) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
    }
    if (transactionType === "payment") paymentIds.add(transactionId);
    else refundReceiptIds.add(transactionId);
  }
  return { paymentIds: [...paymentIds], refundReceiptIds: [...refundReceiptIds] };
}

function supportedPaymentApplications(params: {
  invoice: QuickBooksReconciliationInvoiceEntity;
  payments: readonly QuickBooksPaymentEntity[];
  refundReceipts: readonly QuickBooksRefundReceiptEvidenceEntity[];
  missingPaymentIds: readonly string[];
  missingRefundReceiptIds: readonly string[];
  invoiceCurrency: string;
  requiredReduction: number;
}): SupportedPaymentApplication[] {
  if (params.missingPaymentIds.length > 0 || params.missingRefundReceiptIds.length > 0) {
    throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
  }
  const references = evidenceReferencesFromInvoice(params.invoice);
  const refundReceiptsById = new Map(params.refundReceipts.map((refundReceipt) => [refundReceipt.Id, refundReceipt]));
  const refundsByPaymentId = new Map<string, {
    amountCents: number;
    refundedAtUtc: Date | null;
    providerUpdatedAtUtc: Date | null;
  }>();
  for (const refundReceiptId of references.refundReceiptIds) {
    const refundReceipt = refundReceiptsById.get(refundReceiptId);
    if (!refundReceipt) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
    }
    const invoiceCustomerId = params.invoice.CustomerRef?.value?.trim();
    if (!invoiceCustomerId || refundReceipt.CustomerRef.value.trim() !== invoiceCustomerId) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_CUSTOMER_MISMATCH", false);
    }
    const refundCurrency = refundReceipt.CurrencyRef?.value
      ?? refundReceipt.CurrencyRef?.name
      ?? params.invoiceCurrency;
    if (refundCurrency !== params.invoiceCurrency) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_CURRENCY_MISMATCH", false);
    }
    const linkedPayments = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "payment" && linked.TxnId?.trim()
    );
    const linkedInvoices = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "invoice" && linked.TxnId?.trim()
    );
    const unsupportedLinks = refundReceipt.LinkedTxn.filter((linked) => {
      const type = linked.TxnType?.trim().toLowerCase();
      return type !== "payment" && type !== "invoice";
    });
    if (
      unsupportedLinks.length > 0
      || linkedPayments.length !== 1
      || linkedInvoices.length !== 1
      || linkedInvoices[0]?.TxnId?.trim() !== params.invoice.Id
    ) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_APPLICATION_UNSUPPORTED", false);
    }
    const providerPaymentId = linkedPayments[0]!.TxnId!.trim();
    if (!references.paymentIds.includes(providerPaymentId)) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_PAYMENT_NOT_LINKED_TO_INVOICE", false);
    }
    const refundAmountCents = cents(refundReceipt.TotalAmt);
    if (refundAmountCents <= 0) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_AMOUNT_INVALID", false);
    }
    const prior = refundsByPaymentId.get(providerPaymentId);
    const providerUpdatedAtUtc = providerTimestamp(refundReceipt.MetaData?.LastUpdatedTime);
    refundsByPaymentId.set(providerPaymentId, {
      amountCents: (prior?.amountCents ?? 0) + refundAmountCents,
      refundedAtUtc: latestDate(prior?.refundedAtUtc ?? null, refundReceiptDate(refundReceipt)),
      providerUpdatedAtUtc: latestDate(prior?.providerUpdatedAtUtc ?? null, providerUpdatedAtUtc),
    });
  }
  const paymentIds = references.paymentIds;
  const paymentsById = new Map(params.payments.map((payment) => [payment.Id, payment]));
  const applications: SupportedPaymentApplication[] = [];
  for (const paymentId of paymentIds) {
    const payment = paymentsById.get(paymentId);
    if (
      !payment
      || typeof payment.TotalAmt !== "number"
      || !Number.isFinite(payment.TotalAmt)
      || payment.TotalAmt < 0
    ) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
    }
    const paymentCurrency = payment.CurrencyRef?.value ?? payment.CurrencyRef?.name ?? params.invoiceCurrency;
    if (paymentCurrency !== params.invoiceCurrency) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_CURRENCY_MISMATCH", false);
    }

    let targetApplicationCents = 0;
    let allApplicationsCents = 0;
    for (const line of payment.Line ?? []) {
      const linkedTransactions = line.LinkedTxn ?? [];
      if (linkedTransactions.length === 0) continue;
      if (
        linkedTransactions.length !== 1
        || linkedTransactions[0]?.TxnType?.trim().toLowerCase() !== "invoice"
        || !linkedTransactions[0]?.TxnId?.trim()
      ) {
        throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_APPLICATION_UNSUPPORTED", false);
      }
      if (typeof line.Amount !== "number" || !Number.isFinite(line.Amount) || line.Amount <= 0) {
        throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
      }
      const lineCents = cents(line.Amount);
      allApplicationsCents += lineCents;
      if (linkedTransactions[0].TxnId === params.invoice.Id) {
        targetApplicationCents += lineCents;
      }
    }
    if (targetApplicationCents <= 0 || allApplicationsCents > cents(payment.TotalAmt)) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INCOMPLETE", true);
    }
    const refund = refundsByPaymentId.get(payment.Id);
    const refundCents = refund?.amountCents ?? 0;
    if (refundCents > targetApplicationCents) {
      throw new QuickBooksEvidenceError("QUICKBOOKS_REFUND_EXCEEDS_PAYMENT_APPLICATION", false);
    }
    applications.push({
      providerPaymentId: payment.Id,
      grossAmount: targetApplicationCents / 100,
      amount: (targetApplicationCents - refundCents) / 100,
      explicitRefundAmount: refundCents / 100,
      paidAtUtc: paymentDate(payment),
      refundedAtUtc: refund?.refundedAtUtc ?? null,
      providerSyncToken: payment.SyncToken ?? null,
      providerUpdatedAtUtc: latestDate(
        providerTimestamp(payment.MetaData?.LastUpdatedTime),
        refund?.providerUpdatedAtUtc ?? null,
      ),
    });
  }
  const provenReductionCents = applications.reduce(
    (sum, application) => sum + cents(application.amount),
    0,
  );
  if (provenReductionCents !== cents(params.requiredReduction)) {
    throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_INSUFFICIENT", true);
  }
  return applications;
}

function providerTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function paymentDate(payment: QuickBooksPaymentEntity): Date | null {
  const value = payment.TxnDate ?? payment.MetaData?.CreateTime;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function refundReceiptDate(refundReceipt: QuickBooksRefundReceiptEvidenceEntity): Date | null {
  const value = refundReceipt.TxnDate ?? refundReceipt.MetaData?.CreateTime;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isVoidedInvoice(invoice: QuickBooksReconciliationInvoiceEntity): boolean {
  const status = invoice.TxnStatus?.trim().toLowerCase();
  return status === "void" || status === "voided";
}

function providerPaymentReviewFailure(
  invoice: QuickBooksReconciliationInvoiceEntity,
  reviewed: { allowOnlineAchPayment: boolean; allowOnlineCardPayment: boolean },
): string | null {
  const record = invoice as Record<string, unknown>;
  const reviewedOnlinePayment = reviewed.allowOnlineAchPayment || reviewed.allowOnlineCardPayment;
  const methods = [
    ["AllowOnlineACHPayment", reviewed.allowOnlineAchPayment],
    ["AllowOnlineCreditCardPayment", reviewed.allowOnlineCardPayment],
  ] as const;
  for (const [field, expected] of methods) {
    const present = Object.prototype.hasOwnProperty.call(record, field);
    if (!present) {
      if (expected) return "QUICKBOOKS_PAYMENT_METHOD_CONFIRMATION_MISSING";
      continue;
    }
    const actual = record[field];
    if (actual === expected) continue;
    return expected && actual === false
      ? "QUICKBOOKS_PAYMENT_METHOD_INELIGIBLE"
      : "QUICKBOOKS_PAYMENT_METHOD_REVIEW_MISMATCH";
  }
  if (
    Object.prototype.hasOwnProperty.call(record, "AllowOnlinePayment")
    && record.AllowOnlinePayment !== reviewedOnlinePayment
  ) {
    return reviewedOnlinePayment && record.AllowOnlinePayment === false
      ? "QUICKBOOKS_PAYMENT_METHOD_INELIGIBLE"
      : "QUICKBOOKS_PAYMENT_METHOD_REVIEW_MISMATCH";
  }
  return null;
}

async function loadContext(prisma: PrismaClient, tenantId: string, invoiceId: string): Promise<ReconciliationContext> {
  return withTenantRlsContext(prisma, tenantId, async (transaction) => {
    const operation = await transaction.quickBooksInvoiceOperation.findFirst({
      where: { tenantId, invoiceId, archivedAtUtc: null, providerInvoiceId: { not: null } },
      select: {
        id: true,
        providerInvoiceId: true,
        payloadHash: true,
        allowOnlineAchPayment: true,
        allowOnlineCardPayment: true,
        providerSyncToken: true,
        providerUpdatedAtUtc: true,
        lastReconciledAtUtc: true,
        connection: {
          select: {
            id: true,
            tenantId: true,
            realmId: true,
            status: true,
            deletedAtUtc: true,
            setupConfirmedAtUtc: true,
            setupConfirmedByTenantUserId: true,
            setupChecklistVersion: true,
          },
        },
        invoice: { select: { totalAmount: true, currency: true } },
      },
    });
    if (!operation?.providerInvoiceId) {
      throw new QuickBooksReconciliationError("QUICKBOOKS_OPERATION_NOT_READY", "The invoice has no provider identity to reconcile.", false);
    }
    if (operation.connection.status !== "CONNECTED" || operation.connection.deletedAtUtc) {
      throw new QuickBooksReconciliationError("QUICKBOOKS_NOT_CONNECTED", "Reconnect QuickBooks before reconciliation.", true);
    }
    if (
      !operation.connection.setupConfirmedAtUtc
      || !operation.connection.setupConfirmedByTenantUserId
      || operation.connection.setupChecklistVersion !== QUICKBOOKS_SETUP_CHECKLIST_VERSION
    ) {
      throw new QuickBooksReconciliationError(
        "QUICKBOOKS_SETUP_NOT_CONFIRMED",
        "Confirm QuickBooks setup before reconciliation.",
        false,
      );
    }
    return {
      invoiceId,
      invoiceTotal: money(operation.invoice.totalAmount),
      invoiceCurrency: operation.invoice.currency,
      connection: operation.connection,
      operation: {
        id: operation.id,
        providerInvoiceId: operation.providerInvoiceId,
        payloadHash: operation.payloadHash,
        allowOnlineAchPayment: operation.allowOnlineAchPayment,
        allowOnlineCardPayment: operation.allowOnlineCardPayment,
        providerSyncToken: operation.providerSyncToken,
        providerUpdatedAtUtc: operation.providerUpdatedAtUtc,
        lastReconciledAtUtc: operation.lastReconciledAtUtc,
      },
    };
  }, { maxWait: 5_000, timeout: 15_000 });
}

async function quarantineQuickBooksReconciliation(params: {
  prisma: PrismaClient;
  tenantId: string;
  invoiceId: string;
  operationId: string;
  code: string;
  expectedGeneration: {
    providerSyncToken: string | null;
    providerUpdatedAtUtc: Date | null;
    lastReconciledAtUtc: Date | null;
  };
}) {
  return withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    return quarantineQuickBooksReconciliationTransaction(transaction, params);
  });
}

async function quarantineQuickBooksReconciliationTransaction(
  transaction: Prisma.TransactionClient,
  params: {
    tenantId: string;
    invoiceId: string;
    operationId: string;
    code: string;
    expectedGeneration?: {
      providerSyncToken: string | null;
      providerUpdatedAtUtc: Date | null;
      lastReconciledAtUtc: Date | null;
    };
  },
) {
  const providerEventId = `qbo-drift:${params.operationId}:${params.code}`.slice(0, 191);
  const quarantined = await transaction.quickBooksInvoiceOperation.updateMany({
    where: {
      id: params.operationId,
      tenantId: params.tenantId,
      ...(params.expectedGeneration ?? {}),
    },
    data: {
      status: "RECONCILIATION_REQUIRED",
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      failedAtUtc: new Date(),
      succeededAtUtc: null,
      lastFailureCode: params.code.slice(0, 191),
    },
  });
  if (quarantined.count !== 1) return false;
  const existing = await transaction.invoiceEvent.findFirst({
    where: { tenantId: params.tenantId, providerEventId },
    select: { id: true },
  });
  if (!existing) {
    await transaction.invoiceEvent.create({
      data: {
        tenantId: params.tenantId,
        invoiceId: params.invoiceId,
        type: "PROVIDER_RECONCILIATION_REQUIRED",
        requestId: params.operationId.slice(0, 191),
        providerEventId,
      },
    });
  }
  return true;
}

async function fetchPaymentEvidence(
  runtimeEnv: RuntimeEnv,
  realmId: string,
  accessToken: string,
  invoice: QuickBooksReconciliationInvoiceEntity,
): Promise<{
  payments: QuickBooksPaymentEntity[];
  refundReceipts: QuickBooksRefundReceiptEvidenceEntity[];
  missingPaymentIds: string[];
  missingRefundReceiptIds: string[];
}> {
  const references = evidenceReferencesFromInvoice(invoice);
  if (references.paymentIds.length + references.refundReceiptIds.length > QUICKBOOKS_PAYMENT_EVIDENCE_MAX_LINKS) {
    throw new QuickBooksEvidenceError("QUICKBOOKS_PAYMENT_EVIDENCE_LIMIT_EXCEEDED", false);
  }

  async function fetchBounded<T>(
    ids: readonly string[],
    fetchOne: (id: string) => Promise<T>,
  ): Promise<{ records: T[]; missingIds: string[] }> {
    const missingIds: string[] = [];
    const results: Array<T | null> = new Array(ids.length).fill(null);
    let nextIndex = 0;
    const fetchNext = async () => {
      while (nextIndex < ids.length) {
        const index = nextIndex;
        nextIndex += 1;
        const id = ids[index]!;
        try {
          results[index] = await fetchOne(id);
        } catch (error) {
          if (error instanceof QuickBooksProviderError && error.statusCode === 404) {
            missingIds.push(id);
            continue;
          }
          throw error;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(QUICKBOOKS_PAYMENT_EVIDENCE_CONCURRENCY, ids.length) },
      () => fetchNext(),
    ));
    return { records: results.filter((record): record is T => Boolean(record)), missingIds };
  }

  // Keep one global provider-call ceiling. Running the two evidence pools in
  // parallel would double the intended concurrency from five to ten.
  const paymentEvidence = await fetchBounded(
    references.paymentIds,
    (paymentId) => fetchQuickBooksPayment(runtimeEnv, realmId, accessToken, paymentId),
  );
  const refundEvidence = await fetchBounded(
    references.refundReceiptIds,
    (refundReceiptId) => fetchQuickBooksRefundReceipt(runtimeEnv, realmId, accessToken, refundReceiptId),
  );
  return {
    payments: paymentEvidence.records,
    refundReceipts: refundEvidence.records,
    missingPaymentIds: paymentEvidence.missingIds,
    missingRefundReceiptIds: refundEvidence.missingIds,
  };
}

function eventIdentity(params: {
  providerInvoiceId: string;
  providerSyncToken?: string;
  providerUpdatedAtUtc: Date | null;
  balance: number;
  voided: boolean;
}): string {
  return createHash("sha256").update(JSON.stringify({
    provider: "QUICKBOOKS",
    invoiceId: params.providerInvoiceId,
    syncToken: params.providerSyncToken ?? null,
    updatedAt: params.providerUpdatedAtUtc?.toISOString() ?? null,
    balance: params.balance,
    voided: params.voided,
  }), "utf8").digest("hex");
}

type ProviderGeneration = {
  syncToken: string;
  syncTokenNumber: bigint;
  updatedAtUtc: Date;
};

type GenerationDecision = "FIRST" | "NEWER" | "EQUAL" | "STALE" | "INCONSISTENT";

function providerGeneration(invoice: QuickBooksReconciliationInvoiceEntity): ProviderGeneration {
  return {
    syncToken: invoice.SyncToken,
    syncTokenNumber: BigInt(invoice.SyncToken),
    updatedAtUtc: new Date(invoice.MetaData.LastUpdatedTime),
  };
}

function compareProviderGeneration(
  incoming: ProviderGeneration,
  stored: { providerSyncToken: string | null; providerUpdatedAtUtc: Date | null; lastReconciledAtUtc: Date | null },
): GenerationDecision {
  if (!stored.lastReconciledAtUtc) return "FIRST";
  if (
    !stored.providerSyncToken
    || !/^(0|[1-9][0-9]*)$/.test(stored.providerSyncToken)
    || !stored.providerUpdatedAtUtc
  ) return "INCONSISTENT";
  const storedSyncToken = BigInt(stored.providerSyncToken);
  const incomingTime = incoming.updatedAtUtc.getTime();
  const storedTime = stored.providerUpdatedAtUtc.getTime();
  if (incoming.syncTokenNumber === storedSyncToken && incomingTime === storedTime) return "EQUAL";
  if (incoming.syncTokenNumber <= storedSyncToken && incomingTime <= storedTime) return "STALE";
  if (incoming.syncTokenNumber > storedSyncToken && incomingTime >= storedTime) return "NEWER";
  return "INCONSISTENT";
}

function applicationMapFromEvidence(applications: readonly SupportedPaymentApplication[]): Map<string, number> {
  return new Map(applications
    .filter((application) => cents(application.amount) > 0)
    .map((application) => [application.providerPaymentId, cents(application.amount)]));
}

function applicationMapFromLedger(payments: readonly {
  providerPaymentId: string | null;
  amount: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
}[]): Map<string, number> | null {
  const result = new Map<string, number>();
  for (const payment of payments) {
    const grossCents = cents(money(payment.amount));
    const refundedCents = cents(money(payment.refundedAmount));
    const netCents = Math.max(0, grossCents - refundedCents);
    if (!payment.providerPaymentId) {
      if (netCents > 0) return null;
      continue;
    }
    if (netCents > 0) result.set(payment.providerPaymentId, netCents);
  }
  return result;
}

function applicationMapsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export async function reconcileQuickBooksInvoice(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  invoiceId: string;
  trigger: QuickBooksReconciliationTrigger;
  providerOperation?: string | null;
  getAccessToken: (connection: ReconciliationContext["connection"]) => Promise<string>;
}): Promise<QuickBooksReconciliationResult> {
  const context = await loadContext(params.prisma, params.tenantId, params.invoiceId);
  const expectedGeneration = {
    providerSyncToken: context.operation.providerSyncToken,
    providerUpdatedAtUtc: context.operation.providerUpdatedAtUtc,
    lastReconciledAtUtc: context.operation.lastReconciledAtUtc,
  };
  const accessToken = await params.getAccessToken(context.connection);
  const providerInvoiceResponse = await fetchQuickBooksInvoice(
    params.runtimeEnv,
    context.connection.realmId,
    accessToken,
    context.operation.providerInvoiceId,
  );
  let providerInvoice: QuickBooksReconciliationInvoiceEntity;
  try {
    providerInvoice = validateQuickBooksReconciliationInvoice(providerInvoiceResponse);
  } catch (error) {
    const code = error instanceof QuickBooksProviderError
      ? error.code
      : "QUICKBOOKS_INVOICE_RECONCILIATION_RESPONSE_INVALID";
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code,
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError(code, "QuickBooks returned an incomplete invoice snapshot.", false);
  }
  if (providerInvoice.Id !== context.operation.providerInvoiceId) {
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: "QUICKBOOKS_INVOICE_ID_MISMATCH",
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_ID_MISMATCH", "QuickBooks returned a different invoice identity.", false);
  }
  // Webhook/CDC operations are scheduling hints only. The freshly fetched,
  // canonical provider snapshot is authoritative for ledger state.
  const voided = isVoidedInvoice(providerInvoice);
  if (!voided && quickBooksInvoiceFingerprint(providerInvoice) !== context.operation.payloadHash) {
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: "QUICKBOOKS_INVOICE_FINGERPRINT_MISMATCH",
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_FINGERPRINT_MISMATCH", "QuickBooks invoice identity validation failed.", false);
  }

  const providerTotal = money(providerInvoice.TotalAmt);
  if (!voided && cents(providerTotal) !== cents(context.invoiceTotal)) {
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: "QUICKBOOKS_INVOICE_TOTAL_DRIFT",
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_TOTAL_DRIFT", "QuickBooks invoice totals differ from QuoteFly.", false);
  }
  const providerCurrency = providerInvoice.CurrencyRef?.value ?? providerInvoice.CurrencyRef?.name ?? "USD";
  if (providerCurrency !== context.invoiceCurrency) {
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: "QUICKBOOKS_INVOICE_CURRENCY_DRIFT",
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError("QUICKBOOKS_INVOICE_CURRENCY_DRIFT", "QuickBooks invoice currency differs from QuoteFly.", false);
  }

  const paymentReviewFailure = providerPaymentReviewFailure(providerInvoice, context.operation);
  if (paymentReviewFailure) {
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: paymentReviewFailure,
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError(
      paymentReviewFailure,
      "QuickBooks did not confirm the reviewed hosted-payment methods.",
      false,
    );
  }

  const balance = money(providerInvoice.Balance);
  const amountPaid = money(context.invoiceTotal - balance);
  let applications: SupportedPaymentApplication[];
  try {
    const evidence = await fetchPaymentEvidence(
      params.runtimeEnv,
      context.connection.realmId,
      accessToken,
      providerInvoice,
    );
    applications = supportedPaymentApplications({
      invoice: providerInvoice,
      payments: evidence.payments,
      refundReceipts: evidence.refundReceipts,
      missingPaymentIds: evidence.missingPaymentIds,
      missingRefundReceiptIds: evidence.missingRefundReceiptIds,
      invoiceCurrency: context.invoiceCurrency,
      requiredReduction: voided ? 0 : amountPaid,
    });
  } catch (error) {
    if (!(error instanceof QuickBooksEvidenceError)) throw error;
    await quarantineQuickBooksReconciliation({
      prisma: params.prisma,
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      operationId: context.operation.id,
      code: error.code,
      expectedGeneration,
    });
    throw new QuickBooksReconciliationError(
      error.code,
      "QuickBooks payment evidence could not prove the invoice balance.",
      error.retryable,
    );
  }
  const onlinePaymentsExpected = context.operation.allowOnlineAchPayment || context.operation.allowOnlineCardPayment;
  const hostedPaymentUrl = onlinePaymentsExpected && !voided && balance > 0
    ? validateQuickBooksInvoiceLink(providerInvoice.InvoiceLink)
    : null;
  const paymentLinkUnavailable = onlinePaymentsExpected && !hostedPaymentUrl && !voided && balance > 0;
  const incomingGeneration = providerGeneration(providerInvoice);
  const updatedAtUtc = incomingGeneration.updatedAtUtc;
  const projectionEventId = eventIdentity({
    providerInvoiceId: providerInvoice.Id,
    providerSyncToken: providerInvoice.SyncToken,
    providerUpdatedAtUtc: updatedAtUtc,
    balance,
    voided,
  });

  const projection = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT 1::int AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${`quickbooks-ledger:${params.tenantId}:${params.invoiceId}`}, 0))
      ) acquired
    `);
    const current = await transaction.invoice.findFirstOrThrow({
      where: { id: params.invoiceId, tenantId: params.tenantId, deletedAtUtc: null },
      select: {
        status: true,
        paymentStatus: true,
        amountPaid: true,
        balanceDue: true,
        paidAtUtc: true,
        voidedAtUtc: true,
      },
    });
    const [currentOperation, existingPayments] = await Promise.all([
      transaction.quickBooksInvoiceOperation.findFirstOrThrow({
        where: { id: context.operation.id, tenantId: params.tenantId, invoiceId: params.invoiceId, archivedAtUtc: null },
        select: {
          id: true,
          providerSyncToken: true,
          providerUpdatedAtUtc: true,
          providerBalance: true,
          providerInvoiceStatus: true,
          providerInvoiceLink: true,
          lastReconciledAtUtc: true,
          succeededAtUtc: true,
        },
      }),
      transaction.invoicePayment.findMany({
        where: { tenantId: params.tenantId, invoiceId: params.invoiceId, provider: "QUICKBOOKS", deletedAtUtc: null },
        select: { id: true, providerPaymentId: true, amount: true, refundedAmount: true, status: true },
      }),
    ]);
    const generationDecision = compareProviderGeneration(incomingGeneration, currentOperation);
    if (generationDecision === "STALE") {
      return {
        kind: "STALE" as const,
        result: {
          invoiceId: params.invoiceId,
          providerInvoiceId: providerInvoice.Id,
          invoiceStatus: current.status as QuickBooksReconciliationResult["invoiceStatus"],
          paymentStatus: current.paymentStatus as QuickBooksReconciliationResult["paymentStatus"],
          amountPaid: money(current.amountPaid),
          balanceDue: money(current.balanceDue),
          hostedPaymentUrlAvailable: Boolean(validateQuickBooksInvoiceLink(currentOperation.providerInvoiceLink)),
        },
      };
    }
    if (generationDecision === "INCONSISTENT") {
      const code = "QUICKBOOKS_INVOICE_GENERATION_INCONSISTENT";
      await quarantineQuickBooksReconciliationTransaction(transaction, {
        tenantId: params.tenantId,
        invoiceId: params.invoiceId,
        operationId: context.operation.id,
        code,
      });
      return { kind: "QUARANTINED" as const, code, retryable: false };
    }

    const livePaymentIds = new Set(applications.map((application) => application.providerPaymentId));
    const removedPayments = existingPayments.filter((payment) =>
      payment.providerPaymentId && !livePaymentIds.has(payment.providerPaymentId)
    );
    const previousAmountPaid = money(current.amountPaid);
    const hadPriorCollection = previousAmountPaid > 0
      || existingPayments.some((payment) => money(payment.amount) > 0);
    const hasRefundOrReversalEvidence = existingPayments.some((payment) =>
      money(payment.refundedAmount) > 0
      || payment.status === "REFUNDED"
      || payment.status === "PARTIALLY_REFUNDED"
      || payment.status === "CANCELED"
    ) || applications.some((application) => {
      const prior = existingPayments.find((payment) => payment.providerPaymentId === application.providerPaymentId);
      return application.explicitRefundAmount > 0
        || Boolean(prior && application.amount < money(prior.amount));
    });
    const reopened = amountPaid < previousAmountPaid
      || removedPayments.length > 0
      || hasRefundOrReversalEvidence;
    const invoiceStatus: QuickBooksReconciliationResult["invoiceStatus"] = voided
      ? "VOID"
      : balance === 0
        ? "PAID"
        : "OPEN";
    const paymentStatus: QuickBooksReconciliationResult["paymentStatus"] = voided
      ? "CANCELED"
      : balance === 0
        ? "SUCCEEDED"
        : balance === context.invoiceTotal
          ? (hadPriorCollection || hasRefundOrReversalEvidence ? "REFUNDED" : "PENDING")
          : (reopened ? "PARTIALLY_REFUNDED" : "PARTIALLY_PAID");
    const projectedAmountPaid = voided ? 0 : amountPaid;
    const projectedBalanceDue = voided ? 0 : balance;
    const incomingProviderStatus = providerInvoice.TxnStatus ?? (voided ? "VOID" : invoiceStatus);

    if (generationDecision === "EQUAL") {
      const incomingApplications = applicationMapFromEvidence(applications);
      const ledgerApplications = applicationMapFromLedger(existingPayments);
      const materialSnapshotDiffers = money(currentOperation.providerBalance) !== balance
        || currentOperation.providerInvoiceStatus !== incomingProviderStatus
        || current.status !== invoiceStatus
        || current.paymentStatus !== paymentStatus
        || money(current.amountPaid) !== projectedAmountPaid
        || money(current.balanceDue) !== projectedBalanceDue
        || !ledgerApplications
        || !applicationMapsEqual(incomingApplications, ledgerApplications);
      if (materialSnapshotDiffers) {
        const code = "QUICKBOOKS_EQUAL_GENERATION_SNAPSHOT_DRIFT";
        await quarantineQuickBooksReconciliationTransaction(transaction, {
          tenantId: params.tenantId,
          invoiceId: params.invoiceId,
          operationId: context.operation.id,
          code,
        });
        return { kind: "QUARANTINED" as const, code, retryable: false };
      }
    }

    const now = new Date();
    const operationClaim = await transaction.quickBooksInvoiceOperation.updateMany({
      where: {
        id: currentOperation.id,
        tenantId: params.tenantId,
        providerSyncToken: currentOperation.providerSyncToken,
        providerUpdatedAtUtc: currentOperation.providerUpdatedAtUtc,
        lastReconciledAtUtc: currentOperation.lastReconciledAtUtc,
      },
      data: {
        status: paymentLinkUnavailable ? "RECONCILIATION_REQUIRED" : "SUCCEEDED",
        claimTokenHash: null,
        claimExpiresAtUtc: null,
        providerInvoiceLink: hostedPaymentUrl,
        invoiceLinkFetchedAtUtc: hostedPaymentUrl ? now : null,
        providerSyncToken: incomingGeneration.syncToken,
        providerInvoiceStatus: incomingProviderStatus,
        providerBalance: balance,
        providerUpdatedAtUtc: incomingGeneration.updatedAtUtc,
        lastReconciledAtUtc: now,
        succeededAtUtc: paymentLinkUnavailable ? null : (currentOperation.succeededAtUtc ?? now),
        failedAtUtc: paymentLinkUnavailable ? now : null,
        lastFailureCode: paymentLinkUnavailable ? "QUICKBOOKS_INVOICE_LINK_UNAVAILABLE" : null,
      },
    });
    if (operationClaim.count !== 1) {
      return { kind: "CAS_LOST" as const };
    }

    for (const application of applications) {
      const prior = existingPayments.find((payment) => payment.providerPaymentId === application.providerPaymentId);
      const grossAmount = Math.max(application.grossAmount, application.amount, money(prior?.amount));
      const refundedAmount = money(grossAmount - application.amount);
      const applicationStatus = refundedAmount >= grossAmount && grossAmount > 0
        ? "REFUNDED"
        : refundedAmount > 0
          ? "PARTIALLY_REFUNDED"
          : "SUCCEEDED";
      await transaction.invoicePayment.upsert({
        where: {
          tenantId_provider_providerPaymentId_invoiceId: {
            tenantId: params.tenantId,
            provider: "QUICKBOOKS",
            providerPaymentId: application.providerPaymentId,
            invoiceId: params.invoiceId,
          },
        },
        create: {
          tenantId: params.tenantId,
          invoiceId: params.invoiceId,
          provider: "QUICKBOOKS",
          providerPaymentId: application.providerPaymentId,
          providerInvoiceId: providerInvoice.Id,
          status: applicationStatus,
          amount: grossAmount,
          currency: context.invoiceCurrency,
          paidAtUtc: application.paidAtUtc,
          refundedAtUtc: refundedAmount > 0 ? (application.refundedAtUtc ?? application.providerUpdatedAtUtc ?? now) : null,
          refundedAmount,
          providerSyncToken: application.providerSyncToken,
          providerUpdatedAtUtc: application.providerUpdatedAtUtc,
        },
        update: {
          providerInvoiceId: providerInvoice.Id,
          status: applicationStatus,
          amount: grossAmount,
          paidAtUtc: application.paidAtUtc,
          failedAtUtc: null,
          refundedAtUtc: refundedAmount > 0 ? (application.refundedAtUtc ?? application.providerUpdatedAtUtc ?? now) : null,
          refundedAmount,
          failureCode: null,
          providerSyncToken: application.providerSyncToken,
          providerUpdatedAtUtc: application.providerUpdatedAtUtc,
          deletedAtUtc: null,
        },
      });
    }
    if (removedPayments.length > 0) {
      for (const payment of removedPayments) {
        await transaction.invoicePayment.update({
          where: { id: payment.id },
          data: {
            status: "CANCELED",
            refundedAmount: Math.max(money(payment.refundedAmount), money(payment.amount)),
            refundedAtUtc: now,
            failureCode: "QUICKBOOKS_PAYMENT_REMOVED_OR_REVERSED",
          },
        });
      }
    }
    const materialProjectionChanged = current.status !== invoiceStatus
      || current.paymentStatus !== paymentStatus
      || money(current.amountPaid) !== projectedAmountPaid
      || money(current.balanceDue) !== projectedBalanceDue;
    if (materialProjectionChanged) {
      await transaction.invoice.update({
        where: { id: params.invoiceId },
        data: {
          status: invoiceStatus,
          paymentStatus,
          amountPaid: projectedAmountPaid,
          balanceDue: projectedBalanceDue,
          paidAtUtc: invoiceStatus === "PAID" ? (current.paidAtUtc ?? now) : null,
          voidedAtUtc: voided ? (current.voidedAtUtc ?? now) : null,
          version: { increment: 1 },
        },
      });
    }
    const existingEvent = await transaction.invoiceEvent.findFirst({
      where: { tenantId: params.tenantId, providerEventId: projectionEventId },
      select: { id: true },
    });
    if (!existingEvent && (materialProjectionChanged || paymentLinkUnavailable)) {
      await transaction.invoiceEvent.create({
        data: {
          tenantId: params.tenantId,
          invoiceId: params.invoiceId,
          type: paymentLinkUnavailable
            ? "PROVIDER_RECONCILIATION_REQUIRED"
            : voided
              ? "VOIDED"
              : "PAYMENT_UPDATED",
          fromStatus: current.status,
          toStatus: invoiceStatus,
          fromPaymentStatus: current.paymentStatus,
          toPaymentStatus: paymentStatus,
          requestId: `${params.trigger}:${providerInvoice.Id}`.slice(0, 191),
          providerEventId: projectionEventId,
        },
      });
    }
    await transaction.quickBooksConnection.update({
      where: { id: context.connection.id },
      data: { lastSyncAtUtc: now, status: "CONNECTED", lastError: null },
    });
    return {
      kind: "APPLIED" as const,
      result: {
        invoiceId: params.invoiceId,
        providerInvoiceId: providerInvoice.Id,
        invoiceStatus,
        paymentStatus,
        amountPaid: projectedAmountPaid,
        balanceDue: projectedBalanceDue,
        hostedPaymentUrlAvailable: Boolean(hostedPaymentUrl),
      },
    };
  }, { maxWait: 5_000, timeout: 15_000 });
  if (projection.kind === "QUARANTINED") {
    throw new QuickBooksReconciliationError(
      projection.code,
      "QuickBooks returned an out-of-order or conflicting invoice snapshot.",
      projection.retryable,
    );
  }
  if (projection.kind === "CAS_LOST") {
    throw new QuickBooksReconciliationError(
      "QUICKBOOKS_RECONCILIATION_CAS_LOST",
      "A newer QuickBooks reconciliation won the invoice update.",
      true,
    );
  }
  return projection.result;
}
