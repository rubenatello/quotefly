import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CallIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  CustomerIcon,
  EditIcon,
  EmailIcon,
  InvoiceIcon,
  LockIcon,
  MessageIcon,
  QuoteIcon,
  SendIcon,
} from "../Icons";
import type {
  AfterSaleFollowUpStatus,
  LeadFollowUpStatus,
  QuoteOutboundChannel,
  QuoteJobStatus,
  QuoteRevision,
  QuoteStatus,
} from "../../lib/api";

export type DashboardMobileSection = "pipeline" | "builder" | "quote";

export type LeadCardItem = {
  customerId: string;
  customerName: string;
  phone: string;
  email?: string | null;
  quoteId?: string;
  quoteTitle?: string;
  totalAmount?: number;
  status?: QuoteStatus;
  jobStatus?: QuoteJobStatus;
  afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  afterSaleFollowUpDueAtUtc?: string | null;
  followUpStatus: LeadFollowUpStatus;
  createdAt: string;
};

export type QuoteMathSummary = {
  internalSubtotal: number;
  customerSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  estimatedProfit: number;
  estimatedMarginPercent: number;
};

const FOLLOW_UP_STATUSES: LeadFollowUpStatus[] = [
  "NEEDS_FOLLOW_UP",
  "FOLLOWED_UP",
  "WON",
  "LOST",
];

function statusClass(status: QuoteStatus): string {
  if (status === "ACCEPTED") return "text-emerald-700 border-emerald-300 bg-emerald-50";
  if (status === "REJECTED") return "text-rose-700 border-rose-300 bg-rose-50";
  if (status === "SENT_TO_CUSTOMER") return "text-sky-700 border-sky-300 bg-sky-50";
  if (status === "READY_FOR_REVIEW") return "text-amber-700 border-amber-300 bg-amber-50";
  return "text-slate-700 border-slate-300 bg-slate-100";
}

function quoteStatusMeta(status: QuoteStatus): { label: string; className: string; icon: ReactNode } {
  if (status === "ACCEPTED") {
    return {
      label: "Won",
      className: statusClass(status),
      icon: <CheckIcon size={12} />,
    };
  }

  if (status === "REJECTED") {
    return {
      label: "Lost",
      className: statusClass(status),
      icon: <CloseIcon size={12} />,
    };
  }

  if (status === "SENT_TO_CUSTOMER") {
    return {
      label: "Quoted",
      className: statusClass(status),
      icon: <SendIcon size={12} />,
    };
  }

  if (status === "READY_FOR_REVIEW") {
    return {
      label: "Review",
      className: statusClass(status),
      icon: <ClockIcon size={12} />,
    };
  }

  return {
    label: "Draft",
    className: statusClass(status),
    icon: <EditIcon size={12} />,
  };
}

function followUpLabel(status: LeadFollowUpStatus): string {
  if (status === "NEEDS_FOLLOW_UP") return "Needs Follow Up";
  if (status === "FOLLOWED_UP") return "Followed Up";
  if (status === "WON") return "Won";
  return "Lost";
}

function followUpMeta(status: LeadFollowUpStatus): { label: string; className: string; icon: ReactNode } {
  if (status === "FOLLOWED_UP") {
    return {
      label: "Followed Up",
      className: "text-sky-700 border-sky-300 bg-sky-50",
      icon: <MessageIcon size={12} />,
    };
  }

  if (status === "WON") {
    return {
      label: "Won",
      className: "text-emerald-700 border-emerald-300 bg-emerald-50",
      icon: <CheckIcon size={12} />,
    };
  }

  if (status === "LOST") {
    return {
      label: "Lost",
      className: "text-rose-700 border-rose-300 bg-rose-50",
      icon: <CloseIcon size={12} />,
    };
  }

  return {
    label: "Needs Follow-Up",
    className: "text-amber-700 border-amber-300 bg-amber-50",
    icon: <ClockIcon size={12} />,
  };
}

function eventMeta(eventType: QuoteRevision["eventType"]): { label: string; className: string; icon: ReactNode } {
  if (eventType === "CREATED") {
    return {
      label: "Created",
      className: "text-blue-700 border-blue-300 bg-blue-50",
      icon: <QuoteIcon size={12} />,
    };
  }

  if (eventType === "STATUS_CHANGED") {
    return {
      label: "Status",
      className: "text-violet-700 border-violet-300 bg-violet-50",
      icon: <CheckIcon size={12} />,
    };
  }

  if (eventType === "LINE_ITEM_CHANGED") {
    return {
      label: "Line Items",
      className: "text-orange-700 border-orange-300 bg-orange-50",
      icon: <InvoiceIcon size={12} />,
    };
  }

  if (eventType === "DECISION") {
    return {
      label: "Decision",
      className: "text-indigo-700 border-indigo-300 bg-indigo-50",
      icon: <SendIcon size={12} />,
    };
  }

  return {
    label: "Updated",
    className: "text-slate-700 border-slate-300 bg-slate-100",
    icon: <EditIcon size={12} />,
  };
}

