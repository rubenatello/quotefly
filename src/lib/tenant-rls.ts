import { Prisma, type PrismaClient } from "@prisma/client";

const MAX_TENANT_ID_LENGTH = 191;

export type TenantRlsClient = PrismaClient | Prisma.TransactionClient;

export type TenantRlsTransactionOptions = Readonly<{
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}>;

export const AI_RETRIEVAL_RLS_TABLES = [
  "AiRetrievalDocument",
  "AiRetrievalChunk",
  "AiRetrievalAuditEvent",
  "AiIndexJob",
] as const;

export type AiRetrievalRlsStatus = Readonly<{
  tableName: (typeof AI_RETRIEVAL_RLS_TABLES)[number];
  enabled: boolean;
  forced: boolean;
}>;

export type AiRetrievalRuntimeRoleStatus = Readonly<{
  currentUser: string;
  sessionUser: string;
  superuser: boolean;
  bypassRls: boolean;
  protectedTableOwner: boolean;
  hasMemberships: boolean;
}>;

function isPrismaClient(client: TenantRlsClient): client is PrismaClient {
  return "$transaction" in client;
}

function normalizeTenantId(tenantId: string) {
  const normalized = tenantId.trim();
  if (!normalized || normalized.length > MAX_TENANT_ID_LENGTH) {
    throw new Error("A valid tenant context is required.");
  }
  return normalized;
}

/**
 * Binds PostgreSQL RLS to one tenant for the lifetime of the current
 * transaction. A transaction may reaffirm the same tenant, but it may never
 * switch tenants after work has started.
 */
export async function setTenantRlsContext(
  transaction: Prisma.TransactionClient,
  tenantId: string,
) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const rows = await transaction.$queryRaw<Array<{ tenantId: string | null }>>(Prisma.sql`
    SELECT NULLIF(current_setting('app.tenant_id', true), '') AS "tenantId"
  `);
  const currentTenantId = rows[0]?.tenantId ?? null;
  if (currentTenantId && currentTenantId !== normalizedTenantId) {
    throw new Error("Tenant context cannot be changed inside an active transaction.");
  }

  await transaction.$queryRaw(Prisma.sql`
    SELECT set_config('app.tenant_id', ${normalizedTenantId}, true)
  `);
}

/**
 * Runs tenant-protected queries on the same pooled connection and transaction
 * where SET LOCAL applies. Passing an existing Prisma transaction keeps larger
 * application writes atomic while still binding all RLS tables fail-closed.
 */
export async function withTenantRlsContext<T>(
  client: TenantRlsClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  options?: TenantRlsTransactionOptions,
): Promise<T> {
  if (!isPrismaClient(client)) {
    if (options) {
      throw new Error("Tenant RLS transaction options require a Prisma client.");
    }
    await setTenantRlsContext(client, tenantId);
    return operation(client);
  }

  return client.$transaction(async (transaction) => {
    await setTenantRlsContext(transaction, tenantId);
    return operation(transaction);
  }, options);
}

export async function inspectAiRetrievalRls(client: PrismaClient): Promise<AiRetrievalRlsStatus[]> {
  return client.$queryRaw<AiRetrievalRlsStatus[]>(Prisma.sql`
    SELECT
      c.relname AS "tableName",
      c.relrowsecurity AS "enabled",
      c.relforcerowsecurity AS "forced"
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname IN (${Prisma.join(AI_RETRIEVAL_RLS_TABLES)})
    ORDER BY c.relname
  `);
}

export async function inspectAiRetrievalRuntimeRole(
  client: PrismaClient,
): Promise<AiRetrievalRuntimeRoleStatus | null> {
  const rows = await client.$queryRaw<AiRetrievalRuntimeRoleStatus[]>(Prisma.sql`
    SELECT
      current_user AS "currentUser",
      session_user AS "sessionUser",
      role.rolsuper AS "superuser",
      role.rolbypassrls AS "bypassRls",
      EXISTS (
        SELECT 1
        FROM pg_class owned_table
        INNER JOIN pg_namespace owned_namespace ON owned_namespace.oid = owned_table.relnamespace
        WHERE owned_table.relowner = role.oid
          AND owned_namespace.nspname = current_schema()
          AND owned_table.relname IN (${Prisma.join(AI_RETRIEVAL_RLS_TABLES)})
      ) AS "protectedTableOwner",
      EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE membership.member = role.oid
      ) AS "hasMemberships"
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  return rows[0] ?? null;
}

export async function assertAiRetrievalRlsReady(
  client: PrismaClient,
  options: { requireRuntimeRole?: boolean } = {},
) {
  const rows = await inspectAiRetrievalRls(client);
  const statusByTable = new Map(rows.map((row) => [row.tableName, row]));
  for (const tableName of AI_RETRIEVAL_RLS_TABLES) {
    const status = statusByTable.get(tableName);
    if (!status?.enabled || !status.forced) {
      throw new Error(`AI_RETRIEVAL_RLS_NOT_FORCED:${tableName}`);
    }
  }

  if (options.requireRuntimeRole) {
    const role = await inspectAiRetrievalRuntimeRole(client);
    if (
      !role
      || role.currentUser !== "quotefly_runtime"
      || role.sessionUser !== "quotefly_runtime"
      || role.superuser
      || role.bypassRls
      || role.protectedTableOwner
      || role.hasMemberships
    ) {
      throw new Error("AI_RETRIEVAL_RUNTIME_ROLE_UNSAFE");
    }
  }
}
