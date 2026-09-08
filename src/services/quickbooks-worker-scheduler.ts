import { Prisma } from "@prisma/client";
import {
  buildTenantEntitlements,
  type TenantBillingSnapshot,
} from "../lib/subscription";

export const QUICKBOOKS_WORKER_TENANT_PAGE_SIZE = 50;

export type QuickBooksWorkerTenant = Readonly<{ id: string }>;
export type QuickBooksWorkerProviderTenant = QuickBooksWorkerTenant & TenantBillingSnapshot;

export type QuickBooksWorkerPageResult = Readonly<{
  tenantCount: number;
  nextAfterTenantId: string | null;
  cycleComplete: boolean;
}>;

/**
 * Visits at most one keyset page. The caller owns a cursor per work cadence
 * (webhooks, revocation, and CDC), which keeps every tick bounded while still
 * giving every tenant an eventual turn. An empty tail resets the next tick to
 * the start without issuing a second query in the current tick.
 */
export async function visitQuickBooksWorkerTenantPage<Tenant extends QuickBooksWorkerTenant>(options: {
  afterTenantId: string | null;
  loadPage: (afterTenantId: string | null, take: number) => Promise<readonly Tenant[]>;
  visit: (tenant: Tenant) => Promise<void>;
  pageSize?: number;
}): Promise<QuickBooksWorkerPageResult> {
  const pageSize = options.pageSize ?? QUICKBOOKS_WORKER_TENANT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) {
    throw new Error("QuickBooks worker page size must be between 1 and 250.");
  }

  const page = await options.loadPage(options.afterTenantId, pageSize);
  if (page.length > pageSize) {
    throw new Error("QuickBooks worker tenant loader exceeded its page bound.");
  }
  for (const tenant of page) {
    await options.visit(tenant);
  }

  if (page.length === 0 || page.length < pageSize) {
    return { tenantCount: page.length, nextAfterTenantId: null, cycleComplete: true };
  }
  const lastTenantId = page.at(-1)?.id;
  if (!lastTenantId || lastTenantId === options.afterTenantId) {
    throw new Error("QuickBooks worker tenant pagination did not advance.");
  }
  return { tenantCount: page.length, nextAfterTenantId: lastTenantId, cycleComplete: false };
}

/**
 * Provider reads, token refresh, reconciliation, and CDC are paid workspace
 * capabilities. Signed webhook envelopes remain durable while access is
 * paused; disconnect revocation and retention use the unfiltered scheduler.
 */
export function quickBooksWorkerProviderReadsAllowed(
  tenant: QuickBooksWorkerProviderTenant,
  now = new Date(),
): boolean {
  return buildTenantEntitlements(tenant, now).hasWorkspaceAccess;
}

/**
 * Revalidates provider-work entitlement while holding a shared lock on the
 * tenant billing row. Stripe reconciliation and other billing updates require
 * an incompatible row lock, so a worker cannot claim provider work from a
 * stale scheduler snapshot while billing is being changed.
 */
export async function lockQuickBooksWorkerProviderReadsAllowed(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  now = new Date(),
): Promise<boolean> {
  const tenants = await transaction.$queryRaw<QuickBooksWorkerProviderTenant[]>(Prisma.sql`
    SELECT
      "id",
      "subscriptionStatus",
      "subscriptionPlanCode",
      "stripeCustomerId",
      "stripeSubscriptionId",
      "trialStartsAtUtc",
      "trialEndsAtUtc",
      "subscriptionCurrentPeriodStartUtc",
      "subscriptionCurrentPeriodEndUtc"
    FROM "Tenant"
    WHERE "id" = ${tenantId}
      AND "deletedAtUtc" IS NULL
    FOR SHARE
  `);
  const tenant = tenants[0];
  return tenant ? quickBooksWorkerProviderReadsAllowed(tenant, now) : false;
}

export async function visitQuickBooksWorkerProviderTenantPage(options: {
  afterTenantId: string | null;
  loadPage: (
    afterTenantId: string | null,
    take: number,
  ) => Promise<readonly QuickBooksWorkerProviderTenant[]>;
  visit: (tenant: QuickBooksWorkerProviderTenant) => Promise<void>;
  pageSize?: number;
  now?: Date;
}): Promise<QuickBooksWorkerPageResult> {
  const evaluatedAtUtc = options.now ?? new Date();
  return visitQuickBooksWorkerTenantPage({
    afterTenantId: options.afterTenantId,
    loadPage: options.loadPage,
    visit: async (tenant) => {
      if (quickBooksWorkerProviderReadsAllowed(tenant, evaluatedAtUtc)) {
        await options.visit(tenant);
      }
    },
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
}
