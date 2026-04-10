import { FeatureLockedCard, QuoteMathSummaryPanel, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { useDashboard, money, CHAT_PROMPT_EXAMPLE, SERVICE_TYPES, QUOTE_STATUSES } from "../components/dashboard/DashboardContext";
import type { ServiceType, QuoteStatus } from "../lib/api";
import { Button, Card, CardHeader, Input, Select, Textarea, Alert } from "../components/ui";
import { usePageView, useTrack } from "../lib/analytics";

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const track = useTrack();
  const {
    customers, quotes, saving, error, notice,
    setError, setNotice,
    // Chat to Quote
    canUseChatToQuote, aiQuoteLimit, chatPrompt, chatParsed, setChatPrompt,
    createQuoteFromChatPrompt, currentPlanLabel, canAutoUpgradeMessage,
    // Trade setup
    setupTrade, setupSqFtMode, setupSqFtUnitCost, setupSqFtUnitPrice, recommendedPresetCount,
    setSetupTrade, setSetupSqFtMode, setSetupSqFtUnitCost, setSetupSqFtUnitPrice, applyTradeSetup,
    // Customer
    customerForm, setCustomerForm, createCustomer,
    // Quote
    quoteForm, setQuoteForm, createQuote, createQuoteMath,
    // Duplicate modal
    duplicateModal, setDuplicateModal, mergeDuplicateCustomer, createDuplicateAsNew,
    // Misc
    search, setSearch, statusFilter, setStatusFilter, loadQuotes, navigateToQuote, selectedQuoteId,
  } = useDashboard();

  const serviceOptions = SERVICE_TYPES.map((s) => ({ value: s, label: s }));
  const statusOptions = [{ value: "ALL", label: "All statuses" }, ...QUOTE_STATUSES.map((s) => ({ value: s, label: s }))];
  const customerOptions = customers.map((c) => ({ value: c.id, label: `${c.fullName} (${c.phone})` }));

  return (
    <div className="space-y-5">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {/* ── Chat to Quote (AI) ── */}
      {canUseChatToQuote ? (
        <Card variant="blue">
          <CardHeader title="Chat to Quote" subtitle="Describe customer, scope, and pricing in one message. QuoteFly AI builds the draft." />
          <form onSubmit={(e) => { track("chat_to_quote_submit"); void createQuoteFromChatPrompt(e); }} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-blue-700">
                AI generations this month: {aiQuoteLimit === null ? "Unlimited" : aiQuoteLimit}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { setChatPrompt(CHAT_PROMPT_EXAMPLE); track("chat_to_quote_sample"); }}
              >
                Use Sample
              </Button>
            </div>
            <Textarea
              rows={5}
              value={chatPrompt}
              onChange={(e) => setChatPrompt(e.target.value)}
              placeholder="New quote for..."
            />
            {chatParsed && (
              <div className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs text-slate-700">
                Last parse: {chatParsed.serviceType}
                {chatParsed.squareFeetEstimate ? ` · ${chatParsed.squareFeetEstimate.toLocaleString()} sq ft` : ""}
                {chatParsed.estimatedTotalAmount ? ` · Est. ${money(chatParsed.estimatedTotalAmount)}` : ""}
              </div>
            )}
            <Button type="submit" loading={saving} fullWidth>Generate Draft Quote</Button>
          </form>
        </Card>
      ) : (
        <FeatureLockedCard
          title="Chat to Quote"
          description="Turn one natural-language prompt into a ready quote with labor/material lines."
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Supported Plan"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}

      {/* ── Trade Setup ── */}
      <Card variant="amber">
        <CardHeader title="Quick Trade Setup" subtitle="Set your trade defaults and presets for faster quote creation." />
        <form onSubmit={applyTradeSetup} className="space-y-3">
          <Select
            value={setupTrade}
            onChange={(e) => setSetupTrade(e.target.value as ServiceType)}
            options={serviceOptions}
          />
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={setupSqFtMode} onChange={(e) => setSetupSqFtMode(e.target.checked)} />
            I price jobs by square foot (optional)
          </label>
          {setupSqFtMode && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="number" min="0" step="0.01" placeholder="SQ FT internal cost" value={setupSqFtUnitCost} onChange={(e) => setSetupSqFtUnitCost(e.target.value)} />
              <Input type="number" min="0" step="0.01" placeholder="SQ FT customer price" value={setupSqFtUnitPrice} onChange={(e) => setSetupSqFtUnitPrice(e.target.value)} />
            </div>
          )}
          <p className="text-[11px] text-amber-700">Recommended presets for {setupTrade}: {recommendedPresetCount}</p>
          <Button type="submit" loading={saving} fullWidth>Save Trade Presets</Button>
        </form>
      </Card>

      {/* ── Quick Customer ── */}
      <Card>
        <CardHeader title="Quick Customer" subtitle="Add a new customer to your pipeline." />
        <form onSubmit={createCustomer} className="space-y-3">
          <Input placeholder="Full name" required value={customerForm.fullName} onChange={(e) => setCustomerForm((prev) => ({ ...prev, fullName: e.target.value }))} />
          <Input type="tel" placeholder="Phone" required value={customerForm.phone} onChange={(e) => setCustomerForm((prev) => ({ ...prev, phone: e.target.value }))} />
          <Input type="email" placeholder="Email (optional)" value={customerForm.email} onChange={(e) => setCustomerForm((prev) => ({ ...prev, email: e.target.value }))} />
          <Button type="submit" loading={saving} fullWidth>Create Customer</Button>
        </form>
      </Card>

      {/* ── Create Quote ── */}
      <Card>
        <CardHeader title="Create Quote" subtitle="Build a manual quote for an existing customer." />
        <form onSubmit={createQuote} className="space-y-3">
          <Select value={quoteForm.customerId} required onChange={(e) => setQuoteForm((prev) => ({ ...prev, customerId: e.target.value }))} options={customerOptions} placeholder="Select customer" />
          <Select value={quoteForm.serviceType} onChange={(e) => setQuoteForm((prev) => ({ ...prev, serviceType: e.target.value as ServiceType }))} options={serviceOptions} />
          <Input placeholder="Title" required value={quoteForm.title} onChange={(e) => setQuoteForm((prev) => ({ ...prev, title: e.target.value }))} />
          <Textarea placeholder="Scope details" required rows={3} value={quoteForm.scopeText} onChange={(e) => setQuoteForm((prev) => ({ ...prev, scopeText: e.target.value }))} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input type="number" min="0" step="0.01" placeholder="Internal cost" value={quoteForm.internalCostSubtotal} onChange={(e) => setQuoteForm((prev) => ({ ...prev, internalCostSubtotal: e.target.value }))} />
            <Input type="number" min="0" step="0.01" placeholder="Customer subtotal" value={quoteForm.customerPriceSubtotal} onChange={(e) => setQuoteForm((prev) => ({ ...prev, customerPriceSubtotal: e.target.value }))} />
            <Input type="number" min="0" step="0.01" placeholder="Tax amount" value={quoteForm.taxAmount} onChange={(e) => setQuoteForm((prev) => ({ ...prev, taxAmount: e.target.value }))} />
          </div>
          <QuoteMathSummaryPanel
            summary={createQuoteMath}
            compact
            money={money}
            warning={
              createQuoteMath.customerSubtotal > 0 && createQuoteMath.estimatedProfit < 0
                ? "Customer subtotal is lower than cost. This quote would lose money."
                : createQuoteMath.customerSubtotal > 0 && createQuoteMath.estimatedMarginPercent < 10
                  ? "Margin is below 10%. Confirm this is intentional."
                  : undefined
            }
          />
          <Button type="submit" loading={saving} disabled={!customers.length} fullWidth>Create Quote</Button>
        </form>
      </Card>

      {/* ── Quote List ── */}
      <Card>
        <CardHeader title="Quote List" />
        <div className="mb-2 grid grid-cols-[1fr_140px] gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search quotes" />
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as QuoteStatus | "ALL")} options={statusOptions} />
        </div>
        <Button variant="outline" size="sm" fullWidth onClick={() => void loadQuotes()} className="mb-3">Apply Filters</Button>
        <div className="max-h-[340px] space-y-2 overflow-auto">
          {quotes.map((quote) => (
            <button key={quote.id} type="button" onClick={() => navigateToQuote(quote.id)} className={`w-full rounded-lg border p-3 text-left transition ${selectedQuoteId === quote.id ? "border-quotefly-blue bg-quotefly-blue/10" : "border-slate-200 bg-slate-50 hover:bg-slate-100"}`}>
              <p className="text-sm font-semibold text-slate-900">{quote.title}</p>
              <div className="mt-1 flex items-center justify-between">
                <QuoteStatusPill status={quote.status} compact />
                <span className="text-xs text-slate-600">{money(quote.totalAmount)}</span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* ── Duplicate Customer Modal ── */}
      {duplicateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <Card className="w-full max-w-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Potential Duplicate Customer</h3>
            <p className="mt-1 text-sm text-slate-600">We found matching records. Merge to keep one clean record, or save as new.</p>
            <div className="mt-4 max-h-64 space-y-2 overflow-auto">
              {duplicateModal.matches.map((match) => (
                <label key={match.id} className={`block cursor-pointer rounded-lg border px-3 py-2 ${duplicateModal.selectedMatchId === match.id ? "border-quotefly-blue bg-quotefly-blue/10" : "border-slate-200 bg-slate-50"}`}>
                  <input type="radio" name="dup-match" className="mr-2" checked={duplicateModal.selectedMatchId === match.id} onChange={() => setDuplicateModal((prev) => prev ? { ...prev, selectedMatchId: match.id } : prev)} />
                  <span className="text-sm font-medium text-slate-900">{match.fullName}</span>
                  <p className="text-xs text-slate-600">{match.phone} {match.email ? `| ${match.email}` : ""}</p>
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setDuplicateModal(null)} disabled={saving}>Cancel</Button>
              <Button variant="outline" onClick={() => void createDuplicateAsNew()} disabled={saving || duplicateModal.matches.some((m) => m.matchReasons.includes("phone"))}>Save as New</Button>
              <Button onClick={() => void mergeDuplicateCustomer()} loading={saving}>Merge Into Selected</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
