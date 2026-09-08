import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import rateLimit, { type fastifyRateLimit } from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import Redis from "ioredis";
import { quickBooksOperationalMonitorRoutes } from "../../src/routes/quickbooks-operational-monitor";
import type { QuickBooksOperationalSnapshot } from "../../src/services/quickbooks-operational-health";

const MONITOR_URL = "/internal/quickbooks/monitor/critical";
const MONITOR_BEARER = "quickbooks-monitor-rate-limit-test-bearer";
const testRedisUrl = process.env.TEST_RATE_LIMIT_REDIS_URL?.trim();

const HEALTHY_SNAPSHOT: QuickBooksOperationalSnapshot = {
  operations: {
    webhookOutstandingCount: 0,
    webhookDeadCount: 0,
    oldestWebhookOutstandingAgeMs: null,
    reconciliationRequiredCount: 0,
    oldestReconciliationRequiredAgeMs: null,
    cdcCursorCount: 0,
    cdcTerminalCount: 0,
    cdcOverdueCount: 0,
    maximumCdcLagMs: null,
    connectionRevocationPendingCount: 0,
    connectionRevocationDeadCount: 0,
    oldestConnectionRevocationPendingAgeMs: null,
    orphanRevocationPendingCount: 0,
    orphanRevocationDeadCount: 0,
    oldestOrphanRevocationPendingAgeMs: null,
    tokenRefreshFailureConnectionCount: 0,
    tokenRefreshReauthRequiredCount: 0,
    oldestTokenRefreshFailureAgeMs: null,
  },
  workerFleet: null,
};

class FailingRateLimitStore implements fastifyRateLimit.FastifyRateLimitStore {
  incr(
    _key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
  ): void {
    callback(new Error("rate-limit-store-unavailable"));
  }

  child(): fastifyRateLimit.FastifyRateLimitStore {
    return this;
  }
}

async function buildMonitorApp(options: {
  redis?: Redis;
  nameSpace?: string;
  store?: fastifyRateLimit.FastifyRateLimitStoreCtor;
  onSnapshotLoad?: () => void;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("env", {
    NODE_ENV: "test",
    QUICKBOOKS_MONITOR_BEARER: MONITOR_BEARER,
    QUICKBOOKS_ENVIRONMENT: "sandbox",
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true,
    QUICKBOOKS_OAUTH_ONLY_MODE: true,
    QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: false,
    QUICKBOOKS_CDC_WORKER_ENABLED: false,
  });
  app.decorate("prisma", {} as PrismaClient);
  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: "1 minute",
    skipOnError: false,
    ...(options.redis ? { redis: options.redis } : {}),
    ...(options.nameSpace ? { nameSpace: options.nameSpace } : {}),
    ...(options.store ? { store: options.store } : {}),
  });
  await app.register(quickBooksOperationalMonitorRoutes, {
    loadSnapshot: async () => {
      options.onSnapshotLoad?.();
      return HEALTHY_SNAPSHOT;
    },
  });
  await app.ready();
  return app;
}

function monitorRequest(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: MONITOR_URL,
    headers: { authorization: `Bearer ${MONITOR_BEARER}` },
  });
}

test("rate-limit 11.x aggregates IPv6 addresses within one /64 bucket", async () => {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 2,
    timeWindow: "1 minute",
    ipv6Subnet: 64,
    skipOnError: false,
  });
  app.get("/ipv6", async () => ({ ok: true }));
  await app.ready();
  try {
    const addresses = [
      "2001:db8:1234:5678::1",
      "2001:db8:1234:5678::2",
      "2001:db8:1234:5678:ffff::1",
    ];
    const responses = [];
    for (const remoteAddress of addresses) {
      responses.push(await app.inject({ method: "GET", url: "/ipv6", remoteAddress }));
    }
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 429]);
  } finally {
    await app.close();
  }
});

test("QuickBooks monitor fails closed with an empty 503 when its limiter store errors", async () => {
  let snapshotLoads = 0;
  const app = await buildMonitorApp({
    store: FailingRateLimitStore,
    onSnapshotLoad: () => { snapshotLoads += 1; },
  });
  try {
    const response = await monitorRequest(app);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body, "");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(snapshotLoads, 0);
  } finally {
    await app.close();
  }
});

test("QuickBooks monitor replicas share one six-request Redis quota", { skip: !testRedisUrl }, async () => {
  const namespace = `quotefly-qbo-monitor-test-${randomUUID()}-`;
  const clients = [
    new Redis(testRedisUrl!, { connectTimeout: 1_000, commandTimeout: 1_000, maxRetriesPerRequest: 1 }),
    new Redis(testRedisUrl!, { connectTimeout: 1_000, commandTimeout: 1_000, maxRetriesPerRequest: 1 }),
  ];
  const apps = await Promise.all(clients.map((redis) => buildMonitorApp({ redis, nameSpace: namespace })));
  try {
    const responses = [];
    for (let index = 0; index < 7; index += 1) {
      responses.push(await monitorRequest(apps[index % apps.length]!));
    }
    assert.deepEqual(responses.map((response) => response.statusCode), [204, 204, 204, 204, 204, 204, 429]);
    assert.equal(responses[6]?.body, "");
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    clients.forEach((client) => client.disconnect(false));
  }
});
