import { Prisma } from "@prisma/client";

export const QUICKBOOKS_MONITOR_PHASES = [
  "health_scan",
  "reconciliation_heartbeat_read",
  "alert_evaluation",
  "alert_delivery",
  "terminal_count",
  "heartbeat_write",
] as const;
export type QuickBooksMonitorPhase = typeof QUICKBOOKS_MONITOR_PHASES[number];

export type QuickBooksMonitorFailureCode =
  | "TRANSACTION_ACQUIRE_TIMEOUT"
  | "TRANSACTION_EXECUTION_TIMEOUT"
  | "TRANSACTION_API_ERROR"
  | "DATABASE_REQUEST_FAILED"
  | "CONNECTION_POOL_TIMEOUT"
  | "UNCLASSIFIED_FAILURE";

/** Inspect only known Prisma error fields; no exception text is returned. */
export function classifyQuickBooksMonitorFailure(error: unknown): QuickBooksMonitorFailureCode {
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return "UNCLASSIFIED_FAILURE";
    if (error.code === "P2024") return "CONNECTION_POOL_TIMEOUT";
    if (error.code !== "P2028") return "DATABASE_REQUEST_FAILED";
    const detail = error.meta?.error;
    if (typeof detail === "string" && /^Unable to start a transaction in (?:the )?given time\.?$/.test(detail)) return "TRANSACTION_ACQUIRE_TIMEOUT";
    if (typeof detail === "string" && /^Transaction already closed: A (?:query|commit) cannot be executed on an expired transaction\./.test(detail)) {
      return "TRANSACTION_EXECUTION_TIMEOUT";
    }
    return "TRANSACTION_API_ERROR";
  } catch {
    // Defensive against accessors/proxies. Never inspect or stringify unknown
    // messages, stacks, causes, metadata objects, names, or provider payloads.
    return "UNCLASSIFIED_FAILURE";
  }
}

export function quickBooksMonitorCycleFailure(
  phase: QuickBooksMonitorPhase,
  error: unknown,
  elapsedMs: number,
): { event: "quickbooks_monitor_cycle_failed"; phase: QuickBooksMonitorPhase; failureCode: QuickBooksMonitorFailureCode; elapsedMs: number } {
  return {
    event: "quickbooks_monitor_cycle_failed" as const,
    phase: QUICKBOOKS_MONITOR_PHASES.includes(phase) ? phase : "health_scan",
    failureCode: classifyQuickBooksMonitorFailure(error),
    elapsedMs: Number.isFinite(elapsedMs) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(elapsedMs))) : 0,
  };
}
