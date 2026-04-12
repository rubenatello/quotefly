import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { CheckCircle2 as CheckCircleIcon } from "lucide-react";
import { FeatureLockedCard, QuoteMathSummaryPanel, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { QuickLookupCard } from "../components/dashboard/QuickLookupCard";
import {
  useDashboard,
  money,
  CHAT_PROMPT_EXAMPLE,
  SERVICE_TYPES,
  QUOTE_STATUSES,
} from "../components/dashboard/DashboardContext";
import { api, type Quote, type QuoteStatus, type ServiceType, type WorkPreset } from "../lib/api";
import { CustomerIcon, InvoiceIcon, QuoteIcon, SendIcon } from "../components/Icons";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageHeader,
  ProgressBar,
  Select,
  Textarea,
} from "../components/ui";
import { WorkspaceSection } from "../components/ui/workspace";
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

function formatPresetUnitLabel(unitType: WorkPreset["unitType"]): string {
  if (unitType === "SQ_FT") return "SQ FT";
  if (unitType === "HOUR") return "Hours";
  if (unitType === "EACH") return "Units";
  return "Qty";
}

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const track = useTrack();
  const [activeBuilderTab, setActiveBuilderTab] = useState<"overview" | "customer" | "ai" | "draft" | "export">("overview");
  const {
    session,
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
    createQuoteDraftFromForm,
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
    selectQuoteCustomer,
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
  const [presetLibrary, setPresetLibrary] = useState<WorkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedPresetQuantity, setSelectedPresetQuantity] = useState("");
  const [appliedStarterPreset, setAppliedStarterPreset] = useState<{ presetId: string; quantity: number } | null>(null);
  const [addStarterAsLineItem, setAddStarterAsLineItem] = useState(true);
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
  const draftQuotesCount = useMemo(() => quotes.filter((quote) => quote.status === "DRAFT").length, [quotes]);
  const quotedQuotesCount = useMemo(
    () => quotes.filter((quote) => quote.status === "SENT_TO_CUSTOMER").length,
    [quotes],
  );
  const customerCount = customers.length;
  const activeCustomer = useMemo(
    () => customers.find((customer) => customer.id === quoteForm.customerId) ?? null,
    [customers, quoteForm.customerId],
  );
  const builderSteps = useMemo(
    () => [
      {
        label: "Customer ready",
        description: activeCustomer ? activeCustomer.fullName : "Select or create a customer first",
        complete: Boolean(activeCustomer),
        icon: <CustomerIcon size={14} />,
      },
      {
        label: "Scope drafted",
        description: quoteForm.title.trim() && quoteForm.scopeText.trim() ? "Title and scope are filled in" : "Add a title and scope of work",
        complete: Boolean(quoteForm.title.trim() && quoteForm.scopeText.trim()),
        icon: <QuoteIcon size={14} />,
      },
      {
        label: "Pricing set",
        description:
          Number(quoteForm.customerPriceSubtotal) > 0
            ? `${money(quoteForm.customerPriceSubtotal)} customer subtotal`
            : "Add cost, price, and tax before creating the quote",
        complete: Number(quoteForm.customerPriceSubtotal) > 0,
        icon: <InvoiceIcon size={14} />,
      },
      {
        label: "Quote desk open",
        description: selectedQuoteId ? "Existing quote is ready in the desk" : "Create the quote, then open it in the desk",
        complete: Boolean(selectedQuoteId),
        icon: <SendIcon size={14} />,
      },
    ],
    [activeCustomer, quoteForm.title, quoteForm.scopeText, quoteForm.customerPriceSubtotal, selectedQuoteId],
  );
  const builderCompletionPercent = useMemo(
    () => Math.round((builderSteps.filter((step) => step.complete).length / builderSteps.length) * 100),
    [builderSteps],
  );
  const builderTabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "customer" as const, label: "Customer" },
    { id: "ai" as const, label: "AI Draft" },
    { id: "draft" as const, label: "Draft Quote" },
    { id: "export" as const, label: "Export" },
  ];
  const aiQuoteUsed = session?.usage?.monthlyAiQuoteCount ?? 0;
  const aiQuoteRemaining = aiQuoteLimit === null ? null : Math.max(aiQuoteLimit - aiQuoteUsed, 0);
  const aiUsagePercent = aiQuoteLimit && aiQuoteLimit > 0 ? Math.min((aiQuoteUsed / aiQuoteLimit) * 100, 100) : 0;
  const aiNearLimit = aiQuoteLimit !== null && aiQuoteRemaining !== null && aiQuoteRemaining <= Math.max(3, Math.ceil(aiQuoteLimit * 0.1));

  useEffect(() => {
    setSelectedQuoteIds((current) => current.filter((quoteId) => visibleQuoteIds.includes(quoteId)));
  }, [visibleQuoteIds]);

  useEffect(() => {
    let mounted = true;
    setPresetsLoading(true);
    setPresetLoadError(null);

    api.onboarding
      .getSetup()
      .then((result) => {
        if (!mounted) return;
        setPresetLibrary(result.presets);
      })
      .catch(() => {
        if (!mounted) return;
        setPresetLoadError("Starter jobs could not be loaded.");
      })
      .finally(() => {
        if (mounted) setPresetsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const availablePresets = useMemo(
    () =>
      presetLibrary
        .filter((preset) => preset.serviceType === quoteForm.serviceType)
        .sort((left, right) => {
          const leftIsStandard = Boolean(left.catalogKey);
          const rightIsStandard = Boolean(right.catalogKey);
          if (leftIsStandard !== rightIsStandard) return leftIsStandard ? -1 : 1;
          return left.name.localeCompare(right.name);
        }),
    [presetLibrary, quoteForm.serviceType],
  );

  useEffect(() => {
    if (availablePresets.length === 0) {
      setSelectedPresetId("");
      setSelectedPresetQuantity("");
      return;
    }

    const activePreset = availablePresets.find((preset) => preset.id === selectedPresetId) ?? availablePresets[0];
    setSelectedPresetId(activePreset.id);
    setSelectedPresetQuantity(String(Number(activePreset.defaultQuantity)));
  }, [availablePresets, selectedPresetId]);

  const selectedPreset = useMemo(
    () => availablePresets.find((preset) => preset.id === selectedPresetId) ?? null,
    [availablePresets, selectedPresetId],
  );

  const starterQuantity = useMemo(() => {
    if (!selectedPreset) return 0;
    const parsedQuantity = Number(selectedPresetQuantity);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      return Number(selectedPreset.defaultQuantity);
    }
    return parsedQuantity;
  }, [selectedPreset, selectedPresetQuantity]);

  const starterInternalTotal = selectedPreset ? starterQuantity * Number(selectedPreset.unitCost) : 0;
  const starterCustomerTotal = selectedPreset ? starterQuantity * Number(selectedPreset.unitPrice) : 0;

  function applyStarterPreset() {
    if (!selectedPreset) return;
    setQuoteForm((prev) => ({
      ...prev,
      serviceType: selectedPreset.serviceType,
      title: selectedPreset.name,
      scopeText: selectedPreset.description ?? "",
      internalCostSubtotal: starterInternalTotal.toFixed(2),
      customerPriceSubtotal: starterCustomerTotal.toFixed(2),
    }));
    setAppliedStarterPreset({ presetId: selectedPreset.id, quantity: starterQuantity });
    setAddStarterAsLineItem(true);
    setNotice(`${selectedPreset.name} applied to the quote draft.`);
  }

  async function handleCreateQuote(event: FormEvent) {
    event.preventDefault();

    const shouldAttachStarterLine =
      addStarterAsLineItem &&
      selectedPreset &&
      appliedStarterPreset?.presetId === selectedPreset.id;

    if (!shouldAttachStarterLine) {
      await createQuote(event);
      return;
    }

    const createdQuote = await createQuoteDraftFromForm({
      initialLineItems: [
        {
          description: selectedPreset.name,
          quantity: appliedStarterPreset.quantity,
          unitCost: Number(selectedPreset.unitCost),
          unitPrice: Number(selectedPreset.unitPrice),
        },
      ],
      successNotice: "Quote created with starter job attached.",
    });

    if (createdQuote) {
      setAppliedStarterPreset(null);
    }
  }

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
      <PageHeader
        title="Quote Builder"
        subtitle="Create customers, draft quotes, and prep exports from one operator workflow built for phone-first teams."
        actions={
          selectedQuoteId ? (
            <Button onClick={() => navigateToQuote(selectedQuoteId)}>
              Open Active Quote
            </Button>
          ) : undefined
        }
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      <div className="space-y-6">
          <Card variant="default" padding="md">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-3 xl:max-w-[420px]">
                  <BuilderSnapshotCard label="Customers" value={String(customerCount)} tone="blue" />
                  <BuilderSnapshotCard label="Draft Quotes" value={String(draftQuotesCount)} tone="slate" />
                  <BuilderSnapshotCard label="Quoted" value={String(quotedQuotesCount)} tone="orange" />
                </div>
                {aiQuoteLimit !== null ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">AI drafts</p>
                      <span className="text-xs font-semibold text-slate-900">
                        {aiQuoteUsed}/{aiQuoteLimit}
                      </span>
                    </div>
                    <ProgressBar
                      value={aiUsagePercent}
                      label="Monthly AI draft usage"
                      hint={aiQuoteRemaining === 0 ? "Limit reached" : `${aiQuoteRemaining} left this month`}
                      className="mt-3"
                    />
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {builderTabs.map((tab) => {
                    const active = tab.id === activeBuilderTab;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveBuilderTab(tab.id)}
                        className={`inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                          active
                            ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="xl:w-[320px]">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Current state</p>
                  <p className="mt-2 text-base font-semibold text-slate-900">
                    {activeCustomer ? activeCustomer.fullName : "No customer selected"}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {activeCustomer
                      ? `${activeCustomer.phone}${activeCustomer.email ? ` · ${activeCustomer.email}` : ""}`
                      : "Use the customer section first so the quote attaches to the right record."}
                  </p>
                  <div className="mt-4 grid gap-2">
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Builder progress</p>
                      <p className="mt-1 text-2xl font-bold text-slate-900">{builderCompletionPercent}%</p>
                    </div>
                    {selectedQuoteId ? (
                      <Button fullWidth onClick={() => navigateToQuote(selectedQuoteId)}>
                        Open Quote Desk
                      </Button>
                    ) : (
                      <Button fullWidth variant="outline" disabled>
                        Create Quote First
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {activeBuilderTab === "overview" ? (
          <WorkspaceSection
            id="builder-overview"
            step="Overview"
            title="Overview"
            description="Track builder progress, customer readiness, and quote throughput before drafting."
          >
            <BuilderWorkflowCard steps={builderSteps} progress={builderCompletionPercent} />
          </WorkspaceSection>
          ) : null}

          {activeBuilderTab === "customer" ? (
          <WorkspaceSection
            id="builder-customer"
            step="Customer"
            title="Customer"
            description="Search an existing customer first. If they do not exist, add them fast and keep moving."
          >
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_420px]">
              <QuickLookupCard
                customerActionLabel="Use Customer"
                activeCustomerId={quoteForm.customerId}
                activeQuoteId={selectedQuoteId}
                onCustomerAction={(customer) => {
                  selectQuoteCustomer(customer.id);
                  setNotice(`${customer.fullName} is ready for a new quote.`);
                }}
                onQuoteAction={(quote) => navigateToQuote(quote.id)}
              />

              <Card variant="elevated" padding="lg">
                <CardHeader title="Quick Customer" subtitle="Add a lead fast, then move directly into quoting." />
                <form onSubmit={createCustomer} className="space-y-3">
                  <Input
                    label="Customer name"
                    placeholder="Full name"
                    required
                    value={customerForm.fullName}
                    onChange={(event) =>
                      setCustomerForm((prev) => ({ ...prev, fullName: event.target.value }))
                    }
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    placeholder="Phone"
                    required
                    value={customerForm.phone}
                    onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: event.target.value }))}
                  />
                  <Input
                    label="Email"
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
            </div>
          </WorkspaceSection>
          ) : null}

          {activeBuilderTab === "ai" ? (
          <WorkspaceSection
            id="builder-ai"
            step="AI Draft"
            title="AI Draft"
            description="Use AI when it helps, but keep it in a tight card so it does not compete with the main quote form."
          >
            {canUseChatToQuote ? (
              <Card variant="default" padding="lg">
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="blue">
                        {aiQuoteLimit === null ? "AI drafts included" : `${aiQuoteUsed}/${aiQuoteLimit} AI drafts used`}
                      </Badge>
                      {aiQuoteLimit !== null ? (
                        <Badge tone={aiNearLimit ? "orange" : "slate"}>
                          {aiQuoteRemaining} left this month
                        </Badge>
                      ) : null}
                    </div>
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
                  {aiQuoteLimit !== null ? (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                      <ProgressBar
                        value={aiUsagePercent}
                        label="Monthly AI draft usage"
                        hint={aiQuoteRemaining === 0 ? "Manual revisions stay unlimited" : `${aiQuoteRemaining} AI drafts remaining`}
                      />
                    </div>
                  ) : null}
                  {chatParsed && (
                    <div className="rounded-2xl border border-quotefly-blue/20 bg-white/90 px-3 py-2.5 text-xs text-slate-700 shadow-sm">
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
          </WorkspaceSection>
          ) : null}

          {activeBuilderTab === "draft" ? (
          <WorkspaceSection
            id="builder-draft"
            step="Draft Quote"
            title="Draft Quote"
            description="Use a starter job, tighten pricing, then create the quote and move into the desk."
          >
          <Card variant="default" padding="lg">
        <CardHeader title="Create Quote" subtitle="Use a saved starter job, then tune the scope and math before opening the desk." />
        <form onSubmit={(event) => void handleCreateQuote(event)} className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Current customer</p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {activeCustomer ? activeCustomer.fullName : "No customer selected yet"}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {activeCustomer
                    ? `${activeCustomer.phone}${activeCustomer.email ? ` · ${activeCustomer.email}` : ""}`
                    : "Use the lookup or quick customer form first so the quote attaches cleanly."}
                </p>
              </div>
              <div className="rounded-full border border-quotefly-blue/20 bg-quotefly-blue/[0.06] px-3 py-1 text-xs font-medium text-quotefly-blue">
                {activeCustomer ? "Ready to quote" : "Customer needed"}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Starter Job</p>
                <p className="mt-1 text-xs text-slate-600">
                  Pull from your standard or custom job library to prefill title, description, and pricing.
                </p>
              </div>
              {selectedPreset ? (
                <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${selectedPreset.catalogKey ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-slate-700"}`}>
                  {selectedPreset.catalogKey ? "Standard" : "Custom"}
                </span>
              ) : null}
            </div>

            {presetLoadError ? (
              <div className="mt-3">
                <Alert tone="warning">{presetLoadError}</Alert>
              </div>
            ) : presetsLoading ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-[1.2fr_0.8fr_auto]">
                <div className="h-11 animate-pulse rounded-xl bg-slate-200" />
                <div className="h-11 animate-pulse rounded-xl bg-slate-200" />
                <div className="h-11 animate-pulse rounded-xl bg-slate-200" />
              </div>
            ) : availablePresets.length === 0 ? (
              <div className="mt-3">
                <Alert tone="info">
                  No starter jobs are saved for {quoteForm.serviceType}. Add them in Workspace Setup first.
                </Alert>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1.2fr_0.8fr_auto] sm:items-end">
                  <Select
                    label="Starter job"
                    value={selectedPresetId}
                    onChange={(event) => setSelectedPresetId(event.target.value)}
                    options={availablePresets.map((preset) => ({
                      value: preset.id,
                      label: `${preset.name}${preset.catalogKey ? "" : " (Custom)"}`,
                    }))}
                  />
                  <Input
                    label={selectedPreset ? formatPresetUnitLabel(selectedPreset.unitType) : "Qty"}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={selectedPresetQuantity}
                    onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                  />
                  <Button type="button" variant="outline" onClick={applyStarterPreset} disabled={!selectedPreset}>
                    Use Starter
                  </Button>
                </div>

                {selectedPreset ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                    <p className="text-sm font-semibold text-slate-900">{selectedPreset.name}</p>
                    <p className="mt-1">{selectedPreset.description ?? "No default description yet."}</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Default cost</p>
                        <p className="mt-1 font-semibold text-slate-900">{money(Number(selectedPreset.unitCost))} / {formatPresetUnitLabel(selectedPreset.unitType)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Default price</p>
                        <p className="mt-1 font-semibold text-slate-900">{money(Number(selectedPreset.unitPrice))} / {formatPresetUnitLabel(selectedPreset.unitType)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Applied totals</p>
                        <p className="mt-1 font-semibold text-slate-900">
                          {money(starterInternalTotal)} cost · {money(starterCustomerTotal)} price
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedPreset ? (
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={addStarterAsLineItem}
                      onChange={(event) => setAddStarterAsLineItem(event.target.checked)}
                    />
                    Add this starter job as the first line item when the quote is created
                  </label>
                ) : null}
              </div>
            )}
          </div>

          <Select
            label="Customer"
            value={quoteForm.customerId}
            required
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerId: event.target.value }))}
            options={customerOptions}
            placeholder="Select customer"
          />
          <Select
            label="Trade"
            value={quoteForm.serviceType}
            onChange={(event) =>
              setQuoteForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))
            }
            options={serviceOptions}
          />
          <Input
            label="Quote title"
            placeholder="Title"
            required
            value={quoteForm.title}
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, title: event.target.value }))}
          />
          <Textarea
            label="Scope details"
            placeholder="Scope details"
            required
            rows={3}
            value={quoteForm.scopeText}
            onChange={(event) => setQuoteForm((prev) => ({ ...prev, scopeText: event.target.value }))}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              label="Internal cost"
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
              label="Customer subtotal"
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
              label="Tax amount"
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
          </WorkspaceSection>
          ) : null}

          {activeBuilderTab === "export" ? (
          <WorkspaceSection
            id="builder-export"
            step="Export"
            title="Export"
            description="Review live quotes, select invoice-ready records, and hand off cleanly into QuickBooks."
          >
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_360px]">
      <Card variant="default" padding="md">
        <CardHeader
          title="Quote List"
          subtitle="Select one or more quotes and export as QuickBooks invoice CSV rows."
          actions={<span className="text-xs font-medium text-slate-600">Selected: {selectedQuoteIds.length}</span>}
        />
        <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quotes" />
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")}
            options={statusOptions}
          />
          <Button variant="outline" size="sm" onClick={() => void loadQuotes()} className="md:min-w-[120px]">
            Apply Filters
          </Button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
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
          <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm">
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
          <span className={`text-[11px] ${allChecklistComplete ? "text-quotefly-blue" : "text-amber-700"}`}>
            Checklist: {allChecklistComplete ? "Ready" : "Review before import"}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[48px_minmax(0,1.7fr)_minmax(0,1fr)_130px_110px_96px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:grid">
            <span>Select</span>
            <span>Quote</span>
            <span>Customer</span>
            <span>Status</span>
            <span>Total</span>
            <span>Open</span>
          </div>
          <div className="max-h-[380px] divide-y divide-slate-200 overflow-auto">
            {quotes.map((quote) => (
              <QuoteListRow
                key={quote.id}
                quote={quote}
                selected={selectedQuoteIdSet.has(quote.id)}
                active={selectedQuoteId === quote.id}
                selectionLocked={!selectedQuoteIdSet.has(quote.id) && selectedQuoteIds.length >= MAX_QUICKBOOKS_EXPORT_QUOTES}
                onToggleSelected={(checked) => toggleQuoteSelection(quote.id, checked)}
                onOpen={() => navigateToQuote(quote.id)}
              />
            ))}
          </div>
        </div>
      </Card>

      <Card variant="blue" padding="lg">
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
            </div>
          </WorkspaceSection>
          ) : null}
      </div>

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
                  className={`block cursor-pointer rounded-xl border px-3 py-2.5 ${
                    duplicateModal.selectedMatchId === match.id
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.04]"
                      : "border-slate-200 bg-white"
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

function BuilderSnapshotCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "orange" | "slate";
}) {
  const toneClass =
    tone === "blue"
      ? "border-quotefly-blue/15 bg-quotefly-blue/[0.04] text-quotefly-blue"
      : tone === "orange"
        ? "border-quotefly-orange/15 bg-quotefly-orange/[0.04] text-quotefly-orange"
        : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <div className={`rounded-xl border px-4 py-4 ${toneClass}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </div>
  );
}

