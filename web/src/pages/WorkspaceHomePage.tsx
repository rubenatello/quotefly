import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { api, type QuoteStatus, type WorkspaceAttentionReason, type WorkspaceOverview } from "../lib/api";
import { formatTenantDateTime, validTimeZone } from "../lib/tenant-time";
import { cn } from "../lib/utils";

function formatMoney(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function calendarDateKey(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(read("year"), read("month") - 1, read("day"));
}

function relativeDate(value: string, t: TFunction, locale: string, timeZone: string) {
  const timestamp = new Date(value).getTime();
  const elapsed = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsed < 0) return t("home.time.recently");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("home.time.justNow");
  if (minutes < 60) return t("home.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("home.time.hours", { count: hours });
  const days = Math.max(0, Math.round((calendarDateKey(new Date(), timeZone) - calendarDateKey(new Date(timestamp), timeZone)) / 86_400_000));
  if (days === 1) return t("home.time.yesterday");
  if (days < 30) return t("home.time.days", { count: days });
  return new Intl.DateTimeFormat(locale, { timeZone: validTimeZone(timeZone), month: "short", day: "numeric" }).format(new Date(value));
}

function greetingForNow(t: TFunction, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone(timeZone),
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date()));
  if (hour < 12) return t("home.greetingMorning");
  if (hour < 17) return t("home.greetingAfternoon");
  return t("home.greetingEvening");
}

function priorityLabel(priority: "LOW" | "NORMAL" | "HIGH" | "URGENT", t: TFunction): string {
  return t(`activity.tasks.priorityValue.${priority.toLowerCase()}`);
}

function firstName(fullName: string | null | undefined, fallback: string) {
  return fullName?.trim().split(/\s+/)[0] || fallback;
}

function statusMeta(status: QuoteStatus, t: TFunction): { label: string; tone: "blue" | "orange" | "emerald" | "red" | "slate" } {
  if (status === "READY_FOR_REVIEW") return { label: t("home.status.ready"), tone: "orange" };
  if (status === "SENT_TO_CUSTOMER") return { label: t("home.status.sent"), tone: "blue" };
  if (status === "ACCEPTED") return { label: t("home.status.won"), tone: "emerald" };
  if (status === "REJECTED") return { label: t("home.status.lost"), tone: "red" };
  return { label: t("home.status.draft"), tone: "slate" };
}

