import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AiUsageReservation,
  type PrismaClient,
} from "@prisma/client";
import {
  buildTenantEntitlements,
  type TenantEntitlements,
  type TenantUsagePeriod,
} from "../lib/subscription";
import { withTenantRlsContext } from "../lib/tenant-rls";

const ACTIVE_STATES = ["RESERVED", "STARTED"] as const;
// Quote drafting can make up to five sequential 90-second provider calls plus
// governed retrieval and persistence. Fifteen minutes keeps that bounded
// workflow live without leaving an abandoned hold for a full billing period.
const DEFAULT_OPERATION_TTL_MS = 15 * 60_000;
const DEFAULT_PROVIDER_TTL_MS = 2 * 60_000;

export const AI_USAGE_ERROR_CODES = {
  LIMIT_REACHED: "AI_USAGE_LIMIT_REACHED",
  IN_PROGRESS: "AI_USAGE_REQUEST_IN_PROGRESS",
  ALREADY_PROCESSED: "AI_USAGE_REQUEST_ALREADY_PROCESSED",
  ACCOUNTING_UNAVAILABLE: "AI_USAGE_ACCOUNTING_UNAVAILABLE",
} as const;

export class AiUsageLedgerError extends Error {
  constructor(
    readonly code: (typeof AI_USAGE_ERROR_CODES)[keyof typeof AI_USAGE_ERROR_CODES],
    readonly statusCode: 402 | 409 | 503,
    message: string,
    readonly renewsAtUtc?: Date,
  ) {
    super(message);
    this.name = "AiUsageLedgerError";
  }
}

type RootContext = {
  prisma: PrismaClient;
  tenantId: string;
  periodId: string;
  rootReservationId: string;
  operation: string;
  requestHash: string;
  userEmail: string | null;
  actorTenantUserId: string | null;
  providerCallSequence: number;
  providerStarted: boolean;
};

const operationContext = new AsyncLocalStorage<RootContext>();

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "bigint") return { __bigint: value.toString() };
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value instanceof Date ? value.toISOString() : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function hashAiUsageRequest(value: unknown) {
  return sha256(JSON.stringify(stableValue(value)));
}

export function hashAiIdempotencyKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  return sha256(normalized);
}

export function normalizeAiIdempotencyHeader(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 16
    && normalized.length <= 191
    && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : null;
}

export const AI_IDEMPOTENCY_COMPATIBILITY_HEADER = "X-QuoteFly-AI-Idempotency-Compatibility";

/**
 * One-release rolling-client compatibility. An absent header receives a
 * request-correlated, process-independent random key so it still traverses
 * the complete atomic ledger without promising replay deduplication. Any
 * explicitly supplied malformed value remains a hard validation failure.
 */
export function resolveAiRequestIdempotencyKey(value: unknown, requestId: string) {
  if (value !== undefined) {
    const explicit = normalizeAiIdempotencyHeader(value);
    return explicit ? { idempotencyKey: explicit, usedLegacyFallback: false as const } : null;
  }
  return {
    idempotencyKey: `legacy:${sha256(`${requestId}:${randomUUID()}`)}`,
    usedLegacyFallback: true as const,
  };
}

function usdToMicros(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid AI spend limit.");
  return BigInt(Math.round(value * 1_000_000));
}

function publicAccountingError(error: unknown): AiUsageLedgerError {
  if (error instanceof AiUsageLedgerError) return error;
  return new AiUsageLedgerError(
    AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
    503,
    "AI usage accounting is temporarily unavailable.",
  );
}

function isRetryableAccountingTransaction(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2002") return false;
  const target = JSON.stringify(error.meta?.target ?? "");
  return target.includes("periodStartUtc")
    || target.includes("idempotencyKeyHash")
    || target.includes("AiUsageReservation_tenantId_kind_idempotencyKeyHash_key");
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableAccountingTransaction(error) || attempt === 5) throw error;
      const backoffMs = 5 * (2 ** attempt) + Math.floor(Math.random() * 5);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

