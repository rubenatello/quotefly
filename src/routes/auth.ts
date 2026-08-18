import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { FastifyPluginAsync, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { loadMonthlyAiUsageSnapshot } from "../lib/ai-usage";
import { enqueueTenantWorkPresetAiIndexJobs } from "../lib/ai-index-jobs";
import { BASIC_TRIAL_DAYS } from "../lib/billing-offer";
import { BrandLogoDataUrlSchema } from "../lib/brand-logo";
import { CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION } from "../lib/legal";
import { isSuperuserEmail } from "../lib/superuser";
import { buildTenantEntitlements, startOfCurrentUtcMonth, startOfNextUtcMonth } from "../lib/subscription";
import { applyOnboardingSetup } from "../services/onboarding";
import {
  isTransactionalEmailConfigured,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "../services/transactional-email";

const BCRYPT_ROUNDS = 12;
const JWT_TTL = "7d";
const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.OQhW8q5f8B5s4NfR4xYfJwRoTSesFiW";
const SignInRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;
const AuthMeRateLimit = { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } } as const;
const ForgotPasswordRateLimit = { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } } as const;
const ResetPasswordRateLimit = { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } } as const;
const PASSWORD_RESET_COOLDOWN_MS = 10 * 60 * 1000;
const PASSWORD_RESET_MIN_RESPONSE_MS = 750;
const PASSWORD_RESET_REQUEST_MESSAGE =
  "If an active QuoteFly account exists for that email, a password reset link is on its way.";

const SignUpSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(120),
  fullName: z.string().trim().min(2),
  companyName: z.string().trim().min(2),
  primaryTrade: z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]),
  logoUrl: BrandLogoDataUrlSchema.optional(),
  acceptedLegalTerms: z.literal(true),
  termsVersion: z.literal(CURRENT_TERMS_VERSION),
  privacyPolicyVersion: z.literal(CURRENT_PRIVACY_POLICY_VERSION),
});

const SignInSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(120),
});

const ForgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string().trim().min(43).max(200).regex(/^[A-Za-z0-9_-]+$/),
  password: z.string().min(8).max(120),
});

class PasswordResetRejectedError extends Error {}

