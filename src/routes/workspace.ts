import type { FastifyPluginAsync } from "fastify";
import type { QuoteStatus } from "@prisma/client";
import { getJwtClaims } from "../lib/auth";
import { buildAccessContext } from "../lib/access-policy";
import { tenantActiveCustomerScope, tenantActiveQuoteScope } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { assignedRecordScope } from "../lib/workspace-assignment";

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

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
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

    const overview = await measureRequestPerformance(request, "db", () => app.prisma.$transaction(async (tx) => {
      const [
        customerGroups,
        unquotedLeadCount,
        quoteGroups,
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
          by: ["status", "jobStatus", "afterSaleFollowUpStatus"],
          where: quoteScope,
          _count: { _all: true },
          _sum: { totalAmount: true },
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
            jobStatus: true,
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
      let activeJobs = 0;
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
          if (group.jobStatus !== "COMPLETED") activeJobs += count;
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
          activeJobs,
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
