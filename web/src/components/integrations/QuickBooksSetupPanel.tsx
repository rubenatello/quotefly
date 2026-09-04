import {
  IconAlertTriangleFilled,
  IconBook2,
  IconBuildingBank,
  IconCircleCheckFilled,
  IconPlugConnected,
  IconReceiptDollarFilled,
  IconRefresh,
  IconShieldCheckFilled,
  IconUnlink,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QuickBooksSetupCheckKey, QuickBooksSetupPhase, QuickBooksStatusPayload } from "../../lib/api";
import { Alert, Badge, Button, Card } from "../ui";
import { QuickBooksSetupGuide } from "./QuickBooksSetupGuide";

type QuickBooksAction = "connect" | "confirm" | "disconnect" | null;

type QuickBooksSetupPanelProps = {
  canManage: boolean;
  status: QuickBooksStatusPayload | null;
  loading: boolean;
  error: string | null;
  action: QuickBooksAction;
  onRetry: () => void;
  onConnect: () => void;
  onConfirm: () => void;
  onDisconnect: () => void;
};

const checkKeys: Record<QuickBooksSetupCheckKey, string> = {
  PROVIDER_CONFIGURED: "admin.quickBooksSetup.checks.providerConfigured",
  PROVIDER_WORKFLOWS_ENABLED: "admin.quickBooksSetup.checks.workflowsEnabled",
  ACCOUNTING_WORKFLOWS_ENABLED: "admin.quickBooksSetup.checks.accountingWorkflowsEnabled",
  WEBHOOK_CONFIGURED: "admin.quickBooksSetup.checks.webhookConfigured",
  HOSTED_PAYMENTS_ENABLED: "admin.quickBooksSetup.checks.hostedPaymentsEnabled",
  RECONCILIATION_WORKER_ENABLED: "admin.quickBooksSetup.checks.reconciliationWorkerEnabled",
  RECONCILIATION_WORKER_HEALTHY: "admin.quickBooksSetup.checks.reconciliationWorkerHealthy",
  CDC_WORKER_ENABLED: "admin.quickBooksSetup.checks.cdcWorkerEnabled",
  CONNECTION_ACTIVE: "admin.quickBooksSetup.checks.connectionActive",
  ENVIRONMENT_MATCHES: "admin.quickBooksSetup.checks.environmentMatches",
  ACCOUNTING_SCOPE_GRANTED: "admin.quickBooksSetup.checks.accountingScope",
  CREDENTIALS_AVAILABLE: "admin.quickBooksSetup.checks.credentialsAvailable",
  REALM_BINDING_ACTIVE: "admin.quickBooksSetup.checks.companyBinding",
  CDC_CURSOR_INITIALIZED: "admin.quickBooksSetup.checks.recoveryReady",
  SETUP_CONFIRMED: "admin.quickBooksSetup.checks.setupConfirmed",
};

const preConnectionPlatformChecks = new Set<QuickBooksSetupCheckKey>([
  "PROVIDER_CONFIGURED",
  "PROVIDER_WORKFLOWS_ENABLED",
]);

function phaseTone(phase: QuickBooksSetupPhase): "emerald" | "blue" | "amber" | "red" | "slate" {
  if (phase === "CONFIRMED") return "emerald";
  if (phase === "READY_FOR_CONFIRMATION") return "blue";
  if (phase === "ACTION_REQUIRED") return "amber";
  if (phase === "UNAVAILABLE") return "red";
  return "slate";
}

function phaseKey(phase: QuickBooksSetupPhase) {
  const keys: Record<QuickBooksSetupPhase, string> = {
    UNAVAILABLE: "admin.quickBooksSetup.phases.unavailable",
    NOT_CONNECTED: "admin.quickBooksSetup.phases.notConnected",
    ACTION_REQUIRED: "admin.quickBooksSetup.phases.actionRequired",
    READY_FOR_CONFIRMATION: "admin.quickBooksSetup.phases.readyToConfirm",
    CONFIRMED: "admin.quickBooksSetup.phases.confirmed",
  };
  return keys[phase];
}

