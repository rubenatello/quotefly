import { randomUUID } from "node:crypto";
import {
  Prisma,
  type AiIndexJob,
  type AiIndexJobOperation,
  type PrismaClient,
} from "@prisma/client";
import {
  upsertAiRetrievalSource,
  type AiRetrievalSourceInput,
} from "./ai-retrieval";
import { sha256Text } from "./ai-data-governance";
import { assertAiUsageAvailable, type AiUsageTelemetry } from "./ai-usage";
import { buildTenantEntitlements } from "./subscription";
import { withTenantRlsContext, type TenantRlsClient } from "./tenant-rls";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_WORKER_ID_LENGTH = 128;

type AiIndexJobClient = TenantRlsClient;

class AiIndexBudgetExhaustedError extends Error {
  constructor(readonly renewsAtUtc: Date) {
    super("AI_INDEX_BUDGET_EXHAUSTED");
  }
}

export type ClaimedAiIndexJob = Readonly<AiIndexJob>;
export type AiIndexJobResult = Readonly<{
  chunkCount: number;
  embeddingCacheHitCount: number;
}>;

type AiIndexJobEnqueueInput = Readonly<{
  sourceType: string;
  sourceId: string;
  operation: AiIndexJobOperation;
  expectedSourceUpdatedAtUtc?: Date | null;
  availableAtUtc?: Date;
  maxAttempts?: number;
}>;

async function assertIndexingBudgetAvailable(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      subscriptionStatus: true,
      subscriptionPlanCode: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodEndUtc: true,
    },
  });
  if (!tenant) throw new Error("AI_INDEX_TENANT_NOT_FOUND");
  const entitlements = buildTenantEntitlements(tenant);
  const budget = await assertAiUsageAvailable(prisma, tenantId, entitlements);
  if (budget.blocked) {
    throw new AiIndexBudgetExhaustedError(budget.snapshot.periodEndUtc);
  }
}

async function recordIndexingUsage(
  prisma: PrismaClient,
  job: ClaimedAiIndexJob,
  telemetry: AiUsageTelemetry,
) {
  await withTenantRlsContext(prisma, job.tenantId, (tx) => tx.aiUsageEvent.create({
    data: {
      tenantId: job.tenantId,
      eventType: "INDEXING",
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      creditsConsumed: 0,
      requestCount: telemetry.requestCount,
      promptTokens: telemetry.promptTokens,
      completionTokens: telemetry.completionTokens,
      totalTokens: telemetry.totalTokens,
      estimatedCostUsd: telemetry.estimatedCostUsd,
      promptText: null,
      promptRedacted: null,
      promptHash: sha256Text(`rag-index:${job.sourceType}`),
      sourceCount: 1,
    },
  }));
}

function normalizeRequired(value: string, label: string, maxLength?: number) {
  const normalized = value.trim();
  if (!normalized || (maxLength && normalized.length > maxLength)) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function safeIndexErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("rate limit") || message.includes("429")) return "PROVIDER_RATE_LIMIT";
  if (message.includes("timeout") || message.includes("timed out")) return "PROVIDER_TIMEOUT";
  if (message.includes("unsupported")) return "SOURCE_TYPE_UNSUPPORTED";
  if (message.includes("empty embedding")) return "EMPTY_EMBEDDING";
  if (message.includes("budget_exhausted")) return "AI_BUDGET_EXHAUSTED";
  if (message.includes("source_version_pending")) return "SOURCE_VERSION_PENDING";
  return "AI_INDEX_FAILED";
}

function retryDelayMs(attempts: number) {
  return Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)));
}

