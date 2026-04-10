import { CallIcon, CustomerIcon, EmailIcon, InvoiceIcon, QuoteIcon } from "../components/Icons";
import { Alert, Button, Card, EmptyState, PageHeader } from "../components/ui";
import { FollowUpPill, PipelineFlow, QuoteStatusPill, StatCard } from "../components/dashboard/DashboardUi";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import type { LeadFollowUpStatus } from "../lib/api";
import { usePageView } from "../lib/analytics";

const FOLLOW_UP_STATUSES: LeadFollowUpStatus[] = [
  "NEEDS_FOLLOW_UP",
  "FOLLOWED_UP",
  "WON",
  "LOST",
];

function followUpLabel(status: LeadFollowUpStatus): string {
  if (status === "NEEDS_FOLLOW_UP") return "Needs Follow Up";
  if (status === "FOLLOWED_UP") return "Followed Up";
  if (status === "WON") return "Won";
  return "Lost";
}

function PipelineRowsSection({
  title,
  subtitle,
  leads,
  emptyTitle,
  emptyDescription,
  saving,
  onNavigateToQuote,
  onUpdateFollowUp,
}: {
  title: string;
  subtitle: string;
  leads: ReturnType<typeof useDashboard>["pipeline"]["newLeads"];
  emptyTitle: string;
  emptyDescription: string;
  saving: boolean;
  onNavigateToQuote: (quoteId: string) => void;
  onUpdateFollowUp: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
}) {
  return (
    <Card>
      <div className="mb-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-600">{subtitle}</p>
      </div>

      {leads.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <div key={`${lead.customerId}-${lead.quoteId ?? "no-quote"}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="grid gap-3 lg:grid-cols-[1.8fr_1fr_1fr_1fr_auto] lg:items-center">
                <div className="min-w-0">
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
                      {lead.totalAmount !== undefined ? ` · ${money(lead.totalAmount)}` : ""}
                    </p>
                  )}
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Follow-Up</p>
                  <FollowUpPill status={lead.followUpStatus} />
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quote</p>
                  {lead.status ? (
                    <QuoteStatusPill status={lead.status} />
                  ) : (
                    <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                      No Quote
                    </span>
                  )}
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Last Touch</p>
                  <p className="text-xs text-slate-700">{formatDateTime(lead.createdAt)}</p>
                </div>

                <div className="flex flex-col gap-2">
                  {lead.quoteId ? (
                    <Button size="sm" variant="outline" onClick={() => onNavigateToQuote(lead.quoteId!)}>
                      Open
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      Draft Needed
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-[170px_1fr] sm:items-center">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Update Follow-Up
                </p>
                <select
                  value={lead.followUpStatus}
                  disabled={saving}
                  onChange={(event) =>
                    onUpdateFollowUp(lead.customerId, event.target.value as LeadFollowUpStatus)
                  }
                  className="min-h-[40px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                >
                  {FOLLOW_UP_STATUSES.map((status) => (
                    <option key={`${lead.customerId}-${status}`} value={status}>
                      {followUpLabel(status)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function PipelineView() {
  usePageView("pipeline");
  const {
    session, stats, pipeline, saving, error, notice,
    setError, setNotice, updateLeadFollowUpStatus, navigateToQuote,
  } = useDashboard();

  return (
    <div className="space-y-5">
      <PageHeader
        title={session?.fullName ? `Welcome, ${session.fullName.split(" ")[0]}` : "QuoteFly CRM"}
        subtitle="Your lead pipeline — new prospects, quoted jobs, and closed deals."
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<QuoteIcon size={24} />} label="Quotes This Month" value={String(stats.monthlyQuotes)} />
        <StatCard icon={<CustomerIcon size={24} />} label="Active Customers" value={String(pipeline.totals.newLeads + pipeline.totals.quotedLeads + pipeline.totals.closedLeads)} />
        <StatCard icon={<InvoiceIcon size={24} />} label="Accepted Revenue" value={money(stats.acceptedRevenue)} />
      </div>

      <Card>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Lead Pipeline</h2>
          <p className="text-sm text-slate-600">New leads, quoted jobs, and closed work at a glance.</p>
        </div>

        <PipelineFlow
          newLeads={pipeline.totals.newLeads}
          quotedLeads={pipeline.totals.quotedLeads}
          closedLeads={pipeline.totals.closedLeads}
        />
      </Card>

      <div className="grid gap-4">
        <PipelineRowsSection
          title={`New Leads (${pipeline.totals.newLeads})`}
          subtitle="Prioritized by untouched follow-ups first, oldest to newest."
          leads={pipeline.newLeads}
          emptyTitle="No new leads"
          emptyDescription="No leads waiting for first quote."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />

        <PipelineRowsSection
          title={`Quoted Leads (${pipeline.totals.quotedLeads})`}
          subtitle="Oldest quoted leads first so follow-ups do not slip."
          leads={pipeline.quotedLeads}
          emptyTitle="No quoted leads"
          emptyDescription="Quoted jobs will appear here."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />

        <PipelineRowsSection
          title={`Closed Leads (${pipeline.totals.closedLeads})`}
          subtitle="Sold/accepted work only."
          leads={pipeline.closedLeads}
          emptyTitle="No closed leads"
          emptyDescription="Accepted jobs will appear here once marked as won."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />

        <PipelineRowsSection
          title="Recently Added Leads"
          subtitle="Most recently created customer records."
          leads={pipeline.recentLeads}
          emptyTitle="No recent leads"
          emptyDescription="Customer records will show here once created."
          saving={saving}
          onNavigateToQuote={navigateToQuote}
          onUpdateFollowUp={(customerId, followUpStatus) =>
            void updateLeadFollowUpStatus(customerId, followUpStatus)
          }
        />
      </div>
    </div>
  );
}
