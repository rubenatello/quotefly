import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileClock,
  FilePlus2,
  RefreshCw,
  Send,
  UserPlus2,
  UsersRound,
} from "lucide-react";
import { KodyButton } from "../components/ai/KodyButton";
import { useDashboard } from "../components/dashboard/DashboardContext";
import { Alert, Badge, Button, EmptyState, LoadingState } from "../components/ui";
import { api, ApiError, type QuoteStatus, type WorkspaceAttentionReason, type WorkspaceOverview } from "../lib/api";
import { cn } from "../lib/utils";

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatMoney(value: number) {
  return MONEY.format(Number.isFinite(value) ? value : 0);
}

function relativeDate(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsed = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsed < 0) return "Recently";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function greetingForNow() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(fullName?: string | null) {
  return fullName?.trim().split(/\s+/)[0] || "there";
}

function statusMeta(status: QuoteStatus): { label: string; tone: "blue" | "orange" | "emerald" | "red" | "slate" } {
  if (status === "READY_FOR_REVIEW") return { label: "Ready", tone: "orange" };
  if (status === "SENT_TO_CUSTOMER") return { label: "Sent", tone: "blue" };
  if (status === "ACCEPTED") return { label: "Won", tone: "emerald" };
  if (status === "REJECTED") return { label: "Lost", tone: "red" };
  return { label: "Draft", tone: "slate" };
}

function attentionMeta(reason: WorkspaceAttentionReason): {
  label: string;
  description: string;
  tone: "blue" | "orange" | "emerald" | "slate";
  icon: ReactNode;
} {
  if (reason === "AFTER_SALE_DUE") {
    return { label: "Check in", description: "After-sale follow-up is due", tone: "emerald", icon: <CheckCircle2 size={15} /> };
  }
  if (reason === "AWAITING_RESPONSE") {
    return { label: "Awaiting response", description: "Customer has a sent quote", tone: "blue", icon: <Clock3 size={15} /> };
  }
  if (reason === "READY_TO_SEND") {
    return { label: "Send quote", description: "Quote is ready for the customer", tone: "orange", icon: <Send size={15} /> };
  }
  if (reason === "DRAFT_TO_FINISH") {
    return { label: "Finish draft", description: "Quote still needs work", tone: "slate", icon: <FileClock size={15} /> };
  }
  return { label: "Create quote", description: "New lead has no quote yet", tone: "orange", icon: <UserPlus2 size={15} /> };
}

function OverviewMetric({
  label,
  value,
  hint,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  tone: "blue" | "orange" | "emerald" | "slate";
  onClick: () => void;
}) {
  const toneClass = {
    blue: "bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
    orange: "bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]",
    emerald: "bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]",
    slate: "bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group min-h-[96px] rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 text-left shadow-[var(--qf-shadow-sm)] transition hover:-translate-y-0.5 hover:border-[var(--qf-border-strong)] hover:shadow-[var(--qf-shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[104px]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg", toneClass)}>{icon}</span>
        <ArrowRight size={16} className="text-[var(--qf-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--qf-link)]" />
      </div>
      <p className="mt-1 text-lg font-semibold leading-6 tracking-tight text-[var(--qf-text)] sm:text-xl">{value}</p>
      <p className="text-[11px] font-semibold leading-4 uppercase tracking-[0.14em] text-[var(--qf-text-soft)]">{label}</p>
      <p className="text-[11px] leading-4 text-[var(--qf-text-muted)]">{hint}</p>
    </button>
  );
}