export async function enqueueAiIndexJobs(
  prisma: AiIndexJobClient,
  params: {
    tenantId: string;
    jobs: readonly AiIndexJobEnqueueInput[];
  },
) {
  const tenantId = normalizeRequired(params.tenantId, "AI index tenantId");
  if (params.jobs.length === 0) return [];
  if (params.jobs.length > 5_000) throw new Error("AI index enqueue batch is too large.");
  const jobs = params.jobs.map((job) => ({
    sourceType: normalizeRequired(job.sourceType, "AI index sourceType", 64),
    sourceId: normalizeRequired(job.sourceId, "AI index sourceId"),
    operation: job.operation,
    expectedSourceUpdatedAtUtc: job.expectedSourceUpdatedAtUtc ?? null,
    availableAtUtc: job.availableAtUtc ?? new Date(),
    maxAttempts: Math.min(10, Math.max(1, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
  }));
  const values = jobs.map((job) => Prisma.sql`(
    ${randomUUID()}, ${tenantId}, ${job.sourceType}, ${job.sourceId},
    ${job.operation}::"AiIndexJobOperation", 'PENDING'::"AiIndexJobStatus",
    ${job.expectedSourceUpdatedAtUtc}, ${job.availableAtUtc}, ${job.maxAttempts}, NOW(), NOW()
  )`);

  return withTenantRlsContext(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<AiIndexJob[]>(Prisma.sql`
      INSERT INTO "AiIndexJob" (
        "id", "tenantId", "sourceType", "sourceId", "operation", "status",
        "expectedSourceUpdatedAtUtc", "availableAtUtc", "maxAttempts", "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(values)}
      ON CONFLICT ("tenantId", "sourceType", "sourceId") DO UPDATE SET
        "operation" = EXCLUDED."operation",
        "generation" = "AiIndexJob"."generation" + 1,
        "expectedSourceUpdatedAtUtc" = EXCLUDED."expectedSourceUpdatedAtUtc",
        "status" = CASE
          WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
            THEN "AiIndexJob"."status"
          ELSE 'PENDING'::"AiIndexJobStatus"
        END,
        "availableAtUtc" = CASE
          WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
            THEN "AiIndexJob"."availableAtUtc"
          ELSE EXCLUDED."availableAtUtc"
        END,
        "attempts" = CASE
          WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
            THEN "AiIndexJob"."attempts"
          ELSE 0
        END,
        "maxAttempts" = EXCLUDED."maxAttempts",
        "lockedAtUtc" = CASE
          WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
            THEN "AiIndexJob"."lockedAtUtc"
          ELSE NULL
        END,
        "lockedBy" = CASE
          WHEN "AiIndexJob"."status" = 'PROCESSING'::"AiIndexJobStatus"
            THEN "AiIndexJob"."lockedBy"
          ELSE NULL
        END,
        "completedAtUtc" = NULL,
        "lastErrorCode" = NULL,
        "updatedAt" = NOW()
      RETURNING *
    `);
    if (rows.length !== jobs.length) throw new Error("AI index jobs could not be enqueued.");
    return rows;
  });
}

export async function enqueueAiIndexJob(
  prisma: AiIndexJobClient,
  params: { tenantId: string } & AiIndexJobEnqueueInput,
) {
  const rows = await enqueueAiIndexJobs(prisma, {
    tenantId: params.tenantId,
    jobs: [params],
  });
  const job = rows[0];
  if (!job) throw new Error("AI index job could not be enqueued.");
  return job;
}

export async function enqueueQuoteAiIndexJobs(
  prisma: AiIndexJobClient,
  params: {
    tenantId: string;
    quoteId: string;
    operation?: AiIndexJobOperation;
    expectedSourceUpdatedAtUtc?: Date | null;
  },
) {
  const tenantId = normalizeRequired(params.tenantId, "AI index tenantId");
  const quoteId = normalizeRequired(params.quoteId, "AI index quoteId");
  const lineItems = await prisma.quoteLineItem.findMany({
    where: { tenantId, quoteId },
    select: { id: true, updatedAt: true, deletedAtUtc: true },
  });
  await enqueueAiIndexJobs(prisma, {
    tenantId,
    jobs: [
      {
        sourceType: "Quote",
        sourceId: quoteId,
        operation: params.operation ?? "UPSERT",
        expectedSourceUpdatedAtUtc: params.expectedSourceUpdatedAtUtc,
      },
      ...lineItems.map((lineItem) => ({
        sourceType: "QuoteLineItem",
        sourceId: lineItem.id,
        operation: params.operation ?? (lineItem.deletedAtUtc ? "DELETE" : "UPSERT"),
        expectedSourceUpdatedAtUtc: lineItem.deletedAtUtc ? null : lineItem.updatedAt,
      } satisfies AiIndexJobEnqueueInput)),
    ],
  });
  return { quoteCount: 1, lineItemCount: lineItems.length };
}

export async function enqueueCustomerAiIndexJobs(
  prisma: AiIndexJobClient,
  params: {
    tenantId: string;
    customerId: string;
    operation?: AiIndexJobOperation;
    includeQuotes?: boolean;
    expectedSourceUpdatedAtUtc?: Date | null;
  },
) {
  const tenantId = normalizeRequired(params.tenantId, "AI index tenantId");
  const customerId = normalizeRequired(params.customerId, "AI index customerId");
  const [activityEvents, quotes] = await Promise.all([
    prisma.customerActivityEvent.findMany({
      where: { tenantId, customerId },
      select: { id: true },
    }),
    params.includeQuotes
      ? prisma.quote.findMany({
          where: { tenantId, customerId },
          select: {
            id: true,
            updatedAt: true,
            archivedAtUtc: true,
            deletedAtUtc: true,
            lineItems: { select: { id: true, updatedAt: true, deletedAtUtc: true } },
          },
        })
      : Promise.resolve([]),
  ]);
  const requestedOperation = params.operation;
  await enqueueAiIndexJobs(prisma, {
    tenantId,
    jobs: [
      {
        sourceType: "Customer",
        sourceId: customerId,
        operation: requestedOperation ?? "UPSERT",
        expectedSourceUpdatedAtUtc: params.expectedSourceUpdatedAtUtc,
      },
      ...activityEvents.map((event) => ({
        sourceType: "CustomerActivityEvent",
        sourceId: event.id,
        operation: requestedOperation ?? "UPSERT",
      } satisfies AiIndexJobEnqueueInput)),
      ...quotes.flatMap((quote) => {
        const quoteInactive = Boolean(quote.archivedAtUtc || quote.deletedAtUtc);
        return [
          {
            sourceType: "Quote",
            sourceId: quote.id,
            operation: requestedOperation ?? (quoteInactive ? "DELETE" : "UPSERT"),
            expectedSourceUpdatedAtUtc: quoteInactive ? null : quote.updatedAt,
          },
          ...quote.lineItems.map((lineItem) => ({
            sourceType: "QuoteLineItem",
            sourceId: lineItem.id,
            operation: requestedOperation ?? (quoteInactive || lineItem.deletedAtUtc ? "DELETE" : "UPSERT"),
            expectedSourceUpdatedAtUtc: quoteInactive || lineItem.deletedAtUtc ? null : lineItem.updatedAt,
          })),
        ] satisfies AiIndexJobEnqueueInput[];
      }),
    ],
  });
  return {
    customerCount: 1,
    activityEventCount: activityEvents.length,
    quoteCount: quotes.length,
  };
}

export async function enqueueTenantWorkPresetAiIndexJobs(
  prisma: AiIndexJobClient,
  params: { tenantId: string },
) {
  const tenantId = normalizeRequired(params.tenantId, "AI index tenantId");
  const presets = await prisma.workPreset.findMany({
    where: { tenantId },
    select: { id: true, updatedAt: true, deletedAtUtc: true },
  });
  await enqueueAiIndexJobs(prisma, {
    tenantId,
    jobs: presets.map((preset) => ({
      sourceType: "WorkPreset",
      sourceId: preset.id,
      operation: preset.deletedAtUtc ? "DELETE" : "UPSERT",
      expectedSourceUpdatedAtUtc: preset.deletedAtUtc ? null : preset.updatedAt,
    })),
  });
  return { presetCount: presets.length };
}

export async function claimAiIndexJob(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    workerId: string;
    now?: Date;
    leaseMs?: number;
  },
): Promise<ClaimedAiIndexJob | null> {
  const tenantId = normalizeRequired(params.tenantId, "AI index tenantId");
  const workerId = normalizeRequired(params.workerId, "AI index workerId", MAX_WORKER_ID_LENGTH);
  const now = params.now ?? new Date();
  const leaseCutoff = new Date(now.getTime() - Math.max(30_000, params.leaseMs ?? DEFAULT_LEASE_MS));

  return withTenantRlsContext(prisma, tenantId, async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 AS "locked"
      FROM pg_advisory_xact_lock(hashtext(${`ai-index:${tenantId}`}))
    `);
    await tx.aiIndexJob.updateMany({
      where: {
        tenantId,
        status: "PROCESSING",
        lockedAtUtc: { lt: leaseCutoff },
      },
      data: {
        status: "PENDING",
        availableAtUtc: now,
        lockedAtUtc: null,
        lockedBy: null,
        lastErrorCode: "LEASE_EXPIRED",
      },
    });

    await tx.$executeRaw(Prisma.sql`
      UPDATE "AiIndexJob"
      SET "status" = 'DEAD'::"AiIndexJobStatus",
          "completedAtUtc" = ${now},
          "lastErrorCode" = COALESCE("lastErrorCode", 'MAX_ATTEMPTS_EXHAUSTED'),
          "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}
        AND "status" = 'PENDING'::"AiIndexJobStatus"
        AND "attempts" >= "maxAttempts"
    `);

    const activeLease = await tx.aiIndexJob.count({
      where: { tenantId, status: "PROCESSING" },
    });
    if (activeLease > 0) return null;

    const candidates = await tx.$queryRaw<AiIndexJob[]>(Prisma.sql`
      SELECT *
      FROM "AiIndexJob"
      WHERE "tenantId" = ${tenantId}
        AND "status" = 'PENDING'::"AiIndexJobStatus"
        AND "availableAtUtc" <= ${now}
        AND "attempts" < "maxAttempts"
      ORDER BY "availableAtUtc" ASC, "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const job = candidates[0];
    if (!job) return null;

    const leaseToken = `${workerId.slice(0, 72)}:${randomUUID()}`;

    const claimed = await tx.aiIndexJob.updateMany({
      where: {
        id: job.id,
        tenantId,
        generation: job.generation,
        status: "PENDING",
        availableAtUtc: { lte: now },
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAtUtc: now,
        lockedBy: leaseToken,
        lastErrorCode: null,
      },
    });
    if (claimed.count !== 1) return null;
    return tx.aiIndexJob.findUnique({
      where: { id_tenantId: { id: job.id, tenantId } },
    });
  });
}

