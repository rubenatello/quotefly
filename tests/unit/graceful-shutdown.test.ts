import assert from "node:assert/strict";
import test from "node:test";
import { installGracefulApiShutdown } from "../../src/lib/graceful-shutdown";

type TestSignal = "SIGTERM" | "SIGINT";

function makeHarness(close: () => Promise<unknown>) {
  const listeners = new Map<TestSignal, () => void>();
  const logs: Array<{ level: "info" | "error"; fields: object; message?: string }> = [];
  const timers: Array<{ handler: () => void; unrefCalled: boolean; cleared: boolean }> = [];
  const exitCalls: number[] = [];
  const processControl = {
    exitCode: undefined as number | undefined,
    once: (signal: TestSignal, listener: () => void) => { listeners.set(signal, listener); },
    exit: (code: number): never => {
      exitCalls.push(code);
      throw new Error("TEST_FORCE_EXIT");
    },
  };

  installGracefulApiShutdown({
    close,
    logger: {
      info: (fields, message) => { logs.push({ level: "info", fields, message }); },
      error: (fields, message) => { logs.push({ level: "error", fields, message }); },
    },
    processControl,
    timeoutMs: 1_000,
    setTimer: (handler) => {
      const timer = { handler, unrefCalled: false, cleared: false };
      timers.push(timer);
      return {
        unref: () => { timer.unrefCalled = true; },
      } as NodeJS.Timeout;
    },
    clearTimer: () => { if (timers[0]) timers[0].cleared = true; },
  });

  return { listeners, logs, timers, exitCalls, processControl };
}

async function settlePromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("graceful API shutdown closes exactly once and does not force-exit after success", async () => {
  let closeCalls = 0;
  const harness = makeHarness(async () => { closeCalls += 1; });

  harness.listeners.get("SIGTERM")?.();
  harness.listeners.get("SIGINT")?.();
  await settlePromises();

  assert.equal(closeCalls, 1);
  assert.equal(harness.timers[0]?.unrefCalled, true);
  assert.equal(harness.timers[0]?.cleared, true);
  assert.deepEqual(harness.exitCalls, []);
  assert.equal(harness.processControl.exitCode, undefined);
  assert.deepEqual(harness.logs.map((entry) => entry.fields), [
    { eventCode: "API_GRACEFUL_SHUTDOWN_STARTED", signal: "SIGTERM" },
    { eventCode: "API_GRACEFUL_SHUTDOWN_COMPLETED", signal: "SIGTERM" },
  ]);
});

test("graceful API shutdown reports close failures without logging the error", async () => {
  const harness = makeHarness(async () => {
    throw new Error("database-url-and-token-must-not-log");
  });

  harness.listeners.get("SIGINT")?.();
  await settlePromises();

  assert.equal(harness.processControl.exitCode, 1);
  assert.equal(harness.timers[0]?.cleared, false);
  assert.deepEqual(harness.logs.map((entry) => entry.fields), [
    { eventCode: "API_GRACEFUL_SHUTDOWN_STARTED", signal: "SIGINT" },
    { eventCode: "API_GRACEFUL_SHUTDOWN_FAILED", signal: "SIGINT" },
  ]);
  assert.doesNotMatch(JSON.stringify(harness.logs), /must-not-log/);
});

test("graceful API shutdown force-fails with a fixed timeout signal", () => {
  const harness = makeHarness(() => new Promise(() => undefined));
  harness.listeners.get("SIGTERM")?.();

  assert.throws(() => harness.timers[0]?.handler(), /TEST_FORCE_EXIT/);
  assert.equal(harness.processControl.exitCode, 1);
  assert.deepEqual(harness.exitCalls, [1]);
  assert.deepEqual(harness.logs.at(-1)?.fields, {
    eventCode: "API_GRACEFUL_SHUTDOWN_TIMEOUT",
    signal: "SIGTERM",
  });
});
