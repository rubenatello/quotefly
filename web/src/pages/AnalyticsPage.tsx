import { useEffect, useMemo, type ReactNode } from "react";
import {
  Activity,
  BadgeCheck,
  ChartColumn,
  CircleDollarSign,
  Clock3,
  FileText,
  Send,
  UserRoundCheck,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import { QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { useDashboard, money, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";
import type { Customer, Quote } from "../lib/api";

type TrendPoint = {
  label: string;
  fullLabel: string;
  value: number;
};

type ActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  detail: string;
  tone: "blue" | "orange" | "emerald" | "slate";
  icon: ReactNode;
};

type QuoteLifecycleStage = "DRAFT" | "COMPLETED" | "SENT" | "CLOSED" | "INVOICED";

const DAY_RANGE = 14;
const CHART_HEIGHT = 210;

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function shortDayLabel(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildDailySeries(days: number, getValue: (start: Date, end: Date) => number): TrendPoint[] {
  const today = startOfDay(new Date());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = days - index - 1;
    const start = new Date(today);
    start.setDate(today.getDate() - dayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return {
      label: start.toLocaleDateString(undefined, { weekday: "short" }),
      fullLabel: shortDayLabel(start),
      value: getValue(start, end),
    };
  });
}

function describeDurationHours(hours: number | null) {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(1)}h`;
}

function describeDurationHint(hours: number | null) {
  if (hours === null || !Number.isFinite(hours)) return "No response data yet";
  if (hours < 1) return `${Math.round(hours * 60)} min avg`;
  return `${hours.toFixed(1)} hrs avg`;
}

function lifecycleStage(quote: Quote): QuoteLifecycleStage {
  const syncedInvoice = quote.quickBooksInvoiceSyncs?.some(
    (sync) => sync.status === "SYNCED" && !!sync.quickBooksInvoiceId,
  );

  if (syncedInvoice) return "INVOICED";
  if (quote.status === "ACCEPTED" || quote.status === "REJECTED") return "CLOSED";
  if (quote.status === "SENT_TO_CUSTOMER") return "SENT";
  if (quote.status === "READY_FOR_REVIEW") return "COMPLETED";
  return "DRAFT";
}

function lifecycleLabel(stage: QuoteLifecycleStage) {
  if (stage === "DRAFT") return "Draft";
  if (stage === "COMPLETED") return "Completed";
  if (stage === "SENT") return "Sent";
  if (stage === "CLOSED") return "Closed";
  return "Invoiced";
}

function lifecycleCountMap(quotes: Quote[]) {
  return quotes.reduce<Record<QuoteLifecycleStage, number>>(
    (accumulator, quote) => {
      accumulator[lifecycleStage(quote)] += 1;
      return accumulator;
    },
    { DRAFT: 0, COMPLETED: 0, SENT: 0, CLOSED: 0, INVOICED: 0 },
  );
}

function firstResponseHours(customer: Customer, quotes: Quote[]) {
  const candidateTimes = [
    customer.followUpUpdatedAtUtc,
    ...quotes.map((quote) => quote.sentAt ?? quote.createdAt),
  ]
    .filter(Boolean)
    .map((value) => new Date(value as string).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!candidateTimes.length) return null;

  const createdAtMs = new Date(customer.createdAt).getTime();
  const firstResponseMs = candidateTimes[0];
  if (!Number.isFinite(createdAtMs) || firstResponseMs < createdAtMs) return null;

  return (firstResponseMs - createdAtMs) / (1000 * 60 * 60);
}

function buildActivityItems(customers: Customer[], quotes: Quote[]) {
  const items: ActivityItem[] = [];

  for (const customer of customers) {
    items.push({
      id: `${customer.id}-created`,
      occurredAt: customer.createdAt,
      title: "Lead added",
      detail: customer.fullName,
      tone: "blue",
      icon: <UserRoundCheck size={14} strokeWidth={2.2} />,
    });

    if (customer.followUpUpdatedAtUtc) {
      items.push({
        id: `${customer.id}-follow-up`,
        occurredAt: customer.followUpUpdatedAtUtc,
        title: "Lead status updated",
        detail: `${customer.fullName} · ${customer.followUpStatus.replaceAll("_", " ").toLowerCase()}`,
        tone: customer.followUpStatus === "WON" ? "emerald" : customer.followUpStatus === "LOST" ? "orange" : "slate",
        icon: <Clock3 size={14} strokeWidth={2.2} />,
      });
    }
  }

  for (const quote of quotes) {
    items.push({
      id: `${quote.id}-drafted`,
      occurredAt: quote.createdAt,
      title: "Quote drafted",
      detail: `${quote.customer?.fullName ?? "Customer missing"} · ${quote.title}`,
      tone: "blue",
      icon: <FileText size={14} strokeWidth={2.2} />,
    });

    if (quote.sentAt) {
      items.push({
        id: `${quote.id}-sent`,
        occurredAt: quote.sentAt,
        title: "Quote sent",
        detail: `${quote.customer?.fullName ?? "Customer missing"} · ${money(quote.totalAmount)}`,
        tone: "orange",
        icon: <Send size={14} strokeWidth={2.2} />,
      });
    }

    if (quote.status === "ACCEPTED") {
      items.push({
        id: `${quote.id}-accepted`,
        occurredAt: quote.closedAtUtc ?? quote.updatedAt,
        title: "Quote accepted",
        detail: `${quote.customer?.fullName ?? "Customer missing"} · ${money(quote.totalAmount)}`,
        tone: "emerald",
        icon: <BadgeCheck size={14} strokeWidth={2.2} />,
      });
    }
  }

  return items
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 10);
}

function MetricCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  tone: "blue" | "orange" | "emerald" | "slate";
}) {
  const toneClasses =
    tone === "blue"
      ? "border-[#234f98] bg-[#234f98]"
      : tone === "orange"
        ? "border-[#1f2f55] bg-[#1f2f55]"
        : tone === "emerald"
          ? "border-[#17624b] bg-[#17624b]"
          : "border-[#334155] bg-[#334155]";

  return (
    <div className={`rounded-xl border px-4 py-3 text-white ${toneClasses}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">{label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-white">{value}</p>
          <p className="mt-1 text-xs text-white/70">{hint}</p>
        </div>
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white">
          {icon}
        </span>
      </div>
    </div>
  );
}

