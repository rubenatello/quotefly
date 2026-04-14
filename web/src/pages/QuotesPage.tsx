import { useMemo, useState, type ReactNode } from "react";
import { Archive, BadgeCheck, Calculator, CircleDot, Eye, FileText, ReceiptText, Send, Share2, Trash2, XCircle } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageHeader,
} from "../components/ui";
import { useDashboard, formatDateTime, money } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import { api, ApiError, type Quote, type QuoteOutboundChannel, type QuoteStatus } from "../lib/api";
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

type QuoteLifecycleStage = "DRAFT" | "COMPLETED" | "SENT" | "CLOSED" | "INVOICED";
type PdfActionType = "preview" | "download" | "email" | "sms" | "native-share";
type QuoteRetentionAction = { type: "archive" | "delete"; quote: Quote } | null;

const QUOTE_STAGE_ORDER: QuoteLifecycleStage[] = ["DRAFT", "COMPLETED", "SENT", "CLOSED", "INVOICED"];
const QUOTE_BOARD_GRID_COLUMNS = "grid-cols-[138px_minmax(0,1.3fr)_108px_108px_280px_320px]";

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

function mapSendChannelToOutboundChannel(channel: "email" | "sms" | "copy"): QuoteOutboundChannel {
  if (channel === "email") return "EMAIL_APP";
  if (channel === "sms") return "SMS_APP";
  return "COPY";
}

function quoteLifecycleStage(quote: Quote): QuoteLifecycleStage {
  const syncedInvoice = quote.quickBooksInvoiceSyncs?.some(
    (sync) => sync.status === "SYNCED" && !!sync.quickBooksInvoiceId,
  );

  if (syncedInvoice) return "INVOICED";
  if (quote.status === "ACCEPTED" || quote.status === "REJECTED") return "CLOSED";
  if (quote.status === "SENT_TO_CUSTOMER") return "SENT";
  if (quote.status === "READY_FOR_REVIEW") return "COMPLETED";
  return "DRAFT";
}

function lifecycleLabel(stage: QuoteLifecycleStage) {
  if (stage === "DRAFT") return "Draft";
  if (stage === "COMPLETED") return "Completed";
  if (stage === "SENT") return "Sent";
  if (stage === "CLOSED") return "Closed";
  return "Invoiced";
}

function lifecycleInitial(stage: QuoteLifecycleStage) {
  if (stage === "DRAFT") return "D";
  if (stage === "COMPLETED") return "C";
  if (stage === "SENT") return "S";
  if (stage === "CLOSED") return "CL";
  return "I";
}

function lifecycleIcon(stage: QuoteLifecycleStage, rawStatus?: QuoteStatus) {
  if (stage === "DRAFT") return <CircleDot size={12} strokeWidth={2.2} />;
  if (stage === "COMPLETED") return <FileText size={12} strokeWidth={2.2} />;
  if (stage === "SENT") return <Send size={12} strokeWidth={2.2} />;
  if (stage === "CLOSED" && rawStatus === "REJECTED") return <XCircle size={12} strokeWidth={2.2} />;
  if (stage === "CLOSED") return <BadgeCheck size={12} strokeWidth={2.2} />;
  return <ReceiptText size={12} strokeWidth={2.2} />;
}

function lifecycleDarkClass(stage: QuoteLifecycleStage, rawStatus?: QuoteStatus) {
  if (stage === "DRAFT") return "border-slate-700 bg-slate-700 text-white";
  if (stage === "COMPLETED") return "border-[#2559b8] bg-[#2559b8] text-white";
  if (stage === "SENT") return "border-[#d97706] bg-[#d97706] text-white";
  if (stage === "CLOSED" && rawStatus === "REJECTED") return "border-red-600 bg-red-600 text-white";
  if (stage === "CLOSED") return "border-[#2b7aa5] bg-[#2b7aa5] text-white";
  return "border-emerald-600 bg-emerald-600 text-white";
}

function lifecycleStageBadgeClass(stage: QuoteLifecycleStage, quote: Quote, active: boolean, complete: boolean) {
  if (active) {
    return `${lifecycleDarkClass(stage, quote.status)} shadow-sm`;
  }

  if (complete) {
    return `${lifecycleDarkClass(stage, quote.status)} shadow-sm`;
  }

  return "border-slate-200 bg-slate-50 text-slate-400";
}

function stageIndex(stage: QuoteLifecycleStage) {
  return QUOTE_STAGE_ORDER.indexOf(stage);
}

