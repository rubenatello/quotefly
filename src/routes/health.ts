import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";

const SERVICE_NAME = "quotefly-api";

function readinessErrorCode(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `PRISMA_${error.code}`;
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return error.errorCode ? `PRISMA_${error.errorCode}` : "PRISMA_INITIALIZATION";
  }
  return error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN";
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      await app.prisma.user.findFirst({
        select: {
          id: true,
          legalAcceptedAtUtc: true,
          termsVersion: true,
          privacyPolicyVersion: true,
          authVersion: true,
        },
      });
      await app.prisma.passwordResetToken.findFirst({ select: { id: true } });
      await app.prisma.tenantBrandAsset.findFirst({ select: { id: true, sha256: true } });
      await app.prisma.aiRetrievalDocument.findFirst({ select: { id: true, contentHash: true } });
      await app.prisma.aiRetrievalChunk.findFirst({ select: { id: true, contentHash: true } });

      return {
        status: "ready",
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      request.log.error(
        { dependency: "database", errorCode: readinessErrorCode(error) },
        "Readiness dependency check failed.",
      );

      return reply.code(503).send({ error: "Service is not ready." });
    }
  });
};
