import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Eye,
  FileOutput,
  Mail,
  MessageSquare,
  Plus,
  Save,
  Send,
} from "lucide-react";
import { useDashboard, formatDateTime, money } from "../components/dashboard/DashboardContext";
import {
  FeatureLockedCard,
  HistoryEventPill,
  OutboundChannelPill,
  QuoteStatusPill,
} from "../components/dashboard/DashboardUi";
import { QuickLookupCard } from "../components/dashboard/QuickLookupCard";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
import { QuoteSheetEditor } from "../components/quotes/QuoteSheetEditor";
import { SaveLinePresetModal } from "../components/quotes/SaveLinePresetModal";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
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
  toEditableQuoteLine,
  type EditableQuoteLine,
} from "../lib/quote-lines";
import { usePageView, useTrack } from "../lib/analytics";

function formatPresetUnitLabel(unitType: WorkPreset["unitType"]): string {
  if (unitType === "SQ_FT") return "SQ FT";
  if (unitType === "HOUR") return "Hours";
  if (unitType === "EACH") return "Units";
  return "Qty";
}

type DeskTab = "quote" | "send" | "history" | "log";
type DeskPane = "editor" | "preview";

export function QuoteDeskView() {
  usePageView("quote_desk");
  const track = useTrack();
  const [lineItemPendingDeleteId, setLineItemPendingDeleteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DeskTab>("quote");
  const [presetLibrary, setPresetLibrary] = useState<WorkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedPresetQuantity, setSelectedPresetQuantity] = useState("1");
  const [editableLines, setEditableLines] = useState<EditableQuoteLine[]>([]);
  const [newLine, setNewLine] = useState<EditableQuoteLine>(makeEditableQuoteLine());
  const [presetPromptLine, setPresetPromptLine] = useState<EditableQuoteLine | null>(null);
  const [presetPromptSaving, setPresetPromptSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<DeskPane>("editor");
  const {
    session,
    selectedQuoteId,
    focusQuoteDesk,
    selectedQuote,
    quoteEditForm,
    setQuoteEditForm,
    saving,
    error,
    notice,
    setError,
    setNotice,
    persistSelectedQuote,
    updateQuoteLifecycle,
    openSendComposer,
    confirmSendComposer,
    downloadQuotePdf,
    addLineItemDraft,
    updateLineItem,
    deleteLineItem,
    sendComposer,
    setSendComposer,
    canViewQuoteHistory,
    canViewCommunicationLog,
    currentPlanLabel,
    canAutoUpgradeMessage,
    quoteHistory,
    outboundEvents,
    outboundEventsLoading,
    historyLoading,
    historyMode,
    setHistoryMode,
    historyCustomerId,
    setHistoryCustomerId,
    customers,
    loadQuoteHistory,
    loadOutboundEvents,
    navigateToBuilder,
    navigateToQuote,
  } = useDashboard();
  const { quoteId } = useParams<{ quoteId: string }>();

  useEffect(() => {
    if (!quoteId) return;
    if (quoteId !== selectedQuoteId) {
      focusQuoteDesk(quoteId);
    }
  }, [quoteId, selectedQuoteId, focusQuoteDesk]);

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

  useEffect(() => {
    if (!selectedQuote) {
      setEditableLines([]);
      setNewLine(makeEditableQuoteLine());
      return;
    }

    setEditableLines((selectedQuote.lineItems ?? []).map(toEditableQuoteLine));
    setNewLine(makeEditableQuoteLine());
    setMobilePane("editor");
  }, [selectedQuote?.id, selectedQuote?.updatedAt]);

  const availablePresets = useMemo(
    () =>
      presetLibrary
        .filter((preset) => preset.serviceType === quoteEditForm.serviceType)
        .sort((left, right) => {
          const leftIsStandard = Boolean(left.catalogKey);
          const rightIsStandard = Boolean(right.catalogKey);
          if (leftIsStandard !== rightIsStandard) return leftIsStandard ? -1 : 1;
          return left.name.localeCompare(right.name);
        }),
    [presetLibrary, quoteEditForm.serviceType],
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

  const savedPresetKeys = useMemo(
    () =>
      new Set(
        presetLibrary.map(
          (preset) =>
            `${preset.serviceType}:${preset.name.trim().toLowerCase()}:${(preset.description ?? "").trim().toLowerCase()}`,
        ),
      ),
    [presetLibrary],
  );

  const presetQuantity = useMemo(() => {
    const parsed = Number(selectedPresetQuantity);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [selectedPresetQuantity]);

  const originalLineMap = useMemo(() => {
    const entries = (selectedQuote?.lineItems ?? []).map((lineItem) => [lineItem.id, toEditableQuoteLine(lineItem)] as const);
    return new Map(entries);
  }, [selectedQuote?.id, selectedQuote?.updatedAt]);

  const dirtyLineIds = useMemo(() => {
    return editableLines
      .filter((line) => {
        const original = originalLineMap.get(line.id);
        if (!original) return false;
        return (
          original.title !== line.title ||
          original.details !== line.details ||
          original.quantity !== line.quantity ||
          original.unitCost !== line.unitCost ||
          original.unitPrice !== line.unitPrice
        );
      })
      .map((line) => line.id);
  }, [editableLines, originalLineMap]);

  const lineItemCount = editableLines.length;
  const internalSubtotal = useMemo(
    () => editableLines.reduce((total, line) => total + quoteLineCostTotal(line.quantity, line.unitCost), 0),
    [editableLines],
  );
  const customerSubtotal = useMemo(
    () => editableLines.reduce((total, line) => total + quoteLineAmount(line.quantity, line.unitPrice), 0),
    [editableLines],
  );
  const taxAmount = useMemo(() => {
    const parsed = Number(quoteEditForm.taxAmount);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [quoteEditForm.taxAmount]);
  const totalAmount = customerSubtotal + taxAmount;
  const estimatedProfit = customerSubtotal - internalSubtotal;
  const estimatedMarginPercent = customerSubtotal > 0 ? (estimatedProfit / customerSubtotal) * 100 : 0;
  const sentDateLabel = selectedQuote?.sentAt ? formatDateTime(selectedQuote.sentAt) : "N/A";
  const customerName = selectedQuote?.customer?.fullName ?? "Customer unavailable";
  const customerPhone = selectedQuote?.customer?.phone ?? "No phone";
  const customerEmail = selectedQuote?.customer?.email ?? null;
  const previewLines = useMemo(
    () =>
      editableLines.map((line) => ({
        id: line.id,
        title: line.title,
        details: line.details,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: quoteLineAmount(line.quantity, line.unitPrice),
      })),
    [editableLines],
  );

  function updateEditableLine(lineId: string, field: keyof EditableQuoteLine, value: string) {
    setEditableLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
    );
  }

  async function saveLine(lineId: string) {
    const line = editableLines.find((entry) => entry.id === lineId);
    if (!line || !line.title.trim()) {
      setError("Each line needs a title before it can be saved.");
      return;
    }

    track("quote_line_save");
    await updateLineItem(
      lineId,
      {
        description: joinQuoteLineDescription(line.title, line.details),
        quantity: Number(line.quantity) || 1,
        unitCost: Number(line.unitCost) || 0,
        unitPrice: Number(line.unitPrice) || 0,
      },
      { notice: `${line.title} saved.` },
    );
  }

  async function saveAllLineEdits() {
    for (const lineId of dirtyLineIds) {
      await saveLine(lineId);
    }
  }

  async function addNewLine() {
    if (!newLine.title.trim()) {
      setError("Add a line title before inserting a new row.");
      return;
    }

    const lineToMaybeSave = newLine;
    track("quote_line_add");
    await addLineItemDraft(
      {
        description: joinQuoteLineDescription(lineToMaybeSave.title, lineToMaybeSave.details),
        quantity: Number(lineToMaybeSave.quantity) || 1,
        unitCost: Number(lineToMaybeSave.unitCost) || 0,
        unitPrice: Number(lineToMaybeSave.unitPrice) || 0,
      },
      {
        notice: `${lineToMaybeSave.title} added to the quote.`,
      },
    );
    setNewLine(makeEditableQuoteLine());
    if (
      lineToMaybeSave.title.trim() &&
      !lineToMaybeSave.sourcePresetId &&
      !savedPresetKeys.has(
        `${quoteEditForm.serviceType}:${lineToMaybeSave.title.trim().toLowerCase()}:${lineToMaybeSave.details.trim().toLowerCase()}`,
      )
    ) {
      setPresetPromptLine(lineToMaybeSave);
    }
  }

  async function handleSaveQuoteSheet() {
    track("quote_sheet_save");
    await persistSelectedQuote();
    if (dirtyLineIds.length) {
      await saveAllLineEdits();
    }
  }

  function loadPresetToNewLine(preset: WorkPreset) {
    setNewLine(
      makeEditableQuoteLine({
        title: preset.name,
        details: preset.description ?? "",
        quantity: String(presetQuantity),
        unitCost: Number(preset.unitCost).toFixed(2),
        unitPrice: Number(preset.unitPrice).toFixed(2),
        sourcePresetId: preset.id,
      }),
    );
    setNotice(`${preset.name} loaded into the new line row.`);
  }

  async function addPresetToQuote(preset: WorkPreset) {
    track("quote_line_preset_add");
    await addLineItemDraft(
      {
        description: joinQuoteLineDescription(preset.name, preset.description ?? ""),
        quantity: presetQuantity,
        unitCost: Number(preset.unitCost),
        unitPrice: Number(preset.unitPrice),
      },
      { notice: `${preset.name} added to the quote.` },
    );
  }

  async function saveNewLineAsPreset(includeDescription: boolean) {
    if (!presetPromptLine) return;
    setPresetPromptSaving(true);
    setError(null);
    try {
      const result = await api.onboarding.savePreset(
        buildPresetPayloadFromLine(quoteEditForm.serviceType, presetPromptLine, { includeDescription }),
      );
      setPresetLibrary((current) => {
        const next = current.filter((preset) => preset.id !== result.preset.id);
        return [...next, result.preset];
      });
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
    setPresetPromptLine(null);
  }

  async function confirmDeleteLineItem() {
    if (!lineItemPendingDeleteId) return;
    track("quote_line_delete");
    await deleteLineItem(lineItemPendingDeleteId);
    setLineItemPendingDeleteId(null);
  }

  if (!selectedQuote) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={<FileOutput size={18} />}
          title="No quote selected"
          description="Find an existing quote or jump into a fresh quote for an existing customer."
        />
        <QuickLookupCard
          title="Find Customer or Quote"
          subtitle="Open an existing quote or start a new quote for an existing customer."
          customerActionLabel="New Quote"
          customerActionVariant="secondary"
          onCustomerAction={(customer) => {
            setNotice(`${customer.fullName} is ready for a new quote.`);
            navigateToBuilder(customer.id);
          }}
          onQuoteAction={(quote) => navigateToQuote(quote.id)}
        />
      </div>
    );
  }

  const tabs: Array<{ id: DeskTab; label: string }> = [
    { id: "quote", label: "Quote" },
    { id: "send", label: "Send" },
    { id: "history", label: "History" },
    { id: "log", label: "Send Log" },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={quoteEditForm.title || selectedQuote.title}
        subtitle="Edit the quote directly: update the customer-facing copy, adjust the lines, then send or export when it is ready."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
              Preview
            </Button>
            <QuoteStatusPill status={selectedQuote.status} />
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}

      {activeTab === "quote" ? (
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
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card variant="default" padding="md">
          <div className="grid gap-3 md:grid-cols-[180px_180px_minmax(0,1fr)]">
            <Select
              label="Trade"
              value={quoteEditForm.serviceType}
              onChange={(event) =>
                setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as typeof prev.serviceType }))
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
            <Select
              label="Quote status"
              value={quoteEditForm.status}
              onChange={(event) =>
                setQuoteEditForm((prev) => ({ ...prev, status: event.target.value as typeof prev.status }))
              }
              options={[
                { value: "DRAFT", label: "Draft" },
                { value: "READY_FOR_REVIEW", label: "Completed" },
                { value: "SENT_TO_CUSTOMER", label: "Sent" },
                { value: "ACCEPTED", label: "Closed" },
                { value: "REJECTED", label: "Lost" },
              ]}
            />
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pt-5 md:pt-0 md:items-end md:justify-end">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    activeTab === tab.id
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card variant="blue" padding="md" className="self-start">
          <CardHeader title="Quote summary" subtitle="Internal totals, pricing health, and save actions stay here." />
          <div className="space-y-3 text-sm">
            <SummaryRow label="Line items" value={String(lineItemCount)} />
            <SummaryRow label="Internal subtotal" value={money(internalSubtotal)} />
            <SummaryRow label="Customer subtotal" value={money(customerSubtotal)} />
            <div className="space-y-1">
              <Input
                label="Tax"
                type="number"
                min="0"
                step="0.01"
                value={quoteEditForm.taxAmount}
                onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))}
              />
            </div>
            <SummaryRow label="Total" value={money(totalAmount)} strong />
            <SummaryRow label="Est. profit" value={money(estimatedProfit)} tone={estimatedProfit >= 0 ? "good" : "bad"} />
            <SummaryRow label="Margin" value={`${estimatedMarginPercent.toFixed(1)}%`} tone={estimatedMarginPercent >= 10 ? "good" : "bad"} />
          </div>
          <div className="mt-4 grid gap-2">
            <Button fullWidth loading={saving} icon={<Save size={14} />} onClick={() => void handleSaveQuoteSheet()}>
              Save Quote Sheet
            </Button>
            <Button fullWidth variant="outline" onClick={() => navigateToBuilder(selectedQuote.customerId)}>
              Start Another Quote
            </Button>
            <p className="text-xs text-slate-500">Prepared on {formatDateTime(selectedQuote.createdAt)} · Sent {sentDateLabel}</p>
          </div>
        </Card>
      </div>

      {activeTab === "quote" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className={mobilePane === "preview" ? "hidden lg:block" : ""}>
            <QuoteSheetEditor
              title={quoteEditForm.title}
              onTitleChange={(value) => setQuoteEditForm((prev) => ({ ...prev, title: value }))}
              businessName={session?.tenantName ?? "QuoteFly"}
              customerName={customerName}
              customerHint={`${customerPhone}${customerEmail ? ` / ${customerEmail}` : ""}`}
              preparedDateLabel={formatDateTime(selectedQuote.createdAt)}
              sentDateLabel={sentDateLabel}
              overview={quoteEditForm.scopeText}
              onOverviewChange={(value) => setQuoteEditForm((prev) => ({ ...prev, scopeText: value }))}
              overviewPlaceholder="Optional overview shown near the top of the quote."
              actions={
                dirtyLineIds.length ? (
                  <Badge tone="amber">{dirtyLineIds.length} line edit{dirtyLineIds.length === 1 ? "" : "s"} pending</Badge>
                ) : (
                  <Badge tone="blue">Line editor live</Badge>
                )
              }
            >
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Common work names</p>
                    <p className="mt-1 text-sm text-slate-600">Load prior jobs into the new line row or insert them directly into the quote.</p>
                  </div>
                  {selectedPreset ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
                      <Button size="sm" variant="outline" onClick={() => loadPresetToNewLine(selectedPreset)}>
                        Load to new row
                      </Button>
                      <Button size="sm" onClick={() => void addPresetToQuote(selectedPreset)}>
                        Add to quote
                      </Button>
                    </div>
                  ) : null}
                </div>

                {presetLoadError ? <p className="mt-3 text-xs text-red-600">{presetLoadError}</p> : null}

                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {presetsLoading ? (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">Loading common work…</div>
                  ) : availablePresets.length ? (
                    availablePresets.slice(0, 10).map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedPresetId(preset.id)}
                        className={`min-w-fit rounded-xl border px-3 py-2 text-left transition ${
                          preset.id === selectedPresetId
                            ? "border-quotefly-blue/20 bg-white text-quotefly-blue"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        <p className="text-sm font-semibold">{preset.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{money(preset.unitPrice)} / {formatPresetUnitLabel(preset.unitType)}</p>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-sm text-slate-500">
                      No saved jobs for this trade yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_72px_96px_96px_110px_140px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                  <span>Line</span>
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Cost</span>
                  <span>Price</span>
                  <span>Total</span>
                  <span className="text-right">Actions</span>
                </div>
                {lineItemCount === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No saved lines yet" description="Add the first line below or load one from common work names." />
                  </div>
                ) : null}
                <div className="divide-y divide-slate-200">
                  {editableLines.map((line, index) => (
                    <ExistingLineEditorRow
                      key={line.id}
                      line={line}
                      index={index}
                      dirty={dirtyLineIds.includes(line.id)}
                      onChange={updateEditableLine}
                      onSave={saveLine}
                      onDelete={() => setLineItemPendingDeleteId(line.id)}
                    />
                  ))}
                </div>
              </div>

              <Card variant="default" padding="md">
                <CardHeader title="Add line" subtitle="Use this row to insert a new charge into the quote." />
                <NewLineEditorRow line={newLine} onChange={setNewLine} onAdd={addNewLine} saving={saving} />
              </Card>
            </QuoteSheetEditor>
          </div>

          <div className="space-y-5">
            <div className={mobilePane === "editor" ? "hidden lg:block" : ""}>
              <QuoteLivePreview
                businessName={session?.tenantName ?? "QuoteFly"}
                customerName={customerName}
                customerPhone={customerPhone}
                customerEmail={customerEmail}
                preparedDateLabel={formatDateTime(selectedQuote.createdAt)}
                sentDateLabel={sentDateLabel}
                quoteTitle={quoteEditForm.title}
                scopeText={quoteEditForm.scopeText}
                lines={previewLines}
                customerSubtotal={customerSubtotal}
                taxAmount={taxAmount}
                totalAmount={totalAmount}
              />
            </div>

            <Card variant="blue" padding="md" className={mobilePane === "editor" ? "hidden lg:block" : ""}>
              <CardHeader title="Customer-facing totals" subtitle="This is what the customer sees on the document." />
              <div className="space-y-3 text-sm">
                <SummaryRow label="Customer subtotal" value={money(customerSubtotal)} />
                <SummaryRow label="Tax" value={money(taxAmount)} />
                <SummaryRow label="Total" value={money(totalAmount)} strong />
              </div>
            </Card>

            <div className={`space-y-5 ${mobilePane === "preview" ? "hidden lg:block" : ""}`}>
              <QuickLookupCard
                title="Switch Customer or Quote"
                subtitle="Jump to another quote or start a fresh quote for an existing customer without leaving the quote desk."
                customerActionLabel="New Quote"
                customerActionVariant="outline"
                activeCustomerId={selectedQuote.customerId}
                activeQuoteId={selectedQuote.id}
                onCustomerAction={(customer) => {
                  setNotice(`${customer.fullName} is ready for a new quote.`);
                  navigateToBuilder(customer.id);
                }}
                onQuoteAction={(quote) => navigateToQuote(quote.id)}
              />

              <Card variant="default" padding="md">
                <CardHeader title="Quote status" subtitle="Move the quote forward without leaving the editor." />
                <div className="grid gap-2">
                  <Button variant="outline" onClick={() => void updateQuoteLifecycle(selectedQuote.id, { status: "SENT_TO_CUSTOMER" })}>
                    Mark sent
                  </Button>
                  <Button variant="outline" onClick={() => void updateQuoteLifecycle(selectedQuote.id, { status: "ACCEPTED" })}>
                    Mark closed / won
                  </Button>
                  <Button variant="outline" onClick={() => void updateQuoteLifecycle(selectedQuote.id, { status: "REJECTED" })}>
                    Mark lost
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "send" ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card variant="default" padding="md">
            <CardHeader title="Send the quote" subtitle="When the sheet is ready, open the customer’s app or export the PDF." />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Button variant="outline" icon={<Mail size={14} />} onClick={() => openSendComposer("email")} disabled={saving}>
                Email App
              </Button>
              <Button variant="outline" icon={<MessageSquare size={14} />} onClick={() => openSendComposer("sms")} disabled={saving}>
                Text App
              </Button>
              <Button variant="outline" icon={<FileOutput size={14} />} onClick={() => void downloadQuotePdf()} disabled={saving}>
                Download PDF
              </Button>
              <Button variant="secondary" icon={<Send size={14} />} onClick={() => void downloadQuotePdf({ afterSend: true })} disabled={saving}>
                Send + PDF
              </Button>
            </div>
          </Card>

          <Card variant="blue" padding="md">
            <CardHeader title="Send notes" subtitle="QuoteFly opens the user’s native apps so V1 does not need a paid send service." />
            <div className="space-y-2 text-sm text-slate-700">
              <p>Email and text actions mark the quote as sent and open the device’s app with the draft message.</p>
              <p>Sent date updates once the quote is marked sent.</p>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "history" ? (
        canViewQuoteHistory ? (
          <Card variant="default" padding="md">
            <CardHeader
              title="Revision history"
              subtitle="Track title, status, and pricing changes for this quote."
              actions={<Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>Refresh</Button>}
            />
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {(["quote", "customer", "all"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setHistoryMode(mode)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    historyMode === mode
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {mode === "quote" ? "Selected Quote" : mode === "customer" ? "By Customer" : "All Activity"}
                </button>
              ))}
              {historyMode === "customer" ? (
                <select
                  value={historyCustomerId}
                  onChange={(event) => setHistoryCustomerId(event.target.value)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700"
                >
                  <option value="ALL">Select customer...</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>{customer.fullName}</option>
                  ))}
                </select>
              ) : null}
            </div>
            {historyLoading ? (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">Loading history…</p>
            ) : quoteHistory.length === 0 ? (
              <EmptyState title="No history yet" description="History entries appear after the quote changes." />
            ) : (
              <div className="space-y-2">
                {quoteHistory.map((revision) => (
                  <div key={revision.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <HistoryEventPill eventType={revision.eventType} />
                        <QuoteStatusPill status={revision.status} compact />
                        <span className="text-sm font-semibold text-slate-900">{revision.title}</span>
                      </div>
                      <span className="text-xs text-slate-500">{formatDateTime(revision.createdAt)}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">v{revision.version} · Total {money(revision.totalAmount)}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <FeatureLockedCard
            title="Revision history"
            description="Revision history unlocks on Professional."
            currentPlanLabel={currentPlanLabel}
            requiredPlanLabel="Professional"
            showUpgradeHint={canAutoUpgradeMessage}
          />
        )
      ) : null}

      {activeTab === "log" ? (
        canViewCommunicationLog ? (
          <Card variant="default" padding="md">
            <CardHeader
              title="Send log"
              subtitle="Review email, text, and copy actions for this quote."
              actions={<Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>Refresh</Button>}
            />
            {outboundEventsLoading ? (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">Loading send log…</p>
            ) : outboundEvents.length === 0 ? (
              <EmptyState title="No send log yet" description="Send activity appears after an email, text, or copy action is confirmed." />
            ) : (
              <div className="space-y-2">
                {outboundEvents.map((event) => (
                  <div key={event.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <OutboundChannelPill channel={event.channel} />
                      <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      {event.destination ? `Destination: ${event.destination}` : "Destination not captured"}
                    </p>
                    {event.subject ? <p className="mt-1 text-xs text-slate-500">Subject: {event.subject}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <FeatureLockedCard
            title="Send log"
            description="Communication logs unlock on Professional."
            currentPlanLabel={currentPlanLabel}
            requiredPlanLabel="Professional"
            showUpgradeHint={canAutoUpgradeMessage}
          />
        )
      ) : null}

      <ConfirmModal
        open={lineItemPendingDeleteId !== null}
        onClose={() => setLineItemPendingDeleteId(null)}
        onConfirm={() => void confirmDeleteLineItem()}
        title="Delete line item"
        description="This removes the row from the quote and recalculates totals."
        confirmLabel="Delete line"
        loading={saving}
      />

      <SaveLinePresetModal
        open={Boolean(presetPromptLine)}
        line={presetPromptLine}
        saving={presetPromptSaving}
        onClose={dismissPresetPrompt}
        onSaveFull={() => void saveNewLineAsPreset(true)}
        onSaveNameOnly={() => void saveNewLineAsPreset(false)}
      />

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="xl" ariaLabel="Quote preview">
        <ModalHeader
          title="Quote preview"
          description="This is the customer-facing view of the active quote."
          onClose={() => setPreviewOpen(false)}
        />
        <ModalBody className="bg-slate-50">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            customerName={customerName}
            customerPhone={customerPhone}
            customerEmail={customerEmail}
            preparedDateLabel={formatDateTime(selectedQuote.createdAt)}
            sentDateLabel={sentDateLabel}
            quoteTitle={quoteEditForm.title}
            scopeText={quoteEditForm.scopeText}
            lines={previewLines}
            customerSubtotal={customerSubtotal}
            taxAmount={taxAmount}
            totalAmount={totalAmount}
          />
        </ModalBody>
      </Modal>

      {sendComposer ? (
        <Modal open={true} onClose={() => setSendComposer(null)} size="lg" ariaLabel="Send quote confirmation">
          <ModalHeader
            title={
              sendComposer.channel === "email"
                ? "Email Quote"
                : sendComposer.channel === "sms"
                  ? "Text Quote"
                  : "Copy Quote Message"
            }
            description={`Customer: ${sendComposer.customerName}`}
            onClose={() => setSendComposer(null)}
          />
          <ModalBody className="space-y-4">
            {sendComposer.channel === "email" ? (
              <Input
                label="Subject"
                value={sendComposer.subject}
                onChange={(event) =>
                  setSendComposer((prev) => (prev ? { ...prev, subject: event.target.value } : prev))
                }
              />
            ) : null}
            <Textarea
              label="Message"
              rows={8}
              value={sendComposer.body}
              onChange={(event) =>
                setSendComposer((prev) => (prev ? { ...prev, body: event.target.value } : prev))
              }
            />
            <div className="rounded-xl border border-quotefly-blue/15 bg-quotefly-blue/[0.05] px-3 py-3 text-sm text-slate-700">
              Confirming will mark the quote sent, log the action, and open the selected app.
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onClick={() => setSendComposer(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => { track("send_composer_confirm"); void confirmSendComposer(); }} loading={saving}>
              {sendComposer.channel === "copy" ? "Copy and Mark Sent" : "Open App and Mark Sent"}
            </Button>
          </ModalFooter>
        </Modal>
      ) : null}
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

function ExistingLineEditorRow({
  line,
  index,
  dirty,
  onChange,
  onSave,
  onDelete,
}: {
  line: EditableQuoteLine;
  index: number;
  dirty: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onSave: (lineId: string) => Promise<void>;
  onDelete: () => void;
}) {
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);

  return (
    <div className="px-4 py-4">
      <div className="lg:hidden">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Line {index + 1}</p>
            {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void onSave(line.id)} disabled={!dirty}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              Remove
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          <Input label="Line" value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} />
          <Textarea label="Description" rows={3} value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} />
          <div className="grid grid-cols-3 gap-2">
            <Input label="Qty" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
            <Input label="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
            <Input label="Price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900">
            Line total {money(lineTotal)}
          </div>
        </div>
      </div>

      <div className="hidden lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_72px_96px_96px_110px_140px] lg:items-start lg:gap-3">
        <Input value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} />
        <Textarea rows={2} className="min-h-[84px]" value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} />
        <Input type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
        <Input type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
        <Input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900">
          {money(lineTotal)}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void onSave(line.id)} disabled={!dirty}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewLineEditorRow({
  line,
  onChange,
  onAdd,
  saving,
}: {
  line: EditableQuoteLine;
  onChange: (line: EditableQuoteLine) => void;
  onAdd: () => Promise<void>;
  saving: boolean;
}) {
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_72px_96px_96px_110px]">
        <Input
          label="Line"
          placeholder="Service or job name"
          value={line.title}
          onChange={(event) => onChange({ ...line, title: event.target.value })}
        />
        <Textarea
          label="Description"
          rows={3}
          className="lg:min-h-[84px]"
          placeholder="Optional line description"
          value={line.details}
          onChange={(event) => onChange({ ...line, details: event.target.value })}
        />
        <Input label="Qty" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange({ ...line, quantity: event.target.value })} />
        <Input label="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange({ ...line, unitCost: event.target.value })} />
        <Input label="Price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange({ ...line, unitPrice: event.target.value })} />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-600">Total</label>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900">
            {money(lineTotal)}
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <Button icon={<Plus size={14} />} loading={saving} onClick={() => void onAdd()}>
          Add line to quote
        </Button>
      </div>
    </div>
  );
}

export default QuoteDeskView;

