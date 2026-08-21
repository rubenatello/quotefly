import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { CheckIcon, LockIcon, PriceIcon } from "../Icons";
import { Alert, Badge, Button, Card } from "../ui";
import {
  api,
  type TenantEntitlements,
} from "../../lib/api";
import { useLocale } from "../../i18n";
import { localizedApiError } from "../../lib/localized-api-error";
import { BASIC_PLAN } from "../../lib/plans";

type BillingAction = "checkout" | "portal" | "refresh" | null;

export type BillingRequiredSession = {
  tenantName: string;
  role: string;
  subscriptionStatus?: string;
  entitlements?: TenantEntitlements;
};

type BillingRequiredScreenProps = {
  session: BillingRequiredSession;
  onLogout: () => void;
  onRefreshSession: () => Promise<void>;
};

const PAID_STATUS_WITH_PORTAL = new Set(["active", "past_due", "unpaid", "canceled", "incomplete", "paused"]);

function normalizeSessionRole(role: string): "owner" | "admin" | "member" {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner" || normalized === "admin") return normalized;
  return "member";
}

function billingReasonText(session: BillingRequiredSession, t: TFunction): string {
  const reason = session.entitlements?.accessReason;
  if (reason === "past_due") return t("billing.reasonPastDue");
  if (PAID_STATUS_WITH_PORTAL.has((session.subscriptionStatus ?? "").toLowerCase())) {
    return t("billing.reasonPortal");
  }
  if (reason === "inactive") return t("billing.reasonInactive");
  return t("billing.reasonDefault");
}

function billingStatusText(value: string | null | undefined, t: TFunction): string {
  const normalized = (value ?? "not_started").toLowerCase().replace(/-/g, "_");
  if (normalized === "active") return t("billing.status.active");
  if (normalized === "trialing") return t("billing.status.trialing");
  if (normalized === "past_due") return t("billing.status.pastDue");
  if (normalized === "unpaid") return t("billing.status.unpaid");
  if (normalized === "canceled") return t("billing.status.canceled");
  if (normalized === "incomplete") return t("billing.status.incomplete");
  if (normalized === "paused") return t("billing.status.paused");
  if (normalized === "inactive") return t("billing.status.inactive");
  if (normalized === "not_started") return t("billing.status.notStarted");
  return t("billing.status.unknown");
}

