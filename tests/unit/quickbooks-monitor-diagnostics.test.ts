import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { loadQuickBooksOperationalRow } from "../../src/services/quickbooks-operational-health";
import { classifyQuickBooksMonitorFailure, quickBooksMonitorCycleFailure, QUICKBOOKS_MONITOR_PHASES } from "../../src/services/quickbooks-monitor-diagnostics";

function prismaError(code: string, detail?: unknown) {
  return new Prisma.PrismaClientKnownRequestError("synthetic secret URL must not escape", {
    code, clientVersion: "synthetic", meta: { error: detail, url: "postgresql://synthetic-secret" },
  });
}

test("health row increases acquisition allowance while retaining RLS binding and 5s execution ceiling", async () => {
  const row = { tokenFailureCount: 0 };
  const queries: Prisma.Sql[] = [];
  let options: { maxWait: number; timeout: number } | undefined;
  const transaction = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      if (queries.length === 1) return [{ tenantId: null }];
      if (queries.length === 2) return [];
      return [row];
    },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    $transaction: async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, budget: typeof options) => {
      options = budget;
      // Model measured queue pressure exceeding Prisma's 2s default. This
      // operation must reach the tenant-bound query without widening execution.
      if ((budget?.maxWait ?? 2_000) < 4_200) throw prismaError("P2028", "Unable to start a transaction in given time");
      assert.equal(budget?.timeout, 5_000);
      return operation(transaction);
    },
  } as unknown as PrismaClient;
  assert.equal(await loadQuickBooksOperationalRow(prisma, "synthetic-tenant", new Date()), row);
  assert.deepEqual(options, { maxWait: 10_000, timeout: 5_000 });
  assert.equal(queries.length, 3);
  assert.match(queries[0].sql, /current_setting/);
  assert.match(queries[1].sql, /set_config/);
  assert.ok(queries[1].values.includes("synthetic-tenant"));
  assert.match(queries[2].sql, /QuickBooksWebhookEvent/);
  assert.ok(queries[2].values.includes("synthetic-tenant"));
});

test("diagnostics distinguish acquisition, execution, generic transaction and pool failures", () => {
  for (const detail of ["Unable to start a transaction in given time", "Unable to start a transaction in the given time."]) {
    assert.equal(classifyQuickBooksMonitorFailure(prismaError("P2028", detail)), "TRANSACTION_ACQUIRE_TIMEOUT");
  }
  for (const operation of ["query", "commit"]) {
    assert.equal(classifyQuickBooksMonitorFailure(prismaError("P2028", `Transaction already closed: A ${operation} cannot be executed on an expired transaction. The timeout was 5000 ms.`)), "TRANSACTION_EXECUTION_TIMEOUT");
  }
  for (const detail of [undefined, {}, "Transaction already closed: A query cannot be executed on a committed transaction.", "prefix Unable to start a transaction in given time"]) {
    assert.equal(classifyQuickBooksMonitorFailure(prismaError("P2028", detail)), "TRANSACTION_API_ERROR");
  }
  assert.equal(classifyQuickBooksMonitorFailure(prismaError("P2024")), "CONNECTION_POOL_TIMEOUT");
  assert.equal(classifyQuickBooksMonitorFailure(prismaError("P2002")), "DATABASE_REQUEST_FAILED");
});

test("cycle failure output has only fixed phases/codes and a bounded numeric elapsed time", () => {
  for (const phase of QUICKBOOKS_MONITOR_PHASES) {
    assert.deepEqual(quickBooksMonitorCycleFailure(phase, prismaError("P2028", "Unable to start a transaction in given time"), 4200.9), {
      event: "quickbooks_monitor_cycle_failed", phase, failureCode: "TRANSACTION_ACQUIRE_TIMEOUT", elapsedMs: 4200,
    });
  }
  for (const value of [Number.NaN, Infinity, -Infinity, -1]) {
    assert.equal(quickBooksMonitorCycleFailure("health_scan", undefined, value).elapsedMs, 0);
  }
  assert.equal(quickBooksMonitorCycleFailure("health_scan", undefined, Number.MAX_VALUE).elapsedMs, Number.MAX_SAFE_INTEGER);
});

test("hostile exceptions cannot inject provider data, keys, messages, metadata or phase into diagnostics", () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_LOG";
  const hostile = [
    secret, new Error(secret), { code: "P2028", message: secret, meta: { error: secret } },
    prismaError(secret, secret), prismaError("P2028", { toString: () => { throw new Error(secret); } }),
    new Proxy({}, { getPrototypeOf: () => { throw new Error(secret); } }),
    Object.defineProperty(prismaError("P2028"), "meta", { get: () => { throw new Error(secret); } }),
    Object.defineProperty(prismaError("P2028"), "code", { get: () => { throw new Error(secret); } }),
  ];
  for (const error of hostile) {
    const report = quickBooksMonitorCycleFailure(secret as never, error, 1);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("postgresql"), false);
    assert.deepEqual(Object.keys(report), ["event", "phase", "failureCode", "elapsedMs"]);
    assert.ok(QUICKBOOKS_MONITOR_PHASES.includes(report.phase));
  }
});