function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-[var(--qf-border)] px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-[var(--qf-text)]">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function WorkspaceHomePage() {
  const navigate = useNavigate();
  const { session, navigateToBuilder } = useDashboard();
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const overviewRequestRef = useRef<Promise<WorkspaceOverview> | null>(null);

  const requestOverview = useCallback((force = false) => {
    if (force || !overviewRequestRef.current) {
      overviewRequestRef.current = api.workspace.overview();
    }
    return overviewRequestRef.current;
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await requestOverview(true));
    } catch (loadError) {
      setError(loadError instanceof ApiError ? loadError.message : "Workspace overview could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [requestOverview]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    requestOverview()
      .then((result) => {
        if (active) setOverview(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof ApiError ? loadError.message : "Workspace overview could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [requestOverview]);

  const pipelineTotal = useMemo(() => {
    if (!overview) return 0;
    return overview.quoteStatusCounts.DRAFT + overview.quoteStatusCounts.READY_FOR_REVIEW + overview.quoteStatusCounts.SENT_TO_CUSTOMER;
  }, [overview]);

  return (
    <div className="space-y-5 sm:space-y-6" data-testid="workspace-home">
      <section className="relative overflow-hidden rounded-[22px] border border-[var(--qf-info-border)] bg-[linear-gradient(135deg,var(--qf-info-surface),var(--qf-panel)_62%)] px-5 py-4 shadow-[var(--qf-shadow-sm)] sm:px-6 sm:py-5">
        <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-[var(--qf-selected-strong)] opacity-60 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-link)]">Today at QuoteFly</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em] text-[var(--qf-text)] sm:text-[28px]">
              {greetingForNow()}, {firstName(session?.fullName)}.
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--qf-text-soft)]">
              See what needs attention, keep quotes moving, and get the next customer handled quickly{session?.tenantName ? ` for ${session.tenantName}` : ""}.
            </p>
          </div>
          <KodyButton
            className="qf-kody-home-action w-full justify-center sm:w-auto"
            size="md"
            label="Prioritize my day"
            showLabel
            prompt="Review my workspace and tell me the three highest-priority actions I should take today. Focus on new leads, unfinished quotes, sent quotes awaiting follow-up, and after-sale check-ins."
            tool="FOLLOW_UP_QUEUE"
            context={{ currentPage: "dashboard", limit: 6 }}
          />
        </div>
      </section>

      {error ? (
        <Alert tone="error">
          <span className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" icon={<RefreshCw size={14} />} onClick={() => void loadOverview()}>Try again</Button>
          </span>
        </Alert>
      ) : null}

      {loading && !overview ? (
        <LoadingState
          title="Gathering your workspace"
          description="Loading leads, quotes, follow-ups, and recent activity."
          variant="cards"
          rows={4}
        />
      ) : overview ? (
        <>
          <section aria-label="Workspace summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <OverviewMetric
              label="Unquoted leads"
              value={String(overview.metrics.unquotedLeads)}
              hint={`${overview.metrics.activeCustomers} active customers`}
              icon={<UsersRound size={19} />}
              tone="blue"
              onClick={() => navigate("/app/customers")}
            />
            <OverviewMetric
              label="Needs follow-up"
              value={String(overview.metrics.needsFollowUp)}
              hint={`${overview.metrics.afterSaleDue} after-sale check-ins due`}
              icon={<Clock3 size={19} />}
              tone="orange"
              onClick={() => navigate("/app/follow-up")}
            />
            <OverviewMetric
              label="Open pipeline"
              value={formatMoney(overview.metrics.openPipelineRevenue)}
              hint={`${pipelineTotal} active quotes`}
              icon={<CircleDollarSign size={19} />}
              tone="slate"
              onClick={() => navigate("/app/quotes")}
            />
            <OverviewMetric
              label="Won revenue"
              value={formatMoney(overview.metrics.acceptedRevenue)}
              hint={`${overview.metrics.activeJobs} active jobs`}
              icon={<BriefcaseBusiness size={19} />}
              tone="emerald"
              onClick={() => navigate("/app/analytics")}
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
            <SectionCard
              title="What needs attention"
              description="Oldest and most important customer work appears first."
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/follow-up")}>Open queue</Button>}
            >
              {overview.attention.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.attention.map((item) => {
                    const meta = attentionMeta(item.reason);
                    return (
                      <button
                        key={`${item.customerId}:${item.quoteId ?? "unquoted"}`}
                        type="button"
                        onClick={() => item.quoteId ? navigate(`/app/quotes/${item.quoteId}`) : navigateToBuilder(item.customerId)}
                        className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] sm:px-5"
                      >
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-panel-muted)] text-[var(--qf-link)]">
                          {meta.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-[var(--qf-text)]">{item.customerName}</span>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </span>
                          <span className="mt-1 block truncate text-xs text-[var(--qf-text-muted)]">
                            {item.quoteTitle ?? meta.description}{item.totalAmount !== null ? ` · ${formatMoney(item.totalAmount)}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-xs text-[var(--qf-text-muted)]">{relativeDate(item.occurredAt)}</span>
                          <ArrowRight size={16} className="ml-auto mt-1 text-[var(--qf-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--qf-link)]" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState
                    icon={<CheckCircle2 size={17} />}
                    title="Nothing urgent right now"
                    description="New leads, ready quotes, sent quotes, and after-sale check-ins will appear here."
                  />
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Quote pipeline"
              description="A quick count of every active quote stage."
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/quotes")}>View quotes</Button>}
            >
              <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 xl:grid-cols-2">
                {([
                  { status: "DRAFT" as const, label: "Draft", icon: <FileClock size={17} />, tone: "slate" as const },
                  { status: "READY_FOR_REVIEW" as const, label: "Ready", icon: <FileCheck2 size={17} />, tone: "orange" as const },
                  { status: "SENT_TO_CUSTOMER" as const, label: "Sent", icon: <Send size={17} />, tone: "blue" as const },
                  { status: "ACCEPTED" as const, label: "Won", icon: <CheckCircle2 size={17} />, tone: "emerald" as const },
                ]).map((stage) => (
                  <button
                    key={stage.status}
                    type="button"
                    onClick={() => navigate("/app/quotes")}
                    className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3 text-left transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[var(--qf-link)]">{stage.icon}</span>
                      <Badge tone={stage.tone}>{stage.label}</Badge>
                    </span>
                    <span className="mt-3 block text-2xl font-semibold text-[var(--qf-text)]">{overview.quoteStatusCounts[stage.status]}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-[var(--qf-border)] px-4 py-3 text-xs text-[var(--qf-text-muted)]">
                <span>Lost or declined</span>
                <span className="font-semibold text-[var(--qf-text-soft)]">{overview.quoteStatusCounts.REJECTED}</span>
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard
              title="Recent quotes"
              description="The latest quote work across your visible workspace."
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/quotes")}>See all</Button>}
            >
              {overview.recentQuotes.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.recentQuotes.map((quote) => {
                    const status = statusMeta(quote.status);
                    return (
                      <button
                        key={quote.id}
                        type="button"
                        onClick={() => navigate(`/app/quotes/${quote.id}`)}
                        className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] sm:px-5"
                      >
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]"><FileCheck2 size={17} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{quote.title}</span>
                          <span className="mt-1 block truncate text-xs text-[var(--qf-text-muted)]">{quote.customer.fullName} · {relativeDate(quote.updatedAt)}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold text-[var(--qf-text)]">{formatMoney(quote.totalAmount)}</span>
                          <Badge tone={status.tone} className="mt-1">{status.label}</Badge>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState
                    icon={<FilePlus2 size={17} />}
                    title="No quotes yet"
                    description="Create the first quote when you are ready to price a customer job."
                    action={<Button size="sm" onClick={() => navigate("/app/build")}>Create quote</Button>}
                  />
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Newest customers"
              description="Recent leads ready for contact, quoting, or follow-up."
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/customers")}>See all</Button>}
            >
              {overview.recentCustomers.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.recentCustomers.map((customer) => {
                    const latestStatus = customer.latestQuote ? statusMeta(customer.latestQuote.status) : null;
                    return (
                      <button
                        key={customer.id}
                        type="button"
                        onClick={() => navigate("/app/customers", { state: { kodyCustomerId: customer.id } })}
                        className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] sm:px-5"
                      >
                        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
                          {customer.fullName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{customer.fullName}</span>
                          <span className="mt-1 block truncate text-xs text-[var(--qf-text-muted)]">
                            {customer.latestQuote?.title ?? "No quote yet"} · added {relativeDate(customer.createdAt)}
                          </span>
                        </span>
                        {latestStatus ? <Badge tone={latestStatus.tone}>{latestStatus.label}</Badge> : <Badge tone="orange">New lead</Badge>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState
                    icon={<UsersRound size={17} />}
                    title="No customers yet"
                    description="Add the first customer to start your QuoteFly pipeline."
                    action={<Button size="sm" onClick={() => navigate("/app/customers?compose=customer")}>Add customer</Button>}
                  />
                </div>
              )}
            </SectionCard>
          </div>
        </>
      ) : null}
    </div>
  );
}