function formatUsd(locale: string, amount: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function BillingRequiredScreen({
  session,
  onLogout,
  onRefreshSession,
}: BillingRequiredScreenProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [billingAction, setBillingAction] = useState<BillingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const confirmingCheckout = new URLSearchParams(location.search).get("billing") === "success";
  const ownerView = normalizeSessionRole(session.role) === "owner";
  const status = billingStatusText(session.subscriptionStatus, t);
  const firstPaidPrice = formatUsd(locale, BASIC_PLAN.firstPaidMonthPriceUsd);
  const monthlyPrice = t("billing.monthlyPrice", { price: formatUsd(locale, BASIC_PLAN.monthlyPriceUsd) });
  const basicFeatures = [t("billing.featureAiQuotes"), t("billing.featureCustomers"), t("billing.featurePdfs")];
  const basicLimits = [
    t("billing.quotesPerMonth", { count: BASIC_PLAN.quotesPerMonth }),
    t("billing.trackedAi"),
    t("billing.teamMembers", { count: BASIC_PLAN.teamMembers }),
    t("billing.historyDays", { count: BASIC_PLAN.quoteHistoryDays }),
  ];
  const canOpenPortal =
    ownerView && PAID_STATUS_WITH_PORTAL.has((session.subscriptionStatus ?? "").toLowerCase());

  async function startBasicCheckout() {
    if (!ownerView) return;

    setBillingAction("checkout");
    setError(null);
    try {
      const result = await api.billing.createCheckoutSession({ planCode: "starter" });
      if (!result.checkoutUrl) {
        throw new Error("Missing Stripe checkout redirect URL");
      }
      window.location.assign(result.checkoutUrl);
    } catch (err) {
      setError(localizedApiError(err, t, {
        fallbackKey: "billing.checkoutFailed",
        statusKeys: { 409: "apiErrors.subscriptionExists" },
      }));
      setBillingAction(null);
    }
  }

  async function openBillingPortal() {
    if (!ownerView) return;

    setBillingAction("portal");
    setError(null);
    try {
      const result = await api.billing.createPortalSession();
      window.location.assign(result.url);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "billing.portalFailed" }));
      setBillingAction(null);
    }
  }

  async function refreshStatus() {
    setBillingAction("refresh");
    setError(null);
    try {
      await onRefreshSession();
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "billing.refreshFailed" }));
    } finally {
      setBillingAction(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] pt-4 sm:px-6 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">QuoteFly</p>
            <h1 className="mt-1 truncate text-xl font-semibold text-slate-950 sm:text-2xl">{session.tenantName}</h1>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onLogout}>
            {t("billing.signOut")}
          </Button>
        </header>

        {error ? (
          <Alert tone="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {confirmingCheckout ? (
          <Alert tone="info">
            {t("billing.checkoutConfirming")}
          </Alert>
        ) : null}

        <main className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_360px] lg:items-center">
          <section className="space-y-4">
            <Card variant="elevated" padding="lg" className="bg-white">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                  <LockIcon size={22} />
                </span>
                <div className="min-w-0">
                  <Badge tone="amber">{t("billing.required")}</Badge>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                    {canOpenPortal ? t("billing.updateToUnlock") : t("billing.startToUnlock")}
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">{billingReasonText(session, t)}</p>
                </div>
              </div>
            </Card>

            <div className="grid gap-3 sm:grid-cols-3">
              {basicFeatures.map((feature) => (
                <Card key={feature} variant="default" padding="md" className="bg-white">
                  <CheckIcon size={18} className="text-quotefly-blue" />
                  <p className="mt-3 text-sm font-semibold leading-5 text-slate-900">{feature}</p>
                </Card>
              ))}
            </div>
          </section>

          <aside className="space-y-3">
            <Card variant="blue" padding="lg">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("billing.basic")}</p>
                  <p className="mt-2 text-3xl font-bold text-slate-950">{monthlyPrice}</p>
                  {!canOpenPortal ? (
                    <p className="mt-1 text-sm font-semibold text-emerald-700">
                      {t("billing.firstPaidEligible", { price: firstPaidPrice })}
                    </p>
                  ) : null}
                </div>
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-quotefly-blue shadow-sm">
                  <PriceIcon size={20} />
                </span>
              </div>

              <div className="mt-5 grid gap-2 text-sm text-slate-700">
                {basicLimits.map((limit) => (
                  <p key={limit}>{limit}</p>
                ))}
              </div>

              <div className="mt-5 hidden gap-2 sm:grid">
                {canOpenPortal ? (
                  <Button
                    type="button"
                    fullWidth
                    onClick={() => void openBillingPortal()}
                    disabled={billingAction !== null}
                    loading={billingAction === "portal"}
                  >
                    {t("billing.updateBilling")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    fullWidth
                    onClick={() => void startBasicCheckout()}
                    disabled={!ownerView || billingAction !== null}
                    loading={billingAction === "checkout"}
                  >
                    {t("billing.startBasicFirstMonth", { price: firstPaidPrice })}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  fullWidth
                  onClick={() => void refreshStatus()}
                  disabled={billingAction !== null}
                  loading={billingAction === "refresh"}
                >
                  {t("billing.refreshStatus")}
                </Button>
              </div>
            </Card>

            <Card variant="default" padding="md" className="bg-white text-sm text-slate-600">
              <p className="font-semibold text-slate-900">{t("billing.workspaceStatus")}</p>
              <p className="mt-2">{status}</p>
              {!ownerView ? (
                <p className="mt-3 text-amber-700">{t("billing.ownerHelp")}</p>
              ) : null}
            </Card>
          </aside>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 shadow-[0_-12px_28px_rgba(15,23,42,0.08)] sm:hidden">
        <div className="mx-auto grid max-w-md gap-2">
          {canOpenPortal ? (
            <Button
              type="button"
              fullWidth
              onClick={() => void openBillingPortal()}
              disabled={billingAction !== null}
              loading={billingAction === "portal"}
            >
              {t("billing.updateBilling")}
            </Button>
          ) : (
            <Button
              type="button"
              fullWidth
              onClick={() => void startBasicCheckout()}
              disabled={!ownerView || billingAction !== null}
              loading={billingAction === "checkout"}
            >
              {t("billing.trial.chooseShort", { price: firstPaidPrice })}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            fullWidth
            onClick={() => void refreshStatus()}
            disabled={billingAction !== null}
            loading={billingAction === "refresh"}
          >
            {t("billing.refreshStatus")}
          </Button>
        </div>
      </div>
    </div>
  );
}
