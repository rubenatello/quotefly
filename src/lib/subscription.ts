import { PrismaClient } from "@prisma/client";

export type PlanCode = "starter" | "professional" | "enterprise";

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
    name: "Starter",
    limits: {
      quotesPerMonth: 600,
      aiQuotesPerMonth: 10,
      teamMembers: 3,
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
      aiQuotesPerMonth: 50,
      teamMembers: 10,
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
      aiQuotesPerMonth: 300,
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

const SUPERUSER_EMAIL_SET = new Set(
  (process.env.SUPERUSER_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

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
  const email = context?.userEmail?.trim().toLowerCase();
  if (!email) return false;
  return SUPERUSER_EMAIL_SET.has(email);
}

export function resolveEffectivePlanCode(
  snapshot: TenantBillingSnapshot,
  now = new Date(),
  context?: EntitlementContext,
): PlanCode {
  if (isSuperuser(context)) return "enterprise";
  if (isActiveTrial(snapshot, now)) return "enterprise";
  const explicitPlan = parsePlanCode(snapshot.subscriptionPlanCode);
  if (explicitPlan) return explicitPlan;
  return "starter";
}

export interface TenantEntitlements {
  planCode: PlanCode;
  planName: string;
  isTrial: boolean;
  limits: PlanDefinition["limits"];
  features: PlanDefinition["features"];
}

export function buildTenantEntitlements(
  snapshot: TenantBillingSnapshot,
  now = new Date(),
  context?: EntitlementContext,
): TenantEntitlements {
  const planCode = resolveEffectivePlanCode(snapshot, now, context);
  const definition = PLAN_DEFINITIONS[planCode];

  return {
    planCode,
    planName: definition.name,
    isTrial: isActiveTrial(snapshot, now) && !isSuperuser(context),
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
