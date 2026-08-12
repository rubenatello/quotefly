import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { healthRoutes } from "../../src/routes/health";

const openApps: Array<ReturnType<typeof Fastify>> = [];

function buildHealthServer(
  queryRaw: () => Promise<unknown>,
) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", {
    $queryRaw: queryRaw,
  });
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
    const queryRaw = vi.fn(async () => [{ value: 1 }]);
    const app = buildHealthServer(queryRaw);

    const response = await app.inject({ method: "GET", url: "/v1/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready", service: "quotefly-api" });
    expect(queryRaw).toHaveBeenCalledOnce();
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
});
