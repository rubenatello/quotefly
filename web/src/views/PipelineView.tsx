import type { ReactNode } from "react";
import { CallIcon, ClockIcon, CustomerIcon, EmailIcon, QuoteIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select } from "../components/ui";
import { FollowUpPill, PipelineFlow, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { WorkspaceJumpBar, WorkspaceSection } from "../components/ui/workspace";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import type { AfterSaleFollowUpStatus, LeadFollowUpStatus, QuoteJobStatus } from "../lib/api";
import { usePageView } from "../lib/analytics";

type PipelineLead = ReturnType<typeof useDashboard>["pipeline"]["newLeads"][number];

const FOLLOW_UP_STATUSES: LeadFollowUpStatus[] = [
  "NEEDS_FOLLOW_UP",
  "FOLLOWED_UP",
  "WON",
  "LOST",
];

const JOB_STATUSES: QuoteJobStatus[] = [
  "NOT_STARTED",
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
];

const AFTER_SALE_STATUSES: AfterSaleFollowUpStatus[] = [
  "NOT_READY",
  "DUE",
  "COMPLETED",
];

const FOLLOW_UP_OPTIONS = FOLLOW_UP_STATUSES.map((status) => ({
  value: status,
  label: followUpLabel(status),
}));

const JOB_STATUS_OPTIONS = JOB_STATUSES.map((status) => ({
  value: status,
  label: jobStatusLabel(status),
}));

const AFTER_SALE_OPTIONS = AFTER_SALE_STATUSES.map((status) => ({
  value: status,
  label: afterSaleLabel(status),
}));

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

function LifecyclePill({
  label,
  tone,
}: {
  label: string;
  tone: "slate" | "blue" | "emerald" | "amber";
}) {
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

function sectionBadgeTone(tone: "blue" | "orange" | "emerald" | "slate") {
  return tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue";
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function nextActionLabel(
  lead: PipelineLead,
  actionKind: "follow_up" | "job_status" | "after_sale" | "none",
) {
  if (actionKind === "job_status") return "Move work forward";
  if (actionKind === "after_sale") return "Ask for review or referral";
  if (!lead.quoteId) return "Draft first quote";
  return "Follow up with customer";
}

function PipelineRowsSection({
  sectionId,
  step,
  title,
  subtitle,
  leads,
  emptyTitle,
  emptyDescription,
  saving,
  onNavigateToQuote,
  activeQuoteId,
  actionKind,
  tone,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  sectionId: string;
  step: string;
  title: string;
  subtitle: string;
  leads: PipelineLead[];
  emptyTitle: string;
  emptyDescription: string;
  saving: boolean;
  onNavigateToQuote: (quoteId: string) => void;
  activeQuoteId?: string | null;
  actionKind: "follow_up" | "job_status" | "after_sale" | "none";
  tone: "blue" | "orange" | "emerald" | "slate";
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { jobStatus?: QuoteJobStatus; afterSaleFollowUpStatus?: AfterSaleFollowUpStatus },
  ) => void;
}) {
  return (
    <WorkspaceSection
      id={sectionId}
      step={step}
      title={title}
      description={subtitle}
      actions={<Badge tone={sectionBadgeTone(tone)}>{leads.length} active</Badge>}
    >
      <Card variant="default" padding="md" className="overflow-hidden">
        {leads.length === 0 ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
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
              {leads.map((lead, index) => {
                const touchLabel = lead.afterSaleFollowUpDueAtUtc
                  ? formatDateTime(lead.afterSaleFollowUpDueAtUtc)
                  : formatDateTime(lead.createdAt);

                return (
                  <article
                    key={`${lead.customerId}-${lead.quoteId ?? "no-quote"}`}
                    className={`px-4 py-3 transition hover:bg-slate-50/70 ${lead.quoteId && lead.quoteId === activeQuoteId ? "bg-quotefly-blue/[0.04]" : ""}`}
                  >
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            {index + 1}
                          </span>
                          <span className="text-xs text-slate-500">Created {formatDateTime(lead.createdAt)}</span>
                        </div>
                        <div className="mt-1.5 flex items-start gap-3">
                          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
                            {customerInitials(lead.customerName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{lead.customerName}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                              <span className="inline-flex items-center gap-1">
                                <CallIcon size={12} />
                                {lead.phone}
                              </span>
                              {lead.email ? (
                                <span className="inline-flex items-center gap-1">
                                  <EmailIcon size={12} />
                                  {lead.email}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="min-w-0">
                        {lead.quoteTitle ? (
                          <>
                            <p className="truncate text-sm font-medium text-slate-900">{lead.quoteTitle}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {lead.totalAmount !== undefined ? money(lead.totalAmount) : "No total yet"}
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-slate-500">No quote drafted yet.</p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <FollowUpPill status={lead.followUpStatus} compact />
                        {lead.status ? (
                          <QuoteStatusPill status={lead.status} compact />
                        ) : (
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                            No Quote
                          </span>
                        )}
                        {actionKind === "job_status" && lead.jobStatus ? (
                          <LifecyclePill
                            label={jobStatusLabel(lead.jobStatus)}
                            tone={lead.jobStatus === "COMPLETED" ? "emerald" : lead.jobStatus === "IN_PROGRESS" ? "blue" : "slate"}
                          />
                        ) : null}
                        {actionKind === "after_sale" && lead.afterSaleFollowUpStatus ? (
                          <LifecyclePill
                            label={afterSaleLabel(lead.afterSaleFollowUpStatus)}
                            tone={lead.afterSaleFollowUpStatus === "COMPLETED" ? "emerald" : "amber"}
                          />
                        ) : null}
                      </div>

                      <div className="space-y-1 text-xs text-slate-500">
                        <p>{touchLabel}</p>
                        <p className="font-medium text-slate-700">{nextActionLabel(lead, actionKind)}</p>
                      </div>

                      <div className="flex flex-col gap-2 lg:items-end">
                        {lead.quoteId ? (
                          <Button size="sm" variant="outline" onClick={() => onNavigateToQuote(lead.quoteId!)}>
                            Open Quote
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" disabled>
                            Draft Needed
                          </Button>
                        )}

                        {actionKind === "follow_up" ? (
                          <Select
                            aria-label={`Update follow-up for ${lead.customerName}`}
                            value={lead.followUpStatus}
                            disabled={saving}
                            onChange={(event) =>
                              onUpdateFollowUp?.(lead.customerId, event.target.value as LeadFollowUpStatus)
                            }
                            options={FOLLOW_UP_OPTIONS}
                            className="min-w-[150px]"
                          />
                        ) : actionKind === "job_status" ? (
                          <Select
                            aria-label={`Update job stage for ${lead.customerName}`}
                            value={lead.jobStatus ?? "NOT_STARTED"}
                            disabled={saving || !lead.quoteId}
                            onChange={(event) =>
                              lead.quoteId &&
                              onUpdateQuoteLifecycle?.(lead.quoteId, {
                                jobStatus: event.target.value as QuoteJobStatus,
                              })
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
                              lead.quoteId &&
                              onUpdateQuoteLifecycle?.(lead.quoteId, {
                                afterSaleFollowUpStatus: event.target.value as AfterSaleFollowUpStatus,
                              })
                            }
                            options={AFTER_SALE_OPTIONS}
                            className="min-w-[150px]"
                          />
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </WorkspaceSection>
  );
}

export function PipelineView() {
  usePageView("pipeline");
  const {
    session, stats, pipeline, saving, error, notice,
    setError, setNotice, updateLeadFollowUpStatus, updateQuoteLifecycle, navigateToQuote, navigateToBuilder, selectedQuoteId,
  } = useDashboard();

  const pipelineLinks = [
    { id: "pipeline-overview", label: "Overview", hint: "Totals + actions" },
    { id: "pipeline-new", label: "New Leads", hint: "Untouched first" },
    { id: "pipeline-quoted", label: "Quoted", hint: "Follow-ups" },
    { id: "pipeline-closed", label: "Closed", hint: "Active work" },
    { id: "pipeline-after-sale", label: "After-Sale", hint: "Reviews + referrals" },
    { id: "pipeline-recent", label: "Recent", hint: "Newest customers" },
  ];

  const nextAttentionCount = pipeline.totals.newLeads + pipeline.totals.quotedLeads;
  const activeCustomerCount =
    pipeline.totals.newLeads +
    pipeline.totals.quotedLeads +
    pipeline.totals.closedLeads +
    pipeline.totals.afterSaleLeads;

  return (
    <div className="space-y-5">
      <PageHeader
        title={session?.fullName ? `Welcome, ${session.fullName.split(" ")[0]}` : "QuoteFly CRM"}
        subtitle="Work top-down through your queue: untouched leads first, quoted jobs next, active work after that, then reviews and referrals."
        actions={
          <>
            <Button variant="outline" onClick={() => navigateToBuilder()}>
              Build Quote
            </Button>
            {selectedQuoteId ? (
              <Button onClick={() => navigateToQuote(selectedQuoteId)}>
                Open Active Quote
              </Button>
            ) : null}
          </>
        }
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <section id="pipeline-overview" className="scroll-mt-28 space-y-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_320px]">
          <div className="space-y-4">
            <Card variant="default" padding="md">
              <div className="flex flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  <MetricTile label="Needs attention" value={nextAttentionCount} tone="orange" />
                  <MetricTile label="New leads" value={pipeline.totals.newLeads} tone="blue" />
                  <MetricTile label="Quoted" value={pipeline.totals.quotedLeads} tone="slate" />
                  <MetricTile label="Active work" value={pipeline.totals.closedLeads} tone="emerald" />
                  <MetricTile label="After-sale" value={pipeline.totals.afterSaleLeads} tone="slate" />
                  <MetricTile label="Revenue" value={stats.acceptedRevenue} tone="blue" currency />
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-3 border-t border-slate-200 pt-3">
                  <WorkspaceJumpBar links={pipelineLinks} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => navigateToBuilder()}>
                      Start New Quote
                    </Button>
                    {selectedQuoteId ? (
                      <Button onClick={() => navigateToQuote(selectedQuoteId)}>
                        Reopen Active Quote
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </Card>

            <Card variant="default" padding="md">
              <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Operator board</p>
                  <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Lead Pipeline</h2>
                  <p className="mt-1 text-sm text-slate-600">New leads, quoted jobs, active work, and post-job follow-up in one flow.</p>
                </div>
              </div>

              <PipelineFlow
                newLeads={pipeline.totals.newLeads}
                quotedLeads={pipeline.totals.quotedLeads}
                closedLeads={pipeline.totals.closedLeads}
                afterSaleLeads={pipeline.totals.afterSaleLeads}
              />
            </Card>
          </div>

          <div className="space-y-4">
            <Card variant="default" padding="md">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Queue focus</p>
              <div className="mt-3 space-y-3">
                <FocusRow icon={<ClockIcon size={14} />} label="Needs touch today" value={String(nextAttentionCount)} />
                <FocusRow icon={<CustomerIcon size={14} />} label="Active customers" value={String(activeCustomerCount)} />
                <FocusRow icon={<QuoteIcon size={14} />} label="Quotes this month" value={String(stats.monthlyQuotes)} />
              </div>
            </Card>

            <Card variant="default" padding="md">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Recent leads</p>
              <div className="mt-3 space-y-3">
                {pipeline.recentLeads.slice(0, 4).length > 0 ? (
                  pipeline.recentLeads.slice(0, 4).map((lead) => (
                    <button
                      key={`${lead.customerId}-${lead.quoteId ?? "recent"}`}
                      type="button"
                      onClick={() => (lead.quoteId ? navigateToQuote(lead.quoteId) : navigateToBuilder(lead.customerId))}
                      className="flex w-full items-start gap-3 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-slate-300 hover:bg-white"
                    >
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-700 shadow-sm">
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
      </section>

      <div className="grid gap-5">
        <PipelineRowsSection
          sectionId="pipeline-new"
          step="Step 1"
          title={`New Leads (${pipeline.totals.newLeads})`}
          subtitle="Prioritized by untouched follow-ups first, oldest to newest."
          leads={pipeline.newLeads}
          emptyTitle="No new leads"
          emptyDescription="No leads waiting for first quote."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          activeQuoteId={selectedQuoteId}
          actionKind="follow_up"
          tone="blue"
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />

        <PipelineRowsSection
          sectionId="pipeline-quoted"
          step="Step 2"
          title={`Quoted Leads (${pipeline.totals.quotedLeads})`}
          subtitle="Oldest quoted leads first so follow-ups do not slip."
          leads={pipeline.quotedLeads}
          emptyTitle="No quoted leads"
          emptyDescription="Quoted jobs will appear here."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          activeQuoteId={selectedQuoteId}
          actionKind="follow_up"
          tone="orange"
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />

        <PipelineRowsSection
          sectionId="pipeline-closed"
          step="Step 3"
          title={`Closed Leads (${pipeline.totals.closedLeads})`}
          subtitle="Sold work that is active, scheduled, or still being completed."
          leads={pipeline.closedLeads}
          emptyTitle="No closed leads"
          emptyDescription="Accepted jobs will appear here once marked as won."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          activeQuoteId={selectedQuoteId}
          actionKind="job_status"
          tone="emerald"
          onUpdateQuoteLifecycle={(quoteId, patch) => void updateQuoteLifecycle(quoteId, patch)}
        />

        <PipelineRowsSection
          sectionId="pipeline-after-sale"
          step="Step 4"
          title={`After-Sale Follow-Up (${pipeline.totals.afterSaleLeads})`}
          subtitle="Completed jobs waiting on review, referral, or post-job check-in."
          leads={pipeline.afterSaleLeads}
          emptyTitle="No after-sale follow-up due"
          emptyDescription="Completed jobs will appear here when they need a follow-up."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          activeQuoteId={selectedQuoteId}
          actionKind="after_sale"
          tone="slate"
          onUpdateQuoteLifecycle={(quoteId, patch) => void updateQuoteLifecycle(quoteId, patch)}
        />

        <PipelineRowsSection
          sectionId="pipeline-recent"
          step="Step 5"
          title="Recently Added Leads"
          subtitle="Most recently created customer records."
          leads={pipeline.recentLeads}
          emptyTitle="No recent leads"
          emptyDescription="Customer records will show here once created."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          activeQuoteId={selectedQuoteId}
          actionKind="follow_up"
          tone="blue"
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />
      </div>
    </div>
  );
}

function FocusRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="inline-flex items-center gap-2 text-sm text-slate-700">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white text-quotefly-blue shadow-sm">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
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
    <div className={`rounded-[16px] px-4 py-3 shadow-sm ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight">{currency ? money(value) : value}</p>
    </div>
  );
}
