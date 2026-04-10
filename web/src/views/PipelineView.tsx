import { CustomerIcon, QuoteIcon, InvoiceIcon, SendIcon, CheckIcon, ClockIcon } from "../components/Icons";
import { Card, PageHeader, Alert } from "../components/ui";
import { StatCard, PipelineFlow, PipelineColumn } from "../components/dashboard/DashboardUi";
import { useDashboard, money } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";

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

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <PipelineColumn
            icon={<CustomerIcon size={14} />}
            title={`New Leads (${pipeline.totals.newLeads})`}
            subtitle="No quote yet or still draft"
            leads={pipeline.newLeads}
            emptyLabel="No leads waiting for first quote."
            onSelectLead={(quoteId) => quoteId && navigateToQuote(quoteId)}
            onUpdateFollowUp={(customerId, followUpStatus) => void updateLeadFollowUpStatus(customerId, followUpStatus)}
            saving={saving}
            money={money}
          />
          <PipelineColumn
            icon={<SendIcon size={14} />}
            title={`Quoted Leads (${pipeline.totals.quotedLeads})`}
            subtitle="Quote prepared or sent"
            leads={pipeline.quotedLeads}
            emptyLabel="No active quoted leads."
            onSelectLead={(quoteId) => quoteId && navigateToQuote(quoteId)}
            onUpdateFollowUp={(customerId, followUpStatus) => void updateLeadFollowUpStatus(customerId, followUpStatus)}
            saving={saving}
            money={money}
          />
          <PipelineColumn
            icon={<CheckIcon size={14} />}
            title={`Closed Leads (${pipeline.totals.closedLeads})`}
            subtitle="Accepted, work in progress"
            leads={pipeline.closedLeads}
            emptyLabel="No closed deals yet."
            onSelectLead={(quoteId) => quoteId && navigateToQuote(quoteId)}
            onUpdateFollowUp={(customerId, followUpStatus) => void updateLeadFollowUpStatus(customerId, followUpStatus)}
            saving={saving}
            money={money}
          />
          <PipelineColumn
            icon={<ClockIcon size={14} />}
            title="Recently Added"
            subtitle="Most recent customer records"
            leads={pipeline.recentLeads}
            emptyLabel="No customers added yet."
            onSelectLead={(quoteId) => quoteId && navigateToQuote(quoteId)}
            onUpdateFollowUp={(customerId, followUpStatus) => void updateLeadFollowUpStatus(customerId, followUpStatus)}
            saving={saving}
            money={money}
          />
        </div>
      </Card>
    </div>
  );
}
