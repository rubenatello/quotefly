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
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { CheckIcon, ClockIcon, CustomerIcon, LockIcon, PriceIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, CardHeader, ConfirmModal, Input, PageHeader, Select } from "../components/ui";
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
    summary: "For solo operators and small crews that need clean quoting fast.",
    seatText: "Up to 7 users",
    aiQuoteText: "30 AI quote drafts / month",
    historyText: "30-day quote history",
    accentClassName: "border-blue-200 bg-blue-50/70",
    features: [
      "600 quotes per month",
      "Quick customer intake and pipeline tracking",
      "PDF quote generation",
      "QuickBooks Online invoice sync and CSV fallback",
    ],
  },
  {
    code: "professional",
    name: "Professional",
    price: "$59/mo",
    summary: "For field teams that need stronger pipeline visibility and revision tracking.",
    seatText: "Up to 15 users",
    aiQuoteText: "300 AI quote drafts / month",
    historyText: "180-day quote history",
    accentClassName: "border-orange-200 bg-orange-50/70",
    features: [
      "5,000 quotes per month",
      "Quote version history",
      "Communication log and advanced analytics",
      "Multi-trade workspace support",
    ],
  },
  {
    code: "enterprise",
    name: "Enterprise",
    price: "$249/mo",
    summary: "For larger operations that need automation, governance, and integrations.",
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
  const [quickBooksActionLoading, setQuickBooksActionLoading] = useState(false);
  const [quickBooksActionMode, setQuickBooksActionMode] = useState<"connect" | "disconnect" | null>(null);

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
    navigate("/app/admin", { replace: true });
  }, [location.search, navigate]);

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

  async function connectQuickBooks() {
    if (!ownerView) return;

    setQuickBooksActionLoading(true);
    setQuickBooksActionMode("connect");
    setError(null);
    try {
      const result = await api.integrations.quickbooks.connect();
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed starting QuickBooks authorization.");
      setQuickBooksActionLoading(false);
      setQuickBooksActionMode(null);
    }
  }

  async function disconnectQuickBooks() {
    if (!ownerView) return;

    setQuickBooksActionLoading(true);
    setQuickBooksActionMode("disconnect");
    setError(null);
    try {
      await api.integrations.quickbooks.disconnect();
      await loadQuickBooksStatus();
      setNotice("QuickBooks disconnected from this workspace.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed disconnecting QuickBooks.");
    } finally {
      setQuickBooksActionLoading(false);
      setQuickBooksActionMode(null);
    }
  }

  const seatUsageText = useMemo(() => {
    if (teamMembersLimit === null) return `${teamMembersUsed} seats in use`;
    return `${teamMembersUsed}/${teamMembersLimit} seats in use`;
  }, [teamMembersLimit, teamMembersUsed]);
  const adminLinks = [
    { id: "admin-overview", label: "Overview", hint: "Plan + status" },
    { id: "admin-billing", label: "Billing", hint: "Plans + Stripe" },
    { id: "admin-quickbooks", label: "QuickBooks", hint: "Accounting sync" },
    { id: "admin-team", label: "Team", hint: "Users + roles" },
  ];

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
          title="Organization Admin"
          subtitle="Manage billing, team seats, and workspace access without leaving the CRM."
        />
        <Card variant="elevated" padding="lg" className="text-sm text-slate-600">
          Loading organization settings...
        </Card>
      </div>
    );
  }

  const quickBooksConnected = Boolean(quickBooksStatus?.connection);
  const quickBooksEnvironmentLabel = quickBooksStatus?.environment === "sandbox" ? "Sandbox" : "Production";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organization Admin"
        subtitle="Manage billing, integrations, and team access without leaving the CRM."
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
              <Badge tone={quickBooksConnected ? "emerald" : "slate"}>
                QB {quickBooksConnected ? "Connected" : "Not linked"}
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
            <WorkspaceJumpBar links={adminLinks} className="mt-4" />
          </WorkspaceRailCard>

          <WorkspaceRailCard
            eyebrow="Owner actions"
            title={ownerView ? "You can manage billing" : "Read-only access"}
            description={ownerView ? billingSummaryText : "Only workspace owners can change billing and integration settings."}
          >
            <div className="grid gap-2">
              {ownerView && hasPortalAccess ? (
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
              {ownerView ? (
                <Button
                  type="button"
                  onClick={() => void connectQuickBooks()}
                  disabled={!quickBooksStatus?.enabled || quickBooksActionLoading}
                  loading={quickBooksActionLoading && quickBooksActionMode === "connect"}
                  fullWidth
                >
                  {quickBooksConnected ? "Reconnect QuickBooks" : "Connect QuickBooks"}
                </Button>
              ) : null}
            </div>
          </WorkspaceRailCard>
        </aside>

        <div className="space-y-6">
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

          <div className="grid gap-3 sm:grid-cols-3 xl:w-[460px]">
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
        </div>
            </Card>
          </WorkspaceSection>

          <WorkspaceSection
            id="admin-billing"
            step="Step 2"
            title="Billing"
            description="Choose the plan that matches your crew size. Stripe handles billing and QuoteFly enforces access."
            actions={!ownerView ? <Badge tone="amber">Owner only</Badge> : undefined}
          >
            <Card variant="elevated" padding="lg">
        <CardHeader
          title="Billing and Plan Controls"
          subtitle="Choose the plan that matches your crew size. Stripe handles billing and QuoteFly enforces tenant access."
        />
        <div className="grid gap-4 xl:grid-cols-3">
          {PLAN_CARDS.map((plan) => {
            const isCurrentPaidPlan = activeSubscriptionPlan === plan.code;
            const isCurrentAccessPlan = effectivePlanCode === plan.code;

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
                  disabled={!ownerView || isCurrentPaidPlan || billingAction !== null}
                  loading={billingAction === plan.code}
                >
                  {isCurrentPaidPlan ? "Current Paid Plan" : `Choose ${plan.name}`}
                </Button>
              </article>
            );
          })}
        </div>

        <Card variant="default" padding="md" className="mt-4 bg-slate-50/80">
          <p className="text-sm font-semibold text-slate-900">Operational note</p>
          <p className="mt-1 text-sm text-slate-600">
            Stripe manages billing. QuoteFly manages tenant access, seat limits, AI quote limits, and feature unlocks based on the plan attached to this workspace.
          </p>
        </Card>
            </Card>
          </WorkspaceSection>

          <WorkspaceSection
            id="admin-quickbooks"
            step="Step 3"
            title="QuickBooks"
            description="Link one QuickBooks company to this tenant so accepted quotes can move into invoice workflows."
            actions={<Badge tone={quickBooksStatus?.environment === "sandbox" ? "amber" : "slate"}>{quickBooksEnvironmentLabel}</Badge>}
          >
            <Card variant="elevated" padding="lg">
        <CardHeader
          title="QuickBooks Online"
          subtitle="Link one QuickBooks company to this tenant so accepted quotes can move into invoice workflows."
        />

        <div className="flex flex-wrap gap-2">
          <Badge tone={quickBooksConnected ? "emerald" : "slate"}>
            {quickBooksConnected ? quickBooksStatus?.connection?.status ?? "Connected" : "Not linked"}
          </Badge>
          <Badge tone={quickBooksStatus?.enabled ? "blue" : "amber"}>
            {quickBooksStatus?.enabled ? "API configured" : "API setup missing"}
          </Badge>
          <Badge tone={quickBooksStatus?.webhookConfigured ? "emerald" : "amber"}>
            {quickBooksStatus?.webhookConfigured ? "Webhook ready" : "Webhook verifier missing"}
          </Badge>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_320px]">
          <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Connection Summary</p>
            {quickBooksLoading ? (
              <p className="mt-3 text-sm text-slate-600">Loading QuickBooks status...</p>
            ) : quickBooksStatus?.connection ? (
              <div className="mt-3 grid gap-2 text-sm text-slate-700">
                <p><span className="font-semibold text-slate-900">Company:</span> {quickBooksStatus.connection.companyName ?? "Connected company"}</p>
                <p><span className="font-semibold text-slate-900">Realm ID:</span> {quickBooksStatus.connection.realmId}</p>
                <p><span className="font-semibold text-slate-900">Connected:</span> {dateText(quickBooksStatus.connection.connectedAtUtc)}</p>
                <p><span className="font-semibold text-slate-900">Customer maps:</span> {quickBooksStatus.connection.counts.customerMaps}</p>
                <p><span className="font-semibold text-slate-900">Item maps:</span> {quickBooksStatus.connection.counts.itemMaps}</p>
                <p><span className="font-semibold text-slate-900">Invoice sync records:</span> {quickBooksStatus.connection.counts.invoiceSyncs}</p>
                {quickBooksStatus.connection.lastError ? (
                  <Alert tone="error">{quickBooksStatus.connection.lastError}</Alert>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <p>No QuickBooks company is linked to this tenant yet.</p>
                <p>Once linked, QuoteFly keeps customer, item, and invoice sync state isolated by tenant.</p>
              </div>
            )}
          </div>

          <Card variant="default" padding="md">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Owner Actions</p>
            {!quickBooksStatus?.enabled ? (
              <Alert tone="warning">
                QuickBooks credentials are not configured on the API yet.
              </Alert>
            ) : null}

            <div className="mt-4 grid gap-2">
              <Button
                type="button"
                onClick={() => void connectQuickBooks()}
                disabled={!ownerView || !quickBooksStatus?.enabled || quickBooksActionLoading}
                loading={quickBooksActionLoading && quickBooksActionMode === "connect"}
              >
                {quickBooksConnected ? "Reconnect QuickBooks" : "Connect QuickBooks"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void disconnectQuickBooks()}
                disabled={!ownerView || !quickBooksConnected || quickBooksActionLoading}
                loading={quickBooksActionLoading && quickBooksActionMode === "disconnect"}
              >
                Disconnect
              </Button>
            </div>

            {!ownerView ? (
              <p className="mt-3 text-xs text-slate-500">
                Only workspace owners can change billing and integration connections.
              </p>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">Redirect URI: {quickBooksStatus?.redirectUri ?? "Loading..."}</p>
            <p className="mt-1 text-xs text-slate-500">Webhook URL: {quickBooksStatus?.webhookUrl ?? "Loading..."}</p>
          </Card>
        </div>
            </Card>
          </WorkspaceSection>

          <WorkspaceSection
            id="admin-team"
            step="Step 4"
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
          <div className="space-y-3">
            {members.length ? (
              members.map((member) => (
                <div
                  key={member.id}
                  className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900">{member.user.fullName}</p>
                        <Badge tone={roleTone(member.role)}>{roleLabel(member.role)}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-600">{member.user.email}</p>
                      <p className="mt-1 text-[11px] text-slate-500">Joined {dateText(member.createdAt)}</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[160px_auto] lg:min-w-[310px]">
                      <Select
                        aria-label={`Role for ${member.user.fullName}`}
                        value={member.role}
                        disabled={!ownerView || saving}
                        onChange={(event) => void updateMemberRole(member.id, event.target.value as OrgUserRole)}
                        options={ROLE_OPTIONS}
                      />
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setPendingRemovalMember(member)}
                        disabled={!ownerView || member.role === "owner" || saving}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <Card variant="default" padding="md" className="bg-slate-50/80 text-sm text-slate-500">
                No organization users found.
              </Card>
            )}
          </div>
        </Card>
            </div>
          </WorkspaceSection>
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
    <div className="rounded-[24px] border border-white/75 bg-white/85 p-4 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        {icon}
        {label}
      </div>
      <p className="mt-3 text-lg font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
