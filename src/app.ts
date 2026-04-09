import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { healthRoutes } from "./routes/health";
import { tenantRoutes } from "./routes/tenants";
import { customerRoutes } from "./routes/customers";
import { quoteRoutes } from "./routes/quotes";
import { smsRoutes } from "./routes/sms";
import { authRoutes } from "./routes/auth";
import { brandingRoutes } from "./routes/branding";
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
  app.register(helmet);
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(jwt, { secret: env.JWT_SECRET });
  app.register(swaggerPlugin);

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
  if (env.ENABLE_TWILIO_SMS) {
    app.register(smsRoutes, { prefix: "/v1" });
  }
  app.register(brandingRoutes, { prefix: "/v1" });

  app.addHook("onClose", async () => {
    await app.prisma.$disconnect();
  });

  return app;
}