async function releaseStaleClaim(
  prisma: PrismaClient,
  job: ClaimedAiIndexJob,
  now: Date,
) {
  await withTenantRlsContext(prisma, job.tenantId, (tx) => tx.aiIndexJob.updateMany({
    where: {
      id: job.id,
      tenantId: job.tenantId,
      status: "PROCESSING",
      generation: { gt: job.generation },
      lockedBy: job.lockedBy,
    },
    data: {
      status: "PENDING",
      availableAtUtc: now,
      lockedAtUtc: null,
      lockedBy: null,
    },
  }));
}

async function loadCanonicalSource(
  prisma: PrismaClient,
  job: ClaimedAiIndexJob,
): Promise<AiRetrievalSourceInput | null> {
  const tenantId = job.tenantId;
  switch (job.sourceType) {
    case "Customer": {
      const row = await prisma.customer.findFirst({
        where: { id: job.sourceId, tenantId, archivedAtUtc: null, deletedAtUtc: null },
        select: {
          id: true,
          fullName: true,
          notes: true,
          followUpStatus: true,
          assignedTenantUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return row ? {
        tenantId,
        sourceType: "Customer",
        sourceId: row.id,
        citationLabel: `Customer notes: ${row.fullName}`,
        sourceUpdatedAtUtc: row.updatedAt,
        metadata: { customerId: row.id },
        filterMetadata: {
          customerId: row.id,
          recordStatus: row.followUpStatus,
          lifecycle: "active",
          assignedTenantUserId: row.assignedTenantUserId,
          sourceCreatedAtUtc: row.createdAt,
        },
        fields: [{ field: "Customer.notes", content: row.notes }],
      } : null;
    }
    case "Quote": {
      const row = await prisma.quote.findFirst({
        where: { id: job.sourceId, tenantId, archivedAtUtc: null, deletedAtUtc: null },
        select: {
          id: true,
          customerId: true,
          title: true,
          scopeText: true,
          serviceType: true,
          status: true,
          assignedTenantUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return row ? {
        tenantId,
        sourceType: "Quote",
        sourceId: row.id,
        citationLabel: `Quote: ${row.title}`,
        sourceUpdatedAtUtc: row.updatedAt,
        metadata: { quoteId: row.id, serviceType: row.serviceType },
        filterMetadata: {
          customerId: row.customerId,
          quoteId: row.id,
          serviceType: row.serviceType,
          recordStatus: row.status,
          lifecycle: "active",
          assignedTenantUserId: row.assignedTenantUserId,
          sourceCreatedAtUtc: row.createdAt,
        },
        fields: [
          { field: "Quote.title", content: row.title },
          { field: "Quote.scopeText", content: row.scopeText },
        ],
      } : null;
    }
    case "QuoteLineItem": {
      const row = await prisma.quoteLineItem.findFirst({
        where: {
          id: job.sourceId,
          tenantId,
          deletedAtUtc: null,
          quote: { tenantId, archivedAtUtc: null, deletedAtUtc: null },
        },
        select: {
          id: true,
          description: true,
          sectionType: true,
          sectionLabel: true,
          createdAt: true,
          updatedAt: true,
          quote: {
            select: {
              id: true,
              customerId: true,
              title: true,
              serviceType: true,
              status: true,
              assignedTenantUserId: true,
            },
          },
        },
      });
      return row ? {
        tenantId,
        sourceType: "QuoteLineItem",
        sourceId: row.id,
        citationLabel: `Quote line: ${row.quote.title}`,
        sourceUpdatedAtUtc: row.updatedAt,
        metadata: { quoteId: row.quote.id, serviceType: row.quote.serviceType },
        filterMetadata: {
          customerId: row.quote.customerId,
          quoteId: row.quote.id,
          serviceType: row.quote.serviceType,
          recordStatus: row.quote.status,
          lifecycle: "active",
          assignedTenantUserId: row.quote.assignedTenantUserId,
          section: row.sectionLabel ?? row.sectionType,
          sourceCreatedAtUtc: row.createdAt,
        },
        fields: [{ field: "QuoteLineItem.description", content: row.description }],
      } : null;
    }
    case "CustomerActivityEvent": {
      const row = await prisma.customerActivityEvent.findFirst({
        where: {
          id: job.sourceId,
          tenantId,
          deletedAtUtc: null,
          customer: { tenantId, archivedAtUtc: null, deletedAtUtc: null },
        },
        select: {
          id: true,
          customerId: true,
          eventType: true,
          title: true,
          detail: true,
          createdAt: true,
          customer: { select: { assignedTenantUserId: true } },
        },
      });
      return row ? {
        tenantId,
        sourceType: "CustomerActivityEvent",
        sourceId: row.id,
        citationLabel: `Customer activity: ${row.title}`,
        sourceUpdatedAtUtc: row.createdAt,
        metadata: { customerId: row.customerId },
        filterMetadata: {
          customerId: row.customerId,
          recordStatus: row.eventType,
          lifecycle: "active",
          assignedTenantUserId: row.customer.assignedTenantUserId,
          section: "activity",
          sourceCreatedAtUtc: row.createdAt,
        },
        fields: [
          { field: "CustomerActivityEvent.title", content: row.title },
          { field: "CustomerActivityEvent.detail", content: row.detail },
        ],
      } : null;
    }
    case "WorkPreset": {
      const row = await prisma.workPreset.findFirst({
        where: { id: job.sourceId, tenantId, deletedAtUtc: null },
        select: {
          id: true,
          name: true,
          description: true,
          serviceType: true,
          category: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return row ? {
        tenantId,
        sourceType: "WorkPreset",
        sourceId: row.id,
        citationLabel: `Saved job: ${row.name}`,
        sourceUpdatedAtUtc: row.updatedAt,
        metadata: { serviceType: row.serviceType },
        filterMetadata: {
          serviceType: row.serviceType,
          recordStatus: row.category,
          lifecycle: "active",
          section: "product-catalog",
          sourceCreatedAtUtc: row.createdAt,
        },
        fields: [
          { field: "WorkPreset.name", content: row.name },
          { field: "WorkPreset.description", content: row.description },
        ],
      } : null;
    }
    default:
      throw new Error("AI index source type unsupported.");
  }
}

export async function executeAiIndexJob(prisma: PrismaClient, job: ClaimedAiIndexJob) {
  const source = await loadCanonicalSource(prisma, job);
  const emptyFieldBySourceType = {
    Customer: "Customer.notes",
    Quote: "Quote.scopeText",
    QuoteLineItem: "QuoteLineItem.description",
    CustomerActivityEvent: "CustomerActivityEvent.detail",
    WorkPreset: "WorkPreset.description",
  } as const;
  const sourceToPersist = source ?? (() => {
    const field = emptyFieldBySourceType[job.sourceType as keyof typeof emptyFieldBySourceType];
    if (!field) throw new Error("AI index source type unsupported.");
    return {
      tenantId: job.tenantId,
      sourceType: job.sourceType,
      sourceId: job.sourceId,
      citationLabel: "Deleted source",
      fields: [{ field, content: null }],
    } satisfies AiRetrievalSourceInput;
  })();
  if (source) {
    if (
      job.expectedSourceUpdatedAtUtc
      && source.sourceUpdatedAtUtc
      && job.operation === "UPSERT"
      && source.sourceUpdatedAtUtc.getTime() < job.expectedSourceUpdatedAtUtc.getTime()
    ) {
      throw new Error("AI_INDEX_SOURCE_VERSION_PENDING");
    }
    await assertIndexingBudgetAvailable(prisma, job.tenantId);
  }
  const result = await upsertAiRetrievalSource(prisma, sourceToPersist, {
    persistenceFence: {
      jobId: job.id,
      generation: job.generation,
      leaseToken: job.lockedBy ?? "",
      startedAtMs: Date.now(),
    },
    onEmbeddingTelemetry: (telemetry) => recordIndexingUsage(prisma, job, telemetry),
  });
  return {
    chunkCount: result.chunkCount,
    embeddingCacheHitCount: result.embeddingCacheHitCount,
  };
}

export async function processClaimedAiIndexJob(
  prisma: PrismaClient,
  job: ClaimedAiIndexJob,
) {
  try {
    const result = await executeAiIndexJob(prisma, job);
    return { outcome: "succeeded" as const, result };
  } catch (error) {
    if (error instanceof Error && error.message === "AI_INDEX_JOB_STALE") {
      await releaseStaleClaim(prisma, job, new Date());
      return { outcome: "stale" as const };
    }
    if (error instanceof AiIndexBudgetExhaustedError) {
      const deferred = await withTenantRlsContext(prisma, job.tenantId, (tx) => tx.aiIndexJob.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          generation: job.generation,
          status: "PROCESSING",
          lockedBy: job.lockedBy,
        },
        data: {
          status: "PENDING",
          attempts: { decrement: 1 },
          availableAtUtc: error.renewsAtUtc,
          completedAtUtc: null,
          lockedAtUtc: null,
          lockedBy: null,
          lastErrorCode: "AI_BUDGET_EXHAUSTED",
        },
      }));
      if (deferred.count !== 1) {
        await releaseStaleClaim(prisma, job, new Date());
        return { outcome: "stale" as const };
      }
      return { outcome: "budget_deferred" as const, availableAtUtc: error.renewsAtUtc };
    }
    const now = new Date();
    const exhausted = job.attempts >= job.maxAttempts;
    const failed = await withTenantRlsContext(prisma, job.tenantId, (tx) => tx.aiIndexJob.updateMany({
      where: {
        id: job.id,
        tenantId: job.tenantId,
        generation: job.generation,
        status: "PROCESSING",
        lockedBy: job.lockedBy,
      },
      data: {
        status: exhausted ? "DEAD" : "PENDING",
        availableAtUtc: exhausted ? now : new Date(now.getTime() + retryDelayMs(job.attempts)),
        completedAtUtc: exhausted ? now : null,
        lockedAtUtc: null,
        lockedBy: null,
        lastErrorCode: safeIndexErrorCode(error),
      },
    }));
    if (failed.count !== 1) {
      await releaseStaleClaim(prisma, job, now);
      return { outcome: "stale" as const };
    }
    return { outcome: exhausted ? "dead" as const : "retry" as const };
  }
}

export async function processNextAiIndexJob(
  prisma: PrismaClient,
  params: { tenantId: string; workerId: string },
) {
  const job = await claimAiIndexJob(prisma, params);
  if (!job) return { outcome: "idle" as const };
  return processClaimedAiIndexJob(prisma, job);
}
