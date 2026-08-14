import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { healthRoutes } from "../../src/routes/health";

const openApps: Array<ReturnType<typeof Fastify>> = [];

function buildHealthServer(
  queryRaw: (...args: unknown[]) => Promise<unknown>,
  nodeEnv: "test" | "production" = "test",
) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", {
    $queryRaw: queryRaw,
  });
  app.decorate("env", { NODE_ENV: nodeEnv });
  app.register(healthRoutes, { prefix: "/v1" });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("health and readiness routes", () => {
  test("keeps liveness independent from the database", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("The liveness route must not query the database.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "quotefly-api" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test("returns ready only after the database probe succeeds", async () => {
    const queryRaw = vi.fn(async () => {
      if (queryRaw.mock.calls.length === 1) return [{ value: 1 }];
      return [
        { tableName: "AiIndexJob", enabled: true, forced: true },
        { tableName: "AiRetrievalAuditEvent", enabled: true, forced: true },
        { tableName: "AiRetrievalChunk", enabled: true, forced: true },
        { tableName: "AiRetrievalDocument", enabled: true, forced: true },
      ];
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready", service: "quotefly-api" });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  test("returns a stable safe response when the database probe fails", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("Database failure for secret-user at private-host.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("secret-user");
    expect(response.body).not.toContain("private-host");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  test("returns not ready when the deployed database schema is stale", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("The column User.legalAcceptedAtUtc does not exist.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("legalAcceptedAtUtc");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  test("returns not ready when the password recovery migration is missing", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("The table PasswordResetToken does not exist.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("PasswordResetToken");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  test("returns not ready when the immutable brand asset migration is missing", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("The table TenantBrandAsset does not exist.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("TenantBrandAsset");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  test("returns not ready when the workspace assignment migration is missing", async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error("The column Customer.assignedTenantUserId does not exist.");
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("assignedTenantUserId");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  test("returns not ready when AI retrieval RLS is missing or not forced", async () => {
    const queryRaw = vi.fn(async () => {
      if (queryRaw.mock.calls.length === 1) return [{ value: 1 }];
      return [
        { tableName: "AiIndexJob", enabled: true, forced: true },
        { tableName: "AiRetrievalAuditEvent", enabled: true, forced: true },
        { tableName: "AiRetrievalChunk", enabled: true, forced: false },
        { tableName: "AiRetrievalDocument", enabled: true, forced: true },
      ];
    });
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("AiRetrievalChunk");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  test("production readiness verifies the connected least-privileged runtime role", async () => {
    const queryRaw = vi.fn(async () => {
      if (queryRaw.mock.calls.length === 1) return [{ value: 1 }];
      if (queryRaw.mock.calls.length === 2) {
        return [
          { tableName: "AiIndexJob", enabled: true, forced: true },
          { tableName: "AiRetrievalAuditEvent", enabled: true, forced: true },
          { tableName: "AiRetrievalChunk", enabled: true, forced: true },
          { tableName: "AiRetrievalDocument", enabled: true, forced: true },
        ];
      }
      return [{
        currentUser: "quotefly_runtime",
        sessionUser: "quotefly_runtime",
        superuser: false,
        bypassRls: false,
        protectedTableOwner: false,
        hasMemberships: false,
      }];
    });
    const app = buildHealthServer(queryRaw, "production");

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  test("production readiness rejects a runtime role with a privilege escalation path", async () => {
    const queryRaw = vi.fn(async () => {
      if (queryRaw.mock.calls.length === 1) return [{ value: 1 }];
      if (queryRaw.mock.calls.length === 2) {
        return [
          { tableName: "AiIndexJob", enabled: true, forced: true },
          { tableName: "AiRetrievalAuditEvent", enabled: true, forced: true },
          { tableName: "AiRetrievalChunk", enabled: true, forced: true },
          { tableName: "AiRetrievalDocument", enabled: true, forced: true },
        ];
      }
      return [{
        currentUser: "quotefly_runtime",
        sessionUser: "quotefly_runtime",
        superuser: false,
        bypassRls: false,
        protectedTableOwner: false,
        hasMemberships: true,
      }];
    });
    const app = buildHealthServer(queryRaw, "production");

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service is not ready." });
    expect(response.body).not.toContain("quotefly_runtime");
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });
});
