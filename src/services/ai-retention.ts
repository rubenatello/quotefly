import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenantRlsContext } from "../lib/tenant-rls";

export const DEFAULT_AI_FEEDBACK_RETENTION_DAYS = 180;
export const AI_RETENTION_BATCH_SIZE = 250;
export const AI_RETENTION_MAX_ROWS_PER_TENANT = 5_000;
export const AI_RETENTION_APPLY_CONFIRMATION = "MINIMIZE_EXPIRED_AI_DATA";

const MIN_FEEDBACK_RETENTION_DAYS = 90;

type RetentionCategory =
  | "EXPIRED_USAGE_TRACE"
  | "HISTORICAL_RAW_PROMPT"
  | "EXPIRED_RETRIEVAL_AUDIT"
  | "EXPIRED_FEEDBACK";

const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  "EXPIRED_USAGE_TRACE",
  "HISTORICAL_RAW_PROMPT",
  "EXPIRED_RETRIEVAL_AUDIT",
  "EXPIRED_FEEDBACK",
];

export type AiRetentionPolicy = Readonly<{
  feedbackDays: number;
}>;

export type AiRetentionResult = Readonly<{
  lockSkipped: boolean;
  hasMore: boolean;
  eligibleExpiredUsageTraceCount: number;
  eligibleHistoricalRawPromptCount: number;
  eligibleExpiredRetrievalAuditCount: number;
  eligibleExpiredFeedbackCount: number;
  minimizedExpiredUsageTraceCount: number;
  minimizedHistoricalRawPromptCount: number;
  archivedExpiredRetrievalAuditCount: number;
  archivedExpiredFeedbackCount: number;
}>;

type CategoryCounts = Record<RetentionCategory, number>;

function emptyCounts(): CategoryCounts {
  return {
    EXPIRED_USAGE_TRACE: 0,
    HISTORICAL_RAW_PROMPT: 0,
    EXPIRED_RETRIEVAL_AUDIT: 0,
    EXPIRED_FEEDBACK: 0,
  };
}

function subtractUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

function retentionLockKey(tenantId: string): string {
  return `${tenantId}:ai-retention`;
}

function normalizeMaxRows(maxRows: number | undefined): number {
  const normalized = Math.trunc(maxRows ?? AI_RETENTION_MAX_ROWS_PER_TENANT);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("AI retention maxRows must be a positive integer.");
  }
  return Math.min(normalized, AI_RETENTION_MAX_ROWS_PER_TENANT);
}

export function validateAiRetentionPolicy(policy: AiRetentionPolicy): AiRetentionPolicy {
  if (!Number.isInteger(policy.feedbackDays) || policy.feedbackDays < MIN_FEEDBACK_RETENTION_DAYS) {
    throw new Error(`AI feedback retention must be at least ${MIN_FEEDBACK_RETENTION_DAYS} days.`);
  }
  return Object.freeze({ ...policy });
}

export function validateAiRetentionApplyAuthorization(
  apply: boolean,
  confirmation: string | undefined,
) {
  if (apply && confirmation !== AI_RETENTION_APPLY_CONFIRMATION) {
    throw new Error(`Apply requires --confirm=${AI_RETENTION_APPLY_CONFIRMATION}.`);
  }
}

function categoryPredicate(params: Readonly<{
  category: RetentionCategory;
  tenantId: string;
  now: Date;
  feedbackCutoffAtUtc: Date;
}>): Prisma.Sql {
  switch (params.category) {
    case "EXPIRED_USAGE_TRACE":
      return Prisma.sql`
        "tenantId" = ${params.tenantId}
        AND "retentionExpiresAtUtc" IS NOT NULL
        AND "retentionExpiresAtUtc" <= ${params.now}
        AND (
          "promptText" IS NOT NULL
          OR "promptRedacted" IS NOT NULL
          OR "actorEmail" IS NOT NULL
          OR "actorName" IS NOT NULL
          OR "insightSummary" IS NOT NULL
          OR cardinality("insightReasons") > 0
          OR cardinality("insightSourceLabels") > 0
          OR "riskNote" IS NOT NULL
        )
      `;
    case "HISTORICAL_RAW_PROMPT":
      return Prisma.sql`
        "tenantId" = ${params.tenantId}
        AND "promptText" IS NOT NULL
        AND ("retentionExpiresAtUtc" IS NULL OR "retentionExpiresAtUtc" > ${params.now})
      `;
    case "EXPIRED_RETRIEVAL_AUDIT":
      return Prisma.sql`
        "tenantId" = ${params.tenantId}
        AND "retentionExpiresAtUtc" <= ${params.now}
        AND (
          "deletedAtUtc" IS NULL
          OR "actorUserId" IS NOT NULL
          OR cardinality("sourceTypes") > 0
          OR "sourceRefs" IS NOT NULL
          OR "filterSummary" IS NOT NULL
          OR "rankingSummary" IS NOT NULL
        )
      `;
    case "EXPIRED_FEEDBACK":
      return Prisma.sql`
        "tenantId" = ${params.tenantId}
        AND "createdAt" <= ${params.feedbackCutoffAtUtc}
        AND ("deletedAtUtc" IS NULL OR "note" IS NOT NULL)
      `;
  }
}

