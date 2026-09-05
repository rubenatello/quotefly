import { describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  buildQuickBooksCdcWorkItems,
  pageQuickBooksProviderEntityIds,
  QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM,
} from "../../src/services/quickbooks-cdc";
import {
  visitQuickBooksWorkerProviderTenantPage,
  visitQuickBooksWorkerTenantPage,
} from "../../src/services/quickbooks-worker-scheduler";

const tenants = Array.from({ length: 1_205 }, (_, index) => ({
  id: `tenant-${String(index).padStart(4, "0")}`,
}));

function loadTenantPage(loads: Array<string | null>) {
  return async (afterTenantId: string | null, take: number) => {
    loads.push(afterTenantId);
    const start = afterTenantId === null
      ? 0
      : tenants.findIndex((tenant) => tenant.id === afterTenantId) + 1;
    return tenants.slice(start, start + take);
  };
}

describe("QuickBooks reconciliation worker scheduling", () => {
  test("bounds one idle tick independently of total tenant count", async () => {
    const loads: Array<string | null> = [];
    const visited: string[] = [];
    const result = await visitQuickBooksWorkerTenantPage({
      afterTenantId: null,
      pageSize: 50,
      loadPage: loadTenantPage(loads),
      visit: async (tenant) => { visited.push(tenant.id); },
    });

    expect(loads).toEqual([null]);
    expect(visited).toHaveLength(50);
    expect(result).toEqual({ tenantCount: 50, nextAfterTenantId: "tenant-0049", cycleComplete: false });
  });

  test("round-robin pages eventually visit more than 1000 tenants without starvation", async () => {
    const loads: Array<string | null> = [];
    const visited: string[] = [];
    let cursor: string | null = null;
    let cycleComplete = false;
    let ticks = 0;
    while (!cycleComplete) {
      const result = await visitQuickBooksWorkerTenantPage({
        afterTenantId: cursor,
        pageSize: 250,
        loadPage: loadTenantPage(loads),
        visit: async (tenant) => { visited.push(tenant.id); },
      });
      cursor = result.nextAfterTenantId;
      cycleComplete = result.cycleComplete;
      ticks += 1;
    }

    expect(ticks).toBe(5);
    expect(visited).toEqual(tenants.map((tenant) => tenant.id));
    expect(new Set(visited).size).toBe(1_205);
    expect(loads).toEqual([null, "tenant-0249", "tenant-0499", "tenant-0749", "tenant-0999"]);
    expect(cursor).toBeNull();
  });

  test("independent cadence cursors prevent webhook activity from starving revocation or CDC", async () => {
    const loads: Array<string | null> = [];
    const visited = { webhook: [] as string[], revocation: [] as string[], cdc: [] as string[] };
    const cursors: Record<keyof typeof visited, string | null> = { webhook: null, revocation: null, cdc: null };

    for (const cadence of ["webhook", "webhook", "revocation", "webhook", "cdc"] as const) {
      const result = await visitQuickBooksWorkerTenantPage({
        afterTenantId: cursors[cadence],
        pageSize: 25,
        loadPage: loadTenantPage(loads),
        visit: async (tenant) => { visited[cadence].push(tenant.id); },
      });
      cursors[cadence] = result.nextAfterTenantId;
    }

    expect(visited.webhook).toHaveLength(75);
    expect(visited.revocation).toEqual(tenants.slice(0, 25).map((tenant) => tenant.id));
    expect(visited.cdc).toEqual(tenants.slice(0, 25).map((tenant) => tenant.id));
    expect(cursors.webhook).toBe("tenant-0074");
    expect(cursors.revocation).toBe("tenant-0024");
    expect(cursors.cdc).toBe("tenant-0024");
  });

  test("pauses provider work for billing-ineligible tenants without pausing lifecycle cleanup", async () => {
    const now = new Date("2026-09-04T20:00:00.000Z");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await Promise.all([
      prisma.tenant.create({
        data: {
          name: "QuickBooks Eligible Worker Tenant",
          slug: `qbo-worker-eligible-${suffix}`,
          subscriptionStatus: "trialing",
          trialStartsAtUtc: new Date(now.getTime() - 86_400_000),
          trialEndsAtUtc: new Date(now.getTime() + 86_400_000),
        },
      }),
      prisma.tenant.create({
        data: {
          name: "QuickBooks Billing-Paused Worker Tenant",
          slug: `qbo-worker-paused-${suffix}`,
          subscriptionStatus: "past_due",
          subscriptionPlanCode: "starter",
          stripeCustomerId: `cus_qbo_worker_paused_${suffix}`,
          stripeSubscriptionId: `sub_qbo_worker_paused_${suffix}`,
          trialStartsAtUtc: new Date(now.getTime() - 3 * 86_400_000),
          trialEndsAtUtc: new Date(now.getTime() - 2 * 86_400_000),
          subscriptionCurrentPeriodStartUtc: new Date(now.getTime() - 2 * 86_400_000),
          subscriptionCurrentPeriodEndUtc: new Date(now.getTime() - 86_400_000),
        },
      }),
    ]);
    const tenantIds = created.map(({ id }) => id);
    const loadPage = async (_afterTenantId: string | null, take: number) => prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
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

    try {
      const providerReadTenants: string[] = [];
      await visitQuickBooksWorkerProviderTenantPage({
        afterTenantId: null,
        loadPage,
        now,
        visit: async (tenant) => { providerReadTenants.push(tenant.id); },
      });
      expect(providerReadTenants).toEqual([created[0]!.id]);

      const lifecycleCleanupTenants: string[] = [];
      await visitQuickBooksWorkerTenantPage({
        afterTenantId: null,
        loadPage,
        visit: async (tenant) => { lifecycleCleanupTenants.push(tenant.id); },
      });
      expect(new Set(lifecycleCleanupTenants)).toEqual(new Set(tenantIds));
    } finally {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
  });

  test("oversized provider fan-out is paged so the next tenant still receives a turn", async () => {
    const providerInvoiceIds = Array.from({ length: 35 }, (_, index) =>
      `provider-invoice-${String(index).padStart(3, "0")}`,
    );
    const reconciledByTenant = new Map<string, string[]>();
    const page = await visitQuickBooksWorkerTenantPage({
      afterTenantId: null,
      pageSize: 2,
      loadPage: async (_afterTenantId, take) => tenants.slice(0, take),
      visit: async (tenant) => {
        const providerPage = pageQuickBooksProviderEntityIds(
          tenant.id === tenants[0]!.id ? providerInvoiceIds : ["provider-invoice-next-tenant"],
        );
        reconciledByTenant.set(tenant.id, [...providerPage.providerEntityIds]);
        if (tenant.id === tenants[0]!.id) {
          expect(providerPage.remainingProviderEntityIds).toHaveLength(25);
        }
      },
    });

    expect(reconciledByTenant.get(tenants[0]!.id)).toHaveLength(QUICKBOOKS_RECONCILIATIONS_PER_WORK_ITEM);
    expect(reconciledByTenant.get(tenants[1]!.id)).toEqual(["provider-invoice-next-tenant"]);
    expect(page.tenantCount).toBe(2);
  });

  test("provider fan-out continuation drains deterministically without duplicates", () => {
    const providerInvoiceIds = Array.from({ length: 25 }, (_, index) =>
      `provider-invoice-${String(index).padStart(3, "0")}`,
    ).reverse();
    const drained: string[] = [];
    let pending = providerInvoiceIds;
    do {
      const page = pageQuickBooksProviderEntityIds(pending);
      drained.push(...page.providerEntityIds);
      if (page.remainingProviderEntityIds.length === 0) break;
      pending = [...page.remainingProviderEntityIds];
    } while (true);

    expect(drained).toEqual([...providerInvoiceIds].sort((left, right) => left.localeCompare(right)));
    expect(new Set(drained)).toHaveLength(25);
  });

  test("CDC per-entity worklists do not skip a new ID inserted before an earlier response", () => {
    const updatedAt = "2026-08-27T20:00:00.000Z";
    const invoice = (Id: string) => ({ Id, MetaData: { LastUpdatedTime: updatedAt } });
    const first = buildQuickBooksCdcWorkItems({
      realmId: "realm-fairness",
      invoices: [..."BCDEFGHIJK"].map(invoice),
      payments: [],
      refundReceipts: [],
      fallbackUpdatedAtUtc: new Date(updatedAt),
    });
    const second = buildQuickBooksCdcWorkItems({
      realmId: "realm-fairness",
      invoices: [..."ABCDEFGHIJK"].map(invoice),
      payments: [],
      refundReceipts: [],
      fallbackUpdatedAtUtc: new Date(updatedAt),
    });
    const durableInbox = new Map([...first, ...second].map((item) => [item.webhookEventId, item]));

    expect([...durableInbox.values()].map((item) => item.entityId).sort()).toEqual([..."ABCDEFGHIJK"]);
    expect(first.every((item) => durableInbox.has(item.webhookEventId))).toBe(true);
  });

  test("CDC emits a durable RefundReceipt recovery item", () => {
    const updatedAt = "2026-08-27T20:02:00.000Z";
    const work = buildQuickBooksCdcWorkItems({
      realmId: "realm-refund-recovery",
      invoices: [],
      payments: [],
      refundReceipts: [{
        Id: "refund-receipt-cdc",
        TotalAmt: 40,
        CustomerRef: { value: "customer-cdc" },
        CurrencyRef: { value: "USD" },
        MetaData: { LastUpdatedTime: updatedAt },
        LinkedTxn: [
          { TxnId: "payment-cdc", TxnType: "Payment" },
          { TxnId: "invoice-cdc", TxnType: "Invoice" },
        ],
      }],
      fallbackUpdatedAtUtc: new Date(updatedAt),
    });

    expect(work).toEqual([
      expect.objectContaining({
        eventType: "RefundReceipt",
        entityId: "refund-receipt-cdc",
        operation: "Update",
        payload: expect.objectContaining({ quoteflyTrigger: "CDC" }),
      }),
    ]);
  });

  test("Payment worklist remains stable when the next provider snapshot inserts an earlier ID", () => {
    const firstSnapshot = [..."BCDEFGHIJK"].map((id) => `provider-invoice-${id}`);
    const firstPage = pageQuickBooksProviderEntityIds(firstSnapshot, 5);
    const shiftedProviderSnapshot = [..."ABCDEFGHIJK"].map((id) => `provider-invoice-${id}`);
    const durableRemaining = [...firstPage.remainingProviderEntityIds];
    const drained = [...firstPage.providerEntityIds];
    while (durableRemaining.length > 0) {
      const next = pageQuickBooksProviderEntityIds(durableRemaining, 5);
      drained.push(...next.providerEntityIds);
      durableRemaining.splice(0, durableRemaining.length, ...next.remainingProviderEntityIds);
    }

    expect(drained).toEqual(firstSnapshot);
    expect(shiftedProviderSnapshot[0]).toBe("provider-invoice-A");
    expect(new Set(drained)).toHaveLength(firstSnapshot.length);
  });
});
