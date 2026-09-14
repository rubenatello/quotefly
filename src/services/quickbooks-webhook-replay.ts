import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { isQuickBooksConfigured, isQuickBooksWebhookConfigured } from "./quickbooks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";

export const QUICKBOOKS_REPLAY_REASONS = ["PROVIDER_RECOVERED", "CONNECTION_REAUTHORIZED", "MAPPING_CORRECTED"] as const;
type ReplayReason = typeof QUICKBOOKS_REPLAY_REASONS[number];
type Env = typeof env;
type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
export class QuickBooksReplayError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

// Explicit allowlists prevent provider error text/identifiers entering operational output.
const failureCodes = new Set([
  "QUICKBOOKS_WEBHOOK_INVOICE_FAILURES", "QUICKBOOKS_WORKER_FAILURE", "QUICKBOOKS_TEMPORARY",
  "QUICKBOOKS_INVOICE_INVALID", "QUICKBOOKS_REAUTH_REQUIRED", "QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED",
  "QUICKBOOKS_INVOICE_DELETED_REVIEW_REQUIRED", "QUICKBOOKS_REFUND_RECEIPT_DELETED_REVIEW_REQUIRED",
]);
function safeFailure(value: string | null) { return value && failureCodes.has(value) ? value : "QUICKBOOKS_REVIEW_REQUIRED"; }
function supported(event: { eventType: string; operation: string | null; entityId: string | null }) {
  if (!event.entityId) return false;
  const operations = event.eventType === "Invoice" ? ["Create", "Update", "Void"]
    : event.eventType === "Payment" ? ["Create", "Update", "Void", "Delete"]
    : event.eventType === "RefundReceipt" ? ["Create", "Update"] : [];
  return operations.includes(event.operation ?? "");
}
export function quickBooksReplayEnabled(env: Env) {
  return env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED && !env.QUICKBOOKS_OAUTH_ONLY_MODE
    && env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED && isQuickBooksConfigured(env) && isQuickBooksWebhookConfigured(env);
}
async function lockManager(tx: Prisma.TransactionClient, actor: Actor) {
  // Lock the parent before actor rows, including before their later audit FKs.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR UPDATE`);
  const rows = await tx.$queryRaw<Array<{ id: string; role: string; authVersion: number }>>(Prisma.sql`
    SELECT membership."id", membership."role", account."authVersion"
    FROM "TenantUser" membership JOIN "User" account ON account."id" = membership."userId"
    JOIN "Tenant" tenant ON tenant."id" = membership."tenantId"
    WHERE membership."tenantId" = ${actor.tenantId} AND membership."userId" = ${actor.userId}
      AND membership."deletedAtUtc" IS NULL AND account."deletedAtUtc" IS NULL AND tenant."deletedAtUtc" IS NULL
    FOR UPDATE OF membership, account, tenant
  `);
  const manager = rows[0];
  if (!manager || !["owner", "admin"].includes(manager.role) || manager.authVersion !== actor.authVersion) {
    throw new QuickBooksReplayError(403, "QUICKBOOKS_MANAGER_REQUIRED", "Only current owners or admins can manage QuickBooks recovery.");
  }
  return manager.id;
}

function encodeRecoveryCursor(event: { id: string; deadAtUtc: Date | null }): string {
  return Buffer.from(JSON.stringify({ id: event.id, at: event.deadAtUtc?.toISOString() ?? null }), "utf8").toString("base64url");
}

function decodeRecoveryCursor(cursor: string): { id: string; at: string | null } {
  try {
    if (cursor.length > 512) throw new Error("Invalid cursor");
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(json) as unknown;
    if (Buffer.from(json, "utf8").toString("base64url") !== cursor || !value || typeof value !== "object"
      || !("id" in value) || typeof value.id !== "string" || !value.id || value.id.length > 191
      || !("at" in value) || (value.at !== null && (typeof value.at !== "string" || value.at.length > 32))) throw new Error("Invalid cursor");
    return { id: value.id, at: value.at };
  } catch {
    throw new QuickBooksReplayError(400, "QUICKBOOKS_RECOVERY_CURSOR_INVALID", "Refresh recovery events to continue.");
  }
}