function rawStatusHint(quote: Quote) {
  const stage = quoteLifecycleStage(quote);

  if (stage === "INVOICED") {
    const sync = quote.quickBooksInvoiceSyncs?.[0];
    return sync?.quickBooksDocNumber ? `Invoice ${sync.quickBooksDocNumber}` : "Synced to QuickBooks";
  }

  if (quote.status === "ACCEPTED") return "Accepted by customer";
  if (quote.status === "REJECTED") return "Closed as rejected";
  if (quote.status === "SENT_TO_CUSTOMER") return "Waiting on response";
  if (quote.status === "READY_FOR_REVIEW") return "Ready to send";
  return "Still being drafted";
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
    <div className={`relative overflow-hidden rounded-xl border px-4 py-3 ${toneClasses}`}>
      <div className={`absolute bottom-0 left-0 top-0 w-1 ${barClasses}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="pl-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
          <p className="mt-1.5 text-[1.65rem] font-bold tracking-tight text-white">{value}</p>
          <p className="mt-1 text-xs text-white/70">{hint}</p>
        </div>
        <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${iconClasses}`}>
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
        active ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08]" : "border-slate-200 bg-white hover:border-slate-300"
      } min-h-[44px]`}
    >
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        {stage === "ALL" ? (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 px-1 text-[10px] font-bold text-slate-500">
            All
          </span>
        ) : (
          <span
            className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${lifecycleDarkClass(stage)}`}
          >
            {lifecycleInitial(stage)}
          </span>
        )}
        <span className="text-sm font-semibold text-slate-900">{count}</span>
      </div>
    </button>
  );
}

