import { z } from "zod";

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export function tenantScope(tenantId: string) {
  return { tenantId };
}

export function tenantActiveScope(tenantId: string) {
  return {
    tenantId,
    deletedAtUtc: null as null,
  };
}

export function tenantActiveCustomerScope(tenantId: string) {
  return {
    tenantId,
    archivedAtUtc: null as null,
    deletedAtUtc: null as null,
  };
}

export function tenantActiveQuoteScope(tenantId: string) {
  return {
    tenantId,
    archivedAtUtc: null as null,
    deletedAtUtc: null as null,
  };
}
