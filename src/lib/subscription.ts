import { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { isSuperuserEmail } from "./superuser";

export type PlanCode = "starter" | "professional" | "enterprise";
export type TenantAccessReason =
  | "superuser"
  | "trial"
  | "paid"
  | "payment_required"
  | "past_due"
  | "inactive";

export const BASIC_AI_SPEND_LIMIT_USD = 1.25;
export const BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH = 770;

export interface TenantBillingSnapshot {
  subscriptionStatus: string;
  subscriptionPlanCode: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  trialStartsAtUtc: Date | null;
  trialEndsAtUtc: Date | null;
  subscriptionCurrentPeriodStartUtc?: Date | null;
  subscriptionCurrentPeriodEndUtc: Date | null;
}

export type TenantUsagePeriodSource =
  | "PAID_SUBSCRIPTION"
  | "ACTIVE_TRIAL"
  | "UTC_CALENDAR_SUPERUSER"
  | "UTC_CALENDAR_LEGACY"
  | "UTC_CALENDAR";

export type TenantUsagePeriod = {
  periodStartUtc: Date;
  periodEndUtc: Date;
  source: TenantUsagePeriodSource;
};

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
      aiQuotesPerMonth: BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH,
      aiSpendUsdPerMonth: BASIC_AI_SPEND_LIMIT_USD,
      teamMembers: 7,
      quoteHistoryDays: 30,
    },
    features: {
      quoteVersionHistory: true,
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

export function resolveSubscriptionItemBilling(
  subscription: Stripe.Subscription,
  pricePlans: ReadonlyMap<string, PlanCode>,
): {
  planCode: PlanCode | null;
  currentPeriodStartUtc: Date | null;
  currentPeriodEndUtc: Date | null;
} {
  const matchingItems = subscription.items.data.filter((item) => pricePlans.has(item.price.id));
  if (matchingItems.length !== 1) {
    return { planCode: null, currentPeriodStartUtc: null, currentPeriodEndUtc: null };
  }

  const item = matchingItems[0];
  const planCode = pricePlans.get(item.price.id) ?? null;
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;
  const hasValidBounds =
    planCode
    && Number.isFinite(periodStart)
    && periodStart > 0
    && Number.isFinite(periodEnd)
    && periodEnd > periodStart;
  return {
    planCode,
    currentPeriodStartUtc: hasValidBounds ? new Date(periodStart * 1000) : null,
    currentPeriodEndUtc: hasValidBounds ? new Date(periodEnd * 1000) : null,
  };
}

export function resolveReconciledSubscriptionBillingPeriod(input: {
  subscription: Stripe.Subscription;
  expectedTenantId: string;
  expectedCustomerId: string | null;
  expectedSubscriptionId: string;
  expectedPlanCode: string;
  pricePlans: ReadonlyMap<string, PlanCode>;
  now?: Date;
}): { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date } | null {
  const {
    subscription,
    expectedTenantId,
    expectedCustomerId,
    expectedSubscriptionId,
    expectedPlanCode,
    pricePlans,
    now = new Date(),
  } = input;
  const subscriptionCustomerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const metadataTenantId = subscription.metadata.tenantId;
  const billing = resolveSubscriptionItemBilling(subscription, pricePlans);

  if (
    subscription.id !== expectedSubscriptionId
    || !expectedCustomerId
    || subscriptionCustomerId !== expectedCustomerId
    || (metadataTenantId !== undefined && metadataTenantId !== expectedTenantId)
    || (subscription.status !== "active" && subscription.status !== "trialing")
    || billing.planCode !== expectedPlanCode
    || !billing.currentPeriodStartUtc
    || !billing.currentPeriodEndUtc
    || billing.currentPeriodStartUtc.getTime() > now.getTime()
    || billing.currentPeriodEndUtc.getTime() <= now.getTime()
  ) {
    return null;
  }

  return {
    currentPeriodStartUtc: billing.currentPeriodStartUtc,
    currentPeriodEndUtc: billing.currentPeriodEndUtc,
  };
}

export function resolveReconciledSubscriptionPeriod(input: {
  subscription: Stripe.Subscription;
  expectedTenantId: string;
  expectedCustomerId: string | null;
  expectedSubscriptionId: string;
  expectedPlanCode: string;
  pricePlans: ReadonlyMap<string, PlanCode>;
  now?: Date;
}): Date | null {
  return resolveReconciledSubscriptionBillingPeriod(input)?.currentPeriodEndUtc ?? null;
}

export function resolveReconciledSubscriptionUsagePeriod(input: {
  subscription: Stripe.Subscription;
  expectedTenantId: string;
  expectedCustomerId: string | null;
  expectedSubscriptionId: string;
  expectedPlanCode: string;
  pricePlans: ReadonlyMap<string, PlanCode>;
  now?: Date;
}): { currentPeriodStartUtc: Date; currentPeriodEndUtc: Date } | null {
  const now = input.now ?? new Date();
  const billingPeriod = resolveReconciledSubscriptionBillingPeriod({ ...input, now });
  if (!billingPeriod) return null;
  if (input.subscription.status !== "trialing") return billingPeriod;

  const trialStart = input.subscription.trial_start;
  const trialEnd = input.subscription.trial_end;
  if (
    !Number.isFinite(trialStart)
    || !trialStart
    || !Number.isFinite(trialEnd)
    || !trialEnd
    || trialEnd <= trialStart
  ) {
    return null;
  }
  const currentPeriodStartUtc = new Date(trialStart * 1000);
  const currentPeriodEndUtc = new Date(trialEnd * 1000);
  if (
    currentPeriodStartUtc.getTime() > now.getTime()
    || currentPeriodEndUtc.getTime() <= now.getTime()
  ) {
    return null;
  }
  return { currentPeriodStartUtc, currentPeriodEndUtc };
}

function parsePlanCode(value: string | null | undefined): PlanCode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return PLAN_CODES.has(normalized as PlanCode) ? (normalized as PlanCode) : null;
}

