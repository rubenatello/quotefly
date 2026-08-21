import { useDashboard, money, formatDateTime } from "../components/dashboard/DashboardContext";
import { useTranslation } from "react-i18next";
import { FeatureLockedCard, QuoteStatusPill, HistoryEventPill, OutboundChannelPill } from "../components/dashboard/DashboardUi";
import { Card, CardHeader, Button, EmptyState, Alert, LoadingState } from "../components/ui";
import { usePageView } from "../lib/analytics";

export function QuoteHistoryView() {
  usePageView("quote_history");
  const { t, i18n } = useTranslation();
  const {
    session, error, notice, setError, setNotice,
    canViewQuoteHistory, canViewCommunicationLog,
    currentPlanLabel, canAutoUpgradeMessage,
    quoteHistory, historyLoading, historyMode, setHistoryMode,
    historyCustomerId, setHistoryCustomerId, customers,
    loadQuoteHistory,
    selectedQuote, outboundEvents, outboundEventsLoading,
    loadOutboundEvents,
  } = useDashboard();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const formatMoney = (value: string | number) => money(value, locale);
  const formatLocalDate = (value: string) => formatDateTime(value, locale, session?.timezone);

  return (
    <div className="space-y-5">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {canViewQuoteHistory ? (
        <Card>
          <CardHeader
            title={t("quoteComponents.history.title")}
            subtitle={t("quoteComponents.history.subtitle")}
            actions={<Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>{t("quoteComponents.history.refresh")}</Button>}
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
                {t(`quoteComponents.history.mode.${mode}`)}
              </button>
            ))}
            {historyMode === "customer" && (
              <select
                aria-label={t("quoteComponents.history.customerFilter")}
                value={historyCustomerId}
                onChange={(e) => setHistoryCustomerId(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"
              >
                <option value="ALL">{t("quoteComponents.history.selectCustomer")}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName}</option>
                ))}
              </select>
            )}
          </div>

          {historyLoading ? (
            <LoadingState
              title={t("quoteComponents.history.loading")}
              description={t("quoteComponents.history.loadingDescription")}
              variant="list"
              rows={4}
            />
          ) : quoteHistory.length === 0 ? (
            <EmptyState title={t("quoteComponents.history.empty")} description={t("quoteComponents.history.emptyDescription")} />
          ) : (
            <div className="max-h-[500px] space-y-2 overflow-auto">
              {quoteHistory.map((revision) => (
                <div key={revision.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <HistoryEventPill eventType={revision.eventType} />
                      <p className="truncate text-sm font-medium text-slate-900">{revision.title}</p>
                    </div>
                    <p className="shrink-0 text-xs text-slate-600">{formatLocalDate(revision.createdAt)}</p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <p className="text-slate-600">
                      {t("quoteComponents.history.revisionMeta", { version: revision.version, customer: revision.customer.fullName, actor: revision.actorName || revision.actorEmail || t("quoteComponents.unknown") })}
                    </p>
                    <div className="flex items-center gap-2">
                      <QuoteStatusPill status={revision.status} compact />
                      <p className="text-slate-700">
                        {t("quoteComponents.history.totals", { subtotal: formatMoney(revision.customerPriceSubtotal), total: formatMoney(revision.totalAmount) })}
                      </p>
                    </div>
                  </div>
                  {revision.changedFields.length > 0 && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {t("quoteComponents.history.fields", { fields: revision.changedFields.join(", ") })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <FeatureLockedCard
          title={t("quoteComponents.history.title")}
          description={t("quoteComponents.history.locked")}
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Professional"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}

      {canViewCommunicationLog ? (
        <Card>
          <CardHeader
            title={t("quoteComponents.sendLog.title")}
            subtitle={selectedQuote ? t("quoteComponents.sendLog.forQuote", { title: selectedQuote.title }) : t("quoteComponents.sendLog.select")}
            actions={selectedQuote ? <Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>{t("quoteComponents.history.refresh")}</Button> : undefined}
          />

          {!selectedQuote ? (
            <EmptyState title={t("quoteComponents.sendLog.noQuote")} description={t("quoteComponents.sendLog.noQuoteDescription")} />
          ) : outboundEventsLoading ? (
            <LoadingState
              title={t("quoteComponents.sendLog.loading")}
              description={t("quoteComponents.sendLog.loadingDescription")}
              variant="list"
              rows={3}
            />
          ) : outboundEvents.length === 0 ? (
            <EmptyState title={t("quoteComponents.sendLog.empty")} description={t("quoteComponents.sendLog.emptyDescription")} />
          ) : (
            <div className="max-h-[400px] space-y-2 overflow-auto">
              {outboundEvents.map((event) => (
                <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <OutboundChannelPill channel={event.channel} />
                    <p className="text-xs text-slate-600">{formatLocalDate(event.createdAt)}</p>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {event.destination ? t("quoteComponents.sendLog.to", { destination: event.destination }) : t("quoteComponents.sendLog.noDestination")}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{t("quoteComponents.sendLog.by", { actor: event.actorName || event.actorEmail || t("quoteComponents.unknown") })}</p>
                  {event.subject && <p className="mt-1 text-xs text-slate-600">{t("quoteComponents.sendLog.subject", { subject: event.subject })}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <FeatureLockedCard
          title={t("quoteComponents.sendLog.title")}
          description={t("quoteComponents.sendLog.locked")}
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Professional"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}
    </div>
  );
}
