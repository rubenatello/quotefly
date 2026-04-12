import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
  api,
  type OrganizationUser,
  type OrgUserRole,
  type PlanCode,
  type QuickBooksStatusPayload,
  type TenantEntitlements,
  type TenantUsageSnapshot,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { CheckIcon, ClockIcon, CustomerIcon, LockIcon, PriceIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, CardHeader, ConfirmModal, Input, PageHeader, ProgressBar, Select } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceRailCard, WorkspaceSection } from "../components/ui/workspace";

interface AdminPageProps {
  session?: {
    tenantId: string;
    role: string;
    email: string;
    subscriptionStatus?: string;
    subscriptionPlanCode?: string | null;
    trialEndsAtUtc?: string | null;
    subscriptionCurrentPeriodEndUtc?: string | null;
    effectivePlanCode?: PlanCode;
    effectivePlanName?: string;
    isTrial?: boolean;
    entitlements?: TenantEntitlements;
    usage?: TenantUsageSnapshot;
  } | null;
}

type NewUserForm = {
  fullName: string;
  email: string;
  password: string;
  role: OrgUserRole;
};

type BillingAction = PlanCode | "portal" | null;

type PlanCard = {
  code: PlanCode;
  name: string;
  price: string;
  summary: string;
  launchState: "available" | "coming-soon";
  seatText: string;
  aiQuoteText: string;
  historyText: string;
  accentClassName: string;
  features: string[];
};

const EMPTY_NEW_USER: NewUserForm = {
  fullName: "",
  email: "",
  password: "",
  role: "member",
};

const PLAN_CARDS: readonly PlanCard[] = [
  {
    code: "starter",
    name: "Starter",
    price: "$19/mo",
    launchState: "available",
    summary: "For solo operators and small crews that need clean quoting fast.",
    seatText: "Up to 7 users",
    aiQuoteText: "30 AI quote drafts / month",
    historyText: "30-day quote history",
    accentClassName: "border-blue-200 bg-blue-50/70",
    features: [
      "600 quotes per month",
      "Quick customer intake and pipeline tracking",
      "PDF quote generation",
      "Fast customer and quote tracking",
    ],
  },
  {
    code: "professional",
    name: "Professional",
    price: "$59/mo",
    launchState: "coming-soon",
    summary: "Staged after launch for stronger visibility, revisions, and accounting workflows.",
    seatText: "Up to 15 users",
    aiQuoteText: "300 AI quote drafts / month",
    historyText: "180-day quote history",
    accentClassName: "border-orange-200 bg-orange-50/70",
    features: [
      "Quote version history",
      "Communication log and advanced analytics",
      "Multi-trade workspace support",
      "Accounting workflow upgrades",
    ],
  },
  {
    code: "enterprise",
    name: "Enterprise",
    price: "$249/mo",
    launchState: "coming-soon",
    summary: "Staged after Professional for larger operations that need governance and automation.",
    seatText: "Unlimited users",
    aiQuoteText: "800 AI quote drafts / month",
    historyText: "Unlimited quote history",
    accentClassName: "border-slate-300 bg-slate-100",
    features: [
      "Unlimited quotes",
      "API access and audit logs",
      "Advanced AI automation layer",
      "Custom integrations and priority support",
    ],
  },
] as const;

const ROLE_OPTIONS: Array<{ value: OrgUserRole; label: string }> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

function normalizeRole(role: string): OrgUserRole {
  const value = role.trim().toLowerCase();
  if (value === "owner" || value === "admin") return value;
  return "member";
}

function normalizePlanCode(planCode: string | null | undefined): PlanCode | null {
  if (planCode === "starter" || planCode === "professional" || planCode === "enterprise") {
    return planCode;
  }
  return null;
}