function QuoteListRow({
  quote,
  selected,
  active,
  selectionLocked,
  onToggleSelected,
  onOpen,
}: {
  quote: Quote;
  selected: boolean;
  active: boolean;
  selectionLocked: boolean;
  onToggleSelected: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={`grid gap-3 px-4 py-3 transition md:grid-cols-[48px_minmax(0,1.7fr)_minmax(0,1fr)_130px_110px_96px] md:items-center ${
        active ? "bg-quotefly-blue/[0.04]" : "bg-white hover:bg-slate-50/80"
      }`}
    >
      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          checked={selected}
          disabled={selectionLocked}
          onChange={(event) => onToggleSelected(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-quotefly-blue focus:ring-quotefly-blue"
        />
        <span className="md:hidden">Select</span>
      </label>

      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <p className="truncate text-sm font-semibold text-slate-900">{quote.title}</p>
        <p className="mt-1 text-xs text-slate-500 md:hidden">
          {quote.customer?.fullName ?? "Customer unavailable"} · {money(quote.totalAmount)}
        </p>
      </button>

      <p className="hidden truncate text-sm text-slate-600 md:block">
        {quote.customer?.fullName ?? "Customer unavailable"}
      </p>

      <div className="flex items-center gap-2">
        <QuoteStatusPill status={quote.status} compact />
      </div>

      <p className="text-sm font-semibold text-slate-900">{money(quote.totalAmount)}</p>

      <Button type="button" size="sm" variant="outline" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}

function BuilderWorkflowCard({
  steps,
  progress,
}: {
  steps: Array<{ label: string; description: string; complete: boolean; icon: ReactNode }>;
  progress: number;
}) {
  return (
    <Card variant="default" padding="lg">
      <CardHeader
        title="Builder Workflow"
        subtitle="Follow this order on phone or desktop so customers and quotes stay clean."
      />
      <ProgressBar value={progress} label="Completion" hint={`${progress}%`} />
      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        {steps.map((step, index) => (
          <div
            key={step.label}
            className={`rounded-xl border px-4 py-3 ${
              step.complete
                ? "border-quotefly-blue/15 bg-quotefly-blue/[0.04]"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full ${step.complete ? "bg-quotefly-blue/10 text-quotefly-blue" : "bg-slate-100 text-slate-500"}`}>
                {step.complete ? <CheckCircleIcon size={16} /> : step.icon}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                {index + 1}
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-900">{step.label}</p>
            <p className="mt-1 text-xs text-slate-600">{step.description}</p>
          </div>
        ))}
      </div>
    </Card>
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
        <div className="rounded-xl border border-slate-200 bg-white p-4">
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

        <div className="rounded-xl border border-slate-200 bg-white p-4">
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

        <div className="rounded-xl border border-slate-200 bg-white p-4">
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
