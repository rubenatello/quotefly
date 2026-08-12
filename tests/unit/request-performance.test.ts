import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import {
  applyRequestPerformanceHeaders,
  measureRequestPerformance,
  startRequestPerformance,
} from "../../src/lib/request-performance";

const openApps: Array<ReturnType<typeof Fastify>> = [];

after(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function buildPerformanceHeaderApp(includeServerTiming: boolean) {
  const app = Fastify({ logger: false });
  openApps.push(app);

  app.addHook("onRequest", async (request) => {
    startRequestPerformance(request);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    applyRequestPerformanceHeaders(request, reply, includeServerTiming);
    return payload;
  });
  app.get("/probe/:id", async (request) => {
    await measureRequestPerformance(request, "db", async () => undefined);
    return { ok: true };
  });

  return app;
}

test("request id is exposed while server timing is hidden for production responses", async () => {
  const app = buildPerformanceHeaderApp(false);

  const response = await app.inject({ method: "GET", url: "/probe/secret-customer-id" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["x-request-id"] as string, /\S/);
  assert.equal(response.headers["server-timing"], undefined);
});

test("server timing can be exposed for local diagnostics without path data", async () => {
  const app = buildPerformanceHeaderApp(true);

  const response = await app.inject({ method: "GET", url: "/probe/secret-customer-id" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["x-request-id"] as string, /\S/);
  assert.match(response.headers["server-timing"] as string, /^app;dur=\d+(?:\.\d+)?, db;dur=\d+(?:\.\d+)?$/);
  assert.doesNotMatch(response.headers["server-timing"] as string, /secret-customer-id/);
});
