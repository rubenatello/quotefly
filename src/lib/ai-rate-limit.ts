import type { FastifyRequest } from "fastify";
import { getJwtClaims } from "./auth";

export function authenticatedTenantUserRateLimitKey(request: FastifyRequest): string {
  try {
    const claims = getJwtClaims(request);
    return `${claims.tenantId}:${claims.userId}`;
  } catch {
    return request.ip;
  }
}

export function authenticatedAiRateLimit(groupId: string, max: number, timeWindow = "1 minute") {
  return {
    rateLimit: {
      max,
      timeWindow,
      hook: "preHandler",
      groupId,
      keyGenerator: authenticatedTenantUserRateLimitKey,
    },
  } as const;
}