function ChartFrame({
  eyebrow,
  title,
  subtitle,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card variant="default" padding="md">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{eyebrow}</p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function MinimalLineChart({
  data,
  valueFormatter,
}: {
  data: TrendPoint[];
  valueFormatter?: (value: number) => string;
}) {
  const width = 680;
  const height = CHART_HEIGHT;
  const padding = { top: 18, right: 18, bottom: 28, left: 18 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...data.map((point) => point.value), 1);

  const points = data.map((point, index) => {
    const x = padding.left + (data.length === 1 ? innerWidth / 2 : (index / (data.length - 1)) * innerWidth);
    const y = padding.top + innerHeight - (point.value / maxValue) * innerHeight;
    return { ...point, x, y };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? padding.left} ${padding.top + innerHeight} L ${points[0]?.x ?? padding.left} ${padding.top + innerHeight} Z`;

  return (
    <div className="space-y-3">
      <div className="h-[210px] overflow-hidden rounded-xl border border-slate-200 bg-white px-3 py-3">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="quotefly-line-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2559b8" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#2559b8" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {[0, 0.5, 1].map((ratio) => {
            const y = padding.top + innerHeight * ratio;
            return <line key={ratio} x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" />;
          })}

          <path d={areaPath} fill="url(#quotefly-line-fill)" />
          <path d={linePath} fill="none" stroke="#2559b8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

          {points.map((point) => (
            <g key={point.fullLabel}>
              <circle cx={point.x} cy={point.y} r="4.5" fill="#2559b8" />
              <circle cx={point.x} cy={point.y} r="8" fill="#2559b8" fillOpacity="0.12" />
            </g>
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-7 gap-2 text-[11px] text-slate-500 sm:grid-cols-14">
        {data.map((point) => (
          <div key={point.fullLabel} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-center">
            <div className="font-semibold text-slate-900">{valueFormatter ? valueFormatter(point.value) : point.value}</div>
            <div className="mt-1 truncate">{point.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MinimalBarChart({
  data,
  valueFormatter,
}: {
  data: TrendPoint[];
  valueFormatter?: (value: number) => string;
}) {
  const maxValue = Math.max(...data.map((point) => point.value), 1);

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
        {data.map((point) => {
          const widthPercent = `${(point.value / maxValue) * 100}%`;
          return (
            <div key={point.fullLabel} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-slate-600">{point.fullLabel}</span>
                <span className="font-semibold text-slate-900">{valueFormatter ? valueFormatter(point.value) : point.value}</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-[#2559b8]" style={{ width: widthPercent }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityLog({ items }: { items: ActivityItem[] }) {
  return (
    <div className="space-y-3">
      {items.length ? (
        items.map((item) => (
          <div key={item.id} className="flex gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <span
              className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                item.tone === "blue"
                  ? "bg-[#2559b8] text-white"
                  : item.tone === "orange"
                    ? "bg-[#d97706] text-white"
                    : item.tone === "emerald"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-700 text-white"
              }`}
            >
              {item.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                <span className="text-xs text-slate-500">{formatDateTime(item.occurredAt)}</span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{item.detail}</p>
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="No activity yet" description="Events will show here as customers and quotes start moving." />
      )}
    </div>
  );
}

