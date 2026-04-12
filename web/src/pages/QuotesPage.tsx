import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleDot, Eye, FileText, ReceiptText, Send, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader } from "../components/ui";
import { useDashboard, formatDateTime, money } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import { api, ApiError, type Quote, type QuoteStatus } from "../lib/api";

type QuoteLifecycleStage = "DRAFT" | "COMPLETED" | "SENT" | "CLOSED" | "INVOICED";

const QUOTE_STAGE_ORDER: QuoteLifecycleStage[] = ["DRAFT", "COMPLETED", "SENT", "CLOSED", "INVOICED"];

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
    return lifecycleToneClass(stage, quote) + " shadow-sm";
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

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
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
      className={`min-w-[132px] rounded-xl border px-3 py-3 text-left transition ${
        active ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08]" : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
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
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{count}</p>
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
        <Badge tone={stage === "SENT" ? "orange" : stage === "DRAFT" ? "slate" : "emerald"} icon={lifecycleIcon(stage, quote.status)}>
          {lifecycleLabel(stage)}
        </Badge>
        <span className="truncate text-xs text-slate-500">{rawStatusHint(quote)}</span>
      </div>
    </div>
  );
}

function QuoteDesktopRow({
  quote,
  onOpenQuote,
  onPreviewPdf,
  previewing,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onPreviewPdf: (quoteId: string) => void;
  previewing: boolean;
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
        <Button size="sm" variant="outline" icon={<Eye size={14} />} loading={previewing} onClick={() => onPreviewPdf(quote.id)}>
          Preview
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
  onPreviewPdf,
  previewing,
}: {
  quote: Quote;
  onOpenQuote: (quoteId: string) => void;
  onPreviewPdf: (quoteId: string) => void;
  previewing: boolean;
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
        <Button fullWidth size="sm" variant="outline" icon={<Eye size={14} />} loading={previewing} onClick={() => onPreviewPdf(quote.id)}>
          Preview PDF
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
  const [previewingQuoteId, setPreviewingQuoteId] = useState<string | null>(null);

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

  async function previewQuotePdf(quoteId: string) {
    setPreviewingQuoteId(quoteId);
    setError(null);

    try {
      const blob = await api.quotes.downloadPdf(quoteId, { inline: true });
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
      setPreviewingQuoteId((current) => (current === quoteId ? null : current));
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotes"
        subtitle="Review quote value, lifecycle, and invoice progress from one clean board, then open the quote desk only when work is needed."
        actions={
          <>
            <Button variant="outline" onClick={() => navigateToBuilder()}>New Quote</Button>
            {selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : null}
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Awaiting response" value={String(awaitingResponseQuotes.length)} hint="Quotes still waiting on the customer" />
        <MetricCard label="Awaiting amount" value={money(awaitingAmount)} hint="Value tied up in open decisions" />
        <MetricCard label="Avg per quote" value={money(averageQuoteValue)} hint="Average total across current quotes" />
        <MetricCard label="Invoiced" value={String(invoicedQuotes.length)} hint={`${money(invoicedAmount)} synced to QuickBooks`} />
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 md:grid md:grid-cols-3 md:overflow-visible md:px-0 xl:grid-cols-6">
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
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quote board</p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Most recent quotes first</h2>
            <p className="mt-1 text-sm text-slate-600">Open the desk for edits. Use preview when you only need to verify the customer-facing PDF.</p>
          </div>
          <div className="w-full lg:w-[320px]">
            <Input
              placeholder="Search quote number, customer, or title"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
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
                  <div key={quote.id}>
                    <QuoteDesktopRow
                      quote={quote}
                      onOpenQuote={navigateToQuote}
                      onPreviewPdf={previewQuotePdf}
                      previewing={previewingQuoteId === quote.id}
                    />
                    <QuoteMobileCard
                      quote={quote}
                      onOpenQuote={navigateToQuote}
                      onPreviewPdf={previewQuotePdf}
                      previewing={previewingQuoteId === quote.id}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
