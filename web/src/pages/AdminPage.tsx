import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
import { ConfirmModal } from "../components/ui";

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
    aiQuoteText: "10 AI quote drafts / month",
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
    aiQuoteText: "50 AI quote drafts / month",
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
    aiQuoteText: "300 AI quote drafts / month",
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
    setError(null);
    try {
      const result = await api.integrations.quickbooks.connect();
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed starting QuickBooks authorization.");
      setQuickBooksActionLoading(false);
    }
  }

  async function disconnectQuickBooks() {
    if (!ownerView) return;

    setQuickBooksActionLoading(true);
    setError(null);
    try {
      await api.integrations.quickbooks.disconnect();
      await loadQuickBooksStatus();
      setNotice("QuickBooks disconnected from this workspace.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed disconnecting QuickBooks.");
    } finally {
      setQuickBooksActionLoading(false);
    }
  }

  const seatUsageText = useMemo(() => {
    if (teamMembersLimit === null) return `${teamMembersUsed} seats in use`;
    return `${teamMembersUsed}/${teamMembersLimit} seats in use`;
  }, [teamMembersLimit, teamMembersUsed]);

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
    return <div className="min-h-screen bg-slate-50 p-6 text-slate-700">Loading organization settings...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-bold text-slate-900">Organization Admin</h1>
              <p className="mt-2 text-sm text-slate-600">
                Manage billing, team seats, and workspace access without leaving the CRM.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                  {effectivePlanName} access
                </span>
                {session?.isTrial && (
                  <span className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                    Trial active
                  </span>
                )}
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  Status: {sentenceCaseStatus(session?.subscriptionStatus)}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-500">{billingSummaryText}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:w-[420px]">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <PriceIcon size={16} />
                  Current access
                </div>
                <p className="mt-3 text-lg font-semibold text-slate-900">{effectivePlanName}</p>
                <p className="mt-1 text-xs text-slate-500">{session?.isTrial ? "Trial access" : "Live plan access"}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <ClockIcon size={16} />
                  Billing state
                </div>
                <p className="mt-3 text-lg font-semibold text-slate-900">{sentenceCaseStatus(session?.subscriptionStatus)}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {activeSubscriptionPlan ? `${activeSubscriptionPlan} subscribed` : "No paid plan yet"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <CustomerIcon size={16} />
                  Team seats
                </div>
                <p className="mt-3 text-lg font-semibold text-slate-900">{seatUsageText}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {teamMembersLimit === null ? "No seat cap on this plan" : "Seats are enforced per plan"}
                </p>
              </div>
            </div>
          </div>
        </section>

        {error && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-lg font-semibold text-slate-900">Billing and Plan Controls</h2>
              <p className="mt-2 text-sm text-slate-600">
                Choose the plan that matches your crew size. Stripe handles billing, and QuoteFly enforces access by tenant.
              </p>
              {!ownerView && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                  <LockIcon size={14} />
                  Only workspace owners can change billing
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void openBillingPortal()}
                disabled={!ownerView || !hasPortalAccess || billingAction !== null}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {billingAction === "portal" ? "Opening portal..." : "Manage Billing"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {PLAN_CARDS.map((plan) => {
              const isCurrentPaidPlan = activeSubscriptionPlan === plan.code;
              const isCurrentAccessPlan = effectivePlanCode === plan.code;

              return (
                <article key={plan.code} className={`rounded-2xl border p-4 shadow-sm ${plan.accentClassName}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                      <p className="mt-1 text-2xl font-bold text-slate-900">{plan.price}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {isCurrentAccessPlan && (
                        <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                          Current access
                        </span>
                      )}
                      {isCurrentPaidPlan && (
                        <span className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                          Active billing plan
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="mt-3 text-sm text-slate-600">{plan.summary}</p>

                  <div className="mt-4 grid gap-2 rounded-xl border border-white/80 bg-white/80 p-3 text-xs font-medium text-slate-700">
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

                  <button
                    type="button"
                    onClick={() => void startCheckout(plan.code)}
                    disabled={!ownerView || isCurrentPaidPlan || billingAction !== null}
                    className="mt-5 w-full rounded-xl bg-quotefly-blue px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {billingAction === plan.code
                      ? "Redirecting..."
                      : isCurrentPaidPlan
                        ? "Current Paid Plan"
                        : `Choose ${plan.name}`}
                  </button>
                </article>
              );
            })}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-900">Operational note</p>
            <p className="mt-1">
              Stripe manages billing. QuoteFly manages tenant access, seat limits, AI quote limits, and feature unlocking based on the plan attached to this workspace.
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-lg font-semibold text-slate-900">QuickBooks Online</h2>
              <p className="mt-2 text-sm text-slate-600">
                Link one QuickBooks Online company to this tenant. QuoteFly can then map customers and service items, push accepted quotes into invoices, and refresh invoice balance status.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                Redirect URI: {quickBooksStatus?.redirectUri ?? "Loading..."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {quickBooksStatus?.environment === "sandbox" ? "Sandbox" : "Production"}
              </span>
              {quickBooksStatus?.connection ? (
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  {quickBooksStatus.connection.status}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  Not linked
                </span>
              )}
            </div>
          </div>

          {quickBooksLoading ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Loading QuickBooks status...
            </div>
          ) : (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_320px]">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Connection Summary</p>
                {quickBooksStatus?.connection ? (
                  <div className="mt-3 space-y-2 text-sm text-slate-700">
                    <p><span className="font-semibold text-slate-900">Company:</span> {quickBooksStatus.connection.companyName ?? "Connected company"}</p>
                    <p><span className="font-semibold text-slate-900">Realm ID:</span> {quickBooksStatus.connection.realmId}</p>
                    <p><span className="font-semibold text-slate-900">Connected:</span> {dateText(quickBooksStatus.connection.connectedAtUtc)}</p>
                    <p><span className="font-semibold text-slate-900">Customer maps:</span> {quickBooksStatus.connection.counts.customerMaps}</p>
                    <p><span className="font-semibold text-slate-900">Item maps:</span> {quickBooksStatus.connection.counts.itemMaps}</p>
                    <p><span className="font-semibold text-slate-900">Invoice sync records:</span> {quickBooksStatus.connection.counts.invoiceSyncs}</p>
                    {quickBooksStatus.connection.lastError ? (
                      <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {quickBooksStatus.connection.lastError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 space-y-2 text-sm text-slate-600">
                    <p>No QuickBooks company is linked to this tenant yet.</p>
                    <p>
                      Once linked, QuoteFly can keep customer, item, and invoice sync state isolated by tenant.
                    </p>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Owner Actions</p>
                {!quickBooksStatus?.enabled ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                    QuickBooks credentials are not configured on the API yet.
                  </div>
                ) : null}

                <div className="mt-4 grid gap-2">
                  <button
                    type="button"
                    onClick={() => void connectQuickBooks()}
                    disabled={!ownerView || !quickBooksStatus?.enabled || quickBooksActionLoading}
                    className="inline-flex items-center justify-center rounded-2xl border border-transparent bg-[linear-gradient(135deg,#2f78bf_0%,#5B85AA_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(47,120,191,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {quickBooksStatus?.connection ? "Reconnect QuickBooks" : "Connect QuickBooks"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void disconnectQuickBooks()}
                    disabled={!ownerView || !quickBooksStatus?.connection || quickBooksActionLoading}
                    className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>

                {!ownerView && (
                  <p className="mt-3 text-xs text-slate-500">
                    Only workspace owners can change billing and integration connections.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <form onSubmit={createMember} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Add Team Member</h2>
            <p className="text-sm text-slate-500">
              Invite field users and office staff into the same workspace.
            </p>
            <input
              placeholder="Full name"
              value={form.fullName}
              onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <input
              type="password"
              minLength={8}
              placeholder="Temporary password (min 8)"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as OrgUserRole }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving || seatLimitReached}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
            <button
              type="submit"
              disabled={!canManageUsers || saving || seatLimitReached}
              className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {saving ? "Saving..." : "Add User"}
            </button>
            {!canManageUsers && (
              <p className="text-xs text-slate-500">
                Your role cannot add users. Ask an owner or admin.
              </p>
            )}
            {seatLimitReached && (
              <p className="text-xs text-amber-700">
                Seat limit reached. Upgrade the workspace plan to add more users.
              </p>
            )}
          </form>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Organization Users</h2>
            <p className="mb-4 text-sm text-slate-500">
              Role permissions: owner can edit roles and remove members. Admin can add members. Member is read-only.
            </p>
            <div className="space-y-3">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{member.user.fullName}</p>
                    <p className="text-xs text-slate-600">{member.user.email}</p>
                    <p className="text-[11px] text-slate-500">Joined {dateText(member.createdAt)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 sm:mt-0 sm:justify-end">
                    <select
                      value={member.role}
                      disabled={!ownerView || saving}
                      onChange={(event) =>
                        void updateMemberRole(member.id, event.target.value as OrgUserRole)
                      }
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-60"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                    <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700">
                      {roleLabel(member.role)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingRemovalMember(member)}
                      disabled={!ownerView || member.role === "owner" || saving}
                      className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {!members.length && (
                <p className="rounded-lg border border-slate-200 bg-white px-3 py-4 text-sm text-slate-500">
                  No organization users found.
                </p>
              )}
            </div>
          </section>
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
    </div>
  );
}
