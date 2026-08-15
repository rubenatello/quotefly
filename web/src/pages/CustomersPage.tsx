import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArchiveRestore, BadgeCheck, CircleDot, ClipboardList, FilePlus2, FileText, Mail, MessageSquare, Phone, PhoneCall, Search, Send, Wrench, XCircle } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Card, ConfirmModal, EmptyState, Input, LoadingState, Modal, ModalBody, ModalFooter, ModalHeader, PageHeader, Select, Textarea } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { KodyButton } from "../components/ai/KodyButton";
import { usePageView } from "../lib/analytics";
import { api, type Customer, type CustomerActivityEvent, type CustomerLifecycle, type CustomerQuoteSummary, type OrganizationUser } from "../lib/api";
import { formatUsPhoneDisplay, formatUsPhoneInput, normalizeUsPhoneDigits, toPhoneHrefValue } from "../lib/phone";
import { QuickCustomerModal } from "../components/customers/QuickCustomerModal";
import { notify } from "../lib/notifications";

type CustomerStage = "NEW" | "CONTACTED" | "READY" | "SENT" | "WON" | "LOST";

type CustomerRow = {
  customer: Customer;
  latestQuote: CustomerQuoteSummary | null;
  stage: CustomerStage;
};

type CustomerRetentionAction =
  | { type: "archive" | "delete" | "restore"; row: CustomerRow }
  | null;

function roleLabelForAssignment(role: OrganizationUser["role"]): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "READY", "SENT", "WON", "LOST"];
const ACTIVITY_PAGE_SIZE = 5;
const CUSTOMER_PAGE_SIZE = 25;

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
  if (stage === "CONTACTED") return "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)] text-white";
  if (stage === "READY") return "border-[var(--qf-warning-strong)] bg-[var(--qf-warning-strong)] text-white";
  if (stage === "SENT") return "border-[#2b7aa5] bg-[#2b7aa5] text-white";
  if (stage === "LOST") return "border-[var(--qf-danger-strong)] bg-[var(--qf-danger-strong)] text-white";
  return "border-[var(--qf-success-strong)] bg-[var(--qf-success-strong)] text-white";
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

function formatQuoteTotal(value: number | string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(value));
}

