import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BadgeCheck, ChevronRight, CircleDot, ClipboardList, FilePlus2, FileText, MessageSquare, Phone, PhoneCall, Send, Wrench } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, ModalBody, ModalFooter, ModalHeader, PageHeader } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import { api, type Customer, type CustomerActivityEvent, type Quote } from "../lib/api";
import { QuickCustomerModal } from "../components/customers/QuickCustomerModal";

type CustomerStage = "NEW" | "CONTACTED" | "QUOTED" | "WORKING" | "SOLD";

type CustomerRow = {
  customer: Customer;
  latestQuote: Quote | null;
  stage: CustomerStage;
};

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "QUOTED", "WORKING", "SOLD"];
const ACTIVITY_PAGE_SIZE = 5;

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

function stageDarkClass(stage: CustomerStage) {
  if (stage === "NEW") return "border-slate-700 bg-slate-700 text-white";
  if (stage === "CONTACTED") return "border-[#2559b8] bg-[#2559b8] text-white";
  if (stage === "QUOTED") return "border-[#406fc7] bg-[#406fc7] text-white";
  if (stage === "WORKING") return "border-[#2b7aa5] bg-[#2b7aa5] text-white";
  return "border-emerald-600 bg-emerald-600 text-white";
}

function stageInitial(stage: CustomerStage) {
  if (stage === "NEW") return "N";
  if (stage === "CONTACTED") return "C";
  if (stage === "QUOTED") return "Q";
  if (stage === "WORKING") return "W";
  return "S";
}

function stageIcon(stage: CustomerStage) {
  if (stage === "NEW") return <CircleDot size={12} strokeWidth={2.2} />;
  if (stage === "CONTACTED") return <PhoneCall size={12} strokeWidth={2.2} />;
  if (stage === "QUOTED") return <FileText size={12} strokeWidth={2.2} />;
  if (stage === "WORKING") return <Wrench size={12} strokeWidth={2.2} />;
  return <BadgeCheck size={12} strokeWidth={2.2} />;
}

function stageStateClasses(active: boolean, complete: boolean) {
  if (active) {
    return "";
  }

  if (complete) {
    return "";
  }

  return "border-slate-200 bg-white text-slate-300";
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

function openDialer(phone: string) {
  window.location.assign(`tel:${phone}`);
}

function openTextComposer(phone: string) {
  window.location.assign(`sms:${phone}`);
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
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {CUSTOMER_STAGE_ORDER.map((item, index) => {
          const active = index === activeIndex;
          const complete = index < activeIndex;

          return (
            <div key={item} className="flex items-center gap-1.5">
              <div
                className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border text-[10px] font-bold ${
                  active || complete ? stageDarkClass(item) : stageStateClasses(active, complete)
                }`}
                title={stageLabel(item)}
                aria-label={stageLabel(item)}
              >
                {stageInitial(item)}
              </div>
              {index < CUSTOMER_STAGE_ORDER.length - 1 ? (
                <span className={`h-px w-4 rounded-full ${index < activeIndex ? "bg-slate-400" : "bg-slate-200"}`} />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={stageTone(stage)}
          icon={stageIcon(stage)}
          className={stage === "QUOTED" ? "border-transparent shadow-sm" : "border-transparent bg-slate-900 text-white shadow-sm"}
        >
          {stageLabel(stage)}
        </Badge>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          <span className="text-slate-700">{stageInitial(stage)}</span>
          Current
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
  stage: CustomerStage | "ALL";
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
            className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border text-[10px] font-bold ${stageDarkClass(stage)}`}
          >
            {stageInitial(stage)}
          </span>
        )}
        <span className="text-sm font-semibold text-slate-900">{count}</span>
      </div>
    </button>
  );
}

function StageFlowButton({
  stage,
  count,
  active,
  onClick,
}: {
  stage: CustomerStage;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group min-w-fit rounded-2xl border px-3 py-2.5 text-left transition sm:px-4 ${
        active
          ? "border-slate-900 bg-slate-900 text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
      aria-pressed={active}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
            active ? "border-white/20 bg-white/10 text-white" : stageDarkClass(stage)
          }`}
        >
          {stageInitial(stage)}
        </span>
        <div className="min-w-0">
          <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${active ? "text-white/75" : "text-slate-500"}`}>
            {stageLabel(stage)}
          </p>
          <p className={`mt-0.5 text-sm font-semibold ${active ? "text-white" : "text-slate-900"}`}>{count}</p>
        </div>
      </div>
    </button>
  );
}

