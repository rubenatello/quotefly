import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import Redis from "ioredis";

const testRedisUrl = process.env.TEST_RATE_LIMIT_REDIS_URL?.trim();

test("Redis rate limits are shared across API replicas", { skip: !testRedisUrl }, async () => {
  const namespace = `quotefly-rate-limit-test-${randomUUID()}-`;
  const clients = [
    new Redis(testRedisUrl!, { connectTimeout: 1_000, commandTimeout: 1_000, maxRetriesPerRequest: 1 }),
    new Redis(testRedisUrl!, { connectTimeout: 1_000, commandTimeout: 1_000, maxRetriesPerRequest: 1 }),
  ];
  const apps = [];
  for (const redis of clients) {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 2,
      timeWindow: "1 minute",
      nameSpace: namespace,
      redis,
      skipOnError: false,
    });
    app.get("/probe", async () => ({ ok: true }));
    apps.push(app);
  }

  try {
    assert.equal((await apps[0]!.inject({ method: "GET", url: "/probe" })).statusCode, 200);
    assert.equal((await apps[1]!.inject({ method: "GET", url: "/probe" })).statusCode, 200);
    assert.equal((await apps[0]!.inject({ method: "GET", url: "/probe" })).statusCode, 429);
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    clients.forEach((client) => client.disconnect(false));
  }
});
