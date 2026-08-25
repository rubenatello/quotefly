import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ExternalLink, FileCheck2, ReceiptText, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { money, useDashboard } from "../dashboard/DashboardContext";
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  Input,
  LoadingState,
} from "../ui";
import {
  api,
  type Invoice,
  type InvoicePaymentStatus,
  type InvoiceStatus,
  type QuickBooksInvoiceOperationStatus,
  type QuickBooksInvoiceSyncPreview,
} from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import { tenantWallTimeToIso, toTenantDateTimeInput, validTimeZone } from "../../lib/tenant-time";

type InvoicePanelProps = {
  jobId?: string;
  sourceQuoteId?: string;
  sourceLabel: string;
  sourceAmount: string | number;
  canCreate: boolean;
  createBlockedReason?: string | null;
};

function addCalendarDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function defaultDueDate(timeZone: string) {
  return addCalendarDays(toTenantDateTimeInput(new Date(), timeZone).slice(0, 10), 30);
}

function formatInvoiceDate(value: string, locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(new Date(value));
}

function invoiceStatusTone(status: InvoiceStatus): "slate" | "blue" | "emerald" | "red" | "amber" {
  if (status === "PAID") return "emerald";
  if (status === "OPEN") return "blue";
  if (status === "VOID") return "red";
  if (status === "UNCOLLECTIBLE") return "amber";
  return "slate";
}

function paymentStatusTone(status: InvoicePaymentStatus): "slate" | "emerald" | "red" | "amber" {
  if (status === "SUCCEEDED") return "emerald";
  if (status === "FAILED" || status === "CANCELED") return "red";
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return "amber";
  return "slate";
}

function quickBooksStatusTone(status: QuickBooksInvoiceOperationStatus): "slate" | "blue" | "emerald" | "red" | "amber" {
  if (status === "SUCCEEDED") return "emerald";
  if (status === "FAILED") return "red";
  if (status === "RECONCILIATION_REQUIRED") return "amber";
  if (status === "PROCESSING" || status === "RECONCILING") return "blue";
  return "slate";
}

