import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BadgeCheck, CircleDot, ClipboardList, FilePlus2, FileText, Mail, MessageSquare, Phone, PhoneCall, Search, Send, Wrench, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, Card, ConfirmModal, EmptyState, Input, Modal, ModalBody, ModalFooter, ModalHeader, PageHeader, Textarea } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import { api, type Customer, type CustomerActivityEvent, type Quote } from "../lib/api";
import { formatUsPhoneDisplay, phoneMatchesSearch, toPhoneHrefValue } from "../lib/phone";
import { QuickCustomerModal } from "../components/customers/QuickCustomerModal";

type CustomerStage = "NEW" | "CONTACTED" | "READY" | "SENT" | "WON" | "LOST";

type CustomerRow = {
  customer: Customer;
  latestQuote: Quote | null;
  stage: CustomerStage;
};

type CustomerRetentionAction =
  | { type: "archive" | "delete"; row: CustomerRow }
  | null;

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "READY", "SENT", "WON", "LOST"];
const ACTIVITY_PAGE_SIZE = 5;

function stageLabel(stage: CustomerStage) {
  if (stage === "NEW") return "New";
  if (stage === "CONTACTED") return "Contacted";
  if (stage === "READY") return "Ready";
  if (stage === "SENT") return "Sent";
  if (stage === "WON") return "Won";
  return "Lost";
}

function stageDarkClass(stage: CustomerStage) {
  if (stage === "NEW") return "border-slate-700 bg-slate-700 text-white";
  if (stage === "CONTACTED") return "border-[#2559b8] bg-[#2559b8] text-white";
  if (stage === "READY") return "border-[#d97706] bg-[#d97706] text-white";
  if (stage === "SENT") return "border-[#2b7aa5] bg-[#2b7aa5] text-white";
  if (stage === "LOST") return "border-red-600 bg-red-600 text-white";
  return "border-emerald-600 bg-emerald-600 text-white";
}

function stageSoftClass(stage: CustomerStage) {
  if (stage === "NEW") return "border-slate-200 bg-slate-100 text-slate-700";
  if (stage === "CONTACTED") return "border-blue-200 bg-blue-50 text-blue-700";
  if (stage === "READY") return "border-amber-200 bg-amber-50 text-amber-700";
  if (stage === "SENT") return "border-sky-200 bg-sky-50 text-sky-700";
  if (stage === "LOST") return "border-red-200 bg-red-50 text-red-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function stageInitial(stage: CustomerStage) {
  if (stage === "NEW") return "N";
  if (stage === "CONTACTED") return "C";
  if (stage === "READY") return "R";
  if (stage === "SENT") return "S";
  if (stage === "WON") return "W";
  return "L";
}

function stageIcon(stage: CustomerStage) {
  if (stage === "NEW") return <CircleDot size={12} strokeWidth={2.2} />;
  if (stage === "CONTACTED") return <PhoneCall size={12} strokeWidth={2.2} />;
  if (stage === "READY") return <FileText size={12} strokeWidth={2.2} />;
  if (stage === "SENT") return <Send size={12} strokeWidth={2.2} />;
  if (stage === "WON") return <BadgeCheck size={12} strokeWidth={2.2} />;
  return <XCircle size={12} strokeWidth={2.2} />;
}

function quoteNumber(quoteId: string) {
  return `QF-${quoteId.slice(0, 8).toUpperCase()}`;
}