async function lockPeriod(tx: Prisma.TransactionClient, periodId: string, tenantId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "AiUsagePeriod"
    WHERE "id" = ${periodId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `);
  if (!rows[0]) throw new Error("AI_USAGE_PERIOD_LOCK_FAILED");
}

async function assertActiveActor(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorTenantUserId: string | null | undefined,
) {
  if (!actorTenantUserId) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "TenantUser"
    WHERE "id" = ${actorTenantUserId}
      AND "tenantId" = ${tenantId}
      AND "deletedAtUtc" IS NULL
    FOR KEY SHARE
  `);
  if (!rows[0]) throw new Error("AI_USAGE_ACTOR_NOT_ACTIVE");
}

async function reapExpiredReservations(
  tx: Prisma.TransactionClient,
  tenantId: string,
  periodId: string,
  now: Date,
) {
  const expired = await tx.aiUsageReservation.findMany({
    where: {
      tenantId,
      periodId,
      state: { in: [...ACTIVE_STATES] },
      expiresAtUtc: { lte: now },
    },
    select: {
      id: true,
      kind: true,
      state: true,
      reservedCredits: true,
      ceilingCostMicros: true,
      parentReservationId: true,
      operation: true,
      model: true,
      actorTenantUser: { select: { userId: true } },
    },
  });
  if (!expired.length) return;

  const expiredRootIds = expired
    .filter((reservation) => reservation.kind === "OPERATION")
    .map((reservation) => reservation.id);
  const rootsWithProviderStart = expiredRootIds.length
    ? new Set((await tx.aiUsageReservation.findMany({
        where: {
          tenantId,
          periodId,
          kind: "PROVIDER_CALL",
          parentReservationId: { in: expiredRootIds },
          OR: [
            { providerStartedAtUtc: { not: null } },
            { state: { in: ["SETTLED", "AMBIGUOUS_CHARGED", "EXPIRED_CHARGED", "ACCOUNTING_INCIDENT"] } },
          ],
        },
        select: { parentReservationId: true },
      })).map((row) => row.parentReservationId).filter((id): id is string => Boolean(id)))
    : new Set<string>();

  let chargedCredits = 0;
  let chargedCostMicros = 0n;
  for (const reservation of expired.sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === "PROVIDER_CALL" ? -1 : 1)) {
    const wasStarted = reservation.state === "STARTED"
      && (reservation.kind === "PROVIDER_CALL" || rootsWithProviderStart.has(reservation.id));
    if (wasStarted && reservation.kind === "OPERATION") chargedCredits += reservation.reservedCredits;
    if (wasStarted && reservation.kind === "PROVIDER_CALL") chargedCostMicros += reservation.ceilingCostMicros;
    await tx.aiUsageReservation.update({
      where: { id: reservation.id },
      data: {
        state: wasStarted ? "EXPIRED_CHARGED" : "VOIDED",
        actualCredits: reservation.kind === "OPERATION"
          ? (wasStarted ? reservation.reservedCredits : 0)
          : 0,
        actualCostMicros:
          wasStarted && reservation.kind === "PROVIDER_CALL"
            ? reservation.ceilingCostMicros
            : 0n,
        finalizedAtUtc: now,
        incidentCode: wasStarted ? "RESERVATION_EXPIRED_AFTER_START" : null,
      },
    });
  }
  const chargedRootIds = expiredRootIds.filter((id) => rootsWithProviderStart.has(id));
  const rootsToAudit = new Set([
    ...chargedRootIds,
    ...expired
      .filter((reservation) => reservation.kind === "PROVIDER_CALL" && reservation.state === "STARTED")
      .map((reservation) => reservation.parentReservationId)
      .filter((id): id is string => Boolean(id)),
  ]);
  for (const rootReservationId of rootsToAudit) {
    await ensureChargedRootAudit(tx, tenantId, rootReservationId, now);
  }
  if (chargedCredits || chargedCostMicros > 0n) {
    await tx.aiUsagePeriod.update({
      where: { id: periodId },
      data: {
        completedCredits: { increment: chargedCredits },
        completedCostMicros: { increment: chargedCostMicros },
      },
    });
  }
}

