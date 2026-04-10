import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import fastifyRawBody from "fastify-raw-body";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { healthRoutes } from "./routes/health";
import { tenantRoutes } from "./routes/tenants";
import { customerRoutes } from "./routes/customers";
import { quoteRoutes } from "./routes/quotes";
import { smsRoutes } from "./routes/sms";
import { authRoutes } from "./routes/auth";
import { brandingRoutes } from "./routes/branding";
import { billingRoutes } from "./routes/billing";
import { onboardingRoutes } from "./routes/onboarding";
import { orgUserRoutes } from "./routes/org-users";
import { swaggerPlugin } from "./plugins/swagger";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    env: typeof env;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function buildServer() {
  const app = Fastify({
    logger: {
      transport:
        env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
            }
          : undefined,
    },
  });

  app.decorate("prisma", prisma);
  app.decorate("env", env);

  app.register(cors, { origin: true });
  app.register(formbody);
  app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
  app.register(helmet);
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(jwt, { secret: env.JWT_SECRET });
  app.register(swaggerPlugin);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request data.",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    request.log.error(error);

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;

    return reply.code(statusCode).send({
      error:
        statusCode >= 500
          ? "Internal Server Error"
          : error instanceof Error
            ? error.message
            : "Request failed.",
    });
  });

  // Reusable preHandler hook for protected routes
  app.decorate("authenticate", async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.register(healthRoutes, { prefix: "/v1" });
  app.register(authRoutes, { prefix: "/v1" });
  app.register(tenantRoutes, { prefix: "/v1" });
  app.register(customerRoutes, { prefix: "/v1" });
  app.register(quoteRoutes, { prefix: "/v1" });
  app.register(billingRoutes, { prefix: "/v1" });
  app.register(onboardingRoutes, { prefix: "/v1" });
  app.register(orgUserRoutes, { prefix: "/v1" });
  if (env.ENABLE_TWILIO_SMS) {
    app.register(smsRoutes, { prefix: "/v1" });
  }
  app.register(brandingRoutes, { prefix: "/v1" });

  app.addHook("onClose", async () => {
    await app.prisma.$disconnect();
  });

  return app;
}
