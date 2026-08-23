import {
  ApiError,
  type AiAssistantTool,
  type AiUsagePeriodSource,
  type AiUsageSummary,
  type TenantUsageSnapshot,
} from "./api";
import i18n from "../i18n/i18n";

export const AI_USAGE_WARNING_THRESHOLDS = [25, 50, 75, 85, 95, 100] as const;
export type AiUsageWarningThreshold = (typeof AI_USAGE_WARNING_THRESHOLDS)[number];
export const AI_USAGE_UPDATED_EVENT = "qf:ai-usage-updated";
export const AI_ASSISTANT_PAID_TOOLS: ReadonlySet<AiAssistantTool> = new Set([
  "SEARCH_CUSTOMERS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_QUOTE",
]);

export function assistantToolConsumesAiBudget(tool: AiAssistantTool | "AUTO") {
  return tool !== "AUTO" && AI_ASSISTANT_PAID_TOOLS.has(tool);
}

export type AiUsageUpdateDetail = Partial<AiUsageSummary> & {
  periodStartUtc?: string;
  periodEndUtc?: string;
  /** Client-only fail-closed state; cleared by the next authoritative session. */
  accountingUnavailable?: boolean;
};

export type AiUsagePresentation = {
  completedPercent: number;
  reservedPercent: number;
  effectivePercent: number;
  remainingPercent: number;
  activeReservationCount: number;
  enforcementMode: "SPEND" | "CREDITS" | "UNLIMITED";
  periodSource: AiUsagePeriodSource | null;
  billingCycleReconciliationPending: boolean;
  accountingUnavailable: boolean;
  paidActionsUnavailable: boolean;
  limitReached: boolean;
  renewsAtUtc: string | null;
  periodStartUtc: string | null;
};

type AiUsagePresentationInput = Partial<AiUsageSummary & TenantUsageSnapshot> & {
  accountingUnavailable?: boolean;
};

export function publishAiUsageUpdate(usage: AiUsageUpdateDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AiUsageUpdateDetail>(AI_USAGE_UPDATED_EVENT, { detail: usage }));
}

/**
 * A usage-limit response is authoritative even when the session snapshot was
 * fetched just before the request. Older and intentionally minimal 402/503
 * payloads do not include a full usage object, so preserve only the fact the
 * browser can safely act on: paid AI is paused. We do not fabricate spend,
 * credits, renewal, or percentage values.
 */
export function aiUsageUpdateFromApiError(error: unknown): AiUsageUpdateDetail | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return null;

  const details = error.details as { code?: unknown; renewsAtUtc?: unknown; usage?: unknown };
  if (details.usage && typeof details.usage === "object") {
    return details.usage as AiUsageUpdateDetail;
  }

  if (error.status === 503 && details.code === "AI_USAGE_ACCOUNTING_UNAVAILABLE") {
    return { accountingUnavailable: true };
  }

  if (error.status !== 402 || details.code !== "AI_USAGE_LIMIT_REACHED") return null;

  return {
    limitReached: true,
    ...(typeof details.renewsAtUtc === "string" && details.renewsAtUtc.trim()
      ? { renewsAtUtc: details.renewsAtUtc }
      : {}),
  };
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

function finitePercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function resolveAiUsagePresentation(usage?: AiUsagePresentationInput | null): AiUsagePresentation {
  const compatibilityPercent = finitePercent(
    usage?.monthlySpendUsagePercent ?? usage?.monthlyAiSpendUsagePercent,
  );
  const derivedSpendPercent =
    usage?.monthlySpendUsedUsd !== undefined && usage.monthlySpendLimitUsd
      ? normalizeUsagePercent(usage.monthlySpendUsedUsd, usage.monthlySpendLimitUsd)
      : usage?.monthlyAiSpendUsd !== undefined && usage.monthlyAiSpendLimitUsd
        ? normalizeUsagePercent(usage.monthlyAiSpendUsd, usage.monthlyAiSpendLimitUsd)
        : null;
  const effectivePercent = finitePercent(usage?.monthlyUsageEffectivePercent)
    ?? compatibilityPercent
    ?? derivedSpendPercent
    ?? 0;
  const reservedPercent = finitePercent(usage?.monthlyUsageReservedPercent) ?? 0;
  const completedPercent = finitePercent(usage?.monthlyUsageCompletedPercent)
    ?? Math.max(0, effectivePercent - reservedPercent);
  const remainingPercent = finitePercent(usage?.monthlyUsageRemainingPercent)
    ?? Math.max(0, 100 - effectivePercent);
  const enforcementMode = usage?.enforcementMode
    ?? ((usage?.monthlySpendLimitUsd ?? usage?.monthlyAiSpendLimitUsd) === null ? "UNLIMITED" : "SPEND");
  const billingCycleReconciliationPending =
    usage?.billingCycleReconciliationPending === true
    || usage?.periodSource === "UTC_CALENDAR_LEGACY";
  const accountingUnavailable = usage?.accountingUnavailable === true;
  const limitReached =
    usage?.limitReached === true
    || usage?.monthlyAiLimitReached === true
    || (enforcementMode !== "UNLIMITED" && effectivePercent >= 100);

  return {
    completedPercent,
    reservedPercent,
    effectivePercent,
    remainingPercent,
    activeReservationCount: Math.max(0, Math.floor(usage?.activeReservationCount ?? 0)),
    enforcementMode,
    periodSource: usage?.periodSource ?? null,
    billingCycleReconciliationPending,
    accountingUnavailable,
    paidActionsUnavailable: billingCycleReconciliationPending || accountingUnavailable || limitReached,
    limitReached,
    renewsAtUtc: billingCycleReconciliationPending
      ? null
      : usage?.renewsAtUtc ?? usage?.periodEndUtc ?? null,
    periodStartUtc: usage?.periodStartUtc ?? null,
  };
}

export function formatAiUsageBreakdown(usage: AiUsagePresentationInput, locale?: string) {
  const t = i18n.getFixedT(activeLocale(locale));
  const presentation = resolveAiUsagePresentation(usage);
  if (presentation.billingCycleReconciliationPending) {
    const headline = t("billing.aiUsage.reconciliationTitle");
    const detail = t("billing.aiUsage.reconciliationDescription");
    return {
      ...presentation,
      headline,
      detail,
      valueText: `${headline}. ${detail}`,
    };
  }
  const renews = formatAiRenewalDate(presentation.renewsAtUtc, locale);
  const used = t("billing.aiUsage.usedThisMonth", { percent: Math.round(presentation.effectivePercent) });
  const breakdown = t("billing.aiUsage.breakdown", {
    completed: Math.round(presentation.completedPercent),
    reserved: Math.round(presentation.reservedPercent),
  });
  const available = t("billing.aiUsage.available", { percent: Math.round(presentation.remainingPercent) });
  const active = t("billing.aiUsage.activeRequests", { count: presentation.activeReservationCount });
  const renewal = renews ? t("billing.aiUsage.renews", { date: renews }) : null;
  return {
    ...presentation,
    headline: used,
    detail: [breakdown, available, active, renewal].filter(Boolean).join(" · "),
    valueText: [used, breakdown, available, active, renewal].filter(Boolean).join(". "),
  };
}

export function formatAiPaidUsagePause(usage: AiUsagePresentationInput, locale?: string) {
  const t = i18n.getFixedT(activeLocale(locale));
  const presentation = resolveAiUsagePresentation(usage);
  if (presentation.billingCycleReconciliationPending) {
    return t("billing.aiUsage.reconciliationDescription");
  }
  if (presentation.accountingUnavailable) {
    return t("billing.aiUsage.accountingUnavailable");
  }
  const renews = formatAiRenewalDate(presentation.renewsAtUtc, locale);
  return renews
    ? t("billing.aiUsage.paidPausedUntil", { date: renews })
    : t("billing.aiUsage.paidPaused");
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
  const presentation = resolveAiUsagePresentation(usage);
  if (presentation.billingCycleReconciliationPending) {
    return t("billing.aiUsage.reconciliationTitle");
  }
  const renewalLabel = formatAiRenewalDate(presentation.renewsAtUtc, locale);
  const usagePercentText = t("billing.aiUsage.usedThisMonth", { percent: Math.round(presentation.effectivePercent) });
  const renewalText = renewalLabel ? t("billing.aiUsage.renews", { date: renewalLabel }) : null;
  return [usagePercentText, renewalText].filter(Boolean).join(" ");
}

export function formatAiUsageAvailability(params: {
  usage?: AiUsagePresentationInput | null;
  usedUsd?: number | null;
  limitUsd?: number | null;
  renewsAtUtc?: string | null;
}, locale?: string) {
  if (params.usage) return formatAiUsageBreakdown(params.usage, locale).headline;
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
