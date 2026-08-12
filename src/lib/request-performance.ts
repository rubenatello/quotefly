import type { FastifyReply, FastifyRequest } from "fastify";

export type RequestPerformanceMetric = "auth" | "workspace" | "db" | "ai";

type RequestPerformanceState = {
  startNs: bigint;
  metrics: Partial<Record<RequestPerformanceMetric, number>>;
};

const requestPerformance = new WeakMap<FastifyRequest, RequestPerformanceState>();

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

export function durationMsSince(startNs: bigint): number {
  return Number(nowNs() - startNs) / 1_000_000;
}

export function startRequestPerformance(request: FastifyRequest): void {
  requestPerformance.set(request, {
    startNs: nowNs(),
    metrics: {},
  });
}

export function recordRequestPerformance(
  request: FastifyRequest,
  metric: RequestPerformanceMetric,
  durationMs: number,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  const state = requestPerformance.get(request);
  if (!state) return;

  state.metrics[metric] = (state.metrics[metric] ?? 0) + durationMs;
}

export async function measureRequestPerformance<T>(
  request: FastifyRequest,
  metric: RequestPerformanceMetric,
  operation: () => Promise<T>,
): Promise<T> {
  const startNs = nowNs();
  try {
    return await operation();
  } finally {
    recordRequestPerformance(request, metric, durationMsSince(startNs));
  }
}

export function getRequestPerformanceSummary(request: FastifyRequest) {
  const state = requestPerformance.get(request);
  if (!state) {
    return {
      durationMs: 0,
      metrics: {} as Partial<Record<RequestPerformanceMetric, number>>,
    };
  }

  const metrics: Partial<Record<RequestPerformanceMetric, number>> = {};
  for (const [metric, durationMs] of Object.entries(state.metrics)) {
    metrics[metric as RequestPerformanceMetric] = roundMs(durationMs);
  }

  return {
    durationMs: roundMs(durationMsSince(state.startNs)),
    metrics,
  };
}

function serverTimingToken(name: string, durationMs: number): string {
  return `${name};dur=${roundMs(durationMs)}`;
}

export function applyRequestPerformanceHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  includeServerTiming: boolean,
): void {
  reply.header("X-Request-Id", request.id);

  if (!includeServerTiming) return;

  const summary = getRequestPerformanceSummary(request);
  const tokens = [serverTimingToken("app", summary.durationMs)];
  for (const metric of ["auth", "workspace", "db", "ai"] as const) {
    const durationMs = summary.metrics[metric];
    if (durationMs !== undefined) {
      tokens.push(serverTimingToken(metric, durationMs));
    }
  }

  reply.header("Server-Timing", tokens.join(", "));
}

export function clearRequestPerformance(request: FastifyRequest): void {
  requestPerformance.delete(request);
}
