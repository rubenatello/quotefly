import { useEffect, useMemo, useState } from "react";
import { FeatureLockedCard, QuoteMathSummaryPanel, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import {
  useDashboard,
  money,
  CHAT_PROMPT_EXAMPLE,
  SERVICE_TYPES,
  QUOTE_STATUSES,
} from "../components/dashboard/DashboardContext";
import type { ServiceType, QuoteStatus } from "../lib/api";
import { InvoiceIcon } from "../components/Icons";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  Textarea,
} from "../components/ui";
import { usePageView, useTrack } from "../lib/analytics";

const MAX_QUICKBOOKS_EXPORT_QUOTES = 100;
const QUICKBOOKS_CHECKLIST_ITEMS = [
  { id: "quotes_selected", label: "Selected quotes are the final versions you want invoiced." },
  { id: "customer_verified", label: "Customer names, phone numbers, and emails are verified." },
  { id: "line_items_verified", label: "Line items, quantities, and rates are final." },
  { id: "tax_verified", label: "Tax amounts are checked for each quote." },
  { id: "doc_number_mapped", label: "You will map Doc Number during import to avoid duplicates." },
] as const;

type QuickBooksChecklistId = (typeof QUICKBOOKS_CHECKLIST_ITEMS)[number]["id"];

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const track = useTrack();
  const {
    customers,
    quotes,
    saving,
    error,
    notice,
    setError,
    setNotice,
    // Chat to Quote
    canUseChatToQuote,
    aiQuoteLimit,
    chatPrompt,
    chatParsed,
    setChatPrompt,
    createQuoteFromChatPrompt,
    currentPlanLabel,
    canAutoUpgradeMessage,
    // Customer
    customerForm,
    setCustomerForm,
    createCustomer,
    // Quote
    quoteForm,
    setQuoteForm,
    createQuote,
    createQuoteMath,
    // Duplicate modal
    duplicateModal,
    setDuplicateModal,
    mergeDuplicateCustomer,
    createDuplicateAsNew,
    // Misc
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    loadQuotes,
    navigateToQuote,
    selectedQuoteId,
    exportQuotesAsInvoicesCsv,
  } = useDashboard();

  const serviceOptions = SERVICE_TYPES.map((s) => ({ value: s, label: s }));
  const statusOptions = [
    { value: "ALL", label: "All statuses" },
    ...QUOTE_STATUSES.map((s) => ({ value: s, label: s })),
  ];
  const customerOptions = customers.map((c) => ({ value: c.id, label: `${c.fullName} (${c.phone})` }));

  const [selectedQuoteIds, setSelectedQuoteIds] = useState<string[]>([]);
  const [invoiceDueInDays, setInvoiceDueInDays] = useState("14");
  const [showQuickBooksGuide, setShowQuickBooksGuide] = useState(false);
  const [quickBooksChecklist, setQuickBooksChecklist] = useState<Record<QuickBooksChecklistId, boolean>>({
    quotes_selected: false,
    customer_verified: false,
    line_items_verified: false,
    tax_verified: false,
    doc_number_mapped: false,
  });

  const visibleQuoteIds = useMemo(() => quotes.map((quote) => quote.id), [quotes]);
  const selectedQuoteIdSet = useMemo(() => new Set(selectedQuoteIds), [selectedQuoteIds]);
  const selectedVisibleCount = useMemo(
    () => visibleQuoteIds.filter((quoteId) => selectedQuoteIdSet.has(quoteId)).length,
    [visibleQuoteIds, selectedQuoteIdSet],
  );
  const allVisibleSelected = visibleQuoteIds.length > 0 && selectedVisibleCount === visibleQuoteIds.length;
  const allChecklistComplete = useMemo(
    () => QUICKBOOKS_CHECKLIST_ITEMS.every((item) => quickBooksChecklist[item.id]),
    [quickBooksChecklist],
  );

  useEffect(() => {
    setSelectedQuoteIds((current) => current.filter((quoteId) => visibleQuoteIds.includes(quoteId)));
  }, [visibleQuoteIds]);

  function toggleQuoteSelection(quoteId: string, checked: boolean) {
    setSelectedQuoteIds((current) => {
      if (checked) {
        if (current.includes(quoteId)) return current;
        if (current.length >= MAX_QUICKBOOKS_EXPORT_QUOTES) {
          setError(`You can select up to ${MAX_QUICKBOOKS_EXPORT_QUOTES} quotes per export.`);
          return current;
        }
        return [...current, quoteId];
      }
      return current.filter((id) => id !== quoteId);
    });
  }

  function selectAllVisibleQuotes() {
    setSelectedQuoteIds((current) => {
      if (current.length >= MAX_QUICKBOOKS_EXPORT_QUOTES) {
        setError(`Selection is capped at ${MAX_QUICKBOOKS_EXPORT_QUOTES} quotes per export.`);
        return current;
      }
      const merged = new Set(current);
      for (const quoteId of visibleQuoteIds) {
        if (merged.size >= MAX_QUICKBOOKS_EXPORT_QUOTES) break;
        merged.add(quoteId);
      }

      if (merged.size === MAX_QUICKBOOKS_EXPORT_QUOTES && merged.size > current.length) {
        setNotice(`Selection capped at ${MAX_QUICKBOOKS_EXPORT_QUOTES} quotes for QuickBooks export.`);
      }

      return Array.from(merged);
    });
  }

  async function exportSelectedQuotesCsv() {
    const dueInDays = Number(invoiceDueInDays);
    await exportQuotesAsInvoicesCsv(selectedQuoteIds, {
      dueInDays: Number.isFinite(dueInDays) ? dueInDays : 14,
    });
  }

  function toggleChecklistItem(id: QuickBooksChecklistId) {
    setQuickBooksChecklist((current) => ({ ...current, [id]: !current[id] }));
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {/* Chat to Quote (AI) */}
      {canUseChatToQuote ? (
        <Card variant="blue">
          <CardHeader
            title="Chat to Quote"
            subtitle="Describe customer, scope, and pricing in one message. QuoteFly AI builds the draft."
          />
          <form
            onSubmit={(event) => {
              track("chat_to_quote_submit");
              void createQuoteFromChatPrompt(event);
            }}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-blue-700">
                AI generations this month: {aiQuoteLimit === null ? "Unlimited" : aiQuoteLimit}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setChatPrompt(CHAT_PROMPT_EXAMPLE);
                  track("chat_to_quote_sample");
                }}
              >
                Use Sample
              </Button>
            </div>
            <Textarea
              rows={5}
              value={chatPrompt}
              onChange={(event) => setChatPrompt(event.target.value)}
              placeholder="New quote for..."
            />
            {chatParsed && (
              <div className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs text-slate-700">
                Last parse: {chatParsed.serviceType}
                {chatParsed.squareFeetEstimate ? ` · ${chatParsed.squareFeetEstimate.toLocaleString()} sq ft` : ""}
                {chatParsed.estimatedTotalAmount ? ` · Est. ${money(chatParsed.estimatedTotalAmount)}` : ""}
              </div>
            )}
            <Button type="submit" loading={saving} fullWidth>
              Generate Draft Quote
            </Button>
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

      {/* Quick Customer */}
      <Card>
        <CardHeader title="Quick Customer" subtitle="Add a new customer to your pipeline." />
        <form onSubmit={createCustomer} className="space-y-3">
          <Input
            placeholder="Full name"
            required
            value={customerForm.fullName}
            onChange={(event) =>
              setCustomerForm((prev) => ({ ...prev, fullName: event.target.value }))
            }
          />
          <Input
            type="tel"
            placeholder="Phone"
            required
            value={customerForm.phone}
            onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: event.target.value }))}
          />
          <Input
            type="email"
            placeholder="Email (optional)"
            value={customerForm.email}
            onChange={(event) => setCustomerForm((prev) => ({ ...prev, email: event.target.value }))}
          />
          <Button type="submit" loading={saving} fullWidth>
            Create Customer
          </Button>
        </form>
      </Card>

      {/* Create Quote */}
      <Card>
        <CardHeader title="Create Quote" subtitle="Build a manual quote for an existing customer." />
        <form onSubmit={createQuote} className="space-y-3">
          <Select
            value={quoteForm.customerId}
            required
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerId: event.target.value }))}
            options={customerOptions}
            placeholder="Select customer"
          />
          <Select
            value={quoteForm.serviceType}
            onChange={(event) =>
              setQuoteForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))
            }
            options={serviceOptions}
          />
          <Input
            placeholder="Title"
            required
            value={quoteForm.title}
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, title: event.target.value }))}
          />
          <Textarea
            placeholder="Scope details"
            required
            rows={3}
            value={quoteForm.scopeText}
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, scopeText: event.target.value }))}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Internal cost"
              value={quoteForm.internalCostSubtotal}
              onChange={(event) =>
                setQuoteForm((prev) => ({ ...prev, internalCostSubtotal: event.target.value }))
              }
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Customer subtotal"
              value={quoteForm.customerPriceSubtotal}
              onChange={(event) =>
                setQuoteForm((prev) => ({ ...prev, customerPriceSubtotal: event.target.value }))
              }
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Tax amount"
              value={quoteForm.taxAmount}
              onChange={(event) => setQuoteForm((prev) => ({ ...prev, taxAmount: event.target.value }))}
            />
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
          <Button type="submit" loading={saving} disabled={!customers.length} fullWidth>
            Create Quote
          </Button>
        </form>
      </Card>

      {/* Quote List */}
      <Card>
        <CardHeader
          title="Quote List"
          subtitle="Select one or more quotes and export as QuickBooks invoice CSV rows."
          actions={<span className="text-xs font-medium text-slate-600">Selected: {selectedQuoteIds.length}</span>}
        />
        <div className="mb-2 grid grid-cols-[1fr_140px] gap-2">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quotes" />
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")}
            options={statusOptions}
          />
        </div>
        <Button variant="outline" size="sm" fullWidth onClick={() => void loadQuotes()} className="mb-3">
          Apply Filters
        </Button>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={selectAllVisibleQuotes}
            disabled={!visibleQuoteIds.length || allVisibleSelected || selectedQuoteIds.length >= MAX_QUICKBOOKS_EXPORT_QUOTES}
          >
            Select Visible
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSelectedQuoteIds([])}
            disabled={!selectedQuoteIds.length}
          >
            Clear
          </Button>
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
            Due in
            <input
              type="number"
              min={0}
              max={365}
              value={invoiceDueInDays}
              onChange={(event) => setInvoiceDueInDays(event.target.value)}
              className="w-16 rounded border border-slate-300 px-1 py-0.5 text-right text-xs text-slate-900"
            />
            days
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<InvoiceIcon size={14} />}
            onClick={() => void exportSelectedQuotesCsv()}
            disabled={!selectedQuoteIds.length || saving}
          >
            Export QuickBooks CSV
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowQuickBooksGuide(true)}
          >
            Import Guide
          </Button>
          <span className="text-[11px] text-slate-600">
            {selectedQuoteIds.length} selected = {selectedQuoteIds.length} invoice{selectedQuoteIds.length === 1 ? "" : "s"}
          </span>
          <span className="text-[11px] text-slate-500">Max {MAX_QUICKBOOKS_EXPORT_QUOTES} per export</span>
          <span className={`text-[11px] ${allChecklistComplete ? "text-emerald-700" : "text-amber-700"}`}>
            Checklist: {allChecklistComplete ? "Ready" : "Review before import"}
          </span>
        </div>

        <div className="max-h-[340px] space-y-2 overflow-auto">
          {quotes.map((quote) => (
            <div
              key={quote.id}
              className={`rounded-lg border p-3 transition ${
                selectedQuoteId === quote.id
                  ? "border-quotefly-blue bg-quotefly-blue/10"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedQuoteIdSet.has(quote.id)}
                    disabled={!selectedQuoteIdSet.has(quote.id) && selectedQuoteIds.length >= MAX_QUICKBOOKS_EXPORT_QUOTES}
                    onChange={(event) => toggleQuoteSelection(quote.id, event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-quotefly-blue focus:ring-quotefly-blue"
                  />
                  Select for CSV
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => navigateToQuote(quote.id)}
                >
                  Open
                </Button>
              </div>
              <button
                type="button"
                onClick={() => navigateToQuote(quote.id)}
                className="w-full text-left"
              >
                <p className="text-sm font-semibold text-slate-900">{quote.title}</p>
                <div className="mt-1 flex items-center justify-between">
                  <QuoteStatusPill status={quote.status} compact />
                  <span className="text-xs text-slate-600">{money(quote.totalAmount)}</span>
                </div>
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card variant="blue">
        <CardHeader
          title="QuickBooks Import Workspace"
          subtitle="Open the full step-by-step guide and checklist before importing."
        />
        <div className="space-y-2 text-xs text-slate-700">
          <p>
            Exported CSV behavior: <span className="font-semibold">1 selected quote = 1 invoice</span>.
            Multi-line quotes remain one invoice with shared `Doc Number` rows.
          </p>
          <p>Use the guide to verify mapping and reduce import errors before sending to QuickBooks.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setShowQuickBooksGuide(true)}>
            Open Detailed Import Guide
          </Button>
        </div>
      </Card>

      <QuickBooksGuideModal
        open={showQuickBooksGuide}
        checklist={quickBooksChecklist}
        onToggleChecklist={toggleChecklistItem}
        onClose={() => setShowQuickBooksGuide(false)}
      />

      {/* Duplicate Customer Modal */}
      {duplicateModal && (
        <Modal open={true} onClose={() => setDuplicateModal(null)} size="lg" ariaLabel="Potential duplicate customer">
          <ModalHeader
            title="Potential Duplicate Customer"
            description="We found matching records. Merge to keep one clean record, or save as new."
            onClose={() => setDuplicateModal(null)}
          />
          <ModalBody className="max-h-[70vh] space-y-4">
            <div className="max-h-64 space-y-2 overflow-auto">
              {duplicateModal.matches.map((match) => (
                <label
                  key={match.id}
                  className={`block cursor-pointer rounded-lg border px-3 py-2 ${
                    duplicateModal.selectedMatchId === match.id
                      ? "border-quotefly-blue bg-quotefly-blue/10"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="dup-match"
                    className="mr-2"
                    checked={duplicateModal.selectedMatchId === match.id}
                    onChange={() =>
                      setDuplicateModal((prev) => (prev ? { ...prev, selectedMatchId: match.id } : prev))
                    }
                  />
                  <span className="text-sm font-medium text-slate-900">{match.fullName}</span>
                  <p className="text-xs text-slate-600">
                    {match.phone} {match.email ? `| ${match.email}` : ""}
                  </p>
                </label>
              ))}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onClick={() => setDuplicateModal(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void createDuplicateAsNew()}
              disabled={saving || duplicateModal.matches.some((match) => match.matchReasons.includes("phone"))}
            >
              Save as New
            </Button>
            <Button onClick={() => void mergeDuplicateCustomer()} loading={saving}>
              Merge Into Selected
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

function QuickBooksGuideModal({
  open,
  checklist,
  onToggleChecklist,
  onClose,
}: {
  open: boolean;
  checklist: Record<QuickBooksChecklistId, boolean>;
  onToggleChecklist: (id: QuickBooksChecklistId) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} size="xl" ariaLabel="QuickBooks invoice import guide">
      <ModalHeader
        title="QuickBooks Invoice Import Guide"
        description="Follow this flow after exporting CSV from QuoteFly."
        onClose={onClose}
      />
      <ModalBody className="max-h-[80vh] space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">Step-by-step</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-slate-700">
            <li>In QuoteFly, select quotes and export QuickBooks CSV.</li>
            <li>In QuickBooks, open invoice/sales import.</li>
            <li>Upload the CSV file.</li>
            <li>Map: Customer, Invoice Date, Due Date, Item, Qty, Rate, Amount.</li>
            <li>Map `Doc Number` to preserve invoice identity and avoid duplicates.</li>
            <li>Preview results, then complete import.</li>
          </ol>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">Field mapping reference</p>
          <div className="mt-2 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-600">
                  <th className="py-2 text-left">QuoteFly CSV</th>
                  <th className="py-2 text-left">QuickBooks Field</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                <tr className="border-b border-slate-100"><td className="py-2">Customer</td><td className="py-2">Customer/Display Name</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Doc Number</td><td className="py-2">Invoice Number / Reference</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Invoice Date</td><td className="py-2">Invoice Date</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Due Date</td><td className="py-2">Due Date</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Item Name</td><td className="py-2">Product/Service</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Qty</td><td className="py-2">Quantity</td></tr>
                <tr className="border-b border-slate-100"><td className="py-2">Rate</td><td className="py-2">Rate</td></tr>
                <tr><td className="py-2">Line Amount</td><td className="py-2">Amount</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">Pre-import checklist</p>
          <div className="mt-2 space-y-2">
            {QUICKBOOKS_CHECKLIST_ITEMS.map((item) => (
              <label key={item.id} className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={checklist[item.id]}
                  onChange={() => onToggleChecklist(item.id)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-quotefly-blue focus:ring-quotefly-blue"
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </div>

      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