function customerUpdatedLabel(updatedAt: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return formatDateTime(updatedAt);

  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date)}`;
}

function stageGuidance(stage: CustomerStage, hasQuote: boolean) {
  if (stage === "NEW") return hasQuote ? "Quote started" : "Needs first quote";
  if (stage === "CONTACTED") return "Follow-up in progress";
  if (stage === "READY") return "Ready to review";
  if (stage === "SENT") return "Waiting on customer";
  if (stage === "WON") return "Work won";
  return "Closed lost";
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
  window.location.assign(`tel:${toPhoneHrefValue(phone)}`);
}

function openTextComposer(phone: string) {
  window.location.assign(`sms:${toPhoneHrefValue(phone)}`);
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

function getCustomerStage(customer: Customer, customerQuotes: Quote[]): CustomerStage {
  if (customer.followUpStatus === "WON" || customerQuotes.some((quote) => quote.status === "ACCEPTED")) return "WON";
  if (customer.followUpStatus === "LOST" || customerQuotes.some((quote) => quote.status === "REJECTED")) return "LOST";
  if (customerQuotes.some((quote) => quote.status === "SENT_TO_CUSTOMER")) return "SENT";
  if (customerQuotes.some((quote) => quote.status === "READY_FOR_REVIEW")) return "READY";

  if (customer.followUpStatus === "FOLLOWED_UP") {
    return "CONTACTED";
  }

  return "NEW";
}

function StageFilterButton({
  stage,
  count,
  active,
  onClick,
}: {
  stage: CustomerStage | "ALL";
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const label = stage === "ALL" ? "All customers" : stageLabel(stage);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-[48px] min-w-[126px] shrink-0 snap-start items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition sm:min-h-[44px] ${
        active
          ? "border-quotefly-blue bg-quotefly-blue text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
      aria-pressed={active}
      aria-label={`Filter customers: ${label} (${count})`}
    >
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
          active
            ? "border-white/20 bg-white/10 text-white"
            : stage === "ALL"
              ? "border-slate-200 bg-slate-100 text-slate-600"
              : stageDarkClass(stage)
        }`}
      >
        {stage === "ALL" ? "A" : stageInitial(stage)}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[11px] font-semibold uppercase tracking-[0.12em] ${active ? "text-white/80" : "text-slate-500"}`}>
          {label}
        </p>
        <p className={`mt-0.5 text-sm font-bold ${active ? "text-white" : "text-slate-950"}`}>{count}</p>
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
      <div className="flex snap-x snap-mandatory items-center gap-2 overflow-x-auto pb-2" role="group" aria-label="Customer stage filters">
        <StageFilterButton stage="ALL" count={totalCount} active={stageFilter === "ALL"} onClick={() => onChange("ALL")} />
        {CUSTOMER_STAGE_ORDER.map((stage) => (
          <StageFilterButton key={stage} stage={stage} count={stageCounts[stage]} active={stageFilter === stage} onClick={() => onChange(stage)} />
        ))}
      </div>
      <p className="px-1 text-xs text-slate-500">Filter the customer list by the next stage in the quoting workflow.</p>
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
    <div className="hidden min-h-[86px] grid-cols-[minmax(220px,1.25fr)_minmax(220px,1fr)_minmax(190px,0.9fr)_150px_190px] items-center gap-5 border-l-2 border-transparent px-5 py-3 transition xl:grid hover:border-quotefly-blue hover:bg-slate-50/80 2xl:grid-cols-[minmax(260px,1.35fr)_minmax(250px,1fr)_minmax(220px,0.9fr)_160px_200px]">
      <button
        type="button"
        onClick={() => onOpenActivity(customer.id)}
        className="group/customer min-w-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
        aria-label={`Open ${customer.fullName} details`}
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-700 ring-1 ring-slate-200 transition group-hover/customer:bg-white group-hover/customer:text-quotefly-blue">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-950 group-hover/customer:text-quotefly-blue">{customer.fullName}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{customerUpdatedLabel(customer.updatedAt)} · View details</p>
          </div>
        </div>
      </button>

      <div className="min-w-0 space-y-1.5 text-sm">
        <div className="flex min-w-0 items-center gap-2 text-slate-700">
          <Phone size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate font-medium">{formatUsPhoneDisplay(customer.phone)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-slate-600">
          <Mail size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className={`truncate ${customer.email ? "" : "text-slate-400"}`}>{customer.email ?? "No email added"}</span>
        </div>
      </div>

      <div className="min-w-0">
        {latestQuote ? (
          <button
            type="button"
            onClick={() => onOpenQuote(latestQuote.id)}
            className="block min-w-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
            aria-label={`Open quote ${latestQuote.title}`}
          >
            <span className="block truncate text-sm font-semibold text-slate-900 hover:text-quotefly-blue">{latestQuote.title}</span>
            <span className="mt-1 block truncate text-xs font-medium text-slate-500">{quoteNumber(latestQuote.id)}</span>
          </button>
        ) : (
          <div>
            <p className="text-sm font-semibold text-slate-700">No quote yet</p>
            <p className="mt-1 text-xs text-slate-500">Ready for a first estimate</p>
          </div>
        )}
      </div>

      <div className="min-w-0">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${stageSoftClass(stage)}`}>
          {stageIcon(stage)}
          {stageLabel(stage)}
        </span>
        <p className="mt-1.5 truncate text-xs text-slate-500">{stageGuidance(stage, Boolean(latestQuote))}</p>
      </div>

      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" icon={<Phone size={15} />} onClick={() => onCallCustomer(customer.phone)} aria-label={`Call ${customer.fullName}`} title={`Call ${customer.fullName}`} />
        <Button size="sm" variant="ghost" icon={<MessageSquare size={15} />} onClick={() => onTextCustomer(customer.phone)} aria-label={`Text ${customer.fullName}`} title={`Text ${customer.fullName}`} />
        <Button
          size="sm"
          variant="primary"
          icon={<FilePlus2 size={14} />}
          className="whitespace-nowrap"
          onClick={() => {
            if (latestQuote) {
              onOpenQuote(latestQuote.id);
            } else {
              onStartQuote(customer.id);
            }
          }}
        >
          {latestQuote ? "Open" : "Start"}
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
    <article className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_18px_rgba(15,23,42,0.045)] xl:hidden">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onOpenActivity(customer.id)}
          className="flex min-h-[44px] min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
          aria-label={`Open ${customer.fullName} details`}
        >
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-700 ring-1 ring-slate-200">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-slate-950">{customer.fullName}</p>
            <p className="mt-1 text-xs text-slate-500">{customerUpdatedLabel(customer.updatedAt)} · View details</p>
          </div>
        </button>
        <div className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${stageSoftClass(stage)}`}>
          {stageIcon(stage)}
          {stageLabel(stage)}
        </div>
      </div>

      <div className="space-y-2 rounded-xl bg-slate-50 px-3.5 py-3 text-sm">
        <div className="flex min-w-0 items-center gap-2.5 text-slate-700">
          <Phone size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate font-medium">{formatUsPhoneDisplay(customer.phone)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 text-slate-600">
          <Mail size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className={`truncate ${customer.email ? "" : "text-slate-400"}`}>{customer.email ?? "No email added"}</span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 border-t border-slate-100 pt-3 text-sm text-slate-700">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Latest quote</p>
          <p className="mt-1 truncate font-semibold text-slate-900">{latestQuote ? latestQuote.title : "No quote yet"}</p>
          <p className="mt-1 text-xs text-slate-500">{stageGuidance(stage, Boolean(latestQuote))}</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500">{latestQuote ? quoteNumber(latestQuote.id) : "Ready to start"}</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button fullWidth size="sm" variant="outline" icon={<Phone size={14} />} onClick={() => onCallCustomer(customer.phone)}>
          Call
        </Button>
        <Button fullWidth size="sm" variant="outline" icon={<MessageSquare size={14} />} onClick={() => onTextCustomer(customer.phone)}>
          Text
        </Button>
        {latestQuote ? (
          <Button fullWidth size="sm" variant="primary" icon={<FilePlus2 size={14} />} onClick={() => onOpenQuote(latestQuote.id)}>Open</Button>
        ) : (
          <Button fullWidth size="sm" variant="primary" icon={<FilePlus2 size={14} />} onClick={() => onStartQuote(customer.id)}>Quote</Button>
        )}
      </div>
    </article>
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
    loadCustomers,
    loadQuotes,
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
  const [customerNotesDraft, setCustomerNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [customerDetailsDraft, setCustomerDetailsDraft] = useState({ fullName: "", phone: "", email: "" });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsFeedback, setDetailsFeedback] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [customerRetentionAction, setCustomerRetentionAction] = useState<CustomerRetentionAction>(null);
  const [customerRetentionSaving, setCustomerRetentionSaving] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get("compose") === "customer") {
      setQuickCustomerOpen(true);
    }
  }, [searchParams]);

  useEffect(() => {
    setActivityPage(1);
  }, [activityCustomerId]);

  const loadCustomerActivity = useCallback(
    async (customerId: string, page: number) => {
      setActivityLoading(true);
      try {
        const result = await api.customers.activity(customerId, {
          limit: ACTIVITY_PAGE_SIZE,
          offset: (page - 1) * ACTIVITY_PAGE_SIZE,
        });
        setActivityItems(result.items);
        setActivityTotal(result.pagination.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed loading customer activity.");
      } finally {
        setActivityLoading(false);
      }
    },
    [setError],
  );

  useEffect(() => {
    if (!activityCustomerId) {
      setActivityItems([]);
      setActivityLoading(false);
      setActivityTotal(0);
      return;
    }

    void loadCustomerActivity(activityCustomerId, activityPage);
  }, [activityCustomerId, activityPage, loadCustomerActivity]);

  function closeQuickCustomerModal() {
    setQuickCustomerOpen(false);
    if (searchParams.get("compose") === "customer") {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("compose");
      setSearchParams(nextParams, { replace: true });
    }
  }

  const latestQuoteByCustomer = useMemo(() => getLatestQuoteMap(quotes), [quotes]);
  const quotesByCustomer = useMemo(() => {
    const map = new Map<string, Quote[]>();
    for (const quote of quotes) {
      const customerQuotes = map.get(quote.customerId) ?? [];
      customerQuotes.push(quote);
      map.set(quote.customerId, customerQuotes);
    }
    return map;
  }, [quotes]);

  const customerRows = useMemo(() => {
    return customers
      .map((customer) => {
        const latestQuote = latestQuoteByCustomer.get(customer.id) ?? null;
        const stage = getCustomerStage(customer, quotesByCustomer.get(customer.id) ?? []);
        return {
          customer,
          latestQuote,
          stage,
        } satisfies CustomerRow;
      })
      .sort((left, right) => new Date(right.customer.updatedAt).getTime() - new Date(left.customer.updatedAt).getTime());
  }, [customers, latestQuoteByCustomer, quotesByCustomer]);

  const stageCounts = useMemo(() => {
    return CUSTOMER_STAGE_ORDER.reduce<Record<CustomerStage, number>>((accumulator, stage) => {
      accumulator[stage] = customerRows.filter((row) => row.stage === stage).length;
      return accumulator;
  }, { NEW: 0, CONTACTED: 0, READY: 0, SENT: 0, WON: 0, LOST: 0 });
  }, [customerRows]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return customerRows.filter((row) => {
      const matchesStage = stageFilter === "ALL" || row.stage === stageFilter;
      if (!matchesStage) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        row.customer.fullName,
        row.customer.email ?? "",
        row.latestQuote?.title ?? "",
        row.latestQuote ? quoteNumber(row.latestQuote.id) : "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch) || phoneMatchesSearch(row.customer.phone, searchTerm);
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
  const notesChanged =
    (selectedActivityRow?.customer.notes?.trim() ?? "") !== customerNotesDraft.trim();
  const detailsChanged = Boolean(selectedActivityRow) && (
    selectedActivityRow?.customer.fullName !== customerDetailsDraft.fullName.trim() ||
    selectedActivityRow?.customer.phone !== customerDetailsDraft.phone.trim() ||
    (selectedActivityRow?.customer.email ?? "") !== customerDetailsDraft.email.trim()
  );

  useEffect(() => {
    setCustomerNotesDraft(selectedActivityRow?.customer.notes ?? "");
  }, [selectedActivityRow?.customer.id, selectedActivityRow?.customer.notes]);

  useEffect(() => {
    setCustomerDetailsDraft({
      fullName: selectedActivityRow?.customer.fullName ?? "",
      phone: selectedActivityRow?.customer.phone ?? "",
      email: selectedActivityRow?.customer.email ?? "",
    });
  }, [selectedActivityRow?.customer.email, selectedActivityRow?.customer.fullName, selectedActivityRow?.customer.id, selectedActivityRow?.customer.phone]);

  useEffect(() => {
    setDetailsFeedback(null);
  }, [selectedActivityRow?.customer.id]);

  async function saveCustomerDetails() {
    if (!selectedActivityRow || detailsSaving) return;

    const fullName = customerDetailsDraft.fullName.trim();
    const phone = customerDetailsDraft.phone.trim();
    if (!fullName || !phone) {
      setDetailsFeedback({ tone: "error", message: "Customer name and phone are required." });
      return;
    }

    setDetailsFeedback(null);
    setDetailsSaving(true);
    try {
      await api.customers.update(selectedActivityRow.customer.id, {
        fullName,
        phone,
        email: customerDetailsDraft.email.trim() || null,
      });
      await loadCustomers();
      await loadCustomerActivity(selectedActivityRow.customer.id, activityPage);
      setDetailsFeedback({ tone: "success", message: "Customer details saved." });
    } catch (err) {
      setDetailsFeedback({ tone: "error", message: err instanceof Error ? err.message : "Failed saving customer details." });
    } finally {
      setDetailsSaving(false);
    }
  }

  async function saveCustomerNotes() {
    if (!selectedActivityRow || notesSaving) return;

    const nextNotes = customerNotesDraft.trim();
    setNotesSaving(true);
    try {
      await api.customers.update(selectedActivityRow.customer.id, {
        notes: nextNotes || null,
      });
      await loadCustomers();
      await loadCustomerActivity(selectedActivityRow.customer.id, activityPage);
      setNotice(nextNotes ? "Customer notes saved." : "Customer notes cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed saving customer notes.");
    } finally {
      setNotesSaving(false);
    }
  }

  async function confirmCustomerRetentionAction() {
    if (!customerRetentionAction || customerRetentionSaving) return;

    setCustomerRetentionSaving(true);
    try {
      if (customerRetentionAction.type === "archive") {
        await api.customers.archive(customerRetentionAction.row.customer.id);
        setNotice("Customer archived.");
      } else {
        await api.customers.delete(customerRetentionAction.row.customer.id);
        setNotice("Customer deleted from the active workspace.");
      }
      await Promise.all([loadCustomers(), loadQuotes()]);
      setActivityCustomerId(null);
      setCustomerRetentionAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${customerRetentionAction.type} customer.`);
    } finally {
      setCustomerRetentionSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        subtitle="Track customers through a simple sales pipeline, then jump into quoting when they are ready."
        actions={
          <Button onClick={() => setQuickCustomerOpen(true)}>Add customer</Button>
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

      <Card variant="elevated" padding="md" className="overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer workspace</p>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                {filteredRows.length} {filteredRows.length === 1 ? "customer" : "customers"}
              </span>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Customer list</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">Contact a customer, review their latest quote, or open the full relationship history.</p>
          </div>
          <div className="w-full lg:w-[360px]">
            <label htmlFor="customer-search" className="sr-only">Search customers</label>
            <Input
              id="customer-search"
              icon={<Search size={16} aria-hidden="true" />}
              placeholder="Search name, phone, email, or quote"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
        </div>

        <div className="-mx-4 -mb-4 mt-4 border-t border-slate-200 sm:-mx-5 sm:-mb-5">
          {loading ? (
            <div className="px-5 py-8 text-sm text-slate-600">Loading customers...</div>
          ) : filteredRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={customerRows.length ? "No matching customers" : "Add your first customer"}
                description={customerRows.length ? "Clear the search or choose another stage." : "Create a customer here, then start their first quote."}
                action={customerRows.length ? <Button variant="outline" onClick={() => { setSearchTerm(""); setStageFilter("ALL"); }}>Clear filters</Button> : <Button onClick={() => setQuickCustomerOpen(true)}>Add customer</Button>}
              />
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(220px,1.25fr)_minmax(220px,1fr)_minmax(190px,0.9fr)_150px_190px] gap-5 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500 xl:grid 2xl:grid-cols-[minmax(260px,1.35fr)_minmax(250px,1fr)_minmax(220px,0.9fr)_160px_200px]">
                <span>Customer</span>
                <span>Contact</span>
                <span>Latest quote</span>
                <span>Stage</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="grid gap-3 bg-slate-50/70 p-3 md:grid-cols-2 xl:block xl:bg-white xl:p-0">
                {filteredRows.map((row) => (
                  <div key={row.customer.id} className="xl:border-b xl:border-slate-200 xl:last:border-b-0">
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

              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer details</p>
                    <p className="mt-1 text-sm text-slate-600">Keep contact information current for calls, texts, and quote delivery.</p>
                  </div>
                  <Button size="sm" onClick={() => void saveCustomerDetails()} disabled={!detailsChanged || detailsSaving} loading={detailsSaving}>
                    Save details
                  </Button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className="text-xs font-medium text-slate-700">Name</span>
                    <Input
                      value={customerDetailsDraft.fullName}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, fullName: event.target.value }))}
                      disabled={detailsSaving}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-slate-700">Phone</span>
                    <Input
                      type="tel"
                      value={customerDetailsDraft.phone}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, phone: event.target.value }))}
                      disabled={detailsSaving}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-slate-700">Email</span>
                    <Input
                      type="email"
                      value={customerDetailsDraft.email}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, email: event.target.value }))}
                      disabled={detailsSaving}
                    />
                  </label>
                </div>
                {detailsFeedback ? (
                  <div className="mt-3">
                    <Alert tone={detailsFeedback.tone}>{detailsFeedback.message}</Alert>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer notes</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Keep property details, objections, promises, and follow-up context here for your team and future AI follow-up drafts.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void saveCustomerNotes()}
                    disabled={!notesChanged || notesSaving}
                    loading={notesSaving}
                  >
                    Save Notes
                  </Button>
                </div>
                <div className="mt-3">
                  <Textarea
                    rows={5}
                    placeholder="Add customer notes, callback context, property details, or anything your team and AI should know."
                    value={customerNotesDraft}
                    onChange={(event) => setCustomerNotesDraft(event.target.value)}
                    disabled={notesSaving}
                  />
                </div>
              </div>

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
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setCustomerRetentionAction({ type: "archive", row: selectedActivityRow })}>
                Archive
              </Button>
              <Button variant="danger" onClick={() => setCustomerRetentionAction({ type: "delete", row: selectedActivityRow })}>
                Delete
              </Button>
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

      <ConfirmModal
        open={Boolean(customerRetentionAction)}
        onClose={() => {
          if (!customerRetentionSaving) setCustomerRetentionAction(null);
        }}
        onConfirm={() => void confirmCustomerRetentionAction()}
        title={
          customerRetentionAction?.type === "archive"
            ? "Archive customer?"
            : "Delete customer?"
        }
        description={
          customerRetentionAction?.type === "archive"
            ? "This customer will leave the active workspace but remain retained in the database and audit history. Related active quotes will be archived too."
            : "This customer will leave the active workspace but remain retained in the database and audit history. Related active quotes will be deleted too."
        }
        confirmLabel={customerRetentionAction?.type === "archive" ? "Archive customer" : "Delete customer"}
        loading={customerRetentionSaving}
        confirmVariant={customerRetentionAction?.type === "archive" ? "primary" : "danger"}
      />
    </div>
  );
}