async function ensurePeriod(
  tx: Prisma.TransactionClient,
  tenantId: string,
  usagePeriod: TenantUsagePeriod,
  now: Date,
) {
  const { periodStartUtc, periodEndUtc } = usagePeriod;
  const period = await tx.aiUsagePeriod.upsert({
    where: { tenantId_periodStartUtc: { tenantId, periodStartUtc } },
    create: { tenantId, periodStartUtc, periodEndUtc },
    update: { periodEndUtc },
    select: { id: true, periodStartUtc: true, periodEndUtc: true },
  });
  const expiredPeriods = await tx.aiUsagePeriod.findMany({
    where: {
      tenantId,
      reservations: {
        some: {
          state: { in: [...ACTIVE_STATES] },
          expiresAtUtc: { lte: now },
        },
      },
    },
    select: { id: true, periodStartUtc: true },
    orderBy: [{ periodStartUtc: "asc" }, { id: "asc" }],
  });
  const periodsToLock = [
    ...expiredPeriods,
    ...(expiredPeriods.some((candidate) => candidate.id === period.id)
      ? []
      : [{ id: period.id, periodStartUtc: period.periodStartUtc }]),
  ].sort((left, right) =>
    left.periodStartUtc.getTime() - right.periodStartUtc.getTime() || left.id.localeCompare(right.id));
  for (const candidate of periodsToLock) {
    await lockPeriod(tx, candidate.id, tenantId);
    await reapExpiredReservations(tx, tenantId, candidate.id, now);
  }
  return period;
}

async function activeTotals(
  tx: Prisma.TransactionClient,
  tenantId: string,
  periodId: string,
) {
  const [roots, calls] = await Promise.all([
    tx.aiUsageReservation.aggregate({
      where: { tenantId, periodId, kind: "OPERATION", state: { in: [...ACTIVE_STATES] } },
      _sum: { reservedCredits: true },
      _count: { _all: true },
    }),
    tx.aiUsageReservation.aggregate({
      where: { tenantId, periodId, kind: "PROVIDER_CALL", state: { in: [...ACTIVE_STATES] } },
      _sum: { ceilingCostMicros: true },
      _count: { _all: true },
    }),
  ]);
  return {
    credits: roots._sum.reservedCredits ?? 0,
    costMicros: calls._sum.ceilingCostMicros ?? 0n,
    count: roots._count._all,
  };
}

async function ensureChargedRootAudit(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rootReservationId: string,
  now: Date,
) {
  const existing = await tx.aiUsageEvent.findFirst({
    where: { tenantId, rootReservationId },
    select: { id: true },
  });
  if (existing) return;

  const [root, children] = await Promise.all([
    tx.aiUsageReservation.findFirst({
      where: { id: rootReservationId, tenantId, kind: "OPERATION" },
      select: {
        operation: true,
        reservedCredits: true,
        actualCredits: true,
        actorTenantUser: { select: { userId: true } },
      },
    }),
    tx.aiUsageReservation.findMany({
      where: {
        tenantId,
        parentReservationId: rootReservationId,
        kind: "PROVIDER_CALL",
        OR: [
          { providerStartedAtUtc: { not: null } },
          { state: { in: ["SETTLED", "AMBIGUOUS_CHARGED", "EXPIRED_CHARGED", "ACCOUNTING_INCIDENT"] } },
        ],
      },
      select: { actualCostMicros: true, ceilingCostMicros: true, model: true },
    }),
  ]);
  if (!root || children.length === 0) return;

  const costMicros = children.reduce(
    (total, child) => total + (child.actualCostMicros ?? child.ceilingCostMicros),
    0n,
  );
  const models = new Set(children.flatMap((child) => child.model ? [child.model] : []));
  await tx.aiUsageEvent.createMany({
    data: [{
      tenantId,
      actorUserId: root.actorTenantUser?.userId ?? null,
      rootReservationId,
      ledgerAccountedAtUtc: now,
      eventType: "ACCOUNTING",
      classification: "C3_FINANCIAL_CONFIDENTIAL",
      creditsConsumed: root.actualCredits ?? root.reservedCredits,
      requestCount: children.length,
      estimatedCostUsd: new Prisma.Decimal((Number(costMicros) / 1_000_000).toFixed(6)),
      promptText: null,
      promptRedacted: null,
      promptHash: sha256(`charged-provider-work:${rootReservationId}`),
      model: models.size === 1 ? [...models][0] : "multiple-approved-models",
      insightReasons: [
        "provider work reached a terminal accounting state",
        `operation=${root.operation}`,
        `providerCallCount=${children.length}`,
      ],
      riskNote: "Content-free accounting audit; no prompt or provider output was retained.",
      sourceCount: 0,
    }],
    skipDuplicates: true,
  });
}

