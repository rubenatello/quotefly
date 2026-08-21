import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  CalendarRange,
  ChartColumn,
  CircleDollarSign,
  Clock3,
  FileText,
  RefreshCw,
  Send,
  UserRoundCheck,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, LoadingState, PageHeader } from "../components/ui";
import { QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { KodyButton } from "../components/ai/KodyButton";
import { useDashboard, formatDateTime, money } from "../components/dashboard/DashboardContext";
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

type QuoteLifecycleStage = "DRAFT" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "INVOICED";
type RangePreset = "last_week" | "last_month" | "this_month" | "last_90" | "custom";

type DateRange = {
  start: Date;
  endExclusive: Date;
};

const DEFAULT_PRESET: RangePreset = "last_week";
const CHART_HEIGHT = 224;

const RANGE_OPTIONS: RangePreset[] = ["last_week", "last_month", "this_month", "last_90", "custom"];

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateInputValue(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function differenceInDays(start: Date, endExclusive: Date) {
  return Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

function formatRangeLabel(range: DateRange, locale: string, timeZone?: string | null) {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  }
  const startLabel = formatter.format(range.start);
  const endLabel = formatter.format(addDays(range.endExclusive, -1));
  return `${startLabel} - ${endLabel}`;
}

function getDateRangeForPreset(preset: RangePreset, now = new Date()): DateRange {
  const today = startOfDay(now);

  if (preset === "this_month") {
    return { start: startOfMonth(today), endExclusive: addDays(today, 1) };
  }

  if (preset === "last_month") {
    const currentMonthStart = startOfMonth(today);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      endExclusive: currentMonthStart,
    };
  }

  if (preset === "last_90") {
    return { start: addDays(today, -89), endExclusive: addDays(today, 1) };
  }

  return { start: addDays(today, -6), endExclusive: addDays(today, 1) };
}

function isWithinRange(dateValue: string | null | undefined, range: DateRange) {
  if (!dateValue) return false;
  const time = new Date(dateValue).getTime();
  if (!Number.isFinite(time)) return false;
  return time >= range.start.getTime() && time < range.endExclusive.getTime();
}

function shortDayLabel(date: Date, locale: string, timeZone?: string | null) {
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  }
}

function buildRangeSeries(
  range: DateRange,
  getValue: (start: Date, end: Date) => number,
  locale: string,
  timeZone?: string | null,
): TrendPoint[] {
  const totalDays = differenceInDays(range.start, range.endExclusive);
  const bucketSize = totalDays > 31 ? 7 : 1;
  const points: TrendPoint[] = [];

  for (let cursor = new Date(range.start); cursor < range.endExclusive; cursor = addDays(cursor, bucketSize)) {
    const bucketEnd = new Date(Math.min(addDays(cursor, bucketSize).getTime(), range.endExclusive.getTime()));
    const isSingleDay = differenceInDays(cursor, bucketEnd) === 1;
    points.push({
      label: isSingleDay
        ? new Intl.DateTimeFormat(locale, { weekday: "short", ...(timeZone ? { timeZone } : {}) }).format(cursor)
        : shortDayLabel(cursor, locale, timeZone),
      fullLabel: isSingleDay
        ? shortDayLabel(cursor, locale, timeZone)
        : `${shortDayLabel(cursor, locale, timeZone)} - ${shortDayLabel(addDays(bucketEnd, -1), locale, timeZone)}`,
      value: getValue(cursor, bucketEnd),
    });
  }

  return points;
}

function describeDurationHours(hours: number | null, t: TFunction) {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours >= 48) return t("analytics.duration.dayShort", { days: (hours / 24).toFixed(1) });
  return t("analytics.duration.hourShort", { hours: hours.toFixed(1) });
}

function describeDurationHint(hours: number | null, t: TFunction) {
  if (hours === null || !Number.isFinite(hours)) return t("analytics.duration.none");
  if (hours < 1) return t("analytics.duration.minutes", { count: Math.round(hours * 60) });
  return t("analytics.duration.hours", { hours: hours.toFixed(1) });
}