function formatQuoteStatus(status: CustomerQuoteSummary["status"]) {
  return status.replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
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

function isRouteStateRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
      <div className="qf-horizontal-filter-strip flex snap-x snap-mandatory items-center gap-2 overflow-x-auto pb-2" role="group" aria-label="Customer stage filters">
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
  const canQuote = !customer.archivedAtUtc && !customer.deletedAtUtc;

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
          onClick={() => onStartQuote(customer.id)}
          disabled={!canQuote}
          title={canQuote ? `Start a new quote for ${customer.fullName}` : "Restore this customer before starting a quote"}
        >
          New quote
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
  const canQuote = !customer.archivedAtUtc && !customer.deletedAtUtc;

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
          {latestQuote ? (
            <button
              type="button"
              className="mt-1 block max-w-full truncate rounded text-left font-semibold text-slate-900 hover:text-quotefly-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
              onClick={() => onOpenQuote(latestQuote.id)}
            >
              {latestQuote.title}
            </button>
          ) : (
            <p className="mt-1 truncate font-semibold text-slate-900">No quote yet</p>
          )}
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
        <Button
          fullWidth
          size="sm"
          variant="primary"
          icon={<FilePlus2 size={14} />}
          onClick={() => onStartQuote(customer.id)}
          disabled={!canQuote}
          title={canQuote ? `Start a new quote for ${customer.fullName}` : "Restore this customer before starting a quote"}
        >
          New quote
        </Button>
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
  const location = useLocation();
  const navigate = useNavigate();
  const {
    error,
    notice,
    setError,
    setNotice,
    loadCustomers,
    loadQuotes,
    navigateToQuote,
    navigateToBuilder,
    canManageAssignments,
    canManageRecordRetention,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [stageFilter, setStageFilter] = useState<CustomerStage | "ALL">("ALL");
  const [lifecycleFilter, setLifecycleFilter] = useState<CustomerLifecycle>("active");
  const [customerPage, setCustomerPage] = useState(1);
  const [customerItems, setCustomerItems] = useState<Customer[]>([]);
  const [customerTotal, setCustomerTotal] = useState(0);
  const [customerLoading, setCustomerLoading] = useState(true);
  const [lifecycleCounts, setLifecycleCounts] = useState({ active: 0, archived: 0, deleted: 0 });
  const [serverStageCounts, setServerStageCounts] = useState<Record<CustomerStage, number>>({ NEW: 0, CONTACTED: 0, READY: 0, SENT: 0, WON: 0, LOST: 0 });
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [activityCustomerId, setActivityCustomerId] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<CustomerActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotal, setActivityTotal] = useState(0);
  const [customerNotesDraft, setCustomerNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [customerDetailsDraft, setCustomerDetailsDraft] = useState({ fullName: "", phone: "", email: "", assignedTenantUserId: "" });
  const [workspaceMembers, setWorkspaceMembers] = useState<OrganizationUser[]>([]);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsFeedback, setDetailsFeedback] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [customerRetentionAction, setCustomerRetentionAction] = useState<CustomerRetentionAction>(null);
  const [customerRetentionSaving, setCustomerRetentionSaving] = useState(false);
  const [discardCustomerChangesOpen, setDiscardCustomerChangesOpen] = useState(false);
  const pendingCustomerCloseActionRef = useRef<(() => void) | null>(null);
  const [selectedCustomerDetail, setSelectedCustomerDetail] = useState<Customer | null>(null);
  const [selectedActivityQuotes, setSelectedActivityQuotes] = useState<CustomerQuoteSummary[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const customerRequestIdRef = useRef(0);
  const activityRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);

  useEffect(() => {
    if (!canManageAssignments) return;
    let mounted = true;
    api.org.users.list()
      .then((result) => {
        if (mounted) setWorkspaceMembers(result.members);
      })
      .catch(() => {
        if (mounted) setWorkspaceMembers([]);
      });
    return () => { mounted = false; };
  }, [canManageAssignments]);

  useEffect(() => {
    if (searchParams.get("compose") === "customer") {
      setQuickCustomerOpen(true);
    }
  }, [searchParams]);

  useEffect(() => {
    setActivityPage(1);
  }, [activityCustomerId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim());
      setCustomerPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchTerm]);

  const loadCustomerPage = useCallback(async () => {
    const requestId = ++customerRequestIdRef.current;
    setCustomerLoading(true);
    try {
      const result = await api.customers.list({
        limit: CUSTOMER_PAGE_SIZE,
        offset: (customerPage - 1) * CUSTOMER_PAGE_SIZE,
        search: debouncedSearchTerm || undefined,
        lifecycle: lifecycleFilter,
        stage: stageFilter === "ALL" ? undefined : stageFilter,
      });
      if (requestId !== customerRequestIdRef.current) return;
      setCustomerItems(result.customers);
      setCustomerTotal(result.pagination.total);
      setLifecycleCounts(result.summary.lifecycleCounts);
      setServerStageCounts(result.summary.stageCounts);
    } catch (err) {
      if (requestId !== customerRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed loading customers.");
    } finally {
      if (requestId === customerRequestIdRef.current) setCustomerLoading(false);
    }
  }, [customerPage, debouncedSearchTerm, lifecycleFilter, setError, stageFilter]);

  useEffect(() => {
    void loadCustomerPage();
  }, [loadCustomerPage]);

  const loadCustomerActivity = useCallback(
    async (customerId: string, page: number) => {
      const requestId = ++activityRequestIdRef.current;
      setActivityLoading(true);
      try {
        const result = await api.customers.activity(customerId, {
          limit: ACTIVITY_PAGE_SIZE,
          offset: (page - 1) * ACTIVITY_PAGE_SIZE,
        });
        if (requestId !== activityRequestIdRef.current) return;
        setActivityItems(result.items);
        setActivityTotal(result.pagination.total);
      } catch (err) {
        if (requestId !== activityRequestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed loading customer activity.");
      } finally {
        if (requestId === activityRequestIdRef.current) setActivityLoading(false);
      }
    },
    [setError],
  );

  useEffect(() => {
    if (!activityCustomerId) {
      activityRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      setActivityItems([]);
      setActivityLoading(false);
      setActivityTotal(0);
      setSelectedCustomerDetail(null);
      setSelectedActivityQuotes([]);
      return;
    }

    void loadCustomerActivity(activityCustomerId, activityPage);
  }, [activityCustomerId, activityPage, loadCustomerActivity]);

  const loadCustomerDetail = useCallback(async (customerId: string) => {
    const requestId = ++detailRequestIdRef.current;
    try {
      const result = await api.customers.get(customerId);
      if (requestId !== detailRequestIdRef.current) return;
      setSelectedCustomerDetail(result.customer);
      setSelectedActivityQuotes(result.quotes);
    } catch (err) {
      if (requestId !== detailRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed loading customer details.");
    }
  }, [setError]);

  useEffect(() => {
    if (activityCustomerId) void loadCustomerDetail(activityCustomerId);
  }, [activityCustomerId, loadCustomerDetail]);

  function closeQuickCustomerModal() {
    setQuickCustomerOpen(false);
    if (searchParams.get("compose") === "customer") {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("compose");
      setSearchParams(nextParams, { replace: true });
    }
  }

  const customerRows = useMemo(() => {
    return customerItems
      .map((customer) => {
        const latestQuote = customer.summary?.latestQuote ?? null;
        const stage = customer.summary?.stage ?? "NEW";
        return {
          customer,
          latestQuote,
          stage,
        } satisfies CustomerRow;
      })
      .sort((left, right) => new Date(right.customer.updatedAt).getTime() - new Date(left.customer.updatedAt).getTime());
  }, [customerItems]);

  const selectedActivityRow = useMemo(() => {
    if (!activityCustomerId) return null;
    if (selectedCustomerDetail?.id === activityCustomerId) {
      return {
        customer: selectedCustomerDetail,
        latestQuote: selectedCustomerDetail.summary?.latestQuote ?? null,
        stage: selectedCustomerDetail.summary?.stage ?? "NEW",
      } satisfies CustomerRow;
    }
    return customerRows.find((row) => row.customer.id === activityCustomerId) ?? null;
  }, [activityCustomerId, customerRows, selectedCustomerDetail]);

  const openCustomerDetail = useCallback((customerId: string) => {
    const snapshot = customerItems.find((customer) => customer.id === customerId) ?? null;
    activityRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setSelectedCustomerDetail(snapshot);
    setSelectedActivityQuotes([]);
    setActivityCustomerId(customerId);
  }, [customerItems]);

  useEffect(() => {
    if (!isRouteStateRecord(location.state) || typeof location.state.kodyCustomerId !== "string") return;
    openCustomerDetail(location.state.kodyCustomerId);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate, openCustomerDetail]);

  const totalActivityPages = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));
  const totalCustomerPages = Math.max(1, Math.ceil(customerTotal / CUSTOMER_PAGE_SIZE));
  const selectedCustomerInactive = Boolean(selectedActivityRow?.customer.archivedAtUtc || selectedActivityRow?.customer.deletedAtUtc);

  useEffect(() => {
    if (customerPage > totalCustomerPages) setCustomerPage(totalCustomerPages);
  }, [customerPage, totalCustomerPages]);
  const notesChanged =
    (selectedActivityRow?.customer.notes?.trim() ?? "") !== customerNotesDraft.trim();
  const detailsChanged = Boolean(selectedActivityRow) && (
    selectedActivityRow?.customer.fullName !== customerDetailsDraft.fullName.trim() ||
    selectedActivityRow?.customer.phone !== customerDetailsDraft.phone.trim() ||
    (selectedActivityRow?.customer.email ?? "") !== customerDetailsDraft.email.trim() ||
    (selectedActivityRow?.customer.assignedTenantUserId ?? "") !== customerDetailsDraft.assignedTenantUserId
  );

  useEffect(() => {
    setCustomerNotesDraft(selectedActivityRow?.customer.notes ?? "");
  }, [selectedActivityRow?.customer.id, selectedActivityRow?.customer.notes]);

  useEffect(() => {
    setCustomerDetailsDraft({
      fullName: selectedActivityRow?.customer.fullName ?? "",
      phone: selectedActivityRow?.customer.phone ?? "",
      email: selectedActivityRow?.customer.email ?? "",
      assignedTenantUserId: selectedActivityRow?.customer.assignedTenantUserId ?? "",
    });
  }, [selectedActivityRow?.customer.assignedTenantUserId, selectedActivityRow?.customer.email, selectedActivityRow?.customer.fullName, selectedActivityRow?.customer.id, selectedActivityRow?.customer.phone]);

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
    if (!normalizeUsPhoneDigits(phone)) {
      setDetailsFeedback({ tone: "error", message: "Enter a valid 10-digit US phone number." });
      return;
    }

    setDetailsFeedback(null);
    setDetailsSaving(true);
    try {
      await api.customers.update(selectedActivityRow.customer.id, {
        fullName,
        phone,
        email: customerDetailsDraft.email.trim() || null,
        ...(canManageAssignments ? { assignedTenantUserId: customerDetailsDraft.assignedTenantUserId || null } : {}),
      });
      await Promise.all([loadCustomerPage(), loadCustomers(), loadCustomerDetail(selectedActivityRow.customer.id)]);
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
      await Promise.all([loadCustomerPage(), loadCustomers(), loadCustomerDetail(selectedActivityRow.customer.id)]);
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

    const action = customerRetentionAction;
    setCustomerRetentionSaving(true);
    setError(null);
    try {
      if (action.type === "archive") {
        await api.customers.archive(action.row.customer.id);
        notify.success("Customer archived", {
          description: `${action.row.customer.fullName} and related active quotes left the active workspace. History remains retained.`,
        });
      } else if (action.type === "delete") {
        await api.customers.delete(action.row.customer.id);
        notify.success("Customer removed from the workspace", {
          description: `${action.row.customer.fullName} and related active quotes remain retained for audit history.`,
        });
      } else {
        await api.customers.restore(action.row.customer.id);
        notify.success("Customer restored", {
          description: `${action.row.customer.fullName} is active again. Retained quotes were not restored automatically.`,
        });
      }
      await Promise.all([loadCustomerPage(), loadCustomers(), loadQuotes()]);
      activityRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      setActivityCustomerId(null);
      setCustomerRetentionAction(null);
    } catch (err) {
      notify.error(`Could not ${action.type} customer`, {
        description: err instanceof Error ? err.message : "Please try again. Your customer record was not changed.",
      });
    } finally {
      setCustomerRetentionSaving(false);
    }
  }

  function finishClosingActivityModal() {
    activityRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setActivityCustomerId(null);
  }

  function closeActivityModal(afterClose?: () => void) {
    if (detailsChanged || notesChanged) {
      pendingCustomerCloseActionRef.current = afterClose ?? null;
      setDiscardCustomerChangesOpen(true);
      return;
    }
    finishClosingActivityModal();
    afterClose?.();
  }

  function discardCustomerChangesAndClose() {
    const afterClose = pendingCustomerCloseActionRef.current;
    pendingCustomerCloseActionRef.current = null;
    setDiscardCustomerChangesOpen(false);
    finishClosingActivityModal();
    afterClose?.();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        subtitle="Track customers through a simple sales pipeline, then jump into quoting when they are ready."
        mode="actions-only"
        actions={
          <Button onClick={() => setQuickCustomerOpen(true)}>Add customer</Button>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Customer lifecycle filters">
        {(["active", "archived", "deleted"] as const).map((lifecycle) => (
          <Button
            key={lifecycle}
            size="sm"
            variant={lifecycleFilter === lifecycle ? "primary" : "outline"}
            onClick={() => {
              setLifecycleFilter(lifecycle);
              setCustomerPage(1);
              setStageFilter("ALL");
            }}
          >
            {lifecycle === "active" ? "Active" : lifecycle === "archived" ? "Archived" : "Deleted"} ({lifecycleCounts[lifecycle]})
          </Button>
        ))}
      </div>

      <CustomerPipelineFilterStrip
        totalCount={lifecycleCounts[lifecycleFilter]}
        stageCounts={serverStageCounts}
        stageFilter={stageFilter}
        onChange={(stage) => {
          setStageFilter(stage);
          setCustomerPage(1);
        }}
      />

      <Card variant="elevated" padding="md" className="overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer workspace</p>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                {customerTotal} {customerTotal === 1 ? "customer" : "customers"}
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
          {customerLoading ? (
            <div className="p-4">
              <LoadingState
                title="Loading customers"
                description="Getting the latest tenant-scoped customer list, quote stage, and contact summary."
                variant="table"
                rows={5}
              />
            </div>
          ) : customerRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? "No matching customers" : "Add your first customer"}
                description={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? "Clear the search or choose another stage or lifecycle." : "Create a customer here, then start their first quote."}
                action={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? <Button variant="outline" onClick={() => { setSearchTerm(""); setStageFilter("ALL"); setLifecycleFilter("active"); setCustomerPage(1); }}>Clear filters</Button> : <Button onClick={() => setQuickCustomerOpen(true)}>Add customer</Button>}
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
                {customerRows.map((row) => (
                  <div key={row.customer.id} className="xl:border-b xl:border-slate-200 xl:last:border-b-0">
                    <CustomerDesktopRow
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={openCustomerDetail}
                    />
                    <CustomerMobileCard
                      row={row}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={openCustomerDetail}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      {customerTotal > CUSTOMER_PAGE_SIZE ? (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600">
            Showing {(customerPage - 1) * CUSTOMER_PAGE_SIZE + 1}-{Math.min(customerPage * CUSTOMER_PAGE_SIZE, customerTotal)} of {customerTotal}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={customerPage === 1 || customerLoading}
              onClick={() => setCustomerPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span className="text-xs font-medium text-slate-600">Page {customerPage} of {totalCustomerPages}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={customerPage >= totalCustomerPages || customerLoading}
              onClick={() => setCustomerPage((current) => Math.min(totalCustomerPages, current + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={closeQuickCustomerModal}
        onCreated={async ({ customer, merged, restored, reusedExisting, intent }) => {
          void Promise.all([loadCustomerPage(), loadCustomers()]);
          const message = reusedExisting
              ? "Using existing customer record."
              : merged
                ? restored
                  ? "Customer merged and restored."
                  : "Customer merged into existing record."
                : restored
                  ? "Customer restored."
                  : "Customer created.";
          notify.success(message, { description: `${customer.fullName} is ready in your workspace.` });
          if (intent === "quote") {
            navigateToBuilder(customer.id);
          }
        }}
      />

      <Modal
        open={Boolean(selectedActivityRow)}
        onClose={closeActivityModal}
        size="lg"
        modal={false}
        closeOnBackdrop={false}
        panelClassName="z-[60]"
        ariaLabel="Customer details and activity"
      >
        <ModalHeader
          title={selectedActivityRow ? `${selectedActivityRow.customer.fullName} activity` : "Customer activity"}
          description={selectedActivityRow ? "Timeline of customer entry, contact, quotes, and work progress." : undefined}
          onClose={closeActivityModal}
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

              {selectedCustomerInactive ? (
                <Alert tone="info">
                  This customer is inactive. Restore the customer to edit details or start a new quote. Retained archived or deleted quotes will not be restored automatically.
                </Alert>
              ) : null}

              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer details</p>
                    <p className="mt-1 text-sm text-slate-600">Keep contact information current for calls, texts, and quote delivery.</p>
                  </div>
                  <Button size="sm" onClick={() => void saveCustomerDetails()} disabled={!detailsChanged || detailsSaving || selectedCustomerInactive} loading={detailsSaving}>
                    Save details
                  </Button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className="text-xs font-medium text-slate-700">Name</span>
                    <Input
                      value={customerDetailsDraft.fullName}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, fullName: event.target.value }))}
                      disabled={detailsSaving || selectedCustomerInactive}
                    />
                  </label>
                  {canManageAssignments ? (
                    <div className="sm:col-span-2">
                      <Select
                        label="Assigned to"
                        value={customerDetailsDraft.assignedTenantUserId}
                        onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, assignedTenantUserId: event.target.value }))}
                        disabled={detailsSaving || selectedCustomerInactive}
                        options={[
                          { value: "", label: "Unassigned" },
                          ...workspaceMembers.map((member) => ({ value: member.id, label: `${member.user.fullName} · ${roleLabelForAssignment(member.role)}` })),
                        ]}
                      />
                      <p className="mt-1.5 text-xs text-slate-500">Members see only customers and work assigned to them. Owners and admins see the full workspace.</p>
                    </div>
                  ) : selectedActivityRow.customer.assignedTenantUser ? (
                    <div className="sm:col-span-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-800">
                      Assigned to {selectedActivityRow.customer.assignedTenantUser.user.fullName}
                    </div>
                  ) : null}
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-slate-700">Phone</span>
                    <Input
                      type="tel"
                      value={customerDetailsDraft.phone}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, phone: formatUsPhoneInput(event.target.value) }))}
                      disabled={detailsSaving || selectedCustomerInactive}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-slate-700">Email</span>
                    <Input
                      type="email"
                      value={customerDetailsDraft.email}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, email: event.target.value }))}
                      disabled={detailsSaving || selectedCustomerInactive}
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
                    disabled={!notesChanged || notesSaving || selectedCustomerInactive}
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
                    disabled={notesSaving || selectedCustomerInactive}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quotes</p>
                    <p className="mt-1 text-sm text-slate-600">Open any active quote for this customer or start another.</p>
                  </div>
                  <Button
                    size="sm"
                    icon={<FilePlus2 size={14} />}
                    disabled={Boolean(selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc)}
                    onClick={() => closeActivityModal(() => navigateToBuilder(selectedActivityRow.customer.id))}
                  >
                    New Quote
                  </Button>
                </div>
                {selectedActivityQuotes.length ? (
                  selectedActivityQuotes.map((quote, index) => (
                    <button
                      key={quote.id}
                      type="button"
                      onClick={() => closeActivityModal(() => navigateToQuote(quote.id))}
                      className={`flex min-h-[64px] w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-quotefly-blue ${index > 0 ? "border-t border-slate-200" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{quote.title}</span>
                        <span className="mt-1 block text-xs text-slate-500">{quoteNumber(quote.id)} · {formatQuoteStatus(quote.status)} · Updated {formatDateTime(quote.updatedAt)}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-slate-900">{formatQuoteTotal(quote.totalAmount)}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-5 text-sm text-slate-600">
                    No active quotes. Archived or deleted quotes remain retained but are not reopened automatically when a customer is restored.
                  </div>
                )}
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                {activityLoading ? (
                  <div className="p-4">
                    <LoadingState
                      title="Loading activity"
                      description="Pulling recent customer notes, contact events, and quote movement."
                      variant="list"
                      rows={4}
                    />
                  </div>
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
                            ? "bg-[var(--qf-info-strong)] text-white"
                            : tone === "orange"
                              ? "bg-[var(--qf-warning-strong)] text-white"
                              : tone === "emerald"
                                ? "bg-[var(--qf-success-strong)] text-white"
                                : "bg-slate-700 text-white"
                        }`}
                      >
                        {activityIcon(item)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {item.quoteId ? (
                            <button
                              type="button"
                              className="rounded text-left text-sm font-semibold text-slate-900 hover:text-quotefly-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
                              onClick={() => closeActivityModal(() => navigateToQuote(item.quoteId!))}
                            >
                              {item.title}
                            </button>
                          ) : (
                            <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                          )}
                          <span className="text-xs text-slate-500">{formatDateTime(item.occurredAt)}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-600">{item.detail || "No additional detail captured."}</p>
                        <div className="mt-2 flex items-center justify-between gap-3">
                          {item.quoteId ? (
                            <button
                              type="button"
                              className="text-xs font-semibold text-quotefly-blue hover:underline"
                              onClick={() => closeActivityModal(() => navigateToQuote(item.quoteId!))}
                            >
                              Open quote
                            </button>
                          ) : <span />}
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
            {canManageRecordRetention ? <div className="flex flex-wrap gap-2">
              {selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc ? (
                <Button
                  variant="outline"
                  icon={<ArchiveRestore size={15} />}
                  onClick={() => setCustomerRetentionAction({ type: "restore", row: selectedActivityRow })}
                >
                  Restore customer
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setCustomerRetentionAction({ type: "archive", row: selectedActivityRow })}>
                    Archive
                  </Button>
                  <Button variant="danger" onClick={() => setCustomerRetentionAction({ type: "delete", row: selectedActivityRow })}>
                    Delete
                  </Button>
                </>
              )}
            </div> : <div />}
            <div className="flex flex-wrap gap-2">
              <KodyButton
                label="Ask Kody"
                prompt={`Summarize customer ${selectedActivityRow.customer.fullName}. Show quote status, next follow-up, and anything that helps me move this customer toward a sent or accepted quote.`}
                tool="SEARCH_CUSTOMERS"
                context={{
                  currentPage: "customers",
                  customerId: selectedActivityRow.customer.id,
                  search: selectedActivityRow.customer.fullName,
                  limit: 1,
                }}
                variant="secondary"
                className="shadow-[0_8px_20px_rgba(244,139,37,0.22)]"
              />
              <Button variant="outline" onClick={() => closeActivityModal()}>
                Close
              </Button>
              <Button
                onClick={() => closeActivityModal(() => navigateToBuilder(selectedActivityRow.customer.id))}
                disabled={Boolean(selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc)}
                title={selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc ? "Restore this customer before starting a quote" : undefined}
              >
                New Quote
              </Button>
            </div>
          </ModalFooter>
        ) : null}
      </Modal>

      <ConfirmModal
        open={discardCustomerChangesOpen}
        onClose={() => {
          pendingCustomerCloseActionRef.current = null;
          setDiscardCustomerChangesOpen(false);
        }}
        onConfirm={discardCustomerChangesAndClose}
        title="Discard unsaved customer changes?"
        description="Contact details or notes changed in this window will be lost."
        confirmLabel="Discard changes"
        confirmVariant="warning"
      />

      <ConfirmModal
        open={Boolean(customerRetentionAction)}
        onClose={() => {
          if (!customerRetentionSaving) setCustomerRetentionAction(null);
        }}
        onConfirm={() => void confirmCustomerRetentionAction()}
        title={
          customerRetentionAction?.type === "archive"
            ? "Archive customer?"
            : customerRetentionAction?.type === "delete"
              ? "Delete customer?"
              : "Restore customer?"
        }
        description={
          customerRetentionAction?.type === "archive"
            ? "This customer will leave the active workspace but remain retained in the database and audit history. Related active quotes will be archived too."
            : customerRetentionAction?.type === "delete"
              ? "This customer will leave the active workspace but remain retained in the database and audit history. Related active quotes will be deleted too."
              : "The customer will return to the active workspace. Retained archived or deleted quotes will remain inactive and will not be restored automatically."
        }
        confirmLabel={customerRetentionAction?.type === "archive" ? "Archive customer" : customerRetentionAction?.type === "delete" ? "Delete customer" : "Restore customer"}
        loading={customerRetentionSaving}
        confirmVariant={customerRetentionAction?.type === "delete" ? "danger" : customerRetentionAction?.type === "archive" ? "warning" : "primary"}
      />
    </div>
  );
}






