import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import type { Customer, Quote } from "../lib/api";

type CustomerStage = "NEW" | "CONTACTED" | "QUOTED" | "WORKING" | "SOLD";

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "QUOTED", "WORKING", "SOLD"];

function stageLabel(stage: CustomerStage) {
  if (stage === "NEW") return "New";
  if (stage === "CONTACTED") return "Contacted";
  if (stage === "QUOTED") return "Quoted";
  if (stage === "WORKING") return "Working";
  return "Sold";
}

function quoteNumber(quoteId: string) {
  return `QF-${quoteId.slice(0, 8).toUpperCase()}`;
}

function getLatestQuoteMap(quotes: Quote[]) {
  const sorted = [...quotes].sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });

  const map = new Map<string, Quote>();
  for (const quote of sorted) {
    if (!map.has(quote.customerId)) {
      map.set(quote.customerId, quote);
    }
  }
  return map;
}

function getCustomerStage(customer: Customer, latestQuote?: Quote | null): CustomerStage {
  if (latestQuote?.status === "ACCEPTED") {
    if (latestQuote.jobStatus === "COMPLETED" || latestQuote.afterSaleFollowUpStatus !== "NOT_READY") {
      return "SOLD";
    }
    return "WORKING";
  }

  if (latestQuote && ["SENT_TO_CUSTOMER", "READY_FOR_REVIEW"].includes(latestQuote.status)) {
    return "QUOTED";
  }

  if (customer.followUpStatus === "FOLLOWED_UP") {
    return "CONTACTED";
  }

  return "NEW";
}

function stageIndex(stage: CustomerStage) {
  return CUSTOMER_STAGE_ORDER.indexOf(stage);
}

function CustomerStageProgress({ stage }: { stage: CustomerStage }) {
  const activeIndex = stageIndex(stage);

  return (
    <div className="flex flex-wrap gap-1.5">
      {CUSTOMER_STAGE_ORDER.map((item, index) => {
        const active = index === activeIndex;
        const complete = index < activeIndex;
        return (
          <span
            key={item}
            className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              active
                ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                : complete
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-white text-slate-400"
            }`}
          >
            {stageLabel(item)}
          </span>
        );
      })}
    </div>
  );
}

function StageCountCard({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-3 text-left transition ${
        active ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08]" : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{count}</p>
    </button>
  );
}

export function CustomersPage() {
  usePageView("customers");
  const {
    customers,
    quotes,
    loading,
    error,
    notice,
    setError,
    setNotice,
    loadAll,
    navigateToQuote,
    navigateToBuilder,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [stageFilter, setStageFilter] = useState<CustomerStage | "ALL">("ALL");

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const latestQuoteByCustomer = useMemo(() => getLatestQuoteMap(quotes), [quotes]);

  const customerRows = useMemo(() => {
    return customers
      .map((customer) => {
        const latestQuote = latestQuoteByCustomer.get(customer.id) ?? null;
        const stage = getCustomerStage(customer, latestQuote);
        return {
          customer,
          latestQuote,
          stage,
        };
      })
      .sort((left, right) => new Date(right.customer.updatedAt).getTime() - new Date(left.customer.updatedAt).getTime());
  }, [customers, latestQuoteByCustomer]);

  const stageCounts = useMemo(() => {
    return CUSTOMER_STAGE_ORDER.reduce<Record<CustomerStage, number>>((accumulator, stage) => {
      accumulator[stage] = customerRows.filter((row) => row.stage === stage).length;
      return accumulator;
    }, { NEW: 0, CONTACTED: 0, QUOTED: 0, WORKING: 0, SOLD: 0 });
  }, [customerRows]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return customerRows.filter((row) => {
      const matchesStage = stageFilter === "ALL" || row.stage === stageFilter;
      if (!matchesStage) return false;
      if (!normalizedSearch) return true;

        const haystack = [
          row.customer.fullName,
          row.customer.phone,
          row.customer.email ?? "",
          row.latestQuote?.title ?? "",
          row.latestQuote ? quoteNumber(row.latestQuote.id) : "",
        ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [customerRows, searchTerm, stageFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        subtitle="Track customers through a simple sales pipeline, then jump into quoting when they are ready."
        actions={<Button onClick={() => navigateToBuilder()}>New Quote</Button>}
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StageCountCard label="All" count={customerRows.length} active={stageFilter === "ALL"} onClick={() => setStageFilter("ALL")} />
        {CUSTOMER_STAGE_ORDER.map((stage) => (
          <StageCountCard
            key={stage}
            label={stageLabel(stage)}
            count={stageCounts[stage]}
            active={stageFilter === stage}
            onClick={() => setStageFilter(stage)}
          />
        ))}
      </div>

      <Card variant="default" padding="md">
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer board</p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Most recent customers first</h2>
            <p className="mt-1 text-sm text-slate-600">Use this as the operating table. Open quotes when they exist, or start a new one when they do not.</p>
          </div>
          <div className="w-full lg:w-[320px]">
            <Input
              placeholder="Search customer name, phone, email, or quote"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="px-4 py-8 text-sm text-slate-600">Loading customers...</div>
          ) : filteredRows.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No customers found" description="Adjust the search or stage filter, or add a new customer from the quote builder." />
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,1.4fr)_160px_220px_320px_120px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Customer</span>
                <span>Phone</span>
                <span>Email</span>
                <span>Pipeline</span>
                <span>Action</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredRows.map(({ customer, latestQuote, stage }) => (
                  <div key={customer.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.4fr)_160px_220px_320px_120px] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
                          {customer.fullName
                            .split(" ")
                            .map((part) => part[0] ?? "")
                            .join("")
                            .slice(0, 2)
                            .toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{customer.fullName}</p>
                          <p className="mt-1 text-xs text-slate-500">Updated {formatDateTime(customer.updatedAt)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="text-sm text-slate-700">{customer.phone}</div>
                    <div className="min-w-0 text-sm text-slate-600">{customer.email ?? <span className="text-slate-400">No email</span>}</div>
                    <div className="space-y-2">
                      <CustomerStageProgress stage={stage} />
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Badge tone={stage === "SOLD" ? "emerald" : stage === "WORKING" ? "blue" : stage === "QUOTED" ? "orange" : "slate"}>{stageLabel(stage)}</Badge>
                        {latestQuote ? <span>{quoteNumber(latestQuote.id)}</span> : <span>No quote yet</span>}
                      </div>
                    </div>
                    <div className="flex justify-start lg:justify-end">
                      {latestQuote ? (
                        <Button size="sm" variant="outline" onClick={() => navigateToQuote(latestQuote.id)}>Open Quote</Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => navigateToBuilder(customer.id)}>Start Quote</Button>
                      )}
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
