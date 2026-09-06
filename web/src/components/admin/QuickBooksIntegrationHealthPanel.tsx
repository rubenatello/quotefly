import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, type QuickBooksIntegrationHealth } from "../../lib/api";
import { Badge, Button, Card, CardHeader } from "../ui";

const SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1_000;
const SNAPSHOT_FUTURE_TOLERANCE_MS = 60 * 1_000;

type LoadState = "loading" | "ready" | "error";
type StatusTone = "emerald" | "amber" | "red" | "slate" | "blue";

const MODE_COPY: Record<QuickBooksIntegrationHealth["mode"], { label: string; description: string }> = {
  disabled: {
    label: "Disabled",
    description: "QuickBooks provider workflows are disabled in this environment.",
  },
  oauth_only: {
    label: "OAuth only",
    description: "Connection checks are enabled. Invoice publishing, payments, webhooks, reconciliation, and recovery are not enabled.",
  },
  accounting: {
    label: "Accounting enabled",
    description: "Provider-backed accounting workflows are enabled and included in this operational snapshot.",
  },
};

const WORKER_LABELS: Record<QuickBooksIntegrationHealth["worker"]["status"], string> = {
  not_required: "Not required",
  missing: "Missing",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  stale: "Stale",
  release_mismatch: "Release mismatch",
  topology_invalid: "Topology invalid",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatAge(value: number | null): string {
  if (value === null) return "None waiting";
  if (value < 60_000) return "Less than 1 minute";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function statusPresentation(report: QuickBooksIntegrationHealth, stale: boolean) {
  if (stale) return {
    tone: "amber" as StatusTone,
    label: "Snapshot stale",
    title: "Refresh health status",
    description: "This snapshot is too old to rely on. Refresh before making an operational decision.",
  };
  if (report.state === "critical") return {
    tone: "red" as StatusTone,
    label: "Critical",
    title: "QuickBooks needs action",
    description: "A critical operational condition is active. Review the queues and worker state below.",
  };
  if (report.state === "warning") return {
    tone: "amber" as StatusTone,
    label: "Warning",
    title: "QuickBooks needs attention",
    description: "A warning threshold is active. Review the queues and alert configuration below.",
  };
  if (report.mode === "disabled") return {
    tone: "slate" as StatusTone,
    label: "Disabled",
    title: "QuickBooks is disabled",
    description: "No active operational failure was detected, but the integration is not enabled.",
  };
  if (report.mode === "oauth_only") return {
    tone: "blue" as StatusTone,
    label: "No failures detected",
    title: "OAuth connection checks are clear",
    description: "This does not certify accounting automation, which remains intentionally disabled.",
  };
  const alertingReady = report.monitors.bearerConfigured
    && report.monitors.apiSignalSinkConfigured
    && (!report.worker.required || report.monitors.workerSignalSinkConfigured)
    && report.monitors.deliveryVerified;
  if (!alertingReady) return {
    tone: "amber" as StatusTone,
    label: "Alerting unverified",
    title: "Operations clear; alerting unverified",
    description: "No operational failure was detected, but production readiness still requires a delivered and acknowledged external alert.",
  };
  return {
    tone: "emerald" as StatusTone,
    label: "Healthy",
    title: "Accounting operations are clear",
    description: "No warning or critical accounting condition was detected in this current snapshot.",
  };
}

function toneClasses(tone: StatusTone): string {
  if (tone === "red") return "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)]";
  if (tone === "amber") return "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)]";
  if (tone === "emerald") return "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)]";
  if (tone === "blue") return "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]";
  return "border-[var(--qf-border)] bg-[var(--qf-panel-muted)]";
}

function ConfigurationRow({ label, state, note }: {
  label: string;
  state: "configured" | "not_configured" | "not_required" | "not_verified" | "unknown";
  note?: string;
}) {
  const successful = state === "configured";
  const badgeTone = successful ? "emerald" : state === "not_required" ? "slate" : "amber";
  const stateLabel = successful
    ? "Configured"
    : state === "not_required"
      ? "Not required"
      : state === "not_verified"
        ? "Not verified"
        : state === "unknown"
          ? "Not observable from API"
          : "Not configured";
  return (
    <li className="flex min-w-0 flex-col gap-2 border-b border-[var(--qf-border)] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--qf-text)]">{label}</p>
        {note ? <p className="mt-0.5 text-xs text-[var(--qf-text-soft)]">{note}</p> : null}
      </div>
      <Badge tone={badgeTone} className="w-fit shrink-0">{stateLabel}</Badge>
    </li>
  );
}

function Flag({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2">
      <span className="min-w-0 text-sm text-[var(--qf-text-soft)]">{label}</span>
      <Badge tone={enabled ? "emerald" : "slate"}>{enabled ? "Enabled" : "Disabled"}</Badge>
    </div>
  );
}

function QueueMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-[var(--qf-text)]">{value}</p>
      <p className="mt-1 text-xs text-[var(--qf-text-soft)]">{detail}</p>
    </div>
  );
}

