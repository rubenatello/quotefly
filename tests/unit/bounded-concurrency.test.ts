import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../../src/lib/bounded-concurrency";

test("mapWithConcurrency keeps database-style work below its declared bound", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(Array.from({ length: 25 }, (_, index) => index), 4, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 4);
  assert.deepEqual(results, Array.from({ length: 25 }, (_, index) => index * 2));
});

test("mapWithConcurrency rejects unsafe bounds", async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async (value) => value));
});
