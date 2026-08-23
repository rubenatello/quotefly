import type { FastifyPluginAsync } from "fastify";
import { Prisma, type JobStatus, type QuoteStatus } from "@prisma/client";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext } from "../lib/access-policy";
import { PaginationQuerySchema, tenantActiveCustomerScope, tenantActiveQuoteScope } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { assignedRecordScope } from "../lib/workspace-assignment";
import { ACTIVE_JOB_STATUSES, visibleJobWhere } from "../services/jobs";

const QUOTE_STATUSES: QuoteStatus[] = [
  "DRAFT",
  "READY_FOR_REVIEW",
  "SENT_TO_CUSTOMER",
  "ACCEPTED",
  "REJECTED",
];

type AttentionReason =
  | "NEEDS_FIRST_QUOTE"
  | "DRAFT_TO_FINISH"
  | "READY_TO_SEND"
  | "AWAITING_RESPONSE"
  | "AFTER_SALE_DUE";

function attentionPriority(reason: AttentionReason) {
  if (reason === "AFTER_SALE_DUE") return 0;
  if (reason === "AWAITING_RESPONSE") return 1;
  if (reason === "NEEDS_FIRST_QUOTE") return 2;
  if (reason === "READY_TO_SEND") return 3;
  return 4;
}

const FollowUpQueueSchema = z.enum(["new", "quoted", "closed", "afterSale", "recent"]);
const FollowUpQuerySchema = PaginationQuerySchema.extend({
  queue: FollowUpQueueSchema.default("new"),
  search: z.string().trim().min(1).max(120).optional(),
});

type FollowUpRow = {
  customerId: string;
  customerName: string;
  phone: string;
  email: string | null;
  quoteId: string | null;
  quoteTitle: string | null;
  totalAmount: Prisma.Decimal | null;
  status: string | null;
  jobId: string | null;
  jobNumber: number | null;
  jobStatus: JobStatus | null;
  afterSaleFollowUpStatus: string | null;
  afterSaleFollowUpDueAtUtc: Date | null;
  followUpStatus: string;
  createdAt: Date;
};

