import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getJwtClaims, type JwtClaims } from "./auth";
import { isSuperuserEmail } from "./superuser";

type SuperuserAuditClient =
  | Pick<PrismaClient, "superuserAuditEvent">
  | Pick<Prisma.TransactionClient, "superuserAuditEvent">;

export function requireSuperuserAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): JwtClaims | null {
  const claims = getJwtClaims(request);
  if (!request.liveAuthMembership || !isSuperuserEmail(request.liveAuthMembership.user.email)) {
    reply.code(403).send({
      code: "SUPERUSER_REQUIRED",
      error: "Superuser access required.",
    });
    return null;
  }
  return claims;
}

export async function recordSuperuserAuditEvent(
  prisma: SuperuserAuditClient,
  params: {
    actorUserId: string;
    requestId: string;
    action: string;
    targetType?: string | null;
    targetRefHash?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) {
  const requestId = params.requestId.trim();
  const action = params.action.trim();
  if (!requestId || !action) {
    throw new Error("Superuser audit requestId and action are required.");
  }

  return prisma.superuserAuditEvent.create({
    data: {
      actorUserId: params.actorUserId,
      requestId: requestId.slice(0, 128),
      action: action.slice(0, 80),
      targetType: params.targetType?.trim().slice(0, 64) || null,
      targetRefHash: params.targetRefHash ?? null,
      metadata: params.metadata ?? Prisma.JsonNull,
    },
  });
}
