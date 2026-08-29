import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenantRlsContext, type TenantRlsClient } from "../lib/tenant-rls";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import {
  QUICKBOOKS_RETENTION_BATCH_SIZE,
  QUICKBOOKS_UNKNOWN_REALM_QUARANTINE_RETENTION_DAYS,
} from "./quickbooks-retention";

const WEBHOOK_CLAIM_TTL_MS = 2 * 60 * 1000;
const WEBHOOK_MAX_ATTEMPTS = 8;

function subtractUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

export type QuickBooksWebhookEntityNotification = Readonly<{
  providerEventId?: string;
  providerEventSource?: string;
  realmId: string;
  name: string;
  id: string;
  operation: string;
  lastUpdated: string;
  supported?: boolean;
}>;

const QUICKBOOKS_UNSUPPORTED_WEBHOOK_OPERATION = "QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED";

function quickBooksWebhookSupported(notification: QuickBooksWebhookEntityNotification): boolean {
  return notification.supported !== false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function quickBooksWebhookEventId(notification: QuickBooksWebhookEntityNotification): string {
  if (notification.providerEventId) {
    return sha256(JSON.stringify({
      realmId: notification.realmId,
      providerEventSource: notification.providerEventSource ?? "",
      providerEventId: notification.providerEventId,
    }));
  }
  return sha256(JSON.stringify({
    realmId: notification.realmId,
    entity: notification.name,
    id: notification.id,
    operation: notification.operation,
    lastUpdated: notification.lastUpdated,
  }));
}

export async function resolveQuickBooksWebhookRealm(
  prisma: PrismaClient,
  realmId: string,
): Promise<{ tenantId: string; quickBooksConnectionId: string } | null> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT set_config('app.quickbooks_webhook_realm_id', ${realmId}, true)
    `);
    return transaction.quickBooksRealmBinding.findFirst({
      where: { realmId, active: true },
      select: { tenantId: true, quickBooksConnectionId: true },
    });
  }, { maxWait: 5_000, timeout: 10_000 });
}

async function setQuickBooksWebhookIngressContext(
  transaction: Prisma.TransactionClient,
  realmId: string,
  eventId?: string,
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT
      set_config('app.quickbooks_webhook_realm_id', ${realmId}, true),
      set_config('app.quickbooks_webhook_event_id', ${eventId ?? ""}, true)
  `);
}