function roleLabel(role: OrgUserRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

function dateText(value: string | null | undefined): string {
  if (!value) return "Not set";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sentenceCaseStatus(value: string | null | undefined): string {
  if (!value) return "Not started";
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function billingNoticeText(code: string | null): string | null {
  if (code === "success") return "Billing updated. Stripe checkout completed successfully.";
  if (code === "cancel") return "Stripe checkout was canceled. No billing changes were made.";
  if (code === "portal") return "Returned from the Stripe billing portal.";
  return null;
}

function integrationNoticeText(code: string | null): string | null {
  if (code === "quickbooks_connected") return "QuickBooks connected successfully.";
  if (code === "quickbooks_denied") return "QuickBooks connection was canceled before authorization completed.";
  if (code === "quickbooks_invalid_state") return "QuickBooks authorization expired or became invalid. Start the connection again.";
  if (code === "quickbooks_realm_in_use") return "That QuickBooks company is already linked to another QuoteFly tenant.";
  if (code === "quickbooks_not_configured") return "QuickBooks integration is not configured on the API yet.";
  if (code === "quickbooks_error") return "QuickBooks connection failed. Review your Intuit app configuration and try again.";
  return null;
}

function planTone(planCode: PlanCode | null | undefined): "blue" | "orange" | "slate" {
  if (planCode === "starter") return "blue";
  if (planCode === "professional") return "orange";
  return "slate";
}

function subscriptionTone(status: string | null | undefined): "emerald" | "amber" | "red" | "slate" {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "active") return "emerald";
  if (normalized === "trialing" || normalized === "past_due") return "amber";
  if (normalized === "unpaid" || normalized === "canceled" || normalized === "incomplete") return "red";
  return "slate";
}

function roleTone(role: OrgUserRole): "violet" | "sky" | "slate" {
  if (role === "owner") return "violet";
  if (role === "admin") return "sky";
  return "slate";
}

export function AdminPage({ session }: AdminPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [members, setMembers] = useState<OrganizationUser[]>([]);
  const [teamMembersLimit, setTeamMembersLimit] = useState<number | null>(
    session?.entitlements?.limits.teamMembers ?? null,
  );
  const [teamMembersUsed, setTeamMembersUsed] = useState(0);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [billingAction, setBillingAction] = useState<BillingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<NewUserForm>(EMPTY_NEW_USER);
  const [pendingRemovalMember, setPendingRemovalMember] = useState<OrganizationUser | null>(null);
  const [quickBooksStatus, setQuickBooksStatus] = useState<QuickBooksStatusPayload | null>(null);
  const [quickBooksLoading, setQuickBooksLoading] = useState(true);
  const settingsMode: "org" | "users" = location.pathname.startsWith("/app/settings/users") ? "users" : "org";

  const sessionRole = normalizeRole(session?.role ?? "member");
  const ownerView = sessionRole === "owner";
  const activeSubscriptionPlan = normalizePlanCode(session?.subscriptionPlanCode);
  const effectivePlanCode = session?.effectivePlanCode ?? session?.entitlements?.planCode ?? "starter";
  const effectivePlanName = session?.effectivePlanName ?? session?.entitlements?.planName ?? "Starter";
  const seatLimitReached = teamMembersLimit !== null && teamMembersUsed >= teamMembersLimit;
  const hasPortalAccess =
    activeSubscriptionPlan !== null ||
    ["active", "past_due", "unpaid", "canceled", "incomplete"].includes(
      (session?.subscriptionStatus ?? "").toLowerCase(),
    );

  useEffect(() => {
    setSEOMetadata({
      title: "Organization Admin",
      description: "Manage team members, billing, and workspace access settings.",
    });
    void loadMembers();
    void loadQuickBooksStatus();
  }, []);

  useEffect(() => {
    const billingState = new URLSearchParams(location.search).get("billing");
    const nextNotice = billingNoticeText(billingState);
    const integrationsState = new URLSearchParams(location.search).get("integrations");
    const nextIntegrationNotice = integrationNoticeText(integrationsState);

    if (!nextNotice && !nextIntegrationNotice) return;

    setNotice(nextNotice ?? nextIntegrationNotice);
    setError(null);
    navigate(settingsMode === "users" ? "/app/settings/users" : "/app/settings", { replace: true });
  }, [location.search, navigate, settingsMode]);

  async function loadMembers() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.org.users.list();
      setMembers(result.members);
      setCanManageUsers(result.policy.canManageUsers);
      setTeamMembersLimit(result.policy.teamMembersLimit);
      setTeamMembersUsed(result.policy.teamMembersUsed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading organization users.");
    } finally {
      setLoading(false);
    }
  }

  async function loadQuickBooksStatus() {
    setQuickBooksLoading(true);
    try {
      const result = await api.integrations.quickbooks.status();
      setQuickBooksStatus(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading QuickBooks integration status.");
    } finally {
      setQuickBooksLoading(false);
    }
  }

  async function createMember(event: FormEvent) {
    event.preventDefault();
    if (!canManageUsers || seatLimitReached) return;

    setSaving(true);
    setError(null);
    try {
      await api.org.users.create({
        fullName: form.fullName.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
      });
      setForm(EMPTY_NEW_USER);
      await loadMembers();
      setNotice("Team member added.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating team member.");
    } finally {
      setSaving(false);
    }
  }

  async function updateMemberRole(memberId: string, role: OrgUserRole) {
    if (!ownerView) return;
    setSaving(true);
    setError(null);
    try {
      await api.org.users.updateRole(memberId, { role });
      await loadMembers();
      setNotice("Role updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating member role.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMember() {
    if (!ownerView || !pendingRemovalMember) return;

    setSaving(true);
    setError(null);
    try {
      await api.org.users.remove(pendingRemovalMember.id);
      await loadMembers();
      setNotice("Member removed.");
      setPendingRemovalMember(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed removing member.");
    } finally {
      setSaving(false);
    }
  }

  async function startCheckout(planCode: PlanCode) {
    if (!ownerView) return;

    setBillingAction(planCode);
    setError(null);
    setNotice(null);
    try {
      const result = await api.billing.createCheckoutSession({ planCode });
      if (!result.checkoutUrl) {
        throw new Error("Stripe checkout session did not return a redirect URL.");
      }
      window.location.assign(result.checkoutUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed starting Stripe checkout.");
      setBillingAction(null);
    }
  }

  async function openBillingPortal() {
    if (!ownerView) return;

    setBillingAction("portal");
    setError(null);
    setNotice(null);
    try {
      const result = await api.billing.createPortalSession();
      window.location.assign(result.url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed opening billing portal.");
      setBillingAction(null);
    }
  }

  const seatUsageText = useMemo(() => {
    if (teamMembersLimit === null) return `${teamMembersUsed} seats in use`;
    return `${teamMembersUsed}/${teamMembersLimit} seats in use`;
  }, [teamMembersLimit, teamMembersUsed]);
  const aiQuoteLimit = session?.entitlements?.limits.aiQuotesPerMonth ?? null;
  const aiQuoteUsed = session?.usage?.monthlyAiQuoteCount ?? 0;
  const aiQuoteRemaining = aiQuoteLimit === null ? null : Math.max(aiQuoteLimit - aiQuoteUsed, 0);
  const aiUsagePercent = aiQuoteLimit && aiQuoteLimit > 0 ? Math.min((aiQuoteUsed / aiQuoteLimit) * 100, 100) : 0;
  const adminLinks = [
    { id: "admin-overview", label: "Overview", hint: "Plan + status" },
    { id: "admin-billing", label: "Billing", hint: "Plans + Stripe" },
    { id: "admin-quickbooks", label: "QuickBooks", hint: "Accounting sync" },
    { id: "admin-team", label: "Team", hint: "Users + roles" },
  ];
  const visibleAdminLinks = settingsMode === "users" ? adminLinks.filter((link) => link.id === "admin-team") : adminLinks.filter((link) => link.id !== "admin-team");

  const billingSummaryText = useMemo(() => {
    if (session?.isTrial) {
      return `Trial access active until ${dateText(session.trialEndsAtUtc)}.`;
    }

    if (session?.subscriptionCurrentPeriodEndUtc) {
      return `Current billing period ends ${dateText(session.subscriptionCurrentPeriodEndUtc)}.`;
    }

    if (activeSubscriptionPlan) {
      return "Stripe billing is connected for this workspace.";
    }

    return "No paid plan connected yet.";
  }, [
    activeSubscriptionPlan,
    session?.isTrial,
    session?.subscriptionCurrentPeriodEndUtc,
    session?.trialEndsAtUtc,
  ]);

  if (loading) {
      return (
      <div className="space-y-4">
        <PageHeader
          title="Settings"
          subtitle="Manage billing, users, and workspace access without leaving the CRM."
        />
        <Card variant="elevated" padding="lg" className="text-sm text-slate-600">
          Loading organization settings...
        </Card>
      </div>
    );
  }

  const starterLaunchMode = effectivePlanCode === "starter";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        subtitle={settingsMode === "users" ? "Manage workspace users, roles, and seat usage." : "Manage organization billing, launch-plan access, and workspace controls."}
        actions={
          ownerView && hasPortalAccess ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void openBillingPortal()}
              disabled={billingAction !== null}
              loading={billingAction === "portal"}
            >
              Manage Billing
            </Button>
          ) : undefined
        }
      />

      {error ? (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <WorkspaceRailCard
            eyebrow="Admin"
            title="Workspace Control"
            description="Billing, accounting, and team settings should be obvious and fast to scan on mobile or desktop."
          >
            <div className="flex flex-wrap gap-2">
              <Badge tone={planTone(effectivePlanCode)}>{effectivePlanName} access</Badge>
              {session?.isTrial ? <Badge tone="orange">Trial active</Badge> : null}
              <Badge tone={subscriptionTone(session?.subscriptionStatus)}>
                {sentenceCaseStatus(session?.subscriptionStatus)}
              </Badge>
              <Badge tone={starterLaunchMode ? "blue" : "amber"}>
                {starterLaunchMode ? "Starter launch" : "Advanced tiers later"}
              </Badge>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <AdminMetricCard
                icon={<PriceIcon size={16} />}
                label="Current access"
                value={effectivePlanName}
                hint={session?.isTrial ? "Trial access" : "Live plan access"}
              />
              <AdminMetricCard
                icon={<ClockIcon size={16} />}
                label="Billing state"
                value={sentenceCaseStatus(session?.subscriptionStatus)}
                hint={activeSubscriptionPlan ? `${activeSubscriptionPlan} subscribed` : "No paid plan yet"}
              />
              <AdminMetricCard
                icon={<CustomerIcon size={16} />}
                label="Team seats"
                value={seatUsageText}
                hint={teamMembersLimit === null ? "No seat cap on this plan" : "Seats enforced per plan"}
              />
            </div>
            {aiQuoteLimit !== null ? (
              <div className="mt-4 rounded-[22px] border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">AI Draft Usage</p>
                  <span className="text-xs font-semibold text-slate-900">
                    {aiQuoteUsed}/{aiQuoteLimit}
                  </span>
                </div>
                <ProgressBar
                  value={aiUsagePercent}
                  label="Monthly AI usage"
                  hint={aiQuoteRemaining === 0 ? "Limit reached for this month" : `${aiQuoteRemaining} AI drafts remaining`}
                  className="mt-3"
                />
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={settingsMode === "org" ? "primary" : "outline"}
                onClick={() => navigate("/app/settings")}
              >
                Org
              </Button>
              <Button
                size="sm"
                variant={settingsMode === "users" ? "primary" : "outline"}
                onClick={() => navigate("/app/settings/users")}
              >
                Users
              </Button>
            </div>
            <WorkspaceJumpBar links={visibleAdminLinks} className="mt-4" />
          </WorkspaceRailCard>

          <WorkspaceRailCard
            eyebrow={settingsMode === "users" ? "Access" : "Owner actions"}
            title={settingsMode === "users" ? "User management" : ownerView ? "You can manage billing" : "Read-only access"}
            description={settingsMode === "users" ? "Owners can edit roles and remove members. Admins can add members." : ownerView ? billingSummaryText : "Only workspace owners can change billing and integration settings."}
          >
            <div className="grid gap-2">
              {settingsMode === "org" && ownerView && hasPortalAccess ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openBillingPortal()}
                  disabled={billingAction !== null}
                  loading={billingAction === "portal"}
                  fullWidth
                >
                  Manage Billing
                </Button>
              ) : null}
              {settingsMode === "org" && ownerView ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  Starter launch keeps the product focused on customer management and quoting. Advanced accounting integrations stay off-sale for now.
                </div>
              ) : null}
            </div>
          </WorkspaceRailCard>
        </aside>

        <div className="space-y-6">
          {settingsMode === "org" ? (
          <WorkspaceSection
            id="admin-overview"
            step="Step 1"
            title="Overview"
            description="Keep billing, integrations, and team access aligned from one operator surface."
          >
            <Card variant="blue" padding="lg">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-2xl space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Workspace control center</p>
              <h2 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">Keep billing, integrations, and team access aligned.</h2>
            </div>
            <p className="text-sm text-slate-600 sm:text-base">{billingSummaryText}</p>
            {!ownerView ? (
              <Badge tone="amber" icon={<LockIcon size={14} />}>
                Only workspace owners can change billing and integrations
              </Badge>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:w-[620px] xl:grid-cols-4">
            <AdminMetricCard
              icon={<PriceIcon size={16} />}
              label="Current access"
              value={effectivePlanName}
              hint={session?.isTrial ? "Trial access" : "Live plan access"}
            />
            <AdminMetricCard
              icon={<ClockIcon size={16} />}
              label="Billing state"
              value={sentenceCaseStatus(session?.subscriptionStatus)}
              hint={activeSubscriptionPlan ? `${activeSubscriptionPlan} subscribed` : "No paid plan yet"}
            />
            <AdminMetricCard
              icon={<CustomerIcon size={16} />}
              label="Team seats"
              value={seatUsageText}
              hint={teamMembersLimit === null ? "No seat cap on this plan" : "Seats enforced per plan"}
            />
            <AdminMetricCard
              icon={<ClockIcon size={16} />}
              label="AI drafts"
              value={aiQuoteLimit === null ? "Unlimited" : `${aiQuoteUsed}/${aiQuoteLimit}`}
              hint={aiQuoteLimit === null ? "No monthly cap" : `${aiQuoteRemaining} remaining this month`}
            />
          </div>
        </div>
            </Card>
          </WorkspaceSection>
          ) : null}

          {settingsMode === "org" ? (
          <WorkspaceSection
            id="admin-billing"
            step="Step 2"
            title="Billing"
            description="Starter is the launch plan. Advanced tiers stay visible here, but they are not for sale yet."
            actions={!ownerView ? <Badge tone="amber">Owner only</Badge> : undefined}
          >
            <Card variant="elevated" padding="lg">
        <CardHeader
          title="Billing and Plan Controls"
          subtitle="Launch with Starter. Stripe handles billing and QuoteFly enforces access while Professional and Enterprise stay off-sale."
        />
        <div className="grid gap-4 xl:grid-cols-3">
          {PLAN_CARDS.map((plan) => {
            const isCurrentPaidPlan = activeSubscriptionPlan === plan.code;
            const isCurrentAccessPlan = effectivePlanCode === plan.code;
            const isComingSoon = plan.launchState === "coming-soon";

            return (
              <article key={plan.code} className={`rounded-[26px] border p-4 shadow-sm ${plan.accentClassName}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{plan.price}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {isCurrentAccessPlan ? <Badge tone="blue">Current access</Badge> : null}
                    {isCurrentPaidPlan ? <Badge tone="emerald">Active billing</Badge> : null}
                    {!isCurrentPaidPlan && isComingSoon ? <Badge tone="amber">Coming soon</Badge> : null}
                  </div>
                </div>

                <p className="mt-3 text-sm text-slate-600">{plan.summary}</p>

                <div className="mt-4 grid gap-2 rounded-[22px] border border-white/80 bg-white/80 p-3 text-xs font-medium text-slate-700">
                  <div>{plan.seatText}</div>
                  <div>{plan.aiQuoteText}</div>
                  <div>{plan.historyText}</div>
                </div>

                <div className="mt-4 space-y-2">
                  {plan.features.map((feature) => (
                    <div key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                      <CheckIcon size={14} className="mt-0.5 text-emerald-600" />
                      <span>{feature}</span>
                    </div>
                  ))}
                </div>

                <Button
                  type="button"
                  fullWidth
                  className="mt-5"
                  onClick={() => void startCheckout(plan.code)}
                  disabled={!ownerView || isCurrentPaidPlan || billingAction !== null || isComingSoon}
                  loading={billingAction === plan.code}
                >
                  {isCurrentPaidPlan ? "Current Paid Plan" : isComingSoon ? "Coming Soon" : `Choose ${plan.name}`}
                </Button>
              </article>
            );
          })}
        </div>

        <Card variant="default" padding="md" className="mt-4 bg-slate-50/80">
          <p className="text-sm font-semibold text-slate-900">Launch note</p>
          <p className="mt-1 text-sm text-slate-600">
            Starter is the only sellable launch plan right now. Professional and Enterprise remain visible so the roadmap is clear, but they stay off-sale until the deeper reporting and accounting surfaces are hardened.
          </p>
        </Card>
            </Card>
          </WorkspaceSection>
          ) : null}

          {settingsMode === "org" ? (
          <WorkspaceSection
            id="admin-quickbooks"
            step="Step 3"
            title="Accounting"
            description={starterLaunchMode ? "Starter launch is focused on CRM and quoting first. Direct accounting sync stays off-sale until the next release." : "Accounting integrations are being hardened for the next release."}
            actions={<Badge tone="amber">V2 roadmap</Badge>}
          >
            <Card variant="elevated" padding="lg">
        <CardHeader
          title="Accounting roadmap"
          subtitle={starterLaunchMode ? "Starter customers should focus on customer management, quote tracking, and PDF delivery. Direct accounting sync is being staged after launch." : "Advanced accounting sync is still being hardened before sale."}
        />

        <div className="flex flex-wrap gap-2">
          <Badge tone="blue">PDF quotes live</Badge>
          <Badge tone="blue">Customer pipeline live</Badge>
          <Badge tone="orange">Accounting sync later</Badge>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_320px]">
          <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">What ships now</p>
            <div className="mt-3 grid gap-2 text-sm text-slate-700">
              <p><span className="font-semibold text-slate-900">Customer pipeline:</span> new through sold, with clear status handling.</p>
              <p><span className="font-semibold text-slate-900">Quote workflow:</span> draft, send, close, and PDF actions from one workspace.</p>
              <p><span className="font-semibold text-slate-900">Team access:</span> Starter seat and AI limits are enforced from billing.</p>
              <p><span className="font-semibold text-slate-900">Exports:</span> PDF delivery is part of the launch workflow today.</p>
            </div>
          </div>

          <Card variant="default" padding="md">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Later release</p>
            <div className="mt-3 space-y-3 text-sm text-slate-600">
              <p>Professional and Enterprise will take on accounting workflows only after the starter CRM and quoting path is stable in production.</p>
              <ul className="space-y-2 text-sm text-slate-700">
                <li>- Direct QuickBooks Online connection</li>
                <li>- Invoice push and status refresh</li>
                <li>- Deeper accounting automation and reconciliation</li>
              </ul>
              {quickBooksLoading ? (
                <p className="text-xs text-slate-400">Checking internal QuickBooks foundation...</p>
              ) : (
                <p className="text-xs text-slate-500">
                  Internal foundation status: {quickBooksStatus?.enabled ? "configured" : "not configured"}.
                </p>
              )}
            </div>
          </Card>
        </div>
            </Card>
          </WorkspaceSection>
          ) : null}

          {settingsMode === "users" ? (
          <WorkspaceSection
            id="admin-team"
            step="Users"
            title="Team"
            description="Invite field users and office staff into the same workspace and keep role controls obvious."
            actions={<Badge tone={seatLimitReached ? "amber" : "slate"}>{seatUsageText}</Badge>}
          >
            <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card variant="elevated" padding="lg">
          <CardHeader
            title="Add Team Member"
            subtitle="Invite field users and office staff into the same workspace."
          />
          <form onSubmit={createMember} className="space-y-3">
            <Input
              label="Full name"
              placeholder="Full name"
              value={form.fullName}
              onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Input
              label="Email"
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Input
              label="Temporary password"
              type="password"
              minLength={8}
              placeholder="Minimum 8 characters"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Select
              label="Role"
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as OrgUserRole }))}
              options={ROLE_OPTIONS}
              disabled={!canManageUsers || saving || seatLimitReached}
            />
            <Button
              type="submit"
              fullWidth
              disabled={!canManageUsers || saving || seatLimitReached}
              loading={saving}
            >
              Add User
            </Button>
          </form>
          {!canManageUsers ? (
            <p className="mt-3 text-xs text-slate-500">Your role cannot add users. Ask an owner or admin.</p>
          ) : null}
          {seatLimitReached ? (
            <div className="mt-3">
              <Alert tone="warning">Seat limit reached. Upgrade the workspace plan to add more users.</Alert>
            </div>
          ) : null}
        </Card>

        <Card variant="elevated" padding="lg">
          <CardHeader
            title="Organization Users"
            subtitle="Owners can edit roles and remove members. Admins can add members. Members are read-only."
            actions={<Badge tone="slate">{members.length} users</Badge>}
          />
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {members.length ? (
              <>
                <div className="hidden grid-cols-[minmax(0,1.2fr)_120px_128px_112px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                  <span>User</span>
                  <span>Role</span>
                  <span>Joined</span>
                  <span>Action</span>
                </div>
                <div className="divide-y divide-slate-200">
                  {members.map((member) => (
                    <div key={member.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.2fr)_120px_128px_112px] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
                            {member.user.fullName
                              .split(" ")
                              .map((part) => part[0] ?? "")
                              .join("")
                              .slice(0, 2)
                              .toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{member.user.fullName}</p>
                            <p className="mt-1 truncate text-xs text-slate-500">{member.user.email}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={roleTone(member.role)}>{roleLabel(member.role)}</Badge>
                      </div>
                      <div className="text-xs text-slate-500">Joined {dateText(member.createdAt)}</div>
                      <div className="grid gap-2 sm:grid-cols-[1fr_auto] lg:grid-cols-[1fr]">
                        {ownerView ? (
                      <Select
                        aria-label={`Role for ${member.user.fullName}`}
                        value={member.role}
                        disabled={!ownerView || saving}
                        onChange={(event) => void updateMemberRole(member.id, event.target.value as OrgUserRole)}
                        options={ROLE_OPTIONS}
                        className="min-h-[36px]"
                      />
                        ) : null}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setPendingRemovalMember(member)}
                        disabled={!ownerView || member.role === "owner" || saving}
                        size="sm"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
                </div>
              </>
            ) : (
              <Card variant="default" padding="md" className="bg-slate-50/80 text-sm text-slate-500">
                No organization users found.
              </Card>
            )}
          </div>
        </Card>
            </div>
          </WorkspaceSection>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        open={pendingRemovalMember !== null}
        onClose={() => setPendingRemovalMember(null)}
        onConfirm={() => void removeMember()}
        title="Remove team member"
        description={
          pendingRemovalMember
            ? `Remove ${pendingRemovalMember.user.fullName} from this workspace? They will lose access immediately.`
            : "Remove this member from the workspace?"
        }
        confirmLabel="Remove member"
        loading={saving}
      />
    </div>
  );
}

function AdminMetricCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600">
          {icon}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