export function QuickBooksIntegrationHealthPanel() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [report, setReport] = useState<QuickBooksIntegrationHealth | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const loadHealth = useCallback(async () => {
    setLoadState("loading");
    setReport(null);
    try {
      const next = await api.internal.controlPlane.quickBooksHealth();
      setReport(next);
      setClock(Date.now());
      setLoadState("ready");
    } catch {
      setReport(null);
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.internal.controlPlane.quickBooksHealth({ signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setReport(next);
        setClock(Date.now());
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setReport(null);
        setLoadState("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const stale = report
    ? clock - Date.parse(report.observedAtUtc) > SNAPSHOT_STALE_AFTER_MS
      || Date.parse(report.observedAtUtc) - clock > SNAPSHOT_FUTURE_TOLERANCE_MS
    : false;
  const presentation = useMemo(
    () => report ? statusPresentation(report, stale) : null,
    [report, stale],
  );

  return (
    <Card variant="elevated" padding="lg" data-testid="quickbooks-integration-health">
      <CardHeader
        title="QuickBooks integration health"
        subtitle="Platform-wide, read-only operational status. No tenant records, provider IDs, or credentials are shown."
        actions={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            icon={<RefreshCw size={15} />}
            loading={loadState === "loading"}
            onClick={() => void loadHealth()}
          >
            Refresh health
          </Button>
        )}
      />

      <div aria-live="polite" aria-busy={loadState === "loading" || undefined}>
        {loadState === "loading" ? (
          <div className="flex min-h-24 items-center gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4 text-sm text-[var(--qf-text-soft)]">
            <Activity className="shrink-0 animate-pulse motion-reduce:animate-none" size={20} aria-hidden="true" />
            Checking the current QuickBooks operational snapshot…
          </div>
        ) : null}

        {loadState === "error" ? (
          <div role="alert" className="rounded-xl border border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 shrink-0 text-[var(--qf-danger-text)]" size={20} aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-[var(--qf-danger-text)]">Status unavailable</p>
                <p className="mt-1 text-sm text-[var(--qf-danger-text)]">We could not verify QuickBooks health. Refresh before relying on this status.</p>
              </div>
            </div>
          </div>
        ) : null}

        {loadState === "ready" && report && presentation ? (
          <div className="space-y-4">
            <div className={`rounded-xl border p-4 ${toneClasses(presentation.tone)}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  {presentation.tone === "emerald"
                    ? <CheckCircle2 className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
                    : <AlertTriangle className="mt-0.5 shrink-0" size={20} aria-hidden="true" />}
                  <div className="min-w-0">
                    <p className="font-semibold text-[var(--qf-text)]">{presentation.title}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{presentation.description}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Badge tone={presentation.tone}>{presentation.label}</Badge>
                  <Badge tone={report.environment === "production" ? "red" : "amber"}>{report.environment === "production" ? "Production" : "Sandbox"}</Badge>
                </div>
              </div>
              <div className="mt-3 border-t border-current/15 pt-3">
                <p className="text-sm font-medium text-[var(--qf-text)]">{MODE_COPY[report.mode].label}</p>
                <p className="mt-1 text-xs text-[var(--qf-text-soft)]">{MODE_COPY[report.mode].description}</p>
                <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--qf-text-muted)]">
                  <Clock3 size={14} aria-hidden="true" />
                  Observed {formatDate(report.observedAtUtc)}
                </p>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <section aria-labelledby="quickbooks-alert-readiness-title" className="rounded-xl border border-[var(--qf-border)] p-4">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 shrink-0 text-[var(--qf-text-soft)]" size={18} aria-hidden="true" />
                  <div>
                    <h3 id="quickbooks-alert-readiness-title" className="font-semibold text-[var(--qf-text)]">External alert readiness</h3>
                    <p className="mt-1 text-xs text-[var(--qf-text-soft)]">Configuration is not proof that an owner received an alert.</p>
                  </div>
                </div>
                <ul className="mt-2">
                  <ConfigurationRow label="Monitor endpoint bearer" state={report.monitors.bearerConfigured ? "configured" : "not_configured"} />
                  <ConfigurationRow label="API signal sink" state={report.monitors.apiSignalSinkConfigured ? "configured" : "not_configured"} />
                  <ConfigurationRow
                    label="Worker signal sink"
                    state={report.worker.required
                      ? report.monitors.workerSignalSinkConfigured === true
                        ? "configured"
                        : report.monitors.workerSignalSinkConfigured === false
                          ? "not_configured"
                          : "unknown"
                      : "not_required"}
                    note={report.worker.required && report.monitors.workerSignalSinkConfigured === null
                      ? "Check the worker runtime configuration; its source token is intentionally isolated from the API."
                      : undefined}
                  />
                  <ConfigurationRow label="Owner alert receipt" state="not_verified" note="Requires a real external delivery and acknowledgement test." />
                </ul>
              </section>

              <section aria-labelledby="quickbooks-automation-title" className="rounded-xl border border-[var(--qf-border)] p-4">
                <h3 id="quickbooks-automation-title" className="font-semibold text-[var(--qf-text)]">Automation controls</h3>
                <p className="mt-1 text-xs text-[var(--qf-text-soft)]">Disabled controls remain unavailable until separately enabled and validated.</p>
                <div className="mt-3 grid gap-2">
                  <Flag label="Provider accounting actions" enabled={report.automation.providerActionsEnabled} />
                  <Flag label="Hosted invoice payments" enabled={report.automation.hostedPaymentsEnabled} />
                  <Flag label="Signed webhooks" enabled={report.automation.webhookConfigured} />
                  <Flag label="Status reconciliation" enabled={report.automation.reconciliationEnabled} />
                  <Flag label="Change-data recovery" enabled={report.automation.cdcEnabled} />
                </div>
              </section>
            </div>

            <section aria-labelledby="quickbooks-worker-title" className="rounded-xl border border-[var(--qf-border)] p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 id="quickbooks-worker-title" className="font-semibold text-[var(--qf-text)]">Accounting worker</h3>
                  <p className="mt-1 text-xs text-[var(--qf-text-soft)]">
                    {report.worker.required
                      ? `Last observed: ${report.worker.lastObservedAtUtc ? formatDate(report.worker.lastObservedAtUtc) : "Not yet"}.`
                      : "Not required in the current integration mode."}
                  </p>
                </div>
                <Badge tone={!report.worker.required ? "slate" : report.worker.ready ? "emerald" : "red"}>
                  {WORKER_LABELS[report.worker.status]}
                </Badge>
              </div>
            </section>

            <section aria-labelledby="quickbooks-queues-title">
              <h3 id="quickbooks-queues-title" className="font-semibold text-[var(--qf-text)]">Operational queues</h3>
              <p className="mt-1 text-xs text-[var(--qf-text-soft)]">Counts are platform-wide and exclude tenant-level details.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <QueueMetric
                  label="Webhooks"
                  value={`${report.operations.webhookOutstandingCount} waiting · ${report.operations.webhookDeadCount} dead`}
                  detail={`Oldest waiting: ${formatAge(report.operations.oldestWebhookOutstandingAgeMs)}`}
                />
                <QueueMetric
                  label="Reconciliation"
                  value={`${report.operations.reconciliationRequiredCount} waiting`}
                  detail={`Oldest waiting: ${formatAge(report.operations.oldestReconciliationRequiredAgeMs)}`}
                />
                <QueueMetric
                  label="Change recovery"
                  value={`${report.operations.cdcOverdueCount} overdue · ${report.operations.cdcTerminalCount} terminal`}
                  detail={`Maximum lag: ${formatAge(report.operations.maximumCdcLagMs)}`}
                />
                <QueueMetric
                  label="Connection revocations"
                  value={`${report.operations.connectionRevocationPendingCount} waiting · ${report.operations.connectionRevocationDeadCount} dead`}
                  detail={`Oldest waiting: ${formatAge(report.operations.oldestConnectionRevocationPendingAgeMs)}`}
                />
                <QueueMetric
                  label="Orphan revocations"
                  value={`${report.operations.orphanRevocationPendingCount} waiting · ${report.operations.orphanRevocationDeadCount} dead`}
                  detail={`Oldest waiting: ${formatAge(report.operations.oldestOrphanRevocationPendingAgeMs)}`}
                />
                <QueueMetric
                  label="Token refresh"
                  value={`${report.operations.tokenRefreshFailureConnectionCount} failing · ${report.operations.tokenRefreshReauthRequiredCount} need reconnect`}
                  detail={`Oldest failure: ${formatAge(report.operations.oldestTokenRefreshFailureAgeMs)}`}
                />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