function lifecycleStage(quote: Quote): QuoteLifecycleStage {
  const syncedInvoice = quote.quickBooksInvoiceSyncs?.some(
    (sync) => sync.status === "SYNCED" && !!sync.quickBooksInvoiceId,
  );

  if (syncedInvoice) return "INVOICED";
  if (quote.status === "ACCEPTED") return "ACCEPTED";
  if (quote.status === "REJECTED") return "DECLINED";
  if (quote.status === "SENT_TO_CUSTOMER") return "SENT";
  if (quote.status === "READY_FOR_REVIEW") return "READY";
  return "DRAFT";
}

function lifecycleLabel(stage: QuoteLifecycleStage, t: TFunction) {
  return t(`analytics.lifecycle.${stage.toLowerCase()}`);
}

function lifecycleInitial(stage: QuoteLifecycleStage) {
  if (stage === "READY") return "R";
  if (stage === "ACCEPTED") return "A";
  if (stage === "DECLINED") return "X";
  return stage[0];
}

function lifecycleColorClass(stage: QuoteLifecycleStage, bar = false) {
  if (stage === "DRAFT") return bar ? "bg-slate-700" : "border-slate-700 bg-slate-700 text-white";
  if (stage === "READY") return bar ? "bg-[var(--qf-info-strong)]" : "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)] text-white";
  if (stage === "SENT") return bar ? "bg-[var(--qf-warning-strong)]" : "border-[var(--qf-warning-strong)] bg-[var(--qf-warning-strong)] text-white";
  if (stage === "DECLINED") return bar ? "bg-[var(--qf-danger-strong)]" : "border-[var(--qf-danger-strong)] bg-[var(--qf-danger-strong)] text-white";
  return bar ? "bg-[var(--qf-success-strong)]" : "border-[var(--qf-success-strong)] bg-[var(--qf-success-strong)] text-white";
}

function lifecycleCountMap(quotes: Quote[]) {
  return quotes.reduce<Record<QuoteLifecycleStage, number>>(
    (accumulator, quote) => {
      accumulator[lifecycleStage(quote)] += 1;
      return accumulator;
    },
    { DRAFT: 0, READY: 0, SENT: 0, ACCEPTED: 0, DECLINED: 0, INVOICED: 0 },
  );
}

