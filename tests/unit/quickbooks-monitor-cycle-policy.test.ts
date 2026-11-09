import assert from "node:assert/strict";
import test from "node:test";
import { deliverQuickBooksMonitorBatch, QuickBooksMonitorCyclePolicy, QuickBooksMonitorFailureLimitError } from "../../src/services/quickbooks-monitor-cycle-policy";

test("failure/success/failure resets exhaustion until exactly three consecutive failures", () => {
  const policy = new QuickBooksMonitorCyclePolicy();
  assert.doesNotThrow(() => policy.failed(false));
  assert.doesNotThrow(() => policy.failed(false));
  policy.completed();
  assert.doesNotThrow(() => policy.failed(false));
  assert.doesNotThrow(() => policy.failed(false));
  assert.throws(() => policy.failed(false), QuickBooksMonitorFailureLimitError);
});

test("failure exhaustion terminates after FAILED persistence and never writes STOPPED", async () => {
  const policy = new QuickBooksMonitorCyclePolicy();
  const heartbeats: string[] = [];
  const runFailedCycle = async () => {
    // The worker awaits its durable failure write before enforcing this policy.
    await Promise.resolve().then(() => heartbeats.push("FAILED"));
    policy.failed(false);
  };
  await runFailedCycle();
  await runFailedCycle();
  await assert.rejects(async () => {
    await runFailedCycle();
    heartbeats.push("STOPPED");
  }, { message: "QUICKBOOKS_MONITOR_FAILURE_LIMIT_REACHED" });
  assert.deepEqual(heartbeats, ["FAILED", "FAILED", "FAILED"]);
});

test("operator shutdown before or at threshold retains the graceful stop path", () => {
  for (const previousFailures of [0, 1, 2]) {
    const policy = new QuickBooksMonitorCyclePolicy();
    for (let index = 0; index < previousFailures; index += 1) policy.failed(false);
    assert.doesNotThrow(() => policy.failed(true));
  }
});

test("eight-second delivery timeouts finish durably but no new send begins after the 20s budget", async () => {
  let now = 0;
  const started: number[] = [];
  const completed: number[] = [];
  await deliverQuickBooksMonitorBatch(async () => {
    started.push(now);
    await Promise.resolve();
    now += 8_000;
    completed.push(now);
    return "retry";
  }, () => false, () => now);
  assert.deepEqual(started, [0, 8_000, 16_000]);
  assert.deepEqual(completed, [8_000, 16_000, 24_000]);
});

test("delivery budget is checked before every claim and is exclusive at exactly 20s", async () => {
  let now = 0;
  let sends = 0;
  await deliverQuickBooksMonitorBatch(async () => {
    sends += 1;
    now += 10_000;
    return "sent";
  }, () => false, () => now);
  assert.equal(sends, 2);
});

test("fast delivery still respects the 16-count cap and an idle queue stops immediately", async () => {
  let sends = 0;
  await deliverQuickBooksMonitorBatch(async () => { sends += 1; return "sent"; }, () => false, () => 0);
  assert.equal(sends, 16);
  sends = 0;
  await deliverQuickBooksMonitorBatch(async () => { sends += 1; return "idle"; }, () => false, () => 0);
  assert.equal(sends, 1);
});

test("shutdown starts no additional deliveries and preserves an in-flight result", async () => {
  let stopping = true;
  let sends = 0;
  const deliver = async () => { sends += 1; stopping = true; return "sent" as const; };
  await deliverQuickBooksMonitorBatch(deliver, () => stopping, () => 0);
  assert.equal(sends, 0);
  stopping = false;
  await deliverQuickBooksMonitorBatch(deliver, () => stopping, () => 0);
  assert.equal(sends, 1);
});

test("delivery failures propagate for the cycle failure policy instead of resetting it", async () => {
  const policy = new QuickBooksMonitorCyclePolicy();
  let sends = 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await assert.rejects(
      deliverQuickBooksMonitorBatch(async () => { sends += 1; throw new Error("synthetic failure"); }, () => false, () => 0),
      { message: "synthetic failure" },
    );
    if (cycle < 2) assert.doesNotThrow(() => policy.failed(false));
    else assert.throws(() => policy.failed(false), QuickBooksMonitorFailureLimitError);
  }
  assert.equal(sends, 3);
});
