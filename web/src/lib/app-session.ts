import type { PlanCode, ServiceType, TenantEntitlements, TenantUsageSnapshot } from "./api";

export type AppSession = {
  userId: string;
  email: string;
  fullName: string;
  tenantId: string;
  tenantName: string;
  timezone: string;
  role: string;
  primaryTrade?: ServiceType | null;
  onboardingCompletedAtUtc?: string | null;
  subscriptionStatus?: string;
  subscriptionPlanCode?: string | null;
  trialEndsAtUtc?: string | null;
  subscriptionCurrentPeriodEndUtc?: string | null;
  effectivePlanCode?: PlanCode;
  effectivePlanName?: string;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
  usage?: TenantUsageSnapshot;
  isSuperuser?: boolean;
};

export type SessionRecovery = {
  source: "restore" | "post-auth";
};
