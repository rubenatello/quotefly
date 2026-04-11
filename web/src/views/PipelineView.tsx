import { CallIcon, ClockIcon, CustomerIcon, EmailIcon, InvoiceIcon, QuoteIcon } from "../components/Icons";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select } from "../components/ui";
import { FollowUpPill, PipelineFlow, QuoteStatusPill, StatCard } from "../components/dashboard/DashboardUi";
import { WorkspaceJumpBar, WorkspaceRailCard, WorkspaceSection } from "../components/ui/workspace";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import type { AfterSaleFollowUpStatus, LeadFollowUpStatus, QuoteJobStatus } from "../lib/api";
import { usePageView } from "../lib/analytics";

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
        ? "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue"
        : tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-slate-200 bg-slate-50 text-slate-600";

  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass}`}>{label}</span>;
}

function sectionToneClass(tone: "blue" | "orange" | "emerald" | "slate"): string {
  if (tone === "blue") return "bg-quotefly-blue/[0.06] text-quotefly-blue";
  if (tone === "orange") return "bg-quotefly-orange/[0.06] text-quotefly-orange";
  if (tone === "emerald") return "bg-quotefly-blue/[0.06] text-quotefly-blue";
  return "bg-slate-50 text-slate-600";
}

function sectionBorderClass(tone: "blue" | "orange" | "emerald" | "slate"): string {
  if (tone === "blue") return "border-l-2 border-l-quotefly-blue";
  if (tone === "orange") return "border-l-2 border-l-quotefly-orange";
  if (tone === "emerald") return "border-l-2 border-l-quotefly-blue";
  return "border-l-2 border-l-slate-300";
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
  actionKind,
  tone,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  sectionId: string;
  step: string;
  title: string;
  subtitle: string;
  leads: ReturnType<typeof useDashboard>["pipeline"]["newLeads"];
  emptyTitle: string;
  emptyDescription: string;
  saving: boolean;
  onNavigateToQuote: (quoteId: string) => void;
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
      actions={
        <Badge tone={tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue"}>
          {leads.length} active
        </Badge>
      }
    >
      <Card variant="elevated">
        <div className={`mb-4 rounded-[24px] px-4 py-4 shadow-sm ${sectionToneClass(tone)}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">Pipeline Queue</p>
              <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-900">{title}</h3>
              <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
            </div>
            <Badge tone={tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue"}>
              {leads.length} active
            </Badge>
          </div>
        </div>

        {leads.length === 0 ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          <div className="space-y-3">
            {leads.map((lead, index) => (
              <div
                key={`${lead.customerId}-${lead.quoteId ?? "no-quote"}`}
                className={`rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)] ${sectionBorderClass(tone)}`}
              >
                <div className="grid gap-3 lg:grid-cols-[1.8fr_1fr_1fr_1fr_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge tone={tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue"}>
                        Queue #{index + 1}
                      </Badge>
                      <Badge tone="slate">Created {formatDateTime(lead.createdAt)}</Badge>
                    </div>
                    <p className="truncate text-sm font-semibold text-slate-900">{lead.customerName}</p>
                    <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-600">
                      <CallIcon size={12} />
                      {lead.phone}
                    </p>
                    {lead.email && (
                      <p className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <EmailIcon size={12} />
                        {lead.email}
                      </p>
                    )}
                    {lead.quoteTitle && (
                      <p className="truncate text-xs text-slate-700">
                        {lead.quoteTitle}
                        {lead.totalAmount !== undefined ? ` | ${money(lead.totalAmount)}` : ""}
                      </p>
                    )}
                    {lead.afterSaleFollowUpDueAtUtc && (
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700">
                        <ClockIcon size={12} />
                        Follow-up due {formatDateTime(lead.afterSaleFollowUpDueAtUtc)}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Lead Follow-Up</p>
                    <FollowUpPill status={lead.followUpStatus} />
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quote Status</p>
                    {lead.status ? (
                      <QuoteStatusPill status={lead.status} />
                    ) : (
                      <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                        No Quote
                      </span>
                    )}
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {actionKind === "job_status" ? "Job Stage" : actionKind === "after_sale" ? "After-Sale" : "Last Touch"}
                    </p>
                    {actionKind === "job_status" && lead.jobStatus ? (
                      <LifecyclePill
                        label={jobStatusLabel(lead.jobStatus)}
                        tone={lead.jobStatus === "COMPLETED" ? "emerald" : lead.jobStatus === "IN_PROGRESS" ? "blue" : "slate"}
                      />
                    ) : actionKind === "after_sale" && lead.afterSaleFollowUpStatus ? (
                      <LifecyclePill
                        label={afterSaleLabel(lead.afterSaleFollowUpStatus)}
                        tone={lead.afterSaleFollowUpStatus === "COMPLETED" ? "emerald" : "amber"}
                      />
                    ) : (
                      <p className="text-xs text-slate-700">{formatDateTime(lead.createdAt)}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    {lead.quoteId ? (
                      <Button size="sm" variant="outline" onClick={() => onNavigateToQuote(lead.quoteId!)}>
                        Open Quote Desk
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled>
                        Draft Needed
                      </Button>
                    )}
                  </div>
                </div>

                {actionKind !== "none" && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-[170px_1fr] sm:items-center">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {actionKind === "follow_up"
                        ? "Update Follow-Up"
                        : actionKind === "job_status"
                          ? "Update Job Stage"
                          : "Update After-Sale"}
                    </p>

                    {actionKind === "follow_up" ? (
                      <Select
                        aria-label={`Update follow-up for ${lead.customerName}`}
                        value={lead.followUpStatus}
                        disabled={saving}
                        onChange={(event) =>
                          onUpdateFollowUp?.(lead.customerId, event.target.value as LeadFollowUpStatus)
                        }
                        options={FOLLOW_UP_OPTIONS}
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
                      />
                    ) : (
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
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
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

  return (
    <div className="space-y-6">
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

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <WorkspaceRailCard
            eyebrow="Operator board"
            title="Daily queue"
            description="Keep the top of the funnel clean, then move into won work and post-job follow-up."
          >
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Needs attention</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{nextAttentionCount}</p>
                </div>
                <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active work</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{pipeline.totals.closedLeads}</p>
                </div>
                <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">After-sale</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{pipeline.totals.afterSaleLeads}</p>
                </div>
              </div>
              <WorkspaceJumpBar links={pipelineLinks} />
            </div>
          </WorkspaceRailCard>

          <WorkspaceRailCard
            eyebrow="Quick actions"
            title="Move faster"
            description="Keep actions obvious on a phone: build, reopen, or work the next queue."
          >
            <div className="grid gap-2">
              <Button fullWidth onClick={() => navigateToBuilder()}>
                Start New Quote
              </Button>
              {selectedQuoteId ? (
                <Button fullWidth variant="outline" onClick={() => navigateToQuote(selectedQuoteId)}>
                  Reopen Active Quote
                </Button>
              ) : null}
            </div>
          </WorkspaceRailCard>
        </aside>

        <div className="space-y-5">
          <section id="pipeline-overview" className="scroll-mt-28 space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard icon={<QuoteIcon size={24} />} label="Quotes This Month" value={String(stats.monthlyQuotes)} />
              <StatCard
                icon={<CustomerIcon size={24} />}
                label="Active Customers"
                value={String(
                  pipeline.totals.newLeads +
                    pipeline.totals.quotedLeads +
                    pipeline.totals.closedLeads +
                    pipeline.totals.afterSaleLeads,
                )}
              />
              <StatCard icon={<InvoiceIcon size={24} />} label="Accepted Revenue" value={money(stats.acceptedRevenue)} />
            </div>

            <Card variant="blue">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Operator board</p>
                  <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">Lead Pipeline</h2>
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
          actionKind="follow_up"
          tone="blue"
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />
          </div>
        </div>
      </div>
    </div>
  );
}
