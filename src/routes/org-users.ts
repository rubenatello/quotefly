import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { getJwtClaims } from "../lib/auth";
import { loadTenantEntitlements } from "../lib/subscription";
import { PaginationQuerySchema } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { withTenantRlsContext } from "../lib/tenant-rls";

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

const ListOrgUsersQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
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

function roleCapabilities(role: string) {
  const normalized = normalizeRole(role);
  if (normalized === "owner") {
    return ["All customers and assigned work", "Products, costs, margins, and retention", "Users, assignments, and billing"];
  }
  if (normalized === "admin") {
    return ["All customers and assigned work", "Products, costs, margins, and retention", "Users and assignments"];
  }
  return ["Assigned customers and follow-ups", "Create and edit assigned quotes", "No catalog changes, internal costs, margins, or record deletion"];
}

export const orgUserRoutes: FastifyPluginAsync = async (app) => {
  app.get("/org/users", { preHandler: [app.authenticate] }, async (request, reply) => {
    const claims = getJwtClaims(request);
    const query = ListOrgUsersQuerySchema.parse(request.query);

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

    const activeMemberWhere: Prisma.TenantUserWhereInput = {
      tenantId: claims.tenantId,
      deletedAtUtc: null,
      user: { deletedAtUtc: null },
    };
    const where: Prisma.TenantUserWhereInput = {
      ...activeMemberWhere,
      user: {
        deletedAtUtc: null,
        ...(query.search
          ? {
              OR: [
                { fullName: { contains: query.search, mode: "insensitive" } },
                { email: { contains: query.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
    };

    const [members, total, activeMemberTotal, entitlements] = await measureRequestPerformance(request, "db", () => Promise.all([
      app.prisma.tenantUser.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              fullName: true,
              createdAt: true,
            },
          },
          _count: {
            select: {
              assignedCustomers: { where: { archivedAtUtc: null, deletedAtUtc: null } },
              assignedQuotes: { where: { archivedAtUtc: null, deletedAtUtc: null } },
            },
          },
        },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: query.limit,
        skip: query.offset,
      }),
      app.prisma.tenantUser.count({ where }),
      app.prisma.tenantUser.count({ where: activeMemberWhere }),
      loadTenantEntitlements(app.prisma, claims.tenantId, { userEmail: claims.email }),
    ]));

    return {
      members: members.map((member) => ({
        id: member.id,
        tenantId: member.tenantId,
        role: normalizeRole(member.role),
        createdAt: member.createdAt,
        capabilities: roleCapabilities(member.role),
        assignments: member._count,
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
        teamMembersUsed: activeMemberTotal,
        teamMembersRemaining: entitlements?.limits.teamMembers === null || entitlements?.limits.teamMembers === undefined
          ? null
          : Math.max(entitlements.limits.teamMembers - activeMemberTotal, 0),
        seatPlanCode: entitlements?.seatPlanCode ?? "starter",
        seatPlanName: entitlements?.seatPlanName ?? "Basic",
      },
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
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
    if (normalizeRole(actingMembership.role) !== "owner" && payload.role === "owner") {
      return reply.code(403).send({ error: "Only owners can add another owner." });
    }

    const entitlements = await loadTenantEntitlements(app.prisma, claims.tenantId, {
      userEmail: claims.email,
    });
    if (!entitlements) {
      return reply.code(404).send({ error: "Tenant not found for account." });
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
        // Serialize seat additions per tenant so simultaneous invitations can
        // never overrun the plan allowance.
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${claims.tenantId}, 0))::text
        `);
        const activeMemberCount = await tx.tenantUser.count({
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
          throw new Error(`SEAT_LIMIT:${activeMemberCount}`);
        }
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({
          error: "That user or workspace membership was created by another request. Refresh the team list before retrying.",
        });
      }
      if (error instanceof Error && error.message.startsWith("SEAT_LIMIT:")) {
        const activeMemberCount = Number(error.message.split(":")[1] ?? entitlements.limits.teamMembers ?? 0);
        const requiredPlan = entitlements.planCode === "starter" ? "professional" : "enterprise";
        return reply.code(403).send({
          code: "PLAN_LIMIT_EXCEEDED",
          feature: "teamMembers",
          error: `${entitlements.seatPlanName} allows up to ${entitlements.limits.teamMembers} active team members.`,
          currentPlan: entitlements.seatPlanCode,
          requiredPlan,
          limit: entitlements.limits.teamMembers,
          used: activeMemberCount,
        });
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

    if (tenantUserId === actingMembership.id && payload.role !== "owner") {
      return reply.code(400).send({ error: "Owner cannot demote their own role." });
    }

    const outcome = await withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
      const memberships = await tx.$queryRaw<Array<{ id: string; role: string }>>(Prisma.sql`
        SELECT membership."id", membership."role"
        FROM "TenantUser" membership
        INNER JOIN "User" account ON account."id" = membership."userId"
        WHERE membership."id" = ${tenantUserId}
          AND membership."tenantId" = ${claims.tenantId}
          AND membership."deletedAtUtc" IS NULL
          AND account."deletedAtUtc" IS NULL
        FOR UPDATE OF membership
      `);
      const targetMembership = memberships[0];
      if (!targetMembership) return { kind: "missing" as const };

      if (payload.role === "member" && normalizeRole(targetMembership.role) !== "member") {
        const conflicts = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "count"
          FROM "ActivityTask" task
          INNER JOIN "Customer" customer
            ON customer."id" = task."customerId"
           AND customer."tenantId" = task."tenantId"
          LEFT JOIN "Quote" quote
            ON quote."id" = task."quoteId"
           AND quote."tenantId" = task."tenantId"
          WHERE task."tenantId" = ${claims.tenantId}
            AND task."assignedTenantUserId" = ${targetMembership.id}
            AND task."deletedAtUtc" IS NULL
            AND task."status" IN ('OPEN', 'IN_PROGRESS')
            AND (
              customer."archivedAtUtc" IS NOT NULL
              OR customer."deletedAtUtc" IS NOT NULL
              OR customer."assignedTenantUserId" IS DISTINCT FROM ${targetMembership.id}
              OR (
                task."quoteId" IS NOT NULL
                AND (
                  quote."id" IS NULL
                  OR quote."archivedAtUtc" IS NOT NULL
                  OR quote."deletedAtUtc" IS NOT NULL
                  OR quote."assignedTenantUserId" IS DISTINCT FROM ${targetMembership.id}
                )
              )
            )
        `);
        const activeTaskCount = Number(conflicts[0]?.count ?? 0);
        if (activeTaskCount > 0) {
          return { kind: "task_conflict" as const, activeTaskCount };
        }
      }

      const updated = await tx.tenantUser.update({
        where: { id: targetMembership.id },
        data: { role: payload.role },
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
      return { kind: "updated" as const, updated };
    }, { maxWait: 5_000, timeout: 15_000 });

    if (outcome.kind === "missing") {
      return reply.code(404).send({ error: "Member not found for organization." });
    }
    if (outcome.kind === "task_conflict") {
      return reply.code(409).send({
        code: "ROLE_CHANGE_ACTIVE_TASK_CONFLICT",
        error: `Reassign ${outcome.activeTaskCount} active task(s), or align their customer and quote assignments, before changing this admin to a member.`,
        activeTaskCount: outcome.activeTaskCount,
      });
    }
    const updated = outcome.updated;

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

    const removal = await withTenantRlsContext(app.prisma, claims.tenantId, async (tx) => {
      const memberships = await tx.$queryRaw<Array<{ id: string; role: string }>>(Prisma.sql`
        SELECT membership."id", membership."role"
        FROM "TenantUser" membership
        INNER JOIN "User" account ON account."id" = membership."userId"
        WHERE membership."id" = ${tenantUserId}
          AND membership."tenantId" = ${claims.tenantId}
          AND membership."deletedAtUtc" IS NULL
          AND account."deletedAtUtc" IS NULL
        FOR UPDATE OF membership
      `);
      const targetMembership = memberships[0];
      if (!targetMembership) return { kind: "missing" as const };
      if (normalizeRole(targetMembership.role) === "owner") return { kind: "owner" as const };

      const [customers, quotes, activities] = await Promise.all([
        tx.customer.count({
          where: { tenantId: claims.tenantId, assignedTenantUserId: targetMembership.id, archivedAtUtc: null, deletedAtUtc: null },
        }),
        tx.quote.count({
          where: { tenantId: claims.tenantId, assignedTenantUserId: targetMembership.id, archivedAtUtc: null, deletedAtUtc: null },
        }),
        tx.activityTask.count({
          where: {
            tenantId: claims.tenantId,
            assignedTenantUserId: targetMembership.id,
            deletedAtUtc: null,
            status: { in: ["OPEN", "IN_PROGRESS"] },
          },
        }),
      ]);
      if (customers > 0 || quotes > 0 || activities > 0) {
        return { kind: "assigned" as const, assignments: { customers, quotes, activities } };
      }

      const result = await tx.tenantUser.updateMany({
        where: { id: targetMembership.id, tenantId: claims.tenantId, deletedAtUtc: null },
        data: { deletedAtUtc: new Date() },
      });
      return result.count === 1 ? { kind: "removed" as const } : { kind: "missing" as const };
    }, { maxWait: 5_000, timeout: 15_000 });

    if (removal.kind === "missing") {
      return reply.code(404).send({ error: "Member not found for organization." });
    }
    if (removal.kind === "owner") {
      return reply.code(400).send({ error: "Transfer ownership before removing another owner." });
    }
    if (removal.kind === "assigned") {
      const activeAssignments = removal.assignments;
      return reply.code(409).send({
        code: "MEMBER_HAS_ACTIVE_ASSIGNMENTS",
        error: `Reassign ${activeAssignments.customers} customer(s), ${activeAssignments.quotes} quote(s), and ${activeAssignments.activities} task(s) before removing this member.`,
        assignments: activeAssignments,
      });
    }

    return reply.code(204).send();
  });
};
