import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, EmptyState, Input, PageHeader, Select } from "../components/ui";
import { QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { useDashboard, money } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import type { QuoteStatus } from "../lib/api";

const STATUS_OPTIONS: Array<{ value: QuoteStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "READY_FOR_REVIEW", label: "Ready" },
  { value: "SENT_TO_CUSTOMER", label: "Sent" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "REJECTED", label: "Rejected" },
];

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
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
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | "ALL">("ALL");

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const sortedQuotes = useMemo(() => {
    return [...quotes].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [quotes]);

  const filteredQuotes = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return sortedQuotes.filter((quote) => {
      const matchesStatus = statusFilter === "ALL" || quote.status === statusFilter;
      if (!matchesStatus) return false;
      if (!normalizedSearch) return true;
      return [quoteNumber(quote.id), quote.title, quote.customer?.fullName ?? "", quote.customer?.phone ?? "", quote.customer?.email ?? ""]
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
  const acceptedQuotes = sortedQuotes.filter((quote) => quote.status === "ACCEPTED");
  const acceptedAmount = acceptedQuotes.reduce((total, quote) => total + Number(quote.totalAmount), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotes"
        subtitle="Watch quote value, status, and response load from one clean table, then open the quote desk only when needed."
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
        <MetricCard label="Accepted amount" value={money(acceptedAmount)} hint={`${acceptedQuotes.length} accepted quotes`} />
      </div>

      <Card variant="default" padding="md">
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quote board</p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Most recent quotes first</h2>
            <p className="mt-1 text-sm text-slate-600">Use the table to review pricing and status. Open the quote desk only when the quote needs work.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[260px_180px]">
            <Input
              placeholder="Search quote number, title, customer"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            <Select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")}
              options={STATUS_OPTIONS}
            />
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="px-4 py-8 text-sm text-slate-600">Loading quotes...</div>
          ) : filteredQuotes.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No quotes found" description="Adjust the search or status filter, or create a new quote." />
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[140px_minmax(0,1.3fr)_120px_120px_150px_100px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Quote No.</span>
                <span>Customer</span>
                <span>Cost</span>
                <span>Price</span>
                <span>Status</span>
                <span>Action</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredQuotes.map((quote) => (
                  <div key={quote.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[140px_minmax(0,1.3fr)_120px_120px_150px_100px] lg:items-center">
                    <div className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{quote.customer?.fullName ?? "Customer missing"}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
                    </div>
                    <div className="text-sm text-slate-700">{money(quote.internalCostSubtotal)}</div>
                    <div className="text-sm font-semibold text-slate-900">{money(quote.customerPriceSubtotal)}</div>
                    <div className="flex items-center gap-2">
                      <QuoteStatusPill status={quote.status} compact />
                    </div>
                    <div className="flex justify-start lg:justify-end">
                      <Button size="sm" variant="outline" onClick={() => navigateToQuote(quote.id)}>Open</Button>
                    </div>
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
