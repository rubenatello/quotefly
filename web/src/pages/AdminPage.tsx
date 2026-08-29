import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  api,
  type OrganizationUser,
  type OrgUserRole,
  type PlanCode,
  type QuickBooksStatusPayload,
  type TenantEntitlements,
  type TenantUsageSnapshot,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { BASIC_PLAN } from "../lib/plans";
import { CheckIcon, ClockIcon, CustomerIcon, LockIcon, PriceIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, CardHeader, ConfirmModal, Input, PageHeader, PaginationControls, ProgressBar, Select, type PageSize } from "../components/ui";
import { WorkspaceJumpBar, WorkspaceSection } from "../components/ui/workspace";
import { ThemeSelector } from "../components/settings/ThemeSelector";
import { LanguageSelector } from "../components/settings/LanguageSelector";
import { FollowUpSettingsPanel } from "../components/settings/FollowUpSettingsPanel";
import { notify } from "../lib/notifications";
import { formatAiUsageBreakdown } from "../lib/ai-credits";
import { localizedApiError } from "../lib/localized-api-error";
import { QuickBooksSetupPanel } from "../components/integrations/QuickBooksSetupPanel";
import { isTrustedQuickBooksAuthorizationUrl, normalizeQuickBooksStatusPayload } from "../lib/quickbooks";

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
    isSuperuser?: boolean;
  } | null;
}

type NewUserForm = {
  fullName: string;
  email: string;
  password: string;
  role: OrgUserRole;
};

type BillingAction = PlanCode | "portal" | null;
type QuickBooksAction = "connect" | "confirm" | "disconnect" | null;
type SettingsCategory = "general" | "follow-up" | "billing" | "quickbooks" | "team";

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

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function buildPlanCards(t: TFunction, locale: string): readonly PlanCard[] {
  return [
  {
    code: "starter",
    name: t("admin.plan.basic"),
    price: t("billing.monthlyPrice", { price: formatUsd(BASIC_PLAN.monthlyPriceUsd, locale) }),
    launchState: "available",
    summary: t("admin.plan.basicSummary"),
    seatText: t("admin.plan.upToUsers", { count: BASIC_PLAN.teamMembers }),
    aiQuoteText: t("admin.plan.aiIncluded"),
    historyText: t("admin.plan.historyDays", { count: BASIC_PLAN.quoteHistoryDays }),
    accentClassName: "border-blue-200 bg-blue-50/70",
    features: [
      t("admin.plan.trialOffer", { days: BASIC_PLAN.trialDays, price: formatUsd(BASIC_PLAN.firstPaidMonthPriceUsd, locale) }),
      t("admin.plan.quotesMonthly", { count: BASIC_PLAN.quotesPerMonth }),
      t("admin.plan.basicFeatures.intake"),
      t("admin.plan.basicFeatures.pdf"),
      t("admin.plan.basicFeatures.tracking"),
    ],
  },
  {
    code: "professional",
    name: t("admin.plan.professional"),
    price: t("billing.monthlyPrice", { price: formatUsd(59, locale) }),
    launchState: "coming-soon",
    summary: t("admin.plan.professionalSummary"),
    seatText: t("admin.plan.upToUsers", { count: 15 }),
    aiQuoteText: t("admin.plan.aiHigher"),
    historyText: t("admin.plan.historyDays", { count: 180 }),
    accentClassName: "border-orange-200 bg-orange-50/70",
    features: [
      t("admin.plan.professionalFeatures.history"),
      t("admin.plan.professionalFeatures.analytics"),
      t("admin.plan.professionalFeatures.multiTrade"),
      t("admin.plan.professionalFeatures.accounting"),
    ],
  },
  {
    code: "enterprise",
    name: t("admin.plan.enterprise"),
    price: t("billing.monthlyPrice", { price: formatUsd(249, locale) }),
    launchState: "coming-soon",
    summary: t("admin.plan.enterpriseSummary"),
    seatText: t("admin.plan.unlimitedUsers"),
    aiQuoteText: t("admin.plan.aiExpanded"),
    historyText: t("admin.plan.historyUnlimited"),
    accentClassName: "border-slate-300 bg-slate-100",
    features: [
      t("admin.plan.enterpriseFeatures.quotes"),
      t("admin.plan.enterpriseFeatures.api"),
      t("admin.plan.enterpriseFeatures.ai"),
      t("admin.plan.enterpriseFeatures.integrations"),
    ],
  },
  ];
}

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

function roleLabel(role: OrgUserRole, t: TFunction): string {
  if (role === "owner") return t("domain.role.owner");
  if (role === "admin") return t("domain.role.admin");
  return t("domain.role.member");
}

