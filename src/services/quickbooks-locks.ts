import { Prisma } from "@prisma/client";

// Acquire the parent before connection/event/operation rows. Later audit and
// inbox INSERTs take this same foreign-key lock; taking it late can deadlock
// against a manager transaction that holds the tenant while awaiting a child.
export async function lockQuickBooksTenantParent(transaction: Prisma.TransactionClient, tenantId: string) {
  return transaction.$queryRaw<Array<{ id: string; deletedAtUtc: Date | null }>>(Prisma.sql`
    SELECT "id", "deletedAtUtc" FROM "Tenant" WHERE "id" = ${tenantId} FOR KEY SHARE
  `);
}

export async function lockQuickBooksConnection(transaction: Prisma.TransactionClient, tenantId: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "QuickBooksConnection" WHERE "tenantId" = ${tenantId} FOR UPDATE
  `);
}

// Disconnect/retry may append an audit for an earlier actor. Stabilize the
// tenant first and lock both that actor and the current caller before taking
// the connection. This also covers finalizers carrying a saved actor context.
export async function lockQuickBooksLifecycleParents(
  transaction: Prisma.TransactionClient, tenantId: string, actorTenantUserId?: string | null,
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT membership."id" FROM "TenantUser" membership
    WHERE membership."tenantId" = ${tenantId} AND (
      membership."id" = ${actorTenantUserId ?? null}
      OR membership."id" = (
        SELECT event."actorTenantUserId" FROM "QuickBooksConnectionEvent" event
        WHERE event."tenantId" = ${tenantId} AND event."action" = 'DISCONNECT_REQUESTED'
        ORDER BY event."connectionGeneration" DESC, event."createdAt" DESC, event."id" DESC LIMIT 1
      )
    ) ORDER BY membership."id" FOR KEY SHARE OF membership
  `);
}
