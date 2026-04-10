import { useDashboard, money, formatDateTime } from "../components/dashboard/DashboardContext";
import { FeatureLockedCard, QuoteStatusPill, HistoryEventPill, OutboundChannelPill } from "../components/dashboard/DashboardUi";
import { Card, CardHeader, Button, EmptyState, Alert } from "../components/ui";
import { usePageView } from "../lib/analytics";

export function QuoteHistoryView() {
  usePageView("quote_history");
  const {
    error, notice, setError, setNotice,
    canViewQuoteHistory, canViewCommunicationLog,
    currentPlanLabel, canAutoUpgradeMessage,
    quoteHistory, historyLoading, historyMode, setHistoryMode,
    historyCustomerId, setHistoryCustomerId, customers,
    loadQuoteHistory,
    selectedQuote, outboundEvents, outboundEventsLoading,
    loadOutboundEvents,
  } = useDashboard();

  return (
    <div className="space-y-5">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {/* ── Revision History ── */}
      {canViewQuoteHistory ? (
        <Card>
          <CardHeader
            title="Quote Revision History"
            subtitle="Track all quote changes, organized by quote, customer, or across all records."
            actions={<Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>Refresh</Button>}
          />
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(["quote", "customer", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setHistoryMode(mode)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  historyMode === mode
                    ? "border-quotefly-blue bg-quotefly-blue text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {mode === "quote" ? "Selected Quote" : mode === "customer" ? "By Customer" : "All Activity"}
              </button>
            ))}
            {historyMode === "customer" && (
              <select
                value={historyCustomerId}
                onChange={(e) => setHistoryCustomerId(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"
              >
                <option value="ALL">Select customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName}</option>
                ))}
              </select>
            )}
          </div>

          {historyLoading ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-600">
              Loading revision history...
            </p>
          ) : quoteHistory.length === 0 ? (
            <EmptyState title="No history" description="No history entries for this filter yet." />
          ) : (
            <div className="max-h-[500px] space-y-2 overflow-auto">
              {quoteHistory.map((revision) => (
                <div key={revision.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <HistoryEventPill eventType={revision.eventType} />
                      <p className="truncate text-sm font-medium text-slate-900">{revision.title}</p>
                    </div>
                    <p className="shrink-0 text-xs text-slate-600">{formatDateTime(revision.createdAt)}</p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <p className="text-slate-600">
                      v{revision.version} · Customer: {revision.customer.fullName}
                    </p>
                    <div className="flex items-center gap-2">
                      <QuoteStatusPill status={revision.status} compact />
                      <p className="text-slate-700">
                        Subtotal {money(revision.customerPriceSubtotal)} · Total {money(revision.totalAmount)}
                      </p>
                    </div>
                  </div>
                  {revision.changedFields.length > 0 && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Fields: {revision.changedFields.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <FeatureLockedCard
          title="Quote Revision History"
          description="Revision history, customer-level history, and long-term quote timelines unlock on Professional."
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Professional"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}

      {/* ── Communication Log ── */}
      {canViewCommunicationLog ? (
        <Card>
          <CardHeader
            title="Communication Log"
            subtitle={selectedQuote ? `Send activity for: ${selectedQuote.title}` : "Select a quote to view send activity."}
            actions={selectedQuote ? <Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>Refresh</Button> : undefined}
          />

          {!selectedQuote ? (
            <EmptyState title="No quote selected" description="Select a quote from the Builder or Quote Desk to see communication logs." />
          ) : outboundEventsLoading ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-600">Loading send activity...</p>
          ) : outboundEvents.length === 0 ? (
            <EmptyState title="No activity" description="No send actions logged yet for this quote." />
          ) : (
            <div className="max-h-[400px] space-y-2 overflow-auto">
              {outboundEvents.map((event) => (
                <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <OutboundChannelPill channel={event.channel} />
                    <p className="text-xs text-slate-600">{formatDateTime(event.createdAt)}</p>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {event.destination ? `To: ${event.destination}` : "Destination not captured"}
                  </p>
                  {event.subject && <p className="mt-1 text-xs text-slate-600">Subject: {event.subject}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <FeatureLockedCard
          title="Communication Log"
          description="Email/text/copy activity tracking unlocks on Professional."
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Professional"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}
    </div>
  );
}
