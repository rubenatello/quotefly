import { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isRetryableTransactionConflict,
  withTransactionConflictRetry,
} from "../../src/lib/transaction-retry";

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("transaction conflict", {
    code,
    clientVersion: "test",
    meta,
  });
}

describe("transaction conflict retry", () => {
  test("recognizes Prisma serialization and PostgreSQL deadlock errors", () => {
    assert.equal(isRetryableTransactionConflict(prismaError("P2034")), true);
    assert.equal(isRetryableTransactionConflict(prismaError("P2010", { code: "40P01" })), true);
    assert.equal(isRetryableTransactionConflict({ code: "40P01" }), true);
    assert.equal(isRetryableTransactionConflict(prismaError("P2002")), false);
  });

  test("replays the whole operation after a bounded retryable conflict", async () => {
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls === 1) throw prismaError("P2034");
      return "committed";
    };

    assert.equal(await withTransactionConflictRetry(operation, { baseDelayMs: 0 }), "committed");
    assert.equal(calls, 2);
  });

  test("does not replay nonretryable failures", async () => {
    const failure = prismaError("P2002");
    let calls = 0;
    const operation = async () => {
      calls += 1;
      throw failure;
    };

    await assert.rejects(withTransactionConflictRetry(operation, { baseDelayMs: 0 }), (error) => error === failure);
    assert.equal(calls, 1);
  });
});