function attentionMeta(reason: WorkspaceAttentionReason, t: TFunction): {
  label: string;
  description: string;
  tone: "blue" | "orange" | "emerald" | "slate";
  icon: ReactNode;
} {
  if (reason === "AFTER_SALE_DUE") {
    return { label: t("home.attention.checkIn"), description: t("home.attention.checkInDescription"), tone: "emerald", icon: <CheckCircle2 size={15} /> };
  }
  if (reason === "AWAITING_RESPONSE") {
    return { label: t("home.attention.awaiting"), description: t("home.attention.awaitingDescription"), tone: "blue", icon: <Clock3 size={15} /> };
  }
  if (reason === "READY_TO_SEND") {
    return { label: t("home.attention.send"), description: t("home.attention.sendDescription"), tone: "orange", icon: <Send size={15} /> };
  }
  if (reason === "DRAFT_TO_FINISH") {
    return { label: t("home.attention.finish"), description: t("home.attention.finishDescription"), tone: "slate", icon: <FileClock size={15} /> };
  }
  return { label: t("home.attention.create"), description: t("home.attention.createDescription"), tone: "orange", icon: <UserPlus2 size={15} /> };
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
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const navigate = useNavigate();
  const { session, navigateToBuilder } = useDashboard();
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [activitySummary, setActivitySummary] = useState<Awaited<ReturnType<typeof api.activities.summary>> | null>(null);
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
      const [nextOverview, nextActivities] = await Promise.all([
        requestOverview(true),
        api.activities.summary({ mine: true }).catch(() => null),
      ]);
      setOverview(nextOverview);
      setActivitySummary(nextActivities);
    } catch {
      setError(t("home.error"));
    } finally {
      setLoading(false);
    }
  }, [requestOverview, t]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      requestOverview(),
      api.activities.summary({ mine: true }).catch(() => null),
    ])
      .then(([result, activities]) => {
        if (active) {
          setOverview(result);
          setActivitySummary(activities);
        }
      })
      .catch(() => {
        if (active) setError(t("home.error"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [requestOverview, t]);

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
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-link)]">{t("home.eyebrow")}</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em] text-[var(--qf-text)] sm:text-[28px]">
              {greetingForNow(t, session?.timezone ?? "UTC")}, {firstName(session?.fullName, t("home.fallbackName"))}.
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--qf-text-soft)]">
              {t("home.intro", { tenant: session?.tenantName ? t("home.tenantSuffix", { tenantName: session.tenantName }) : "" })}
            </p>
          </div>
          <KodyButton
            className="qf-kody-home-action w-full justify-center sm:w-auto"
            size="md"
            label={t("home.prioritizeDay")}
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
            <Button size="sm" variant="outline" icon={<RefreshCw size={14} />} onClick={() => void loadOverview()}>{t("home.tryAgain")}</Button>
          </span>
        </Alert>
      ) : null}

      {loading && !overview ? (
        <LoadingState
          title={t("home.loadingTitle")}
          description={t("home.loadingDescription")}
          variant="cards"
          rows={4}
        />
      ) : overview ? (
        <>
          <section aria-label={t("home.summary")} className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <OverviewMetric
              label={t("home.unquotedLeads")}
              value={String(overview.metrics.unquotedLeads)}
              hint={t("home.activeCustomers", { count: overview.metrics.activeCustomers })}
              icon={<UsersRound size={19} />}
              tone="blue"
              onClick={() => navigate("/app/customers")}
            />
            <OverviewMetric
              label={activitySummary ? t("home.tasksDue") : t("home.needsFollowUp")}
              value={String(activitySummary ? activitySummary.counts.overdue + activitySummary.counts.today : overview.metrics.needsFollowUp)}
              hint={activitySummary
                ? t("home.upcomingTasks", { count: activitySummary.counts.upcoming })
                : t("home.afterSaleDue", { count: overview.metrics.afterSaleDue })}
              icon={<Clock3 size={19} />}
              tone="orange"
              onClick={() => navigate("/app/follow-up")}
            />
            <OverviewMetric
              label={t("home.openPipeline")}
              value={formatMoney(overview.metrics.openPipelineRevenue, locale)}
              hint={t("home.activeQuotes", { count: pipelineTotal })}
              icon={<CircleDollarSign size={19} />}
              tone="slate"
              onClick={() => navigate("/app/quotes")}
            />
            <OverviewMetric
              label={t("home.wonRevenue")}
              value={formatMoney(overview.metrics.acceptedRevenue, locale)}
              hint={t("home.activeJobs", { count: overview.metrics.activeJobs })}
              icon={<BriefcaseBusiness size={19} />}
              tone="emerald"
              onClick={() => navigate("/app/analytics")}
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
            <SectionCard
              title={t("home.myDay")}
              description={t("home.myDayDescription")}
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/follow-up")}>{t("home.openQueue")}</Button>}
            >
              {activitySummary?.top.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {activitySummary.top.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => navigate("/app/follow-up", { state: { activityTaskId: task.id } })}
                      className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] sm:px-5"
                    >
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]">
                        <Clock3 size={16} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-[var(--qf-text)]">{task.title}</span>
                          <Badge tone={task.priority === "URGENT" ? "red" : task.priority === "HIGH" ? "orange" : "blue"}>
                            {priorityLabel(task.priority, t)}
                          </Badge>
                        </span>
                        <span className="mt-1 block truncate text-xs text-[var(--qf-text-muted)]">
                          {task.customer.fullName} · {formatTenantDateTime(task.dueAtUtc, activitySummary.timezone, locale)}
                        </span>
                      </span>
                      <ArrowRight size={16} className="shrink-0 text-[var(--qf-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--qf-link)]" />
                    </button>
                  ))}
                </div>
              ) : overview.attention.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.attention.map((item) => {
                    const meta = attentionMeta(item.reason, t);
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
                            {item.quoteTitle ?? meta.description}{item.totalAmount !== null ? ` · ${formatMoney(item.totalAmount, locale)}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-xs text-[var(--qf-text-muted)]">{relativeDate(item.occurredAt, t, locale, session?.timezone ?? "UTC")}</span>
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
                    title={t("home.noAttention")}
                    description={t("home.noAttentionDescription")}
                  />
                </div>
              )}
            </SectionCard>

            <SectionCard
              title={t("home.quotePipeline")}
              description={t("home.quotePipelineDescription")}
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/quotes")}>{t("home.viewQuotes")}</Button>}
            >
              <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 xl:grid-cols-2">
                {([
                  { status: "DRAFT" as const, label: t("home.status.draft"), icon: <FileClock size={17} />, tone: "slate" as const },
                  { status: "READY_FOR_REVIEW" as const, label: t("home.status.ready"), icon: <FileCheck2 size={17} />, tone: "orange" as const },
                  { status: "SENT_TO_CUSTOMER" as const, label: t("home.status.sent"), icon: <Send size={17} />, tone: "blue" as const },
                  { status: "ACCEPTED" as const, label: t("home.status.won"), icon: <CheckCircle2 size={17} />, tone: "emerald" as const },
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
                <span>{t("home.lostDeclined")}</span>
                <span className="font-semibold text-[var(--qf-text-soft)]">{overview.quoteStatusCounts.REJECTED}</span>
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard
              title={t("home.recentQuotes")}
              description={t("home.recentQuotesDescription")}
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/quotes")}>{t("home.seeAll")}</Button>}
            >
              {overview.recentQuotes.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.recentQuotes.map((quote) => {
                    const status = statusMeta(quote.status, t);
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
                          <span className="mt-1 block truncate text-xs text-[var(--qf-text-muted)]">{quote.customer.fullName} · {relativeDate(quote.updatedAt, t, locale, session?.timezone ?? "UTC")}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold text-[var(--qf-text)]">{formatMoney(quote.totalAmount, locale)}</span>
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
                    title={t("home.noQuotes")}
                    description={t("home.noQuotesDescription")}
                    action={<Button size="sm" onClick={() => navigate("/app/build")}>{t("home.createQuote")}</Button>}
                  />
                </div>
              )}
            </SectionCard>

            <SectionCard
              title={t("home.newestCustomers")}
              description={t("home.newestCustomersDescription")}
              action={<Button size="sm" variant="ghost" onClick={() => navigate("/app/customers")}>{t("home.seeAll")}</Button>}
            >
              {overview.recentCustomers.length ? (
                <div className="divide-y divide-[var(--qf-border)]">
                  {overview.recentCustomers.map((customer) => {
                    const latestStatus = customer.latestQuote ? statusMeta(customer.latestQuote.status, t) : null;
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
                            {customer.latestQuote?.title ?? t("home.noQuoteYet")} · {t("home.added", { time: relativeDate(customer.createdAt, t, locale, session?.timezone ?? "UTC") })}
                          </span>
                        </span>
                        {latestStatus ? <Badge tone={latestStatus.tone}>{latestStatus.label}</Badge> : <Badge tone="orange">{t("home.newLead")}</Badge>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState
                    icon={<UsersRound size={17} />}
                    title={t("home.noCustomers")}
                    description={t("home.noCustomersDescription")}
                    action={<Button size="sm" onClick={() => navigate("/app/customers?compose=customer")}>{t("home.addCustomer")}</Button>}
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
