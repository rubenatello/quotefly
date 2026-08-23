import { Prisma } from "@prisma/client";
import { FastifyRequest } from "fastify";
import { z } from "zod";

export const LiveAuthMembershipSelect = Prisma.validator<Prisma.TenantUserSelect>()({
  id: true,
  tenantId: true,
  userId: true,
  role: true,
  user: {
    select: {
      id: true,
      email: true,
      fullName: true,
      preferredLocale: true,
      authVersion: true,
      createdAt: true,
    },
  },
  tenant: {
    select: {
      id: true,
      name: true,
      slug: true,
      timezone: true,
      subscriptionStatus: true,
      subscriptionPlanCode: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      primaryTrade: true,
      onboardingCompletedAtUtc: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodStartUtc: true,
      subscriptionCurrentPeriodEndUtc: true,
    },
  },
});

export type LiveAuthMembership = Prisma.TenantUserGetPayload<{
  select: typeof LiveAuthMembershipSelect;
}>;

declare module "fastify" {
  interface FastifyRequest {
    liveAuthMembership: LiveAuthMembership | null;
  }
}

const JwtClaimsSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  authVersion: z.number().int().nonnegative().default(0),
});

export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

export function getJwtClaims(request: FastifyRequest): JwtClaims {
  return JwtClaimsSchema.parse(request.user);
}
