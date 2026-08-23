import { useCallback, useEffect } from "react";
import type { TenantUsageSnapshot } from "../../lib/api";
import {
  aiUsageWarningCopy,
  AI_USAGE_UPDATED_EVENT,
  resolveAiUsageWarningThreshold,
  resolveAiUsagePresentation,
  type AiUsageUpdateDetail,
  type AiUsageWarningThreshold,
} from "../../lib/ai-credits";
import { notify } from "../../lib/notifications";

const STORAGE_PREFIX = "qf_ai_usage_warning_v1";

function storedThreshold(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function rememberThreshold(key: string, threshold: AiUsageWarningThreshold) {
  try {
    window.localStorage.setItem(key, String(threshold));
  } catch {
    // The warning can still be shown when private browsing blocks storage.
  }
}

export function AiUsageMilestoneNotifier({
  tenantId,
  userId,
  usage,
  onUsageChanged,
}: {
  tenantId: string;
  userId: string;
  usage?: TenantUsageSnapshot;
  onUsageChanged: () => Promise<void>;
}) {
  const usagePresentation = resolveAiUsagePresentation(usage);
  const usagePercent = usagePresentation.effectivePercent;
  const threshold = usagePresentation.billingCycleReconciliationPending
    ? null
    : usage?.monthlyAiSpendWarningThresholdPercent ??
      resolveAiUsageWarningThreshold(usagePercent);
  const periodEndUtc = usagePresentation.renewsAtUtc;

  const showWarning = useCallback((nextThreshold: AiUsageWarningThreshold | null, renewsAtUtc: string | null) => {
    if (nextThreshold === null || !renewsAtUtc) return;
    const key = `${STORAGE_PREFIX}:${tenantId}:${userId}:${renewsAtUtc}`;
    if (storedThreshold(key) >= nextThreshold) return;

    rememberThreshold(key, nextThreshold);
    const copy = aiUsageWarningCopy(nextThreshold, renewsAtUtc);
    const options = {
      description: copy.description,
      id: `${key}:${nextThreshold}`,
    };
    if (copy.severity === "error") notify.error(copy.title, options);
    else if (copy.severity === "warning") notify.warning(copy.title, options);
    else notify.info(copy.title, options);
  }, [tenantId, userId]);

  useEffect(() => {
    showWarning(threshold, periodEndUtc);
  }, [periodEndUtc, showWarning, threshold]);

  useEffect(() => {
    const handleUsageUpdate = (event: Event) => {
      const detail = (event as CustomEvent<AiUsageUpdateDetail>).detail;
      const presentation = resolveAiUsagePresentation(detail);
      const nextThreshold = presentation.billingCycleReconciliationPending
        ? null
        : detail?.warningThresholdPercent ??
          resolveAiUsageWarningThreshold(presentation.effectivePercent);
      showWarning(nextThreshold, presentation.renewsAtUtc);
      // A canonical accounting failure is a client-side fail-closed pause.
      // Do not immediately overwrite it with a concurrently fetched session;
      // an explicit session refresh is the authoritative recovery path.
      if (detail?.accountingUnavailable === true) return;
      void onUsageChanged().catch((error) => {
        console.warn("Could not refresh workspace AI usage after an AI request.", error);
      });
    };

    window.addEventListener(AI_USAGE_UPDATED_EVENT, handleUsageUpdate);
    return () => window.removeEventListener(AI_USAGE_UPDATED_EVENT, handleUsageUpdate);
  }, [onUsageChanged, showWarning]);

  return null;
}