function CustomerPipelineFilterStrip({
  totalCount,
  stageCounts,
  stageFilter,
  onChange,
}: {
  totalCount: number;
  stageCounts: Record<CustomerStage, number>;
  stageFilter: CustomerStage | "ALL";
  onChange: (stage: CustomerStage | "ALL") => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <StageCountCard label="All" count={totalCount} stage="ALL" active={stageFilter === "ALL"} onClick={() => onChange("ALL")} />
        <div className="hidden h-px w-6 shrink-0 bg-slate-200 sm:block" />
        <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50 px-2 py-2 sm:gap-2 sm:px-3">
          {CUSTOMER_STAGE_ORDER.map((stage, index) => (
            <div key={stage} className="flex items-center gap-1.5 sm:gap-2">
              <StageFlowButton stage={stage} count={stageCounts[stage]} active={stageFilter === stage} onClick={() => onChange(stage)} />
              {index < CUSTOMER_STAGE_ORDER.length - 1 ? (
                <span className="inline-flex h-8 w-6 shrink-0 items-center justify-center text-slate-300">
                  <ChevronRight size={16} strokeWidth={2.2} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <p className="px-1 text-xs text-slate-500">Follow the flow from new lead to sold, or tap any stage to filter the board.</p>
    </div>
  );
}

function CustomerDesktopRow({
  row,
  onOpenQuote,
  onStartQuote,
  onCallCustomer,
  onTextCustomer,
  onOpenActivity,
}: {
  row: CustomerRow;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
  onCallCustomer: (phone: string) => void;
  onTextCustomer: (phone: string) => void;
  onOpenActivity: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenActivity(customer.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenActivity(customer.id);
        }
      }}
      className="hidden cursor-pointer grid-cols-[minmax(0,1.35fr)_156px_220px_260px_190px] gap-4 px-4 py-3 lg:grid lg:items-center"
    >
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
            <span className="truncate">
              {quoteNumber(latestQuote.id)} - {latestQuote.title}
            </span>
          ) : (
            <span>No quote yet</span>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" icon={<Phone size={14} />} onClick={(event) => { event.stopPropagation(); onCallCustomer(customer.phone); }} aria-label="Call customer" />
        <Button size="sm" variant="ghost" icon={<MessageSquare size={14} />} onClick={(event) => { event.stopPropagation(); onTextCustomer(customer.phone); }} aria-label="Text customer" />
        <Button
          size="sm"
          variant={latestQuote ? "outline" : "primary"}
          icon={<FilePlus2 size={14} />}
          onClick={(event) => {
            event.stopPropagation();
            latestQuote ? onOpenQuote(latestQuote.id) : onStartQuote(customer.id);
          }}
        >
          {latestQuote ? "Open" : "Quote"}
        </Button>
      </div>
    </div>
  );
}

function CustomerMobileCard({
  row,
  onOpenQuote,
  onStartQuote,
  onCallCustomer,
  onTextCustomer,
  onOpenActivity,
}: {
  row: CustomerRow;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
  onCallCustomer: (phone: string) => void;
  onTextCustomer: (phone: string) => void;
  onOpenActivity: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenActivity(customer.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenActivity(customer.id);
        }
      }}
      className="space-y-3 px-4 py-4 lg:hidden"
    >
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
        <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold ${stageDarkClass(stage)}`}>
            {stageInitial(stage)}
          </span>
          {stageLabel(stage)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-700">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Phone</p>
          <p className="mt-1 truncate">{customer.phone}</p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Email</p>
          <p className="mt-1 truncate text-slate-600">{customer.email ?? "No email"}</p>
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

      <div className="grid grid-cols-3 gap-2">
        <Button fullWidth size="sm" variant="outline" icon={<Phone size={14} />} onClick={(event) => { event.stopPropagation(); onCallCustomer(customer.phone); }}>
          Call
        </Button>
        <Button fullWidth size="sm" variant="outline" icon={<MessageSquare size={14} />} onClick={(event) => { event.stopPropagation(); onTextCustomer(customer.phone); }}>
          Text
        </Button>
        {latestQuote ? (
          <Button fullWidth size="sm" variant="primary" icon={<FilePlus2 size={14} />} onClick={(event) => { event.stopPropagation(); onOpenQuote(latestQuote.id); }}>Open</Button>
        ) : (
          <Button fullWidth size="sm" variant="primary" icon={<FilePlus2 size={14} />} onClick={(event) => { event.stopPropagation(); onStartQuote(customer.id); }}>Quote</Button>
        )}
      </div>
    </div>
  );
}

function activityTone(item: CustomerActivityEvent): "slate" | "blue" | "orange" | "emerald" {
  if (item.sourceType === "quote_outbound") return "orange";
  if (
    item.eventType === "ACCEPTED" ||
    item.eventType === "WON" ||
    item.eventType === "RESTORED" ||
    item.title.toLowerCase().includes("accepted") ||
    item.title.toLowerCase().includes("completed")
  ) {
    return "emerald";
  }
  if (item.eventType === "ARCHIVED" || item.eventType === "REJECTED") return "slate";
  return "blue";
}

function activityIcon(item: CustomerActivityEvent): ReactNode {
  if (item.sourceType === "quote_outbound") {
    if (item.channel === "SMS_APP") return <MessageSquare size={14} strokeWidth={2.2} />;
    if (item.channel === "COPY") return <ClipboardList size={14} strokeWidth={2.2} />;
    return <Send size={14} strokeWidth={2.2} />;
  }

  const title = item.title.toLowerCase();
  if (title.includes("quote drafted")) return <FilePlus2 size={14} strokeWidth={2.2} />;
  if (title.includes("quote sent")) return <Send size={14} strokeWidth={2.2} />;
  if (title.includes("accepted")) return <BadgeCheck size={14} strokeWidth={2.2} />;
  if (title.includes("completed")) return <Wrench size={14} strokeWidth={2.2} />;
  if (item.eventType === "STATUS_CHANGED") return <PhoneCall size={14} strokeWidth={2.2} />;
  if (item.eventType === "NOTES_ADDED" || item.eventType === "NOTES_UPDATED" || item.eventType === "NOTES_CLEARED") {
    return <FileText size={14} strokeWidth={2.2} />;
  }
  if (item.eventType === "ARCHIVED") return <CircleDot size={14} strokeWidth={2.2} />;
  return <ClipboardList size={14} strokeWidth={2.2} />;
}

function activityActorLabel(item: CustomerActivityEvent): string {
  return item.actorName?.trim() || item.actorEmail?.trim() || "Unknown";
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
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [activityCustomerId, setActivityCustomerId] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<CustomerActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotal, setActivityTotal] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (searchParams.get("compose") === "customer") {
      setQuickCustomerOpen(true);
    }
  }, [searchParams]);

  useEffect(() => {
    setActivityPage(1);
  }, [activityCustomerId]);

  useEffect(() => {
    if (!activityCustomerId) {
      setActivityItems([]);
      setActivityLoading(false);
      setActivityTotal(0);
      return;
    }

    let mounted = true;
    setActivityLoading(true);

    api.customers
      .activity(activityCustomerId, {
        limit: ACTIVITY_PAGE_SIZE,
        offset: (activityPage - 1) * ACTIVITY_PAGE_SIZE,
      })
      .then((result) => {
        if (!mounted) return;
        setActivityItems(result.items);
        setActivityTotal(result.pagination.total);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Failed loading customer activity.");
      })
      .finally(() => {
        if (mounted) setActivityLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [activityCustomerId, activityPage, setError]);

  function closeQuickCustomerModal() {
    setQuickCustomerOpen(false);
    if (searchParams.get("compose") === "customer") {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("compose");
      setSearchParams(nextParams, { replace: true });
    }
  }

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

  const selectedActivityRow = useMemo(
    () => (activityCustomerId ? customerRows.find((row) => row.customer.id === activityCustomerId) ?? null : null),
    [activityCustomerId, customerRows],
  );

  const selectedActivityQuotes = useMemo(
    () =>
      selectedActivityRow
        ? quotes
            .filter((quote) => quote.customerId === selectedActivityRow.customer.id)
            .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        : [],
    [quotes, selectedActivityRow],
  );

  const totalActivityPages = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        subtitle="Track customers through a simple sales pipeline, then jump into quoting when they are ready."
        actions={
          <>
            <Button variant="outline" onClick={() => setQuickCustomerOpen(true)}>Add Customer</Button>
            <Button onClick={() => navigateToBuilder()}>New Quote</Button>
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <CustomerPipelineFilterStrip
        totalCount={customerRows.length}
        stageCounts={stageCounts}
        stageFilter={stageFilter}
        onChange={setStageFilter}
      />

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
              <div className="hidden grid-cols-[minmax(0,1.35fr)_156px_220px_260px_190px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Customer</span>
                <span>Phone</span>
                <span>Email</span>
                <span>Status</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="divide-y divide-slate-200">
                {filteredRows.map((row) => (
                  <div key={row.customer.id} className="transition-colors hover:bg-slate-50/80">
                    <CustomerDesktopRow
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={setActivityCustomerId}
                    />
                    <CustomerMobileCard
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={setActivityCustomerId}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={closeQuickCustomerModal}
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

      <Modal open={Boolean(selectedActivityRow)} onClose={() => setActivityCustomerId(null)} size="lg" ariaLabel="Customer activity history">
        <ModalHeader
          title={selectedActivityRow ? `${selectedActivityRow.customer.fullName} activity` : "Customer activity"}
          description={selectedActivityRow ? "Timeline of customer entry, contact, quotes, and work progress." : undefined}
          onClose={() => setActivityCustomerId(null)}
        />
        <ModalBody className="space-y-5">
          {selectedActivityRow ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer since</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{formatDateTime(selectedActivityRow.customer.createdAt)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Current status</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold ${stageDarkClass(selectedActivityRow.stage)}`}>
                      {stageInitial(selectedActivityRow.stage)}
                    </span>
                    <span className="text-sm font-semibold text-slate-900">{stageLabel(selectedActivityRow.stage)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quotes on record</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{selectedActivityQuotes.length}</p>
                </div>
              </div>

              {selectedActivityRow.customer.notes?.trim() ? (
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Current notes</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{selectedActivityRow.customer.notes.trim()}</p>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                {activityLoading ? (
                  <div className="px-4 py-6 text-sm text-slate-600">Loading activity...</div>
                ) : activityItems.length ? (
                  activityItems.map((item, index) => {
                    const tone = activityTone(item);
                    return (
                    <div
                      key={item.id}
                      className={`flex gap-3 px-4 py-4 ${index > 0 ? "border-t border-slate-200" : ""}`}
                    >
                      <span
                        className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                          tone === "blue"
                            ? "bg-[#2559b8] text-white"
                            : tone === "orange"
                              ? "bg-[#d97706] text-white"
                              : tone === "emerald"
                                ? "bg-emerald-600 text-white"
                                : "bg-slate-700 text-white"
                        }`}
                      >
                        {activityIcon(item)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                          <span className="text-xs text-slate-500">{formatDateTime(item.occurredAt)}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-600">{item.detail || "No additional detail captured."}</p>
                        <div className="mt-2 flex items-center justify-end">
                          <span className="text-[11px] font-medium text-slate-500">By {activityActorLabel(item)}</span>
                        </div>
                      </div>
                    </div>
                  );
                  })
                ) : (
                  <div className="p-4">
                    <EmptyState title="No activity yet" description="Customer events will appear here as work moves from entry to sold." />
                  </div>
                )}
              </div>

              {activityTotal > ACTIVITY_PAGE_SIZE ? (
                <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-slate-500">
                    Showing {Math.min((activityPage - 1) * ACTIVITY_PAGE_SIZE + 1, activityTotal)}-
                    {Math.min(activityPage * ACTIVITY_PAGE_SIZE, activityTotal)} of {activityTotal} events
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActivityPage((current) => Math.max(1, current - 1))}
                      disabled={activityPage === 1 || activityLoading}
                    >
                      Previous
                    </Button>
                    <span className="text-xs font-medium text-slate-600">
                      Page {activityPage} of {totalActivityPages}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActivityPage((current) => Math.min(totalActivityPages, current + 1))}
                      disabled={activityPage >= totalActivityPages || activityLoading}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </ModalBody>
        {selectedActivityRow ? (
          <ModalFooter className="justify-between">
            <div className="text-xs text-slate-500">
              Open a quote from this customer when you need pricing, send actions, or PDF work.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setActivityCustomerId(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setActivityCustomerId(null);
                  if (selectedActivityRow.latestQuote) {
                    navigateToQuote(selectedActivityRow.latestQuote.id);
                  } else {
                    navigateToBuilder(selectedActivityRow.customer.id);
                  }
                }}
              >
                {selectedActivityRow.latestQuote ? "Open Quote" : "Start Quote"}
              </Button>
            </div>
          </ModalFooter>
        ) : null}
      </Modal>
    </div>
  );
}

