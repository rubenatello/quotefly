import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getJwtClaims } from "../lib/auth";
import { loadTenantEntitlements } from "../lib/subscription";

const BCRYPT_ROUNDS = 12;

const OrgUserRoleSchema = z.enum(["owner", "admin", "member"]);

const CreateOrgUserSchema = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(120),
  role: OrgUserRoleSchema.default("member"),
});

const UpdateOrgUserRoleSchema = z.object({
  role: OrgUserRoleSchema,
});

const TenantUserParamsSchema = z.object({
  tenantUserId: z.string().min(1),
});

function normalizeRole(role: string): "owner" | "admin" | "member" {
  const value = role.trim().toLowerCase();
  if (value === "owner" || value === "admin") return value;
  return "member";
}

function canManageUsers(role: string): boolean {
  const normalized = normalizeRole(role);
  return normalized === "owner" || normalized === "admin";
}

export const orgUserRoutes: FastifyPluginAsync = async (app) => {
  app.get("/org/users", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);

    const membership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
        tenant: { deletedAtUtc: null },
      },
      select: { id: true, role: true },
    });

    if (!membership) {
      return reply.code(403).send({ error: "No active tenant membership for this user." });
    }

    const [members, entitlements] = await Promise.all([
      app.prisma.tenantUser.findMany({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
          user: { deletedAtUtc: null },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              fullName: true,
              createdAt: true,
            },
          },
        },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      }),
      loadTenantEntitlements(app.prisma, claims.tenantId),
    ]);

    return {
      members: members.map((member) => ({
        id: member.id,
        tenantId: member.tenantId,
        role: normalizeRole(member.role),
        createdAt: member.createdAt,
        user: {
          id: member.user.id,
          email: member.user.email,
          fullName: member.user.fullName,
          createdAt: member.user.createdAt,
        },
      })),
      policy: {
        canManageUsers: canManageUsers(membership.role),
        teamMembersLimit: entitlements?.limits.teamMembers ?? null,
        teamMembersUsed: members.length,
      },
    };
  });

  app.post("/org/users", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const payload = CreateOrgUserSchema.parse(request.body);
    const normalizedEmail = payload.email.toLowerCase();

    const actingMembership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
      },
      select: { id: true, role: true },
    });

    if (!actingMembership || !canManageUsers(actingMembership.role)) {
      return reply.code(403).send({ error: "Insufficient permission to manage organization users." });
    }

    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId);
    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const activeMemberCount = await app.prisma.tenantUser.count({
      where: {
        tenantId: claims.tenantId,
        deletedAtUtc: null,
        user: { deletedAtUtc: null },
      },
    });

    if (
      entitlements.limits.teamMembers !== null &&
      activeMemberCount >= entitlements.limits.teamMembers
    ) {
      const requiredPlan = entitlements.planCode === "starter" ? "professional" : "enterprise";
      return reply.code(403).send({
        code: "PLAN_LIMIT_EXCEEDED",
        feature: "teamMembers",
        error: `${entitlements.planName} allows up to ${entitlements.limits.teamMembers} active team members.`,
        currentPlan: entitlements.planCode,
        requiredPlan,
        limit: entitlements.limits.teamMembers,
        used: activeMemberCount,
      });
    }

    const existingUser = await app.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        tenantLink: {
          where: {
            tenantId: claims.tenantId,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const role = payload.role;
    const now = new Date();
    let tenantMembershipId = "";
    let userId = "";

    try {
      await app.prisma.$transaction(async (tx) => {
        if (!existingUser) {
          const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);
          const createdUser = await tx.user.create({
            data: {
              email: normalizedEmail,
              fullName: payload.fullName,
              passwordHash,
            },
          });

          const tenantMembership = await tx.tenantUser.create({
            data: {
              tenantId: claims.tenantId,
              userId: createdUser.id,
              role,
            },
          });

          userId = createdUser.id;
          tenantMembershipId = tenantMembership.id;
          return;
        }

        if (existingUser.deletedAtUtc) {
          return;
        }

        const latestLink = existingUser.tenantLink[0];
        if (latestLink?.deletedAtUtc === null) {
          throw new Error("ACTIVE_MEMBERSHIP_EXISTS");
        }

        if (existingUser.fullName !== payload.fullName) {
          await tx.user.update({
            where: { id: existingUser.id },
            data: {
              fullName: payload.fullName,
            },
          });
        }

        if (latestLink?.deletedAtUtc) {
          const restored = await tx.tenantUser.update({
            where: { id: latestLink.id },
            data: {
              role,
              deletedAtUtc: null,
            },
          });
          tenantMembershipId = restored.id;
          userId = existingUser.id;
          return;
        }

        const tenantMembership = await tx.tenantUser.create({
          data: {
            tenantId: claims.tenantId,
            userId: existingUser.id,
            role,
            createdAt: now,
          },
        });
        tenantMembershipId = tenantMembership.id;
        userId = existingUser.id;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "ACTIVE_MEMBERSHIP_EXISTS") {
        return reply.code(409).send({ error: "User is already an active member in this organization." });
      }
      throw error;
    }

    if (!tenantMembershipId || !userId) {
      if (existingUser?.deletedAtUtc) {
        return reply.code(409).send({
          error: "User account exists but is disabled. Reactivation flow not implemented yet.",
        });
      }

      return reply.code(409).send({
        error: "User is already an active member in this organization.",
      });
    }

    const createdMember = await app.prisma.tenantUser.findFirst({
      where: {
        id: tenantMembershipId,
        tenantId: claims.tenantId,
        deletedAtUtc: null,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            createdAt: true,
          },
        },
      },
    });

    if (!createdMember) {
      return reply.code(500).send({ error: "Failed loading created team member." });
    }

    return reply.code(201).send({
      member: {
        id: createdMember.id,
        tenantId: createdMember.tenantId,
        role: normalizeRole(createdMember.role),
        createdAt: createdMember.createdAt,
        user: createdMember.user,
      },
    });
  });

  app.patch("/org/users/:tenantUserId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { tenantUserId } = TenantUserParamsSchema.parse(request.params);
    const payload = UpdateOrgUserRoleSchema.parse(request.body);

    const actingMembership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
      },
      select: { id: true, role: true },
    });

    if (!actingMembership || normalizeRole(actingMembership.role) !== "owner") {
      return reply.code(403).send({ error: "Only owners can update member roles." });
    }

    const targetMembership = await app.prisma.tenantUser.findFirst({
      where: {
        id: tenantUserId,
        tenantId: claims.tenantId,
        deletedAtUtc: null,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            createdAt: true,
          },
        },
      },
    });

    if (!targetMembership) {
      return reply.code(404).send({ error: "Member not found for organization." });
    }

    if (targetMembership.id === actingMembership.id && payload.role !== "owner") {
      return reply.code(400).send({ error: "Owner cannot demote their own role." });
    }

    const updated = await app.prisma.tenantUser.update({
      where: { id: targetMembership.id },
      data: {
        role: payload.role,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            createdAt: true,
          },
        },
      },
    });

    return reply.send({
      member: {
        id: updated.id,
        tenantId: updated.tenantId,
        role: normalizeRole(updated.role),
        createdAt: updated.createdAt,
        user: updated.user,
      },
    });
  });

  app.delete("/org/users/:tenantUserId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const { tenantUserId } = TenantUserParamsSchema.parse(request.params);

    const actingMembership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId: claims.tenantId,
        userId: claims.userId,
        deletedAtUtc: null,
      },
      select: { id: true, role: true },
    });

    if (!actingMembership || normalizeRole(actingMembership.role) !== "owner") {
      return reply.code(403).send({ error: "Only owners can remove members." });
    }

    if (actingMembership.id === tenantUserId) {
      return reply.code(400).send({ error: "Owner cannot remove their own active membership." });
    }

    const targetMembership = await app.prisma.tenantUser.findFirst({
      where: {
        id: tenantUserId,
        tenantId: claims.tenantId,
        deletedAtUtc: null,
      },
      select: { id: true, role: true },
    });

    if (!targetMembership) {
      return reply.code(404).send({ error: "Member not found for organization." });
    }

    if (normalizeRole(targetMembership.role) === "owner") {
      return reply.code(400).send({ error: "Transfer ownership before removing another owner." });
    }

    await app.prisma.tenantUser.update({
      where: { id: targetMembership.id },
      data: { deletedAtUtc: new Date() },
    });

    return reply.code(204).send();
  });
};
