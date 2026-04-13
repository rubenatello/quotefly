import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, Plus, Sparkles } from "lucide-react";
import { FeatureLockedCard } from "../components/dashboard/DashboardUi";
import { useDashboard, money } from "../components/dashboard/DashboardContext";
import { QuickCustomerModal } from "../components/customers/QuickCustomerModal";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
import { QuoteSheetEditor } from "../components/quotes/QuoteSheetEditor";
import { SaveLinePresetModal } from "../components/quotes/SaveLinePresetModal";
import { WorkPresetPickerModal } from "../components/quotes/WorkPresetPickerModal";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Modal,
  ModalBody,
  ModalHeader,
  PageHeader,
  Select,
  Textarea,
} from "../components/ui";
import { api, type WorkPreset } from "../lib/api";
import {
  buildPresetPayloadFromLine,
  joinQuoteLineDescription,
  makeEditableQuoteLine,
  quoteLineAmount,
  quoteLineCostTotal,
  type EditableQuoteLine,
} from "../lib/quote-lines";
import { usePageView, useTrack } from "../lib/analytics";

function formatPresetUnitLabel(unitType: WorkPreset["unitType"]): string {
  if (unitType === "SQ_FT") return "SQ FT";
  if (unitType === "HOUR") return "Hours";
  if (unitType === "EACH") return "Units";
  return "Qty";
}

function buildAiPromptStarters(
  serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
  customer?: { fullName: string; phone: string } | null,
) {
  const customerLead = customer
    ? `${customer.fullName} ${customer.phone}`
    : "Alan Johnson 818-233-4333";

  if (serviceType === "ROOFING") {
    return [
      `New quote for ${customerLead}. Replace a 1,250 square foot asphalt shingle roof and include tear-off, disposal, underlayment, and installation.`,
      `Draft a roofing quote for ${customerLead}. Add roof deck inspection, flashing, and new architectural shingles.`,
    ];
  }

  if (serviceType === "HVAC") {
    return [
      `New quote for ${customerLead}. Install a new AC condenser and reconnect refrigerant lines with startup testing.`,
      `Draft an HVAC quote for ${customerLead}. Replace a furnace and include haul-away, install materials, and testing.`,
    ];
  }

  if (serviceType === "PLUMBING") {
    return [
      `New quote for ${customerLead}. Replace a burst pipe section, patch wall access, and test the line after repair.`,
      `Draft a plumbing quote for ${customerLead}. Install a new water heater with fittings, labor, and disposal.`,
    ];
  }

  if (serviceType === "FLOORING") {
    return [
      `New quote for ${customerLead}. Install 650 square feet of LVP flooring with underlayment and trim.`,
      `Draft a flooring quote for ${customerLead}. Remove old carpet and install new laminate flooring in the living room and hallway.`,
    ];
  }

  if (serviceType === "GARDENING") {
    return [
      `New quote for ${customerLead}. Monthly landscaping maintenance with mowing, edging, cleanup, and shrub trimming.`,
      `Draft a gardening quote for ${customerLead}. Refresh front-yard mulch beds, trim hedges, and haul debris.`,
    ];
  }

  return [
    `New quote for ${customerLead}. Remodel a small bathroom and include demolition, framing touchups, finish work, and cleanup.`,
    `Draft a construction quote for ${customerLead}. Build a backyard patio cover and include labor, materials, and site cleanup.`,
  ];
}