export async function listQuickBooksDeadLetters(prisma: PrismaClient, actor: Actor, env: Env, limit: number, cursor?: string) {
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    await lockManager(tx, actor);
    const baseWhere: Prisma.QuickBooksWebhookEventWhereInput = { tenantId: actor.tenantId, status: "DEAD" };
    let seek: Prisma.QuickBooksWebhookEventWhereInput = {};
    if (cursor) {
      // The anchor must still belong to this tenant's recovery queue. Missing,
      // foreign, replayed and expired anchors have the same safe response.
      const decoded = decodeRecoveryCursor(cursor);
      const anchor = await tx.quickBooksWebhookEvent.findFirst({
        where: { ...baseWhere, id: decoded.id }, select: { id: true, deadAtUtc: true },
      });
      if (!anchor || (anchor.deadAtUtc?.toISOString() ?? null) !== decoded.at) {
        throw new QuickBooksReplayError(400, "QUICKBOOKS_RECOVERY_CURSOR_INVALID", "Refresh recovery events to continue.");
      }
      seek = anchor.deadAtUtc ? { OR: [
        { deadAtUtc: { lt: anchor.deadAtUtc } },
        { deadAtUtc: anchor.deadAtUtc, id: { lt: anchor.id } },
        { deadAtUtc: null },
      ] } : { deadAtUtc: null, id: { lt: anchor.id } };
    }
    const pageSize = Math.min(50, Math.max(1, limit));
    const rows = await tx.quickBooksWebhookEvent.findMany({
      where: { ...baseWhere, ...seek }, take: pageSize + 1,
      orderBy: [{ deadAtUtc: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      select: { id: true, eventType: true, operation: true, entityId: true, status: true, lastError: true,
        attemptCount: true, receivedAtUtc: true, deadAtUtc: true },
    });
    const events = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    const last = events.at(-1);
    const total = await tx.quickBooksWebhookEvent.count({ where: baseWhere });
    return { replayEnabled: quickBooksReplayEnabled(env), reasons: QUICKBOOKS_REPLAY_REASONS, total, hasMore,
      nextCursor: hasMore && last ? encodeRecoveryCursor(last) : null,
      events: events.map((event) => ({ id: event.id,
        type: ["Invoice", "Payment", "RefundReceipt"].includes(event.eventType) ? event.eventType : "Unsupported",
        state: event.status, reason: safeFailure(event.lastError), attempts: event.attemptCount,
        receivedAtUtc: event.receivedAtUtc, deadAtUtc: event.deadAtUtc, replaySupported: supported(event) })) };
  });
}

export async function replayQuickBooksDeadLetter(prisma: PrismaClient, actor: Actor, env: Env,
  input: { eventId: string; reason: ReplayReason; idempotencyKey: string }) {
  const commandHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const actorTenantUserId = await lockManager(tx, actor);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qbo-replay:${actor.tenantId}:${commandHash}`}, 0))::text`);
    const previous = await tx.quickBooksWebhookReplay.findUnique({ where: { tenantId_commandHash: { tenantId: actor.tenantId, commandHash } } });
    if (previous) {
      if (previous.eventId !== input.eventId || previous.reason !== input.reason) {
        throw new QuickBooksReplayError(409, "QUICKBOOKS_REPLAY_KEY_CONFLICT", "Use a new idempotency key for a different recovery request.");
      }
      return { replayId: previous.id, eventId: previous.eventId, outcome: "QUEUED" as const, requestedAtUtc: previous.createdAtUtc };
    }
    if (!quickBooksReplayEnabled(env)) throw new QuickBooksReplayError(503, "QUICKBOOKS_REPLAY_DISABLED", "QuickBooks reconciliation must be enabled before recovery.");
    // Lock the connection before the event, matching provider lifecycle serialization.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "tenantId" = ${actor.tenantId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksWebhookEvent" WHERE "id" = ${input.eventId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`);
    const event = await tx.quickBooksWebhookEvent.findFirst({ where: { id: input.eventId, tenantId: actor.tenantId } });
    if (!event) throw new QuickBooksReplayError(404, "QUICKBOOKS_EVENT_NOT_FOUND", "Recovery event was not found.");
    if (event.status !== "DEAD" || !supported(event)) throw new QuickBooksReplayError(409, "QUICKBOOKS_EVENT_NOT_REPLAYABLE", "This event requires manual review or has already been queued.");
    const connection = await tx.quickBooksConnection.findFirst({ where: {
      tenantId: actor.tenantId, id: event.quickBooksConnectionId ?? "", realmId: event.realmId,
      status: "CONNECTED", deletedAtUtc: null, disconnectRequestedAtUtc: null, environment: env.QUICKBOOKS_ENVIRONMENT,
      setupConfirmedAtUtc: { not: null }, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      realmBinding: { is: { tenantId: actor.tenantId, realmId: event.realmId, active: true } },
    }, select: { id: true } });
    if (!connection) throw new QuickBooksReplayError(409, "QUICKBOOKS_CONNECTION_REVIEW_REQUIRED", "Confirm the active QuickBooks connection and setup before recovery.");
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new QuickBooksReplayError(409, "QUICKBOOKS_EVENT_NOT_REPLAYABLE", "This event requires manual review.");
    }
    const payload = { ...event.payload } as Prisma.JsonObject;
    for (const key of ["quoteflyPendingInvoiceIds", "quoteflyPendingProviderInvoiceIds", "quoteflyInvoiceRetryCounts", "quoteflyInvoiceTerminalFailures"]) delete payload[key];
    const audit = await tx.quickBooksWebhookReplay.create({ data: {
      tenantId: actor.tenantId, actorTenantUserId, eventId: event.id, reason: input.reason,
      priorFailureCode: safeFailure(event.lastError), priorAttemptCount: event.attemptCount, commandHash,
    } });
    await tx.quickBooksWebhookEvent.update({ where: { id: event.id }, data: {
      status: "RECEIVED", attemptCount: 0, nextAttemptAtUtc: null, claimTokenHash: null,
      claimExpiresAtUtc: null, processedAtUtc: null, deadAtUtc: null, lastError: null, payload,
    } });
    return { replayId: audit.id, eventId: audit.eventId, outcome: "QUEUED" as const, requestedAtUtc: audit.createdAtUtc };
  });
}
