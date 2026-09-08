import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Archive, BadgeCheck, CircleDot, Download, Eye, FileText, MoreHorizontal, ReceiptText, Send, Share2, Trash2, XCircle } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PaginationControls,
  type PageSize,
} from "../components/ui";
import { useDashboard, formatDateTime, money } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import { api, type Quote, type QuoteOutboundChannel, type QuoteStatus } from "../lib/api";
import { QuickCustomerModal } from "../components/customers/QuickCustomerModal";
import { buildQuoteMessageDraft } from "../lib/quote-message-template";
import { toPhoneHrefValue } from "../lib/phone";
import {
  canNativePdfShareOnDevice,
  fileLabel,
  isLikelyMobileRuntime,
  openPdfPreviewBlob,
  sharePdfBlobNatively,
} from "../lib/quote-pdf-actions";
import { notify } from "../lib/notifications";
import i18n from "../i18n/i18n";
import { useLocale } from "../i18n";
import { localizedApiError } from "../lib/localized-api-error";

type QuoteLifecycleStage = "DRAFT" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "INVOICED";
type PdfActionType = "preview" | "download" | "email" | "sms" | "native-share";
type QuoteRetentionAction = { type: "archive" | "delete"; quote: Quote } | null;
type PreparedSend = {
  quoteId: string;
  channel: QuoteOutboundChannel;
  idempotencyKey: string;
  draft: { subject: string; body: string };
};

const QUOTE_STAGE_ORDER: QuoteLifecycleStage[] = ["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "INVOICED"];
const QUOTE_BOARD_GRID_COLUMNS =
  "xl:grid-cols-[118px_minmax(0,1.2fr)_92px_100px_190px_150px] 2xl:grid-cols-[138px_minmax(0,1.3fr)_108px_108px_240px_170px]";

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function createSendIdempotencyKey(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `quote-send:${randomId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function quoteLifecycleStage(quote: Quote): QuoteLifecycleStage {
  const syncedInvoice = quote.quickBooksInvoiceSyncs?.some(
    (sync) => sync.status === "SYNCED" && !!sync.quickBooksInvoiceId,
  );

  if (syncedInvoice) return "INVOICED";
  if (quote.status === "ACCEPTED") return "ACCEPTED";
  if (quote.status === "REJECTED") return "DECLINED";
  if (quote.status === "SENT_TO_CUSTOMER") return "SENT";
  if (quote.status === "READY_FOR_REVIEW") return "READY";
  return "DRAFT";
}

function lifecycleLabel(stage: QuoteLifecycleStage) {
  return i18n.t(`domain.quoteStage.${stage}`);
}

function lifecycleInitial(stage: QuoteLifecycleStage) {
  if (stage === "DRAFT") return "D";
  if (stage === "READY") return "R";
  if (stage === "SENT") return "S";
  if (stage === "ACCEPTED") return "A";
  if (stage === "DECLINED") return "X";
  return "I";
}

function lifecycleIcon(stage: QuoteLifecycleStage, rawStatus?: QuoteStatus) {
  if (stage === "DRAFT") return <CircleDot size={12} strokeWidth={2.2} />;
  if (stage === "READY") return <FileText size={12} strokeWidth={2.2} />;
  if (stage === "SENT") return <Send size={12} strokeWidth={2.2} />;
  if (stage === "DECLINED" || rawStatus === "REJECTED") return <XCircle size={12} strokeWidth={2.2} />;
  if (stage === "ACCEPTED") return <BadgeCheck size={12} strokeWidth={2.2} />;
  return <ReceiptText size={12} strokeWidth={2.2} />;
}

function lifecycleDarkClass(stage: QuoteLifecycleStage, rawStatus?: QuoteStatus) {
  if (stage === "DRAFT") return "border-slate-700 bg-slate-700 text-white";
  if (stage === "READY") return "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)] text-white";
  if (stage === "SENT") return "border-[var(--qf-warning-strong)] bg-[var(--qf-warning-strong)] text-white";
  if (stage === "DECLINED" || rawStatus === "REJECTED") return "border-[var(--qf-danger-strong)] bg-[var(--qf-danger-strong)] text-white";
  return "border-[var(--qf-success-strong)] bg-[var(--qf-success-strong)] text-white";
}

function rawStatusHint(quote: Quote) {
  const stage = quoteLifecycleStage(quote);

  if (stage === "INVOICED") {
    const sync = quote.quickBooksInvoiceSyncs?.[0];
    return sync?.quickBooksDocNumber ? i18n.t("quotes.hint.invoice", { number: sync.quickBooksDocNumber }) : i18n.t("quotes.hint.synced");
  }

  if (quote.status === "ACCEPTED") return i18n.t("quotes.hint.accepted");
  if (quote.status === "REJECTED") return i18n.t("quotes.hint.rejected");
  if (quote.status === "SENT_TO_CUSTOMER") return i18n.t("quotes.hint.waiting");
  if (quote.status === "READY_FOR_REVIEW") return i18n.t("quotes.hint.ready");
  return i18n.t("quotes.hint.draft");
}

function MetricCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  tone: "blue" | "orange" | "emerald" | "slate";
}) {
  const toneClasses =
    tone === "blue"
      ? "border-[#234f98] bg-[#234f98]"
      : tone === "orange"
        ? "border-[#1f2f55] bg-[#1f2f55]"
        : tone === "emerald"
          ? "border-[#17624b] bg-[#17624b]"
          : "border-[#334155] bg-[#334155]";
  const iconClasses =
    tone === "blue"
      ? "bg-white/10 text-white"
      : tone === "orange"
        ? "bg-white/10 text-white"
        : tone === "emerald"
          ? "bg-white/10 text-white"
          : "bg-white/10 text-white";
  const barClasses =
    tone === "blue"
      ? "bg-[#5b8ee8]"
      : tone === "orange"
        ? "bg-[#f2a64c]"
        : tone === "emerald"
          ? "bg-emerald-300"
          : "bg-slate-300";

  return (
    <div className={`relative overflow-hidden rounded-xl border px-3 py-3 sm:px-4 ${toneClasses}`}>
      <div className={`absolute bottom-0 left-0 top-0 w-1 ${barClasses}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="pl-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">{label}</p>
          <p className="mt-1.5 text-xl font-bold tracking-tight text-white sm:text-[1.65rem]">{value}</p>
          <p className="mt-1 hidden text-xs text-white sm:block">{hint}</p>
        </div>
        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full sm:h-10 sm:w-10 ${iconClasses}`}>
          {icon}
        </span>
      </div>
    </div>
  );
}

function StageCountCard({
  label,
  count,
  stage,
  active,
  onClick,
}: {
  label: string;
  count: number;
  stage: QuoteLifecycleStage | "ALL";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-fit rounded-full border px-3 py-2 text-left transition ${
        active
          ? "border-quotefly-blue/30 bg-[var(--qf-selected)] shadow-[0_0_0_2px_var(--qf-focus-ring)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
      } min-h-[44px]`}
      aria-pressed={active}
    >
      <div className="flex items-center gap-2">
        <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${active ? "text-[var(--qf-link)]" : "text-[var(--qf-text-muted)]"}`}>{label}</p>
        {stage === "ALL" ? (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-1 text-[10px] font-bold text-[var(--qf-text-muted)]">
            {i18n.t("domain.quoteStage.ALL")}
          </span>
        ) : (
          <span
            className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${lifecycleDarkClass(stage)}`}
          >
            {lifecycleInitial(stage)}
          </span>
        )}
        <span className="text-sm font-semibold text-[var(--qf-text)]">{count}</span>
      </div>
    </button>
  );
}