function firstResponseHours(customer: Customer, quotes: Quote[]) {
  const candidateTimes = [customer.followUpUpdatedAtUtc, ...quotes.map((quote) => quote.sentAt)]
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
function buildActivityItems(
  customers: Customer[],
  quotes: Quote[],
  range: DateRange,
  t: TFunction,
  formatMoney: (value: string | number) => string,
) {
  const items: ActivityItem[] = [];

  for (const customer of customers) {
    if (isWithinRange(customer.createdAt, range)) {
      items.push({
        id: `${customer.id}-created`,
        occurredAt: customer.createdAt,
        title: t("analytics.activity.leadAdded"),
        detail: customer.fullName,
        tone: "blue",
        icon: <UserRoundCheck size={14} strokeWidth={2.2} />,
      });
    }

    if (isWithinRange(customer.followUpUpdatedAtUtc, range)) {
      items.push({
        id: `${customer.id}-follow-up`,
        occurredAt: customer.followUpUpdatedAtUtc as string,
        title: t("analytics.activity.leadUpdated"),
        detail: `${customer.fullName} - ${t(`quoteComponents.followUp.${customer.followUpStatus}`)}`,
        tone: customer.followUpStatus === "WON" ? "emerald" : customer.followUpStatus === "LOST" ? "orange" : "slate",
        icon: <Clock3 size={14} strokeWidth={2.2} />,
      });
    }
  }

  for (const quote of quotes) {
    if (isWithinRange(quote.createdAt, range)) {
      items.push({
        id: `${quote.id}-drafted`,
        occurredAt: quote.createdAt,
        title: t("analytics.activity.quoteDrafted"),
        detail: `${quote.customer?.fullName ?? t("analytics.activity.missingCustomer")} - ${quote.title}`,
        tone: "blue",
        icon: <FileText size={14} strokeWidth={2.2} />,
      });
    }

    if (isWithinRange(quote.sentAt, range)) {
      items.push({
        id: `${quote.id}-sent`,
        occurredAt: quote.sentAt as string,
        title: t("analytics.activity.quoteSent"),
        detail: `${quote.customer?.fullName ?? t("analytics.activity.missingCustomer")} - ${formatMoney(quote.totalAmount)}`,
        tone: "orange",
        icon: <Send size={14} strokeWidth={2.2} />,
      });
    }

    if (quote.status === "ACCEPTED" && isWithinRange(quote.closedAtUtc ?? quote.updatedAt, range)) {
      items.push({
        id: `${quote.id}-accepted`,
        occurredAt: (quote.closedAtUtc ?? quote.updatedAt) as string,
        title: t("analytics.activity.quoteAccepted"),
        detail: `${quote.customer?.fullName ?? t("analytics.activity.missingCustomer")} - ${formatMoney(quote.totalAmount)}`,
        tone: "emerald",
        icon: <BadgeCheck size={14} strokeWidth={2.2} />,
      });
    }
  }

  return items
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 8);
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
      ? "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)]"
      : tone === "orange"
        ? "border-[var(--qf-warning-strong)] bg-[var(--qf-warning-strong)]"
        : tone === "emerald"
          ? "border-[var(--qf-success-strong)] bg-[var(--qf-success-strong)]"
          : "border-[#334155] bg-[#334155]";

  return (
    <div className={`rounded-xl border px-3 py-3 text-white sm:rounded-2xl sm:px-4 sm:py-4 ${toneClasses}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">{label}</p>
          <p className="mt-2 text-xl font-bold tracking-tight text-white sm:text-[1.9rem]">{value}</p>
          <p className="mt-1 hidden text-xs leading-5 text-white/70 sm:block">{hint}</p>
        </div>
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white sm:h-10 sm:w-10">
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
    <Card variant="default" padding="md" className="h-full">
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{eyebrow}</p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function MinimalLineChart({ data, valueFormatter }: { data: TrendPoint[]; valueFormatter?: (value: number) => string }) {
  const width = 680;
  const height = CHART_HEIGHT;
  const padding = { top: 18, right: 18, bottom: 20, left: 18 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...data.map((point) => point.value), 1);

  const points = data.map((point, index) => {
    const x = padding.left + (data.length === 1 ? innerWidth / 2 : (index / Math.max(data.length - 1, 1)) * innerWidth);
    const y = padding.top + innerHeight - (point.value / maxValue) * innerHeight;
    return { ...point, x, y };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? padding.left} ${padding.top + innerHeight} L ${points[0]?.x ?? padding.left} ${padding.top + innerHeight} Z`;
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  const footerPoints = data.filter((_, index) => index % labelStep === 0 || index === data.length - 1);

  return (
    <div className="space-y-3">
      <div className="h-[224px] overflow-hidden rounded-2xl border border-slate-200 bg-white px-3 py-3 sm:h-[240px]">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="quotefly-analytics-line-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2559b8" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#2559b8" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((ratio) => {
            const y = padding.top + innerHeight * ratio;
            return <line key={ratio} x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" />;
          })}
          <path d={areaPath} fill="url(#quotefly-analytics-line-fill)" />
          <path d={linePath} fill="none" stroke="#2559b8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((point) => (
            <g key={point.fullLabel}>
              <circle cx={point.x} cy={point.y} r="4.5" fill="#2559b8" />
              <circle cx={point.x} cy={point.y} r="8" fill="#2559b8" fillOpacity="0.12" />
            </g>
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-6">
        {footerPoints.map((point) => (
          <div key={point.fullLabel} className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-center">
            <div className="font-semibold text-slate-900">{valueFormatter ? valueFormatter(point.value) : point.value}</div>
            <div className="mt-1 truncate text-slate-500">{point.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
function MinimalBarChart({ data, valueFormatter }: { data: TrendPoint[]; valueFormatter?: (value: number) => string }) {
  const maxValue = Math.max(...data.map((point) => point.value), 1);

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
      {data.map((point) => {
        const widthPercent = point.value > 0 ? `${(point.value / maxValue) * 100}%` : "0%";
        return (
          <div key={point.fullLabel} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-slate-600">{point.fullLabel}</span>
              <span className="shrink-0 font-semibold text-slate-900">{valueFormatter ? valueFormatter(point.value) : point.value}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-[#2559b8]" style={{ width: widthPercent }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityLog({ items, t, locale, timeZone }: { items: ActivityItem[]; t: TFunction; locale: string; timeZone?: string | null }) {
  return items.length ? (
    <div className="max-h-[520px] space-y-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
      {items.map((item, index) => (
        <div key={item.id} className={`flex gap-3 px-4 py-3 ${index > 0 ? "border-t border-slate-200" : ""}`}>
          <span
            className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              item.tone === "blue"
                ? "bg-[var(--qf-info-strong)] text-white"
                : item.tone === "orange"
                  ? "bg-[var(--qf-warning-strong)] text-white"
                  : item.tone === "emerald"
                    ? "bg-[var(--qf-success-strong)] text-white"
                    : "bg-slate-700 text-white"
            }`}
          >
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-semibold text-slate-900">{item.title}</p>
              <span className="text-xs text-slate-500">{formatDateTime(item.occurredAt, locale, timeZone)}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{item.detail}</p>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <EmptyState title={t("analytics.activity.none")} description={t("analytics.activity.noneDescription")} />
  );
}

function LifecycleMix({ quotes, t }: { quotes: Quote[]; t: TFunction }) {
  const counts = lifecycleCountMap(quotes);
  const total = quotes.length || 1;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      {(Object.keys(counts) as QuoteLifecycleStage[]).map((stage) => {
        const count = counts[stage];
        const widthPercent = `${(count / total) * 100}%`;
        return (
          <div key={stage} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${lifecycleColorClass(stage)}`}>
                  {lifecycleInitial(stage)}
                </span>
                <span className="font-medium text-slate-700">{lifecycleLabel(stage, t)}</span>
              </div>
              <span className="font-semibold text-slate-900">{count}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${lifecycleColorClass(stage, true)}`}
                style={{ width: widthPercent }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RangeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-[44px] items-center justify-center rounded-full border px-3 py-2 text-sm font-medium transition ${
        active
          ? "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)] text-white shadow-[0_8px_20px_rgba(37,89,184,0.18)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)]"
      }`}
    >
      {label}
    </button>
  );
}

export function AnalyticsPage() {
  usePageView("analytics");
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const {
    session,
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
  const timeZone = session?.timezone ?? null;
  const formatMoney = (value: string | number) => money(value, locale);
  const activeRangeLabel = (range: DateRange) => formatRangeLabel(range, locale, timeZone);

  const initialRange = useMemo(() => getDateRangeForPreset(DEFAULT_PRESET), []);
  const [rangePreset, setRangePreset] = useState<RangePreset>(DEFAULT_PRESET);
  const [customStart, setCustomStart] = useState(toDateInputValue(initialRange.start));
  const [customEnd, setCustomEnd] = useState(toDateInputValue(addDays(initialRange.endExclusive, -1)));
  const parsedCustomStart = fromDateInputValue(customStart);
  const parsedCustomEnd = fromDateInputValue(customEnd);
  const customRangeError = rangePreset === "custom"
    ? !parsedCustomStart || !parsedCustomEnd
      ? t("analytics.range.bothRequired")
      : parsedCustomEnd < parsedCustomStart
        ? t("analytics.range.endAfterStart")
        : null
    : null;

  const activeRange = useMemo(() => {
    if (rangePreset !== "custom") {
      return getDateRangeForPreset(rangePreset);
    }

    const start = fromDateInputValue(customStart);
    const end = fromDateInputValue(customEnd);
    if (!start || !end) {
      return getDateRangeForPreset(DEFAULT_PRESET);
    }

    const normalizedStart = startOfDay(start);
    const normalizedEndExclusive = addDays(startOfDay(end), 1);
    if (normalizedEndExclusive <= normalizedStart) {
      return { start: normalizedStart, endExclusive: addDays(normalizedStart, 1) };
    }

    return { start: normalizedStart, endExclusive: normalizedEndExclusive };
  }, [rangePreset, customEnd, customStart]);

  const customerQuotesMap = useMemo(() => {
    const map = new Map<string, Quote[]>();
    for (const quote of quotes) {
      const list = map.get(quote.customerId) ?? [];
      list.push(quote);
      map.set(quote.customerId, list);
    }
    return map;
  }, [quotes]);

  const filteredCustomers = useMemo(
    () => customers.filter((customer) => isWithinRange(customer.createdAt, activeRange) || isWithinRange(customer.followUpUpdatedAtUtc, activeRange)),
    [activeRange, customers],
  );

  const filteredQuotes = useMemo(
    () => quotes.filter((quote) => isWithinRange(quote.createdAt, activeRange) || isWithinRange(quote.updatedAt, activeRange) || isWithinRange(quote.sentAt, activeRange) || isWithinRange(quote.closedAtUtc, activeRange)),
    [activeRange, quotes],
  );

  const responseTimeHours = useMemo(() => {
    return customers
      .filter((customer) => isWithinRange(customer.createdAt, activeRange))
      .map((customer) => firstResponseHours(customer, customerQuotesMap.get(customer.id) ?? []))
      .filter((value): value is number => value !== null);
  }, [activeRange, customerQuotesMap, customers]);

  const averageResponseHours = responseTimeHours.length
    ? responseTimeHours.reduce((sum, value) => sum + value, 0) / responseTimeHours.length
    : null;

  const rangeDays = differenceInDays(activeRange.start, activeRange.endExclusive);
  const quotesPerDaySeries = useMemo(
    () =>
      buildRangeSeries(
        activeRange,
        (start, end) =>
          quotes.filter((quote) => {
            const createdAt = new Date(quote.createdAt);
            return createdAt >= start && createdAt < end;
          }).length,
        locale,
        timeZone,
      ),
    [activeRange, locale, quotes, timeZone],
  );

  const responseTimeSeries = useMemo(
    () =>
      buildRangeSeries(activeRange, (start, end) => {
        const matchingHours = customers
          .filter((customer) => {
            const createdAt = new Date(customer.createdAt);
            return createdAt >= start && createdAt < end;
          })
          .map((customer) => firstResponseHours(customer, customerQuotesMap.get(customer.id) ?? []))
          .filter((value): value is number => value !== null);

        if (!matchingHours.length) return 0;
        return matchingHours.reduce((sum, value) => sum + value, 0) / matchingHours.length;
      }, locale, timeZone),
    [activeRange, customerQuotesMap, customers, locale, timeZone],
  );
  const recentQuotes = useMemo(
    () =>
      [...filteredQuotes]
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .slice(0, 8),
    [filteredQuotes],
  );

  const recentActivity = useMemo(
    () => buildActivityItems(customers, quotes, activeRange, t, (value) => money(value, locale)),
    [activeRange, customers, locale, quotes, t],
  );

  const acceptedRevenueInRange = filteredQuotes
    .filter((quote) => quote.status === "ACCEPTED" && isWithinRange(quote.closedAtUtc ?? quote.updatedAt, activeRange))
    .reduce((total, quote) => total + Number(quote.totalAmount), 0);

  const quotesCreatedInRange = quotes.filter((quote) => isWithinRange(quote.createdAt, activeRange));
  const averageQuoteValue = quotesCreatedInRange.length
    ? quotesCreatedInRange.reduce((total, quote) => total + Number(quote.totalAmount), 0) / quotesCreatedInRange.length
    : 0;

  const quotesPerDay = quotesCreatedInRange.length / rangeDays;

  if (loading && customers.length === 0 && quotes.length === 0) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PageHeader title={t("analytics.title")} subtitle={t("analytics.loadingSubtitle")} mode="actions-only" />
        <LoadingState
          title={t("analytics.loadingTitle")}
          description={t("analytics.loadingDescription")}
          variant="cards"
          rows={4}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <PageHeader
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
        mode="actions-only"
        actions={
          <KodyButton
            label={t("analytics.askKody")}
            prompt={t("analytics.kodyPrompt", { range: activeRangeLabel(activeRange) })}
            tool="SUMMARIZE_PIPELINE"
            context={{
              currentPage: "analytics",
              dateFrom: activeRange.start.toISOString(),
              dateTo: activeRange.endExclusive.toISOString(),
              limit: 8,
            }}
          />
        }
      />

      {error ? (
        <Alert tone="error" onDismiss={() => setError(null)}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void loadAll()}>{t("analytics.retry")}</Button>
          </div>
        </Alert>
      ) : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <Card variant="default" padding="md" className="overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t("analytics.range.eyebrow")}</p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">{t("analytics.range.title")}</h2>
            <p className="mt-1 text-sm text-slate-600">{t("analytics.range.description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={customRangeError ? "orange" : "blue"} icon={<CalendarRange size={12} strokeWidth={2.1} />}>
              {customRangeError ? t("analytics.range.attention") : activeRangeLabel(activeRange)}
            </Badge>
            <Button variant="outline" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadAll()}>
              {t("analytics.refresh")}
            </Button>
          </div>
        </div>

        <div className="qf-horizontal-filter-strip mt-4 flex snap-x gap-2 overflow-x-auto pb-1">
          {RANGE_OPTIONS.map((option) => (
            <RangeButton
              key={option}
              active={rangePreset === option}
              label={t(`analytics.range.${option === "last_week" ? "lastWeek" : option === "last_month" ? "lastMonth" : option === "this_month" ? "thisMonth" : option === "last_90" ? "last90" : "custom"}`)}
              onClick={() => setRangePreset(option)}
            />
          ))}
        </div>

        {rangePreset === "custom" ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[180px_180px_minmax(0,1fr)]">
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600">{t("analytics.range.start")}</span>
              <input
                type="date"
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
                className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#2559b8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,89,184,0.12)]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600">{t("analytics.range.end")}</span>
              <input
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
                className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#2559b8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,89,184,0.12)]"
              />
            </label>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {customRangeError ? (
                <span className="font-medium text-red-700">{customRangeError}</span>
              ) : (
                t("analytics.range.help")
              )}
            </div>
          </div>
        ) : null}
      </Card>

      {customRangeError ? (
        <Alert tone="error">
          {t("analytics.range.hidden", { error: customRangeError })}
        </Alert>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
        <MetricCard
          label={t("analytics.metrics.quotes")}
          value={String(quotesCreatedInRange.length)}
          hint={t("analytics.metrics.quotesHint", { range: activeRangeLabel(activeRange) })}
          icon={<ChartColumn size={18} strokeWidth={2.1} />}
          tone="blue"
        />
        <MetricCard
          label={t("analytics.metrics.wonValue")}
          value={formatMoney(acceptedRevenueInRange)}
          hint={t("analytics.metrics.wonHint")}
          icon={<CircleDollarSign size={18} strokeWidth={2.1} />}
          tone="emerald"
        />
        <MetricCard
          label={t("analytics.metrics.response")}
          value={describeDurationHours(averageResponseHours, t)}
          hint={t("analytics.metrics.responseHint")}
          icon={<Clock3 size={18} strokeWidth={2.1} />}
          tone="orange"
        />
        <MetricCard
          label={t("analytics.metrics.perDay")}
          value={new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(quotesPerDay)}
          hint={t("analytics.metrics.perDayHint", { days: rangeDays })}
          icon={<Activity size={18} strokeWidth={2.1} />}
          tone="slate"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
        <ChartFrame
          eyebrow={t("analytics.charts.volumeEyebrow")}
          title={t("analytics.charts.volumeTitle")}
          subtitle={t(rangeDays > 31 ? "analytics.charts.volumeWeekly" : "analytics.charts.volumeDaily")}
          action={<Badge tone="blue">{t("analytics.charts.created", { count: quotesCreatedInRange.length })}</Badge>}
        >
          <MinimalLineChart data={quotesPerDaySeries} valueFormatter={(value) => String(value)} />
        </ChartFrame>

        <ChartFrame
          eyebrow={t("analytics.charts.historyEyebrow")}
          title={t("analytics.charts.historyTitle")}
          subtitle={t("analytics.charts.historyDescription")}
          action={<Badge tone="slate">{t("analytics.charts.events", { count: recentActivity.length })}</Badge>}
        >
          <ActivityLog items={recentActivity} t={t} locale={locale} timeZone={timeZone} />
        </ChartFrame>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_380px]">
        <ChartFrame
          eyebrow={t("analytics.charts.speedEyebrow")}
          title={t("analytics.charts.speedTitle")}
          subtitle={t(rangeDays > 31 ? "analytics.charts.speedWeekly" : "analytics.charts.speedDaily")}
          action={<Badge tone="orange" icon={<CalendarClock size={12} strokeWidth={2.1} />}>{describeDurationHint(averageResponseHours, t)}</Badge>}
        >
          <MinimalBarChart data={responseTimeSeries} valueFormatter={(value) => (value > 0 ? t("analytics.duration.hourShort", { hours: value.toFixed(1) }) : "—")} />
        </ChartFrame>

        <ChartFrame
          eyebrow={t("analytics.charts.snapshot")}
          title={t("analytics.charts.summary")}
          subtitle={t("analytics.charts.summaryDescription")}
        >
          <div className="space-y-4">
            <LifecycleMix quotes={filteredQuotes} t={t} />

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-semibold text-slate-900">{t("analytics.charts.averageValue")}</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{formatMoney(averageQuoteValue)}</p>
              <p className="mt-1 text-xs text-slate-500">{t("analytics.charts.customersTouched", { count: filteredCustomers.length })}</p>
            </div>
          </div>
        </ChartFrame>
      </div>

      <ChartFrame
        eyebrow={t("analytics.charts.recentEyebrow")}
        title={t("analytics.charts.recentTitle")}
        subtitle={t("analytics.charts.recentDescription")}
      >
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {loading ? (
            <div className="p-4">
              <LoadingState
                title={t("analytics.table.loading")}
                description={t("analytics.table.loadingDescription")}
                variant="table"
                rows={4}
              />
            </div>
          ) : recentQuotes.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t("analytics.table.empty")} description={t("analytics.table.emptyDescription")} />
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[130px_minmax(0,1.25fr)_132px_108px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 xl:grid 2xl:grid-cols-[140px_minmax(0,1.4fr)_150px_120px]">
                <span>{t("analytics.table.quote")}</span>
                <span>{t("analytics.table.customer")}</span>
                <span>{t("analytics.table.status")}</span>
                <span>{t("analytics.table.updated")}</span>
              </div>
              <div className="divide-y divide-slate-200">
                {recentQuotes.map((quote) => (
                  <button
                    key={quote.id}
                    type="button"
                    onClick={() => navigateToQuote(quote.id)}
                    className="grid w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 xl:grid-cols-[130px_minmax(0,1.25fr)_132px_108px] xl:items-center 2xl:grid-cols-[140px_minmax(0,1.4fr)_150px_120px]"
                  >
                    <div className="text-sm font-semibold text-slate-900">{quoteNumber(quote.id)}</div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{quote.customer?.fullName ?? t("analytics.activity.missingCustomer")}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">{quote.title}</p>
                    </div>
                    <div>
                      <QuoteStatusPill status={quote.status} compact />
                    </div>
                    <div className="text-xs text-slate-500">{formatDateTime(quote.updatedAt, locale, timeZone)}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </ChartFrame>
        </>
      )}
    </div>
  );
}
