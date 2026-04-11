import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getJwtClaims } from "../lib/auth";
import { buildTenantEntitlements, startOfCurrentUtcMonth, startOfNextUtcMonth } from "../lib/subscription";
import { applyOnboardingSetup } from "../services/onboarding";

const BCRYPT_ROUNDS = 12;
const JWT_TTL = "7d";
const TRIAL_DAYS = 14;
const BCRYPT_DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.OQhW8q5f8B5s4NfR4xYfJwRoTSesFiW";

const SignUpSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8),
  fullName: z.string().trim().min(2),
  companyName: z.string().trim().min(2),
  primaryTrade: z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]),
  logoUrl: z.string().trim().max(1_500_000).optional(),
  generateLogoIfMissing: z.boolean().default(true),
});

const SignInSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

function slugifyCompanyName(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "tenant";
}

function nextSlugCandidate(baseSlug: string, attempt: number): string {
  if (attempt === 0) return baseSlug;
  return `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
}

function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function uniqueViolationTargets(error: Prisma.PrismaClientKnownRequestError): string[] {
  const target = error.meta?.target;

  if (Array.isArray(target)) {
    return target.map((value) => String(value));
  }

  if (typeof target === "string") {
    return [target];
  }

  return [];
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/auth/signup
  app.post("/auth/signup", async (request, reply) => {
    const payload = SignUpSchema.parse(request.body);
    const email = payload.email.toLowerCase();

    const existing = await app.prisma.user.findUnique({
      where: { email },
      select: { id: true, deletedAtUtc: true },
    });

    if (existing && !existing.deletedAtUtc) {
      return reply.code(409).send({ error: "An account with this email already exists." });
    }

    if (existing?.deletedAtUtc) {
      return reply
        .code(409)
        .send({ error: "This account email is reserved. Contact support to reactivate it." });
    }

    const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
    const baseSlug = slugifyCompanyName(payload.companyName);
    const trialStartsAtUtc = new Date();
    const trialEndsAtUtc = new Date(trialStartsAtUtc.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const slug = nextSlugCandidate(baseSlug, attempt);

      try {
        const [user, tenant] = await app.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email,
              fullName: payload.fullName,
              passwordHash,
            },
          });

          const newTenant = await tx.tenant.create({
            data: {
              name: payload.companyName,
              slug,
              primaryTrade: payload.primaryTrade,
              subscriptionStatus: "trialing",
              trialStartsAtUtc,
              trialEndsAtUtc,
              users: {
                create: { userId: newUser.id, role: "owner" },
              },
            },
          });

          await applyOnboardingSetup(tx, {
            tenantId: newTenant.id,
            companyName: payload.companyName,
            primaryTrade: payload.primaryTrade,
            logoUrl: payload.logoUrl,
            generateLogoIfMissing: payload.generateLogoIfMissing,
          });

          return [newUser, newTenant] as const;
        });

        const token = app.jwt.sign(
          { userId: user.id, tenantId: tenant.id, email: user.email, role: "owner" },
          { expiresIn: JWT_TTL },
        );

        return reply.code(201).send({
          token,
          user: { id: user.id, email: user.email, fullName: user.fullName },
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        const targets = uniqueViolationTargets(error);

        if (targets.some((target) => target.includes("email"))) {
          return reply.code(409).send({ error: "An account with this email already exists." });
        }

        if (!targets.some((target) => target.includes("slug"))) {
          throw error;
        }
      }
    }

    throw new Error("Could not create tenant slug after several attempts.");
  });

  // POST /v1/auth/signin
  app.post("/auth/signin", async (request, reply) => {
    const payload = SignInSchema.parse(request.body);
    const email = payload.email.toLowerCase();

    const user = await app.prisma.user.findUnique({
      where: { email },
      include: {
        tenantLink: {
          where: {
            deletedAtUtc: null,
            tenant: { deletedAtUtc: null },
          },
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
          },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });

    // Constant-time comparison to prevent timing attacks - always run bcrypt even when user is absent.
    const hashToCompare = user && !user.deletedAtUtc ? user.passwordHash : BCRYPT_DUMMY_HASH;
    const valid = await bcrypt.compare(payload.password, hashToCompare);

    if (!user || user.deletedAtUtc || !valid) {
      return reply.code(401).send({ error: "Invalid email or password." });
    }

    const tenantLink = user.tenantLink[0];
    if (!tenantLink) {
      return reply.code(403).send({ error: "Account has no active associated company." });
    }

    const token = app.jwt.sign(
      {
        userId: user.id,
        tenantId: tenantLink.tenantId,
        email: user.email,
        role: tenantLink.role,
      },
      { expiresIn: JWT_TTL },
    );

    return reply.send({
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant: { id: tenantLink.tenant.id, name: tenantLink.tenant.name, slug: tenantLink.tenant.slug },
    });
  });

  // GET /v1/auth/me  (protected)
  app.get("/auth/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);

    const membership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
        user: { deletedAtUtc: null },
        tenant: { deletedAtUtc: null },
      },
      include: {
        user: {
          select: { id: true, email: true, fullName: true, createdAt: true },
        },
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            subscriptionStatus: true,
            subscriptionPlanCode: true,
            primaryTrade: true,
            onboardingCompletedAtUtc: true,
            trialStartsAtUtc: true,
            trialEndsAtUtc: true,
            subscriptionCurrentPeriodEndUtc: true,
          },
        },
      },
    });

    if (!membership) {
      return reply.code(401).send({ error: "Session is no longer valid." });
    }

    const entitlements = buildTenantEntitlements({
      subscriptionStatus: membership.tenant.subscriptionStatus,
      subscriptionPlanCode: membership.tenant.subscriptionPlanCode,
      trialStartsAtUtc: membership.tenant.trialStartsAtUtc,
      trialEndsAtUtc: membership.tenant.trialEndsAtUtc,
      subscriptionCurrentPeriodEndUtc: membership.tenant.subscriptionCurrentPeriodEndUtc,
    }, new Date(), { userEmail: membership.user.email });

    const periodStart = startOfCurrentUtcMonth();
    const periodEnd = startOfNextUtcMonth();
    const [monthlyQuoteCount, monthlyAiQuoteCount] = await Promise.all([
      app.prisma.quote.count({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
          createdAt: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
      }),
      app.prisma.quote.count({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
          aiGeneratedAtUtc: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
      }),
    ]);

    return {
      user: membership.user,
      tenant: {
        ...membership.tenant,
        effectivePlanCode: entitlements.planCode,
        effectivePlanName: entitlements.planName,
        isTrial: entitlements.isTrial,
        entitlements,
        usage: {
          periodStartUtc: periodStart,
          periodEndUtc: periodEnd,
          monthlyQuoteCount,
          monthlyAiQuoteCount,
        },
      },
      role: membership.role,
    };
  });
};

