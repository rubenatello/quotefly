import { createHash, timingSafeEqual } from "node:crypto";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import { resolveRuntimeReleaseSha } from "../lib/release-identity";
import {
  evaluateQuickBooksOperationalSnapshot,
  loadQuickBooksOperationalSnapshot,
  type QuickBooksOperationalRuntime,
  type QuickBooksOperationalSnapshot,
} from "../services/quickbooks-operational-health";

const QUICKBOOKS_MONITOR_RATE_LIMIT_MAX = 6;
const QUICKBOOKS_MONITOR_RATE_LIMIT_WINDOW = "1 minute";
const QUICKBOOKS_MONITOR_RATE_LIMIT_KEY = "qbo-operational-monitor";

type QuickBooksOperationalMonitorRouteOptions = Readonly<{
  loadSnapshot?: typeof loadQuickBooksOperationalSnapshot;
  now?: () => Date;
  resolveReleaseSha?: () => string | null;
}>;

function bearerTokenFromAuthorization(authorization: string | undefined): string {
  const match = /^Bearer ([^\s,]+)$/.exec(authorization ?? "");
  return match?.[1] ?? "";
}

export function quickBooksMonitorBearerMatches(
  authorization: string | undefined,
  configuredBearer: string,
): boolean {
  const expected = configuredBearer.trim();
  const provided = bearerTokenFromAuthorization(authorization);
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  return expected.length >= 32
    && provided.length > 0
    && timingSafeEqual(expectedDigest, providedDigest);
}

function monitorRuntime(app: Parameters<FastifyPluginAsync>[0]): QuickBooksOperationalRuntime {
  return {
    environment: app.env.QUICKBOOKS_ENVIRONMENT,
    providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
    oauthOnlyMode: app.env.QUICKBOOKS_OAUTH_ONLY_MODE,
    reconciliationWorkerEnabled: app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
    cdcWorkerEnabled: app.env.QUICKBOOKS_CDC_WORKER_ENABLED,
    requireWorkerReleaseIdentity: app.env.NODE_ENV === "production",
  };
}

export const quickBooksOperationalMonitorRoutes: FastifyPluginAsync<
  QuickBooksOperationalMonitorRouteOptions
> = async (app, options) => {
  const loadSnapshot = options.loadSnapshot ?? loadQuickBooksOperationalSnapshot;
  const now = options.now ?? (() => new Date());
  const resolveReleaseSha = options.resolveReleaseSha ?? resolveRuntimeReleaseSha;
  const rateLimit = app.createRateLimit({
    max: QUICKBOOKS_MONITOR_RATE_LIMIT_MAX,
    timeWindow: QUICKBOOKS_MONITOR_RATE_LIMIT_WINDOW,
    skipOnError: false,
    keyGenerator: () => QUICKBOOKS_MONITOR_RATE_LIMIT_KEY,
  });

  const protect = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const configuredBearer = app.env.QUICKBOOKS_MONITOR_BEARER.trim();
    if (configuredBearer.length < 32) {
      return reply.code(503).send();
    }
    if (!quickBooksMonitorBearerMatches(request.headers.authorization, configuredBearer)) {
      reply.header("WWW-Authenticate", 'Bearer realm="quotefly-quickbooks-monitor"');
      return reply.code(401).send();
    }

    // Only an authenticated probe can consume the shared evaluation quota.
    // The key never depends on request.ip or forwarding headers, so spoofed
    // X-Forwarded-For values cannot bypass or exhaust the legitimate bucket.
    try {
      const result = await rateLimit(request);
      if (!result.isAllowed && result.isExceeded) {
        return reply.code(429).send();
      }
    } catch {
      request.log.error(
        { eventCode: "QUICKBOOKS_MONITOR_RATE_LIMIT_UNAVAILABLE" },
        "QuickBooks operational monitor rate-limit evaluation failed.",
      );
      return reply.code(503).send();
    }
  };

  const evaluate = async (
    tier: "warning" | "critical",
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const evaluatedAtUtc = now();
      const runtime = monitorRuntime(app);
      const snapshot: QuickBooksOperationalSnapshot = await loadSnapshot(app.prisma, runtime, {
        apiReleaseSha: resolveReleaseSha(),
        now: evaluatedAtUtc,
      });
      const evaluation = evaluateQuickBooksOperationalSnapshot(runtime, snapshot, evaluatedAtUtc);
      const unhealthy = tier === "warning"
        ? evaluation.warningUnhealthy
        : evaluation.criticalUnhealthy;
      return reply.code(unhealthy ? 503 : 204).send();
    } catch {
      request.log.error(
        { eventCode: "QUICKBOOKS_MONITOR_EVALUATION_FAILED", tier },
        "QuickBooks operational monitor evaluation failed.",
      );
      return reply.code(503).send();
    }
  };

  const routeOptions: RouteShorthandOptions = {
    config: { rateLimit: false },
    preHandler: [protect],
  };

  app.get("/internal/quickbooks/monitor/warning", routeOptions, async (request, reply) =>
    evaluate("warning", request, reply));
  app.get("/internal/quickbooks/monitor/critical", routeOptions, async (request, reply) =>
    evaluate("critical", request, reply));
};
