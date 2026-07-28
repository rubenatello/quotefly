import { FastifyPluginAsync } from "fastify";

const SERVICE_NAME = "quotefly-api";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;

      return {
        status: "ready",
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
      };
    } catch {
      request.log.error(
        { dependency: "database" },
        "Readiness dependency check failed.",
      );

      return reply.code(503).send({ error: "Service is not ready." });
    }
  });
};