function categoryTable(category: RetentionCategory): Prisma.Sql {
  return category === "EXPIRED_RETRIEVAL_AUDIT"
    ? Prisma.sql`"AiRetrievalAuditEvent"`
    : category === "EXPIRED_FEEDBACK"
      ? Prisma.sql`"AiAssistantFeedback"`
      : Prisma.sql`"AiUsageEvent"`;
}

function categoryOrder(category: RetentionCategory): Prisma.Sql {
  if (category === "EXPIRED_RETRIEVAL_AUDIT") return Prisma.sql`"retentionExpiresAtUtc" ASC, "id" ASC`;
  return Prisma.sql`"createdAt" ASC, "id" ASC`;
}

async function acquireRetentionLock(transaction: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${retentionLockKey(tenantId)}, 0)) AS "acquired"
  `);
  return Boolean(rows[0]?.acquired);
}

async function countEligible(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    category: RetentionCategory;
    now: Date;
    feedbackCutoffAtUtc: Date;
    limit: number;
  }>,
): Promise<{ lockSkipped: boolean; count: number; hasMore: boolean }> {
  return withTenantRlsContext(prisma, params.tenantId, async (transaction) => {
    if (!await acquireRetentionLock(transaction, params.tenantId)) {
      return { lockSkipped: true, count: 0, hasMore: true };
    }
    const predicate = categoryPredicate(params);
    const rows = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM (
        SELECT 1
        FROM ${categoryTable(params.category)}
        WHERE ${predicate}
        ORDER BY ${categoryOrder(params.category)}
        LIMIT ${params.limit + 1}
      ) eligible
    `);
    const boundedCount = Number(rows[0]?.count ?? 0);
    return {
      lockSkipped: false,
      count: Math.min(boundedCount, params.limit),
      hasMore: boundedCount > params.limit,
    };
  });
}

async function applyBatch(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    category: RetentionCategory;
    now: Date;
    feedbackCutoffAtUtc: Date;
    limit: number;
  }>,
): Promise<{ lockSkipped: boolean; count: number }> {
  return withTenantRlsContext(prisma, params.tenantId, async (transaction) => {
    if (!await acquireRetentionLock(transaction, params.tenantId)) {
      return { lockSkipped: true, count: 0 };
    }
    const predicate = categoryPredicate(params);
    const table = categoryTable(params.category);
    const order = categoryOrder(params.category);
    const result = params.category === "EXPIRED_USAGE_TRACE"
      ? await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          WITH candidates AS (
            SELECT "id" FROM ${table}
            WHERE ${predicate}
            ORDER BY ${order}
            FOR UPDATE SKIP LOCKED
            LIMIT ${params.limit}
          ), minimized AS (
            UPDATE "AiUsageEvent" event
            SET "promptText" = NULL,
                "promptRedacted" = NULL,
                "actorEmail" = NULL,
                "actorName" = NULL,
                "insightSummary" = NULL,
                "insightReasons" = ARRAY[]::text[],
                "insightSourceLabels" = ARRAY[]::text[],
                "riskNote" = NULL
            FROM candidates
            WHERE event."id" = candidates."id" AND event."tenantId" = ${params.tenantId}
            RETURNING event."id"
          ) SELECT COUNT(*)::bigint AS "count" FROM minimized
        `)
      : params.category === "HISTORICAL_RAW_PROMPT"
        ? await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            WITH candidates AS (
              SELECT "id" FROM ${table}
              WHERE ${predicate}
              ORDER BY ${order}
              FOR UPDATE SKIP LOCKED
              LIMIT ${params.limit}
            ), minimized AS (
              UPDATE "AiUsageEvent" event SET "promptText" = NULL
              FROM candidates
              WHERE event."id" = candidates."id" AND event."tenantId" = ${params.tenantId}
              RETURNING event."id"
            ) SELECT COUNT(*)::bigint AS "count" FROM minimized
          `)
        : params.category === "EXPIRED_RETRIEVAL_AUDIT"
          ? await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
              WITH candidates AS (
                SELECT "id" FROM ${table}
                WHERE ${predicate}
                ORDER BY ${order}
                FOR UPDATE SKIP LOCKED
                LIMIT ${params.limit}
              ), archived AS (
                UPDATE "AiRetrievalAuditEvent" audit
                SET "actorUserId" = NULL,
                    "sourceTypes" = ARRAY[]::text[],
                    "sourceRefs" = NULL,
                    "filterSummary" = NULL,
                    "rankingSummary" = NULL,
                    "deletedAtUtc" = COALESCE(audit."deletedAtUtc", ${params.now})
                FROM candidates
                WHERE audit."id" = candidates."id" AND audit."tenantId" = ${params.tenantId}
                RETURNING audit."id"
              ) SELECT COUNT(*)::bigint AS "count" FROM archived
            `)
          : await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
              WITH candidates AS (
                SELECT "id" FROM ${table}
                WHERE ${predicate}
                ORDER BY ${order}
                FOR UPDATE SKIP LOCKED
                LIMIT ${params.limit}
              ), archived AS (
                UPDATE "AiAssistantFeedback" feedback
                SET "note" = NULL,
                    "deletedAtUtc" = COALESCE(feedback."deletedAtUtc", ${params.now}),
                    "updatedAt" = ${params.now}
                FROM candidates
                WHERE feedback."id" = candidates."id" AND feedback."tenantId" = ${params.tenantId}
                RETURNING feedback."id"
              ) SELECT COUNT(*)::bigint AS "count" FROM archived
            `);
    return { lockSkipped: false, count: Number(result[0]?.count ?? 0) };
  });
}