async function cleanupExpiredUnknownQuickBooksWebhookQuarantine(
  transaction: Prisma.TransactionClient,
  realmId: string,
): Promise<number> {
  const cutoffAtUtc = subtractUtcDays(new Date(), QUICKBOOKS_UNKNOWN_REALM_QUARANTINE_RETENTION_DAYS);
  await transaction.$queryRaw(Prisma.sql`
    SELECT set_config('app.quickbooks_webhook_quarantine_retention', '1', true)
  `);
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id"
      FROM "QuickBooksWebhookEvent"
      WHERE "tenantId" IS NULL
        AND "quickBooksConnectionId" IS NULL
        AND "realmId" = ${realmId}
        AND "status" = 'RECEIVED'
        AND "lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
        AND "receivedAtUtc" <= ${cutoffAtUtc}
      ORDER BY "receivedAtUtc" ASC, "id" ASC
      LIMIT ${QUICKBOOKS_RETENTION_BATCH_SIZE}
    )
    DELETE FROM "QuickBooksWebhookEvent" event
    USING candidates
    WHERE event."id" = candidates."id"
      AND event."tenantId" IS NULL
      AND event."quickBooksConnectionId" IS NULL
      AND event."realmId" = ${realmId}
      AND event."status" = 'RECEIVED'
      AND event."lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
    RETURNING event."id"
  `);
  return rows.length;
}

export async function adoptQuickBooksWebhookQuarantine(
  client: TenantRlsClient,
  binding: { tenantId: string; quickBooksConnectionId: string; realmId: string },
): Promise<number> {
  return withTenantRlsContext(client, binding.tenantId, async (transaction) => {
    await setQuickBooksWebhookIngressContext(transaction, binding.realmId);
    const adopted = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        tenantId: null,
        quickBooksConnectionId: null,
        realmId: binding.realmId,
        status: "RECEIVED",
        lastError: "QUICKBOOKS_REALM_UNBOUND",
      },
      data: {
        tenantId: binding.tenantId,
        quickBooksConnectionId: binding.quickBooksConnectionId,
        lastError: null,
      },
    });
    const terminal = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        tenantId: null,
        quickBooksConnectionId: null,
        realmId: binding.realmId,
        status: "RECEIVED",
        lastError: QUICKBOOKS_UNSUPPORTED_WEBHOOK_OPERATION,
      },
      data: {
        tenantId: binding.tenantId,
        quickBooksConnectionId: binding.quickBooksConnectionId,
        status: "DEAD",
        deadAtUtc: new Date(),
      },
    });
    return adopted.count + terminal.count;
  });
}

async function quarantineUnknownQuickBooksWebhooks(
  prisma: PrismaClient,
  notifications: readonly QuickBooksWebhookEntityNotification[],
): Promise<{ persisted: number; duplicate: number }> {
  return prisma.$transaction(async (transaction) => {
    let persisted = 0;
    let duplicate = 0;
    const realmId = notifications[0]?.realmId;
    if (!realmId || notifications.some((notification) => notification.realmId !== realmId)) {
      throw new Error("QuickBooks quarantine requires one realm per transaction.");
    }
    await setQuickBooksWebhookIngressContext(transaction, realmId);
    await cleanupExpiredUnknownQuickBooksWebhookQuarantine(transaction, realmId);
    for (const notification of notifications) {
      const eventId = quickBooksWebhookEventId(notification);
      await setQuickBooksWebhookIngressContext(transaction, notification.realmId, eventId);
      const created = await transaction.quickBooksWebhookEvent.createMany({
        data: [{
          tenantId: null,
          quickBooksConnectionId: null,
          webhookEventId: eventId,
          realmId: notification.realmId,
          eventType: notification.name,
          entityId: notification.id,
          operation: notification.operation,
          providerUpdatedAtUtc: new Date(notification.lastUpdated),
          // Never retain the raw webhook or provider entity content before a
          // realm is bound. These provider identifiers are the minimum replay
          // envelope needed to adopt and reconcile the event later.
          payload: { quarantined: true },
          status: "RECEIVED",
          lastError: quickBooksWebhookSupported(notification)
            ? "QUICKBOOKS_REALM_UNBOUND"
            : QUICKBOOKS_UNSUPPORTED_WEBHOOK_OPERATION,
        }],
        skipDuplicates: true,
      });
      if (created.count === 1) persisted += 1;
      else duplicate += 1;
    }
    return { persisted, duplicate };
  }, { maxWait: 5_000, timeout: 10_000 });
}

export async function persistQuickBooksWebhookNotifications(
  prisma: PrismaClient,
  notifications: readonly QuickBooksWebhookEntityNotification[],
): Promise<{ persisted: number; duplicate: number; unknownRealm: number }> {
  let persisted = 0;
  let duplicate = 0;
  let unknownRealm = 0;
  const notificationsByRealm = new Map<string, QuickBooksWebhookEntityNotification[]>();
  for (const notification of notifications) {
    const realmNotifications = notificationsByRealm.get(notification.realmId) ?? [];
    realmNotifications.push(notification);
    notificationsByRealm.set(notification.realmId, realmNotifications);
  }
  for (const [realmId, realmNotifications] of notificationsByRealm) {
    const binding = await resolveQuickBooksWebhookRealm(prisma, realmId);
    if (!binding) {
      unknownRealm += realmNotifications.length;
      const quarantined = await quarantineUnknownQuickBooksWebhooks(prisma, realmNotifications);
      persisted += quarantined.persisted;
      duplicate += quarantined.duplicate;
      continue;
    }
    const realmResult = await withTenantRlsContext(prisma, binding.tenantId, async (transaction) => {
      const notificationRows = realmNotifications.map((notification) => ({
        notification,
        eventId: quickBooksWebhookEventId(notification),
      }));
      const supportedEventIds = [...new Set(notificationRows
        .filter(({ notification }) => quickBooksWebhookSupported(notification))
        .map(({ eventId }) => eventId))];
      const unsupportedEventIds = [...new Set(notificationRows
        .filter(({ notification }) => !quickBooksWebhookSupported(notification))
        .map(({ eventId }) => eventId))];
      await setQuickBooksWebhookIngressContext(transaction, realmId);
      // Adopt and insert the whole bound-realm batch set-wise. The previous
      // per-event loop performed two or three sequential SQL statements for
      // every notification and could exceed Intuit's acknowledgement window
      // on a valid large delivery.
      const adopted = await transaction.quickBooksWebhookEvent.updateMany({
        where: {
          tenantId: null,
          quickBooksConnectionId: null,
          webhookEventId: { in: supportedEventIds },
          realmId,
          status: "RECEIVED",
          lastError: "QUICKBOOKS_REALM_UNBOUND",
        },
        data: {
          tenantId: binding.tenantId,
          quickBooksConnectionId: binding.quickBooksConnectionId,
          lastError: null,
        },
      });
      const terminalAtUtc = new Date();
      const adoptedUnsupported = unsupportedEventIds.length === 0
        ? { count: 0 }
        : await transaction.quickBooksWebhookEvent.updateMany({
            where: {
              tenantId: null,
              quickBooksConnectionId: null,
              webhookEventId: { in: unsupportedEventIds },
              realmId,
              status: "RECEIVED",
              lastError: QUICKBOOKS_UNSUPPORTED_WEBHOOK_OPERATION,
            },
            data: {
              tenantId: binding.tenantId,
              quickBooksConnectionId: binding.quickBooksConnectionId,
              status: "DEAD",
              deadAtUtc: terminalAtUtc,
            },
          });
      const created = await transaction.quickBooksWebhookEvent.createMany({
        data: notificationRows.map(({ notification, eventId }) => ({
            tenantId: binding.tenantId,
            quickBooksConnectionId: binding.quickBooksConnectionId,
            webhookEventId: eventId,
            realmId: notification.realmId,
            eventType: notification.name,
            entityId: notification.id,
            operation: notification.operation,
            providerUpdatedAtUtc: new Date(notification.lastUpdated),
            payload: {
              name: notification.name,
              id: notification.id,
              operation: notification.operation,
              lastUpdated: notification.lastUpdated,
            },
            status: quickBooksWebhookSupported(notification) ? "RECEIVED" : "DEAD",
            deadAtUtc: quickBooksWebhookSupported(notification) ? null : terminalAtUtc,
            lastError: quickBooksWebhookSupported(notification)
              ? null
              : QUICKBOOKS_UNSUPPORTED_WEBHOOK_OPERATION,
          })),
        skipDuplicates: true,
      });
      await transaction.quickBooksConnection.updateMany({
        where: { id: binding.quickBooksConnectionId, tenantId: binding.tenantId, deletedAtUtc: null },
        data: { lastWebhookAtUtc: new Date() },
      });
      const realmPersisted = adopted.count + adoptedUnsupported.count + created.count;
      return {
        persisted: realmPersisted,
        duplicate: Math.max(0, realmNotifications.length - realmPersisted),
      };
    }, { maxWait: 5_000, timeout: 10_000 });
    persisted += realmResult.persisted;
    duplicate += realmResult.duplicate;
  }
  return { persisted, duplicate, unknownRealm };
}

export type QuickBooksWebhookClaim = Readonly<{
  id: string;
  tenantId: string;
  quickBooksConnectionId: string;
  realmId: string;
  eventType: string;
  entityId: string;
  operation: string | null;
  attemptCount: number;
  claimToken: string;
}>;

export async function claimQuickBooksWebhookEvent(
  prisma: PrismaClient,
  tenantId: string,
): Promise<QuickBooksWebhookClaim | null> {
  return withTenantRlsContext(prisma, tenantId, async (transaction) => {
    const now = new Date();
    const candidate = await transaction.quickBooksWebhookEvent.findFirst({
      where: {
        tenantId,
        quickBooksConnectionId: { not: null },
        entityId: { not: null },
        connection: {
          status: "CONNECTED",
          deletedAtUtc: null,
          setupConfirmedAtUtc: { not: null },
          setupConfirmedByTenantUserId: { not: null },
          setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        },
        OR: [
          { status: "RECEIVED" },
          { status: "FAILED", nextAttemptAtUtc: { lte: now } },
          { status: "PROCESSING", claimExpiresAtUtc: { lte: now } },
        ],
      },
      orderBy: [{ receivedAtUtc: "asc" }, { id: "asc" }],
      select: {
        id: true,
        quickBooksConnectionId: true,
        realmId: true,
        eventType: true,
        entityId: true,
        operation: true,
        attemptCount: true,
      },
    });
    if (!candidate?.quickBooksConnectionId || !candidate.entityId) return null;
    const claimToken = randomBytes(32).toString("hex");
    const claimed = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        id: candidate.id,
        tenantId,
        OR: [
          { status: "RECEIVED" },
          { status: "FAILED", nextAttemptAtUtc: { lte: now } },
          { status: "PROCESSING", claimExpiresAtUtc: { lte: now } },
        ],
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        claimTokenHash: sha256(claimToken),
        claimExpiresAtUtc: new Date(now.getTime() + WEBHOOK_CLAIM_TTL_MS),
        nextAttemptAtUtc: null,
        lastError: null,
      },
    });
    if (claimed.count !== 1) return null;
    return {
      ...candidate,
      tenantId,
      quickBooksConnectionId: candidate.quickBooksConnectionId,
      entityId: candidate.entityId,
      attemptCount: candidate.attemptCount + 1,
      claimToken,
    };
  }, { maxWait: 5_000, timeout: 10_000 });
}

export async function completeQuickBooksWebhookEvent(
  prisma: PrismaClient,
  claim: QuickBooksWebhookClaim,
): Promise<boolean> {
  return withTenantRlsContext(prisma, claim.tenantId, async (transaction) => {
    const result = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        id: claim.id,
        tenantId: claim.tenantId,
        status: "PROCESSING",
        claimTokenHash: sha256(claim.claimToken),
      },
      data: {
        status: "PROCESSED",
        processedAtUtc: new Date(),
        claimTokenHash: null,
        claimExpiresAtUtc: null,
        nextAttemptAtUtc: null,
        lastError: null,
      },
    });
    return result.count === 1;
  });
}

export async function failQuickBooksWebhookEvent(
  prisma: PrismaClient,
  claim: QuickBooksWebhookClaim,
  failureCode: string,
  options: { retryable?: boolean } = {},
): Promise<"FAILED" | "DEAD" | "STALE"> {
  return withTenantRlsContext(prisma, claim.tenantId, async (transaction) => {
    const dead = options.retryable === false || claim.attemptCount >= WEBHOOK_MAX_ATTEMPTS;
    const now = new Date();
    const result = await transaction.quickBooksWebhookEvent.updateMany({
      where: {
        id: claim.id,
        tenantId: claim.tenantId,
        status: "PROCESSING",
        claimTokenHash: sha256(claim.claimToken),
      },
      data: {
        status: dead ? "DEAD" : "FAILED",
        claimTokenHash: null,
        claimExpiresAtUtc: null,
        nextAttemptAtUtc: dead
          ? null
          : new Date(now.getTime() + Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.max(0, claim.attemptCount - 1)))),
        deadAtUtc: dead ? now : null,
        lastError: failureCode.slice(0, 191),
      },
    });
    if (result.count !== 1) return "STALE";
    return dead ? "DEAD" : "FAILED";
  });
}