function QuoteLifecycleMini({ quote }: { quote: Quote }) {
  const stage = quoteLifecycleStage(quote);
  const activeIndex = stageIndex(stage);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {QUOTE_STAGE_ORDER.map((item, index) => {
          const active = index === activeIndex;
          const complete = index < activeIndex;

          return (
            <div key={item} className="flex items-center gap-1.5">
              <div
                className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${lifecycleStageBadgeClass(
                  item,
                  quote,
                  active,
                  complete,
                )}`}
                title={lifecycleLabel(item)}
                aria-label={lifecycleLabel(item)}
              >
                {lifecycleInitial(item)}
              </div>
              {index < QUOTE_STAGE_ORDER.length - 1 ? (
                <span className={`h-px w-4 rounded-full ${index < activeIndex ? "bg-emerald-300" : "bg-slate-200"}`} />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={quoteLifecycleStage(quote) === "SENT" ? "orange" : quoteLifecycleStage(quote) === "DRAFT" ? "slate" : "emerald"} icon={lifecycleIcon(quoteLifecycleStage(quote), quote.status)}>
          {lifecycleLabel(quoteLifecycleStage(quote))}
        </Badge>
        <span className="truncate text-xs text-slate-500">{rawStatusHint(quote)}</span>
      </div>
    </div>
  );
}

function QuoteDesktopRow({
  quote,
  onOpenQuote,
  onOpenPdfActions,
  onRetentionAction,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
}) {
  return (
    <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-4 px-4 py-3 lg:grid lg:items-center`}>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</p>
        <p className="text-xs text-slate-500">Updated {formatDateTime(quote.updatedAt)}</p>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
            {customerInitials(quote.customer?.fullName ?? "QM")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{quote.customer?.fullName ?? "Customer missing"}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
          </div>
        </div>
      </div>

      <div className="text-sm text-slate-700">{money(quote.internalCostSubtotal)}</div>
      <div className="text-sm font-semibold text-slate-900">{money(quote.customerPriceSubtotal)}</div>

      <div className="min-w-0">
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" icon={<FileText size={14} />} onClick={() => onOpenPdfActions(quote)}>
          PDF
        </Button>
        <Button size="sm" variant="outline" icon={<Archive size={14} />} onClick={() => onRetentionAction({ type: "archive", quote })}>
          Archive
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => onRetentionAction({ type: "delete", quote })}>
          Delete
        </Button>
        <Button size="sm" variant="outline" onClick={() => onOpenQuote(quote.id)}>
          Open
        </Button>
      </div>
    </div>
  );
}

function QuoteMobileCard({
  quote,
  onOpenQuote,
  onOpenPdfActions,
  onRetentionAction,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
}) {
  return (
    <div className="space-y-3 px-4 py-4 lg:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</p>
          <p className="mt-1 truncate text-sm text-slate-700">{quote.customer?.fullName ?? "Customer missing"}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
        </div>
        <Badge tone={quoteLifecycleStage(quote) === "SENT" ? "orange" : quoteLifecycleStage(quote) === "DRAFT" ? "slate" : "emerald"} icon={lifecycleIcon(quoteLifecycleStage(quote), quote.status)}>
          {lifecycleLabel(quoteLifecycleStage(quote))}
        </Badge>
      </div>

      <div className="rounded-xl bg-slate-50 px-3 py-3">
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cost</p>
          <p className="mt-1 text-slate-700">{money(quote.internalCostSubtotal)}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Price</p>
          <p className="mt-1 font-semibold text-slate-900">{money(quote.customerPriceSubtotal)}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button fullWidth size="sm" variant="outline" icon={<FileText size={14} />} onClick={() => onOpenPdfActions(quote)}>
          PDF
        </Button>
        <Button fullWidth size="sm" variant="outline" onClick={() => onOpenQuote(quote.id)}>
          Open
        </Button>
      </div>
      <div className="flex gap-2">
        <Button fullWidth size="sm" variant="outline" icon={<Archive size={14} />} onClick={() => onRetentionAction({ type: "archive", quote })}>
          Archive
        </Button>
        <Button fullWidth size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => onRetentionAction({ type: "delete", quote })}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export function QuotesPage() {
  usePageView("quotes");
  const {
    quotes,
    loading,
    error,
    notice,
    setError,
    setNotice,
    loadQuotes,
    loadCustomers,
    navigateToQuote,
    navigateToBuilder,
    selectedQuoteId,
    branding,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteLifecycleStage | "ALL">("ALL");
  const [pdfActionQuote, setPdfActionQuote] = useState<Quote | null>(null);
  const [pdfActionLoading, setPdfActionLoading] = useState<PdfActionType | null>(null);
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quoteRetentionAction, setQuoteRetentionAction] = useState<QuoteRetentionAction>(null);
  const [quoteRetentionSaving, setQuoteRetentionSaving] = useState(false);

  const sortedQuotes = useMemo(() => {
    return [...quotes].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [quotes]);

  const stageCounts = useMemo(() => {
    return QUOTE_STAGE_ORDER.reduce<Record<QuoteLifecycleStage, number>>((accumulator, stage) => {
      accumulator[stage] = sortedQuotes.filter((quote) => quoteLifecycleStage(quote) === stage).length;
      return accumulator;
    }, { DRAFT: 0, COMPLETED: 0, SENT: 0, CLOSED: 0, INVOICED: 0 });
  }, [sortedQuotes]);

  const filteredQuotes = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return sortedQuotes.filter((quote) => {
      const lifecycle = quoteLifecycleStage(quote);
      const matchesStatus = statusFilter === "ALL" || lifecycle === statusFilter;
      if (!matchesStatus) return false;
      if (!normalizedSearch) return true;
      return [
        quoteNumber(quote.id),
        quote.title,
        quote.customer?.fullName ?? "",
        quote.customer?.phone ?? "",
        quote.customer?.email ?? "",
        rawStatusHint(quote),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [sortedQuotes, searchTerm, statusFilter]);

  const awaitingResponseQuotes = useMemo(
    () => sortedQuotes.filter((quote) => ["READY_FOR_REVIEW", "SENT_TO_CUSTOMER"].includes(quote.status)),
    [sortedQuotes],
  );
  const awaitingAmount = awaitingResponseQuotes.reduce((total, quote) => total + Number(quote.totalAmount), 0);
  const averageQuoteValue = sortedQuotes.length
    ? sortedQuotes.reduce((total, quote) => total + Number(quote.totalAmount), 0) / sortedQuotes.length
    : 0;
  const invoicedQuotes = sortedQuotes.filter((quote) => quoteLifecycleStage(quote) === "INVOICED");
  const invoicedAmount = invoicedQuotes.reduce((total, quote) => total + Number(quote.totalAmount), 0);

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
      setError(err instanceof ApiError ? err.message : "Failed opening quote PDF preview.");
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
      setNotice("PDF downloaded.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed downloading quote PDF.");
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function recordOutboundAndMarkSent(quote: Quote, channel: "email" | "sms" | "copy", draft: { subject: string; body: string }) {
    await api.quotes.decision(quote.id, "send");
    await api.quotes.outboundEvents.create(quote.id, {
      channel: mapSendChannelToOutboundChannel(channel),
      destination: channel === "email" ? quote.customer?.email ?? undefined : channel === "sms" ? quote.customer?.phone : undefined,
      subject: draft.subject,
      body: draft.body,
    });
    await loadQuotes();
  }

  async function openQuoteInApp(quote: Quote, channel: "email" | "sms") {
    if (!quote.customer) {
      setError("This quote is missing customer information.");
      return;
    }

    if (channel === "email" && !quote.customer.email) {
      setError("This customer does not have an email address yet.");
      return;
    }

    if (channel === "sms" && !quote.customer.phone) {
      setError("This customer does not have a phone number yet.");
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
      });
      const shouldPreferAttachmentShare = isLikelyMobileRuntime();

      if (shouldPreferAttachmentShare) {
        const blob = await getPdfBlob(quote.id);
        const shared = await sharePdfBlobNatively(blob, quote.title, draft);

        if (shared) {
          await recordOutboundAndMarkSent(quote, channel, draft);
          setNotice(
            `Share sheet opened with the quote PDF attached. Choose ${channel === "email" ? "Mail" : "Messages"} to send it.`,
          );
          return;
        }
      }

      await recordOutboundAndMarkSent(quote, channel, draft);

      if (channel === "email") {
        const mailto = `mailto:${quote.customer.email ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
        window.location.assign(mailto);
        setNotice("Email app opened. This browser cannot attach the PDF automatically, so attach the downloaded file in your mail app.");
      } else {
        window.location.assign(`sms:${toPhoneHrefValue(quote.customer.phone)}?&body=${encodeURIComponent(draft.body)}`);
        setNotice("Text app opened. This browser cannot attach the PDF automatically, so attach the downloaded file in your messages app.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(err instanceof ApiError ? err.message : `Failed opening ${channel} app.`);
    } finally {
      setPdfActionLoading(null);
    }
  }

  async function shareQuotePdfNatively(quote: Quote) {
    if (!quote.customer) {
      setError("This quote is missing customer information.");
      return;
    }

    setPdfActionLoading("native-share");
    setError(null);

    try {
      const blob = await getPdfBlob(quote.id);
      if (!canNativePdfShareOnDevice()) {
        throw new Error("Native PDF sharing is not available on this device.");
      }

      const draft = buildQuoteMessageDraft({
        customerName: quote.customer.fullName,
        quoteTitle: quote.title,
        quoteTotalAmount: quote.totalAmount,
        scopeText: quote.scopeText,
        branding,
      });
      await sharePdfBlobNatively(blob, quote.title, draft);

      await recordOutboundAndMarkSent(quote, "copy", draft);
      setNotice("Native share sheet opened with the quote PDF.");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed opening share sheet.");
    } finally {
      setPdfActionLoading(null);
    }
  }

  const canUseNativeShare = useMemo(() => {
    return canNativePdfShareOnDevice();
  }, []);

  async function confirmQuoteRetentionAction() {
    if (!quoteRetentionAction || quoteRetentionSaving) return;

    setQuoteRetentionSaving(true);
    try {
      if (quoteRetentionAction.type === "archive") {
        await api.quotes.archive(quoteRetentionAction.quote.id);
        setNotice("Quote archived.");
      } else {
        await api.quotes.delete(quoteRetentionAction.quote.id);
        setNotice("Quote deleted from the active workspace.");
      }
      setPdfActionQuote((current) => (current?.id === quoteRetentionAction.quote.id ? null : current));
      await loadQuotes();
      setQuoteRetentionAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${quoteRetentionAction.type} quote.`);
    } finally {
      setQuoteRetentionSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotes"
        subtitle="Review quote value, lifecycle, and invoice progress from one clean board, then open the quote desk only when work is needed."
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Awaiting response"
          value={String(awaitingResponseQuotes.length)}
          hint="Quotes still waiting on the customer"
          icon={<Send size={18} strokeWidth={2.1} />}
          tone="orange"
        />
        <MetricCard
          label="Awaiting amount"
          value={money(awaitingAmount)}
          hint="Value tied up in open decisions"
          icon={<ReceiptText size={18} strokeWidth={2.1} />}
          tone="blue"
        />
        <MetricCard
          label="Avg per quote"
          value={money(averageQuoteValue)}
          hint="Average total across current quotes"
          icon={<Calculator size={18} strokeWidth={2.1} />}
          tone="slate"
        />
        <MetricCard
          label="Invoiced"
          value={String(invoicedQuotes.length)}
          hint={`${money(invoicedAmount)} synced to QuickBooks`}
          icon={<BadgeCheck size={18} strokeWidth={2.1} />}
          tone="emerald"
        />
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <StageCountCard label="All" count={sortedQuotes.length} stage="ALL" active={statusFilter === "ALL"} onClick={() => setStatusFilter("ALL")} />
        {QUOTE_STAGE_ORDER.map((stage) => (
          <StageCountCard
            key={stage}
            label={lifecycleLabel(stage)}
            count={stageCounts[stage]}
            stage={stage}
            active={statusFilter === stage}
            onClick={() => setStatusFilter(stage)}
          />
        ))}
      </div>

      <Card variant="default" padding="md">
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quote board</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Most recent quotes first</h2>
          </div>
          <div className="flex w-full flex-col gap-3 lg:w-auto lg:flex-row lg:items-center">
            <div className="w-full lg:w-[300px]">
              <Input
                placeholder="Search quote number, customer, or title"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setQuickCustomerOpen(true)}>Add Customer</Button>
              <Button variant="outline" onClick={() => navigateToBuilder()}>New Quote</Button>
              {selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : null}
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="px-4 py-8 text-sm text-slate-600">Loading quotes...</div>
          ) : filteredQuotes.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No quotes found" description="Adjust the search or lifecycle filter, or create a new quote." />
            </div>
          ) : (
            <>
              <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid`}>
                <span>Quote No.</span>
                <span>Customer</span>
                <span>Cost</span>
                <span>Price</span>
                <span>Status</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredQuotes.map((quote) => (
                  <div key={quote.id} className="transition-colors hover:bg-slate-50/80">
                    <QuoteDesktopRow
                      quote={quote}
                      onOpenQuote={navigateToQuote}
                      onOpenPdfActions={setPdfActionQuote}
                      onRetentionAction={setQuoteRetentionAction}
                    />
                    <QuoteMobileCard
                      quote={quote}
                      onOpenQuote={navigateToQuote}
                      onOpenPdfActions={setPdfActionQuote}
                      onRetentionAction={setQuoteRetentionAction}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      {pdfActionQuote ? (
        <Modal open={true} onClose={() => setPdfActionQuote(null)} size="lg" ariaLabel="PDF quote actions">
          <ModalHeader
            title="PDF quote actions"
            description={`${quoteNumber(pdfActionQuote.id)} · ${pdfActionQuote.customer?.fullName ?? "Customer missing"}`}
            onClose={() => setPdfActionQuote(null)}
          />
          <ModalBody className="space-y-5">
            <div className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                <FileText size={22} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{pdfActionQuote.title}</p>
                <p className="mt-1 text-sm text-slate-600">{money(pdfActionQuote.totalAmount)} · {lifecycleLabel(quoteLifecycleStage(pdfActionQuote))}</p>
                <p className="mt-2 text-xs text-slate-500">
                  Preview first if you want to verify the layout. On supported phones, Email App and Text App open the native share sheet with the PDF attached.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" icon={<Eye size={14} />} loading={pdfActionLoading === "preview"} onClick={() => void previewQuotePdf(pdfActionQuote)}>
                Preview PDF
              </Button>
              <Button variant="outline" icon={<FileText size={14} />} loading={pdfActionLoading === "download"} onClick={() => void downloadQuotePdf(pdfActionQuote)}>
                Download PDF
              </Button>
              <Button variant="outline" icon={<Send size={14} />} loading={pdfActionLoading === "email"} onClick={() => void openQuoteInApp(pdfActionQuote, "email")}>
                Email App
              </Button>
              <Button variant="outline" icon={<Send size={14} />} loading={pdfActionLoading === "sms"} onClick={() => void openQuoteInApp(pdfActionQuote, "sms")}>
                Text App
              </Button>
              {canUseNativeShare ? (
                <Button className="sm:col-span-2" variant="secondary" icon={<Share2 size={14} />} loading={pdfActionLoading === "native-share"} onClick={() => void shareQuotePdfNatively(pdfActionQuote)}>
                  Share PDF
                </Button>
              ) : null}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setPdfActionQuote(null)} disabled={pdfActionLoading !== null}>
              Close
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
        title={quoteRetentionAction?.type === "archive" ? "Archive quote?" : "Delete quote?"}
        description={
          quoteRetentionAction?.type === "archive"
            ? "This quote will leave the active workspace but remain retained in the database and audit history."
            : "This quote will leave the active workspace but remain retained in the database and audit history."
        }
        confirmLabel={quoteRetentionAction?.type === "archive" ? "Archive quote" : "Delete quote"}
        loading={quoteRetentionSaving}
        confirmVariant={quoteRetentionAction?.type === "archive" ? "primary" : "danger"}
      />

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        onCreated={async ({ customer, merged, restored, reusedExisting, intent }) => {
          await loadCustomers();
          setNotice(
            reusedExisting
              ? "Using existing customer record."
              : merged
                ? restored
                  ? "Customer merged and restored."
                  : "Customer merged into existing record."
                : restored
                  ? "Customer restored."
                  : "Customer created.",
          );
          if (intent === "quote") {
            navigateToBuilder(customer.id);
          }
        }}
      />
    </div>
  );
}
