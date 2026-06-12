import { PrismaClient } from "@prisma/client";
import { isSuperuserEmail } from "./superuser";

export type PlanCode = "starter" | "professional" | "enterprise";
export type TenantAccessReason =
  | "superuser"
  | "trial"
  | "paid"
  | "payment_required"
  | "past_due"
  | "inactive";

export interface TenantBillingSnapshot {
  subscriptionStatus: string;
  subscriptionPlanCode: string | null;
  trialStartsAtUtc: Date | null;
  trialEndsAtUtc: Date | null;
  subscriptionCurrentPeriodEndUtc: Date | null;
}

interface EntitlementContext {
  userEmail?: string | null;
}

interface PlanDefinition {
  code: PlanCode;
  name: string;
  limits: {
    quotesPerMonth: number | null;
    aiQuotesPerMonth: number | null;
    aiSpendUsdPerMonth: number | null;
    teamMembers: number | null;
    quoteHistoryDays: number | null;
  };
  features: {
    quoteVersionHistory: boolean;
    communicationLog: boolean;
    advancedAnalytics: boolean;
    multiTrade: boolean;
    apiAccess: boolean;
    auditLogs: boolean;
    aiAutomation: boolean;
  };
}

const PLAN_DEFINITIONS: Record<PlanCode, PlanDefinition> = {
  starter: {
    code: "starter",
    name: "Basic",
    limits: {
      quotesPerMonth: 600,
      aiQuotesPerMonth: 30,
      aiSpendUsdPerMonth: 0.6,
      teamMembers: 7,
      quoteHistoryDays: 30,
    },
    features: {
      quoteVersionHistory: false,
      communicationLog: false,
      advancedAnalytics: false,
      multiTrade: false,
      apiAccess: false,
      auditLogs: false,
      aiAutomation: true,
    },
  },
  professional: {
    code: "professional",
    name: "Professional",
    limits: {
      quotesPerMonth: 5_000,
      aiQuotesPerMonth: 300,
      aiSpendUsdPerMonth: 11,
      teamMembers: 15,
      quoteHistoryDays: 180,
    },
    features: {
      quoteVersionHistory: true,
      communicationLog: true,
      advancedAnalytics: true,
      multiTrade: true,
      apiAccess: false,
      auditLogs: false,
      aiAutomation: true,
    },
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    limits: {
      quotesPerMonth: null,
      aiQuotesPerMonth: 800,
      aiSpendUsdPerMonth: 56,
      teamMembers: null,
      quoteHistoryDays: null,
    },
    features: {
      quoteVersionHistory: true,
      communicationLog: true,
      advancedAnalytics: true,
      multiTrade: true,
      apiAccess: true,
      auditLogs: true,
      aiAutomation: true,
    },
  },
};

const PLAN_CODES = new Set<PlanCode>(["starter", "professional", "enterprise"]);
const PAID_ACCESS_STATUSES = new Set(["active"]);

function parsePlanCode(value: string | null | undefined): PlanCode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return PLAN_CODES.has(normalized as PlanCode) ? (normalized as PlanCode) : null;
}

function isActiveTrial(snapshot: TenantBillingSnapshot, now: Date): boolean {
  if (snapshot.subscriptionStatus !== "trialing") return false;
  if (!snapshot.trialEndsAtUtc) return false;
  return snapshot.trialEndsAtUtc.getTime() > now.getTime();
}

function isSuperuser(context?: EntitlementContext): boolean {
  return isSuperuserEmail(context?.userEmail);
}

function normalizeSubscriptionStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

function hasActivePaidSubscription(snapshot: TenantBillingSnapshot, now: Date): boolean {
  const explicitPlan = parsePlanCode(snapshot.subscriptionPlanCode);
  if (!explicitPlan) return false;
  if (!PAID_ACCESS_STATUSES.has(normalizeSubscriptionStatus(snapshot.subscriptionStatus))) return false;
  if (!snapshot.subscriptionCurrentPeriodEndUtc) return true;
  return snapshot.subscriptionCurrentPeriodEndUtc.getTime() > now.getTime();
}

function resolveTenantAccess(
  snapshot: TenantBillingSnapshot,
  now: Date,
  context?: EntitlementContext,
): {
  planCode: PlanCode;
  hasWorkspaceAccess: boolean;
  billingRequired: boolean;
  accessReason: TenantAccessReason;
} {
  if (isSuperuser(context)) {
    return {
      planCode: "enterprise",
      hasWorkspaceAccess: true,
      billingRequired: false,
      accessReason: "superuser",
    };
  }

  if (isActiveTrial(snapshot, now)) {
    return {
      planCode: "enterprise",
      hasWorkspaceAccess: true,
      billingRequired: false,
      accessReason: "trial",
    };
  }

  const explicitPlan = parsePlanCode(snapshot.subscriptionPlanCode);
  if (explicitPlan && hasActivePaidSubscription(snapshot, now)) {
    return {
      planCode: explicitPlan,
      hasWorkspaceAccess: true,
      billingRequired: false,
      accessReason: "paid",
    };
  }

  const status = normalizeSubscriptionStatus(snapshot.subscriptionStatus);

  return {
    planCode: explicitPlan ?? "starter",
    hasWorkspaceAccess: false,
    billingRequired: true,
    accessReason: status === "past_due" ? "past_due" : explicitPlan ? "inactive" : "payment_required",
  };
}

export function resolveEffectivePlanCode(
  snapshot: TenantBillingSnapshot,
  now = new Date(),
  context?: EntitlementContext,
): PlanCode {
  return resolveTenantAccess(snapshot, now, context).planCode;
}

export interface TenantEntitlements {
  planCode: PlanCode;
  planName: string;
  isTrial: boolean;
  hasWorkspaceAccess: boolean;
  billingRequired: boolean;
  accessReason: TenantAccessReason;
  limits: PlanDefinition["limits"];
  features: PlanDefinition["features"];
}

export function buildTenantEntitlements(
  snapshot: TenantBillingSnapshot,
  now = new Date(),
  context?: EntitlementContext,
): TenantEntitlements {
  const access = resolveTenantAccess(snapshot, now, context);
  const definition = PLAN_DEFINITIONS[access.planCode];

  return {
    planCode: access.planCode,
    planName: definition.name,
    isTrial: isActiveTrial(snapshot, now) && !isSuperuser(context),
    hasWorkspaceAccess: access.hasWorkspaceAccess,
    billingRequired: access.billingRequired,
    accessReason: access.accessReason,
    limits: definition.limits,
    features: definition.features,
  };
}

export async function loadTenantBillingSnapshot(
  prisma: PrismaClient,
  tenantId: string,
): Promise<TenantBillingSnapshot | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAtUtc: null },
    select: {
      subscriptionStatus: true,
      subscriptionPlanCode: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodEndUtc: true,
    },
  });

  if (!tenant) return null;
  return tenant;
}

export async function loadTenantEntitlements(
  prisma: PrismaClient,
  tenantId: string,
  context?: EntitlementContext,
): Promise<TenantEntitlements | null> {
  const snapshot = await loadTenantBillingSnapshot(prisma, tenantId);
  if (!snapshot) return null;
  return buildTenantEntitlements(snapshot, new Date(), context);
}

export function startOfCurrentUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
