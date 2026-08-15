import { useMemo, useState } from "react";
import { ApiError, api } from "../../lib/api";
import {
  BASIC_PLAN,
  basicFirstPaidMonthPriceLabel,
  basicMonthlyPriceLabel,
} from "../../lib/plans";
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
      className={`mb-4 rounded-2xl border px-3 py-2.5 shadow-[var(--qf-shadow-sm)] sm:px-4 sm:py-3 ${
        urgent
          ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)]"
          : "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]"
      }`}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={urgent ? "amber" : "blue"}>Full trial</Badge>
            <p className="text-sm font-semibold text-[var(--qf-text)]">
              {daysRemaining === null
                ? `${BASIC_PLAN.trialDays}-day trial active`
                : daysRemaining === 0
                  ? "Trial ends today"
                  : `${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} left`}
            </p>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--qf-text-soft)] sm:hidden">
            {endsOn ? `Free through ${endsOn}. ` : "Free through your trial. "}
            First month {basicFirstPaidMonthPriceLabel()}, then {basicMonthlyPriceLabel()}.
          </p>
          <p className="mt-1 hidden text-sm text-[var(--qf-text-soft)] sm:block">
            Checkout keeps access free{endsOn ? ` until at least ${endsOn}` : " through your trial"}.
            {` Your first paid month is ${basicFirstPaidMonthPriceLabel()}, then ${basicMonthlyPriceLabel()}.`}
          </p>
        </div>
        {ownerView ? (
          <Button type="button" onClick={() => void startCheckout()} loading={loading} disabled={loading} className="shrink-0">
            <span className="sm:hidden">Choose Basic · {basicFirstPaidMonthPriceLabel()}</span>
            <span className="hidden sm:inline">Choose Basic — {basicFirstPaidMonthPriceLabel()} first month</span>
          </Button>
        ) : (
          <p className="text-sm font-medium text-[var(--qf-warning-text)]">Ask the workspace owner to choose Basic.</p>
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
