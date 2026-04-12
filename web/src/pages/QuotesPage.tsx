import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BadgeCheck, Calculator, CircleDot, Eye, FileText, ReceiptText, Send, Share2, XCircle } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
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

type QuoteLifecycleStage = "DRAFT" | "COMPLETED" | "SENT" | "CLOSED" | "INVOICED";
type PdfActionType = "preview" | "download" | "email" | "sms" | "native-share";

const QUOTE_STAGE_ORDER: QuoteLifecycleStage[] = ["DRAFT", "COMPLETED", "SENT", "CLOSED", "INVOICED"];

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
}

function fileLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "quote"
  );
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function buildQuoteMessageDraft(quote: Quote, customerName: string): { subject: string; body: string } {
  const subject = `${quote.title} - Quote`;
  const body = [
    `Hi ${customerName},`,
    "",
    "Thanks for the opportunity to quote this project.",
    "",
    `Quote: ${quote.title}`,
    `Total: ${money(quote.totalAmount)}`,
    "",
    "Scope:",
    quote.scopeText,
    "",
    "Reply to confirm or ask for any revisions.",
  ].join("\n");

  return { subject, body };
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

function lifecycleToneClass(stage: QuoteLifecycleStage, quote: Quote) {
  if (stage === "DRAFT") return "border-slate-200 bg-slate-50 text-slate-600";
  if (stage === "COMPLETED") return "border-quotefly-blue/15 bg-quotefly-blue/[0.05] text-quotefly-blue";
  if (stage === "SENT") return "border-quotefly-orange/15 bg-quotefly-orange/[0.06] text-quotefly-orange";
  if (stage === "CLOSED" && quote.status === "REJECTED") return "border-red-200 bg-red-50 text-red-600";
  if (stage === "CLOSED") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function lifecycleStageBadgeClass(stage: QuoteLifecycleStage, quote: Quote, active: boolean, complete: boolean) {
  if (active) {
    return `${lifecycleToneClass(stage, quote)} shadow-sm`;
  }

  if (complete) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
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

function supportsNativeFileShare(file: File) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  const checker = (navigator as Navigator & { canShare?: (data?: ShareData) => boolean }).canShare;
  if (typeof checker !== "function") return false;
  try {
    return checker.call(navigator, { files: [file] });
  } catch {
    return false;
  }
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
      ? "border-quotefly-blue/15 bg-quotefly-blue/[0.04]"
      : tone === "orange"
        ? "border-quotefly-orange/15 bg-quotefly-orange/[0.05]"
        : tone === "emerald"
          ? "border-emerald-200 bg-emerald-50/70"
          : "border-slate-200 bg-slate-50/80";
  const iconClasses =
    tone === "blue"
      ? "bg-quotefly-blue/[0.10] text-quotefly-blue"
      : tone === "orange"
        ? "bg-quotefly-orange/[0.10] text-quotefly-orange"
        : tone === "emerald"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-white text-slate-600";
  const barClasses =
    tone === "blue"
      ? "bg-quotefly-blue"
      : tone === "orange"
        ? "bg-quotefly-orange"
        : tone === "emerald"
          ? "bg-emerald-500"
          : "bg-slate-300";

  return (
    <div className={`relative overflow-hidden rounded-xl border px-4 py-3 ${toneClasses}`}>
      <div className={`absolute bottom-0 left-0 top-0 w-1 ${barClasses}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="pl-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
          <p className="mt-1.5 text-[1.65rem] font-bold tracking-tight text-slate-900">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
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
      }`}
    >
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        {stage === "ALL" ? (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 px-1 text-[10px] font-bold text-slate-500">
            All
          </span>
        ) : (
          <span
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${
              active ? "border-quotefly-blue/20 bg-white text-quotefly-blue" : "border-slate-200 bg-slate-50 text-slate-500"
            }`}
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
                className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${lifecycleStageBadgeClass(
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
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
}) {
  return (
    <div className="hidden grid-cols-[138px_minmax(0,1.3fr)_108px_108px_280px_184px] gap-4 px-4 py-3 lg:grid lg:items-center">
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
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onOpenPdfActions: (quote: Quote) => void;
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
    loadAll,
    navigateToQuote,
    navigateToBuilder,
    selectedQuoteId,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteLifecycleStage | "ALL">("ALL");
  const [pdfActionQuote, setPdfActionQuote] = useState<Quote | null>(null);
  const [pdfActionLoading, setPdfActionLoading] = useState<PdfActionType | null>(null);
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
      const objectUrl = URL.createObjectURL(blob);
      const previewWindow = window.open(objectUrl, "_blank", "noopener,noreferrer");

      if (!previewWindow) {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
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
    await loadAll();
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
      const draft = buildQuoteMessageDraft(quote, quote.customer.fullName);
      await recordOutboundAndMarkSent(quote, channel, draft);

      if (channel === "email") {
        const mailto = `mailto:${quote.customer.email ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
        window.location.assign(mailto);
        setNotice("Email app opened. Download the PDF first if you want to attach it.");
      } else {
        window.location.assign(`sms:${quote.customer.phone}?&body=${encodeURIComponent(draft.body)}`);
        setNotice("Text app opened. Download the PDF first if you want to share the file separately.");
      }
    } catch (err) {
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
      const file = new File([blob], `${fileLabel(quote.title)}.pdf`, { type: "application/pdf" });

      if (!supportsNativeFileShare(file)) {
        throw new Error("Native PDF sharing is not available on this device.");
      }

      const draft = buildQuoteMessageDraft(quote, quote.customer.fullName);
      await navigator.share({
        title: draft.subject,
        text: draft.body,
        files: [file],
      });

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
    if (!pdfActionQuote) return false;
    try {
      const testFile = new File([new Blob(["test"], { type: "application/pdf" })], "quote.pdf", { type: "application/pdf" });
      return supportsNativeFileShare(testFile);
    } catch {
      return false;
    }
  }, [pdfActionQuote]);

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
              <div className="hidden grid-cols-[138px_minmax(0,1.3fr)_108px_108px_280px_184px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Quote No.</span>
                <span>Customer</span>
                <span>Cost</span>
                <span>Price</span>
                <span>Status</span>
                <span>Action</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredQuotes.map((quote) => (
                  <div key={quote.id} className="transition-colors hover:bg-slate-50/80">
                    <QuoteDesktopRow quote={quote} onOpenQuote={navigateToQuote} onOpenPdfActions={setPdfActionQuote} />
                    <QuoteMobileCard quote={quote} onOpenQuote={navigateToQuote} onOpenPdfActions={setPdfActionQuote} />
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
                  Preview first if you want to verify the layout. Download if you want a file to attach. Email and text actions open the device apps directly.
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

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        onCreated={async ({ customer, merged, restored, intent }) => {
          await loadAll();
          setNotice(
            merged
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