function LifecycleMix({ quotes }: { quotes: Quote[] }) {
  const counts = lifecycleCountMap(quotes);
  const total = quotes.length || 1;

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      {(Object.keys(counts) as QuoteLifecycleStage[]).map((stage) => {
        const count = counts[stage];
        const widthPercent = `${(count / total) * 100}%`;
        return (
          <div key={stage} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${stage === "DRAFT" ? "border-slate-700 bg-slate-700 text-white" : stage === "COMPLETED" ? "border-[#2559b8] bg-[#2559b8] text-white" : stage === "SENT" ? "border-[#d97706] bg-[#d97706] text-white" : stage === "CLOSED" ? "border-[#2b7aa5] bg-[#2b7aa5] text-white" : "border-emerald-600 bg-emerald-600 text-white"}`}>
                  {stage === "CLOSED" ? "CL" : stage[0]}
                </span>
                <span className="font-medium text-slate-700">{lifecycleLabel(stage)}</span>
              </div>
              <span className="font-semibold text-slate-900">{count}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${stage === "DRAFT" ? "bg-slate-700" : stage === "COMPLETED" ? "bg-[#2559b8]" : stage === "SENT" ? "bg-[#d97706]" : stage === "CLOSED" ? "bg-[#2b7aa5]" : "bg-emerald-600"}`}
                style={{ width: widthPercent }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AnalyticsPage() {
  usePageView("analytics");
  const {
    session,
    stats,
    customers,
    quotes,
    loading,
    error,
    notice,
    setError,
    setNotice,
    loadAll,
    navigateToQuote,
  } = useDashboard();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const averageQuoteValue = quotes.length
    ? quotes.reduce((total, quote) => total + Number(quote.totalAmount), 0) / quotes.length
    : 0;

  const customerQuotesMap = useMemo(() => {
    const map = new Map<string, Quote[]>();
    for (const quote of quotes) {
      const list = map.get(quote.customerId) ?? [];
      list.push(quote);
      map.set(quote.customerId, list);
    }
    return map;
  }, [quotes]);

  const responseTimeHours = useMemo(() => {
    return customers
      .map((customer) => firstResponseHours(customer, customerQuotesMap.get(customer.id) ?? []))
      .filter((value): value is number => value !== null);
  }, [customerQuotesMap, customers]);

  const averageResponseHours = responseTimeHours.length
    ? responseTimeHours.reduce((sum, value) => sum + value, 0) / responseTimeHours.length
    : null;

  const quotesPerDaySeries = useMemo(
    () =>
      buildDailySeries(DAY_RANGE, (start, end) =>
        quotes.filter((quote) => {
          const createdAt = new Date(quote.createdAt);
          return createdAt >= start && createdAt < end;
        }).length,
      ),
    [quotes],
  );

  const responseTimeSeries = useMemo(
    () =>
      buildDailySeries(DAY_RANGE, (start, end) => {
        const matchingHours = customers
          .filter((customer) => {
            const createdAt = new Date(customer.createdAt);
            return createdAt >= start && createdAt < end;
          })
          .map((customer) => firstResponseHours(customer, customerQuotesMap.get(customer.id) ?? []))
          .filter((value): value is number => value !== null);

        if (!matchingHours.length) return 0;
        return matchingHours.reduce((sum, value) => sum + value, 0) / matchingHours.length;
      }),
    [customerQuotesMap, customers],
  );

  const recentQuotes = useMemo(
    () => [...quotes].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, 8),
    [quotes],
  );

  const recentActivity = useMemo(() => buildActivityItems(customers, quotes), [customers, quotes]);

  const trailingQuotesPerDay =
    quotesPerDaySeries.reduce((sum, point) => sum + point.value, 0) / (quotesPerDaySeries.length || 1);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        subtitle="Track response speed, quote volume, and recent activity without leaving the operating workflow."
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <MetricCard
          label="Quotes this month"
          value={String(stats.monthlyQuotes)}
          hint="Current monthly quote volume"
          icon={<ChartColumn size={18} strokeWidth={2.1} />}
          tone="blue"
        />
        <MetricCard
          label="Accepted revenue"
          value={money(stats.acceptedRevenue)}
          hint="Won quote totals"
          icon={<CircleDollarSign size={18} strokeWidth={2.1} />}
          tone="emerald"
        />
        <MetricCard
          label="Avg first response"
          value={describeDurationHours(averageResponseHours)}
          hint="First contact or quote activity after a lead enters"
          icon={<Clock3 size={18} strokeWidth={2.1} />}
          tone="orange"
        />
        <MetricCard
          label="Quotes per day"
          value={trailingQuotesPerDay.toFixed(1)}
          hint="14-day trailing daily average"
          icon={<Activity size={18} strokeWidth={2.1} />}
          tone="slate"
        />
      </div>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_360px]">
        <ChartFrame
          eyebrow="Volume trend"
          title="Quotes per day"
          subtitle="Daily quote creation across the last 14 days."
          action={<Badge tone="blue">{quotes.length} total quotes</Badge>}
        >
          <MinimalLineChart data={quotesPerDaySeries} valueFormatter={(value) => String(value)} />
        </ChartFrame>

        <ChartFrame
          eyebrow="Speed trend"
          title="Lead response time"
          subtitle="Average hours from lead entry to first contact or quote activity."
          action={<Badge tone="orange">{describeDurationHint(averageResponseHours)}</Badge>}
        >
          <MinimalBarChart data={responseTimeSeries} valueFormatter={(value) => (value > 0 ? `${value.toFixed(1)}h` : "—")} />
        </ChartFrame>

        <ChartFrame
          eyebrow="History log"
          title="Recent workspace activity"
          subtitle="A small feed of new leads, quote sends, and wins."
          action={<Button variant="outline" size="sm" onClick={() => void loadAll()}>Refresh</Button>}
        >
          <ActivityLog items={recentActivity} />
        </ChartFrame>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_340px]">
        <ChartFrame
          eyebrow="Recent quote activity"
          title="Latest quote outcomes"
          subtitle="Use this to jump straight into the most recently changed quotes."
        >
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {loading ? (
              <div className="px-4 py-8 text-sm text-slate-600">Loading analytics...</div>
            ) : recentQuotes.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No quote activity yet" description="Quotes will start appearing here once the workspace is in use." />
              </div>
            ) : (
              <>
                <div className="hidden grid-cols-[140px_minmax(0,1.4fr)_150px_120px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                  <span>Quote</span>
                  <span>Customer</span>
                  <span>Status</span>
                  <span>Updated</span>
                </div>
                <div className="divide-y divide-slate-200">
                  {recentQuotes.map((quote) => (
                    <button
                      key={quote.id}
                      type="button"
                      onClick={() => navigateToQuote(quote.id)}
                      className="grid w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 lg:grid-cols-[140px_minmax(0,1.4fr)_150px_120px] lg:items-center"
                    >
                      <div className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{quote.customer?.fullName ?? "Customer missing"}</p>
                        <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
                      </div>
                      <div>
                        <QuoteStatusPill status={quote.status} compact />
                      </div>
                      <div className="text-xs text-slate-500">{formatDateTime(quote.updatedAt)}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </ChartFrame>

        <ChartFrame
          eyebrow="Snapshot"
          title="Workspace mix"
          subtitle="Plan, usage, and current quote lifecycle distribution."
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Plan</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge tone="blue">{session?.effectivePlanName ?? "Starter"}</Badge>
                    {session?.isTrial ? <Badge tone="orange">Trial</Badge> : null}
                  </div>
                </div>
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                  <UserRoundCheck size={18} strokeWidth={2.2} />
                </span>
              </div>
              {session?.usage ? (
                <div className="mt-4 grid gap-2 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">Quotes used:</span> {session.usage.monthlyQuoteCount}</p>
                  <p><span className="font-semibold text-slate-900">AI credits used:</span> {session.usage.monthlyAiQuoteCount}</p>
                </div>
              ) : null}
            </div>

            <LifecycleMix quotes={quotes} />

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-semibold text-slate-900">Average quote value</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{money(averageQuoteValue)}</p>
              <p className="mt-1 text-xs text-slate-500">{customers.length} customer records in workspace</p>
            </div>
          </div>
        </ChartFrame>
      </div>
    </div>
  );
}
