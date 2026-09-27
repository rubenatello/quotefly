import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";

type HistoryRow = {
  id: string;
  checksum: string;
  migrationName: string;
  startedAtUtc: string;
  finishedAtUtc: string | null;
  rolledBackAtUtc: string | null;
  appliedStepsCount: number;
  logs: string | null;
};

async function historyDigest() {
  const rows = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT id, checksum, migration_name AS "migrationName",
      started_at::text AS "startedAtUtc", finished_at::text AS "finishedAtUtc",
      rolled_back_at::text AS "rolledBackAtUtc", applied_steps_count AS "appliedStepsCount", logs
    FROM public."_prisma_migrations"
    ORDER BY started_at, id
  `);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function expectRuntimeDenied(statement: string) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRawUnsafe(statement);
      throw new Error("UNEXPECTED_RUNTIME_MIGRATION_HISTORY_WRITE");
    });
    throw new Error("UNEXPECTED_RUNTIME_MIGRATION_HISTORY_WRITE");
  } catch (error) {
    if (error instanceof Error && error.message === "UNEXPECTED_RUNTIME_MIGRATION_HISTORY_WRITE") throw error;
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const databaseCode = (error as Prisma.PrismaClientKnownRequestError).meta?.code;
    expect(databaseCode).toBe("42501");
  }
}

describe("migration history runtime privileges", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("keeps runtime history read-only, blocks PUBLIC, and preserves the owner path", async () => {
    const [catalog] = await prisma.$queryRaw<Array<{
      databaseIsTest: boolean;
      publicTableGrantCount: number;
      publicColumnGrantCount: number;
      runtimeColumnWriteCount: number;
      runtimeGrantOptionCount: number;
      reachableWriterRoleCount: number;
      runtimeSelect: boolean;
      runtimeInsert: boolean;
      runtimeUpdate: boolean;
      runtimeDelete: boolean;
      runtimeTruncate: boolean;
      runtimeReferences: boolean;
      runtimeTrigger: boolean;
      ownerInsert: boolean;
      ownerUpdate: boolean;
      ownerDelete: boolean;
    }>>(Prisma.sql`
      WITH history AS (
        SELECT oid, relowner, relacl FROM pg_class
        WHERE oid = 'public._prisma_migrations'::regclass
      ), runtime AS (
        SELECT oid FROM pg_roles WHERE rolname = 'quotefly_runtime'
      )
      SELECT current_database() ILIKE '%test%' AS "databaseIsTest",
        (SELECT count(*)::int FROM history
          CROSS JOIN LATERAL aclexplode(COALESCE(relacl, acldefault('r', relowner))) privilege
          WHERE privilege.grantee = 0) AS "publicTableGrantCount",
        (SELECT count(*)::int FROM pg_attribute history_column, history
          CROSS JOIN LATERAL aclexplode(COALESCE(history_column.attacl, acldefault('c', history.relowner))) privilege
          WHERE history_column.attrelid = history.oid
            AND history_column.attnum > 0 AND NOT history_column.attisdropped
            AND privilege.grantee = 0) AS "publicColumnGrantCount",
        (SELECT count(*)::int FROM pg_attribute history_column, history, runtime
          WHERE history_column.attrelid = history.oid
            AND history_column.attnum > 0 AND NOT history_column.attisdropped
            AND (has_column_privilege(runtime.oid, history.oid, history_column.attname, 'INSERT')
              OR has_column_privilege(runtime.oid, history.oid, history_column.attname, 'UPDATE')
              OR has_column_privilege(runtime.oid, history.oid, history_column.attname, 'REFERENCES'))) AS "runtimeColumnWriteCount",
        (SELECT count(*)::int FROM history, runtime
          CROSS JOIN LATERAL aclexplode(COALESCE(history.relacl, acldefault('r', history.relowner))) privilege
          WHERE privilege.grantee = runtime.oid AND privilege.is_grantable) AS "runtimeGrantOptionCount",
        (SELECT count(*)::int FROM pg_roles reachable_role, history, runtime
          WHERE reachable_role.oid <> runtime.oid
            AND (pg_has_role(runtime.oid, reachable_role.oid, 'USAGE')
              OR pg_has_role(runtime.oid, reachable_role.oid, 'SET'))
            AND (has_table_privilege(reachable_role.oid, history.oid, 'INSERT')
              OR has_table_privilege(reachable_role.oid, history.oid, 'UPDATE')
              OR has_table_privilege(reachable_role.oid, history.oid, 'DELETE')
              OR has_table_privilege(reachable_role.oid, history.oid, 'TRUNCATE')
              OR has_table_privilege(reachable_role.oid, history.oid, 'REFERENCES')
              OR has_table_privilege(reachable_role.oid, history.oid, 'TRIGGER')
              OR EXISTS (SELECT 1 FROM pg_attribute history_column
                WHERE history_column.attrelid = history.oid
                  AND history_column.attnum > 0 AND NOT history_column.attisdropped
                  AND (has_column_privilege(reachable_role.oid, history.oid, history_column.attname, 'INSERT')
                    OR has_column_privilege(reachable_role.oid, history.oid, history_column.attname, 'UPDATE')
                    OR has_column_privilege(reachable_role.oid, history.oid, history_column.attname, 'REFERENCES'))))) AS "reachableWriterRoleCount",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'SELECT') AS "runtimeSelect",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'INSERT') AS "runtimeInsert",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'UPDATE') AS "runtimeUpdate",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'DELETE') AS "runtimeDelete",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'TRUNCATE') AS "runtimeTruncate",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'REFERENCES') AS "runtimeReferences",
        has_table_privilege('quotefly_runtime', 'public._prisma_migrations', 'TRIGGER') AS "runtimeTrigger",
        has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') AS "ownerInsert",
        has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') AS "ownerUpdate",
        has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') AS "ownerDelete"
    `);
    expect(catalog).toEqual({
      databaseIsTest: true,
      publicTableGrantCount: 0,
      publicColumnGrantCount: 0,
      runtimeColumnWriteCount: 0,
      runtimeGrantOptionCount: 0,
      reachableWriterRoleCount: 0,
      runtimeSelect: true,
      runtimeInsert: false,
      runtimeUpdate: false,
      runtimeDelete: false,
      runtimeTruncate: false,
      runtimeReferences: false,
      runtimeTrigger: false,
      ownerInsert: true,
      ownerUpdate: true,
      ownerDelete: true,
    });

    const ownerCount = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM public."_prisma_migrations"`;
    const runtimeCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      return tx.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM public."_prisma_migrations"`;
    });
    expect(runtimeCount).toEqual(ownerCount);
  });

  test("rejects runtime INSERT, UPDATE, DELETE, and TRUNCATE without changing history", async () => {
    const before = await historyDigest();
    await expectRuntimeDenied(`
      INSERT INTO public."_prisma_migrations"
        (id, checksum, migration_name, started_at, applied_steps_count)
      VALUES ('synthetic-denied-migration', repeat('0', 64),
        'synthetic_denied_migration', now(), 0)
    `);
    await expectRuntimeDenied(`
      UPDATE public."_prisma_migrations" SET checksum = checksum WHERE false
    `);
    await expectRuntimeDenied(`
      DELETE FROM public."_prisma_migrations" WHERE false
    `);
    await expectRuntimeDenied(`TRUNCATE TABLE public."_prisma_migrations"`);
    expect(await historyDigest()).toBe(before);
  });
});
