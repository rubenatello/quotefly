import type { AiUsageSummary } from "./api";
import i18n from "../i18n/i18n";

export const AI_USAGE_WARNING_THRESHOLDS = [25, 50, 75, 85, 95, 100] as const;
export type AiUsageWarningThreshold = (typeof AI_USAGE_WARNING_THRESHOLDS)[number];
export const AI_USAGE_UPDATED_EVENT = "qf:ai-usage-updated";

export type AiUsageUpdateDetail = Pick<
  AiUsageSummary,
  "monthlySpendUsagePercent" | "warningThresholdPercent" | "limitReached" | "renewsAtUtc"
>;

export function publishAiUsageUpdate(usage: AiUsageUpdateDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AiUsageUpdateDetail>(AI_USAGE_UPDATED_EVENT, { detail: usage }));
}

function activeLocale(locale?: string): string {
  return locale ?? i18n.resolvedLanguage ?? i18n.language ?? "en-US";
}

export function formatAiRenewalDate(value?: string | null, locale?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(activeLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function normalizeUsagePercent(usedUsd: number, limitUsd: number) {
  if (limitUsd <= 0) return 0;
  return Math.min((usedUsd / limitUsd) * 100, 100);
}

export function resolveAiUsageWarningThreshold(
  usagePercent: number | null | undefined,
): AiUsageWarningThreshold | null {
  if (usagePercent === null || usagePercent === undefined || !Number.isFinite(usagePercent)) return null;
  for (let index = AI_USAGE_WARNING_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    const threshold = AI_USAGE_WARNING_THRESHOLDS[index];
    if (threshold !== undefined && usagePercent >= threshold) return threshold;
  }
  return null;
}

export function aiUsageProgressTone(usagePercent: number): "default" | "warning" | "danger" {
  if (usagePercent >= 95) return "danger";
  if (usagePercent >= 75) return "warning";
  return "default";
}

export function aiUsageWarningCopy(
  threshold: AiUsageWarningThreshold,
  renewsAtUtc?: string | null,
  locale?: string,
) {
  const t = i18n.getFixedT(activeLocale(locale));
  const renewalLabel = formatAiRenewalDate(renewsAtUtc, locale);
  const renewalText = renewalLabel ? t("billing.aiUsage.resets", { date: renewalLabel }) : null;

  if (threshold === 100) {
    return {
      title: t("billing.aiUsage.limitTitle"),
      description: [t("billing.aiUsage.limitDescription"), renewalText].filter(Boolean).join(" "),
      severity: "error" as const,
    };
  }

  const remainingPercent = 100 - threshold;
  return {
    title: t("billing.aiUsage.usageTitle", { percent: threshold }),
    description: [t("billing.aiUsage.remaining", { percent: remainingPercent }), renewalText].filter(Boolean).join(" "),
    severity: threshold >= 75 ? "warning" as const : "info" as const,
  };
}

export function formatAiUsageNotice(usage: AiUsageSummary, locale?: string) {
  const t = i18n.getFixedT(activeLocale(locale));
  const renewalLabel = formatAiRenewalDate(usage.renewsAtUtc, locale);
  const usagePercent =
    usage.monthlySpendUsagePercent ??
    (usage.monthlySpendLimitUsd !== null
      ? normalizeUsagePercent(usage.monthlySpendUsedUsd, usage.monthlySpendLimitUsd)
      : null);
  const usagePercentText =
    usagePercent === null || usagePercent === undefined
      ? t("billing.aiUsage.updated")
      : t("billing.aiUsage.usedThisMonth", { percent: Math.round(usagePercent) });
  const renewalText = renewalLabel ? t("billing.aiUsage.renews", { date: renewalLabel }) : null;
  return [usagePercentText, renewalText].filter(Boolean).join(" ");
}

export function formatAiUsageAvailability(params: {
  usedUsd?: number | null;
  limitUsd?: number | null;
  renewsAtUtc?: string | null;
}, locale?: string) {
  if (params.limitUsd === null || params.limitUsd === undefined) return null;
  const t = i18n.getFixedT(activeLocale(locale));
  const usedUsd = params.usedUsd ?? 0;
  const percent = normalizeUsagePercent(usedUsd, params.limitUsd);
  const roundedPercent = Math.round(percent);
  const renewalLabel = formatAiRenewalDate(params.renewsAtUtc, locale);
  return renewalLabel
    ? t("billing.aiUsage.availabilityRenews", { percent: roundedPercent, date: renewalLabel })
    : t("billing.aiUsage.availability", { percent: roundedPercent });
}
