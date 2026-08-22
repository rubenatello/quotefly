import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ExternalLink, ReceiptText } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(() => defaultDueDate(timeZone));
  const commandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const sourceRef = useRef(sourceKey);
  const operationGenerationRef = useRef(0);
  if (sourceRef.current !== sourceKey) {
    sourceRef.current = sourceKey;
    operationGenerationRef.current += 1;
  }

  const operationIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      sourceRef.current === operationSource && operationGenerationRef.current === generation,
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

  useEffect(() => {
    setDueDate(defaultDueDate(timeZone));
    setInvoice(null);
    setError(null);
    setNotice(null);
    setConfirmOpen(false);
    setSaving(false);
    commandRef.current = null;
    void loadInvoice();
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [loadInvoice, sourceKey, timeZone]);

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
      setNotice(response.duplicate ? t("invoices.existingNotice") : t("invoices.createdNotice"));
      setConfirmOpen(false);
    } catch (err) {
      if (!operationIsCurrent(operationSource, generation)) return;
      setError(localizedApiError(err, t, { fallbackKey: "invoices.createError" }));
      setConfirmOpen(false);
    } finally {
      if (operationIsCurrent(operationSource, generation)) setSaving(false);
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

      {notice ? <div className="mt-4"><Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert></div> : null}
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
              <p className="mt-1 truncate text-sm font-semibold text-[var(--qf-text)]">{invoice.customer.fullName}</p>
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
    </section>
  );
}
