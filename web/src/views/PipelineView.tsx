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

function compactDateTime(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) {
    return `Today, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
      ? "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]"
      : tone === "emerald"
        ? "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"
        : tone === "amber"
          ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]";

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
      ? "bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]"
      : tone === "orange"
        ? "bg-[var(--qf-warning-strong)] text-white"
      : tone === "emerald"
          ? "bg-[var(--qf-success-strong)] text-white"
          : "bg-slate-800 text-white";

  return (
    <div data-testid="follow-up-metric" className={`min-w-0 rounded-xl px-3 py-3 sm:px-4 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
      <p className="mt-2 truncate text-xl font-bold tracking-tight sm:text-2xl">{currency ? money(value) : value}</p>
    </div>
  );
}

function UtilityRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3">
      <div className="inline-flex items-center gap-2 text-sm text-[var(--qf-text-soft)]">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--qf-panel-muted)] text-[var(--qf-link)]">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold text-[var(--qf-text)]">{value}</span>
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
    <div data-testid="follow-up-queue-tabs" className="grid w-full grid-cols-3 gap-2 sm:flex sm:flex-wrap">
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1.5 py-2 text-[11px] font-medium transition sm:min-h-[36px] sm:flex-none sm:rounded-full sm:px-3 sm:py-1.5 sm:text-sm ${
              active
                ? "border-[var(--qf-selected-border)] bg-[var(--qf-selected)] text-[var(--qf-link)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
            }`}
          >
            <span className="truncate">{tab.label}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold sm:px-2 sm:text-[11px] ${active ? "bg-[var(--qf-panel)] text-[var(--qf-link)]" : "bg-[var(--qf-panel-muted)] text-[var(--qf-text-muted)]"}`}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function QueueActions({
  lead,
  actionKind,
  saving,
  mobile = false,
  onNavigateToQuote,
  onNavigateToBuilder,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  lead: PipelineLead;
  actionKind: QueueActionKind;
  saving: boolean;
  mobile?: boolean;
  onNavigateToQuote: (quoteId: string) => void;
  onNavigateToBuilder: (customerId: string) => void;
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { jobStatus?: QuoteJobStatus; afterSaleFollowUpStatus?: AfterSaleFollowUpStatus },
  ) => void;
}) {
  const selectClassName = mobile ? "min-w-0 w-full" : "w-full min-w-[150px] sm:w-auto";

  return (
    <div className={mobile ? "grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2" : "mt-2 flex flex-col gap-2 sm:flex-row sm:items-center xl:mt-0 xl:flex-col xl:items-end"}>
      <Button
        size="sm"
        variant={lead.quoteId ? "outline" : "primary"}
        className="w-full sm:w-auto"
        onClick={() => lead.quoteId ? onNavigateToQuote(lead.quoteId) : onNavigateToBuilder(lead.customerId)}
      >
        {lead.quoteId ? "Open quote" : "Draft quote"}
      </Button>

      {actionKind === "follow_up" ? (
        <Select
          aria-label={`Update follow-up for ${lead.customerName}`}
          value={lead.followUpStatus}
          disabled={saving}
          onChange={(event) => onUpdateFollowUp?.(lead.customerId, event.target.value as LeadFollowUpStatus)}
          options={FOLLOW_UP_OPTIONS}
          className={selectClassName}
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
          className={selectClassName}
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
          className={selectClassName}
        />
      ) : null}
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
  onNavigateToBuilder,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  lead: PipelineLead;
  index: number;
  actionKind: QueueActionKind;
  saving: boolean;
  activeQuoteId?: string | null;
  onNavigateToQuote: (quoteId: string) => void;
  onNavigateToBuilder: (customerId: string) => void;
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { jobStatus?: QuoteJobStatus; afterSaleFollowUpStatus?: AfterSaleFollowUpStatus },
  ) => void;
}) {
  const touchLabel = lead.afterSaleFollowUpDueAtUtc ? formatDateTime(lead.afterSaleFollowUpDueAtUtc) : formatDateTime(lead.createdAt);
  const renderStatusPills = () => (
    <>
      <FollowUpPill status={lead.followUpStatus} compact />
      {lead.status ? <QuoteStatusPill status={lead.status} compact /> : <LifecyclePill label="No quote" tone="slate" />}
      {actionKind === "job_status" && lead.jobStatus ? (
        <LifecyclePill label={jobStatusLabel(lead.jobStatus)} tone={lead.jobStatus === "COMPLETED" ? "emerald" : lead.jobStatus === "IN_PROGRESS" ? "blue" : "slate"} />
      ) : null}
      {actionKind === "after_sale" && lead.afterSaleFollowUpStatus ? (
        <LifecyclePill label={afterSaleLabel(lead.afterSaleFollowUpStatus)} tone={lead.afterSaleFollowUpStatus === "COMPLETED" ? "emerald" : "amber"} />
      ) : null}
    </>
  );

  return (
    <article data-testid="follow-up-queue-row" className={`transition hover:bg-[var(--qf-interactive-hover)] ${lead.quoteId && lead.quoteId === activeQuoteId ? "bg-[var(--qf-selected)]" : ""}`}>
      <div className="p-4 xl:hidden">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
            {customerInitials(lead.customerName)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</p>
              <span className="shrink-0 rounded-full bg-[var(--qf-panel-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--qf-text-muted)]">#{index + 1}</span>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">Added {compactDateTime(lead.createdAt)}</p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <a href={`tel:${lead.phone}`} className="inline-flex min-h-10 min-w-0 items-center gap-2 rounded-xl bg-[var(--qf-panel-muted)] px-3 text-[var(--qf-text-soft)] hover:text-[var(--qf-link)]">
            <CallIcon size={13} />
            <span className="truncate">{lead.phone}</span>
          </a>
          {lead.email ? (
            <a href={`mailto:${lead.email}`} className="inline-flex min-h-10 min-w-0 items-center gap-2 rounded-xl bg-[var(--qf-panel-muted)] px-3 text-[var(--qf-text-soft)] hover:text-[var(--qf-link)]">
              <EmailIcon size={13} />
              <span className="truncate">{lead.email}</span>
            </a>
          ) : null}
        </div>

        <div className="mt-3 flex min-w-0 items-center justify-between gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--qf-text)]">{lead.quoteTitle ?? "No quote drafted yet"}</p>
            <p className="mt-0.5 text-xs text-[var(--qf-text-muted)]">{nextActionLabel(lead, actionKind)}</p>
          </div>
          <span className="shrink-0 text-sm font-semibold text-[var(--qf-text)]">{lead.totalAmount !== undefined ? money(lead.totalAmount) : "—"}</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">{renderStatusPills()}</div>

        <div className="my-3 flex items-center justify-between gap-3 text-xs text-[var(--qf-text-muted)]">
          <span>Last activity</span>
          <span className="truncate text-right font-medium text-[var(--qf-text-soft)]">{compactDateTime(lead.afterSaleFollowUpDueAtUtc ?? lead.createdAt)}</span>
        </div>

        <QueueActions
          lead={lead}
          actionKind={actionKind}
          saving={saving}
          mobile
          onNavigateToQuote={onNavigateToQuote}
          onNavigateToBuilder={onNavigateToBuilder}
          onUpdateFollowUp={onUpdateFollowUp}
          onUpdateQuoteLifecycle={onUpdateQuoteLifecycle}
        />
      </div>

      <div className="hidden gap-3 px-4 py-3 xl:grid xl:grid-cols-[minmax(0,1.95fr)_minmax(0,1fr)_180px_132px_154px] xl:items-center 2xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--qf-panel-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{index + 1}</span>
            <span className="text-xs text-[var(--qf-text-muted)]">Created {formatDateTime(lead.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">{customerInitials(lead.customerName)}</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--qf-text-soft)]">
                <span className="inline-flex items-center gap-1"><CallIcon size={12} />{lead.phone}</span>
                {lead.email ? <span className="inline-flex items-center gap-1"><EmailIcon size={12} />{lead.email}</span> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          {lead.quoteTitle ? (
            <>
              <p className="truncate text-sm font-medium text-[var(--qf-text)]">{lead.quoteTitle}</p>
              <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{lead.totalAmount !== undefined ? money(lead.totalAmount) : "No total yet"}</p>
            </>
          ) : (
            <p className="text-sm text-[var(--qf-text-muted)]">No quote drafted yet.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">{renderStatusPills()}</div>

        <div className="space-y-1 text-xs text-[var(--qf-text-muted)]">
          <p>{touchLabel}</p>
          <p className="font-medium text-[var(--qf-text-soft)]">{nextActionLabel(lead, actionKind)}</p>
        </div>

        <QueueActions
          lead={lead}
          actionKind={actionKind}
          saving={saving}
          onNavigateToQuote={onNavigateToQuote}
          onNavigateToBuilder={onNavigateToBuilder}
          onUpdateFollowUp={onUpdateFollowUp}
          onUpdateQuoteLifecycle={onUpdateQuoteLifecycle}
        />
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
      label: "Post-job",
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
        title="Follow-up"
        subtitle="Keep leads and jobs moving: new customers first, quoted work next, then completed-job check-ins."
        mode="actions-only"
        actions={selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : undefined}
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.45fr)_320px]">
        <div className="space-y-4">
          <div data-testid="follow-up-metrics" className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            <MetricTile label="Needs attention" value={nextAttentionCount} tone="orange" />
            <MetricTile label="New leads" value={pipeline.totals.newLeads} tone="blue" />
            <MetricTile label="Active work" value={pipeline.totals.closedLeads} tone="emerald" />
            <MetricTile label="Revenue" value={stats.acceptedRevenue} tone="slate" currency />
          </div>

          <Card variant="default" padding="md" className="overflow-hidden p-0 sm:p-5">
            <div className="flex flex-col gap-3 border-b border-[var(--qf-border)] p-4 sm:mb-4 sm:p-0 sm:pb-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Lead queue</p>
                <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-[var(--qf-text)]">{activeQueue.title}</h2>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{activeQueue.subtitle}</p>
              </div>
              <div className="min-w-0 max-w-full lg:w-auto">
                <QueueTabs tabs={queueTabs} activeTab={activeTab} onChange={setActiveTab} />
              </div>
            </div>

            <div data-testid="follow-up-queue" className="overflow-hidden bg-[var(--qf-panel)] sm:rounded-xl sm:border sm:border-[var(--qf-border)]">
              {activeQueue.leads.length === 0 ? (
                <div className="p-4">
                  <EmptyState title={activeQueue.emptyTitle} description={activeQueue.emptyDescription} />
                </div>
              ) : (
                <>
                  <div className="hidden grid-cols-[minmax(0,1.95fr)_minmax(0,1fr)_180px_132px_154px] gap-4 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] xl:grid 2xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px]">
                    <span>Lead</span>
                    <span>Quote</span>
                    <span>Status</span>
                    <span>Touch</span>
                    <span>Action</span>
                  </div>
                  <div className="divide-y divide-[var(--qf-border)]">
                    {activeQueue.leads.map((lead, index) => (
                      <QueueRow
                        key={`${lead.customerId}-${lead.quoteId ?? "row"}`}
                        lead={lead}
                        index={index}
                        actionKind={activeQueue.actionKind}
                        saving={saving}
                        activeQuoteId={selectedQuoteId}
                        onNavigateToQuote={navigateToQuote}
                        onNavigateToBuilder={navigateToBuilder}
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

        <div className="hidden space-y-4 xl:block">
          <Card variant="default" padding="md">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Queue focus</p>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">Keep one list moving at a time.</p>
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
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Recent leads</p>
            <div className="mt-3 space-y-2.5">
              {pipeline.recentLeads.slice(0, 4).length > 0 ? (
                pipeline.recentLeads.slice(0, 4).map((lead) => (
                  <button
                    key={`${lead.customerId}-${lead.quoteId ?? "recent"}`}
                    type="button"
                    onClick={() => (lead.quoteId ? navigateToQuote(lead.quoteId) : navigateToBuilder(lead.customerId))}
                    className="flex w-full items-start gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3 text-left transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
                      {customerInitials(lead.customerName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</span>
                      <span className="mt-1 block text-xs text-[var(--qf-text-muted)]">{lead.quoteTitle ?? "No quote yet"}</span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="rounded-[14px] border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text-muted)]">
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