function QuoteLifecycleMini({ quote }: { quote: Quote }) {
  const stage = quoteLifecycleStage(quote);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={stage === "SENT" ? "orange" : stage === "DRAFT" ? "slate" : stage === "DECLINED" ? "red" : "emerald"} icon={lifecycleIcon(stage, quote.status)}>
        {lifecycleLabel(stage)}
      </Badge>
      <span className="truncate text-xs text-[var(--qf-text-muted)]">{rawStatusHint(quote)}</span>
    </div>
  );
}

function QuoteActionsMenu({
  quote,
  onOpenPdfActions,
  onRetentionAction,
  canManageRecordRetention,
}: {
  quote: Quote;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
  canManageRecordRetention: boolean;
}) {
  const itemClass = "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] focus:bg-[var(--qf-interactive-hover)]";

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button size="sm" variant="outline" icon={<MoreHorizontal size={15} />} aria-label={`${i18n.t("quotes.columns.actions")} ${quoteNumber(quote.id)}`}>
          {i18n.t("quotes.columns.actions")}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={8} className="qf-theme-scope z-[130] min-w-[190px] rounded-xl border border-qf-border bg-qf-surface p-1.5 text-qf-text shadow-[var(--qf-shadow-md)]">
          <DropdownMenuPrimitive.Item onSelect={() => onOpenPdfActions(quote)} className={itemClass}>
            <FileText size={14} /> {i18n.t("quotes.share")}
          </DropdownMenuPrimitive.Item>
          {canManageRecordRetention ? <DropdownMenuPrimitive.Item onSelect={() => onRetentionAction({ type: "archive", quote })} className={itemClass}>
            <Archive size={14} /> {i18n.t("quotes.archive")}
          </DropdownMenuPrimitive.Item> : null}
          {canManageRecordRetention ? <DropdownMenuPrimitive.Item onSelect={() => onRetentionAction({ type: "delete", quote })} className={`${itemClass} text-[var(--qf-danger-text)] hover:bg-[var(--qf-danger-surface)] focus:bg-[var(--qf-danger-surface)]`}>
            <Trash2 size={14} /> {i18n.t("quotes.delete")}
          </DropdownMenuPrimitive.Item> : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function QuoteDesktopRow({
  quote,
  exportSelected,
  onExportSelectedChange,
  onOpenQuote,
  onOpenPdfActions,
  onRetentionAction,
  canViewInternalCosts,
  canManageRecordRetention,
  timezone,
}: {
  quote: Quote;
  exportSelected: boolean;
  onExportSelectedChange: (quoteId: string, selected: boolean) => void;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
  canViewInternalCosts: boolean;
  canManageRecordRetention: boolean;
  timezone?: string | null;
}) {
  return (
    <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-3 px-4 py-3 xl:grid xl:items-center`}>
      <div className="flex items-center gap-2">
        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg focus-within:ring-2 focus-within:ring-[var(--qf-focus)]">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--qf-primary)]"
            checked={exportSelected}
            onChange={(event) => onExportSelectedChange(quote.id, event.target.checked)}
          />
          <span className="sr-only">{i18n.t("quotes.quickBooksCsv.selectQuote", { number: quoteNumber(quote.id) })}</span>
        </label>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-[var(--qf-text)]">{quoteNumber(quote.id)}</p>
          <p className="text-xs text-[var(--qf-text-muted)]">{i18n.t("customers.updated", { date: formatDateTime(quote.updatedAt, i18n.resolvedLanguage, timezone) })}</p>
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
            {customerInitials(quote.customer?.fullName ?? "QM")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{quote.customer?.fullName ?? i18n.t("quotes.columns.customer")}</p>
            <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">{quote.title}</p>
          </div>
        </div>
      </div>

      <div className="text-sm text-[var(--qf-text-soft)]">{canViewInternalCosts ? money(quote.internalCostSubtotal ?? 0, i18n.resolvedLanguage) : null}</div>
      <div className="text-sm font-semibold text-[var(--qf-text)]">{money(quote.customerPriceSubtotal, i18n.resolvedLanguage)}</div>

      <div className="min-w-0">
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className="flex items-center justify-end gap-2">
        <QuoteActionsMenu quote={quote} onOpenPdfActions={onOpenPdfActions} onRetentionAction={onRetentionAction} canManageRecordRetention={canManageRecordRetention} />
        <Button size="sm" onClick={() => onOpenQuote(quote.id)}>
          {i18n.t("quotes.open")}
        </Button>
      </div>
    </div>
  );
}

function QuoteMobileCard({
  quote,
  exportSelected,
  onExportSelectedChange,
  onOpenQuote,
  onOpenPdfActions,
  onRetentionAction,
  canViewInternalCosts,
  canManageRecordRetention,
}: {
  quote: Quote;
  exportSelected: boolean;
  onExportSelectedChange: (quoteId: string, selected: boolean) => void;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
  canViewInternalCosts: boolean;
  canManageRecordRetention: boolean;
}) {
  return (
    <div className="space-y-3 px-4 py-4 xl:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <label className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-within:ring-2 focus-within:ring-[var(--qf-focus)]">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--qf-primary)]"
              checked={exportSelected}
              onChange={(event) => onExportSelectedChange(quote.id, event.target.checked)}
            />
            <span className="sr-only">{i18n.t("quotes.quickBooksCsv.selectQuote", { number: quoteNumber(quote.id) })}</span>
          </label>
          <div className="min-w-0 pt-1">
          <p className="text-sm font-semibold text-[var(--qf-text)]">{quoteNumber(quote.id)}</p>
          <p className="mt-1 truncate text-sm text-[var(--qf-text-soft)]">{quote.customer?.fullName ?? i18n.t("quotes.columns.customer")}</p>
          <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">{quote.title}</p>
          </div>
        </div>
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className={`grid gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm ${canViewInternalCosts ? "grid-cols-2" : "grid-cols-1"}`}>
        {canViewInternalCosts ? <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{i18n.t("products.columns.cost")}</p>
          <p className="mt-1 text-[var(--qf-text-soft)]">{money(quote.internalCostSubtotal ?? 0, i18n.resolvedLanguage)}</p>
        </div> : null}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{i18n.t("products.columns.price")}</p>
          <p className="mt-1 font-semibold text-[var(--qf-text)]">{money(quote.customerPriceSubtotal, i18n.resolvedLanguage)}</p>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button fullWidth size="sm" onClick={() => onOpenQuote(quote.id)}>{i18n.t("quotes.open")}</Button>
        <QuoteActionsMenu quote={quote} onOpenPdfActions={onOpenPdfActions} onRetentionAction={onRetentionAction} canManageRecordRetention={canManageRecordRetention} />
      </div>
    </div>
  );
}

export function QuotesPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  usePageView("quotes");
  const {
    error,
    notice,
    setError,
    setNotice,
    loadQuotes,
    loadCustomers,
    navigateToQuote,
    navigateToBuilder,
    branding,
    canViewInternalCosts,
    canManageRecordRetention,
    exportQuotesAsInvoicesCsv,
    session,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteLifecycleStage | "ALL">("ALL");
  const [quoteItems, setQuoteItems] = useState<Quote[]>([]);
  const [quoteTotal, setQuoteTotal] = useState(0);
  const [quotePage, setQuotePage] = useState(1);
  const [quotePageSize, setQuotePageSize] = useState<PageSize>(25);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteLoadError, setQuoteLoadError] = useState<string | null>(null);
  const [quoteSummary, setQuoteSummary] = useState({
    stageCounts: { DRAFT: 0, READY: 0, SENT: 0, ACCEPTED: 0, DECLINED: 0, INVOICED: 0 } as Record<QuoteLifecycleStage, number>,
    readyToSendCount: 0,
    awaitingResponseCount: 0,
    awaitingResponseAmount: 0,
    acceptedAmount: 0,
  });
  const quoteRequestIdRef = useRef(0);
  const [pdfActionQuote, setPdfActionQuote] = useState<Quote | null>(null);
  const [pdfActionLoading, setPdfActionLoading] = useState<PdfActionType | null>(null);
  const [preparedSend, setPreparedSend] = useState<PreparedSend | null>(null);
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quoteRetentionAction, setQuoteRetentionAction] = useState<QuoteRetentionAction>(null);
  const [quoteRetentionSaving, setQuoteRetentionSaving] = useState(false);
  const [quickBooksCsvQuoteIds, setQuickBooksCsvQuoteIds] = useState<Set<string>>(() => new Set());
  const [quickBooksCsvDueInDays, setQuickBooksCsvDueInDays] = useState(14);
  const [quickBooksCsvExporting, setQuickBooksCsvExporting] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim());
      setQuotePage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchTerm]);

  const loadQuotePage = useCallback(async () => {
    const requestId = ++quoteRequestIdRef.current;
    setQuoteLoading(true);
    setQuoteLoadError(null);
    try {
      const result = await api.quotes.list({
        limit: quotePageSize,
        offset: (quotePage - 1) * quotePageSize,
        search: debouncedSearchTerm || undefined,
        stage: statusFilter === "ALL" ? undefined : statusFilter,
      });
      if (requestId !== quoteRequestIdRef.current) return;
      setQuoteItems(result.quotes);
      setQuoteTotal(result.pagination.total);
      setQuoteSummary(result.summary);
    } catch (err) {
      if (requestId !== quoteRequestIdRef.current) return;
      setQuoteLoadError(localizedApiError(err, t, { fallbackKey: "quotes.loadError" }));
    } finally {
      if (requestId === quoteRequestIdRef.current) setQuoteLoading(false);
    }
  }, [debouncedSearchTerm, quotePage, quotePageSize, statusFilter, t]);

  useEffect(() => {
    void loadQuotePage();
  }, [loadQuotePage]);

  const filteredQuotes = quoteItems;
  const stageCounts = quoteSummary.stageCounts;
  const allQuoteCount = QUOTE_STAGE_ORDER.reduce((total, stage) => total + stageCounts[stage], 0);
  const readyToSendCount = quoteSummary.readyToSendCount;
  const awaitingResponseCount = quoteSummary.awaitingResponseCount;
  const awaitingAmount = quoteSummary.awaitingResponseAmount;
  const acceptedAmount = quoteSummary.acceptedAmount;
  const totalQuotePages = Math.max(1, Math.ceil(quoteTotal / quotePageSize));
  const pageQuoteIds = useMemo(() => filteredQuotes.map((quote) => quote.id), [filteredQuotes]);
  const allPageQuotesSelected = pageQuoteIds.length > 0
    && pageQuoteIds.every((quoteId) => quickBooksCsvQuoteIds.has(quoteId));

  useEffect(() => {
    if (quotePage > totalQuotePages) setQuotePage(totalQuotePages);
  }, [quotePage, totalQuotePages]);

  const setQuickBooksCsvQuoteSelected = useCallback((quoteId: string, selected: boolean) => {
    setQuickBooksCsvQuoteIds((current) => {
      if (selected && !current.has(quoteId) && current.size >= 100) {
        setError(t("quotes.quickBooksCsv.selectionLimitReached", { count: 100 }));
        return current;
      }
      const next = new Set(current);
      if (selected) next.add(quoteId);
      else next.delete(quoteId);
      return next;
    });
  }, [setError, t]);

  const setCurrentPageQuickBooksCsvSelected = useCallback((selected: boolean) => {
    setQuickBooksCsvQuoteIds((current) => {
      const next = new Set(current);
      if (!selected) {
        for (const quoteId of pageQuoteIds) next.delete(quoteId);
        return next;
      }
      if (next.size + pageQuoteIds.filter((quoteId) => !next.has(quoteId)).length > 100) {
        setError(t("quotes.quickBooksCsv.selectionLimitReached", { count: 100 }));
        return current;
      }
      for (const quoteId of pageQuoteIds) next.add(quoteId);
      return next;
    });
  }, [pageQuoteIds, setError, t]);

  async function exportSelectedQuickBooksCsv() {
    if (quickBooksCsvExporting || quickBooksCsvQuoteIds.size === 0) return;
    setQuickBooksCsvExporting(true);
    try {
      await exportQuotesAsInvoicesCsv([...quickBooksCsvQuoteIds], { dueInDays: quickBooksCsvDueInDays });
    } finally {
      setQuickBooksCsvExporting(false);
    }
  }

  async function getPdfBlob(quoteId: string, options?: { inline?: boolean }) {
    return api.quotes.downloadPdf(quoteId, { inline: options?.inline });
  }

  async function previewQuotePdf(quote: Quote) {
    setPdfActionLoading("preview");
    setError(null);

    try {
      const blob = await getPdfBlob(quote.id, { inline: true });
      openPdfPreviewBlob(blob);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quotes.pdfError" }));
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function downloadQuotePdf(quote: Quote) {
    setPdfActionLoading("download");
    setError(null);

    try {
      const blob = await getPdfBlob(quote.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${fileLabel(quote.title)}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice(t("quotes.download"));
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quotes.pdfError" }));
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function recordOutboundAndMarkSent(quote: Quote, prepared: PreparedSend) {
    await api.quotes.confirmSend(quote.id, {
      channel: prepared.channel,
      idempotencyKey: prepared.idempotencyKey,
      destination:
        prepared.channel === "EMAIL_APP"
          ? quote.customer?.email ?? undefined
          : prepared.channel === "SMS_APP"
            ? quote.customer?.phone
            : undefined,
      subject: prepared.draft.subject,
      body: prepared.draft.body,
    });
    await Promise.all([loadQuotes(), loadQuotePage()]);
  }

  async function confirmPreparedSend(quote: Quote) {
    if (!preparedSend || preparedSend.quoteId !== quote.id) return;
    setPdfActionLoading(
      preparedSend.channel === "EMAIL_APP"
        ? "email"
        : preparedSend.channel === "SMS_APP"
          ? "sms"
          : "native-share",
    );
    setError(null);

    try {
      await recordOutboundAndMarkSent(quote, preparedSend);
      setPreparedSend(null);
      setNotice(t("quotes.send"));
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quotes.sendError" }));
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function openQuoteInApp(quote: Quote, channel: "email" | "sms") {
    if (!quote.customer) {
      setError(t("quotes.sendError"));
      return;
    }

    if (channel === "email" && !quote.customer.email) {
      setError(t("quotes.sendError"));
      return;
    }

    if (channel === "sms" && !quote.customer.phone) {
      setError(t("quotes.sendError"));
      return;
    }

    setPdfActionLoading(channel);
    setError(null);

    try {
      const draft = buildQuoteMessageDraft({
        customerName: quote.customer.fullName,
        quoteTitle: quote.title,
        quoteTotalAmount: quote.totalAmount,
        scopeText: quote.scopeText,
        branding,
        documentLocale: quote.documentLocale,
      });
      const shouldPreferAttachmentShare = channel === "email" && isLikelyMobileRuntime();

      if (shouldPreferAttachmentShare) {
        const blob = await getPdfBlob(quote.id);
        const shared = await sharePdfBlobNatively(blob, quote.title, draft);

        if (shared) {
          setPreparedSend({
            quoteId: quote.id,
            channel: "NATIVE_SHARE",
            idempotencyKey: createSendIdempotencyKey(),
            draft,
          });
          setNotice(t("quotes.confirmSendDescription"));
          return;
        }
      }

      setPreparedSend({
        quoteId: quote.id,
        channel: channel === "email" ? "EMAIL_APP" : "SMS_APP",
        idempotencyKey: createSendIdempotencyKey(),
        draft,
      });

      if (channel === "email") {
        const mailto = `mailto:${quote.customer.email ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
        window.location.assign(mailto);
        setNotice(t("quotes.confirmSendDescription"));
      } else {
        window.location.assign(`sms:${toPhoneHrefValue(quote.customer.phone)}?&body=${encodeURIComponent(draft.body)}`);
        setNotice(t("quotes.confirmSendDescription"));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(localizedApiError(err, t, { fallbackKey: "quotes.sendError" }));
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function shareQuotePdfNatively(quote: Quote) {
    if (!quote.customer) {
      setError(t("quotes.sendError"));
      return;
    }

    setPdfActionLoading("native-share");
    setError(null);

    try {
      const blob = await getPdfBlob(quote.id);
      if (!canNativePdfShareOnDevice()) {
        setError(t("quotes.nativeShareUnavailable"));
        return;
      }

      const draft = buildQuoteMessageDraft({
        customerName: quote.customer.fullName,
        quoteTitle: quote.title,
        quoteTotalAmount: quote.totalAmount,
        scopeText: quote.scopeText,
        branding,
        documentLocale: quote.documentLocale,
      });
      const shared = await sharePdfBlobNatively(blob, quote.title, draft);
      if (shared) {
        setPreparedSend({
          quoteId: quote.id,
          channel: "NATIVE_SHARE",
          idempotencyKey: createSendIdempotencyKey(),
          draft,
        });
        setNotice(t("quotes.confirmSendDescription"));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(localizedApiError(err, t, { fallbackKey: "quotes.sendError" }));
    } finally {
      setPdfActionLoading(null);
    }
  }

  const canUseNativeShare = useMemo(() => {
    return canNativePdfShareOnDevice();
  }, []);

  async function confirmQuoteRetentionAction() {
    if (!quoteRetentionAction || quoteRetentionSaving) return;

    const action = quoteRetentionAction;
    setQuoteRetentionSaving(true);
    setError(null);
    try {
      if (action.type === "archive") {
        await api.quotes.archive(action.quote.id);
        notify.success(t("quotes.archivedNotice"), {
          description: t("quotes.archiveDescription"),
        });
      } else {
        await api.quotes.delete(action.quote.id);
        notify.success(t("quotes.deletedNotice"), {
          description: t("quotes.deleteDescription"),
        });
      }
      setQuickBooksCsvQuoteIds((current) => {
        if (!current.has(action.quote.id)) return current;
        const next = new Set(current);
        next.delete(action.quote.id);
        return next;
      });
      setPdfActionQuote((current) => (current?.id === action.quote.id ? null : current));
      await Promise.all([loadQuotes(), loadQuotePage()]);
      setQuoteRetentionAction(null);
    } catch (err) {
      notify.error(t("quotes.sendError"), {
        description: localizedApiError(err, t, { fallbackKey: "quotes.actionError" }),
      });
    } finally {
      setQuoteRetentionSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
        <MetricCard
          label={t("quotes.metrics.needsAction")}
          value={String(readyToSendCount)}
          hint={t("quotes.hint.ready")}
          icon={<FileText size={18} strokeWidth={2.1} />}
          tone="blue"
        />
        <MetricCard
          label={t("quotes.hint.waiting")}
          value={String(awaitingResponseCount)}
          hint={t("quotes.hint.waiting")}
          icon={<Send size={18} strokeWidth={2.1} />}
          tone="orange"
        />
        <MetricCard
          label={t("quotes.metrics.open")}
          value={money(awaitingAmount, locale)}
          hint={t("quotes.hint.waiting")}
          icon={<ReceiptText size={18} strokeWidth={2.1} />}
          tone="slate"
        />
        <MetricCard
          label={t("quotes.metrics.accepted")}
          value={money(acceptedAmount, locale)}
          hint={t("quotes.hint.accepted")}
          icon={<BadgeCheck size={18} strokeWidth={2.1} />}
          tone="emerald"
        />
      </div>

      <div className="qf-horizontal-filter-strip -mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
        <StageCountCard label={t("domain.quoteStage.ALL")} count={allQuoteCount} stage="ALL" active={statusFilter === "ALL"} onClick={() => { setStatusFilter("ALL"); setQuotePage(1); }} />
        {QUOTE_STAGE_ORDER.map((stage) => (
          <StageCountCard
            key={stage}
            label={lifecycleLabel(stage)}
            count={stageCounts[stage]}
            stage={stage}
            active={statusFilter === stage}
            onClick={() => { setStatusFilter(stage); setQuotePage(1); }}
          />
        ))}
      </div>

      <Card variant="default" padding="md">
        <div className="flex flex-col gap-3 border-b border-[var(--qf-border)] pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quotes.board")}</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-[var(--qf-text)]">{t("quotes.boardDescription")}</h2>
          </div>
          <div className="flex w-full flex-col gap-3 lg:w-auto lg:flex-row lg:items-center">
            <div className="w-full lg:w-[300px]">
              <label htmlFor="quote-search" className="sr-only">{t("quotes.searchLabel")}</label>
              <Input
                id="quote-search"
                placeholder={t("quotes.searchPlaceholder")}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setQuickCustomerOpen(true)}>{t("customers.add")}</Button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-1 text-sm font-medium text-[var(--qf-text)] focus-within:ring-2 focus-within:ring-[var(--qf-focus)]">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--qf-primary)]"
              checked={allPageQuotesSelected}
              onChange={(event) => setCurrentPageQuickBooksCsvSelected(event.target.checked)}
              disabled={pageQuoteIds.length === 0 || quoteLoading}
            />
            <span>{t("quotes.quickBooksCsv.selectAllCurrentPage")}</span>
          </label>
          <div className="min-w-[150px] flex-1 sm:max-w-[190px]">
            <label htmlFor="quickbooks-csv-due-days" className="mb-1 block text-xs font-semibold text-[var(--qf-text-muted)]">
              {t("quotes.quickBooksCsv.dueDays")}
            </label>
            <Input
              id="quickbooks-csv-due-days"
              type="number"
              min={0}
              max={365}
              inputMode="numeric"
              value={quickBooksCsvDueInDays}
              onChange={(event) => setQuickBooksCsvDueInDays(Math.min(365, Math.max(0, Number(event.target.value) || 0)))}
            />
          </div>
          <div className="min-w-0 flex-1 sm:min-w-[260px]">
            <p className="text-sm font-semibold text-[var(--qf-text)]">
              {t("quotes.quickBooksCsv.selectedCount", { count: quickBooksCsvQuoteIds.size })}
            </p>
            <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("quotes.quickBooksCsv.help")}</p>
          </div>
          <Button
            type="button"
            className="min-h-11 sm:ml-auto"
            icon={<Download size={16} />}
            disabled={quickBooksCsvQuoteIds.size === 0}
            loading={quickBooksCsvExporting}
            onClick={() => void exportSelectedQuickBooksCsv()}
          >
            {quickBooksCsvExporting ? t("quotes.quickBooksCsv.exporting") : t("quotes.quickBooksCsv.export")}
          </Button>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
          {quoteLoading ? (
            <div className="p-4">
              <LoadingState
                title={t("quotes.loading")}
                description={t("quotes.loadingDescription")}
                variant="table"
                rows={5}
              />
            </div>
          ) : quoteLoadError ? (
            <div className="p-4">
              <EmptyState
                title={t("quotes.loadError")}
                description={quoteLoadError}
                action={<Button variant="outline" onClick={() => void loadQuotePage()}>{t("quotes.retry")}</Button>}
              />
            </div>
          ) : filteredQuotes.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={debouncedSearchTerm || statusFilter !== "ALL" ? t("quotes.noMatches") : t("quotes.empty")}
                description={debouncedSearchTerm || statusFilter !== "ALL" ? t("quotes.noMatchesDescription") : t("quotes.emptyDescription")}
                action={debouncedSearchTerm || statusFilter !== "ALL" ? <Button variant="outline" onClick={() => { setSearchTerm(""); setStatusFilter("ALL"); setQuotePage(1); }}>{t("products.clearFilters")}</Button> : <Button onClick={() => navigateToBuilder()}>{t("quotes.new")}</Button>}
              />
            </div>
          ) : (
            <>
              <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-3 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] xl:grid`}>
                <span>{t("quotes.columns.quote")}</span>
                <span>{t("quotes.columns.customer")}</span>
                <span>{canViewInternalCosts ? t("products.columns.cost") : ""}</span>
                <span>{t("products.columns.price")}</span>
                <span>{t("quotes.columns.status")}</span>
                <span className="text-right">{t("quotes.columns.actions")}</span>
              </div>
              <div className="divide-y divide-[var(--qf-border)]">
                {filteredQuotes.map((quote) => (
                  <div key={quote.id} className="transition-colors hover:bg-[var(--qf-interactive-hover)]">
                    <QuoteDesktopRow
                      quote={quote}
                      exportSelected={quickBooksCsvQuoteIds.has(quote.id)}
                      onExportSelectedChange={setQuickBooksCsvQuoteSelected}
                      onOpenQuote={navigateToQuote}
                      onOpenPdfActions={setPdfActionQuote}
                      onRetentionAction={setQuoteRetentionAction}
                      canViewInternalCosts={canViewInternalCosts}
                      canManageRecordRetention={canManageRecordRetention}
                      timezone={session?.timezone}
                    />
                    <QuoteMobileCard
                      quote={quote}
                      exportSelected={quickBooksCsvQuoteIds.has(quote.id)}
                      onExportSelectedChange={setQuickBooksCsvQuoteSelected}
                      onOpenQuote={navigateToQuote}
                      onOpenPdfActions={setPdfActionQuote}
                      onRetentionAction={setQuoteRetentionAction}
                      canViewInternalCosts={canViewInternalCosts}
                      canManageRecordRetention={canManageRecordRetention}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <PaginationControls
        limit={quotePageSize}
        offset={(quotePage - 1) * quotePageSize}
        total={quoteTotal}
        loading={quoteLoading}
        itemLabel={t("navigation.quotes").toLocaleLowerCase(locale)}
        onLimitChange={(nextLimit) => {
          setQuotePageSize(nextLimit);
          setQuotePage(1);
        }}
        onOffsetChange={(nextOffset) => setQuotePage(Math.floor(nextOffset / quotePageSize) + 1)}
      />

      {pdfActionQuote ? (
        <Modal open={true} onClose={() => { setPdfActionQuote(null); setPreparedSend(null); }} size="lg" ariaLabel={t("quotes.share")}>
          <ModalHeader
            title={t("quotes.share")}
            description={`${quoteNumber(pdfActionQuote.id)} · ${pdfActionQuote.customer?.fullName ?? t("quotes.columns.customer")}`}
            onClose={() => { setPdfActionQuote(null); setPreparedSend(null); }}
          />
          <ModalBody className="space-y-5">
            <div className="flex items-start gap-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-4">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                <FileText size={22} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--qf-text)]">{pdfActionQuote.title}</p>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{money(pdfActionQuote.totalAmount, locale)} · {lifecycleLabel(quoteLifecycleStage(pdfActionQuote))}</p>
                <p className="mt-2 text-xs text-[var(--qf-text-muted)]">
                  {t("quotes.confirmSendDescription")}
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" icon={<Eye size={14} />} loading={pdfActionLoading === "preview"} onClick={() => void previewQuotePdf(pdfActionQuote)}>
                {t("quotes.preview")}
              </Button>
              <Button variant="outline" icon={<FileText size={14} />} loading={pdfActionLoading === "download"} onClick={() => void downloadQuotePdf(pdfActionQuote)}>
                {t("quotes.download")}
              </Button>
              <Button variant="outline" icon={<Send size={14} />} loading={pdfActionLoading === "email"} onClick={() => void openQuoteInApp(pdfActionQuote, "email")}>
                {t("quotes.sendEmail")}
              </Button>
              <Button variant="outline" icon={<Send size={14} />} loading={pdfActionLoading === "sms"} onClick={() => void openQuoteInApp(pdfActionQuote, "sms")}>
                {t("quotes.sendSms")}
              </Button>
              {canUseNativeShare ? (
                <Button className="sm:col-span-2" variant="secondary" icon={<Share2 size={14} />} loading={pdfActionLoading === "native-share"} onClick={() => void shareQuotePdfNatively(pdfActionQuote)}>
                  {t("quotes.share")}
                </Button>
              ) : null}
            </div>
            {preparedSend?.quoteId === pdfActionQuote.id ? (
              <div className="rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-4">
                <p className="text-sm font-semibold text-[var(--qf-text)]">{t("quotes.confirmSendTitle")}</p>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quotes.confirmSendDescription")}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button variant="outline" onClick={() => setPreparedSend(null)} disabled={pdfActionLoading !== null}>
                    {t("quotes.share")}
                  </Button>
                  <Button onClick={() => void confirmPreparedSend(pdfActionQuote)} loading={pdfActionLoading !== null}>
                    {t("quotes.send")}
                  </Button>
                </div>
              </div>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => { setPdfActionQuote(null); setPreparedSend(null); }} disabled={pdfActionLoading !== null}>
              {t("common.close")}
            </Button>
          </ModalFooter>
        </Modal>
      ) : null}

      <ConfirmModal
        open={Boolean(quoteRetentionAction)}
        onClose={() => {
          if (!quoteRetentionSaving) setQuoteRetentionAction(null);
        }}
        onConfirm={() => void confirmQuoteRetentionAction()}
        title={quoteRetentionAction?.type === "archive" ? t("quotes.archiveTitle") : t("quotes.deleteTitle")}
        description={
          quoteRetentionAction?.type === "archive"
            ? t("quotes.archiveDescription")
            : t("quotes.deleteDescription")
        }
        confirmLabel={quoteRetentionAction?.type === "archive" ? t("quotes.archiveConfirm") : t("quotes.deleteConfirm")}
        loading={quoteRetentionSaving}
        confirmVariant={quoteRetentionAction?.type === "archive" ? "warning" : "danger"}
      />

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        onCreated={async ({ customer, merged, restored, reusedExisting, intent }) => {
          void loadCustomers();
          void merged;
          void reusedExisting;
          notify.success(restored ? t("customers.restoredNotice") : t("customers.saved"), { description: customer.fullName });
          if (intent === "quote") {
            navigateToBuilder(customer.id);
          }
        }}
      />
    </div>
  );
}