function outboundChannelMeta(channel: QuoteOutboundChannel): { label: string; className: string; icon: ReactNode } {
  if (channel === "EMAIL_APP") {
    return {
      label: "Email",
      className: "text-cyan-700 border-cyan-300 bg-cyan-50",
      icon: <EmailIcon size={12} />,
    };
  }

  if (channel === "SMS_APP") {
    return {
      label: "Text",
      className: "text-indigo-700 border-indigo-300 bg-indigo-50",
      icon: <MessageIcon size={12} />,
    };
  }

  return {
    label: "Copy",
    className: "text-violet-700 border-violet-300 bg-violet-50",
    icon: <CopyIcon size={12} />,
  };
}

export function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-slate-100 transition hover:border-slate-300 hover:shadow-md">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-orange-100 text-quotefly-blue">
        {icon}
      </span>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

export function MobileSectionSwitcher({
  activeSection,
  onChange,
  selectedQuoteId,
  quoteCount,
  totals,
}: {
  activeSection: DashboardMobileSection;
  onChange: (section: DashboardMobileSection) => void;
  selectedQuoteId: string | null;
  quoteCount: number;
  totals: { newLeads: number; quotedLeads: number; closedLeads: number; afterSaleLeads: number };
}) {
  const sections: Array<{
    id: DashboardMobileSection;
    label: string;
    count: number;
    icon: ReactNode;
  }> = [
    {
      id: "pipeline",
      label: "Pipeline",
      count: totals.newLeads + totals.quotedLeads + totals.closedLeads + totals.afterSaleLeads,
      icon: <CustomerIcon size={14} />,
    },
    { id: "builder", label: "Build", count: quoteCount, icon: <EditIcon size={14} /> },
    { id: "quote", label: "Quote Desk", count: selectedQuoteId ? 1 : 0, icon: <QuoteIcon size={14} /> },
  ];

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm lg:hidden">
      <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Mobile Workflow
      </p>
      <div className="grid grid-cols-3 gap-2">
        {sections.map((section) => {
          const active = section.id === activeSection;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onChange(section.id)}
              className={`rounded-lg border px-2 py-2.5 text-left transition ${
                active
                  ? "border-quotefly-blue bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                {section.icon}
                {section.label}
              </span>
              <p className="mt-1 text-lg font-bold">{section.count}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PipelineFlow({
  newLeads,
  quotedLeads,
  closedLeads,
  afterSaleLeads,
}: {
  newLeads: number;
  quotedLeads: number;
  closedLeads: number;
  afterSaleLeads: number;
}) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:p-4">
      <div className="flex flex-col gap-2 text-sm font-semibold sm:flex-row sm:items-center sm:gap-3">
        <PipelineStage icon={<CustomerIcon size={14} />} label="New Leads" count={newLeads} tone="blue" />
        <FlowArrow />
        <PipelineStage icon={<SendIcon size={14} />} label="Quoted Leads" count={quotedLeads} tone="orange" />
        <FlowArrow />
        <PipelineStage icon={<CheckIcon size={14} />} label="Closed Leads" count={closedLeads} tone="emerald" />
        <FlowArrow />
        <PipelineStage icon={<ClockIcon size={14} />} label="After-Sale" count={afterSaleLeads} tone="slate" />
      </div>
    </div>
  );
}

function PipelineStage({
  icon,
  label,
  count,
  tone,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  tone: "blue" | "orange" | "emerald" | "slate";
}) {
  const toneClass =
    tone === "blue"
      ? "text-quotefly-blue border-quotefly-blue/30 bg-quotefly-blue/10"
      : tone === "orange"
        ? "text-quotefly-orange border-quotefly-orange/30 bg-quotefly-orange/10"
        : tone === "emerald"
          ? "text-emerald-700 border-emerald-300 bg-emerald-50"
          : "text-slate-700 border-slate-300 bg-slate-100";

  return (
    <div className={`flex min-w-[170px] items-center justify-between rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="inline-flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-current/30 bg-white/70">
          {icon}
        </span>
        {label}
      </p>
      <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-bold">{count}</span>
    </div>
  );
}

function FlowArrow() {
  return (
    <span className="inline-flex justify-center text-slate-400 rotate-90 sm:rotate-0">
      <ArrowRightIcon size={14} />
    </span>
  );
}

export function PipelineColumn({
  icon,
  title,
  subtitle,
  leads,
  emptyLabel,
  onSelectLead,
  onUpdateFollowUp,
  saving,
  money,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  leads: LeadCardItem[];
  emptyLabel: string;
  onSelectLead: (quoteId?: string) => void;
  onUpdateFollowUp: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  saving: boolean;
  money: (value: string | number) => string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-quotefly-blue">
          {icon}
        </span>
        {title}
      </h3>
      <p className="mb-3 text-xs text-slate-500">{subtitle}</p>
      {leads.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white px-2 py-3 text-xs text-slate-500">
          {emptyLabel}
        </p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-auto pr-1">
          {leads.map((lead) => (
            <button
              key={`${lead.customerId}-${lead.quoteId ?? "lead"}`}
              type="button"
              onClick={() => onSelectLead(lead.quoteId)}
              disabled={!lead.quoteId}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-90"
            >
              <p className="text-sm font-medium text-slate-900">{lead.customerName}</p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-600">
                <CallIcon size={11} />
                {lead.phone}
              </p>
              {lead.email && (
                <p className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <EmailIcon size={11} />
                  {lead.email}
                </p>
              )}
              {lead.quoteTitle && (
                <p className="mt-1 text-xs text-slate-700">
                  {lead.quoteTitle} · {lead.totalAmount !== undefined ? money(lead.totalAmount) : ""}
                </p>
              )}
              {lead.status && (
                <div className="mt-2">
                  <QuoteStatusPill status={lead.status} compact />
                </div>
              )}
              <div className="mt-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <FollowUpPill status={lead.followUpStatus} compact />
                  {lead.quoteId ? (
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">Status</span>
                  ) : null}
                </div>
                {lead.quoteId ? (
                  <select
                    value={lead.followUpStatus}
                    disabled={saving}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      onUpdateFollowUp(lead.customerId, event.target.value as LeadFollowUpStatus)
                    }
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                  >
                    {FOLLOW_UP_STATUSES.map((status) => (
                      <option key={`${lead.customerId}-${status}`} value={status}>
                        {followUpLabel(status)}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {!lead.quoteId && <p className="mt-1 text-[11px] text-slate-500">No quote attached yet</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function QuoteStatusPill({
  status,
  compact = false,
}: {
  status: QuoteStatus;
  compact?: boolean;
}) {
  const meta = quoteStatusMeta(status);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${meta.className} ${
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      }`}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

export function FollowUpPill({
  status,
  compact = false,
}: {
  status: LeadFollowUpStatus;
  compact?: boolean;
}) {
  const meta = followUpMeta(status);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${meta.className} ${
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      }`}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

export function HistoryEventPill({ eventType }: { eventType: QuoteRevision["eventType"] }) {
  const meta = eventMeta(eventType);

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

export function OutboundChannelPill({ channel }: { channel: QuoteOutboundChannel }) {
  const meta = outboundChannelMeta(channel);

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

export function FeatureLockedCard({
  title,
  description,
  currentPlanLabel,
  requiredPlanLabel,
  showUpgradeHint,
}: {
  title: string;
  description: string;
  currentPlanLabel: string;
  requiredPlanLabel: string;
  showUpgradeHint: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-amber-900">{title}</h3>
          <p className="mt-1 text-xs text-amber-800">{description}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-amber-700">
          <LockIcon size={10} />
          {requiredPlanLabel}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-amber-700">Current plan: {currentPlanLabel}</p>
      {showUpgradeHint && (
        <p className="mt-1 text-[11px] text-amber-700">
          Upgrade plan to unlock this module for your whole workspace.
        </p>
      )}
    </div>
  );
}

export function QuoteMathSummaryPanel({
  summary,
  compact = false,
  warning,
  money,
}: {
  summary: QuoteMathSummary;
  compact?: boolean;
  warning?: string;
  money: (value: string | number) => string;
}) {
  const profitTone = summary.estimatedProfit >= 0 ? "text-emerald-700" : "text-red-700";
  const marginTone = summary.estimatedMarginPercent >= 10 ? "text-emerald-700" : "text-amber-700";

  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${compact ? "p-3" : "p-4"}`}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Live Quote Math</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="Internal Cost" value={money(summary.internalSubtotal)} />
        <Metric label="Customer Subtotal" value={money(summary.customerSubtotal)} />
        <Metric label="Tax" value={money(summary.taxAmount)} />
        <Metric label="Total" value={money(summary.totalAmount)} />
        <Metric label="Est. Profit" value={money(summary.estimatedProfit)} valueClassName={profitTone} />
        <Metric label="Margin" value={`${summary.estimatedMarginPercent.toFixed(1)}%`} valueClassName={marginTone} />
      </div>
      {warning && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700">
          {warning}
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className={`text-base font-semibold ${valueClassName ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}