function formatDateTime(value: string | null | undefined, locale: string, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function QuickBooksSetupPanel({
  canManage,
  status,
  loading,
  error,
  action,
  onRetry,
  onConnect,
  onConfirm,
  onDisconnect,
}: QuickBooksSetupPanelProps) {
  const { t, i18n } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);
  const guideTriggerRef = useRef<HTMLButtonElement>(null);

  function closeGuide() {
    setGuideOpen(false);
    window.requestAnimationFrame(() => guideTriggerRef.current?.focus());
  }

  if (!canManage) {
    return (
      <Card variant="default" padding="lg">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]">
            <IconBuildingBank size={24} aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-semibold text-[var(--qf-text)]">{t("admin.quickBooksSetup.managerOnlyTitle")}</h3>
            <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">{t("admin.quickBooksSetup.managerOnlyDescription")}</p>
          </div>
        </div>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card variant="default" padding="lg" className="min-h-56" role="status">
        <div className="flex items-center gap-3 text-sm text-[var(--qf-text-soft)]">
          <IconRefresh className="animate-spin" size={20} aria-hidden="true" />
          {t("admin.quickBooksSetup.loading")}
        </div>
      </Card>
    );
  }

  if (error || !status) {
    return (
      <Card variant="default" padding="lg">
        <Alert tone="error">{error ?? t("admin.quickBooksSetup.loadError")}</Alert>
        <Button className="mt-4" variant="outline" icon={<IconRefresh size={17} />} onClick={onRetry}>
          {t("admin.quickBooksSetup.retry")}
        </Button>
      </Card>
    );
  }

  const { setup, connection } = status;
  const fallback = t("admin.quickBooksSetup.never");
  const primaryAction = setup.capabilities.canConnect
    ? { label: t("admin.quickBooksSetup.connect"), handler: onConnect }
    : setup.capabilities.canReconnect && connection?.status !== "CONNECTED"
      ? { label: t("admin.quickBooksSetup.reconnect"), handler: onConnect }
      : null;
  const actionableFailures = setup.checks.filter((check) => !check.passed && check.managedBy === "WORKSPACE");
  const quoteFlyManagedFailures = setup.checks.filter((check) => !check.passed && check.managedBy === "QUOTEFLY");
  const platformFailures = connection?.status === "CONNECTED"
    ? quoteFlyManagedFailures
    : quoteFlyManagedFailures.filter((check) => preConnectionPlatformChecks.has(check.key));
  const reconciliationWorkerExpected = setup.checks.some(
    (check) => check.key === "RECONCILIATION_WORKER_ENABLED" && check.passed,
  );
  const reconciliationWorkerHealthy = Boolean(status.reconciliationWorker?.fresh);

  return (
    <>
      <Card variant="elevated" padding="lg" className="overflow-hidden">
      <div className="relative overflow-hidden rounded-[24px] border border-[var(--qf-info-border)] bg-[linear-gradient(135deg,var(--qf-info-surface),var(--qf-panel)_62%)] p-4 sm:p-5">
        <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-[var(--qf-primary)] opacity-[0.08] blur-2xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--qf-primary)] text-white shadow-lg shadow-blue-950/10">
              <IconReceiptDollarFilled size={27} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.eyebrow")}</p>
              <h3 className="mt-1 break-words text-xl font-bold text-[var(--qf-text)]">
                {connection?.companyName || t("admin.quickBooksSetup.notConnectedCompany")}
              </h3>
              <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">{t("admin.quickBooksSetup.description")}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Badge tone={phaseTone(setup.phase)}>{t(phaseKey(setup.phase))}</Badge>
            <Badge tone={status.environment === "sandbox" ? "amber" : "slate"}>
              {status.environment === "sandbox" ? t("admin.quickBooksSetup.sandbox") : t("admin.quickBooksSetup.production")}
            </Badge>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {primaryAction ? (
          <Button icon={<IconPlugConnected size={18} />} onClick={primaryAction.handler} loading={action === "connect"} disabled={action !== null && action !== "connect"}>
            {primaryAction.label}
          </Button>
        ) : null}
        {setup.capabilities.canConfirm && !setup.confirmed ? (
          <Button variant="success" icon={<IconShieldCheckFilled size={18} />} onClick={onConfirm} loading={action === "confirm"} disabled={action !== null && action !== "confirm"}>
            {t("admin.quickBooksSetup.confirm")}
          </Button>
        ) : null}
        <Button ref={guideTriggerRef} variant="outline" icon={<IconBook2 size={18} />} onClick={() => setGuideOpen(true)}>
          {t("admin.quickBooksSetup.guide.open")}
        </Button>
        <Button variant="ghost" icon={<IconRefresh size={18} />} onClick={onRetry} disabled={action !== null}>
          {t("admin.quickBooksSetup.refresh")}
        </Button>
        {setup.capabilities.canDisconnect ? (
          <Button variant="outline" icon={<IconUnlink size={18} />} onClick={onDisconnect} loading={action === "disconnect"} disabled={action !== null && action !== "disconnect"}>
            {t("admin.quickBooksSetup.disconnect")}
          </Button>
        ) : null}
      </div>

      {actionableFailures.length ? (
        <div className="mt-5">
          <Alert tone="warning">
            <p className="font-semibold">{t("admin.quickBooksSetup.actionRequiredTitle")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {actionableFailures.map((check) => <li key={check.key}>{t(checkKeys[check.key])}</li>)}
            </ul>
          </Alert>
        </div>
      ) : null}

      {platformFailures.length ? (
        <div className="mt-5">
          <Alert tone="warning">
            <p className="font-semibold">
              {connection?.status === "CONNECTED"
                ? t("admin.quickBooksSetup.platformWaitingTitle")
                : t("admin.quickBooksSetup.platformUnavailableTitle")}
            </p>
            <p className="mt-1">
              {connection?.status === "CONNECTED"
                ? t("admin.quickBooksSetup.platformWaitingDescription")
                : t("admin.quickBooksSetup.platformUnavailableDescription")}
            </p>
          </Alert>
        </div>
      ) : null}

      {reconciliationWorkerExpected && !reconciliationWorkerHealthy ? (
        <div className="mt-5">
          <Alert tone="warning">
            <p className="font-semibold">{t("admin.quickBooksSetup.workerUnavailableTitle")}</p>
            <p className="mt-1">{t("admin.quickBooksSetup.workerUnavailableDescription")}</p>
          </Alert>
        </div>
      ) : null}

      <details className="mt-5 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--qf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)]">
          <span>{t("admin.quickBooksSetup.diagnosticsTitle")}</span>
          <span className="text-xs font-medium text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.diagnosticsHint")}</span>
        </summary>
      <div className="grid gap-5 border-t border-[var(--qf-border)] py-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <section aria-labelledby="quickbooks-checklist-title">
          <div className="flex items-center gap-2">
            <IconShieldCheckFilled className="text-[var(--qf-primary)]" size={20} aria-hidden="true" />
            <h4 id="quickbooks-checklist-title" className="font-semibold text-[var(--qf-text)]">{t("admin.quickBooksSetup.checklistTitle")}</h4>
          </div>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("admin.quickBooksSetup.checklistDescription")}</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {setup.checks.map((check) => (
              <li key={check.key} className="flex min-h-12 items-start gap-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2.5">
                {check.passed
                  ? <IconCircleCheckFilled className="mt-0.5 shrink-0 text-[var(--qf-success-text)]" size={18} aria-hidden="true" />
                  : <IconAlertTriangleFilled className="mt-0.5 shrink-0 text-[var(--qf-warning-text)]" size={18} aria-hidden="true" />}
                <span className="min-w-0 text-sm leading-5 text-[var(--qf-text)]">
                  {t(checkKeys[check.key])}
                  {!check.passed && check.managedBy === "QUOTEFLY" ? (
                    <span className="block text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.quoteFlyManaged")}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
          <h4 className="font-semibold text-[var(--qf-text)]">{t("admin.quickBooksSetup.activityTitle")}</h4>
          <dl className="mt-3 grid gap-3 text-sm">
            <div><dt className="text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.lastSync")}</dt><dd className="mt-0.5 font-medium text-[var(--qf-text)]">{formatDateTime(connection?.lastSyncAtUtc, i18n.language, fallback)}</dd></div>
            <div><dt className="text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.lastWebhook")}</dt><dd className="mt-0.5 font-medium text-[var(--qf-text)]">{formatDateTime(connection?.lastWebhookAtUtc, i18n.language, fallback)}</dd></div>
            <div><dt className="text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.confirmedAt")}</dt><dd className="mt-0.5 font-medium text-[var(--qf-text)]">{formatDateTime(setup.confirmedAtUtc, i18n.language, fallback)}</dd></div>
            <div>
              <dt className="text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.workerHeartbeat")}</dt>
              <dd className={`mt-0.5 font-medium ${reconciliationWorkerHealthy ? "text-[var(--qf-success-text)]" : "text-[var(--qf-warning-text)]"}`}>
                {reconciliationWorkerHealthy
                  ? t("admin.quickBooksSetup.workerOnline", {
                      date: formatDateTime(status.reconciliationWorker?.heartbeatAtUtc, i18n.language, fallback),
                    })
                  : t("admin.quickBooksSetup.workerOffline")}
              </dd>
            </div>
          </dl>
          {connection ? (
            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-[var(--qf-border)] pt-4 text-center">
              <div><p className="text-lg font-bold text-[var(--qf-text)]">{connection.counts.customerMaps}</p><p className="text-[11px] text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.customers")}</p></div>
              <div><p className="text-lg font-bold text-[var(--qf-text)]">{connection.counts.itemMaps}</p><p className="text-[11px] text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.items")}</p></div>
              <div><p className="text-lg font-bold text-[var(--qf-text)]">{connection.counts.invoiceSyncs}</p><p className="text-[11px] text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.invoices")}</p></div>
            </div>
          ) : null}
          <div className="mt-4 border-t border-[var(--qf-border)] pt-4">
            <p className="text-sm font-semibold text-[var(--qf-text)]">{t("admin.quickBooksSetup.operationsTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{t("admin.quickBooksSetup.operationsDescription")}</p>
            <ul className="mt-3 space-y-2">
              {([
                ["coreConnectionReady", "admin.quickBooksSetup.operations.coreConnection"],
                ["hostedPaymentsReady", "admin.quickBooksSetup.operations.hostedPayments"],
                ["reconciliationReady", "admin.quickBooksSetup.operations.reconciliation"],
                ["cdcRecoveryReady", "admin.quickBooksSetup.operations.cdcRecovery"],
              ] as const).map(([key, labelKey]) => {
                const ready = setup.operations[key];
                return (
                  <li key={key} className="flex min-h-8 items-center justify-between gap-3 text-sm">
                    <span className="text-[var(--qf-text-soft)]">{t(labelKey)}</span>
                    <span className={`inline-flex shrink-0 items-center gap-1 font-semibold ${ready ? "text-[var(--qf-success-text)]" : "text-[var(--qf-warning-text)]"}`}>
                      {ready
                        ? <IconCircleCheckFilled size={16} aria-hidden="true" />
                        : <IconAlertTriangleFilled size={16} aria-hidden="true" />}
                      {ready ? t("admin.quickBooksSetup.operations.ready") : t("admin.quickBooksSetup.operations.notReady")}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
      </details>
      </Card>
      <QuickBooksSetupGuide
        open={guideOpen}
        onClose={closeGuide}
        environment={status.environment}
        companyName={connection?.companyName}
        operations={setup.operations}
        canConnect={Boolean(primaryAction)}
        connectLabel={primaryAction?.label ?? t("admin.quickBooksSetup.connect")}
        onConnect={primaryAction?.handler ?? onConnect}
      />
    </>
  );
}
