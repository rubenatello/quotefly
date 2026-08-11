import { useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { BASIC_PLAN, basicMonthlyPriceLabel } from "../../lib/plans";
import { Alert, Badge, Button } from "../ui";

type TrialConversionBannerProps = {
  trialEndsAtUtc?: string | null;
  ownerView: boolean;
};

function trialDaysRemaining(trialEndsAtUtc: string | null | undefined): number | null {
  if (!trialEndsAtUtc) return null;
  const remainingMs = new Date(trialEndsAtUtc).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return null;
  return Math.max(0, Math.ceil(remainingMs / 86_400_000));
}

function trialEndLabel(trialEndsAtUtc: string | null | undefined): string | null {
  if (!trialEndsAtUtc) return null;
  const date = new Date(trialEndsAtUtc);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TrialConversionBanner({ trialEndsAtUtc, ownerView }: TrialConversionBannerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const daysRemaining = useMemo(() => trialDaysRemaining(trialEndsAtUtc), [trialEndsAtUtc]);
  const endsOn = useMemo(() => trialEndLabel(trialEndsAtUtc), [trialEndsAtUtc]);
  const urgent = daysRemaining !== null && daysRemaining <= 3;

  async function startCheckout() {
    if (!ownerView || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.billing.createCheckoutSession({ planCode: BASIC_PLAN.code });
      if (!result.checkoutUrl) throw new Error("Stripe checkout did not return a redirect URL.");
      window.location.assign(result.checkoutUrl);
    } catch (checkoutError) {
      setError(checkoutError instanceof ApiError ? checkoutError.message : "Billing checkout is temporarily unavailable.");
      setLoading(false);
    }
  }

  return (
    <section
      aria-label="Trial and billing"
      className={`mb-4 rounded-2xl border px-4 py-3 shadow-sm ${
        urgent ? "border-amber-300 bg-amber-50" : "border-blue-200 bg-blue-50"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={urgent ? "amber" : "blue"}>Full trial</Badge>
            <p className="text-sm font-semibold text-slate-950">
              {daysRemaining === null
                ? `${BASIC_PLAN.trialDays}-day trial active`
                : daysRemaining === 0
                  ? "Trial ends today"
                  : `${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} left`}
            </p>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Keep customer, quote, PDF, and follow-up access for {basicMonthlyPriceLabel()}.
            {endsOn ? ` Checkout now keeps access free until at least ${endsOn}.` : ""}
          </p>
        </div>
        {ownerView ? (
          <Button type="button" onClick={() => void startCheckout()} loading={loading} disabled={loading}>
            Keep QuoteFly — {basicMonthlyPriceLabel()}
          </Button>
        ) : (
          <p className="text-sm font-medium text-amber-800">Ask the workspace owner to choose Basic.</p>
        )}
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      ) : null}
    </section>
  );
}