type BuilderPane = "editor" | "preview";

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const track = useTrack();
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [presetLibrary, setPresetLibrary] = useState<WorkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedPresetQuantity, setSelectedPresetQuantity] = useState("1");
  const [draftLines, setDraftLines] = useState<EditableQuoteLine[]>([makeEditableQuoteLine()]);
  const [presetPromptLine, setPresetPromptLine] = useState<EditableQuoteLine | null>(null);
  const [presetPromptSaving, setPresetPromptSaving] = useState(false);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<BuilderPane>("editor");
  const {
    session,
    customers,
    saving,
    error,
    notice,
    setError,
    setNotice,
    canUseChatToQuote,
    aiQuoteLimit,
    chatPrompt,
    setChatPrompt,
    createQuoteFromChatPrompt,
    currentPlanLabel,
    canAutoUpgradeMessage,
    quoteForm,
    setQuoteForm,
    createQuoteDraftFromForm,
    selectQuoteCustomer,
    selectedQuoteId,
    navigateToQuote,
    loadCustomers,
  } = useDashboard();

  const customerOptions = customers.map((customer) => ({
    value: customer.id,
    label: `${customer.fullName} (${customer.phone})`,
  }));

  const activeCustomer = useMemo(
    () => customers.find((customer) => customer.id === quoteForm.customerId) ?? null,
    [customers, quoteForm.customerId],
  );
  const preparedDateLabel = useMemo(() => new Date().toLocaleDateString(), []);

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
        setPresetLoadError("Common work names could not be loaded.");
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
      setSelectedPresetQuantity("1");
      return;
    }

    const activePreset = availablePresets.find((preset) => preset.id === selectedPresetId) ?? availablePresets[0];
    setSelectedPresetId(activePreset.id);
    setSelectedPresetQuantity(String(Number(activePreset.defaultQuantity) || 1));
  }, [availablePresets, selectedPresetId]);

  const selectedPreset = useMemo(
    () => availablePresets.find((preset) => preset.id === selectedPresetId) ?? null,
    [availablePresets, selectedPresetId],
  );

  const presetQuantity = useMemo(() => {
    const parsed = Number(selectedPresetQuantity);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [selectedPresetQuantity]);

  const filteredDraftLines = useMemo(
    () => draftLines.filter((line) => line.title.trim() || line.details.trim()),
    [draftLines],
  );

  const savedPresetKeys = useMemo(
    () =>
      new Set(
        presetLibrary.map((preset) => `${preset.serviceType}:${preset.name.trim().toLowerCase()}:${(preset.description ?? "").trim().toLowerCase()}`),
      ),
    [presetLibrary],
  );

  const internalSubtotal = useMemo(
    () => filteredDraftLines.reduce((total, line) => total + quoteLineCostTotal(line.quantity, line.unitCost), 0),
    [filteredDraftLines],
  );
  const customerSubtotal = useMemo(
    () => filteredDraftLines.reduce((total, line) => total + quoteLineAmount(line.quantity, line.unitPrice), 0),
    [filteredDraftLines],
  );
  const taxAmount = useMemo(() => {
    const parsed = Number(quoteForm.taxAmount);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [quoteForm.taxAmount]);
  const totalAmount = customerSubtotal + taxAmount;
  const estimatedProfit = customerSubtotal - internalSubtotal;
  const estimatedMarginPercent = customerSubtotal > 0 ? (estimatedProfit / customerSubtotal) * 100 : 0;
  const previewLines = useMemo(
    () =>
      filteredDraftLines.map((line) => ({
        id: line.id,
        title: line.title,
        details: line.details,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: quoteLineAmount(line.quantity, line.unitPrice),
      })),
    [filteredDraftLines],
  );
  const aiPromptStarters = useMemo(
    () => buildAiPromptStarters(quoteForm.serviceType, activeCustomer ? { fullName: activeCustomer.fullName, phone: activeCustomer.phone } : null),
    [quoteForm.serviceType, activeCustomer],
  );

  function updateDraftLine(lineId: string, field: keyof EditableQuoteLine, value: string) {
    setDraftLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
    );
  }

  function addBlankLine() {
    const previousLine = draftLines[draftLines.length - 1];
    if (
      previousLine &&
      previousLine.title.trim() &&
      !previousLine.presetPromptHandled &&
      !previousLine.sourcePresetId &&
      !savedPresetKeys.has(
        `${quoteForm.serviceType}:${previousLine.title.trim().toLowerCase()}:${previousLine.details.trim().toLowerCase()}`,
      )
    ) {
      setPresetPromptLine(previousLine);
      setDraftLines((current) =>
        current.map((line) =>
          line.id === previousLine.id ? { ...line, presetPromptHandled: true } : line,
        ),
      );
    }
    setDraftLines((current) => [...current, makeEditableQuoteLine()]);
  }

  function removeDraftLine(lineId: string) {
    setDraftLines((current) => {
      const remaining = current.filter((line) => line.id !== lineId);
      return remaining.length ? remaining : [makeEditableQuoteLine()];
    });
  }

  function applyPresetToDraft(preset: WorkPreset) {
    const nextLine = makeEditableQuoteLine({
      title: preset.name,
      details: preset.description ?? "",
      quantity: String(presetQuantity),
      unitCost: Number(preset.unitCost).toFixed(2),
      unitPrice: Number(preset.unitPrice).toFixed(2),
      sourcePresetId: preset.id,
    });

    setDraftLines((current) => {
      const hasOnlyEmptyLine =
        current.length === 1 && !current[0].title.trim() && !current[0].details.trim();
      return hasOnlyEmptyLine ? [nextLine] : [...current, nextLine];
    });

    setQuoteForm((prev) => ({
      ...prev,
      title: prev.title.trim() ? prev.title : preset.name,
      scopeText: prev.scopeText.trim() ? prev.scopeText : preset.description ?? "",
    }));
    setNotice(`${preset.name} loaded into the quote.`);
  }

  async function saveDraftLineAsPreset(includeDescription: boolean) {
    if (!presetPromptLine) return;
    setPresetPromptSaving(true);
    setError(null);
    try {
      const result = await api.onboarding.savePreset(
        buildPresetPayloadFromLine(quoteForm.serviceType, presetPromptLine, { includeDescription }),
      );
      setPresetLibrary((current) => {
        const next = current.filter((preset) => preset.id !== result.preset.id);
        return [...next, result.preset];
      });
      setDraftLines((current) =>
        current.map((line) =>
          line.id === presetPromptLine.id
            ? {
                ...line,
                sourcePresetId: result.preset.id,
                presetPromptHandled: true,
              }
            : line,
        ),
      );
      setSelectedPresetId(result.preset.id);
      setNotice(includeDescription ? "Saved job name and description for future quotes." : "Saved job name for future quotes.");
      setPresetPromptLine(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed saving work name.");
    } finally {
      setPresetPromptSaving(false);
    }
  }

  function dismissPresetPrompt() {
    if (presetPromptLine) {
      setDraftLines((current) =>
        current.map((line) =>
          line.id === presetPromptLine.id ? { ...line, presetPromptHandled: true } : line,
        ),
      );
    }
    setPresetPromptLine(null);
  }

  async function handleCreateQuote() {
    if (!quoteForm.customerId) {
      setError("Select a customer before creating the quote.");
      return;
    }

    if (!quoteForm.title.trim()) {
      setError("Add a quote title before creating the quote.");
      return;
    }

    if (filteredDraftLines.length === 0) {
      setError("Add at least one quote line before creating the quote.");
      return;
    }

    const linesToCreate = filteredDraftLines;
    const promptCandidate =
      [...linesToCreate]
        .reverse()
        .find(
          (line) =>
            line.title.trim() &&
            !line.presetPromptHandled &&
            !line.sourcePresetId &&
            !savedPresetKeys.has(
              `${quoteForm.serviceType}:${line.title.trim().toLowerCase()}:${line.details.trim().toLowerCase()}`,
            ),
        ) ?? null;

    track("builder_quote_create");
    const createdQuote = await createQuoteDraftFromForm({
      quoteOverride: {
        internalCostSubtotal: internalSubtotal.toFixed(2),
        customerPriceSubtotal: customerSubtotal.toFixed(2),
      },
      initialLineItems: linesToCreate.map((line) => ({
        description: joinQuoteLineDescription(line.title, line.details),
        quantity: Number(line.quantity) || 1,
        unitCost: Number(line.unitCost) || 0,
        unitPrice: Number(line.unitPrice) || 0,
      })),
      successNotice: "Quote created. Continue editing in the quote desk.",
    });

    if (createdQuote) {
      setDraftLines([makeEditableQuoteLine()]);
      if (!presetPromptLine && promptCandidate) {
        setPresetPromptLine(promptCandidate);
      }
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Build Quote"
        subtitle="Start with the customer, then build the quote line by line. Load common work names when you need speed, but keep the quote sheet simple."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
              Preview PDF
            </Button>
            {selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : null}
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      <div className="flex gap-2 lg:hidden">
        {([
          { id: "editor", label: "Edit quote" },
          { id: "preview", label: "Preview" },
        ] as const).map((pane) => (
          <button
            key={pane.id}
            type="button"
            onClick={() => setMobilePane(pane.id)}
            className={`flex-1 rounded-full border px-4 py-2 text-sm font-medium transition ${
              mobilePane === pane.id
                ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                : "border-slate-200 bg-white text-slate-700"
            }`}
          >
            {pane.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_340px]">
        <div>
          {canUseChatToQuote ? (
            <Card variant="default" padding="md" className="h-full">
              <CardHeader
                title="AI quick start"
                subtitle={`Start here when speed matters. Draft the first version with AI, then clean the quote line by line.`}
                actions={
                  aiQuoteLimit !== null ? (
                    <Badge tone="blue">
                      {session?.usage?.monthlyAiQuoteCount ?? 0}/{aiQuoteLimit} drafts
                    </Badge>
                  ) : null
                }
              />
              <div className="mb-3 flex flex-wrap gap-2">
                {aiPromptStarters.map((starter, index) => (
                  <button
                    key={`${quoteForm.serviceType}-${index}`}
                    type="button"
                    onClick={() => setChatPrompt(starter)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white"
                  >
                    {index === 0 ? "Use starter prompt" : "Alt prompt"}
                  </button>
                ))}
              </div>
              <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px]" onSubmit={(event) => void createQuoteFromChatPrompt(event)}>
                <Textarea
                  label="Prompt"
                  rows={5}
                  placeholder="New quote for Alan Johnson. Replace 1,250 sq ft asphalt shingle roof..."
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.target.value)}
                />
                <div className="flex flex-col gap-3">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                    AI should get you to a first draft fast, not lock the quote. You still own every line, cost, and price.
                  </div>
                  <Button fullWidth loading={saving} icon={<Sparkles size={14} />}>
                    Draft With AI
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <FeatureLockedCard
              title="AI draft helper"
              description="AI-assisted quote drafting is not active on this workspace yet."
              currentPlanLabel={currentPlanLabel}
              requiredPlanLabel="Starter"
              showUpgradeHint={canAutoUpgradeMessage}
            />
          )}
        </div>

        <Card variant="blue" padding="md" className="self-start">
          <CardHeader
            title="Quote actions"
            subtitle="Keep PDF and create actions in view while you build."
            actions={
              <Button variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                Preview PDF
              </Button>
            }
          />
          <div className="space-y-3 text-sm">
            <SummaryRow label="Customer subtotal" value={money(customerSubtotal)} />
            <SummaryRow label="Tax" value={money(taxAmount)} />
            <SummaryRow label="Total" value={money(totalAmount)} strong />
            <SummaryRow label="Est. profit" value={money(estimatedProfit)} tone={estimatedProfit >= 0 ? "good" : "bad"} />
            <SummaryRow label="Margin" value={`${estimatedMarginPercent.toFixed(1)}%`} tone={estimatedMarginPercent >= 10 ? "good" : "bad"} />
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-700">
            <ChecklistItem compact complete={Boolean(activeCustomer)} label="Customer selected" />
            <ChecklistItem compact complete={Boolean(quoteForm.title.trim())} label="Quote title added" />
            <ChecklistItem compact complete={filteredDraftLines.length > 0} label={`${filteredDraftLines.length || 0} line${filteredDraftLines.length === 1 ? "" : "s"} ready`} />
          </div>
          <div className="mt-4 grid gap-2">
            <Button fullWidth loading={saving} onClick={() => void handleCreateQuote()}>
              Create Quote
            </Button>
            {selectedQuoteId ? (
              <Button fullWidth variant="outline" onClick={() => navigateToQuote(selectedQuoteId)}>
                Open Active Quote
              </Button>
            ) : null}
          </div>
        </Card>
      </div>

      <Card variant="default" padding="md">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_auto]">
          <Select
            label="Customer"
            value={quoteForm.customerId}
            onChange={(event) => selectQuoteCustomer(event.target.value)}
            options={customerOptions}
            placeholder="Select customer"
          />
          <Select
            label="Trade"
            value={quoteForm.serviceType}
            onChange={(event) =>
              setQuoteForm((prev) => ({ ...prev, serviceType: event.target.value as typeof prev.serviceType }))
            }
            options={[
              { value: "HVAC", label: "HVAC" },
              { value: "PLUMBING", label: "PLUMBING" },
              { value: "FLOORING", label: "FLOORING" },
              { value: "ROOFING", label: "ROOFING" },
              { value: "GARDENING", label: "GARDENING" },
              { value: "CONSTRUCTION", label: "CONSTRUCTION" },
            ]}
          />
          <div className="flex items-end">
            <Button fullWidth variant="outline" icon={<Plus size={14} />} onClick={() => setQuickCustomerOpen(true)}>
              Add Customer
            </Button>
          </div>
        </div>
      </Card>

      {mobilePane === "preview" ? (
        <div className="lg:hidden">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            customerName={activeCustomer?.fullName ?? "Select customer"}
            customerPhone={activeCustomer?.phone ?? null}
            customerEmail={activeCustomer?.email ?? null}
            preparedDateLabel={preparedDateLabel}
            sentDateLabel="N/A"
            quoteTitle={quoteForm.title}
            scopeText={quoteForm.scopeText}
            lines={previewLines}
            customerSubtotal={customerSubtotal}
            taxAmount={taxAmount}
            totalAmount={totalAmount}
          />
        </div>
      ) : null}

      <div className={mobilePane === "preview" ? "hidden lg:block" : ""}>
        <QuoteSheetEditor
            title={quoteForm.title}
            onTitleChange={(value) => setQuoteForm((prev) => ({ ...prev, title: value }))}
            titlePlaceholder="Asphalt shingle roof replacement"
            businessName={session?.tenantName ?? "QuoteFly"}
            customerName={activeCustomer?.fullName ?? "Select customer"}
            customerHint={activeCustomer ? `${activeCustomer.phone}${activeCustomer.email ? ` / ${activeCustomer.email}` : ""}` : "Use an existing customer or add one fast."}
            preparedDateLabel={preparedDateLabel}
            sentDateLabel="N/A"
            overview={quoteForm.scopeText}
            onOverviewChange={(value) => setQuoteForm((prev) => ({ ...prev, scopeText: value }))}
            overviewPlaceholder="Optional overview shown near the top of the quote."
            actions={
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                  Preview PDF
                </Button>
                <Button variant="outline" size="sm" icon={<Plus size={14} />} onClick={addBlankLine}>
                  Add line
                </Button>
              </div>
            }
          >
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Common work names</p>
                  <p className="mt-1 text-sm text-slate-600">Load standard jobs or your saved work names into the quote sheet.</p>
                </div>
                <div className="lg:hidden">
                  <Button size="sm" variant="outline" onClick={() => setPresetPickerOpen(true)}>
                    Browse jobs
                  </Button>
                </div>
                {selectedPreset ? (
                  <div className="hidden flex-col gap-2 sm:flex-row sm:items-end lg:flex">
                    <div className="sm:w-24">
                      <Input
                        label={formatPresetUnitLabel(selectedPreset.unitType)}
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={selectedPresetQuantity}
                        onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                      />
                    </div>
                    <Button size="sm" variant="outline" onClick={() => applyPresetToDraft(selectedPreset)}>
                      Load selected job
                    </Button>
                  </div>
                ) : null}
              </div>

              {presetLoadError ? <p className="mt-3 text-xs text-red-600">{presetLoadError}</p> : null}

              {selectedPreset ? (
                <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 lg:hidden">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{selectedPreset.name}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {money(selectedPreset.unitPrice)} / {formatPresetUnitLabel(selectedPreset.unitType)}
                      </p>
                    </div>
                    {selectedPreset.catalogKey ? <Badge tone="blue">Standard</Badge> : <Badge tone="slate">Saved</Badge>}
                  </div>
                  <div className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-2">
                    <Input
                      label={formatPresetUnitLabel(selectedPreset.unitType)}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={selectedPresetQuantity}
                      onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                    />
                    <div className="flex items-end">
                      <Button fullWidth size="sm" variant="outline" onClick={() => applyPresetToDraft(selectedPreset)}>
                        Load selected job
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 hidden gap-2 overflow-x-auto pb-1 lg:flex">
                {presetsLoading ? (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">Loading common work…</div>
                ) : availablePresets.length ? (
                  availablePresets.slice(0, 10).map((preset) => {
                    const active = preset.id === selectedPresetId;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedPresetId(preset.id)}
                        className={`min-w-fit rounded-xl border px-3 py-2 text-left transition ${
                          active
                            ? "border-quotefly-blue/20 bg-white text-quotefly-blue"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        <p className="text-sm font-semibold">{preset.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{money(preset.unitPrice)} / {formatPresetUnitLabel(preset.unitType)}</p>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-sm text-slate-500">
                    No saved jobs for this trade yet. Add them in Setup.
                  </div>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_72px_96px_96px_110px_90px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                <span>Line</span>
                <span>Description</span>
                <span>Qty</span>
                <span>Cost</span>
                <span>Price</span>
                <span>Total</span>
                <span className="text-right">Remove</span>
              </div>
              <div className="divide-y divide-slate-200">
                {draftLines.map((line, index) => (
                  <DraftLineEditorRow
                    key={line.id}
                    line={line}
                    index={index}
                    startExpanded={!line.title.trim() && !line.details.trim()}
                    onChange={updateDraftLine}
                    onRemove={removeDraftLine}
                  />
                ))}
              </div>
            </div>
          </QuoteSheetEditor>
      </div>

      <div className="lg:hidden">
        <div className="h-24" />
        <div className="fixed inset-x-4 bottom-20 z-40 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span>{filteredDraftLines.length} line{filteredDraftLines.length === 1 ? "" : "s"}</span>
            <span>Total {money(totalAmount)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              icon={mobilePane === "preview" ? <ChevronDown size={14} /> : <Eye size={14} />}
              onClick={() => setMobilePane((current) => (current === "editor" ? "preview" : "editor"))}
            >
              {mobilePane === "preview" ? "Edit Quote" : "Preview"}
            </Button>
            <Button loading={saving} onClick={() => void handleCreateQuote()}>
              Create Quote
            </Button>
          </div>
        </div>
      </div>

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        onCreated={async ({ customer, intent }) => {
          await loadCustomers();
          selectQuoteCustomer(customer.id);
          setNotice(intent === "quote" ? `${customer.fullName} is ready for a quote.` : "Customer created.");
        }}
      />

      <SaveLinePresetModal
        open={Boolean(presetPromptLine)}
        line={presetPromptLine}
        saving={presetPromptSaving}
        onClose={dismissPresetPrompt}
        onSaveFull={() => void saveDraftLineAsPreset(true)}
        onSaveNameOnly={() => void saveDraftLineAsPreset(false)}
      />

      <WorkPresetPickerModal
        open={presetPickerOpen}
        onClose={() => setPresetPickerOpen(false)}
        presets={availablePresets}
        selectedPresetId={selectedPresetId}
        onSelectPreset={setSelectedPresetId}
        quantity={selectedPresetQuantity}
        onQuantityChange={setSelectedPresetQuantity}
        primaryActionLabel="Load selected job"
        onPrimaryAction={() => {
          if (!selectedPreset) return;
          applyPresetToDraft(selectedPreset);
          setPresetPickerOpen(false);
        }}
      />

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="xl" ariaLabel="Quote preview">
        <ModalHeader
          title="Quote preview"
          description="This is the customer-facing view of the quote as you build it."
          onClose={() => setPreviewOpen(false)}
        />
        <ModalBody className="bg-slate-50">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            customerName={activeCustomer?.fullName ?? "Select customer"}
            customerPhone={activeCustomer?.phone ?? null}
            customerEmail={activeCustomer?.email ?? null}
            preparedDateLabel={preparedDateLabel}
            sentDateLabel="N/A"
            quoteTitle={quoteForm.title}
            scopeText={quoteForm.scopeText}
            lines={previewLines}
            customerSubtotal={customerSubtotal}
            taxAmount={taxAmount}
            totalAmount={totalAmount}
          />
        </ModalBody>
      </Modal>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "good" | "bad";
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span
        className={`text-sm font-semibold ${
          strong ? "text-slate-950" : tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-slate-900"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ChecklistItem({
  complete,
  label,
  compact,
}: {
  complete: boolean;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 ${compact ? "py-2" : "py-2"} ${complete ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${complete ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
        {complete ? "OK" : "-"}
      </span>
      <span className="text-sm text-slate-700">{label}</span>
    </div>
  );
}

function DraftLineEditorRow({
  line,
  index,
  startExpanded,
  onChange,
  onRemove,
}: {
  line: EditableQuoteLine;
  index: number;
  startExpanded?: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onRemove: (lineId: string) => void;
}) {
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);

  useEffect(() => {
    setExpanded(startExpanded ?? false);
  }, [line.id, startExpanded]);

  return (
    <div className="px-4 py-4">
      <div className="lg:hidden">
        <div className="rounded-2xl border border-slate-200 bg-slate-50">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
          >
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Line {index + 1}</p>
              <p className="truncate text-sm font-semibold text-slate-900">{line.title.trim() || "Untitled line"}</p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                <span>Qty {line.quantity}</span>
                <span>Price {money(line.unitPrice)}</span>
                <span>Total {money(lineTotal)}</span>
              </div>
            </div>
            <span className="rounded-full border border-slate-200 bg-white p-2 text-slate-500">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>

          <div className={expanded ? "border-t border-slate-200 px-3 py-3" : "hidden"}>
            <div className="mb-2 flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => onRemove(line.id)}>
                Remove
              </Button>
            </div>
            <div className="space-y-3">
              <Input
                label="Line"
                placeholder="Asphalt shingle tear-off"
                value={line.title}
                onChange={(event) => onChange(line.id, "title", event.target.value)}
              />
              <Textarea
                label="Description"
                rows={3}
                placeholder="Optional scope details for this line"
                value={line.details}
                onChange={(event) => onChange(line.id, "details", event.target.value)}
              />
              <div className="grid grid-cols-3 gap-2">
                <Input label="Qty" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
                <Input label="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
                <Input label="Price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900">
                Line total {money(lineTotal)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="hidden lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_72px_96px_96px_110px_90px] lg:items-start lg:gap-3">
        <Input
          placeholder="Line"
          value={line.title}
          onChange={(event) => onChange(line.id, "title", event.target.value)}
        />
        <Textarea
          rows={2}
          className="min-h-[84px]"
          placeholder="Description"
          value={line.details}
          onChange={(event) => onChange(line.id, "details", event.target.value)}
        />
        <Input type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
        <Input type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
        <Input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900">
          {money(lineTotal)}
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => onRemove(line.id)}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

export default QuoteBuilderView;