function toResult(params: Readonly<{
  eligible: CategoryCounts;
  applied: CategoryCounts;
  lockSkipped: boolean;
  hasMore: boolean;
}>): AiRetentionResult {
  return {
    lockSkipped: params.lockSkipped,
    hasMore: params.hasMore,
    eligibleExpiredUsageTraceCount: params.eligible.EXPIRED_USAGE_TRACE,
    eligibleHistoricalRawPromptCount: params.eligible.HISTORICAL_RAW_PROMPT,
    eligibleExpiredRetrievalAuditCount: params.eligible.EXPIRED_RETRIEVAL_AUDIT,
    eligibleExpiredFeedbackCount: params.eligible.EXPIRED_FEEDBACK,
    minimizedExpiredUsageTraceCount: params.applied.EXPIRED_USAGE_TRACE,
    minimizedHistoricalRawPromptCount: params.applied.HISTORICAL_RAW_PROMPT,
    archivedExpiredRetrievalAuditCount: params.applied.EXPIRED_RETRIEVAL_AUDIT,
    archivedExpiredFeedbackCount: params.applied.EXPIRED_FEEDBACK,
  };
}

export async function runAiRetentionForTenant(
  prisma: PrismaClient,
  params: Readonly<{
    tenantId: string;
    now: Date;
    apply: boolean;
    policy?: AiRetentionPolicy;
    maxRows?: number;
  }>,
): Promise<AiRetentionResult> {
  if (!(params.now instanceof Date) || Number.isNaN(params.now.getTime())) {
    throw new Error("AI retention requires a valid UTC timestamp.");
  }
  const policy = validateAiRetentionPolicy(params.policy ?? {
    feedbackDays: DEFAULT_AI_FEEDBACK_RETENTION_DAYS,
  });
  const maxRows = normalizeMaxRows(params.maxRows);
  const feedbackCutoffAtUtc = subtractUtcDays(params.now, policy.feedbackDays);
  const eligible = emptyCounts();
  const applied = emptyCounts();

  if (!params.apply) {
    let remaining = maxRows;
    let hasMore = false;
    for (const category of RETENTION_CATEGORIES) {
      const hadNoCapacity = remaining === 0;
      const probeLimit = Math.max(1, remaining);
      const result = await countEligible(prisma, {
        tenantId: params.tenantId,
        category,
        now: params.now,
        feedbackCutoffAtUtc,
        limit: probeLimit,
      });
      if (result.lockSkipped) {
        return toResult({ eligible, applied, lockSkipped: true, hasMore: true });
      }
      if (remaining > 0) {
        eligible[category] = result.count;
        remaining -= result.count;
      }
      hasMore ||= result.hasMore || (hadNoCapacity && result.count > 0);
    }
    return toResult({ eligible, applied, lockSkipped: false, hasMore });
  }

  let remaining = maxRows;
  for (const category of RETENTION_CATEGORIES) {
    while (remaining > 0) {
      const limit = Math.min(AI_RETENTION_BATCH_SIZE, remaining);
      const result = await applyBatch(prisma, {
        tenantId: params.tenantId,
        category,
        now: params.now,
        feedbackCutoffAtUtc,
        limit,
      });
      if (result.lockSkipped) {
        return toResult({ eligible, applied, lockSkipped: true, hasMore: true });
      }
      applied[category] += result.count;
      remaining -= result.count;
      if (result.count < limit) break;
    }
  }

  let hasMore = false;
  for (const category of RETENTION_CATEGORIES) {
    const probe = await countEligible(prisma, {
      tenantId: params.tenantId,
      category,
      now: params.now,
      feedbackCutoffAtUtc,
      limit: 1,
    });
    if (probe.lockSkipped) {
      return toResult({ eligible, applied, lockSkipped: true, hasMore: true });
    }
    hasMore ||= probe.count > 0 || probe.hasMore;
  }
  return toResult({ eligible, applied, lockSkipped: false, hasMore });
}
