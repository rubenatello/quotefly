import { performance } from "node:perf_hooks";

const MAX_CONSECUTIVE_FAILED_CYCLES = 3;
const MAX_DELIVERIES_PER_CYCLE = 16;
const DELIVERY_BATCH_BUDGET_MS = 20_000;

export class QuickBooksMonitorFailureLimitError extends Error {
  constructor() {
    super("QUICKBOOKS_MONITOR_FAILURE_LIMIT_REACHED");
    this.name = "QuickBooksMonitorFailureLimitError";
  }
}

/** Only an entirely successful sample (including heartbeat) resets the streak. */
export class QuickBooksMonitorCyclePolicy {
  private consecutiveFailures = 0;

  completed(): void {
    this.consecutiveFailures = 0;
  }

  failed(stopping: boolean): void {
    this.consecutiveFailures += 1;
    // An operator-requested shutdown retains the normal STOPPED heartbeat flow.
    if (!stopping && this.consecutiveFailures >= MAX_CONSECUTIVE_FAILED_CYCLES) {
      throw new QuickBooksMonitorFailureLimitError();
    }
  }
}

/**
 * Stop claiming deliveries once the elapsed budget expires. An in-flight send
 * keeps its existing provider timeout and durable result handling; never race or
 * abandon it. A final send may extend beyond 20 seconds by its own bounded time.
 */
export async function deliverQuickBooksMonitorBatch(
  deliver: () => Promise<"idle" | "sent" | "retry" | "terminal">,
  stopping: () => boolean,
  monotonicNow: () => number = () => performance.now(),
): Promise<void> {
  const startedAt = monotonicNow();
  for (let index = 0; index < MAX_DELIVERIES_PER_CYCLE; index += 1) {
    if (stopping() || monotonicNow() - startedAt >= DELIVERY_BATCH_BUDGET_MS) break;
    if (await deliver() === "idle") break;
  }
}