function dateText(value: string | null | undefined, locale: string, t: TFunction): string {
  if (!value) return t("admin.status.notSet");
  return new Date(value).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function subscriptionStatusLabel(value: string | null | undefined, t: TFunction): string {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "active") return t("admin.status.active");
  if (normalized === "trialing") return t("admin.status.trialing");
  if (normalized === "past_due") return t("admin.status.pastDue");
  if (normalized === "unpaid") return t("admin.status.unpaid");
  if (normalized === "canceled") return t("admin.status.canceled");
  if (normalized === "incomplete") return t("admin.status.incomplete");
  if (normalized === "paused") return t("admin.status.paused");
  return t("admin.status.unknown");
}

function billingNoticeText(code: string | null, subscriptionConfirmed: boolean, t: TFunction): string | null {
  if (code === "success") {
    return subscriptionConfirmed
      ? t("admin.notices.billingActive")
      : t("admin.notices.billingConfirming");
  }
  if (code === "cancel") return t("admin.notices.billingCanceled");
  if (code === "portal") return t("admin.notices.billingPortalReturned");
  return null;
}

function integrationNoticeText(code: string | null, t: TFunction): string | null {
  if (code === "quickbooks_connected") return t("admin.notices.quickBooksConnected");
  if (code === "quickbooks_denied") return t("admin.notices.quickBooksDenied");
  if (code === "quickbooks_invalid_state") return t("admin.notices.quickBooksInvalid");
  if (code === "quickbooks_realm_in_use") return t("admin.notices.quickBooksInUse");
  if (code === "quickbooks_disconnect_pending") return t("admin.notices.quickBooksDisconnectPending");
  if (code === "quickbooks_not_configured") return t("admin.notices.quickBooksUnavailable");
  if (code === "quickbooks_error") return t("admin.notices.quickBooksError");
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
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const planCards = buildPlanCards(t, locale);
  const roleOptions: Array<{ value: OrgUserRole; label: string }> = [
    { value: "member", label: t("domain.role.member") },
    { value: "admin", label: t("domain.role.admin") },
    { value: "owner", label: t("domain.role.owner") },
  ];
  const navigate = useNavigate();
  const location = useLocation();
  const settingsMode: "org" | "users" = location.pathname.startsWith("/app/settings/users") ? "users" : "org";
  const [members, setMembers] = useState<OrganizationUser[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState<PageSize>(25);
  const [memberTotal, setMemberTotal] = useState(0);
  const [teamMembersLimit, setTeamMembersLimit] = useState<number | null>(
    session?.entitlements?.limits.teamMembers ?? null,
  );
  const [teamMembersUsed, setTeamMembersUsed] = useState(0);
  const [seatPlanName, setSeatPlanName] = useState(session?.entitlements?.seatPlanName ?? "Basic");
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [loading, setLoading] = useState(settingsMode === "users");
  const [saving, setSaving] = useState(false);
  const [billingAction, setBillingAction] = useState<BillingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<NewUserForm>(EMPTY_NEW_USER);
  const [pendingRemovalMember, setPendingRemovalMember] = useState<OrganizationUser | null>(null);
  const [quickBooksStatus, setQuickBooksStatus] = useState<QuickBooksStatusPayload | null>(null);
  const [quickBooksLoading, setQuickBooksLoading] = useState(true);
  const [quickBooksError, setQuickBooksError] = useState<string | null>(null);
  const [quickBooksAction, setQuickBooksAction] = useState<QuickBooksAction>(null);
  const [confirmQuickBooksSetupOpen, setConfirmQuickBooksSetupOpen] = useState(false);
  const [disconnectQuickBooksOpen, setDisconnectQuickBooksOpen] = useState(false);
  const [followUpDirty, setFollowUpDirty] = useState(false);
  const [pendingSettingsCategory, setPendingSettingsCategory] = useState<SettingsCategory | null>(null);
  const memberRequestIdRef = useRef(0);

  const sessionRole = normalizeRole(session?.role ?? "member");
  const superuserView = Boolean(session?.isSuperuser);
  const ownerView = sessionRole === "owner";
  const canManageQuickBooks = sessionRole === "owner" || sessionRole === "admin";
  const canManageFollowUp = sessionRole === "owner" || sessionRole === "admin";
  const activeSubscriptionPlan = normalizePlanCode(session?.subscriptionPlanCode);
  const effectivePlanCode = session?.effectivePlanCode ?? session?.entitlements?.planCode ?? "starter";
  const effectivePlanName = session?.effectivePlanName ?? session?.entitlements?.planName ?? "Basic";
  const displayPlanName = session?.isTrial ? t("admin.plan.fullTrial") : effectivePlanName;
  const seatLimitReached = teamMembersLimit !== null && teamMembersUsed >= teamMembersLimit;
  const hasPortalAccess =
    activeSubscriptionPlan !== null ||
    ["active", "past_due", "unpaid", "canceled", "incomplete", "paused"].includes(
      (session?.subscriptionStatus ?? "").toLowerCase(),
    );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedMemberSearch(memberSearch.trim());
      setMemberPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [memberSearch]);

  const loadMembers = useCallback(async () => {
    const requestId = ++memberRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.org.users.list({
        limit: memberPageSize,
        offset: (memberPage - 1) * memberPageSize,
        search: debouncedMemberSearch || undefined,
      });
      if (requestId !== memberRequestIdRef.current) return;
      setMembers(result.members);
      setMemberTotal(result.pagination.total);
      setCanManageUsers(result.policy.canManageUsers);
      setTeamMembersLimit(result.policy.teamMembersLimit);
      setTeamMembersUsed(result.policy.teamMembersUsed);
      setSeatPlanName(result.policy.seatPlanName);
    } catch (err) {
      if (requestId !== memberRequestIdRef.current) return;
      setError(localizedApiError(err, t, { fallbackKey: "admin.errors.loadUsers" }));
    } finally {
      if (requestId === memberRequestIdRef.current) setLoading(false);
    }
  }, [debouncedMemberSearch, memberPage, memberPageSize, t]);

  const loadQuickBooksStatus = useCallback(async () => {
    if (!canManageQuickBooks) {
      setQuickBooksStatus(null);
      setQuickBooksLoading(false);
      return;
    }

    setQuickBooksLoading(true);
    setQuickBooksError(null);
    try {
      const result = await api.integrations.quickbooks.status();
      const normalizedStatus = normalizeQuickBooksStatusPayload(result);
      if (!normalizedStatus) {
        setQuickBooksStatus(null);
        setQuickBooksError(t("admin.quickBooksSetup.loadError"));
        return;
      }
      setQuickBooksStatus(normalizedStatus);
    } catch (err) {
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "admin.errors.loadQuickBooks" }));
    } finally {
      setQuickBooksLoading(false);
    }
  }, [canManageQuickBooks, t]);

  const startQuickBooksConnection = useCallback(async () => {
    setQuickBooksAction("connect");
    setQuickBooksError(null);
    try {
      const result = await api.integrations.quickbooks.connect();
      if (!isTrustedQuickBooksAuthorizationUrl(result.authorizationUrl)) {
        throw new Error(t("admin.quickBooksSetup.untrustedAuthorizationUrl"));
      }
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setQuickBooksError(
        err instanceof Error && err.message === t("admin.quickBooksSetup.untrustedAuthorizationUrl")
          ? err.message
          : localizedApiError(err, t, { fallbackKey: "admin.quickBooksSetup.connectError" }),
      );
      setQuickBooksAction(null);
    }
  }, [t]);

  const confirmQuickBooksSetup = useCallback(async () => {
    if (!quickBooksStatus) return;
    setQuickBooksAction("confirm");
    setQuickBooksError(null);
    try {
      await api.integrations.quickbooks.confirmSetup({
        checklistVersion: quickBooksStatus.setup.checklistVersion,
        companyConfirmed: true,
        reviewResponsibilityConfirmed: true,
      });
      setConfirmQuickBooksSetupOpen(false);
      setNotice(t("admin.notices.quickBooksSetupConfirmed"));
      await loadQuickBooksStatus();
    } catch (err) {
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "admin.quickBooksSetup.confirmError" }));
    } finally {
      setQuickBooksAction(null);
    }
  }, [loadQuickBooksStatus, quickBooksStatus, t]);

  const disconnectQuickBooks = useCallback(async () => {
    setQuickBooksAction("disconnect");
    setQuickBooksError(null);
    try {
      const result = await api.integrations.quickbooks.disconnect();
      setDisconnectQuickBooksOpen(false);
      setNotice(result.revocationPending
        ? t("admin.notices.quickBooksDisconnectPending")
        : t("admin.notices.quickBooksDisconnected"));
      await loadQuickBooksStatus();
    } catch (err) {
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "admin.quickBooksSetup.disconnectError" }));
    } finally {
      setQuickBooksAction(null);
    }
  }, [loadQuickBooksStatus, t]);

  useEffect(() => {
    setSEOMetadata({
      title: t("admin.seoTitle"),
      description: t("admin.seoDescription"),
    });
    void loadQuickBooksStatus();
  }, [loadQuickBooksStatus, t]);

  useEffect(() => {
    if (settingsMode === "users") {
      void loadMembers();
    } else {
      setLoading(false);
    }
  }, [loadMembers, settingsMode]);

  useEffect(() => {
    if (location.hash !== "#admin-quickbooks") return;
    const frame = window.requestAnimationFrame(() => {
      const section = document.getElementById("admin-quickbooks");
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      section?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, quickBooksLoading]);

  useEffect(() => {
    const billingState = new URLSearchParams(location.search).get("billing");
    const billingSubscriptionConfirmed =
      activeSubscriptionPlan !== null &&
      ["active", "trialing"].includes((session?.subscriptionStatus ?? "").toLowerCase());
    const nextNotice = billingNoticeText(billingState, billingSubscriptionConfirmed, t);
    const integrationsState = new URLSearchParams(location.search).get("integrations");
    const nextIntegrationNotice = integrationNoticeText(integrationsState, t);

    if (!nextNotice && !nextIntegrationNotice) return;

    setNotice(nextNotice ?? nextIntegrationNotice);
    setError(null);
    if (billingState !== "success" || billingSubscriptionConfirmed) {
      navigate(settingsMode === "users" ? "/app/settings/users" : "/app/settings", { replace: true });
    }
  }, [
    activeSubscriptionPlan,
    location.search,
    navigate,
    session?.subscriptionStatus,
    settingsMode,
    t,
  ]);

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
      setNotice(t("admin.notices.memberAdded"));
    } catch (err) {
      setError(localizedApiError(err, t, {
        fallbackKey: "admin.errors.createUser",
        statusKeys: { 409: "apiErrors.memberExists" },
      }));
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
      setNotice(t("admin.notices.roleUpdated"));
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "admin.errors.updateRole" }));
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
      notify.success(t("admin.notices.removedTitle"), {
        description: t("admin.notices.removedDescription", { name: pendingRemovalMember.user.fullName }),
      });
      setPendingRemovalMember(null);
    } catch (err) {
      notify.error(t("admin.errors.removeTitle"), {
        description: localizedApiError(err, t, { fallbackKey: "admin.errors.removeDescription" }),
      });
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
      setError(localizedApiError(err, t, {
        fallbackKey: "admin.errors.checkout",
        statusKeys: { 409: "apiErrors.subscriptionExists" },
      }));
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
      setError(localizedApiError(err, t, { fallbackKey: "admin.errors.billingPortal" }));
      setBillingAction(null);
    }
  }

  const seatUsageText = useMemo(() => {
    if (teamMembersLimit === null) return t("admin.access.inUseUnlimited", { used: teamMembersUsed });
    return t("admin.access.seatsInUse", { used: teamMembersUsed, limit: teamMembersLimit });
  }, [t, teamMembersLimit, teamMembersUsed]);
  const totalMemberPages = Math.max(1, Math.ceil(memberTotal / memberPageSize));

  useEffect(() => {
    if (memberPage > totalMemberPages) setMemberPage(totalMemberPages);
  }, [memberPage, totalMemberPages]);
  const aiUsage = useMemo(() => formatAiUsageBreakdown(session?.usage ?? {}, locale), [locale, session?.usage]);
  const aiRenewalText = !aiUsage.billingCycleReconciliationPending && session?.usage?.periodEndUtc
    ? dateText(session.usage.periodEndUtc, locale, t)
    : null;
  const requestedSettingsSection = new URLSearchParams(location.search).get("section");
  const activeSettingsCategory: SettingsCategory = settingsMode === "users"
    ? "team"
    : location.hash === "#admin-quickbooks"
      ? "quickbooks"
      : requestedSettingsSection === "billing"
        ? "billing"
        : requestedSettingsSection === "follow-up"
          ? "follow-up"
        : "general";
  const adminLinks = [
    { id: "admin-general", label: t("admin.nav.general"), hint: t("admin.nav.generalHint") },
    { id: "admin-follow-up", label: t("admin.nav.followUp"), hint: t("admin.nav.followUpHint") },
    { id: "admin-billing", label: t("admin.nav.billing"), hint: t("admin.nav.billingHint") },
    { id: "admin-quickbooks", label: t("admin.nav.quickBooks"), hint: t("admin.nav.quickBooksHint") },
    { id: "admin-team", label: t("admin.nav.team"), hint: t("admin.nav.teamHint") },
  ];

  function navigateSettingsCategory(category: SettingsCategory) {
    if (category === "team") {
      navigate("/app/settings/users");
      return;
    }
    if (category === "quickbooks") {
      navigate("/app/settings#admin-quickbooks");
      return;
    }
    if (category === "billing") {
      navigate("/app/settings?section=billing");
      return;
    }
    if (category === "follow-up") {
      navigate("/app/settings?section=follow-up");
      return;
    }
    navigate("/app/settings");
  }

  function selectSettingsCategory(id: string) {
    const category = id.replace(/^admin-/, "") as SettingsCategory;
    if (category === activeSettingsCategory) return;
    if (activeSettingsCategory === "follow-up" && followUpDirty) {
      setPendingSettingsCategory(category);
      return;
    }
    navigateSettingsCategory(category);
  }

  const billingSummaryText = useMemo(() => {
    if (session?.isTrial) {
      return t("admin.owner.billingTrial", { date: dateText(session.trialEndsAtUtc, locale, t) });
    }

    if (session?.subscriptionCurrentPeriodEndUtc) {
      return t("admin.owner.billingPeriod", { date: dateText(session.subscriptionCurrentPeriodEndUtc, locale, t) });
    }

    if (activeSubscriptionPlan) {
      return t("admin.owner.billingConnected");
    }

    return t("admin.owner.billingNone");
  }, [
    activeSubscriptionPlan,
    session?.isTrial,
    session?.subscriptionCurrentPeriodEndUtc,
    session?.trialEndsAtUtc,
    locale,
    t,
  ]);

  if (loading) {
      return (
      <div className="space-y-4">
        <PageHeader
          title={t("admin.title")}
          subtitle={t("admin.subtitle")}
          mode="actions-only"
        />
        <Card variant="elevated" padding="lg" className="text-sm text-slate-600">
          {t("admin.loading")}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("admin.title")}
        subtitle={settingsMode === "users" ? t("admin.usersSubtitle") : t("admin.organizationSubtitle")}
        mode="actions-only"
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

      <Card variant="default" padding="sm" className="overflow-hidden shadow-sm lg:sticky lg:top-16 lg:z-10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <WorkspaceJumpBar
            links={adminLinks}
            activeId={`admin-${activeSettingsCategory}`}
            ariaLabel={t("admin.nav.ariaLabel")}
            onSelect={(link) => selectSettingsCategory(link.id)}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge tone={planTone(effectivePlanCode)}>{t("admin.access.accessSuffix", { plan: displayPlanName })}</Badge>
            {session?.isTrial ? <Badge tone="orange">{t("admin.access.trialActive")}</Badge> : null}
            <Badge tone={subscriptionTone(session?.subscriptionStatus)}>{subscriptionStatusLabel(session?.subscriptionStatus, t)}</Badge>
          </div>
        </div>
      </Card>

      <div className="space-y-6">
          {activeSettingsCategory === "general" ? (
          <WorkspaceSection
            id="admin-general"
            step={t("admin.overview.step")}
            title={t("admin.overview.title")}
            description={t("admin.overview.description")}
            actions={superuserView ? (
              <Button type="button" variant="outline" onClick={() => navigate("/app/internal/admin")}>
                {t("admin.owner.operatorConsole")}
              </Button>
            ) : undefined}
          >
            <Card variant="blue" padding="lg">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(420px,520px)] 2xl:grid-cols-[minmax(0,1.35fr)_minmax(460px,580px)] 2xl:items-start">
          <div className="min-w-0 max-w-3xl space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-600">{t("admin.overview.eyebrow")}</p>
              <h2 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">{t("admin.overview.heading")}</h2>
            </div>
            <p className="text-sm text-slate-600 sm:text-base">{billingSummaryText}</p>
            {!ownerView ? (
              <Badge tone="amber" icon={<LockIcon size={14} />}>
                {t("admin.overview.ownerOnly")}
              </Badge>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <AdminMetricCard
              icon={<PriceIcon size={16} />}
              label={t("admin.access.currentAccess")}
              value={displayPlanName}
              hint={session?.isTrial ? t("admin.access.trialAccess") : t("admin.access.livePlanAccess")}
            />
            <AdminMetricCard
              icon={<ClockIcon size={16} />}
              label={t("admin.access.billingState")}
              value={subscriptionStatusLabel(session?.subscriptionStatus, t)}
              hint={activeSubscriptionPlan ? t("admin.access.subscribed", { plan: activeSubscriptionPlan }) : t("admin.access.noPaidPlan")}
            />
            <AdminMetricCard
              icon={<CustomerIcon size={16} />}
              label={t("admin.access.teamSeats")}
              value={seatUsageText}
              hint={teamMembersLimit === null ? t("admin.access.noSeatCap") : t("admin.access.seatsEnforced")}
            />
            <AdminMetricCard
              icon={<ClockIcon size={16} />}
              label={t("admin.access.aiUsage")}
              value={aiUsage.enforcementMode === "UNLIMITED" ? t("admin.access.noCap") : aiUsage.headline}
              hint={
                aiUsage.enforcementMode === "UNLIMITED"
                  ? t("admin.access.noMonthlyCap")
                  : aiRenewalText
                    ? t("admin.access.renews", { date: aiRenewalText })
                    : t("admin.access.monthlyLimit")
              }
            />
          </div>
        </div>
            </Card>
          </WorkspaceSection>
          ) : null}

          {activeSettingsCategory === "general" ? (
          <WorkspaceSection
            id="admin-appearance"
            step={t("settings.appearanceStep")}
            title={t("settings.appearance")}
            description={t("settings.appearanceDescription")}
          >
            <div className="grid gap-4 xl:grid-cols-2">
              <ThemeSelector />
              <LanguageSelector
                onPreferenceChange={async (preferredLocale) => {
                  try {
                    await api.auth.updatePreferences({ preferredLocale });
                    notify.success(t("language.saved"));
                  } catch (error) {
                    notify.error(t("language.saveError"));
                    throw error;
                  }
                }}
              />
            </div>
          </WorkspaceSection>
          ) : null}

          {activeSettingsCategory === "follow-up" ? (
          <WorkspaceSection
            id="admin-follow-up"
            step={t("admin.followUp.step")}
            title={t("admin.followUp.title")}
            description={t("admin.followUp.description")}
            actions={<Badge tone={canManageFollowUp ? "blue" : "slate"}>{canManageFollowUp ? t("admin.followUp.managerAccess") : t("admin.followUp.readOnlyBadge")}</Badge>}
          >
            <FollowUpSettingsPanel canManage={canManageFollowUp} onDirtyChange={setFollowUpDirty} />
          </WorkspaceSection>
          ) : null}

          {activeSettingsCategory === "billing" ? (
          <WorkspaceSection
            id="admin-billing"
            step={t("admin.billing.step")}
            title={t("admin.billing.title")}
            description={t("admin.billing.description")}
            actions={!ownerView ? <Badge tone="amber">{t("admin.billing.ownerOnly")}</Badge> : undefined}
          >
            <Card variant="elevated" padding="lg">
        <CardHeader
          title={t("admin.billing.currentPlan")}
          subtitle={billingSummaryText}
          actions={ownerView && hasPortalAccess ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void openBillingPortal()}
              disabled={billingAction !== null}
              loading={billingAction === "portal"}
            >
              {t("admin.owner.manageBilling")}
            </Button>
          ) : undefined}
        />
        <div className="flex flex-wrap gap-2 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
          <Badge tone={planTone(effectivePlanCode)}>{displayPlanName}</Badge>
          <Badge tone={subscriptionTone(session?.subscriptionStatus)}>{subscriptionStatusLabel(session?.subscriptionStatus, t)}</Badge>
          {!ownerView ? <Badge tone="amber">{t("admin.billing.ownerOnly")}</Badge> : null}
        </div>

        <details className="mt-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--qf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)]">
            <span>{t("admin.billing.comparePlans")}</span>
            <span className="text-xs font-medium text-[var(--qf-text-muted)]">{t("admin.billing.comparePlansHint")}</span>
          </summary>
          <div className="grid gap-4 border-t border-[var(--qf-border)] py-4 xl:grid-cols-3">
          {planCards.map((plan) => {
            const isCurrentPaidPlan = activeSubscriptionPlan === plan.code;
            const isCurrentAccessPlan = !session?.isTrial && effectivePlanCode === plan.code;
            const isComingSoon = plan.launchState === "coming-soon";

            return (
              <article key={plan.code} className={`rounded-[26px] border p-4 shadow-sm ${plan.accentClassName}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{plan.price}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {isCurrentAccessPlan ? <Badge tone="blue">{t("admin.plan.currentAccess")}</Badge> : null}
                    {isCurrentPaidPlan ? <Badge tone="emerald">{t("admin.plan.activeBilling")}</Badge> : null}
                    {!isCurrentPaidPlan && isComingSoon ? <Badge tone="amber">{t("admin.plan.comingSoon")}</Badge> : null}
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
                  {isCurrentPaidPlan ? t("admin.plan.currentPaid") : isComingSoon ? t("admin.plan.comingSoon") : t("admin.plan.choose", { plan: plan.name })}
                </Button>
              </article>
            );
          })}
          </div>

        <Card variant="default" padding="md" className="mb-4 bg-slate-50/80">
          <p className="text-sm font-semibold text-slate-900">{t("admin.billing.launchNote")}</p>
          <p className="mt-1 text-sm text-slate-600">
            {t("admin.billing.launchDescription")}
          </p>
        </Card>
        </details>
            </Card>
          </WorkspaceSection>
          ) : null}

          {activeSettingsCategory === "quickbooks" ? (
          <WorkspaceSection
            id="admin-quickbooks"
            step={t("admin.accounting.step")}
            title={t("admin.accounting.title")}
            description={t("admin.quickBooksSetup.sectionDescription")}
            actions={quickBooksStatus ? <Badge tone={quickBooksStatus.setup.confirmed ? "emerald" : quickBooksStatus.setup.phase === "UNAVAILABLE" ? "red" : "amber"}>{t(`admin.quickBooksSetup.phases.${quickBooksStatus.setup.phase === "UNAVAILABLE" ? "unavailable" : quickBooksStatus.setup.phase === "NOT_CONNECTED" ? "notConnected" : quickBooksStatus.setup.phase === "ACTION_REQUIRED" ? "actionRequired" : quickBooksStatus.setup.phase === "READY_FOR_CONFIRMATION" ? "readyToConfirm" : "confirmed"}`)}</Badge> : undefined}
          >
            <QuickBooksSetupPanel
              canManage={canManageQuickBooks}
              status={quickBooksStatus}
              loading={quickBooksLoading}
              error={quickBooksError}
              action={quickBooksAction}
              onRetry={() => void loadQuickBooksStatus()}
              onConnect={() => void startQuickBooksConnection()}
              onConfirm={() => setConfirmQuickBooksSetupOpen(true)}
              onDisconnect={() => setDisconnectQuickBooksOpen(true)}
            />
          </WorkspaceSection>
          ) : null}

          {activeSettingsCategory === "team" ? (
          <WorkspaceSection
            id="admin-team"
            step={t("admin.team.step")}
            title={t("admin.team.title")}
            description={t("admin.team.description")}
            actions={<Badge tone={seatLimitReached ? "amber" : "slate"}>{seatUsageText}</Badge>}
          >
            <Card variant="default" padding="md" className="mb-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("admin.team.allowance", { plan: seatPlanName })}</p>
                  <p className="mt-1 text-xl font-bold text-slate-950">{seatUsageText}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    {teamMembersLimit === null
                      ? t("admin.team.noCap")
                      : t("admin.team.seatsRemaining", { count: Math.max(teamMembersLimit - teamMembersUsed, 0) })}
                  </p>
                </div>
                <Badge tone={seatLimitReached ? "amber" : "blue"}>{seatLimitReached ? t("admin.team.limitReached") : t("admin.team.seatsAvailable")}</Badge>
              </div>
              {teamMembersLimit !== null ? (
                <ProgressBar
                  value={Math.min(100, (teamMembersUsed / Math.max(teamMembersLimit, 1)) * 100)}
                  label={t("admin.team.activeSeats")}
                  hint={t("admin.access.seatsInUse", { used: teamMembersUsed, limit: teamMembersLimit })}
                  className="mt-4"
                />
              ) : null}
            </Card>

            <details className="mb-5 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 md:hidden">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--qf-text)]">
                {t("admin.team.compareRoles")}
                <span className="text-xs font-medium text-[var(--qf-text-muted)]">{t("admin.team.roleList")}</span>
              </summary>
              <RoleGuideCards className="border-t border-[var(--qf-border)] py-4" />
            </details>
            <RoleGuideCards className="mb-5 hidden md:grid md:grid-cols-3" />
            <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card variant="elevated" padding="lg">
          <CardHeader
            title={t("admin.team.addTitle")}
            subtitle={t("admin.team.addDescription")}
          />
          <form onSubmit={createMember} className="space-y-3">
            <Input
              label={t("admin.team.fullName")}
              placeholder={t("admin.team.fullName")}
              value={form.fullName}
              onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Input
              label={t("admin.team.email")}
              type="email"
              placeholder={t("admin.team.email")}
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Input
              label={t("admin.team.temporaryPassword")}
              type="password"
              minLength={8}
              placeholder={t("admin.team.passwordPlaceholder")}
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              disabled={!canManageUsers || saving || seatLimitReached}
              required
            />
            <Select
              label={t("admin.team.role")}
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as OrgUserRole }))}
              options={roleOptions}
              disabled={!canManageUsers || saving || seatLimitReached}
            />
            <Button
              type="submit"
              fullWidth
              disabled={!canManageUsers || saving || seatLimitReached}
              loading={saving}
            >
              {t("admin.team.addUser")}
            </Button>
          </form>
          {!canManageUsers ? (
            <p className="mt-3 text-xs text-slate-500">{t("admin.team.cannotAdd")}</p>
          ) : null}
          {seatLimitReached ? (
            <div className="mt-3">
              <Alert tone="warning">{t("admin.team.seatLimit")}</Alert>
            </div>
          ) : null}
        </Card>

        <Card variant="elevated" padding="lg">
          <CardHeader
            title={t("admin.team.usersTitle")}
            subtitle={t("admin.team.usersDescription")}
            actions={<Badge tone="slate">{t("admin.team.userCount", { count: teamMembersUsed })}</Badge>}
          />
          <div className="mb-4 max-w-md">
            <Input
              label={t("admin.team.search")}
              value={memberSearch}
              onChange={(event) => setMemberSearch(event.target.value)}
              placeholder={t("admin.team.searchPlaceholder")}
            />
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
            {members.length ? (
              <>
                <div className="hidden grid-cols-[minmax(0,1.2fr)_110px_120px_110px_112px] gap-4 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] lg:grid">
                  <span>{t("admin.team.user")}</span>
                  <span>{t("admin.team.role")}</span>
                  <span>{t("admin.team.assigned")}</span>
                  <span>{t("admin.team.joined")}</span>
                  <span>{t("admin.team.action")}</span>
                </div>
                <div className="divide-y divide-[var(--qf-border)]">
                  {members.map((member) => (
                    <div key={member.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1.2fr)_110px_120px_110px_112px] lg:items-center lg:py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
                            {member.user.fullName
                              .split(" ")
                              .map((part) => part[0] ?? "")
                              .join("")
                              .slice(0, 2)
                              .toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{member.user.fullName}</p>
                            <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">{member.user.email}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2 lg:justify-start">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] lg:hidden">{t("admin.team.role")}</span>
                        <Badge tone={roleTone(member.role)}>{roleLabel(member.role, t)}</Badge>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-xs text-[var(--qf-text-soft)] lg:block">
                        <span className="font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] lg:hidden">{t("admin.team.assigned")}</span>
                        <span className="text-right lg:text-left">
                          <span>{t("admin.team.assignedCustomers", { count: member.assignments?.assignedCustomers ?? 0 })}</span>
                          <span className="ml-2 lg:ml-0 lg:mt-1 lg:block">{t("admin.team.assignedQuotes", { count: member.assignments?.assignedQuotes ?? 0 })}</span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-xs text-[var(--qf-text-muted)] lg:block">
                        <span className="font-semibold uppercase tracking-wide lg:hidden">{t("admin.team.joined")}</span>
                        <span>{dateText(member.createdAt, locale, t)}</span>
                      </div>
                      <div className="grid gap-2 border-t border-[var(--qf-border)] pt-3 sm:grid-cols-[1fr_auto] lg:grid-cols-[1fr] lg:border-0 lg:pt-0">
                        {ownerView ? (
                      <Select
                        aria-label={t("admin.team.roleFor", { name: member.user.fullName })}
                        value={member.role}
                        disabled={!ownerView || saving}
                        onChange={(event) => void updateMemberRole(member.id, event.target.value as OrgUserRole)}
                        options={roleOptions}
                        className="min-h-11"
                      />
                        ) : null}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setPendingRemovalMember(member)}
                        disabled={!ownerView || member.role === "owner" || saving}
                        size="sm"
                      >
                        {t("admin.team.remove")}
                      </Button>
                    </div>
                  </div>
                ))}
                </div>
              </>
            ) : (
              <Card variant="default" padding="md" className="bg-slate-50/80 text-sm text-slate-500">
                {t("admin.team.none")}
              </Card>
            )}
          </div>
          <div className="mt-4">
            <PaginationControls
              limit={memberPageSize}
              offset={(memberPage - 1) * memberPageSize}
              total={memberTotal}
              loading={loading}
              itemLabel={t("admin.team.pagination")}
              onLimitChange={(nextLimit) => {
                setMemberPageSize(nextLimit);
                setMemberPage(1);
              }}
              onOffsetChange={(nextOffset) => setMemberPage(Math.floor(nextOffset / memberPageSize) + 1)}
            />
          </div>
        </Card>
            </div>
          </WorkspaceSection>
          ) : null}
      </div>

      <ConfirmModal
        open={pendingSettingsCategory !== null}
        onClose={() => setPendingSettingsCategory(null)}
        onConfirm={() => {
          const category = pendingSettingsCategory;
          setPendingSettingsCategory(null);
          if (category) navigateSettingsCategory(category);
        }}
        title={t("admin.followUp.leaveTitle")}
        description={t("admin.followUp.leaveDescription")}
        confirmLabel={t("admin.followUp.leaveConfirm")}
        confirmVariant="warning"
      />
      <ConfirmModal
        open={confirmQuickBooksSetupOpen}
        onClose={() => setConfirmQuickBooksSetupOpen(false)}
        onConfirm={() => void confirmQuickBooksSetup()}
        title={t("admin.quickBooksSetup.confirmTitle")}
        description={t("admin.quickBooksSetup.confirmDescription", { company: quickBooksStatus?.connection?.companyName ?? t("admin.quickBooksSetup.connectedCompany") })}
        confirmLabel={t("admin.quickBooksSetup.confirmButton")}
        confirmVariant="success"
        loading={quickBooksAction === "confirm"}
      />
      <ConfirmModal
        open={disconnectQuickBooksOpen}
        onClose={() => setDisconnectQuickBooksOpen(false)}
        onConfirm={() => void disconnectQuickBooks()}
        title={t("admin.quickBooksSetup.disconnectTitle")}
        description={t("admin.quickBooksSetup.disconnectDescription")}
        confirmLabel={t("admin.quickBooksSetup.disconnectButton")}
        confirmVariant="warning"
        loading={quickBooksAction === "disconnect"}
      />
      <ConfirmModal
        open={pendingRemovalMember !== null}
        onClose={() => setPendingRemovalMember(null)}
        onConfirm={() => void removeMember()}
        title={t("admin.team.removeTitle")}
        description={
          pendingRemovalMember
            ? t("admin.team.removeDescription", { name: pendingRemovalMember.user.fullName })
            : t("admin.team.removeFallback")
        }
        confirmLabel={t("admin.team.removeConfirm")}
        loading={saving}
      />
    </div>
  );
}

function RoleGuideCards({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const guides = [
    {
      role: t("domain.role.owner"),
      tone: "border-violet-200 bg-violet-50",
      text: t("admin.team.guides.owner"),
    },
    {
      role: t("domain.role.admin"),
      tone: "border-sky-200 bg-sky-50",
      text: t("admin.team.guides.admin"),
    },
    {
      role: t("domain.role.member"),
      tone: "border-[var(--qf-border)] bg-[var(--qf-panel-muted)]",
      text: t("admin.team.guides.member"),
    },
  ];
  return (
    <div className={`grid gap-3 ${className}`}>
      {guides.map((guide) => (
        <div key={guide.role} className={`rounded-2xl border p-4 ${guide.tone}`}>
          <p className="text-sm font-bold text-[var(--qf-text)]">{guide.role}</p>
          <p className="mt-2 text-xs leading-5 text-[var(--qf-text-soft)]">{guide.text}</p>
        </div>
      ))}
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
    <div className="h-full rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{label}</p>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]">
          {icon}
        </span>
      </div>
      <p className="mt-2 text-base font-semibold leading-6 text-[var(--qf-text)] sm:text-lg">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{hint}</p>
    </div>
  );
}
