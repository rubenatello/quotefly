import { useState } from "react";
import { CheckIcon, LockIcon, PriceIcon } from "../Icons";
import { Alert, Badge, Button, Card } from "../ui";
import {
  api,
  ApiError,
  type TenantEntitlements,
} from "../../lib/api";

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

const PAID_STATUS_WITH_PORTAL = new Set(["active", "past_due", "unpaid", "canceled", "incomplete"]);
const BASIC_FEATURES = ["Draft AI-assisted quotes", "Manage customer records", "Export customer-ready PDFs"];
const BASIC_LIMITS = [
  "600 quotes per month",
  "AI assistance with in-app usage tracking",
  "Up to 7 team members",
  "30-day quote history",
];

function normalizeSessionRole(role: string): "owner" | "admin" | "member" {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner" || normalized === "admin") return normalized;
  return "member";
}

function billingReasonText(session: BillingRequiredSession): string {
  const reason = session.entitlements?.accessReason;
  if (reason === "past_due") return "Payment needs attention before the workspace can create quotes or edit customer records.";
  if (reason === "inactive") return "The previous subscription is no longer active. Start Basic to restore workspace actions.";
  return "Start Basic to keep drafting quotes, managing customers, and sending PDFs.";
}

export function BillingRequiredScreen({
  session,
  onLogout,
  onRefreshSession,
}: BillingRequiredScreenProps) {
  const [billingAction, setBillingAction] = useState<BillingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const ownerView = normalizeSessionRole(session.role) === "owner";
  const status = (session.subscriptionStatus ?? "not_started").replace(/[_-]/g, " ");
  const canOpenPortal =
    ownerView && PAID_STATUS_WITH_PORTAL.has((session.subscriptionStatus ?? "").toLowerCase());

  async function startBasicCheckout() {
    if (!ownerView) return;

    setBillingAction("checkout");
    setError(null);
    try {
      const result = await api.billing.createCheckoutSession({ planCode: "starter" });
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
    try {
      const result = await api.billing.createPortalSession();
      window.location.assign(result.url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed opening billing portal.");
      setBillingAction(null);
    }
  }

  async function refreshStatus() {
    setBillingAction("refresh");
    setError(null);
    try {
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed refreshing billing status.");
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
            Sign Out
          </Button>
        </header>

        {error ? (
          <Alert tone="error" onDismiss={() => setError(null)}>
            {error}
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
                  <Badge tone="amber">Billing required</Badge>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                    Start Basic to unlock your workspace.
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">{billingReasonText(session)}</p>
                </div>
              </div>
            </Card>

            <div className="grid gap-3 sm:grid-cols-3">
              {BASIC_FEATURES.map((feature) => (
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
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Basic</p>
                  <p className="mt-2 text-3xl font-bold text-slate-950">$19/mo</p>
                </div>
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-quotefly-blue shadow-sm">
                  <PriceIcon size={20} />
                </span>
              </div>

              <div className="mt-5 grid gap-2 text-sm text-slate-700">
                {BASIC_LIMITS.map((limit) => (
                  <p key={limit}>{limit}</p>
                ))}
              </div>

              <div className="mt-5 hidden gap-2 sm:grid">
                <Button
                  type="button"
                  fullWidth
                  onClick={() => void startBasicCheckout()}
                  disabled={!ownerView || billingAction !== null}
                  loading={billingAction === "checkout"}
                >
                  Start Basic - $19/mo
                </Button>
                {canOpenPortal ? (
                  <Button
                    type="button"
                    variant="outline"
                    fullWidth
                    onClick={() => void openBillingPortal()}
                    disabled={billingAction !== null}
                    loading={billingAction === "portal"}
                  >
                    Manage Billing
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  fullWidth
                  onClick={() => void refreshStatus()}
                  disabled={billingAction !== null}
                  loading={billingAction === "refresh"}
                >
                  Refresh Status
                </Button>
              </div>
            </Card>

            <Card variant="default" padding="md" className="bg-white text-sm text-slate-600">
              <p className="font-semibold text-slate-900">Workspace status</p>
              <p className="mt-2 capitalize">{status}</p>
              {!ownerView ? (
                <p className="mt-3 text-amber-700">Ask the workspace owner to start or update the Basic subscription.</p>
              ) : null}
            </Card>
          </aside>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 shadow-[0_-12px_28px_rgba(15,23,42,0.08)] sm:hidden">
        <div className="mx-auto grid max-w-md gap-2">
          <Button
            type="button"
            fullWidth
            onClick={() => void startBasicCheckout()}
            disabled={!ownerView || billingAction !== null}
            loading={billingAction === "checkout"}
          >
            Start Basic - $19/mo
          </Button>
          <Button
            type="button"
            variant="outline"
            fullWidth
            onClick={() => void refreshStatus()}
            disabled={billingAction !== null}
            loading={billingAction === "refresh"}
          >
            Refresh Status
          </Button>
        </div>
      </div>
    </div>
  );
}
