import type { PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  fetchQuickBooksCdc,
  type QuickBooksInvoiceEntity,
  type QuickBooksPaymentEntity,
  type QuickBooksRefundReceiptEntity,
} from "./quickbooks";
import type { QuickBooksTokenConnection } from "./quickbooks-credentials";
import { quickBooksWebhookEventId } from "./quickbooks-webhook-inbox";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";

type RuntimeEnv = typeof env;

const CDC_OVERLAP_MS = 2 * 60 * 1000;
const CDC_INTERVAL_MS = 5 * 60 * 1000;
export const QUICKBOOKS_CDC_MAX_ATTEMPTS = 8;
export const QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM = 10;
const QUICKBOOKS_PROVIDER_ENTITY_LIMIT = 1_000;
const CDC_INBOX_INSERT_CHUNK_SIZE = 100;

export type QuickBooksCdcClaim = Readonly<{
  id: string;
  tenantId: string;
  changedSinceUtc: Date;
  quickBooksConnectionId: string;
  connection: QuickBooksTokenConnection;
  claimAttemptCount: number;
  claimStartedAtUtc: Date;
  claimLeaseExpiresAtUtc: Date;
}>;

export type QuickBooksProviderEntityPage = Readonly<{
  providerEntityIds: readonly string[];
  remainingProviderEntityIds: readonly string[];
}>;

/**
 * Turns provider-controlled entity arrays into a deterministic, bounded work
 * page. The hard ceiling fails closed before an unexpectedly large provider
 * response can turn one worker tick into unbounded database/provider fan-out.
 */
export function pageQuickBooksProviderEntityIds(
  providerEntityIds: Iterable<string>,
  take = QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM,
): QuickBooksProviderEntityPage {
  if (!Number.isInteger(take) || take < 1 || take > QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM) {
    throw new Error("QuickBooks provider work page size is invalid.");
  }
  const uniqueIds = new Set<string>();
  for (const providerEntityId of providerEntityIds) {
    if (!providerEntityId) continue;
    uniqueIds.add(providerEntityId);
    if (uniqueIds.size > QUICKBOOKS_PROVIDER_ENTITY_LIMIT) {
      throw new Error("QUICKBOOKS_PROVIDER_ENTITY_LIMIT_EXCEEDED");
    }
  }
  const orderedIds = [...uniqueIds].sort((left, right) => left.localeCompare(right));
  return {
    providerEntityIds: orderedIds.slice(0, take),
    remainingProviderEntityIds: orderedIds.slice(take),
  };
}

export type QuickBooksCdcWorkItem = Readonly<{
  webhookEventId: string;
  eventType: "Invoice" | "Payment" | "RefundReceipt";
  entityId: string;
  operation: string;
  providerUpdatedAtUtc: Date;
  payload: Readonly<Record<string, string>>;
}>;

/** Creates a stable per-entity worklist that can be committed with the CDC cursor. */
export function buildQuickBooksCdcWorkItems(params: {
  realmId: string;
  invoices: readonly QuickBooksInvoiceEntity[];
  payments: readonly QuickBooksPaymentEntity[];
  refundReceipts: readonly QuickBooksRefundReceiptEntity[];
  fallbackUpdatedAtUtc: Date;
}): QuickBooksCdcWorkItem[] {
  const entities = [
    ...params.invoices.map((entity) => ({ eventType: "Invoice" as const, entity })),
    ...params.payments.map((entity) => ({ eventType: "Payment" as const, entity })),
    ...params.refundReceipts.map((entity) => ({ eventType: "RefundReceipt" as const, entity })),
  ];
  if (entities.length > QUICKBOOKS_PROVIDER_ENTITY_LIMIT) {
    throw new Error("QUICKBOOKS_PROVIDER_ENTITY_LIMIT_EXCEEDED");
  }
  const unique = new Map<string, QuickBooksCdcWorkItem>();
  for (const { eventType, entity } of entities) {
    const providerUpdatedAtUtc = entity.MetaData?.LastUpdatedTime
      ? new Date(entity.MetaData.LastUpdatedTime)
      : params.fallbackUpdatedAtUtc;
    if (Number.isNaN(providerUpdatedAtUtc.getTime())) {
      throw new Error("QUICKBOOKS_CDC_ENTITY_TIMESTAMP_INVALID");
    }
    const operation = eventType === "Invoice" ? entity.TxnStatus ?? "Update" : "Update";
    const lastUpdated = providerUpdatedAtUtc.toISOString();
    const notification = {
      realmId: params.realmId,
      name: eventType,
      id: entity.Id,
      operation,
      lastUpdated,
    };
    const workItem: QuickBooksCdcWorkItem = {
      webhookEventId: quickBooksWebhookEventId(notification),
      eventType,
      entityId: entity.Id,
      operation,
      providerUpdatedAtUtc,
      payload: {
        name: eventType,
        id: entity.Id,
        operation,
        lastUpdated,
        quoteflyTrigger: "CDC",
      },
    };
    unique.set(`${eventType}:${entity.Id}:${lastUpdated}`, workItem);
  }
  return [...unique.values()].sort((left, right) =>
    left.eventType.localeCompare(right.eventType) || left.entityId.localeCompare(right.entityId)
  );
}

