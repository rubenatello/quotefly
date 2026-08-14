import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";

test("tenant RLS forwards an explicit bounded interactive transaction budget", async () => {
  const queryResults: unknown[] = [
    [{ tenantId: null }],
    [],
  ];
  const transaction = {
    $queryRaw: async () => queryResults.shift(),
  } as unknown as Prisma.TransactionClient;
  let capturedOptions: unknown;
  const client = {
    $transaction: async (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: unknown,
    ) => {
      capturedOptions = options;
      return operation(transaction);
    },
  } as unknown as PrismaClient;

  const result = await withTenantRlsContext(
    client,
    "tenant-health-audit",
    async () => "ok",
    { maxWait: 5_000, timeout: 15_000 },
  );

  assert.equal(result, "ok");
  assert.deepEqual(capturedOptions, { maxWait: 5_000, timeout: 15_000 });
  assert.equal(queryResults.length, 0);
});

test("nested tenant RLS calls reject transaction options they cannot enforce", async () => {
  const transaction = {
    $queryRaw: async () => [],
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    withTenantRlsContext(
      transaction,
      "tenant-health-audit",
      async () => "unreachable",
      { timeout: 15_000 },
    ),
    /require a Prisma client/,
  );
});
