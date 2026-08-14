import { useMemo, useState, type ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Archive, BadgeCheck, CircleDot, Eye, FileText, MoreHorizontal, ReceiptText, Send, Share2, Trash2, XCircle } from "lucide-react";
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
  if (stage === "DRAFT") return "Draft";
  if (stage === "READY") return "Ready to send";
  if (stage === "SENT") return "Sent";
  if (stage === "ACCEPTED") return "Accepted";
  if (stage === "DECLINED") return "Declined";
  return "Invoiced";
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
  if (stage === "READY") return "border-[#2559b8] bg-[#2559b8] text-white";
  if (stage === "SENT") return "border-[#d97706] bg-[#d97706] text-white";
  if (stage === "DECLINED" || rawStatus === "REJECTED") return "border-red-600 bg-red-600 text-white";
  if (stage === "ACCEPTED") return "border-[#17624b] bg-[#17624b] text-white";
  return "border-emerald-600 bg-emerald-600 text-white";
}

function rawStatusHint(quote: Quote) {
  const stage = quoteLifecycleStage(quote);

  if (stage === "INVOICED") {
    const sync = quote.quickBooksInvoiceSyncs?.[0];
    return sync?.quickBooksDocNumber ? `Invoice ${sync.quickBooksDocNumber}` : "Synced to QuickBooks";
  }

  if (quote.status === "ACCEPTED") return "Accepted by customer";
  if (quote.status === "REJECTED") return "Declined by customer";
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
    <div className={`relative overflow-hidden rounded-xl border px-3 py-3 sm:px-4 ${toneClasses}`}>
      <div className={`absolute bottom-0 left-0 top-0 w-1 ${barClasses}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="pl-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
          <p className="mt-1.5 text-xl font-bold tracking-tight text-white sm:text-[1.65rem]">{value}</p>
          <p className="mt-1 hidden text-xs text-white/70 sm:block">{hint}</p>
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={stage === "SENT" ? "orange" : stage === "DRAFT" ? "slate" : stage === "DECLINED" ? "red" : "emerald"} icon={lifecycleIcon(stage, quote.status)}>
        {lifecycleLabel(stage)}
      </Badge>
      <span className="truncate text-xs text-slate-500">{rawStatusHint(quote)}</span>
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
  const itemClass = "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50 focus:bg-slate-50";

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button size="sm" variant="outline" icon={<MoreHorizontal size={15} />} aria-label={`More actions for ${quoteNumber(quote.id)}`}>
          More
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={8} className="z-[130] min-w-[190px] rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_18px_38px_rgba(15,23,42,0.16)]">
          <DropdownMenuPrimitive.Item onSelect={() => onOpenPdfActions(quote)} className={itemClass}>
            <FileText size={14} /> Quote PDF and sharing
          </DropdownMenuPrimitive.Item>
          {canManageRecordRetention ? <DropdownMenuPrimitive.Item onSelect={() => onRetentionAction({ type: "archive", quote })} className={itemClass}>
            <Archive size={14} /> Archive quote
          </DropdownMenuPrimitive.Item> : null}
          {canManageRecordRetention ? <DropdownMenuPrimitive.Item onSelect={() => onRetentionAction({ type: "delete", quote })} className={`${itemClass} text-red-700 hover:bg-red-50 focus:bg-red-50`}>
            <Trash2 size={14} /> Delete quote
          </DropdownMenuPrimitive.Item> : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function QuoteDesktopRow({
  quote,
  onOpenQuote,
  onOpenPdfActions,
  onRetentionAction,
  canViewInternalCosts,
  canManageRecordRetention,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
  canViewInternalCosts: boolean;
  canManageRecordRetention: boolean;
}) {
  return (
    <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-3 px-4 py-3 xl:grid xl:items-center`}>
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

      <div className="text-sm text-slate-700">{canViewInternalCosts ? money(quote.internalCostSubtotal ?? 0) : null}</div>
      <div className="text-sm font-semibold text-slate-900">{money(quote.customerPriceSubtotal)}</div>

      <div className="min-w-0">
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className="flex items-center justify-end gap-2">
        <QuoteActionsMenu quote={quote} onOpenPdfActions={onOpenPdfActions} onRetentionAction={onRetentionAction} canManageRecordRetention={canManageRecordRetention} />
        <Button size="sm" onClick={() => onOpenQuote(quote.id)}>
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
  canViewInternalCosts,
  canManageRecordRetention,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
  onRetentionAction: (action: QuoteRetentionAction) => void;
  canViewInternalCosts: boolean;
  canManageRecordRetention: boolean;
}) {
  return (
    <div className="space-y-3 px-4 py-4 xl:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</p>
          <p className="mt-1 truncate text-sm text-slate-700">{quote.customer?.fullName ?? "Customer missing"}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
        </div>
        <QuoteLifecycleMini quote={quote} />
      </div>

      <div className={`grid gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm ${canViewInternalCosts ? "grid-cols-2" : "grid-cols-1"}`}>
        {canViewInternalCosts ? <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cost</p>
          <p className="mt-1 text-slate-700">{money(quote.internalCostSubtotal ?? 0)}</p>
        </div> : null}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Price</p>
          <p className="mt-1 font-semibold text-slate-900">{money(quote.customerPriceSubtotal)}</p>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button fullWidth size="sm" onClick={() => onOpenQuote(quote.id)}>Open quote</Button>
        <QuoteActionsMenu quote={quote} onOpenPdfActions={onOpenPdfActions} onRetentionAction={onRetentionAction} canManageRecordRetention={canManageRecordRetention} />
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
    branding,
    canViewCommunicationLog,
    canViewInternalCosts,
    canManageRecordRetention,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteLifecycleStage | "ALL">("ALL");
  const [pdfActionQuote, setPdfActionQuote] = useState<Quote | null>(null);
  const [pdfActionLoading, setPdfActionLoading] = useState<PdfActionType | null>(null);
  const [preparedSend, setPreparedSend] = useState<PreparedSend | null>(null);
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
    }, { DRAFT: 0, READY: 0, SENT: 0, ACCEPTED: 0, DECLINED: 0, INVOICED: 0 });
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

  const readyToSendQuotes = useMemo(() => sortedQuotes.filter((quote) => quote.status === "READY_FOR_REVIEW"), [sortedQuotes]);
  const awaitingResponseQuotes = useMemo(() => sortedQuotes.filter((quote) => quote.status === "SENT_TO_CUSTOMER"), [sortedQuotes]);
  const awaitingAmount = awaitingResponseQuotes.reduce((total, quote) => total + Number(quote.totalAmount), 0);
  const acceptedAmount = sortedQuotes
    .filter((quote) => quote.status === "ACCEPTED")
    .reduce((total, quote) => total + Number(quote.totalAmount), 0);

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
    await loadQuotes();
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
      setNotice(canViewCommunicationLog ? "Quote marked sent and the communication was logged." : "Quote marked sent.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed marking the quote sent.");
    } finally {
      setPdfActionLoading(null);
    }
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
          setNotice(
            `Share sheet completed. Confirm here after you send the quote through ${channel === "email" ? "Mail" : "Messages"}.`,
          );
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
        setNotice("Email app opened. Return here after sending to mark the quote sent.");
      } else {
        window.location.assign(`sms:${toPhoneHrefValue(quote.customer.phone)}?&body=${encodeURIComponent(draft.body)}`);
        setNotice("Text app opened with the customer's phone number. Return here after sending to mark the quote sent.");
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
      const shared = await sharePdfBlobNatively(blob, quote.title, draft);
      if (shared) {
        setPreparedSend({
          quoteId: quote.id,
          channel: "NATIVE_SHARE",
          idempotencyKey: createSendIdempotencyKey(),
          draft,
        });
        setNotice("Share sheet completed. Return here after sending to mark the quote sent.");
      }
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
        subtitle="Create, send, and follow up on every quote from one clear workspace."
        actions={<Button className="lg:hidden" onClick={() => navigateToBuilder()}>New quote</Button>}
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
        <MetricCard
          label="Ready to send"
          value={String(readyToSendQuotes.length)}
          hint="Finished quotes waiting for you"
          icon={<FileText size={18} strokeWidth={2.1} />}
          tone="blue"
        />
        <MetricCard
          label="Waiting on reply"
          value={String(awaitingResponseQuotes.length)}
          hint="Sent quotes awaiting the customer"
          icon={<Send size={18} strokeWidth={2.1} />}
          tone="orange"
        />
        <MetricCard
          label="Open quote value"
          value={money(awaitingAmount)}
          hint="Sent value still awaiting a decision"
          icon={<ReceiptText size={18} strokeWidth={2.1} />}
          tone="slate"
        />
        <MetricCard
          label="Won quote value"
          value={money(acceptedAmount)}
          hint="Value accepted by customers"
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
              <label htmlFor="quote-search" className="sr-only">Search quotes</label>
              <Input
                id="quote-search"
                placeholder="Search quote number, customer, or title"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setQuickCustomerOpen(true)}>Add customer</Button>
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="p-4">
              <LoadingState
                title="Loading quotes"
                description="Building the quote board with current status, customer, PDF, and accounting context."
                variant="table"
                rows={5}
              />
            </div>
          ) : filteredQuotes.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={sortedQuotes.length ? "No matching quotes" : "Create your first quote"}
                description={sortedQuotes.length ? "Clear the search or choose another status." : "Add a customer and build a professional quote in minutes."}
                action={sortedQuotes.length ? <Button variant="outline" onClick={() => { setSearchTerm(""); setStatusFilter("ALL"); }}>Clear filters</Button> : <Button onClick={() => navigateToBuilder()}>New quote</Button>}
              />
            </div>
          ) : (
            <>
              <div className={`hidden ${QUOTE_BOARD_GRID_COLUMNS} gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 xl:grid`}>
                <span>Quote No.</span>
                <span>Customer</span>
                <span>{canViewInternalCosts ? "Cost" : ""}</span>
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
                      canViewInternalCosts={canViewInternalCosts}
                      canManageRecordRetention={canManageRecordRetention}
                    />
                    <QuoteMobileCard
                      quote={quote}
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

      {pdfActionQuote ? (
        <Modal open={true} onClose={() => { setPdfActionQuote(null); setPreparedSend(null); }} size="lg" ariaLabel="PDF quote actions">
          <ModalHeader
            title="PDF quote actions"
            description={`${quoteNumber(pdfActionQuote.id)} · ${pdfActionQuote.customer?.fullName ?? "Customer missing"}`}
            onClose={() => { setPdfActionQuote(null); setPreparedSend(null); }}
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
                  Preview first to verify the layout. Email quote can share the PDF on supported phones; Text quote opens Messages with the customer's number and message filled in.
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
                Email quote
              </Button>
              <Button variant="outline" icon={<Send size={14} />} loading={pdfActionLoading === "sms"} onClick={() => void openQuoteInApp(pdfActionQuote, "sms")}>
                Text quote
              </Button>
              {canUseNativeShare ? (
                <Button className="sm:col-span-2" variant="secondary" icon={<Share2 size={14} />} loading={pdfActionLoading === "native-share"} onClick={() => void shareQuotePdfNatively(pdfActionQuote)}>
                  Share PDF
                </Button>
              ) : null}
            </div>
            {preparedSend?.quoteId === pdfActionQuote.id ? (
              <div className="rounded-2xl border border-quotefly-blue/20 bg-quotefly-blue/[0.06] px-4 py-4">
                <p className="text-sm font-semibold text-slate-900">Did you send it?</p>
                <p className="mt-1 text-sm text-slate-600">QuoteFly has not changed the status yet. Confirm only after the message leaves your phone.</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button variant="outline" onClick={() => setPreparedSend(null)} disabled={pdfActionLoading !== null}>
                    Share Again
                  </Button>
                  <Button onClick={() => void confirmPreparedSend(pdfActionQuote)} loading={pdfActionLoading !== null}>
                    Yes, Mark Sent
                  </Button>
                </div>
              </div>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => { setPdfActionQuote(null); setPreparedSend(null); }} disabled={pdfActionLoading !== null}>
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
        confirmVariant={quoteRetentionAction?.type === "archive" ? "warning" : "danger"}
      />

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        onCreated={async ({ customer, merged, restored, reusedExisting, intent }) => {
          void loadCustomers();
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
