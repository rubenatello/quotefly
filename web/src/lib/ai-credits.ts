import type { AiUsageSummary } from "./api";

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

export function formatAiRenewalDate(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
) {
  const renewalLabel = formatAiRenewalDate(renewsAtUtc);
  const renewalText = renewalLabel ? ` Resets ${renewalLabel}.` : "";

  if (threshold === 100) {
    return {
      title: "Monthly AI limit reached",
      description: `Kody and AI tools are paused for this workspace.${renewalText}`.trim(),
      severity: "error" as const,
    };
  }

  const remainingPercent = 100 - threshold;
  return {
    title: `AI usage is at ${threshold}%`,
    description: `${remainingPercent}% of this workspace's monthly AI budget remains.${renewalText}`.trim(),
    severity: threshold >= 75 ? "warning" as const : "info" as const,
  };
}

export function formatAiUsageNotice(usage: AiUsageSummary) {
  const renewalLabel = formatAiRenewalDate(usage.renewsAtUtc);
  const usagePercent =
    usage.monthlySpendUsagePercent ??
    (usage.monthlySpendLimitUsd !== null
      ? normalizeUsagePercent(usage.monthlySpendUsedUsd, usage.monthlySpendLimitUsd)
      : null);
  const usagePercentText =
    usagePercent === null || usagePercent === undefined
      ? "AI usage updated."
      : `${Math.round(usagePercent)}% used this month.`;
  const renewalText = renewalLabel ? ` Renews ${renewalLabel}.` : "";
  return `${usagePercentText}${renewalText}`.trim();
}

export function formatAiUsageAvailability(params: {
  usedUsd?: number | null;
  limitUsd?: number | null;
  renewsAtUtc?: string | null;
}) {
  if (params.limitUsd === null || params.limitUsd === undefined) return null;
  const usedUsd = params.usedUsd ?? 0;
  const percent = normalizeUsagePercent(usedUsd, params.limitUsd);
  const renewalLabel = formatAiRenewalDate(params.renewsAtUtc);
  const usageText = `AI usage ${Math.round(percent)}% used`;
  return renewalLabel
    ? `${usageText} | renews ${renewalLabel}`
    : usageText;
}