export function InvoicePanel({
  jobId,
  sourceQuoteId,
  sourceLabel,
  sourceAmount,
  canCreate,
  createBlockedReason,
}: InvoicePanelProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { session } = useDashboard();
  const headingId = useId();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const timeZone = validTimeZone(session?.timezone ?? "UTC");
  const sourceKey = jobId ? `job:${jobId}` : sourceQuoteId ? `quote:${sourceQuoteId}` : "missing";
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [quickBooksConfirmOpen, setQuickBooksConfirmOpen] = useState(false);
  const [quickBooksPreview, setQuickBooksPreview] = useState<QuickBooksInvoiceSyncPreview | null>(null);
  const [quickBooksEnabled, setQuickBooksEnabled] = useState(false);
  const [quickBooksLoading, setQuickBooksLoading] = useState(false);
  const [quickBooksSaving, setQuickBooksSaving] = useState(false);
  const [quickBooksError, setQuickBooksError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "warning" } | null>(null);
  const [dueDate, setDueDate] = useState(() => defaultDueDate(timeZone));
  const commandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const sourceRef = useRef(sourceKey);
  const operationGenerationRef = useRef(0);
  const quickBooksGenerationRef = useRef(0);
  const quickBooksOperationGenerationRef = useRef(0);
  const quickBooksCommandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  if (sourceRef.current !== sourceKey) {
    sourceRef.current = sourceKey;
    operationGenerationRef.current += 1;
    quickBooksGenerationRef.current += 1;
    quickBooksOperationGenerationRef.current += 1;
  }

  const operationIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      sourceRef.current === operationSource && operationGenerationRef.current === generation,
    [],
  );

  const quickBooksOperationIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      sourceRef.current === operationSource && quickBooksOperationGenerationRef.current === generation,
    [],
  );

  const loadInvoice = useCallback(async () => {
    const operationSource = sourceKey;
    const generation = ++operationGenerationRef.current;
    if (!jobId && !sourceQuoteId) {
      if (operationIsCurrent(operationSource, generation)) {
        setLoading(false);
        setInvoice(null);
      }
      return;
    }
    setLoading(true);
    setInvoice(null);
    setError(null);
    try {
      const response = await api.invoices.list({
        jobId,
        sourceQuoteId,
        limit: 1,
        offset: 0,
      });
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(response.items[0] ?? null);
    } catch (err) {
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(null);
      setError(localizedApiError(err, t, { fallbackKey: "invoices.loadError" }));
    } finally {
      if (operationIsCurrent(operationSource, generation)) setLoading(false);
    }
  }, [jobId, operationIsCurrent, sourceKey, sourceQuoteId, t]);

  const loadQuickBooksPreview = useCallback(async (
    currentInvoice: Invoice,
    options: { clearError?: boolean } = {},
  ) => {
    const generation = ++quickBooksGenerationRef.current;
    setQuickBooksLoading(true);
    if (options.clearError !== false) setQuickBooksError(null);
    try {
      const response = await api.integrations.quickbooks.invoiceSyncPreview(currentInvoice.id);
      if (generation !== quickBooksGenerationRef.current) return;
      setQuickBooksEnabled(response.providerWorkflowsEnabled);
      setQuickBooksPreview(response.preview);
    } catch (err) {
      if (generation !== quickBooksGenerationRef.current) return;
      setQuickBooksPreview(null);
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.loadError" }));
    } finally {
      if (generation === quickBooksGenerationRef.current) setQuickBooksLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setDueDate(defaultDueDate(timeZone));
    setInvoice(null);
    setError(null);
    setNotice(null);
    setConfirmOpen(false);
    setQuickBooksConfirmOpen(false);
    setSaving(false);
    setQuickBooksPreview(null);
    setQuickBooksError(null);
    setQuickBooksSaving(false);
    commandRef.current = null;
    quickBooksCommandRef.current = null;
    quickBooksGenerationRef.current += 1;
    quickBooksOperationGenerationRef.current += 1;
    void loadInvoice();
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [loadInvoice, sourceKey, timeZone]);

  useEffect(() => {
    if (!invoice || !canCreate) return;
    void loadQuickBooksPreview(invoice);
    return () => {
      quickBooksGenerationRef.current += 1;
    };
  }, [canCreate, invoice, loadQuickBooksPreview]);

  const dueAtUtc = useMemo(
    () => dueDate ? tenantWallTimeToIso(`${dueDate}T12:00`, timeZone) : null,
    [dueDate, timeZone],
  );

  const handleCreate = async () => {
    if (saving || !canCreate || createBlockedReason || (!jobId && !sourceQuoteId)) return;
    if (!dueAtUtc) {
      setError(t("invoices.invalidDueDate"));
      setConfirmOpen(false);
      return;
    }

    const payload = {
      ...(jobId ? { jobId } : { sourceQuoteId }),
      dueAtUtc,
    };
    const fingerprint = JSON.stringify(payload);
    if (!commandRef.current || commandRef.current.fingerprint !== fingerprint) {
      commandRef.current = { fingerprint, key: `qf-invoice-${crypto.randomUUID()}` };
    }
    const operationSource = sourceKey;
    const generation = ++operationGenerationRef.current;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.invoices.create(payload, commandRef.current.key);
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(response.invoice);
      setNotice({
        message: response.duplicate ? t("invoices.existingNotice") : t("invoices.createdNotice"),
        tone: "success",
      });
      setConfirmOpen(false);
    } catch (err) {
      if (!operationIsCurrent(operationSource, generation)) return;
      setError(localizedApiError(err, t, { fallbackKey: "invoices.createError" }));
      setConfirmOpen(false);
    } finally {
      if (operationIsCurrent(operationSource, generation)) setSaving(false);
    }
  };

  const handleQuickBooksPublish = async () => {
    if (
      !invoice
      || !quickBooksPreview?.ready
      || !quickBooksPreview.reviewBinding
      || !quickBooksEnabled
      || quickBooksSaving
    ) return;
    const reviewedPreview = quickBooksPreview;
    const reviewBinding = reviewedPreview.reviewBinding;
    if (!reviewBinding) return;
    const fingerprint = `${reviewedPreview.invoice.id}:${reviewedPreview.invoice.version}:${reviewBinding}`;
    if (!quickBooksCommandRef.current || quickBooksCommandRef.current.fingerprint !== fingerprint) {
      quickBooksCommandRef.current = {
        fingerprint,
        key: `qf-quickbooks-invoice-${crypto.randomUUID()}`,
      };
    }
    const operationSource = sourceKey;
    const generation = ++quickBooksOperationGenerationRef.current;
    setQuickBooksSaving(true);
    setQuickBooksError(null);
    setNotice(null);
    try {
      const response = await api.integrations.quickbooks.publishQuoteFlyInvoice(
        reviewedPreview.invoice.id,
        {
          invoiceVersion: reviewedPreview.invoice.version,
          reviewBinding,
        },
        quickBooksCommandRef.current.key,
      );
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      setQuickBooksPreview((current) => current ? { ...current, operation: response.operation } : current);
      setQuickBooksConfirmOpen(false);
    } catch (err) {
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      const message = localizedApiError(err, t, {
        fallbackKey: "invoices.quickBooks.publishError",
        codeKeys: {
          INVOICE_VERSION_CONFLICT: "invoices.quickBooks.versionConflict",
          QUICKBOOKS_REVIEW_STALE: "invoices.quickBooks.reviewStale",
        },
      });
      setQuickBooksConfirmOpen(false);
      await loadQuickBooksPreview(invoice, { clearError: false });
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksError(message);
    } finally {
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksSaving(false);
    }
  };

  const handleQuickBooksReconcile = async () => {
    if (!invoice || quickBooksSaving) return;
    const operationSource = sourceKey;
    const generation = ++quickBooksOperationGenerationRef.current;
    setQuickBooksSaving(true);
    setQuickBooksError(null);
    setNotice(null);
    try {
      const response = await api.integrations.quickbooks.reconcileQuoteFlyInvoice(invoice.id);
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      setQuickBooksPreview((current) => current ? { ...current, operation: response.operation } : current);
    } catch (err) {
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      const message = localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.reconcileError" });
      await loadQuickBooksPreview(invoice, { clearError: false });
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksError(message);
    } finally {
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="invoice-panel"
      className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)] sm:p-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("invoices.eyebrow")}</p>
          <h2 id={headingId} className="mt-1 flex items-center gap-2 text-base font-semibold text-[var(--qf-text)]">
            <ReceiptText size={18} aria-hidden="true" />
            {invoice ? t("invoices.number", { number: invoice.invoiceNumber }) : t("invoices.title")}
          </h2>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {invoice
              ? t("invoices.recordDescription")
              : sourceQuoteId
                ? t("invoices.quoteDescription")
                : t("invoices.jobDescription")}
          </p>
        </div>
        {invoice ? (
          <div className="flex flex-wrap gap-2">
            <Badge tone={invoiceStatusTone(invoice.status)}>{t(`domain.invoiceStatus.${invoice.status}`)}</Badge>
            <Badge tone={paymentStatusTone(invoice.paymentStatus)}>{t(`domain.invoicePaymentStatus.${invoice.paymentStatus}`)}</Badge>
          </div>
        ) : null}
      </div>

      {notice ? (
        <div className="mt-4">
          <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.message}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mt-4">
          <Alert tone="error" onDismiss={() => setError(null)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              {!invoice ? <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadInvoice()}>{t("invoices.retry")}</Button> : null}
            </div>
          </Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="mt-4"><LoadingState variant="compact" title={t("invoices.loading")} /></div>
      ) : invoice ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.customer")}</p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">{invoice.customer.fullName}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.total")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{money(invoice.totalAmount, locale)}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.balance")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{money(invoice.balanceDue, locale)}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.due")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">
                {invoice.dueAtUtc ? formatInvoiceDate(invoice.dueAtUtc, locale, timeZone) : t("invoices.noDueDate")}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-[var(--qf-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-[var(--qf-text-muted)]">{t("invoices.providerBoundary")}</p>
            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              {!jobId ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => navigate(`/app/jobs/${invoice.job.id}`)}>
                  <ExternalLink size={15} aria-hidden="true" />
                  {t("invoices.openJob", { number: invoice.job.jobNumber })}
                </Button>
              ) : null}
              {!sourceQuoteId ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => navigate(`/app/quotes/${invoice.sourceQuote.id}`)}>
                  <ExternalLink size={15} aria-hidden="true" />
                  {t("invoices.openQuote")}
                </Button>
              ) : null}
            </div>
          </div>
          {canCreate ? (
            <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4" data-testid="quickbooks-invoice-panel">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
                    <FileCheck2 size={17} aria-hidden="true" />
                    {t("invoices.quickBooks.title")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">
                    {t("invoices.quickBooks.description")}
                  </p>
                </div>
                {quickBooksPreview?.operation ? (
                  <Badge tone={quickBooksStatusTone(quickBooksPreview.operation.status)}>
                    {t(`invoices.quickBooks.status.${quickBooksPreview.operation.status}`)}
                  </Badge>
                ) : null}
              </div>

              {quickBooksError ? (
                <div className="mt-3">
                  <Alert tone="error" onDismiss={() => setQuickBooksError(null)}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span>{quickBooksError}</span>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => invoice && void loadQuickBooksPreview(invoice)}>
                        {t("invoices.retry")}
                      </Button>
                    </div>
                  </Alert>
                </div>
              ) : null}

              {quickBooksLoading ? (
                <div className="mt-3"><LoadingState variant="compact" title={t("invoices.quickBooks.loading")} /></div>
              ) : quickBooksPreview ? (
                <div className="mt-3 space-y-3">
                  {!quickBooksEnabled ? <Alert tone="info">{t("invoices.quickBooks.paused")}</Alert> : null}
                  {quickBooksPreview.operation?.status === "SUCCEEDED" ? (
                    <Alert tone="success">{t("invoices.quickBooks.success", { number: quickBooksPreview.providerDocNumber })}</Alert>
                  ) : quickBooksPreview.operation?.status === "RECONCILIATION_REQUIRED" ? (
                    <Alert tone="warning">{t("invoices.quickBooks.reconciliationRequired")}</Alert>
                  ) : quickBooksPreview.operation?.status === "FAILED" ? (
                    <Alert tone="error">{t("invoices.quickBooks.failed")}</Alert>
                  ) : quickBooksPreview.operation ? (
                    <Alert tone="info">{t("invoices.quickBooks.inProgress")}</Alert>
                  ) : quickBooksPreview.blockers.length ? (
                    <div>
                      <p className="text-xs font-semibold text-[var(--qf-text-soft)]">{t("invoices.quickBooks.setupNeeded")}</p>
                      <ul className="mt-2 space-y-1 text-xs text-[var(--qf-text-muted)]">
                        {quickBooksPreview.blockers.map((blocker) => (
                          <li key={blocker}>• {t(`invoices.quickBooks.blockers.${blocker}`)}</li>
                        ))}
                      </ul>
                      <Button type="button" variant="outline" className="mt-3 min-h-11" onClick={() => navigate("/app/settings")}>
                        {t("invoices.quickBooks.openSettings")}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--qf-text-muted)]">
                      {t("invoices.quickBooks.ready", {
                        company: quickBooksPreview.connection?.companyName || t("invoices.quickBooks.connectedCompany"),
                        number: quickBooksPreview.providerDocNumber,
                      })}
                    </p>
                  )}

                  {quickBooksEnabled && quickBooksPreview.operation?.reconciliationAvailable ? (
                    <Button type="button" variant="outline" className="min-h-11" loading={quickBooksSaving} onClick={() => void handleQuickBooksReconcile()}>
                      <RefreshCw size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.reconcile")}
                    </Button>
                  ) : quickBooksEnabled && quickBooksPreview.ready && !quickBooksPreview.operation ? (
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => setQuickBooksConfirmOpen(true)}>
                      <FileCheck2 size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.review")}
                    </Button>
                  ) : quickBooksPreview.operation?.status === "PROCESSING" || quickBooksPreview.operation?.status === "RECONCILING" ? (
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadQuickBooksPreview(invoice)}>
                      <RefreshCw size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.refreshStatus")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)] p-4">
          {canCreate && createBlockedReason ? (
            <Alert tone="warning">{createBlockedReason}</Alert>
          ) : canCreate ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(200px,.4fr)_minmax(0,1fr)_auto] lg:items-end">
              <Input
                type="date"
                label={t("invoices.dueDate")}
                value={dueDate}
                min={toTenantDateTimeInput(new Date(), timeZone).slice(0, 10)}
                onChange={(event) => {
                  setDueDate(event.target.value);
                  setError(null);
                }}
              />
              <p className="text-sm leading-6 text-[var(--qf-text-soft)]">{t("invoices.createHelp")}</p>
              <Button type="button" className="min-h-11" disabled={!dueAtUtc} onClick={() => setConfirmOpen(true)}>
                <ReceiptText size={16} aria-hidden="true" />
                {t("invoices.create")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-[var(--qf-text-soft)]">{t("invoices.waiting")}</p>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleCreate()}
        title={t("invoices.confirmTitle")}
        description={t("invoices.confirmDescription", {
          source: sourceLabel,
          amount: money(sourceAmount, locale),
        })}
        confirmLabel={t("invoices.confirmCreate")}
        confirmVariant="primary"
        loading={saving}
      >
        <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[var(--qf-text-muted)]">
              <CalendarDays size={15} aria-hidden="true" />
              {t("invoices.due")}
            </span>
            <span className="font-semibold text-[var(--qf-text)]">
              {dueAtUtc ? formatInvoiceDate(dueAtUtc, locale, timeZone) : t("invoices.noDueDate")}
            </span>
          </div>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={quickBooksConfirmOpen}
        onClose={() => setQuickBooksConfirmOpen(false)}
        onConfirm={() => void handleQuickBooksPublish()}
        title={t("invoices.quickBooks.confirmTitle")}
        description={t("invoices.quickBooks.confirmDescription")}
        confirmLabel={t("invoices.quickBooks.publish")}
        confirmVariant="primary"
        loading={quickBooksSaving}
        size="md"
      >
        {quickBooksPreview ? (
          <div className="space-y-3 rounded-xl bg-[var(--qf-panel-muted)] p-3 text-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.destination")}</span>
              <span className="break-words text-right font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">
                {quickBooksPreview.connection?.companyName || t("invoices.quickBooks.connectedCompany")}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.customer")}</span>
              <span className="min-w-0 break-words text-right font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">
                {quickBooksPreview.invoice.customerName}
                {quickBooksPreview.quickBooksCustomerName ? (
                  <small className="mt-1 block font-normal text-[var(--qf-text-muted)]">
                    {t("invoices.quickBooks.mapsTo", { target: quickBooksPreview.quickBooksCustomerName })}
                  </small>
                ) : null}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.documentNumber")}</span>
              <span className="font-semibold text-[var(--qf-text)]">{quickBooksPreview.providerDocNumber}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.due")}</span>
              <span className="font-semibold text-[var(--qf-text)]">
                {quickBooksPreview.invoice.dueAtUtc
                  ? formatInvoiceDate(quickBooksPreview.invoice.dueAtUtc, locale, timeZone)
                  : t("invoices.noDueDate")}
              </span>
            </div>
            <div className="space-y-2 border-t border-[var(--qf-border)] pt-3">
              {quickBooksPreview.lineItems.map((line, index) => (
                <div key={`${line.description}:${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <span className="min-w-0 break-words text-[var(--qf-text-soft)] [overflow-wrap:anywhere]">
                    {line.description}
                    {line.quickBooksItemName ? (
                      <small className="mt-1 block text-[var(--qf-text-muted)]">
                        {t("invoices.quickBooks.mapsTo", { target: line.quickBooksItemName })}
                      </small>
                    ) : null}
                    <small className="mt-1 block text-[var(--qf-text-muted)]">
                      {t("invoices.quickBooks.lineMath", {
                        quantity: line.quantity,
                        unitPrice: money(line.unitPrice, locale),
                      })}
                    </small>
                  </span>
                  <span className="shrink-0 font-medium text-[var(--qf-text)]">{money(line.amount, locale)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-[var(--qf-border)] pt-3">
              <span className="font-semibold text-[var(--qf-text)]">{t("invoices.total")}</span>
              <span className="font-semibold text-[var(--qf-text)]">{money(quickBooksPreview.invoice.totalAmount, locale)}</span>
            </div>
          </div>
        ) : null}
      </ConfirmModal>
    </section>
  );
}
