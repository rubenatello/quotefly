import { Prisma } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { setTenantRlsContext } from "../lib/tenant-rls";

type Transaction = Prisma.TransactionClient;

const CustomerMappingSelect = {
  customerId: true,
  quickBooksCustomerId: true,
  quickBooksDisplayName: true,
  reviewedAtUtc: true,
  reviewVersion: true,
} as const satisfies Prisma.QuickBooksCustomerMapSelect;

const ItemMappingSelect = {
  itemKey: true,
  quickBooksItemId: true,
  quickBooksItemName: true,
  workPresetId: true,
  reviewedAtUtc: true,
  reviewVersion: true,
} as const satisfies Prisma.QuickBooksItemMapSelect;

export class QuickBooksMappingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireManager(access: AccessContext) {
  if (!hasCapability(access, "manageIntegrations")) {
    throw new QuickBooksMappingError(403, "QUICKBOOKS_MAPPING_FORBIDDEN", "Only owners or admins can review QuickBooks mappings.");
  }
}

export function normalizeQuickBooksItemKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

export async function reviewQuickBooksCustomerMapping(
  transaction: Transaction,
  access: AccessContext,
  params: {
    connectionId: string;
    customerId: string;
    quickBooksCustomerId: string;
    quickBooksDisplayName: string;
  },
) {
  requireManager(access);
  await setTenantRlsContext(transaction, access.tenantId);
  const [connection, customer, collision] = await Promise.all([
    transaction.quickBooksConnection.findFirst({
      where: { id: params.connectionId, tenantId: access.tenantId, status: "CONNECTED", deletedAtUtc: null },
      select: { id: true },
    }),
    transaction.customer.findFirst({
      where: { id: params.customerId, tenantId: access.tenantId, archivedAtUtc: null, deletedAtUtc: null },
      select: { id: true },
    }),
    transaction.quickBooksCustomerMap.findFirst({
      where: {
        tenantId: access.tenantId,
        quickBooksConnectionId: params.connectionId,
        quickBooksCustomerId: params.quickBooksCustomerId,
        customerId: { not: params.customerId },
        deletedAtUtc: null,
      },
      select: { id: true },
    }),
  ]);
  if (!connection) throw new QuickBooksMappingError(409, "QUICKBOOKS_NOT_CONNECTED", "Reconnect QuickBooks before reviewing mappings.");
  if (!customer) throw new QuickBooksMappingError(404, "CUSTOMER_NOT_FOUND", "Customer not found for tenant.");
  if (collision) throw new QuickBooksMappingError(409, "QUICKBOOKS_CUSTOMER_ALREADY_MAPPED", "That QuickBooks customer is already mapped to another QuoteFly customer.");

  const now = new Date();
  return transaction.quickBooksCustomerMap.upsert({
    where: {
      quickBooksConnectionId_customerId: {
        quickBooksConnectionId: params.connectionId,
        customerId: params.customerId,
      },
    },
    create: {
      tenantId: access.tenantId,
      quickBooksConnectionId: params.connectionId,
      customerId: params.customerId,
      quickBooksCustomerId: params.quickBooksCustomerId,
      quickBooksDisplayName: params.quickBooksDisplayName,
      reviewedByTenantUserId: access.tenantUserId,
      reviewedAtUtc: now,
      reviewVersion: 1,
    },
    update: {
      quickBooksCustomerId: params.quickBooksCustomerId,
      quickBooksDisplayName: params.quickBooksDisplayName,
      reviewedByTenantUserId: access.tenantUserId,
      reviewedAtUtc: now,
      reviewVersion: { increment: 1 },
      deletedAtUtc: null,
    },
    select: CustomerMappingSelect,
  });
}

export async function reviewQuickBooksItemMapping(
  transaction: Transaction,
  access: AccessContext,
  params: {
    connectionId: string;
    itemKey: string;
    quickBooksItemId: string;
    quickBooksItemName: string;
    workPresetId?: string | null;
  },
) {
  requireManager(access);
  await setTenantRlsContext(transaction, access.tenantId);
  const itemKey = normalizeQuickBooksItemKey(params.itemKey);
  if (!itemKey) throw new QuickBooksMappingError(400, "QUICKBOOKS_ITEM_KEY_REQUIRED", "A line-item key is required.");
  const [connection, preset, collision] = await Promise.all([
    transaction.quickBooksConnection.findFirst({
      where: { id: params.connectionId, tenantId: access.tenantId, status: "CONNECTED", deletedAtUtc: null },
      select: { id: true },
    }),
    params.workPresetId
      ? transaction.workPreset.findFirst({
          where: { id: params.workPresetId, tenantId: access.tenantId, deletedAtUtc: null },
          select: { id: true },
        })
      : Promise.resolve(null),
    transaction.quickBooksItemMap.findFirst({
      where: {
        tenantId: access.tenantId,
        quickBooksConnectionId: params.connectionId,
        quickBooksItemId: params.quickBooksItemId,
        itemKey: { not: itemKey },
        deletedAtUtc: null,
      },
      select: { id: true },
    }),
  ]);
  if (!connection) throw new QuickBooksMappingError(409, "QUICKBOOKS_NOT_CONNECTED", "Reconnect QuickBooks before reviewing mappings.");
  if (params.workPresetId && !preset) throw new QuickBooksMappingError(404, "WORK_PRESET_NOT_FOUND", "Product or service not found for tenant.");
  if (collision) throw new QuickBooksMappingError(409, "QUICKBOOKS_ITEM_ALREADY_MAPPED", "That QuickBooks item is already mapped to another line-item key.");

  const now = new Date();
  return transaction.quickBooksItemMap.upsert({
    where: {
      quickBooksConnectionId_itemKey: {
        quickBooksConnectionId: params.connectionId,
        itemKey,
      },
    },
    create: {
      tenantId: access.tenantId,
      quickBooksConnectionId: params.connectionId,
      itemKey,
      quickBooksItemId: params.quickBooksItemId,
      quickBooksItemName: params.quickBooksItemName,
      workPresetId: params.workPresetId ?? null,
      sourceType: params.workPresetId ? "work_preset" : "line_description",
      reviewedByTenantUserId: access.tenantUserId,
      reviewedAtUtc: now,
      reviewVersion: 1,
    },
    update: {
      quickBooksItemId: params.quickBooksItemId,
      quickBooksItemName: params.quickBooksItemName,
      workPresetId: params.workPresetId ?? null,
      sourceType: params.workPresetId ? "work_preset" : "line_description",
      reviewedByTenantUserId: access.tenantUserId,
      reviewedAtUtc: now,
      reviewVersion: { increment: 1 },
      deletedAtUtc: null,
    },
    select: ItemMappingSelect,
  });
}
