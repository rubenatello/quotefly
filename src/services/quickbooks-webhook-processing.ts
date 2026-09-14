import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { fetchQuickBooksPayment, fetchQuickBooksRefundReceipt, QuickBooksProviderError } from "./quickbooks";
import { getSerializedQuickBooksAccessToken, runQuickBooksProviderRequestWithRefresh } from "./quickbooks-credentials";
import { pageQuickBooksProviderEntityIds, QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM } from "./quickbooks-cdc";
import { reconcileQuickBooksInvoice } from "./quickbooks-reconciliation";
import { classifyQuickBooksWorkerFailure } from "./quickbooks-worker-failures";
import { claimQuickBooksWebhookEvent, completeQuickBooksWebhookEvent, failQuickBooksWebhookEvent, type QuickBooksWebhookClaim } from "./quickbooks-webhook-inbox";

type ProcessingContext = {
  prisma: PrismaClient;
  runtimeEnv: typeof env;
  reconcile?: typeof reconcileQuickBooksInvoice;
};

const RETRY_COUNTS_KEY = "quoteflyInvoiceRetryCounts";
const TERMINAL_FAILURES_KEY = "quoteflyInvoiceTerminalFailures";
const MAX_INVOICE_ATTEMPTS = 8;
const MAX_FAILURE_CODES = 20;

type ProcessingOutcome = Readonly<{
  status: "idle" | "processed" | "failed" | "dead";
  failureCode?: string;
}>;

function boundedCounts(payload: Prisma.JsonObject, key: string): Map<string, number> {
  const value = payload[key];
  if (value === undefined) return new Map();
  const limit = key === TERMINAL_FAILURES_KEY ? MAX_FAILURE_CODES : 1_000;
  if (!Array.isArray(value) || value.length > limit) throw new Error("QUICKBOOKS_WEBHOOK_WORKLIST_INVALID");
  const counts = new Map<string, number>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string"
      || item[0].length > 191 || typeof item[1] !== "number"
      || !Number.isInteger(item[1]) || item[1] < 1 || item[1] > 1_000) {
      throw new Error("QUICKBOOKS_WEBHOOK_WORKLIST_INVALID");
    }
    if (key === TERMINAL_FAILURES_KEY && !/^[A-Z][A-Z0-9_]{0,190}$/.test(item[0])) {
      throw new Error("QUICKBOOKS_WEBHOOK_WORKLIST_INVALID");
    }
    counts.set(item[0], item[1]);
  }
  return counts;
}