export async function loadAiUsageLedgerTotals(
  prisma: PrismaClient,
  tenantId: string,
  now = new Date(),
  options?: { userEmail?: string | null; usagePeriod?: TenantUsagePeriod },
) {
  try {
    return await withSerializableRetry(() => withTenantRlsContext(prisma, tenantId, async (tx) => {
      const usagePeriod = options?.usagePeriod
        ?? (await liveEntitlements(tx, tenantId, options?.userEmail, now)).usagePeriod;
      const period = await ensurePeriod(tx, tenantId, usagePeriod, now);
      const [periodRow, active] = await Promise.all([
        tx.aiUsagePeriod.findUniqueOrThrow({ where: { id: period.id } }),
        activeTotals(tx, tenantId, period.id),
      ]);
      return {
        periodId: period.id,
        periodSource: usagePeriod.source,
        periodStartUtc: period.periodStartUtc,
        periodEndUtc: period.periodEndUtc,
        completedCredits: periodRow.completedCredits,
        completedCostMicros: periodRow.completedCostMicros,
        reservedCredits: active.credits,
        reservedCostMicros: active.costMicros,
        activeReservationCount: active.count,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 }));
  } catch (error) {
    throw publicAccountingError(error);
  }
}

async function liveEntitlements(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userEmail: string | null | undefined,
  now: Date,
) {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId, deletedAtUtc: null },
    select: {
      subscriptionStatus: true,
      subscriptionPlanCode: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodStartUtc: true,
      subscriptionCurrentPeriodEndUtc: true,
    },
  });
  if (!tenant) throw new Error("AI_USAGE_TENANT_NOT_FOUND");
  return buildTenantEntitlements(tenant, now, { userEmail });
}

