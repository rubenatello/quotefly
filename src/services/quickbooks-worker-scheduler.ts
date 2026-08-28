export const QUICKBOOKS_WORKER_TENANT_PAGE_SIZE = 50;

export type QuickBooksWorkerTenant = Readonly<{ id: string }>;

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
export async function visitQuickBooksWorkerTenantPage(options: {
  afterTenantId: string | null;
  loadPage: (afterTenantId: string | null, take: number) => Promise<readonly QuickBooksWorkerTenant[]>;
  visit: (tenant: QuickBooksWorkerTenant) => Promise<void>;
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