/** Drains one bounded page; every invoice result is durably fenced before advancing. */
export async function processQuickBooksWebhookClaim(
  context: ProcessingContext,
  claim: QuickBooksWebhookClaim,
): Promise<ProcessingOutcome> {
  const { prisma, runtimeEnv } = context;
  try {
    const work = await invoiceIdsForClaim(context, claim);
    let pending = [...new Set([...work.invoiceIds, ...work.remainingInvoiceIds])];
    let payload = await persistQuickBooksWebhookWorklist(
      prisma, claim, work.payload, work.remainingProviderInvoiceIds, pending,
    );
    const retries = boundedCounts(payload, RETRY_COUNTS_KEY);
    const terminal = boundedCounts(payload, TERMINAL_FAILURES_KEY);
    const retryFailures = new Map<string, string>();
    for (const invoiceId of work.invoiceIds) {
      let retryCode: string | undefined;
      let terminalCode: string | undefined;
      try {
        await (context.reconcile ?? reconcileQuickBooksInvoice)({
          prisma, runtimeEnv, tenantId: claim.tenantId, invoiceId,
          trigger: work.trigger, providerOperation: claim.operation,
          getAccessToken: (connection) => getSerializedQuickBooksAccessToken({ prisma, runtimeEnv, connection }),
        });
      } catch (error) {
        const failure = classifyQuickBooksWorkerFailure(error);
        const attempts = (retries.get(invoiceId) ?? 0) + 1;
        if (failure.retryable && attempts < MAX_INVOICE_ATTEMPTS) {
          retries.set(invoiceId, attempts);
          retryCode = failure.code;
        } else {
          terminalCode = failure.code;
        }
      }
      pending = pending.filter((id) => id !== invoiceId);
      if (retryCode) {
        pending.push(invoiceId);
        retryFailures.set(invoiceId, retryCode);
      } else {
        retries.delete(invoiceId);
      }
      if (terminalCode) {
        // Only sanitized, bounded codes/counts are retained, never provider error text.
        const code = terminal.has(terminalCode) || terminal.size < MAX_FAILURE_CODES - 1
          ? terminalCode : "QUICKBOOKS_OTHER_INVOICE_FAILURES";
        terminal.set(code, Math.min(1_000, (terminal.get(code) ?? 0) + 1));
      }
      payload = await persistQuickBooksWebhookWorklist(prisma, claim, {
        ...payload,
        [RETRY_COUNTS_KEY]: [...retries],
        [TERMINAL_FAILURES_KEY]: [...terminal],
      }, work.remainingProviderInvoiceIds, pending);
    }
    if (work.remainingProviderInvoiceIds.length > 0 || pending.some((id) => !retryFailures.has(id))) {
      const requeued = await requeueQuickBooksWebhookClaim(prisma, claim, payload, work.remainingProviderInvoiceIds, pending);
      return requeued ? { status: "processed" } : { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
    }
    if (pending.length > 0) {
      const failureCode = retryFailures.get(pending[0]!) ?? "QUICKBOOKS_WORKER_FAILURE";
      // Page continuations reset the parent attempt count. Use durable per-invoice
      // attempts for backoff so large fanouts neither starve siblings nor retry forever.
      const attemptCount = Math.min(...pending.map((id) => retries.get(id) ?? 1));
      const outcome = await failQuickBooksWebhookEvent(prisma, { ...claim, attemptCount }, failureCode, { retryable: true });
      return { status: outcome === "DEAD" ? "dead" : "failed", failureCode };
    }
    if (terminal.size > 0) {
      const failureCode = "QUICKBOOKS_WEBHOOK_INVOICE_FAILURES";
      const outcome = await failQuickBooksWebhookEvent(prisma, claim, failureCode, { retryable: false });
      return { status: outcome === "DEAD" ? "dead" : "failed", failureCode };
    }
    return await completeQuickBooksWebhookEvent(prisma, claim)
      ? { status: "processed" }
      : { status: "failed", failureCode: "QUICKBOOKS_WEBHOOK_CLAIM_STALE" };
  } catch (error) {
    const failure = classifyQuickBooksWorkerFailure(error);
    const outcome = await failQuickBooksWebhookEvent(prisma, claim, failure.code, { retryable: failure.retryable });
    return {
      status: outcome === "DEAD" ? "dead" : "failed",
      failureCode: outcome === "STALE" ? "QUICKBOOKS_WEBHOOK_CLAIM_STALE" : failure.code,
    };
  }
}

export async function processQuickBooksWebhookForTenant(
  context: ProcessingContext & { tenantId: string },
): Promise<ProcessingOutcome> {
  const claim = await claimQuickBooksWebhookEvent(context.prisma, context.tenantId);
  return claim ? processQuickBooksWebhookClaim(context, claim) : { status: "idle" };
}

const WEBHOOK_PROVIDER_WORKLIST_KEY = "quoteflyPendingProviderInvoiceIds";
const WEBHOOK_INVOICE_WORKLIST_KEY = "quoteflyPendingInvoiceIds";

function webhookPayloadStringArray(payload: Prisma.JsonValue, key: string): string[] | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = (payload as Prisma.JsonObject)[key];
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1_000
    || value.some((entry) => typeof entry !== "string" || entry.length > 191)) {
    throw new Error("QUICKBOOKS_WEBHOOK_WORKLIST_INVALID");
  }
  return [...new Set(value as string[])];
}

function webhookPayloadWithContinuation(
  payload: Prisma.JsonValue,
  remainingProviderInvoiceIds: readonly string[],
  remainingInvoiceIds: readonly string[],
): Prisma.JsonObject {
  if (remainingProviderInvoiceIds.length + remainingInvoiceIds.length > 1_000
    || [...remainingProviderInvoiceIds, ...remainingInvoiceIds].some((id) => !id || id.length > 191)) {
    throw new Error("QUICKBOOKS_WEBHOOK_WORKLIST_INVALID");
  }
  const existing = payload && !Array.isArray(payload) && typeof payload === "object"
    ? payload as Prisma.JsonObject
    : {};
  return {
    ...existing,
    [WEBHOOK_PROVIDER_WORKLIST_KEY]: [...remainingProviderInvoiceIds],
    [WEBHOOK_INVOICE_WORKLIST_KEY]: [...remainingInvoiceIds],
  } as Prisma.JsonObject;
}

async function persistQuickBooksWebhookWorklist(
  prisma: PrismaClient,
  claim: NonNullable<Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>>,
  payload: Prisma.JsonValue,
  providerInvoiceIds: readonly string[],
  invoiceIds: readonly string[],
): Promise<Prisma.JsonObject> {
  const stablePayload = webhookPayloadWithContinuation(payload, providerInvoiceIds, invoiceIds);
  const claimTokenHash = createHash("sha256").update(claim.claimToken, "utf8").digest("hex");
  const persisted = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
    transaction.quickBooksWebhookEvent.updateMany({
      where: { id: claim.id, tenantId: claim.tenantId, status: "PROCESSING", claimTokenHash },
      data: { payload: stablePayload },
    }),
  );
  if (persisted.count !== 1) throw new Error("QUICKBOOKS_WEBHOOK_CLAIM_STALE");
  return stablePayload;
}

