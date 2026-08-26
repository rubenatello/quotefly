export type AiQuoteProviderBudget = {
  callsUsed: number;
  readonly maxCalls: number;
  readonly deadlineAtMs: number;
  readonly perCallTimeoutMs: number;
};

export function createAiQuoteProviderBudget(options: {
  perCallTimeoutMs: number;
  operationTimeoutMs: number;
  maxCalls?: number;
}): AiQuoteProviderBudget {
  const maxCalls = Math.max(1, Math.min(options.maxCalls ?? 2, 2));
  const perCallTimeoutMs = Math.max(1_000, Math.min(options.perCallTimeoutMs, 60_000));
  const operationTimeoutMs = Math.max(1_000, Math.min(options.operationTimeoutMs, 60_000));
  return {
    callsUsed: 0,
    maxCalls,
    deadlineAtMs: Date.now() + operationTimeoutMs,
    perCallTimeoutMs,
  };
}

export function claimAiQuoteProviderTimeout(budget: AiQuoteProviderBudget): number {
  const remainingMs = budget.deadlineAtMs - Date.now();
  if (budget.callsUsed >= budget.maxCalls || remainingMs < 1_000) {
    throw new Error("AI quote provider budget exhausted before another call could start.");
  }
  budget.callsUsed += 1;
  return Math.max(1_000, Math.min(budget.perCallTimeoutMs, remainingMs));
}
