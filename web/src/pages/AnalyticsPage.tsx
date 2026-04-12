import { useEffect, useMemo, type ReactNode } from "react";
import { BadgeCheck, ChartColumn, CircleDollarSign, Send } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import { QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { useDashboard, money, formatDateTime } from "../components/dashboard/DashboardContext";
import { usePageView } from "../lib/analytics";

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
      ? "border-quotefly-blue/15 bg-quotefly-blue/[0.04]"
      : tone === "orange"
        ? "border-quotefly-orange/15 bg-quotefly-orange/[0.05]"
        : tone === "emerald"
          ? "border-emerald-200 bg-emerald-50/70"
          : "border-slate-200 bg-slate-50/80";
  const iconClasses =
    tone === "blue"
      ? "bg-quotefly-blue/[0.10] text-quotefly-blue"
      : tone === "orange"
        ? "bg-quotefly-orange/[0.10] text-quotefly-orange"
        : tone === "emerald"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-white text-slate-600";

  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClasses}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
        </div>
        <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${iconClasses}`}>
          {icon}
        </span>
      </div>
    </div>
  );
}

function quoteNumber(id: string) {
  return `QF-${id.slice(0, 8).toUpperCase()}`;
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
  const awaitingResponse = quotes.filter((quote) => ["READY_FOR_REVIEW", "SENT_TO_CUSTOMER"].includes(quote.status));
  const acceptanceRate = quotes.length
    ? Math.round((quotes.filter((quote) => quote.status === "ACCEPTED").length / quotes.length) * 100)
    : 0;
  const recentQuotes = useMemo(
    () => [...quotes].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, 8),
    [quotes],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        subtitle="Keep the reporting simple: quote volume, revenue, response load, and recent outcomes."
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Quotes this month" value={String(stats.monthlyQuotes)} hint="Current monthly volume" icon={<ChartColumn size={18} strokeWidth={2.1} />} tone="blue" />
        <MetricCard label="Accepted revenue" value={money(stats.acceptedRevenue)} hint="Won quote totals" icon={<CircleDollarSign size={18} strokeWidth={2.1} />} tone="emerald" />
        <MetricCard label="Avg quote value" value={money(averageQuoteValue)} hint="Average total across quotes" icon={<BadgeCheck size={18} strokeWidth={2.1} />} tone="slate" />
        <MetricCard label="Acceptance rate" value={`${acceptanceRate}%`} hint={`${awaitingResponse.length} still awaiting response`} icon={<Send size={18} strokeWidth={2.1} />} tone="orange" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_320px]">
        <Card variant="default" padding="md">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Recent quote activity</p>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">Latest quote outcomes</h2>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadAll()}>Refresh</Button>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
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
        </Card>

        <Card variant="default" padding="md">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Workspace snapshot</p>
          <div className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Customers in workspace</p>
                <p className="mt-1 text-xs text-slate-500">Active customer records across the tenant</p>
              </div>
              <span className="text-2xl font-bold tracking-tight text-slate-900">{customers.length}</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-sm font-semibold text-slate-900">Plan</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="blue">{session?.effectivePlanName ?? "Starter"}</Badge>
                {session?.isTrial ? <Badge tone="orange">Trial</Badge> : null}
              </div>
            </div>
            {session?.usage ? (
              <div className="grid gap-3 px-4 py-3 text-sm text-slate-700">
                <p><span className="font-semibold text-slate-900">Quotes used:</span> {session.usage.monthlyQuoteCount}</p>
                <p><span className="font-semibold text-slate-900">AI drafts used:</span> {session.usage.monthlyAiQuoteCount}</p>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