async function invoiceIdsForClaim(context: ProcessingContext, claim: QuickBooksWebhookClaim) {
  const { prisma, runtimeEnv: env } = context;
  const event = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
    transaction.quickBooksWebhookEvent.findFirst({
      where: { id: claim.id, tenantId: claim.tenantId, status: "PROCESSING",
        claimTokenHash: createHash("sha256").update(claim.claimToken, "utf8").digest("hex") },
      select: { payload: true },
    }),
  );
  if (!event) throw new Error("QUICKBOOKS_WEBHOOK_CLAIM_STALE");
  const payload = event.payload;
  const trigger = payload && !Array.isArray(payload) && typeof payload === "object"
    && (payload as Prisma.JsonObject).quoteflyTrigger === "CDC"
    ? "CDC" as const
    : "WEBHOOK" as const;

  const connection = { id: claim.quickBooksConnectionId, tenantId: claim.tenantId, realmId: claim.realmId };
  const invoiceIdsForProviderWorklist = async (
    providerInvoiceIds: readonly string[],
    persistBeforeProcessing = false,
  ) => {
    const providerPage = pageQuickBooksProviderEntityIds(providerInvoiceIds);
    const stableProviderInvoiceIds = [
      ...providerPage.providerEntityIds,
      ...providerPage.remainingProviderEntityIds,
    ];
    const stablePayload = persistBeforeProcessing
      ? await persistQuickBooksWebhookWorklist(prisma, claim, payload, stableProviderInvoiceIds, [])
      : payload;
    const invoiceIds = providerPage.providerEntityIds.length === 0
      ? []
      : await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
          transaction.quickBooksInvoiceOperation.findMany({
            where: {
              tenantId: claim.tenantId,
              quickBooksConnectionId: claim.quickBooksConnectionId,
              providerInvoiceId: { in: [...providerPage.providerEntityIds] },
              archivedAtUtc: null,
            },
            select: { invoiceId: true },
            orderBy: { invoiceId: "asc" },
          }).then((rows) => rows.map((row) => row.invoiceId)),
        );
    return {
      invoiceIds: [...new Set([...invoiceIds, ...(webhookPayloadStringArray(payload, WEBHOOK_INVOICE_WORKLIST_KEY) ?? [])])]
        .slice(0, QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM),
      remainingProviderInvoiceIds: [...providerPage.remainingProviderEntityIds],
      remainingInvoiceIds: [...new Set([...invoiceIds, ...(webhookPayloadStringArray(payload, WEBHOOK_INVOICE_WORKLIST_KEY) ?? [])])]
        .slice(QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM),
      payload: stablePayload,
      trigger,
    };
  };
  const storedProviderInvoiceIds = webhookPayloadStringArray(payload, WEBHOOK_PROVIDER_WORKLIST_KEY);
  if (storedProviderInvoiceIds?.length) return invoiceIdsForProviderWorklist(storedProviderInvoiceIds);
  const storedInvoiceIds = webhookPayloadStringArray(payload, WEBHOOK_INVOICE_WORKLIST_KEY);
  if (storedInvoiceIds !== null || storedProviderInvoiceIds !== null) {
    // Keep the durable order: retries were moved behind unattempted siblings.
    const invoiceIds = storedInvoiceIds ?? [];
    return {
      invoiceIds: invoiceIds.slice(0, QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM),
      remainingProviderInvoiceIds: [] as string[],
      remainingInvoiceIds: invoiceIds.slice(QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM),
      payload,
      trigger,
    };
  }
  if (claim.eventType === "Invoice") {
    const invoiceIds = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
      transaction.quickBooksInvoiceOperation.findMany({
        where: {
          tenantId: claim.tenantId,
          quickBooksConnectionId: claim.quickBooksConnectionId,
          providerInvoiceId: claim.entityId,
          archivedAtUtc: null,
        },
        select: { invoiceId: true },
        orderBy: { invoiceId: "asc" },
        take: 1,
      }).then((rows) => rows.map((row) => row.invoiceId)),
    );
    return {
      invoiceIds,
      remainingProviderInvoiceIds: [],
      remainingInvoiceIds: [],
      payload,
      trigger,
    };
  }

  if (claim.eventType === "RefundReceipt") {
    const refundReceipt = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksRefundReceipt(env, claim.realmId, accessToken, claim.entityId),
    });
    const linkedPayments = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "payment" && linked.TxnId?.trim()
    );
    const linkedInvoices = refundReceipt.LinkedTxn.filter((linked) =>
      linked.TxnType?.trim().toLowerCase() === "invoice" && linked.TxnId?.trim()
    );
    const hasUnsupportedLink = refundReceipt.LinkedTxn.some((linked) => {
      const type = linked.TxnType?.trim().toLowerCase();
      return type !== "payment" && type !== "invoice";
    });
    if (hasUnsupportedLink || linkedPayments.length !== 1 || linkedInvoices.length !== 1) {
      throw new QuickBooksProviderError("QUICKBOOKS_REFUND_APPLICATION_UNSUPPORTED", false);
    }
    const providerInvoiceId = linkedInvoices[0]!.TxnId!.trim();
    const payment = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksPayment(
        env,
        claim.realmId,
        accessToken,
        linkedPayments[0]!.TxnId!.trim(),
      ),
    });
    const paymentInvoiceIds = new Set((payment.Line ?? [])
      .flatMap((line) => line.LinkedTxn ?? [])
      .filter((linked) => linked.TxnType?.trim().toLowerCase() === "invoice" && linked.TxnId?.trim())
      .map((linked) => linked.TxnId!.trim()));
    if (!paymentInvoiceIds.has(providerInvoiceId)) {
      throw new QuickBooksProviderError("QUICKBOOKS_REFUND_PAYMENT_NOT_LINKED_TO_INVOICE", false);
    }
    return invoiceIdsForProviderWorklist([providerInvoiceId], true);
  }
  if (claim.eventType !== "Payment") {
    throw new QuickBooksProviderError("QUICKBOOKS_WEBHOOK_ENTITY_UNSUPPORTED", false);
  }
  try {
    const payment = await runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection,
      operation: (accessToken) => fetchQuickBooksPayment(env, claim.realmId, accessToken, claim.entityId),
    });
    const providerInvoiceIds = (payment.Line ?? [])
      .flatMap((line) => line.LinkedTxn ?? [])
      .filter((linked) => linked.TxnType === "Invoice" && linked.TxnId)
      .map((linked) => linked.TxnId as string);
    return invoiceIdsForProviderWorklist(providerInvoiceIds, true);
  } catch (error) {
    if (!(error instanceof QuickBooksProviderError) || error.statusCode !== 404) throw error;
    const invoiceIds = await withTenantRlsContext(prisma, claim.tenantId, (transaction) =>
      transaction.invoicePayment.findMany({
        where: {
          tenantId: claim.tenantId,
          provider: "QUICKBOOKS",
          providerPaymentId: claim.entityId,
          deletedAtUtc: null,
        },
        select: { invoiceId: true },
        orderBy: { invoiceId: "asc" },
        distinct: ["invoiceId"],
        take: 1_001,
      }).then((rows) => [...new Set(rows.map((row) => row.invoiceId))]),
    );
    const invoicePage = pageQuickBooksProviderEntityIds(invoiceIds);
    const stableInvoiceIds = [...invoicePage.providerEntityIds, ...invoicePage.remainingProviderEntityIds];
    const stablePayload = await persistQuickBooksWebhookWorklist(prisma, claim, payload, [], stableInvoiceIds);
    return {
      invoiceIds: [...invoicePage.providerEntityIds],
      remainingProviderInvoiceIds: [],
      remainingInvoiceIds: [...invoicePage.remainingProviderEntityIds],
      payload: stablePayload,
      trigger,
    };
  }
}

async function requeueQuickBooksWebhookClaim(
  prisma: PrismaClient,
  claim: NonNullable<Awaited<ReturnType<typeof claimQuickBooksWebhookEvent>>>,
  payload: Prisma.JsonValue,
  remainingProviderInvoiceIds: readonly string[],
  remainingInvoiceIds: readonly string[],
): Promise<boolean> {
  const claimTokenHash = createHash("sha256").update(claim.claimToken, "utf8").digest("hex");
  return withTenantRlsContext(prisma, claim.tenantId, async (transaction) => {
    const result = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        id: claim.id,
        tenantId: claim.tenantId,
        status: "PROCESSING",
        claimTokenHash,
      },
      data: {
        payload: webhookPayloadWithContinuation(payload, remainingProviderInvoiceIds, remainingInvoiceIds),
        status: "RECEIVED",
        // A successfully drained page is continuation, not a failed attempt.
        // Resetting the retry counter prevents legitimate large payments from
        // exhausting the dead-letter budget solely because they need pages.
        attemptCount: 0,
        claimTokenHash: null,
        claimExpiresAtUtc: null,
        nextAttemptAtUtc: null,
        lastError: null,
      },
    });
    return result.count === 1;
  });
}
