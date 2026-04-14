import type { AiUsageSummary } from "./api";

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
  const promptsLeftText =
    usage.estimatedPromptsRemaining !== null
      ? ` ~${usage.estimatedPromptsRemaining} est. prompts remaining.`
      : "";
  const renewalText = renewalLabel ? ` Renews ${renewalLabel}.` : "";
  return `${usagePercentText}${promptsLeftText}${renewalText}`.trim();
}

export function formatAiUsageAvailability(params: {
  usedUsd?: number | null;
  limitUsd?: number | null;
  estimatedPromptsRemaining?: number | null;
  renewsAtUtc?: string | null;
}) {
  if (params.limitUsd === null || params.limitUsd === undefined) return null;
  const usedUsd = params.usedUsd ?? 0;
  const percent = normalizeUsagePercent(usedUsd, params.limitUsd);
  const renewalLabel = formatAiRenewalDate(params.renewsAtUtc);
  const usageText = `AI usage ${Math.round(percent)}% used`;
  const promptsText =
    params.estimatedPromptsRemaining !== null && params.estimatedPromptsRemaining !== undefined
      ? ` | ~${params.estimatedPromptsRemaining} est. prompts left`
      : "";
  return renewalLabel
    ? `${usageText} | renews ${renewalLabel}${promptsText}`
    : `${usageText}${promptsText}`;
}
