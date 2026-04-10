import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useDashboard, money, formatDateTime, SERVICE_TYPES, QUOTE_STATUSES } from "../components/dashboard/DashboardContext";
import { FeatureLockedCard, QuoteMathSummaryPanel, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { DeleteIcon, SendIcon } from "../components/Icons";
import { Button, Card, CardHeader, Input, Select, Textarea, Alert, EmptyState } from "../components/ui";
import { usePageView, useTrack } from "../lib/analytics";

export function QuoteDeskView() {
  usePageView("quote_desk");
  const track = useTrack();
  const {
    selectedQuoteId, focusQuoteDesk,
    selectedQuote, selectedQuoteMath, quoteEditForm, setQuoteEditForm,
    lineItemForm, setLineItemForm, lineItemMath,
    saving, error, notice, setError, setNotice,
    saveQuote, sendDecision, openSendComposer, confirmSendComposer,
    downloadQuotePdf, addLineItem, deleteLineItem, persistSelectedQuote,
    sendComposer, setSendComposer,
    canViewQuoteHistory, canViewCommunicationLog, currentPlanLabel, canAutoUpgradeMessage,
    quoteHistory, outboundEvents, outboundEventsLoading, historyLoading,
    historyMode, setHistoryMode, historyCustomerId, setHistoryCustomerId,
    customers, loadQuoteHistory, loadOutboundEvents,
  } = useDashboard();
  const { quoteId } = useParams<{ quoteId: string }>();

  useEffect(() => {
    if (!quoteId) return;
    if (quoteId !== selectedQuoteId) {
      focusQuoteDesk(quoteId);
    }
  }, [quoteId, selectedQuoteId, focusQuoteDesk]);

  const serviceOptions = SERVICE_TYPES.map((s) => ({ value: s, label: s }));
  const statusOptions = QUOTE_STATUSES.map((s) => ({ value: s, label: s }));

  if (!selectedQuote) {
    return <EmptyState title="No quote selected" description="Select a quote from the Builder tab or create a new one." />;
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {/* ── Quote Header ── */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{selectedQuote.title}</h2>
            <p className="text-xs text-slate-600">Customer: {selectedQuote.customer?.fullName ?? selectedQuote.customerId}</p>
          </div>
          <QuoteStatusPill status={selectedQuote.status} />
        </div>
      </Card>

      {/* ── Edit Form ── */}
      <Card>
        <CardHeader title="Quote Details" />
        <form onSubmit={(e) => { track("quote_save"); void saveQuote(e); }} className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <Select value={quoteEditForm.serviceType} onChange={(e) => setQuoteEditForm((prev) => ({ ...prev, serviceType: e.target.value as typeof prev.serviceType }))} options={serviceOptions} />
            <Select value={quoteEditForm.status} onChange={(e) => setQuoteEditForm((prev) => ({ ...prev, status: e.target.value as typeof prev.status }))} options={statusOptions} />
            <Input type="number" min="0" step="0.01" placeholder="Tax amount" value={quoteEditForm.taxAmount} onChange={(e) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: e.target.value }))} />
          </div>
          <Input value={quoteEditForm.title} onChange={(e) => setQuoteEditForm((prev) => ({ ...prev, title: e.target.value }))} placeholder="Title" />
          <Textarea rows={3} value={quoteEditForm.scopeText} onChange={(e) => setQuoteEditForm((prev) => ({ ...prev, scopeText: e.target.value }))} placeholder="Scope details" />
          {selectedQuoteMath && (
            <QuoteMathSummaryPanel
              summary={selectedQuoteMath}
              money={money}
              warning={
                selectedQuoteMath.customerSubtotal > 0 && selectedQuoteMath.estimatedProfit < 0
                  ? "Current pricing is below cost."
                  : selectedQuoteMath.customerSubtotal > 0 && selectedQuoteMath.estimatedMarginPercent < 10
                    ? "Margin is below 10%."
                    : undefined
              }
            />
          )}

          {/* Desktop action buttons */}
          <div className="hidden flex-wrap gap-2 sm:flex">
            <Button type="submit" loading={saving}>Save Quote</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_mark_quoted"); void sendDecision("send"); }} disabled={saving} icon={<SendIcon size={14} />}>Mark Quoted</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_revise"); void sendDecision("revise"); }} disabled={saving}>Revise</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_email"); openSendComposer("email"); }} disabled={saving}>Email App</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_sms"); openSendComposer("sms"); }} disabled={saving}>Text App</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_copy"); openSendComposer("copy"); }} disabled={saving}>Copy Message</Button>
            <Button type="button" variant="outline" onClick={() => { track("quote_pdf"); void downloadQuotePdf(); }} disabled={saving}>Download PDF</Button>
            <Button type="button" variant="secondary" onClick={() => { track("quote_send_pdf"); void downloadQuotePdf({ afterSend: true }); }} disabled={saving}>Send + PDF</Button>
          </div>
          <p className="text-xs text-slate-600">
            Email and text use the device apps after confirmation, so no paid messaging service is required for v1.
          </p>
        </form>
      </Card>

      {/* ── Line Items ── */}
      <Card>
        <CardHeader title="Line Items" />
        <div className="space-y-2">
          {(selectedQuote.lineItems ?? []).map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div>
                <p className="text-sm text-slate-900">{item.description}</p>
                <p className="text-xs text-slate-600">Qty {Number(item.quantity)} · {money(item.unitPrice)}</p>
              </div>
              <Button variant="danger" size="sm" onClick={() => { track("line_item_delete"); void deleteLineItem(item.id); }} icon={<DeleteIcon size={12} />}>Delete</Button>
            </div>
          ))}
        </div>
        <form onSubmit={(e) => { track("line_item_add"); void addLineItem(e); }} className="mt-3 space-y-2 border-t border-slate-200 pt-3">
          <Input placeholder="Description" value={lineItemForm.description} onChange={(e) => setLineItemForm((prev) => ({ ...prev, description: e.target.value }))} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input type="number" min="0" step="0.01" placeholder="Qty" value={lineItemForm.quantity} onChange={(e) => setLineItemForm((prev) => ({ ...prev, quantity: e.target.value }))} />
            <Input type="number" min="0" step="0.01" placeholder="Unit cost" value={lineItemForm.unitCost} onChange={(e) => setLineItemForm((prev) => ({ ...prev, unitCost: e.target.value }))} />
            <Input type="number" min="0" step="0.01" placeholder="Unit price" value={lineItemForm.unitPrice} onChange={(e) => setLineItemForm((prev) => ({ ...prev, unitPrice: e.target.value }))} />
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            Draft line math: Cost {money(lineItemMath.costTotal)} · Price {money(lineItemMath.priceTotal)} · Profit{" "}
            <span className={lineItemMath.profit >= 0 ? "text-emerald-700" : "text-red-700"}>
              {money(lineItemMath.profit)}
            </span>
          </div>
          <Button type="submit" loading={saving}>Add Line Item</Button>
        </form>
      </Card>

      {selectedQuoteMath && <QuoteMathSummaryPanel summary={selectedQuoteMath} money={money} />}

      {/* ── Mobile Sticky Actions ── */}
      <div className="sticky bottom-16 z-20 rounded-xl border border-slate-200 bg-white p-3 shadow-lg sm:hidden">
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={() => void persistSelectedQuote()} loading={saving}>Save</Button>
          <Button size="sm" variant="outline" onClick={() => void sendDecision("send")} disabled={saving}>Mark Quoted</Button>
          <Button size="sm" variant="outline" onClick={() => openSendComposer("email")} disabled={saving}>Email</Button>
          <Button size="sm" variant="outline" onClick={() => void downloadQuotePdf()} disabled={saving}>PDF</Button>
        </div>
      </div>

      {/* ── Quote History ── */}
      {canViewQuoteHistory ? (
        <Card>
          <CardHeader
            title="Quote Revision History"
            subtitle="Track original quote values, revisions, and decision changes."
            actions={<Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>Refresh</Button>}
          />
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(["quote", "customer", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setHistoryMode(mode)}
                className={`rounded-md border px-2 py-1 text-xs ${historyMode === mode ? "border-quotefly-blue bg-quotefly-blue/20 text-white" : "border-slate-300 bg-white text-slate-700"}`}
              >
                {mode === "quote" ? "Selected Quote" : mode === "customer" ? "By Customer" : "All Activity"}
              </button>
            ))}
            {historyMode === "customer" && (
              <select
                value={historyCustomerId}
                onChange={(e) => setHistoryCustomerId(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
              >
                <option value="ALL">Select customer...</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
              </select>
            )}
          </div>
          {historyLoading ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">Loading revision history...</p>
          ) : quoteHistory.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">No history entries for this filter yet.</p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-auto">
              {quoteHistory.map((revision) => (
                <div key={revision.id} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <QuoteStatusPill status={revision.status} compact />
                      <p className="truncate text-sm font-medium text-slate-900">{revision.title}</p>
                    </div>
                    <p className="text-xs text-slate-600">{formatDateTime(revision.createdAt)}</p>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    v{revision.version} · Customer: {revision.customer.fullName} · Total {money(revision.totalAmount)}
                  </p>
                  {revision.changedFields.length > 0 && (
                    <p className="mt-1 text-[11px] text-slate-500">Fields: {revision.changedFields.join(", ")}</p>
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
            title="Send Activity"
            subtitle="Logged email/text/copy actions for this quote."
            actions={<Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>Refresh</Button>}
          />
          {outboundEventsLoading ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">Loading send activity...</p>
          ) : outboundEvents.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">No send actions logged yet.</p>
          ) : (
            <div className="max-h-52 space-y-2 overflow-auto">
              {outboundEvents.map((event) => (
                <div key={event.id} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{event.channel}</span>
                    <p className="text-xs text-slate-600">{formatDateTime(event.createdAt)}</p>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{event.destination ? `To: ${event.destination}` : "Destination not captured"}</p>
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

      {/* ── Send Composer Modal ── */}
      {sendComposer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <Card className="w-full max-w-lg">
            <h3 className="text-lg font-semibold text-slate-900">
              {sendComposer.channel === "email" ? "Email Quote" : sendComposer.channel === "sms" ? "Text Quote" : "Copy Quote Message"}
            </h3>
            <p className="mt-1 text-sm text-slate-600">To: {sendComposer.customerName}</p>
            {sendComposer.channel === "email" && (
              <Input label="Subject" value={sendComposer.subject} onChange={(e) => setSendComposer((prev) => prev ? { ...prev, subject: e.target.value } : prev)} className="mt-3" />
            )}
            <Textarea label="Message" rows={8} value={sendComposer.body} onChange={(e) => setSendComposer((prev) => prev ? { ...prev, body: e.target.value } : prev)} className="mt-3" />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSendComposer(null)} disabled={saving}>Cancel</Button>
              <Button onClick={() => { track("send_composer_confirm"); void confirmSendComposer(); }} loading={saving}>
                {sendComposer.channel === "copy" ? "Copy & Mark Quoted" : "Open App & Mark Quoted"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