type FollowUpCountsRow = {
  newCount: bigint;
  quotedCount: bigint;
  closedCount: bigint;
  afterSaleCount: bigint;
  recentCount: bigint;
};

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function followUpCte(input: {
  tenantId: string;
  assignedTenantUserId: string | null;
  search?: string;
}) {
  const searchPattern = input.search ? `%${escapeLikePattern(input.search)}%` : null;
  const searchSql = searchPattern
    ? Prisma.sql`AND (
        customer."fullName" ILIKE ${searchPattern} ESCAPE E'\\\\'
        OR customer."email" ILIKE ${searchPattern} ESCAPE E'\\\\'
        OR customer."phone" ILIKE ${searchPattern} ESCAPE E'\\\\'
        OR latest_quote."title" ILIKE ${searchPattern} ESCAPE E'\\\\'
      )`
    : Prisma.empty;

  return Prisma.sql`
    WITH scoped AS (
      SELECT
        customer."id" AS "customerId",
        customer."fullName" AS "customerName",
        customer."phone",
        customer."email",
        customer."followUpStatus"::text AS "customerFollowUpStatus",
        customer."createdAt" AS "customerCreatedAt",
        latest_quote."id" AS "quoteId",
        latest_quote."title" AS "quoteTitle",
        latest_quote."totalAmount",
        latest_quote."status"::text AS "status",
        latest_job."id" AS "jobId",
        latest_job."jobNumber",
        latest_job."status"::text AS "jobStatus",
        latest_quote."afterSaleFollowUpStatus"::text AS "afterSaleFollowUpStatus",
        latest_quote."afterSaleFollowUpDueAtUtc",
        latest_quote."updatedAt" AS "quoteUpdatedAt"
      FROM "Customer" customer
      LEFT JOIN LATERAL (
        SELECT quote.*
        FROM "Quote" quote
        WHERE quote."tenantId" = ${input.tenantId}
          AND quote."customerId" = customer."id"
          AND quote."archivedAtUtc" IS NULL
          AND quote."deletedAtUtc" IS NULL
          AND (${input.assignedTenantUserId}::text IS NULL OR quote."assignedTenantUserId" = ${input.assignedTenantUserId})
        ORDER BY quote."updatedAt" DESC, quote."id" DESC
        LIMIT 1
      ) latest_quote ON TRUE
      LEFT JOIN LATERAL (
        SELECT job."id", job."jobNumber", job."status"
        FROM "Job" job
        WHERE job."tenantId" = ${input.tenantId}
          AND job."sourceQuoteId" = latest_quote."id"
          AND job."archivedAtUtc" IS NULL
          AND job."deletedAtUtc" IS NULL
          AND (${input.assignedTenantUserId}::text IS NULL OR job."assignedTenantUserId" = ${input.assignedTenantUserId})
        LIMIT 1
      ) latest_job ON TRUE
      WHERE customer."tenantId" = ${input.tenantId}
        AND customer."archivedAtUtc" IS NULL
        AND customer."deletedAtUtc" IS NULL
        AND (${input.assignedTenantUserId}::text IS NULL OR customer."assignedTenantUserId" = ${input.assignedTenantUserId})
        ${searchSql}
    ), classified AS (
      SELECT
        scoped.*,
        CASE
          WHEN scoped."quoteId" IS NULL OR scoped."status" IN ('DRAFT', 'READY_FOR_REVIEW') THEN 'new'
          WHEN scoped."status" = 'SENT_TO_CUSTOMER' THEN 'quoted'
          WHEN scoped."status" = 'ACCEPTED' AND scoped."afterSaleFollowUpStatus" = 'DUE' THEN 'afterSale'
          WHEN scoped."status" = 'ACCEPTED' AND scoped."afterSaleFollowUpStatus" <> 'COMPLETED' THEN 'closed'
          ELSE NULL
        END AS "queueKey",
        CASE
          WHEN scoped."status" = 'ACCEPTED' THEN 'WON'
          WHEN scoped."status" = 'REJECTED' THEN 'LOST'
          ELSE scoped."customerFollowUpStatus"
        END AS "effectiveFollowUpStatus"
      FROM scoped
    )`;
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/workspace/follow-up", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const recordScope = assignedRecordScope(access);
    const query = FollowUpQuerySchema.parse(request.query);
    const cte = followUpCte({
      tenantId: claims.tenantId,
      assignedTenantUserId: recordScope.assignedTenantUserId ?? null,
      search: query.search,
    });
    const queueFilter = query.queue === "recent"
      ? Prisma.sql`TRUE`
      : Prisma.sql`"queueKey" = ${query.queue}`;
    const orderSql = query.queue === "recent"
      ? Prisma.sql`"customerCreatedAt" DESC, "customerId" DESC`
      : query.queue === "closed"
        ? Prisma.sql`
            CASE "jobStatus"
              WHEN 'UNSCHEDULED' THEN 0
              WHEN 'SCHEDULED' THEN 1
              WHEN 'DISPATCHED' THEN 2
              WHEN 'IN_PROGRESS' THEN 3
              WHEN 'COMPLETED' THEN 4
              WHEN 'CANCELED' THEN 5
              ELSE 6
            END,
            COALESCE("quoteUpdatedAt", "customerCreatedAt") ASC,
            "customerId" ASC`
        : query.queue === "afterSale"
          ? Prisma.sql`COALESCE("afterSaleFollowUpDueAtUtc", 'epoch'::timestamptz) ASC, COALESCE("quoteUpdatedAt", "customerCreatedAt") ASC, "customerId" ASC`
          : Prisma.sql`
              CASE "effectiveFollowUpStatus"
                WHEN 'NEEDS_FOLLOW_UP' THEN 0
                WHEN 'FOLLOWED_UP' THEN 1
                WHEN 'WON' THEN 2
                WHEN 'LOST' THEN 3
                ELSE 4
              END,
              COALESCE("quoteUpdatedAt", "customerCreatedAt") ASC,
              "customerId" ASC`;
    const quoteScope = {
      ...tenantActiveQuoteScope(claims.tenantId),
      ...recordScope,
    };
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [rows, countRows, acceptedRevenue, monthlyQuotes] = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => Promise.all([
      tx.$queryRaw<FollowUpRow[]>(Prisma.sql`
        ${cte}
        SELECT
          "customerId",
          "customerName",
          "phone",
          "email",
          "quoteId",
          "quoteTitle",
          "totalAmount",
          "status",
          "jobId",
          "jobNumber",
          "jobStatus",
          "afterSaleFollowUpStatus",
          "afterSaleFollowUpDueAtUtc",
          "effectiveFollowUpStatus" AS "followUpStatus",
          CASE WHEN ${query.queue} = 'recent' THEN "customerCreatedAt" ELSE COALESCE("quoteUpdatedAt", "customerCreatedAt") END AS "createdAt"
        FROM classified
        WHERE ${queueFilter}
        ORDER BY ${orderSql}
        LIMIT ${query.limit}
        OFFSET ${query.offset}
      `),
      tx.$queryRaw<FollowUpCountsRow[]>(Prisma.sql`
        ${cte}
        SELECT
          COUNT(*) FILTER (WHERE "queueKey" = 'new')::bigint AS "newCount",
          COUNT(*) FILTER (WHERE "queueKey" = 'quoted')::bigint AS "quotedCount",
          COUNT(*) FILTER (WHERE "queueKey" = 'closed')::bigint AS "closedCount",
          COUNT(*) FILTER (WHERE "queueKey" = 'afterSale')::bigint AS "afterSaleCount",
          COUNT(*)::bigint AS "recentCount"
        FROM classified
      `),
      tx.quote.aggregate({
        where: { ...quoteScope, status: "ACCEPTED" },
        _sum: { totalAmount: true },
      }),
      tx.quote.count({
        where: {
          ...quoteScope,
          createdAt: { gte: monthStart },
        },
      }),
    ])));

    const counts = countRows[0] ?? {
      newCount: 0n,
      quotedCount: 0n,
      closedCount: 0n,
      afterSaleCount: 0n,
      recentCount: 0n,
    };
    const totals = {
      newLeads: Number(counts.newCount),
      quotedLeads: Number(counts.quotedCount),
      closedLeads: Number(counts.closedCount),
      afterSaleLeads: Number(counts.afterSaleCount),
      recentLeads: Number(counts.recentCount),
    };
    const totalByQueue = {
      new: totals.newLeads,
      quoted: totals.quotedLeads,
      closed: totals.closedLeads,
      afterSale: totals.afterSaleLeads,
      recent: totals.recentLeads,
    };

    reply.header("Cache-Control", "private, no-store");
    return {
      items: rows.map((row) => ({
        customerId: row.customerId,
        customerName: row.customerName,
        phone: row.phone,
        email: row.email,
        ...(row.quoteId ? { quoteId: row.quoteId } : {}),
        ...(row.quoteTitle ? { quoteTitle: row.quoteTitle } : {}),
        ...(row.totalAmount !== null ? { totalAmount: Number(row.totalAmount) } : {}),
        ...(row.status ? { status: row.status } : {}),
        // One-release mixed-client compatibility. This flat read projection
        // comes only from authoritative Job; Quote.jobStatus remains legacy
        // display data and is never accepted as Job write authority.
        jobStatus: row.jobStatus,
        ...(row.jobId && row.jobNumber !== null && row.jobStatus
          ? { job: { id: row.jobId, jobNumber: row.jobNumber, status: row.jobStatus } }
          : {}),
        ...(row.afterSaleFollowUpStatus ? { afterSaleFollowUpStatus: row.afterSaleFollowUpStatus } : {}),
        afterSaleFollowUpDueAtUtc: row.afterSaleFollowUpDueAtUtc?.toISOString() ?? null,
        followUpStatus: row.followUpStatus,
        createdAt: row.createdAt.toISOString(),
        activityAtUtc: row.createdAt.toISOString(),
        activityKind: query.queue === "recent" || !row.quoteId ? "ADDED" : "UPDATED",
      })),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: totalByQueue[query.queue],
      },
      totals,
      metrics: {
        acceptedRevenue: Number(acceptedRevenue._sum.totalAmount ?? 0),
        monthlyQuotes,
      },
    };
  });

  app.get("/workspace/overview", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const access = buildAccessContext(request);
    const recordScope = assignedRecordScope(access);
    const customerScope = {
      ...tenantActiveCustomerScope(claims.tenantId),
      ...recordScope,
    };
    const quoteScope = {
      ...tenantActiveQuoteScope(claims.tenantId),
      ...recordScope,
    };

    const overview = await measureRequestPerformance(request, "db", () => withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
      const [
        customerGroups,
        unquotedLeadCount,
        quoteGroups,
        activeJobCount,
        recentCustomers,
        attentionQuotes,
        unquotedCustomers,
        recentQuotes,
      ] = await Promise.all([
        tx.customer.groupBy({
          by: ["followUpStatus"],
          where: customerScope,
          _count: { _all: true },
        }),
        tx.customer.count({
          where: {
            ...customerScope,
            followUpStatus: { notIn: ["WON", "LOST"] },
            quotes: { none: quoteScope },
          },
        }),
        tx.quote.groupBy({
          by: ["status", "afterSaleFollowUpStatus"],
          where: quoteScope,
          _count: { _all: true },
          _sum: { totalAmount: true },
        }),
        tx.job.count({
          where: {
            ...visibleJobWhere(access),
            status: { in: ACTIVE_JOB_STATUSES },
          },
        }),
        tx.customer.findMany({
          where: customerScope,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 5,
          select: {
            id: true,
            fullName: true,
            followUpStatus: true,
            createdAt: true,
            quotes: {
              where: quoteScope,
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 1,
              select: {
                id: true,
                title: true,
                status: true,
                totalAmount: true,
                updatedAt: true,
              },
            },
          },
        }),
        tx.quote.findMany({
          where: {
            ...quoteScope,
            OR: [
              { status: "DRAFT" },
              { status: "READY_FOR_REVIEW" },
              { status: "SENT_TO_CUSTOMER" },
              { status: "ACCEPTED", afterSaleFollowUpStatus: "DUE" },
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: 12,
          select: {
            id: true,
            customerId: true,
            title: true,
            status: true,
            totalAmount: true,
            updatedAt: true,
            afterSaleFollowUpStatus: true,
            afterSaleFollowUpDueAtUtc: true,
            customer: { select: { fullName: true } },
          },
        }),
        tx.customer.findMany({
          where: {
            ...customerScope,
            followUpStatus: { notIn: ["WON", "LOST"] },
            quotes: { none: quoteScope },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 6,
          select: {
            id: true,
            fullName: true,
            createdAt: true,
          },
        }),
        tx.quote.findMany({
          where: quoteScope,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 5,
          select: {
            id: true,
            title: true,
            status: true,
            totalAmount: true,
            updatedAt: true,
            customer: { select: { id: true, fullName: true } },
          },
        }),
      ]);

      const quoteStatusCounts = Object.fromEntries(
        QUOTE_STATUSES.map((status) => [status, 0]),
      ) as Record<QuoteStatus, number>;
      let activeQuotes = 0;
      let openPipelineRevenue = 0;
      let acceptedRevenue = 0;
      let afterSaleDue = 0;

      for (const group of quoteGroups) {
        const count = group._count._all;
        const totalAmount = Number(group._sum.totalAmount ?? 0);
        quoteStatusCounts[group.status] += count;
        if (["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER"].includes(group.status)) {
          activeQuotes += count;
        }
        if (["READY_FOR_REVIEW", "SENT_TO_CUSTOMER"].includes(group.status)) {
          openPipelineRevenue += totalAmount;
        }
        if (group.status === "ACCEPTED") {
          acceptedRevenue += totalAmount;
          if (group.afterSaleFollowUpStatus === "DUE") afterSaleDue += count;
        }
      }

      const activeCustomers = customerGroups.reduce((total, group) => total + group._count._all, 0);
      const needsFollowUp = customerGroups.find((group) => group.followUpStatus === "NEEDS_FOLLOW_UP")?._count._all ?? 0;

      const attentionByCustomer = new Map<string, {
        customerId: string;
        customerName: string;
        quoteId: string | null;
        quoteTitle: string | null;
        quoteStatus: QuoteStatus | null;
        totalAmount: number | null;
        reason: AttentionReason;
        occurredAt: string;
        priority: number;
      }>();

      for (const quote of attentionQuotes) {
        const reason: AttentionReason =
          quote.status === "ACCEPTED" && quote.afterSaleFollowUpStatus === "DUE"
            ? "AFTER_SALE_DUE"
            : quote.status === "SENT_TO_CUSTOMER"
              ? "AWAITING_RESPONSE"
              : quote.status === "READY_FOR_REVIEW"
                ? "READY_TO_SEND"
                : "DRAFT_TO_FINISH";
        const candidate = {
          customerId: quote.customerId,
          customerName: quote.customer.fullName,
          quoteId: quote.id,
          quoteTitle: quote.title,
          quoteStatus: quote.status,
          totalAmount: Number(quote.totalAmount),
          reason,
          occurredAt: (quote.afterSaleFollowUpDueAtUtc ?? quote.updatedAt).toISOString(),
          priority: attentionPriority(reason),
        };
        const current = attentionByCustomer.get(quote.customerId);
        if (
          !current ||
          candidate.priority < current.priority ||
          (candidate.priority === current.priority && candidate.occurredAt < current.occurredAt)
        ) {
          attentionByCustomer.set(quote.customerId, candidate);
        }
      }

      for (const customer of unquotedCustomers) {
        if (attentionByCustomer.has(customer.id)) continue;
        const reason: AttentionReason = "NEEDS_FIRST_QUOTE";
        attentionByCustomer.set(customer.id, {
          customerId: customer.id,
          customerName: customer.fullName,
          quoteId: null,
          quoteTitle: null,
          quoteStatus: null,
          totalAmount: null,
          reason,
          occurredAt: customer.createdAt.toISOString(),
          priority: attentionPriority(reason),
        });
      }

      const attention = [...attentionByCustomer.values()]
        .sort((left, right) => left.priority - right.priority || left.occurredAt.localeCompare(right.occurredAt))
        .slice(0, 6)
        .map(({ priority: _priority, ...item }) => item);

      return {
        generatedAtUtc: new Date().toISOString(),
        metrics: {
          activeCustomers,
          unquotedLeads: unquotedLeadCount,
          needsFollowUp,
          activeQuotes,
          openPipelineRevenue,
          acceptedRevenue,
          activeJobs: activeJobCount,
          afterSaleDue,
        },
        quoteStatusCounts,
        attention,
        recentCustomers: recentCustomers.map((customer) => ({
          id: customer.id,
          fullName: customer.fullName,
          followUpStatus: customer.followUpStatus,
          createdAt: customer.createdAt.toISOString(),
          latestQuote: customer.quotes[0]
            ? {
                ...customer.quotes[0],
                totalAmount: Number(customer.quotes[0].totalAmount),
                updatedAt: customer.quotes[0].updatedAt.toISOString(),
              }
            : null,
        })),
        recentQuotes: recentQuotes.map((quote) => ({
          ...quote,
          totalAmount: Number(quote.totalAmount),
          updatedAt: quote.updatedAt.toISOString(),
        })),
      };
    }, {
      timeout: 10_000,
    }));

    reply.header("Cache-Control", "private, no-store");
    return overview;
  });
};