/**
 * Claims exactly one due CDC cursor. The three claim fields form a lease
 * generation fence: a reclaimed worker increments the attempt and replaces
 * both timestamps, so an older worker cannot complete the newer lease.
 */
export async function claimQuickBooksCdcCursor(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  now?: Date;
}): Promise<QuickBooksCdcClaim | null> {
  return withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    const now = params.now ?? new Date();
    const cursor = await transaction.quickBooksCdcCursor.findFirst({
      where: {
        tenantId: params.tenantId,
        terminalAtUtc: null,
        OR: [{ nextAttemptAtUtc: null }, { nextAttemptAtUtc: { lte: now } }],
        connection: {
          status: "CONNECTED",
          deletedAtUtc: null,
          setupConfirmedAtUtc: { not: null },
          setupConfirmedByTenantUserId: { not: null },
          setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        },
      },
      select: {
        id: true,
        tenantId: true,
        changedSinceUtc: true,
        attemptCount: true,
        nextAttemptAtUtc: true,
        quickBooksConnectionId: true,
        connection: { select: { id: true, tenantId: true, realmId: true } },
      },
    });
    if (!cursor) return null;
    const claimLeaseExpiresAtUtc = new Date(
      now.getTime() + params.runtimeEnv.QUICKBOOKS_PROVIDER_TIMEOUT_MS + 30_000,
    );
    const claimed = await transaction.quickBooksCdcCursor.updateMany({
      where: {
        id: cursor.id,
        tenantId: params.tenantId,
        attemptCount: cursor.attemptCount,
        nextAttemptAtUtc: cursor.nextAttemptAtUtc,
      },
      data: {
        lastAttemptAtUtc: now,
        nextAttemptAtUtc: claimLeaseExpiresAtUtc,
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    return {
      id: cursor.id,
      tenantId: cursor.tenantId,
      changedSinceUtc: cursor.changedSinceUtc,
      quickBooksConnectionId: cursor.quickBooksConnectionId,
      connection: cursor.connection,
      claimAttemptCount: cursor.attemptCount + 1,
      claimStartedAtUtc: now,
      claimLeaseExpiresAtUtc,
    };
  });
}

function activeQuickBooksCdcClaimWhere(claim: QuickBooksCdcClaim) {
  return {
    id: claim.id,
    tenantId: claim.tenantId,
    attemptCount: claim.claimAttemptCount,
    lastAttemptAtUtc: claim.claimStartedAtUtc,
    nextAttemptAtUtc: claim.claimLeaseExpiresAtUtc,
  };
}

/** Atomically materializes CDC work and advances only the exact active lease. */
export async function completeQuickBooksCdcClaimSuccess(params: {
  prisma: PrismaClient;
  claim: QuickBooksCdcClaim;
  providerCursor: Date;
  workItems: readonly QuickBooksCdcWorkItem[];
  now?: Date;
}): Promise<boolean> {
  return withTenantRlsContext(params.prisma, params.claim.tenantId, async (transaction) => {
    const now = params.now ?? new Date();
    const completed = await transaction.quickBooksCdcCursor.updateMany({
      where: activeQuickBooksCdcClaimWhere(params.claim),
      data: {
        changedSinceUtc: new Date(params.providerCursor.getTime() - CDC_OVERLAP_MS),
        lastSucceededAtUtc: now,
        nextAttemptAtUtc: new Date(now.getTime() + CDC_INTERVAL_MS),
        attemptCount: 0,
        lastErrorCode: null,
        terminalAtUtc: null,
      },
    });
    if (completed.count !== 1) return false;

    // The cursor update and inbox inserts share this short transaction. A
    // failure rolls both back; duplicates remain safe through the event key.
    for (let offset = 0; offset < params.workItems.length; offset += CDC_INBOX_INSERT_CHUNK_SIZE) {
      await transaction.quickBooksWebhookEvent.createMany({
        data: params.workItems.slice(offset, offset + CDC_INBOX_INSERT_CHUNK_SIZE).map((item) => ({
          tenantId: params.claim.tenantId,
          quickBooksConnectionId: params.claim.quickBooksConnectionId,
          webhookEventId: item.webhookEventId,
          realmId: params.claim.connection.realmId,
          eventType: item.eventType,
          entityId: item.entityId,
          operation: item.operation,
          providerUpdatedAtUtc: item.providerUpdatedAtUtc,
          payload: item.payload,
          status: "RECEIVED" as const,
        })),
        skipDuplicates: true,
      });
    }
    return true;
  });
}

/** Records retry state only while this exact CDC lease remains active. */
export async function completeQuickBooksCdcClaimFailure(params: {
  prisma: PrismaClient;
  claim: QuickBooksCdcClaim;
  errorCode: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  return withTenantRlsContext(params.prisma, params.claim.tenantId, async (transaction) => {
    const terminal = params.claim.claimAttemptCount >= QUICKBOOKS_CDC_MAX_ATTEMPTS;
    const completed = await transaction.quickBooksCdcCursor.updateMany({
      where: activeQuickBooksCdcClaimWhere(params.claim),
      data: {
        nextAttemptAtUtc: terminal
          ? null
          : new Date(
              now.getTime()
              + Math.min(
                60 * 60 * 1000,
                30_000 * (2 ** Math.max(0, params.claim.claimAttemptCount - 1)),
              ),
            ),
        lastErrorCode: params.errorCode.slice(0, 191),
        terminalAtUtc: terminal ? now : null,
      },
    });
    return completed.count === 1;
  });
}

export async function recoverQuickBooksChanges(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  getAccessToken: (connection: QuickBooksTokenConnection) => Promise<string>;
}): Promise<{ invoicesReconciled: number; paymentsObserved: number; refundsObserved: number } | null> {
  const context = await claimQuickBooksCdcCursor({
    prisma: params.prisma,
    runtimeEnv: params.runtimeEnv,
    tenantId: params.tenantId,
  });
  if (!context) return null;

  try {
    const accessToken = await params.getAccessToken(context.connection);
    const changes = await fetchQuickBooksCdc(
      params.runtimeEnv,
      context.connection.realmId,
      accessToken,
      context.changedSinceUtc,
    );
    const now = new Date();
    const providerCursor = changes.providerTime ?? now;
    const workItems = buildQuickBooksCdcWorkItems({
      realmId: context.connection.realmId,
      invoices: changes.invoices,
      payments: changes.payments,
      refundReceipts: changes.refundReceipts,
      fallbackUpdatedAtUtc: providerCursor,
    });
    const completed = await completeQuickBooksCdcClaimSuccess({
      prisma: params.prisma,
      claim: context,
      providerCursor,
      workItems,
      now,
    });
    if (!completed) return null;
    return {
      invoicesReconciled: 0,
      paymentsObserved: changes.payments.length,
      refundsObserved: changes.refundReceipts.length,
    };
  } catch (error) {
    await completeQuickBooksCdcClaimFailure({
      prisma: params.prisma,
      claim: context,
      errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    });
    throw error;
  }
}
