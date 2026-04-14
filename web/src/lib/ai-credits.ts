import type { AiUsageSummary } from "./api";

export function formatAiRenewalDate(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAiUsageNotice(usage: AiUsageSummary) {
  const renewalLabel = formatAiRenewalDate(usage.renewsAtUtc);

  if (usage.monthlyRemaining === null) {
    return usage.consumedCredits === 1
      ? "1 AI credit used."
      : `${usage.consumedCredits} AI credits used.`;
  }

  const creditLabel = usage.consumedCredits === 1 ? "1 AI credit used." : `${usage.consumedCredits} AI credits used.`;
  const renewalText = renewalLabel ? ` Credits renew ${renewalLabel}.` : "";
  return `${creditLabel} ${usage.monthlyRemaining} left this month.${renewalText}`.trim();
}

export function formatAiUsageAvailability(params: {
  used?: number | null;
  limit?: number | null;
  renewsAtUtc?: string | null;
}) {
  if (params.limit === null || params.limit === undefined) return null;
  const used = params.used ?? 0;
  const remaining = Math.max(params.limit - used, 0);
  const renewalLabel = formatAiRenewalDate(params.renewsAtUtc);
  return renewalLabel
    ? `${remaining} AI credits left · renews ${renewalLabel}`
    : `${remaining} AI credits left`;
}
