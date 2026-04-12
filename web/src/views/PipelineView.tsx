import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CallIcon, ClockIcon, CustomerIcon, EmailIcon, QuoteIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select } from "../components/ui";
import { FollowUpPill, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import type { AfterSaleFollowUpStatus, LeadFollowUpStatus, QuoteJobStatus } from "../lib/api";
import { usePageView } from "../lib/analytics";

type PipelineLead = ReturnType<typeof useDashboard>["pipeline"]["newLeads"][number];
type QueueTab = "new" | "quoted" | "closed" | "afterSale" | "recent";

const FOLLOW_UP_STATUSES: LeadFollowUpStatus[] = ["NEEDS_FOLLOW_UP", "FOLLOWED_UP", "WON", "LOST"];
const JOB_STATUSES: QuoteJobStatus[] = ["NOT_STARTED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"];
const AFTER_SALE_STATUSES: AfterSaleFollowUpStatus[] = ["NOT_READY", "DUE", "COMPLETED"];

const FOLLOW_UP_OPTIONS = FOLLOW_UP_STATUSES.map((status) => ({ value: status, label: followUpLabel(status) }));
const JOB_STATUS_OPTIONS = JOB_STATUSES.map((status) => ({ value: status, label: jobStatusLabel(status) }));
const AFTER_SALE_OPTIONS = AFTER_SALE_STATUSES.map((status) => ({ value: status, label: afterSaleLabel(status) }));

function followUpLabel(status: LeadFollowUpStatus): string {
  if (status === "NEEDS_FOLLOW_UP") return "Needs Follow Up";
  if (status === "FOLLOWED_UP") return "Followed Up";
  if (status === "WON") return "Won";
  return "Lost";
}

function jobStatusLabel(status: QuoteJobStatus): string {
  if (status === "NOT_STARTED") return "Not Started";
  if (status === "IN_PROGRESS") return "In Progress";
  return status.charAt(0) + status.slice(1).toLowerCase().replace("_", " ");
}

function afterSaleLabel(status: AfterSaleFollowUpStatus): string {
  if (status === "NOT_READY") return "Not Ready";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function nextActionLabel(lead: PipelineLead, actionKind: QueueActionKind) {
  if (actionKind === "job_status") return "Move work forward";
  if (actionKind === "after_sale") return "Ask for review or referral";
  if (!lead.quoteId) return "Draft first quote";
  return "Follow up with customer";
}

function sectionToneBadge(tone: "blue" | "orange" | "emerald" | "slate") {
  return tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue";
}

type QueueActionKind = "follow_up" | "job_status" | "after_sale" | "none";

type QueueConfig = {
  key: QueueTab;
  label: string;
  title: string;
  subtitle: string;
  count: number;
  leads: PipelineLead[];
  actionKind: QueueActionKind;
  tone: "blue" | "orange" | "emerald" | "slate";
  emptyTitle: string;
  emptyDescription: string;
};

function LifecyclePill({ label, tone }: { label: string; tone: "slate" | "blue" | "emerald" | "amber" }) {
  const toneClass =
    tone === "blue"
      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue"
      : tone === "emerald"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-slate-200 bg-slate-50 text-slate-600";

  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}>{label}</span>;
}

function MetricTile({
  label,
  value,
  tone,
  currency = false,
}: {
  label: string;
  value: number;
  tone: "blue" | "orange" | "emerald" | "slate";
  currency?: boolean;
}) {
  const toneClass =
    tone === "blue"
      ? "bg-quotefly-blue text-white"
      : tone === "orange"
        ? "bg-quotefly-orange text-white"
        : tone === "emerald"
          ? "bg-emerald-600 text-white"
          : "bg-slate-800 text-white";

  return (
    <div className={`rounded-xl px-4 py-3 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight">{currency ? money(value) : value}</p>
    </div>
  );
}

function UtilityRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div className="inline-flex items-center gap-2 text-sm text-slate-700">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50 text-quotefly-blue">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function QueueTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: QueueConfig[];
  activeTab: QueueTab;
  onChange: (tab: QueueTab) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
              active
                ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <span>{tab.label}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${active ? "bg-white text-quotefly-blue" : "bg-slate-100 text-slate-600"}`}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function QueueRow({
  lead,
  index,
  actionKind,
  saving,
  activeQuoteId,
  onNavigateToQuote,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  lead: PipelineLead;
  index: number;
  actionKind: QueueActionKind;
  saving: boolean;
  activeQuoteId?: string | null;
  onNavigateToQuote: (quoteId: string) => void;
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { jobStatus?: QuoteJobStatus; afterSaleFollowUpStatus?: AfterSaleFollowUpStatus },
  ) => void;
}) {
  const touchLabel = lead.afterSaleFollowUpDueAtUtc ? formatDateTime(lead.afterSaleFollowUpDueAtUtc) : formatDateTime(lead.createdAt);

  return (
    <article className={`px-4 py-3 transition hover:bg-slate-50/80 ${lead.quoteId && lead.quoteId === activeQuoteId ? "bg-quotefly-blue/[0.04]" : ""}`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{index + 1}</span>
            <span className="text-xs text-slate-500">Created {formatDateTime(lead.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">{customerInitials(lead.customerName)}</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{lead.customerName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1"><CallIcon size={12} />{lead.phone}</span>
                {lead.email ? <span className="inline-flex items-center gap-1"><EmailIcon size={12} />{lead.email}</span> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          {lead.quoteTitle ? (
            <>
              <p className="truncate text-sm font-medium text-slate-900">{lead.quoteTitle}</p>
              <p className="mt-1 text-xs text-slate-500">{lead.totalAmount !== undefined ? money(lead.totalAmount) : "No total yet"}</p>
            </>
          ) : (
            <p className="text-sm text-slate-500">No quote drafted yet.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FollowUpPill status={lead.followUpStatus} compact />
          {lead.status ? <QuoteStatusPill status={lead.status} compact /> : <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600">No Quote</span>}
          {actionKind === "job_status" && lead.jobStatus ? (
            <LifecyclePill label={jobStatusLabel(lead.jobStatus)} tone={lead.jobStatus === "COMPLETED" ? "emerald" : lead.jobStatus === "IN_PROGRESS" ? "blue" : "slate"} />
          ) : null}
          {actionKind === "after_sale" && lead.afterSaleFollowUpStatus ? (
            <LifecyclePill label={afterSaleLabel(lead.afterSaleFollowUpStatus)} tone={lead.afterSaleFollowUpStatus === "COMPLETED" ? "emerald" : "amber"} />
          ) : null}
        </div>

        <div className="space-y-1 text-xs text-slate-500">
          <p>{touchLabel}</p>
          <p className="font-medium text-slate-700">{nextActionLabel(lead, actionKind)}</p>
        </div>

        <div className="flex flex-col gap-2 lg:items-end">
          {lead.quoteId ? (
            <Button size="sm" variant="outline" onClick={() => onNavigateToQuote(lead.quoteId!)}>Open Quote</Button>
          ) : (
            <Button size="sm" variant="outline" disabled>Draft Needed</Button>
          )}

          {actionKind === "follow_up" ? (
            <Select
              aria-label={`Update follow-up for ${lead.customerName}`}
              value={lead.followUpStatus}
              disabled={saving}
              onChange={(event) => onUpdateFollowUp?.(lead.customerId, event.target.value as LeadFollowUpStatus)}
              options={FOLLOW_UP_OPTIONS}
              className="min-w-[150px]"
            />
          ) : actionKind === "job_status" ? (
            <Select
              aria-label={`Update job stage for ${lead.customerName}`}
              value={lead.jobStatus ?? "NOT_STARTED"}
              disabled={saving || !lead.quoteId}
              onChange={(event) =>
                lead.quoteId && onUpdateQuoteLifecycle?.(lead.quoteId, { jobStatus: event.target.value as QuoteJobStatus })
              }
              options={JOB_STATUS_OPTIONS}
              className="min-w-[150px]"
            />
          ) : actionKind === "after_sale" ? (
            <Select
              aria-label={`Update after-sale for ${lead.customerName}`}
              value={lead.afterSaleFollowUpStatus ?? "DUE"}
              disabled={saving || !lead.quoteId}
              onChange={(event) =>
                lead.quoteId && onUpdateQuoteLifecycle?.(lead.quoteId, { afterSaleFollowUpStatus: event.target.value as AfterSaleFollowUpStatus })
              }
              options={AFTER_SALE_OPTIONS}
              className="min-w-[150px]"
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function PipelineView() {
  usePageView("pipeline");
  const {
    stats,
    pipeline,
    saving,
    error,
    notice,
    setError,
    setNotice,
    updateLeadFollowUpStatus,
    updateQuoteLifecycle,
    navigateToQuote,
    navigateToBuilder,
    selectedQuoteId,
  } = useDashboard();
  const [activeTab, setActiveTab] = useState<QueueTab>("new");

  const nextAttentionCount = pipeline.totals.newLeads + pipeline.totals.quotedLeads;
  const activeCustomerCount =
    pipeline.totals.newLeads +
    pipeline.totals.quotedLeads +
    pipeline.totals.closedLeads +
    pipeline.totals.afterSaleLeads;

  const queueTabs = useMemo<QueueConfig[]>(() => [
    {
      key: "new",
      label: "New",
      title: `New Leads (${pipeline.totals.newLeads})`,
      subtitle: "Untouched leads first, oldest to newest.",
      count: pipeline.totals.newLeads,
      leads: pipeline.newLeads,
      actionKind: "follow_up",
      tone: "blue",
      emptyTitle: "No new leads",
      emptyDescription: "No leads waiting for first quote.",
    },
    {
      key: "quoted",
      label: "Quoted",
      title: `Quoted Leads (${pipeline.totals.quotedLeads})`,
      subtitle: "Quoted jobs that still need follow-up.",
      count: pipeline.totals.quotedLeads,
      leads: pipeline.quotedLeads,
      actionKind: "follow_up",
      tone: "orange",
      emptyTitle: "No quoted leads",
      emptyDescription: "Quoted jobs will appear here.",
    },
    {
      key: "closed",
      label: "Closed",
      title: `Closed Leads (${pipeline.totals.closedLeads})`,
      subtitle: "Accepted jobs that are scheduled or in progress.",
      count: pipeline.totals.closedLeads,
      leads: pipeline.closedLeads,
      actionKind: "job_status",
      tone: "emerald",
      emptyTitle: "No closed leads",
      emptyDescription: "Accepted jobs will appear here once marked as won.",
    },
    {
      key: "afterSale",
      label: "After-Sale",
      title: `After-Sale Follow-Up (${pipeline.totals.afterSaleLeads})`,
      subtitle: "Completed jobs waiting on review, referral, or post-job check-in.",
      count: pipeline.totals.afterSaleLeads,
      leads: pipeline.afterSaleLeads,
      actionKind: "after_sale",
      tone: "slate",
      emptyTitle: "No after-sale follow-up due",
      emptyDescription: "Completed jobs will appear here when follow-up is due.",
    },
    {
      key: "recent",
      label: "Recent",
      title: "Recently Added Leads",
      subtitle: "Newest customer records, regardless of quote status.",
      count: pipeline.recentLeads.length,
      leads: pipeline.recentLeads,
      actionKind: "follow_up",
      tone: "blue",
      emptyTitle: "No recent leads",
      emptyDescription: "Customer records will show here once created.",
    },
  ], [pipeline]);

  const activeQueue = queueTabs.find((tab) => tab.key === activeTab) ?? queueTabs[0];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pipeline"
        subtitle="Work the queue in order: untouched leads first, quoted jobs next, active work after that, then reviews and referrals."
        actions={
          <>
            <Button variant="outline" onClick={() => navigateToBuilder()}>
              Build Quote
            </Button>
            {selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : null}
          </>
        }
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_320px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="Needs attention" value={nextAttentionCount} tone="orange" />
            <MetricTile label="New leads" value={pipeline.totals.newLeads} tone="blue" />
            <MetricTile label="Active work" value={pipeline.totals.closedLeads} tone="emerald" />
            <MetricTile label="Revenue" value={stats.acceptedRevenue} tone="slate" currency />
          </div>

          <Card variant="default" padding="md">
            <div className="mb-4 flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Lead Queue</p>
                <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">{activeQueue.title}</h2>
                <p className="mt-1 text-sm text-slate-600">{activeQueue.subtitle}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <QueueTabs tabs={queueTabs} activeTab={activeTab} onChange={setActiveTab} />
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {activeQueue.leads.length === 0 ? (
                <div className="p-4">
                  <EmptyState title={activeQueue.emptyTitle} description={activeQueue.emptyDescription} />
                </div>
              ) : (
                <>
                  <div className="hidden grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                    <span>Lead</span>
                    <span>Quote</span>
                    <span>Status</span>
                    <span>Touch</span>
                    <span>Action</span>
                  </div>
                  <div className="divide-y divide-slate-200">
                    {activeQueue.leads.map((lead, index) => (
                      <QueueRow
                        key={`${lead.customerId}-${lead.quoteId ?? "row"}`}
                        lead={lead}
                        index={index}
                        actionKind={activeQueue.actionKind}
                        saving={saving}
                        activeQuoteId={selectedQuoteId}
                        onNavigateToQuote={navigateToQuote}
                        onUpdateFollowUp={(customerId, followUpStatus) => void updateLeadFollowUpStatus(customerId, followUpStatus)}
                        onUpdateQuoteLifecycle={(quoteId, patch) => void updateQuoteLifecycle(quoteId, patch)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card variant="default" padding="md">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Queue focus</p>
                <p className="mt-1 text-sm text-slate-600">Keep one list moving at a time.</p>
              </div>
              <Badge tone={sectionToneBadge(activeQueue.tone)}>{activeQueue.count} active</Badge>
            </div>
            <div className="mt-3 space-y-2.5">
              <UtilityRow icon={<ClockIcon size={14} />} label="Needs touch today" value={String(nextAttentionCount)} />
              <UtilityRow icon={<CustomerIcon size={14} />} label="Active customers" value={String(activeCustomerCount)} />
              <UtilityRow icon={<QuoteIcon size={14} />} label="Quotes this month" value={String(stats.monthlyQuotes)} />
            </div>
            <div className="mt-4 grid gap-2">
              <Button fullWidth variant="outline" onClick={() => navigateToBuilder()}>
                Start New Quote
              </Button>
              {selectedQuoteId ? (
                <Button fullWidth onClick={() => navigateToQuote(selectedQuoteId)}>
                  Open Active Quote
                </Button>
              ) : null}
            </div>
          </Card>

          <Card variant="default" padding="md">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Recent leads</p>
            <div className="mt-3 space-y-2.5">
              {pipeline.recentLeads.slice(0, 4).length > 0 ? (
                pipeline.recentLeads.slice(0, 4).map((lead) => (
                  <button
                    key={`${lead.customerId}-${lead.quoteId ?? "recent"}`}
                    type="button"
                    onClick={() => (lead.quoteId ? navigateToQuote(lead.quoteId) : navigateToBuilder(lead.customerId))}
                    className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
                      {customerInitials(lead.customerName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{lead.customerName}</span>
                      <span className="mt-1 block text-xs text-slate-500">{lead.quoteTitle ?? "No quote yet"}</span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="rounded-[14px] border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                  New leads will appear here.
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
