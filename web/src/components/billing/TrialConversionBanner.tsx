import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useLocale } from "../../i18n";
import { localizedApiError } from "../../lib/localized-api-error";
import { BASIC_PLAN } from "../../lib/plans";
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

function trialEndLabel(trialEndsAtUtc: string | null | undefined, locale: string): string | null {
  if (!trialEndsAtUtc) return null;
  const date = new Date(trialEndsAtUtc);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
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

export function TrialConversionBanner({ trialEndsAtUtc, ownerView }: TrialConversionBannerProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const daysRemaining = useMemo(() => trialDaysRemaining(trialEndsAtUtc), [trialEndsAtUtc]);
  const endsOn = useMemo(() => trialEndLabel(trialEndsAtUtc, locale), [locale, trialEndsAtUtc]);
  const urgent = daysRemaining !== null && daysRemaining <= 3;
  const firstPaidPrice = formatUsd(locale, BASIC_PLAN.firstPaidMonthPriceUsd);
  const monthlyPrice = t("billing.monthlyPrice", { price: formatUsd(locale, BASIC_PLAN.monthlyPriceUsd) });

  async function startCheckout() {
    if (!ownerView || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.billing.createCheckoutSession({ planCode: BASIC_PLAN.code });
      if (!result.checkoutUrl) throw new Error("Missing Stripe checkout redirect URL");
      window.location.assign(result.checkoutUrl);
    } catch (checkoutError) {
      setError(localizedApiError(checkoutError, t, {
        fallbackKey: "billing.checkoutUnavailable",
        statusKeys: { 409: "apiErrors.subscriptionExists" },
      }));
      setLoading(false);
    }
  }

  return (
    <section
      aria-label={t("billing.trial.aria")}
      className={`mb-4 rounded-2xl border px-3 py-2.5 shadow-[var(--qf-shadow-sm)] sm:px-4 sm:py-3 ${
        urgent
          ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)]"
          : "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]"
      }`}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={urgent ? "amber" : "blue"}>{t("billing.trial.full")}</Badge>
            <p className="text-sm font-semibold text-[var(--qf-text)]">
              {daysRemaining === null
                ? t("billing.trial.active", { count: BASIC_PLAN.trialDays })
                : daysRemaining === 0
                  ? t("billing.trial.endsToday")
                  : t("billing.trial.daysLeft", { count: daysRemaining })}
            </p>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--qf-text-soft)] sm:hidden">
            {endsOn ? t("billing.trial.freeThroughDate", { date: endsOn }) : t("billing.trial.freeThroughTrial")} {t("billing.trial.firstThen", { firstPrice: firstPaidPrice, monthlyPrice })}
          </p>
          <p className="mt-1 hidden text-sm text-[var(--qf-text-soft)] sm:block">
            {endsOn ? t("billing.trial.checkoutDate", { date: endsOn }) : t("billing.trial.checkoutTrial")} {t("billing.trial.checkoutPricing", { firstPrice: firstPaidPrice, monthlyPrice })}
          </p>
        </div>
        {ownerView ? (
          <Button type="button" onClick={() => void startCheckout()} loading={loading} disabled={loading} className="shrink-0">
            <span className="sm:hidden">{t("billing.trial.chooseShort", { price: firstPaidPrice })}</span>
            <span className="hidden sm:inline">{t("billing.trial.chooseLong", { price: firstPaidPrice })}</span>
          </Button>
        ) : (
          <p className="text-sm font-medium text-[var(--qf-warning-text)]">{t("billing.trial.ownerChoose")}</p>
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
