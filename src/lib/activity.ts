import { Prisma, PrismaClient } from "@prisma/client";
import type { JwtClaims } from "./auth";

export type ActivityActor = {
  actorUserId: string;
  actorEmail: string;
  actorName: string;
};

type ActorClient = Pick<PrismaClient, "user"> | Pick<Prisma.TransactionClient, "user">;
type CustomerActivityClient =
  | Pick<PrismaClient, "customerActivityEvent">
  | Pick<Prisma.TransactionClient, "customerActivityEvent">;

export async function resolveActivityActor(
  prisma: ActorClient,
  claims: JwtClaims,
): Promise<ActivityActor> {
  const user = await prisma.user.findFirst({
    where: {
      id: claims.userId,
      deletedAtUtc: null,
    },
    select: {
      email: true,
      fullName: true,
    },
  });

  return {
    actorUserId: claims.userId,
    actorEmail: user?.email ?? claims.email,
    actorName: user?.fullName ?? claims.email,
  };
}

export async function createCustomerActivityEvent(
  prisma: CustomerActivityClient,
  params: {
    tenantId: string;
    customerId: string;
    actor: ActivityActor;
    eventType: string;
    title: string;
    detail?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) {
  return prisma.customerActivityEvent.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      actorUserId: params.actor.actorUserId,
      actorEmail: params.actor.actorEmail,
      actorName: params.actor.actorName,
      eventType: params.eventType,
      title: params.title,
      detail: params.detail ?? null,
      metadata: params.metadata,
    },
  });
}
