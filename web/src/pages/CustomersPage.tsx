import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import type { Customer, Quote } from "../lib/api";

type CustomerStage = "NEW" | "CONTACTED" | "QUOTED" | "WORKING" | "SOLD";

type CustomerRow = {
  customer: Customer;
  latestQuote: Quote | null;
  stage: CustomerStage;
};

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "QUOTED", "WORKING", "SOLD"];

function stageLabel(stage: CustomerStage) {
  if (stage === "NEW") return "New";
  if (stage === "CONTACTED") return "Contacted";
  if (stage === "QUOTED") return "Quoted";
  if (stage === "WORKING") return "Working";
  return "Sold";
}

function stageTone(stage: CustomerStage): "slate" | "blue" | "orange" | "emerald" {
  if (stage === "NEW") return "slate";
  if (stage === "CONTACTED") return "blue";
  if (stage === "QUOTED") return "orange";
  return "emerald";
}

function quoteNumber(quoteId: string) {
  return `QF-${quoteId.slice(0, 8).toUpperCase()}`;
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
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

function CustomerPipelineMini({ stage }: { stage: CustomerStage }) {
  const activeIndex = stageIndex(stage);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {CUSTOMER_STAGE_ORDER.map((item, index) => {
          const active = index === activeIndex;
          const complete = index < activeIndex;
          return (
            <div key={item} className="flex min-w-0 flex-1 items-center gap-1.5">
              <span
                className={`h-2.5 min-w-2.5 flex-1 rounded-full ${
                  active
                    ? "bg-quotefly-blue"
                    : complete
                      ? "bg-emerald-500"
                      : "bg-slate-200"
                }`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={stageTone(stage)}>{stageLabel(stage)}</Badge>
        <div className="hidden flex-wrap gap-1 sm:flex">
          {CUSTOMER_STAGE_ORDER.map((item, index) => (
            <span
              key={item}
              className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                index <= activeIndex ? "text-slate-700" : "text-slate-400"
              }`}
            >
              {stageLabel(item)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function StageCountCard({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{count}</p>
    </button>
  );
}

function CustomerDesktopRow({
  row,
  onOpenQuote,
  onStartQuote,
}: {
  row: CustomerRow;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;

  return (
    <div className="hidden grid-cols-[minmax(0,1.45fr)_156px_220px_260px_118px] gap-4 px-4 py-3 lg:grid lg:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{customer.fullName}</p>
            <p className="mt-1 truncate text-xs text-slate-500">Updated {formatDateTime(customer.updatedAt)}</p>
          </div>
        </div>
      </div>

      <div className="truncate text-sm text-slate-700">{customer.phone}</div>

      <div className="min-w-0">
        {customer.email ? (
          <p className="truncate text-sm text-slate-600">{customer.email}</p>
        ) : (
          <p className="text-sm text-slate-400">No email</p>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        <CustomerPipelineMini stage={stage} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {latestQuote ? (
            <span className="truncate">{quoteNumber(latestQuote.id)} · {latestQuote.title}</span>
          ) : (
            <span>No quote yet</span>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        {latestQuote ? (
          <Button size="sm" variant="outline" onClick={() => onOpenQuote(latestQuote.id)}>Open</Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onStartQuote(customer.id)}>Start</Button>
        )}
      </div>
    </div>
  );
}

function CustomerMobileCard({
  row,
  onOpenQuote,
  onStartQuote,
}: {
  row: CustomerRow;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;

  return (
    <div className="space-y-3 px-4 py-4 lg:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{customer.fullName}</p>
            <p className="mt-1 text-xs text-slate-500">Updated {formatDateTime(customer.updatedAt)}</p>
          </div>
        </div>
        <Badge tone={stageTone(stage)}>{stageLabel(stage)}</Badge>
      </div>

      <div className="grid gap-2 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-700">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Phone</p>
          <p className="mt-1 break-all">{customer.phone}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Email</p>
          <p className="mt-1 break-all text-slate-600">{customer.email ?? "No email"}</p>
        </div>
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pipeline</p>
        <div className="mt-2">
          <CustomerPipelineMini stage={stage} />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Latest quote</p>
        <p className="mt-1 font-medium text-slate-900">{latestQuote ? quoteNumber(latestQuote.id) : "No quote yet"}</p>
        <p className="mt-1 text-xs text-slate-500">{latestQuote?.title ?? "Start a quote when this customer is ready."}</p>
      </div>

      {latestQuote ? (
        <Button fullWidth variant="outline" onClick={() => onOpenQuote(latestQuote.id)}>Open Quote</Button>
      ) : (
        <Button fullWidth variant="outline" onClick={() => onStartQuote(customer.id)}>Start Quote</Button>
      )}
    </div>
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
        } satisfies CustomerRow;
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

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 md:grid md:grid-cols-3 md:overflow-visible md:px-0 xl:grid-cols-6">
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
            <p className="mt-1 max-w-3xl text-sm text-slate-600">Use this as the operating table. Open quotes when they exist, or start a new one when they do not.</p>
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
              <div className="hidden grid-cols-[minmax(0,1.45fr)_156px_220px_260px_118px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Customer</span>
                <span>Phone</span>
                <span>Email</span>
                <span>Pipeline</span>
                <span>Action</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredRows.map((row) => (
                  <div key={row.customer.id}>
                    <CustomerDesktopRow
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                    />
                    <CustomerMobileCard
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
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
