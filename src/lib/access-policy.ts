import type { FastifyRequest } from "fastify";
import { getJwtClaims } from "./auth";

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const CAPABILITIES = [
  "viewCustomerPii",
  "viewTenantQuotes",
  "viewInternalCosts",
  "viewMargins",
  "viewAiRunSummary",
  "viewAiRunAudit",
  "viewAiRawPrompt",
  "useAiQuoteDrafting",
  "useAiBusinessInsights",
  "manageAiSettings",
  "viewBilling",
  "manageBilling",
  "manageIntegrations",
  "manageTeam",
  "manageCatalog",
  "manageAssignments",
  "manageRecordRetention",
  "viewAllWorkspaceRecords",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const BASE_CAPABILITIES = [
  "viewCustomerPii",
  "viewTenantQuotes",
  "viewAiRunSummary",
  "useAiQuoteDrafting",
  "useAiBusinessInsights",
] as const satisfies readonly Capability[];

const ADMIN_CAPABILITIES = [
  ...BASE_CAPABILITIES,
  "viewInternalCosts",
  "viewMargins",
  "viewAiRunAudit",
  "manageAiSettings",
  "viewBilling",
  "manageIntegrations",
  "manageTeam",
  "manageCatalog",
  "manageAssignments",
  "manageRecordRetention",
  "viewAllWorkspaceRecords",
] as const satisfies readonly Capability[];

const OWNER_CAPABILITIES = [
  ...ADMIN_CAPABILITIES,
  "manageBilling",
] as const satisfies readonly Capability[];

const ROLE_CAPABILITIES: Record<WorkspaceRole, readonly Capability[]> = {
  owner: OWNER_CAPABILITIES,
  admin: ADMIN_CAPABILITIES,
  member: BASE_CAPABILITIES,
};

export type AccessContext = Readonly<{
  tenantId: string;
  tenantUserId: string;
  userId: string;
  role: WorkspaceRole;
  capabilities: ReadonlySet<Capability>;
  requestId: string;
}>;

export function normalizeWorkspaceRole(role: string): WorkspaceRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner" || normalized === "admin") return normalized;
  return "member";
}

export function capabilitiesForRole(role: string): ReadonlySet<Capability> {
  return new Set(ROLE_CAPABILITIES[normalizeWorkspaceRole(role)]);
}

export function hasCapability(
  access: Pick<AccessContext, "capabilities">,
  capability: Capability,
): boolean {
  return access.capabilities.has(capability);
}

/**
 * Builds authorization context only from server-verified request state. The
 * tenant, user, and role are never accepted from route bodies or model output.
 */
export function buildAccessContext(request: FastifyRequest): AccessContext {
  const claims = getJwtClaims(request);
  const membership = request.liveAuthMembership;
  if (!membership) {
    throw new Error("Live workspace membership is required.");
  }

  const role = normalizeWorkspaceRole(membership.role);
  return Object.freeze({
    tenantId: claims.tenantId,
    tenantUserId: membership.id,
    userId: claims.userId,
    role,
    capabilities: capabilitiesForRole(role),
    requestId: request.id,
  });
}