function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function waitForMinimumResponseTime(startedAt: number): Promise<void> {
  const remainingMs = PASSWORD_RESET_MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

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

function sessionCookieBaseOptions(app: Parameters<FastifyPluginAsync>[0]) {
  const domain = app.env.SESSION_COOKIE_DOMAIN.trim();
  return {
    httpOnly: true,
    path: "/",
    sameSite: app.env.SESSION_COOKIE_SAME_SITE,
    secure: app.env.NODE_ENV === "production" || app.env.SESSION_COOKIE_SAME_SITE === "none",
    ...(domain ? { domain } : {}),
  } as const;
}

function setSessionCookie(app: Parameters<FastifyPluginAsync>[0], reply: FastifyReply, token: string) {
  reply.setCookie(app.env.SESSION_COOKIE_NAME, token, {
    ...sessionCookieBaseOptions(app),
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

function clearSessionCookie(app: Parameters<FastifyPluginAsync>[0], reply: FastifyReply) {
  reply.clearCookie(app.env.SESSION_COOKIE_NAME, sessionCookieBaseOptions(app));
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const signUpRateLimit = {
    config: {
      rateLimit: {
        max: app.env.NODE_ENV === "test" ? 100 : 5,
        timeWindow: "10 minutes",
      },
    },
  } as const;

  // POST /v1/auth/signup
  app.post("/auth/signup", signUpRateLimit, async (request, reply) => {
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
    const trialEndsAtUtc = new Date(
      trialStartsAtUtc.getTime() + BASIC_TRIAL_DAYS * 24 * 60 * 60 * 1000,
    );

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const slug = nextSlugCandidate(baseSlug, attempt);

      try {
        const [user, tenant] = await app.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email,
              fullName: payload.fullName,
              passwordHash,
              legalAcceptedAtUtc: new Date(),
              termsVersion: payload.termsVersion,
              privacyPolicyVersion: payload.privacyPolicyVersion,
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
          });
          await enqueueTenantWorkPresetAiIndexJobs(tx, { tenantId: newTenant.id });

          return [newUser, newTenant] as const;
        });

        const token = app.jwt.sign(
          {
            userId: user.id,
            tenantId: tenant.id,
            email: user.email,
            role: "owner",
            authVersion: user.authVersion,
          },
          { expiresIn: JWT_TTL },
        );

        setSessionCookie(app, reply, token);

        return reply.code(201).send({
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
  app.post("/auth/signin", SignInRateLimit, async (request, reply) => {
    const payload = SignInSchema.parse(request.body);
    const email = payload.email.toLowerCase();

    const user = await app.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        passwordHash: true,
        authVersion: true,
        deletedAtUtc: true,
        tenantLink: {
          where: {
            deletedAtUtc: null,
            tenant: { deletedAtUtc: null },
          },
          select: {
            tenantId: true,
            role: true,
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
        authVersion: user.authVersion,
      },
      { expiresIn: JWT_TTL },
    );

    setSessionCookie(app, reply, token);

    return reply.send({
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant: { id: tenantLink.tenant.id, name: tenantLink.tenant.name, slug: tenantLink.tenant.slug },
    });
  });

  // POST /v1/auth/forgot-password
  app.post("/auth/forgot-password", ForgotPasswordRateLimit, async (request, reply) => {
    const startedAt = Date.now();
    const payload = ForgotPasswordSchema.parse(request.body);
    const email = payload.email.toLowerCase();

    if (!isTransactionalEmailConfigured(app.env)) {
      await waitForMinimumResponseTime(startedAt);
      return reply.code(503).send({
        error: "Password recovery is temporarily unavailable. Please contact QuoteFly support.",
      });
    }

    const user = await app.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, deletedAtUtc: true },
    });

    if (user && !user.deletedAtUtc) {
      const cooldownStartedAt = new Date(Date.now() - PASSWORD_RESET_COOLDOWN_MS);
      const recentToken = await app.prisma.passwordResetToken.findFirst({
        where: {
          userId: user.id,
          usedAtUtc: null,
          expiresAtUtc: { gt: new Date() },
          createdAt: { gte: cooldownStartedAt },
        },
        select: { id: true },
      });

      if (!recentToken) {
        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = hashPasswordResetToken(rawToken);
        const expiresAtUtc = new Date(
          Date.now() + app.env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000,
        );
        const resetUrl = new URL("/reset-password", app.env.APP_URL);
        resetUrl.hash = new URLSearchParams({ token: rawToken }).toString();

        const resetToken = await app.prisma.$transaction(async (tx) => {
          // Serialize reset issuance per user. Without this lock, two requests can both
          // pass the cooldown check, send different links, and invalidate each other.
          await tx.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${user.id}`}))::text AS "lock"
          `;

          const tokenIssuedByConcurrentRequest = await tx.passwordResetToken.findFirst({
            where: {
              userId: user.id,
              usedAtUtc: null,
              expiresAtUtc: { gt: new Date() },
              createdAt: { gte: cooldownStartedAt },
            },
            select: { id: true },
          });

          if (tokenIssuedByConcurrentRequest) return null;

          return tx.passwordResetToken.create({
            data: { userId: user.id, tokenHash, expiresAtUtc },
            select: { id: true },
          });
        });

        if (resetToken) {
          try {
            await sendPasswordResetEmail(app.env, {
              to: user.email,
              resetUrl: resetUrl.toString(),
            });

            await app.prisma.passwordResetToken.updateMany({
              where: {
                userId: user.id,
                id: { not: resetToken.id },
                usedAtUtc: null,
              },
              data: { usedAtUtc: new Date() },
            });
          } catch (error) {
            await app.prisma.passwordResetToken.deleteMany({ where: { id: resetToken.id } });
            request.log.error(
              {
                provider: "resend",
                reason: error instanceof Error ? error.message : "unknown provider error",
              },
              "Password reset email delivery failed.",
            );
          }
        }
      }
    }

    await waitForMinimumResponseTime(startedAt);
    return reply.code(202).send({ message: PASSWORD_RESET_REQUEST_MESSAGE });
  });

  // POST /v1/auth/reset-password
  app.post("/auth/reset-password", ResetPasswordRateLimit, async (request, reply) => {
    const payload = ResetPasswordSchema.parse(request.body);
    const tokenHash = hashPasswordResetToken(payload.token);
    const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
    const now = new Date();

    let resetUserEmail: string | null;
    try {
      resetUserEmail = await app.prisma.$transaction(async (tx) => {
        const resetToken = await tx.passwordResetToken.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            userId: true,
            usedAtUtc: true,
            expiresAtUtc: true,
            user: { select: { email: true, deletedAtUtc: true } },
          },
        });

        if (
          !resetToken ||
          resetToken.usedAtUtc ||
          resetToken.expiresAtUtc <= now ||
          resetToken.user.deletedAtUtc
        ) {
          return null;
        }

        const claimed = await tx.passwordResetToken.updateMany({
          where: {
            id: resetToken.id,
            usedAtUtc: null,
            expiresAtUtc: { gt: now },
          },
          data: { usedAtUtc: now },
        });

        if (claimed.count !== 1) return null;

        const updatedUser = await tx.user.updateMany({
          where: { id: resetToken.userId, deletedAtUtc: null },
          data: {
            passwordHash,
            authVersion: { increment: 1 },
          },
        });

        if (updatedUser.count !== 1) {
          throw new PasswordResetRejectedError();
        }

        await tx.passwordResetToken.updateMany({
          where: { userId: resetToken.userId, usedAtUtc: null },
          data: { usedAtUtc: now },
        });

        return resetToken.user.email;
      });
    } catch (error) {
      if (error instanceof PasswordResetRejectedError) {
        resetUserEmail = null;
      } else {
        throw error;
      }
    }

    if (!resetUserEmail) {
      return reply.code(400).send({
        error: "This reset link is invalid or has expired. Request a new one.",
      });
    }

    clearSessionCookie(app, reply);

    try {
      await sendPasswordChangedEmail(app.env, resetUserEmail);
    } catch (error) {
      request.log.error(
        {
          provider: "resend",
          reason: error instanceof Error ? error.message : "unknown provider error",
        },
        "Password change notification delivery failed.",
      );
    }

    return reply.send({ message: "Password updated. You can now sign in." });
  });

  // POST /v1/auth/logout
  app.post("/auth/logout", async (_request, reply) => {
    clearSessionCookie(app, reply);
    return reply.code(204).send();
  });

  // GET /v1/auth/me  (protected)
  app.get("/auth/me", { ...AuthMeRateLimit, preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);

    const membership = request.liveAuthMembership;

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
    const [monthlyQuoteCount, aiUsageSnapshot] = await Promise.all([
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
      loadMonthlyAiUsageSnapshot(
        app.prisma,
        claims.tenantId,
        {
          credits: entitlements.limits.aiQuotesPerMonth,
          spendUsd: entitlements.limits.aiSpendUsdPerMonth,
        },
      ),
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
          periodStartUtc: aiUsageSnapshot.periodStartUtc,
          periodEndUtc: aiUsageSnapshot.periodEndUtc,
          monthlyQuoteCount,
          monthlyAiQuoteCount: aiUsageSnapshot.monthlyCreditsUsed,
          monthlyAiSpendUsd: aiUsageSnapshot.monthlySpendUsedUsd,
          monthlyAiSpendLimitUsd: aiUsageSnapshot.monthlySpendLimitUsd,
          monthlyAiSpendRemainingUsd: aiUsageSnapshot.monthlySpendRemainingUsd,
          monthlyAiSpendUsagePercent: aiUsageSnapshot.monthlySpendUsagePercent,
          monthlyAiSpendWarningThresholdPercent: aiUsageSnapshot.warningThresholdPercent,
          monthlyAiLimitReached: aiUsageSnapshot.limitReached,
          monthlyAiEstimatedPromptsRemaining: aiUsageSnapshot.estimatedPromptsRemaining,
        },
      },
      role: membership.role,
      isSuperuser: isSuperuserEmail(membership.user.email),
    };
  });
};

