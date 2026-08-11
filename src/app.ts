import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import fastifyRawBody from "fastify-raw-body";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { env } from "./config/env";
import { getJwtClaims, LiveAuthMembershipSelect } from "./lib/auth";
import { prisma } from "./lib/prisma";
import { buildTenantEntitlements } from "./lib/subscription";
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
import { quickBooksRoutes } from "./routes/quickbooks";
import { internalAdminRoutes } from "./routes/internal-admin";
import { feedbackRoutes } from "./routes/feedback";
import { swaggerPlugin } from "./plugins/swagger";

type CorsOriginCallback = (error: Error | null, origin: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsOriginCallback) => void;

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return null;
  }
}

function buildCorsOrigin(): CorsOriginFunction {
  const allowedOrigins = new Set(
    [env.APP_URL, env.API_URL, ...env.CORS_ALLOWED_ORIGINS.split(",")]
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  );

  return (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  };
}

const WORKSPACE_ACCESS_MUTATION_PREFIXES = [
  "/v1/customers",
  "/v1/quotes",
  "/v1/onboarding",
  "/v1/tenants",
  "/v1/org",
  "/v1/integrations/quickbooks",
];
const WORKSPACE_ACCESS_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_PROVIDER_MUTATION_PATHS = new Set([
  "/v1/integrations/quickbooks/webhook",
  "/v1/integrations/quickbooks/webhook/",
]);

function requestPathname(url: string): string {
  return url.split("?")[0] ?? url;
}

function requiresWorkspaceAccess(method: string, url: string): boolean {
  const pathname = requestPathname(url);
  const normalizedMethod = method.toUpperCase();

  if (PUBLIC_PROVIDER_MUTATION_PATHS.has(pathname)) {
    return false;
  }

  if (normalizedMethod === "GET" && /^\/v1\/quotes\/[^/]+\/pdf$/.test(pathname)) {
    return true;
  }

  if (!WORKSPACE_ACCESS_MUTATION_METHODS.has(normalizedMethod)) {
    return false;
  }

  return WORKSPACE_ACCESS_MUTATION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    env: typeof env;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function buildServer() {
  const app = Fastify({
    bodyLimit: 6 * 1024 * 1024,
    trustProxy: env.NODE_ENV === "production",
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
  app.decorateRequest("liveAuthMembership", null);

  // An app-level workspace-access hook and a route preHandler can both invoke
  // authenticate. Revalidate membership once per request without weakening the
  // live membership check.
  const membershipValidatedRequests = new WeakSet<FastifyRequest>();

  app.register(cors, {
    origin: buildCorsOrigin(),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
  app.register(cookie);
  app.register(formbody);
  app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
  app.register(helmet);
  app.register(rateLimit, {
    max: env.NODE_ENV === "test" ? 10_000 : 100,
    timeWindow: "1 minute",
  });
  app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: env.SESSION_COOKIE_NAME,
      signed: false,
    },
  });
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
    if (membershipValidatedRequests.has(request)) {
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    let claims;
    try {
      claims = getJwtClaims(request);
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const membership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
        user: { deletedAtUtc: null },
        tenant: { deletedAtUtc: null },
      },
      select: LiveAuthMembershipSelect,
    });

    if (!membership) {
      reply.code(401).send({ error: "Session is no longer valid." });
      return;
    }

    if (membership.user.authVersion !== claims.authVersion) {
      reply.code(401).send({ error: "Session is no longer valid." });
      return;
    }

    // Roles and email-based superuser entitlements must reflect the live
    // database state rather than the potentially stale JWT payload.
    Object.assign(request.user as object, {
      email: membership.user.email,
      role: membership.role,
    });
    request.liveAuthMembership = membership;
    membershipValidatedRequests.add(request);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!requiresWorkspaceAccess(request.method, request.url)) {
      return;
    }

    await app.authenticate(request, reply);
    if (reply.sent) return;

    const claims = getJwtClaims(request);
    const membership = request.liveAuthMembership;
    if (!membership) return reply.code(401).send({ error: "Session is no longer valid." });
    const entitlements = buildTenantEntitlements(
      membership.tenant,
      new Date(),
      { userEmail: membership.user.email },
    );

    if (!entitlements.hasWorkspaceAccess) {
      return reply.code(402).send({
        code: "BILLING_REQUIRED",
        error: "A Basic subscription is required to continue using this workspace.",
        requiredPlan: "starter",
        planCode: entitlements.planCode,
        planName: entitlements.planName,
        accessReason: entitlements.accessReason,
        billingRequired: entitlements.billingRequired,
      });
    }
  });

  app.register(healthRoutes, { prefix: "/v1" });
  app.register(authRoutes, { prefix: "/v1" });
  app.register(feedbackRoutes, { prefix: "/v1" });
  app.register(tenantRoutes, { prefix: "/v1" });
  app.register(customerRoutes, { prefix: "/v1" });
  app.register(quoteRoutes, { prefix: "/v1" });
  app.register(billingRoutes, { prefix: "/v1" });
  app.register(onboardingRoutes, { prefix: "/v1" });
  app.register(orgUserRoutes, { prefix: "/v1" });
  app.register(quickBooksRoutes, { prefix: "/v1" });
  app.register(internalAdminRoutes, { prefix: "/v1" });
  if (env.ENABLE_TWILIO_SMS) {
    app.register(smsRoutes, { prefix: "/v1" });
  }
  app.register(brandingRoutes, { prefix: "/v1" });

  app.addHook("onClose", async () => {
    await app.prisma.$disconnect();
  });

  return app;
}
