import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { measureRequestPerformance } from "../lib/request-performance";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";

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
      await measureRequestPerformance(request, "db", async () => {
        await app.prisma.$queryRaw`
          WITH
            user_probe AS (
              SELECT
                "id",
                "legalAcceptedAtUtc",
                "termsVersion",
                "privacyPolicyVersion",
                "authVersion"
              FROM "User"
              LIMIT 0
            ),
            password_reset_probe AS (
              SELECT "id"
              FROM "PasswordResetToken"
              LIMIT 0
            ),
            brand_asset_probe AS (
              SELECT "id", "sha256"
              FROM "TenantBrandAsset"
              LIMIT 0
            ),
            customer_assignment_probe AS (
              SELECT "id", "tenantId", "assignedTenantUserId"
              FROM "Customer"
              LIMIT 0
            ),
            quote_assignment_probe AS (
              SELECT "id", "tenantId", "assignedTenantUserId"
              FROM "Quote"
              LIMIT 0
            ),
            ai_document_probe AS (
              SELECT "id", "contentHash"
              FROM "AiRetrievalDocument"
              LIMIT 0
            ),
            ai_chunk_probe AS (
              SELECT "id", "contentHash"
              FROM "AiRetrievalChunk"
              LIMIT 0
            ),
            worker_heartbeat_probe AS (
              SELECT "workerKey", "heartbeatAtUtc", "status"
              FROM "WorkerHeartbeat"
              LIMIT 0
            )
          SELECT true AS "ready"
          FROM user_probe
          FULL JOIN password_reset_probe ON false
          FULL JOIN brand_asset_probe ON false
          FULL JOIN customer_assignment_probe ON false
          FULL JOIN quote_assignment_probe ON false
          FULL JOIN ai_document_probe ON false
          FULL JOIN ai_chunk_probe ON false
          FULL JOIN worker_heartbeat_probe ON false
        `;
        await assertAiRetrievalRlsReady(app.prisma, {
          requireRuntimeRole: app.env.NODE_ENV === "production",
        });
      });
    } catch (error) {
      request.log.error(
        { dependency: "database", errorCode: readinessErrorCode(error) },
        "Readiness dependency check failed.",
      );

      return reply.code(503).send({ error: "Service is not ready." });
    }

    if (app.rateLimitRedis) {
      try {
        await measureRequestPerformance(request, "rate_limit", async () => {
          await app.rateLimitRedis?.ping();
        });
      } catch (error) {
        request.log.error(
          { dependency: "rate_limit_store", errorCode: readinessErrorCode(error) },
          "Readiness dependency check failed.",
        );
        return reply.code(503).send({ error: "Service is not ready." });
      }
    }

    return {
      status: "ready",
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    };
  });
};