function isActiveTrial(snapshot: TenantBillingSnapshot, now: Date): boolean {
  if (snapshot.subscriptionStatus !== "trialing") return false;
  if (!snapshot.trialEndsAtUtc) return false;
  if (snapshot.trialEndsAtUtc.getTime() <= now.getTime()) return false;
  // Checkout may create a Stripe Customer before a subscription exists. That
  // customer-only state remains QuoteFly's local trial; subscription binding is
  // the boundary where provider plan integrity becomes mandatory.
  if (!snapshot.stripeSubscriptionId) return true;
  return Boolean(
    snapshot.stripeCustomerId
    && snapshot.stripeSubscriptionId
    && parsePlanCode(snapshot.subscriptionPlanCode),
  );
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
  if (!snapshot.stripeCustomerId || !snapshot.stripeSubscriptionId) return false;
  // Stripe's Dahlia API reports the billing period on the subscription item.
  // A missing synchronized period is incomplete billing evidence, so access must
  // fail closed until a later webhook repairs the snapshot.
  if (!snapshot.subscriptionCurrentPeriodEndUtc) return false;
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
  /** Billing plan that controls the number of active workspace seats. */
  seatPlanCode: PlanCode;
  seatPlanName: string;
  isTrial: boolean;
  hasWorkspaceAccess: boolean;
  billingRequired: boolean;
  accessReason: TenantAccessReason;
  usagePeriod: TenantUsagePeriod;
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
  // Superusers and trials receive broad feature access, but they must not
  // silently bypass the seat allowance of the tenant's actual sellable plan.
  const seatPlanCode = parsePlanCode(snapshot.subscriptionPlanCode) ?? "starter";
  const seatDefinition = PLAN_DEFINITIONS[seatPlanCode];
  const trial = isActiveTrial(snapshot, now) && !isSuperuser(context);
  const limits = trial
    ? {
        ...definition.limits,
        // Trials keep full feature access, but use the launch Basic AI budget so
        // an unpaid workspace cannot create Enterprise-level provider spend.
        aiQuotesPerMonth: BASIC_ESTIMATED_AI_REQUESTS_PER_MONTH,
        aiSpendUsdPerMonth: BASIC_AI_SPEND_LIMIT_USD,
        teamMembers: seatDefinition.limits.teamMembers,
      }
    : access.accessReason === "superuser"
      ? { ...definition.limits, teamMembers: seatDefinition.limits.teamMembers }
      : definition.limits;
  const calendarPeriod = {
    periodStartUtc: startOfCurrentUtcMonth(now),
    periodEndUtc: startOfNextUtcMonth(now),
  };
  const paidStart = snapshot.subscriptionCurrentPeriodStartUtc ?? null;
  const paidEnd = snapshot.subscriptionCurrentPeriodEndUtc;
  const usagePeriod: TenantUsagePeriod = access.accessReason === "superuser"
    ? { ...calendarPeriod, source: "UTC_CALENDAR_SUPERUSER" }
    : access.accessReason === "trial"
      && snapshot.trialStartsAtUtc
      && snapshot.trialEndsAtUtc
      && snapshot.trialStartsAtUtc.getTime() <= now.getTime()
      && snapshot.trialEndsAtUtc.getTime() > now.getTime()
      ? {
          periodStartUtc: snapshot.trialStartsAtUtc,
          periodEndUtc: snapshot.trialEndsAtUtc,
          source: "ACTIVE_TRIAL",
        }
      : access.accessReason === "paid"
        && paidStart
        && paidEnd
        && paidStart.getTime() <= now.getTime()
        && paidEnd.getTime() > now.getTime()
        ? {
            periodStartUtc: paidStart,
            periodEndUtc: paidEnd,
            source: "PAID_SUBSCRIPTION",
          }
        : access.accessReason === "paid" || access.accessReason === "trial"
          ? { ...calendarPeriod, source: "UTC_CALENDAR_LEGACY" }
          : { ...calendarPeriod, source: "UTC_CALENDAR" };

  return {
    planCode: access.planCode,
    planName: definition.name,
    seatPlanCode,
    seatPlanName: seatDefinition.name,
    isTrial: trial,
    hasWorkspaceAccess: access.hasWorkspaceAccess,
    billingRequired: access.billingRequired,
    accessReason: access.accessReason,
    usagePeriod,
    limits,
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
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      trialStartsAtUtc: true,
      trialEndsAtUtc: true,
      subscriptionCurrentPeriodStartUtc: true,
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
