import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccessContext } from "./access-policy";
import { hasCapability } from "./access-policy";

export type WorkspaceAssigneeSummary = {
  id: string;
  role: "owner" | "admin" | "member";
  user: {
    id: string;
    email: string;
    fullName: string;
  };
};

export function assignedRecordScope(
  access: AccessContext,
): { assignedTenantUserId?: string } {
  return hasCapability(access, "viewAllWorkspaceRecords")
    ? {}
    : { assignedTenantUserId: access.tenantUserId };
}

export function canAccessAssignedRecord(
  access: AccessContext,
  assignedTenantUserId: string | null | undefined,
): boolean {
  return hasCapability(access, "viewAllWorkspaceRecords") ||
    assignedTenantUserId === access.tenantUserId;
}

export function defaultAssigneeForCreatedRecord(access: AccessContext): string | null {
  return hasCapability(access, "viewAllWorkspaceRecords") ? null : access.tenantUserId;
}

export async function validateActiveTenantAssignee(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { tenantId: string; tenantUserId: string },
): Promise<boolean> {
  const membership = await prisma.tenantUser.findFirst({
    where: {
      id: input.tenantUserId,
      tenantId: input.tenantId,
      deletedAtUtc: null,
      user: { deletedAtUtc: null },
    },
    select: { id: true },
  });
  return Boolean(membership);
}

export const WorkspaceAssigneeSelect = {
  id: true,
  role: true,
  user: {
    select: {
      id: true,
      email: true,
      fullName: true,
    },
  },
} as const satisfies Prisma.TenantUserSelect;