async function lockTenantBillingSnapshot(
  tx: Prisma.TransactionClient,
  tenantId: string,
) {
  // Stripe reconciliation updates this same Tenant row. FOR SHARE conflicts
  // with PostgreSQL's non-key UPDATE lock, so a root can never authorize from
  // old bounds and appear after reconciliation's incompatible-hold check.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Tenant"
    WHERE "id" = ${tenantId} AND "deletedAtUtc" IS NULL
    FOR SHARE
  `);
  if (rows.length !== 1) throw new Error("AI_USAGE_TENANT_NOT_FOUND");
}

function assertAuthoritativePaidUsagePeriod(entitlements: TenantEntitlements) {
  const source = entitlements.usagePeriod.source;
  if (
    (entitlements.accessReason === "paid" && source !== "PAID_SUBSCRIPTION")
    || (entitlements.accessReason === "trial" && source !== "ACTIVE_TRIAL")
  ) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable while billing-cycle data is reconciled.",
    );
  }
}

export async function reserveAiUsageOperation(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    userEmail?: string | null;
    actorTenantUserId?: string | null;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    credits?: number;
    allowVoidedReplay?: boolean;
    now?: Date;
    ttlMs?: number;
  },
) {
  const now = params.now ?? new Date();
  const tenantId = params.tenantId.trim();
  const operation = params.operation.trim().slice(0, 64);
  const requestHash = params.requestHash.trim().toLowerCase();
  const idempotencyKeyHash = hashAiIdempotencyKey(params.idempotencyKey);
  const credits = params.credits ?? 1;
  if (!tenantId || !operation || !/^[0-9a-f]{64}$/.test(requestHash) || credits < 0) {
    throw publicAccountingError(new Error("AI_USAGE_RESERVATION_INPUT_INVALID"));
  }

  try {
    return await withSerializableRetry(() => withTenantRlsContext(prisma, tenantId, async (tx) => {
      await lockTenantBillingSnapshot(tx, tenantId);
      const entitlements = await liveEntitlements(tx, tenantId, params.userEmail, now);
      assertAuthoritativePaidUsagePeriod(entitlements);
      const period = await ensurePeriod(tx, tenantId, entitlements.usagePeriod, now);
      const existing = await tx.aiUsageReservation.findUnique({
        where: {
          tenantId_kind_idempotencyKeyHash: {
            tenantId,
            kind: "OPERATION",
            idempotencyKeyHash,
          },
        },
      });
      if (existing) {
        if (existing.requestHash !== requestHash || existing.operation !== operation) {
          throw new AiUsageLedgerError(
            AI_USAGE_ERROR_CODES.ALREADY_PROCESSED,
            409,
            "That AI request key was already used for different input.",
          );
        }
        if (existing.state === "RESERVED" || existing.state === "STARTED") {
          throw new AiUsageLedgerError(
            AI_USAGE_ERROR_CODES.IN_PROGRESS,
            409,
            "That AI request is already in progress.",
          );
        }
        if (!(params.allowVoidedReplay && existing.state === "VOIDED")) {
          throw new AiUsageLedgerError(
            AI_USAGE_ERROR_CODES.ALREADY_PROCESSED,
            409,
            "That AI request has already been processed.",
          );
        }
      }

      const [periodRow, active] = await Promise.all([
        tx.aiUsagePeriod.findUniqueOrThrow({ where: { id: period.id } }),
        activeTotals(tx, tenantId, period.id),
      ]);
      await assertActiveActor(tx, tenantId, params.actorTenantUserId);
      const spendLimitMicros = usdToMicros(entitlements.limits.aiSpendUsdPerMonth);
      const creditLimit = entitlements.limits.aiQuotesPerMonth;
      const accessDenied = !entitlements.hasWorkspaceAccess || !entitlements.features.aiAutomation;
      const spendExhausted =
        spendLimitMicros !== null
        && periodRow.completedCostMicros + active.costMicros >= spendLimitMicros;
      const creditsExhausted =
        spendLimitMicros === null
        && creditLimit !== null
        && periodRow.completedCredits + active.credits + credits > creditLimit;
      if (accessDenied || spendExhausted || creditsExhausted) {
        throw new AiUsageLedgerError(
          AI_USAGE_ERROR_CODES.LIMIT_REACHED,
          402,
          "This workspace has reached its AI usage limit for the current billing period.",
          period.periodEndUtc,
        );
      }

      if (existing) {
        // Background index work may be retried after a pre-provider budget
        // denial. Reusing the same root is safe only when the ledger proves
        // that no provider child or linked audit was ever created. Any other
        // terminal state remains non-replayable to avoid duplicate spend.
        const [childCount, auditCount] = await Promise.all([
          tx.aiUsageReservation.count({
            where: { tenantId, parentReservationId: existing.id },
          }),
          tx.aiUsageEvent.count({
            where: { tenantId, rootReservationId: existing.id },
          }),
        ]);
        if (childCount !== 0 || auditCount !== 0 || existing.actorTenantUserId !== (params.actorTenantUserId ?? null)) {
          throw new AiUsageLedgerError(
            AI_USAGE_ERROR_CODES.ALREADY_PROCESSED,
            409,
            "That AI request has already been processed.",
          );
        }
        return tx.aiUsageReservation.update({
          where: { id: existing.id },
          data: {
            periodId: period.id,
            state: "RESERVED",
            actualCredits: null,
            actualCostMicros: null,
            finalizedAtUtc: null,
            incidentCode: null,
            expiresAtUtc: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_OPERATION_TTL_MS)),
          },
        });
      }

      return tx.aiUsageReservation.create({
        data: {
          tenantId,
          periodId: period.id,
          kind: "OPERATION",
          state: "RESERVED",
          actorTenantUserId: params.actorTenantUserId ?? null,
          operation,
          idempotencyKeyHash,
          requestHash,
          reservedCredits: credits,
          ceilingCostMicros: 0n,
          expiresAtUtc: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_OPERATION_TTL_MS)),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 }));
  } catch (error) {
    throw publicAccountingError(error);
  }
}

async function markRootStarted(prisma: PrismaClient, reservation: AiUsageReservation) {
  return withTenantRlsContext(prisma, reservation.tenantId, async (tx) => {
    await lockPeriod(tx, reservation.periodId, reservation.tenantId);
    const updated = await tx.aiUsageReservation.updateMany({
      where: {
        id: reservation.id,
        tenantId: reservation.tenantId,
        kind: "OPERATION",
        state: "RESERVED",
      },
      data: { state: "STARTED" },
    });
    if (updated.count !== 1) throw new Error("AI_USAGE_ROOT_START_FAILED");
  });
}

async function finalizeRoot(
  prisma: PrismaClient,
  context: RootContext,
  state: "SETTLED" | "VOIDED" | "AMBIGUOUS_CHARGED" | "ACCOUNTING_INCIDENT",
  incidentCode?: string,
  settledCredits?: number,
) {
  const now = new Date();
  return withTenantRlsContext(prisma, context.tenantId, async (tx) => {
    await lockPeriod(tx, context.periodId, context.tenantId);
    const reservation = await tx.aiUsageReservation.findFirst({
      where: { id: context.rootReservationId, tenantId: context.tenantId, kind: "OPERATION" },
    });
    if (!reservation) throw new Error("AI_USAGE_ROOT_NOT_FOUND");
    if (!ACTIVE_STATES.includes(reservation.state as (typeof ACTIVE_STATES)[number])) return reservation;
    const chargeCredits = state === "VOIDED"
      ? 0
      : Math.max(0, Math.min(settledCredits ?? reservation.reservedCredits, reservation.reservedCredits));
    if (chargeCredits) {
      await tx.aiUsagePeriod.update({
        where: { id: context.periodId },
        data: { completedCredits: { increment: chargeCredits } },
      });
    }
    const updated = await tx.aiUsageReservation.update({
      where: { id: reservation.id },
      data: {
        state,
        actualCredits: chargeCredits,
        actualCostMicros: 0n,
        finalizedAtUtc: now,
        incidentCode: incidentCode ?? null,
      },
    });
    if (state !== "VOIDED") {
      await ensureChargedRootAudit(tx, context.tenantId, context.rootReservationId, now);
    }
    return updated;
  });
}

export async function runWithAiUsageOperation<T>(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    userEmail?: string | null;
    actorTenantUserId?: string | null;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    credits?: number;
    allowVoidedReplay?: boolean;
    resolveSettledCredits?: (result: T) => number;
  },
  operation: () => Promise<T>,
) {
  const reservation = await reserveAiUsageOperation(prisma, params);
  try {
    await markRootStarted(prisma, reservation);
  } catch (error) {
    throw publicAccountingError(error);
  }
  const context: RootContext = {
    prisma,
    tenantId: reservation.tenantId,
    periodId: reservation.periodId,
    rootReservationId: reservation.id,
    operation: reservation.operation,
    requestHash: reservation.requestHash,
    userEmail: params.userEmail?.trim() || null,
    actorTenantUserId: params.actorTenantUserId?.trim() || null,
    providerCallSequence: 0,
    providerStarted: false,
  };
  return operationContext.run(context, async () => {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        const canVoid = !context.providerStarted;
        await finalizeRoot(
          prisma,
          context,
          canVoid ? "VOIDED" : "AMBIGUOUS_CHARGED",
          canVoid ? undefined : "OPERATION_FAILED_AFTER_START",
        );
      } catch {
        throw new AiUsageLedgerError(
          AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
          503,
          "AI usage accounting is temporarily unavailable.",
        );
      }
      throw error;
    }

    try {
      await finalizeRoot(
        prisma,
        context,
        "SETTLED",
        undefined,
        params.resolveSettledCredits?.(result),
      );
      return result;
    } catch (error) {
      // A result must not escape when its authoritative settlement failed.
      // Best-effort terminalization preserves a charge only when provider work
      // actually started; the public response remains the stable 503 either
      // way, including when the compensating write also fails.
      try {
        const canVoid = !context.providerStarted;
        await finalizeRoot(
          prisma,
          context,
          canVoid ? "VOIDED" : "AMBIGUOUS_CHARGED",
          canVoid ? undefined : "OPERATION_FAILED_AFTER_START",
        );
      } catch {}
      throw publicAccountingError(error);
    }
  });
}

export function requireAiUsageOperationContext() {
  const context = operationContext.getStore();
  if (!context) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI provider access requires an active usage reservation.",
    );
  }
  return context;
}

export function currentAiUsageRootReservation() {
  const context = operationContext.getStore();
  return context
    ? { tenantId: context.tenantId, rootReservationId: context.rootReservationId }
    : null;
}

export async function reserveAiProviderCall(params: {
  model: string;
  pricingVersion: string;
  inputRateMicrosPerM: bigint;
  outputRateMicrosPerM: bigint;
  serializedInputBytes: number;
  maxOutputTokens: number;
  ceilingCostMicros: bigint;
}) {
  const context = requireAiUsageOperationContext();
  const now = new Date();
  context.providerCallSequence += 1;
  const requestHash = hashAiUsageRequest(params);
  const idempotencyKeyHash = sha256(
    `${context.rootReservationId}:provider:${context.providerCallSequence}:${requestHash}`,
  );
  try {
    return await withSerializableRetry(() => withTenantRlsContext(context.prisma, context.tenantId, async (tx) => {
      await lockPeriod(tx, context.periodId, context.tenantId);
      await reapExpiredReservations(tx, context.tenantId, context.periodId, now);
      const period = await tx.aiUsagePeriod.findFirst({
        where: { id: context.periodId, tenantId: context.tenantId },
        select: { id: true, periodEndUtc: true },
      });
      if (!period) throw new Error("AI_USAGE_PERIOD_NOT_FOUND");
      const root = await tx.aiUsageReservation.findFirst({
        where: {
          id: context.rootReservationId,
          tenantId: context.tenantId,
          kind: "OPERATION",
          state: "STARTED",
          expiresAtUtc: { gt: now },
        },
      });
      if (!root) throw new Error("AI_USAGE_ROOT_NOT_ACTIVE");
      await assertActiveActor(tx, context.tenantId, context.actorTenantUserId);
      const [entitlements, periodRow, active] = await Promise.all([
        liveEntitlements(tx, context.tenantId, context.userEmail, now),
        tx.aiUsagePeriod.findUniqueOrThrow({ where: { id: period.id } }),
        activeTotals(tx, context.tenantId, period.id),
      ]);
      assertAuthoritativePaidUsagePeriod(entitlements);
      const spendLimitMicros = usdToMicros(entitlements.limits.aiSpendUsdPerMonth);
      if (
        !entitlements.hasWorkspaceAccess
        || !entitlements.features.aiAutomation
        || (spendLimitMicros !== null
          && periodRow.completedCostMicros + active.costMicros + params.ceilingCostMicros > spendLimitMicros)
      ) {
        throw new AiUsageLedgerError(
          AI_USAGE_ERROR_CODES.LIMIT_REACHED,
          402,
          "This workspace has reached its AI usage limit for the current billing period.",
          period.periodEndUtc,
        );
      }
      return tx.aiUsageReservation.create({
        data: {
          tenantId: context.tenantId,
          periodId: period.id,
          parentReservationId: context.rootReservationId,
          actorTenantUserId: context.actorTenantUserId,
          kind: "PROVIDER_CALL",
          state: "RESERVED",
          operation: context.operation,
          model: params.model,
          pricingVersion: params.pricingVersion,
          inputRateMicrosPerM: params.inputRateMicrosPerM,
          outputRateMicrosPerM: params.outputRateMicrosPerM,
          idempotencyKeyHash,
          requestHash,
          reservedCredits: 0,
          ceilingCostMicros: params.ceilingCostMicros,
          serializedInputBytes: params.serializedInputBytes,
          maxOutputTokens: params.maxOutputTokens,
          expiresAtUtc: new Date(now.getTime() + DEFAULT_PROVIDER_TTL_MS),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 }));
  } catch (error) {
    throw publicAccountingError(error);
  }
}

export async function markAiProviderCallStarted(reservation: AiUsageReservation) {
  const context = requireAiUsageOperationContext();
  const now = new Date();
  try {
    await withTenantRlsContext(context.prisma, context.tenantId, async (tx) => {
      await lockPeriod(tx, context.periodId, context.tenantId);
      const changed = await tx.aiUsageReservation.updateMany({
        where: {
          id: reservation.id,
          tenantId: context.tenantId,
          parentReservationId: context.rootReservationId,
          kind: "PROVIDER_CALL",
          state: "RESERVED",
          expiresAtUtc: { gt: now },
        },
        data: { state: "STARTED", providerStartedAtUtc: now },
      });
      if (changed.count !== 1) throw new Error("AI_PROVIDER_RESERVATION_START_FAILED");
    });
    context.providerStarted = true;
  } catch (error) {
    throw publicAccountingError(error);
  }
}

export async function finalizeAiProviderCall(
  reservation: AiUsageReservation,
  params:
    | { outcome: "SUCCESS"; actualCostMicros: bigint }
    | { outcome: "AMBIGUOUS"; incidentCode: string }
    | { outcome: "VOID" },
) {
  const context = requireAiUsageOperationContext();
  const now = new Date();
  try {
    const result = await withTenantRlsContext(context.prisma, context.tenantId, async (tx) => {
      await lockPeriod(tx, context.periodId, context.tenantId);
      const current = await tx.aiUsageReservation.findFirst({
        where: { id: reservation.id, tenantId: context.tenantId, parentReservationId: context.rootReservationId },
      });
      if (!current) throw new Error("AI_PROVIDER_RESERVATION_NOT_FOUND");
      if (!ACTIVE_STATES.includes(current.state as (typeof ACTIVE_STATES)[number])) return current;

      let state: "SETTLED" | "VOIDED" | "AMBIGUOUS_CHARGED" | "ACCOUNTING_INCIDENT";
      let cost = 0n;
      let incidentCode: string | null = null;
      if (params.outcome === "VOID" && current.state === "RESERVED") {
        state = "VOIDED";
      } else if (params.outcome === "SUCCESS") {
        cost = params.actualCostMicros;
        if (cost > current.ceilingCostMicros) {
          state = "ACCOUNTING_INCIDENT";
          incidentCode = "PROVIDER_COST_EXCEEDED_CEILING";
        } else {
          state = "SETTLED";
        }
      } else {
        state = "AMBIGUOUS_CHARGED";
        cost = current.ceilingCostMicros;
        incidentCode = params.outcome === "AMBIGUOUS" ? params.incidentCode : "PROVIDER_START_STATE_INVALID";
      }
      if (state !== "VOIDED") {
        await tx.aiUsagePeriod.update({
          where: { id: context.periodId },
          data: { completedCostMicros: { increment: cost } },
        });
      }
      const updated = await tx.aiUsageReservation.update({
        where: { id: current.id },
        data: {
          state,
          actualCostMicros: cost,
          finalizedAtUtc: now,
          incidentCode,
        },
      });
      return updated;
    });
    if (result.state === "ACCOUNTING_INCIDENT") {
      throw new AiUsageLedgerError(
        AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
        503,
        "AI usage accounting is temporarily unavailable.",
      );
    }
    return result;
  } catch (error) {
    throw publicAccountingError(error);
  }
}

export function aiUsageLedgerErrorResponse(error: AiUsageLedgerError) {
  return {
    code: error.code,
    error: error.message,
    ...(error.renewsAtUtc ? { renewsAtUtc: error.renewsAtUtc } : {}),
  };
}
