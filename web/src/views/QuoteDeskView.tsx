import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  useDashboard,
  money,
  formatDateTime,
  SERVICE_TYPES,
  QUOTE_STATUSES,
} from "../components/dashboard/DashboardContext";
import {
  FeatureLockedCard,
  HistoryEventPill,
  OutboundChannelPill,
  QuoteMathSummaryPanel,
  QuoteStatusPill,
} from "../components/dashboard/DashboardUi";
import {
  CopyIcon,
  CustomerIcon,
  DeleteIcon,
  EmailIcon,
  InvoiceIcon,
  MessageIcon,
  PriceIcon,
  QuoteIcon,
  SendIcon,
} from "../components/Icons";
import {
  Alert,
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
import { usePageView, useTrack } from "../lib/analytics";

function formatPresetUnitLabel(unitType: WorkPreset["unitType"]): string {
  if (unitType === "SQ_FT") return "SQ FT";
  if (unitType === "HOUR") return "Hours";
  if (unitType === "EACH") return "Units";
  return "Qty";
}

export function QuoteDeskView() {
  usePageView("quote_desk");
  const track = useTrack();
  const [lineItemPendingDeleteId, setLineItemPendingDeleteId] = useState<string | null>(null);
  const [presetLibrary, setPresetLibrary] = useState<WorkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedPresetQuantity, setSelectedPresetQuantity] = useState("");
  const {
    selectedQuoteId,
    focusQuoteDesk,
    selectedQuote,
    selectedQuoteMath,
    quoteEditForm,
    setQuoteEditForm,
    lineItemForm,
    setLineItemForm,
    lineItemMath,
    saving,
    error,
    notice,
    setError,
    setNotice,
    saveQuote,
    sendDecision,
    updateQuoteLifecycle,
    openSendComposer,
    confirmSendComposer,
    downloadQuotePdf,
    addLineItem,
    addLineItemDraft,
    deleteLineItem,
    persistSelectedQuote,
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
        setPresetLoadError("Saved jobs could not be loaded.");
      })
      .finally(() => {
        if (mounted) setPresetsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const serviceOptions = SERVICE_TYPES.map((serviceType) => ({
    value: serviceType,
    label: formatServiceTypeLabel(serviceType),
  }));
  const statusOptions = QUOTE_STATUSES.map((status) => ({
    value: status,
    label: formatQuoteStatusLabel(status),
  }));
  const jobStatusOptions = [
    { value: "NOT_STARTED", label: formatJobStatusLabel("NOT_STARTED") },
    { value: "SCHEDULED", label: formatJobStatusLabel("SCHEDULED") },
    { value: "IN_PROGRESS", label: formatJobStatusLabel("IN_PROGRESS") },
    { value: "COMPLETED", label: formatJobStatusLabel("COMPLETED") },
  ];
  const afterSaleOptions = [
    { value: "NOT_READY", label: formatAfterSaleStatusLabel("NOT_READY") },
    { value: "DUE", label: formatAfterSaleStatusLabel("DUE") },
    { value: "COMPLETED", label: formatAfterSaleStatusLabel("COMPLETED") },
  ];

  const quoteMathWarning = useMemo(() => {
    if (!selectedQuoteMath || selectedQuoteMath.customerSubtotal <= 0) return undefined;
    if (selectedQuoteMath.estimatedProfit < 0) return "Current pricing is below cost.";
    if (selectedQuoteMath.estimatedMarginPercent < 10) return "Margin is below 10 percent.";
    return undefined;
  }, [selectedQuoteMath]);

  const activeServiceType = quoteEditForm.serviceType || selectedQuote?.serviceType || "HVAC";
  const availablePresets = useMemo(
    () =>
      presetLibrary
        .filter((preset) => preset.serviceType === activeServiceType)
        .sort((left, right) => {
          const leftIsStandard = Boolean(left.catalogKey);
          const rightIsStandard = Boolean(right.catalogKey);
          if (leftIsStandard !== rightIsStandard) return leftIsStandard ? -1 : 1;
          return left.name.localeCompare(right.name);
        }),
    [presetLibrary, activeServiceType],
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

  const selectedPresetQuantityValue = useMemo(() => {
    if (!selectedPreset) return 0;
    const parsed = Number(selectedPresetQuantity);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Number(selectedPreset.defaultQuantity);
    }
    return parsed;
  }, [selectedPreset, selectedPresetQuantity]);

  const selectedPresetCostTotal = selectedPreset ? selectedPresetQuantityValue * Number(selectedPreset.unitCost) : 0;
  const selectedPresetPriceTotal = selectedPreset ? selectedPresetQuantityValue * Number(selectedPreset.unitPrice) : 0;

  function applyPresetToLineItemForm() {
    if (!selectedPreset) return;
    setLineItemForm({
      description: selectedPreset.name,
      quantity: selectedPresetQuantityValue.toFixed(2).replace(/\.00$/, ""),
      unitCost: Number(selectedPreset.unitCost).toFixed(2),
      unitPrice: Number(selectedPreset.unitPrice).toFixed(2),
    });
    setNotice(`${selectedPreset.name} loaded into the line item form.`);
  }

  async function addPresetAsLineItem() {
    if (!selectedPreset) return;
    track("line_item_preset_add");
    await addLineItemDraft(
      {
        description: selectedPreset.name,
        quantity: selectedPresetQuantityValue,
        unitCost: Number(selectedPreset.unitCost),
        unitPrice: Number(selectedPreset.unitPrice),
      },
      {
        resetForm: false,
        notice: `${selectedPreset.name} added to the quote.`,
      },
    );
  }

  if (!selectedQuote) {
    return (
      <EmptyState
        icon={<QuoteIcon size={18} />}
        title="No quote selected"
        description="Select a quote from the Builder tab or create a new one."
      />
    );
  }

  const customerName = selectedQuote.customer?.fullName ?? selectedQuote.customerId;
  const customerPhone = selectedQuote.customer?.phone ?? "No phone yet";
  const customerEmail = selectedQuote.customer?.email ?? null;
  const lineItemCount = selectedQuote.lineItems?.length ?? 0;
  const afterSaleDueLabel = selectedQuote.afterSaleFollowUpDueAtUtc
    ? formatDateTime(selectedQuote.afterSaleFollowUpDueAtUtc)
    : "Not scheduled";

  async function confirmDeleteLineItem() {
    if (!lineItemPendingDeleteId) return;
    track("line_item_delete");
    await deleteLineItem(lineItemPendingDeleteId);
    setLineItemPendingDeleteId(null);
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Card variant="elevated" padding="lg">
        <PageHeader
          title={selectedQuote.title}
          subtitle="Review the scope, keep the numbers tight, and move the job forward from one screen."
          actions={<QuoteStatusPill status={selectedQuote.status} />}
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <HeaderMetaChip icon={<CustomerIcon size={13} />} label={customerName} />
          <HeaderMetaChip icon={<MessageIcon size={13} />} label={customerPhone} />
          {customerEmail ? <HeaderMetaChip icon={<EmailIcon size={13} />} label={customerEmail} /> : null}
          <HeaderMetaChip icon={<InvoiceIcon size={13} />} label={`Updated ${formatDateTime(selectedQuote.updatedAt)}`} />
        </div>

        {selectedQuoteMath && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DeskMetricCard
              icon={<PriceIcon size={16} />}
              label="Quote total"
              value={money(selectedQuoteMath.totalAmount)}
              tone="blue"
            />
            <DeskMetricCard
              icon={<InvoiceIcon size={16} />}
              label="Line items"
              value={String(lineItemCount)}
              tone="slate"
            />
            <DeskMetricCard
              icon={<QuoteIcon size={16} />}
              label="Est. profit"
              value={money(selectedQuoteMath.estimatedProfit)}
              tone={selectedQuoteMath.estimatedProfit >= 0 ? "emerald" : "rose"}
            />
            <DeskMetricCard
              icon={<SendIcon size={16} />}
              label="Margin"
              value={`${selectedQuoteMath.estimatedMarginPercent.toFixed(1)}%`}
              tone={selectedQuoteMath.estimatedMarginPercent >= 10 ? "emerald" : "amber"}
            />
          </div>
        )}
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_360px]">
        <div className="space-y-5">
          <Card padding="lg">
            <CardHeader
              title="Quote Details"
              subtitle="Keep the customer-facing scope clear while preserving the internal math behind the quote."
            />
            <form id="quote-desk-form" onSubmit={(event) => { track("quote_save"); void saveQuote(event); }} className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[1.1fr_1.1fr_0.8fr]">
                <Select
                  label="Trade"
                  value={quoteEditForm.serviceType}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as typeof prev.serviceType }))
                  }
                  options={serviceOptions}
                />
                <Select
                  label="Pipeline stage"
                  value={quoteEditForm.status}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, status: event.target.value as typeof prev.status }))
                  }
                  options={statusOptions}
                />
                <Input
                  label="Tax amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={quoteEditForm.taxAmount}
                  onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-[1fr_1fr_0.9fr]">
                <Select
                  label="Job stage"
                  value={quoteEditForm.jobStatus}
                  disabled={quoteEditForm.status !== "ACCEPTED"}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, jobStatus: event.target.value as typeof prev.jobStatus }))
                  }
                  options={jobStatusOptions}
                />
                <Select
                  label="After-sale follow-up"
                  value={quoteEditForm.afterSaleFollowUpStatus}
                  disabled={quoteEditForm.status !== "ACCEPTED"}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({
                      ...prev,
                      afterSaleFollowUpStatus: event.target.value as typeof prev.afterSaleFollowUpStatus,
                    }))
                  }
                  options={afterSaleOptions}
                />
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Follow-up due</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{afterSaleDueLabel}</p>
                </div>
              </div>

              <Input
                label="Quote title"
                value={quoteEditForm.title}
                onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Replace condenser and evaporator coil"
              />

              <Textarea
                label="Scope of work"
                rows={5}
                value={quoteEditForm.scopeText}
                onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, scopeText: event.target.value }))}
                placeholder="Describe the work, materials, exclusions, and completion notes."
              />

              {selectedQuoteMath && (
                <QuoteMathSummaryPanel summary={selectedQuoteMath} money={money} warning={quoteMathWarning} />
              )}
            </form>
          </Card>

          <Card padding="lg">
            <CardHeader
              title="Line Items"
              subtitle={`${lineItemCount} line item${lineItemCount === 1 ? "" : "s"} currently attached to this quote.`}
            />

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_360px]">
              <div className="space-y-3">
                {lineItemCount === 0 ? (
                  <EmptyState
                    icon={<InvoiceIcon size={18} />}
                    title="No line items yet"
                    description="Add labor, materials, or service charges so the quote math has usable structure."
                  />
                ) : (
                  (selectedQuote.lineItems ?? []).map((item) => {
                    const quantity = Number(item.quantity);
                    const unitCost = Number(item.unitCost);
                    const unitPrice = Number(item.unitPrice);
                    const lineTotal = quantity * unitPrice;
                    const lineProfit = quantity * (unitPrice - unitCost);

                    return (
                      <div key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{item.description}</p>
                            <div className="mt-3 grid gap-3 text-xs text-slate-600 sm:grid-cols-4">
                              <MiniMetric label="Qty" value={quantity.toString()} />
                              <MiniMetric label="Unit Cost" value={money(unitCost)} />
                              <MiniMetric label="Unit Price" value={money(unitPrice)} />
                              <MiniMetric
                                label="Line Profit"
                                value={money(lineProfit)}
                                valueClassName={lineProfit >= 0 ? "text-emerald-700" : "text-red-700"}
                              />
                            </div>
                            <p className="mt-3 text-sm font-semibold text-slate-900">Line total {money(lineTotal)}</p>
                          </div>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setLineItemPendingDeleteId(item.id)}
                            icon={<DeleteIcon size={12} />}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm font-semibold text-slate-900">Add Line Item</p>
                <p className="mt-1 text-xs text-slate-500">
                  Build labor, materials, and service charges with cost and sell price separated.
                </p>
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Saved Jobs</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Tap a standard or custom job to load it fast, then add it straight into this quote.
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
                    <div className="mt-3 space-y-2">
                      <div className="h-10 animate-pulse rounded-xl bg-slate-200" />
                      <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
                    </div>
                  ) : availablePresets.length === 0 ? (
                    <div className="mt-3">
                      <Alert tone="info">No saved jobs are ready for {formatServiceTypeLabel(activeServiceType)} yet. Add them in Setup first.</Alert>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                        {availablePresets.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => {
                              setSelectedPresetId(preset.id);
                              setSelectedPresetQuantity(String(Number(preset.defaultQuantity)));
                            }}
                            className={`min-w-[180px] rounded-2xl border px-3 py-2 text-left transition ${
                              preset.id === selectedPresetId
                                ? "border-quotefly-blue bg-quotefly-blue/10"
                                : "border-slate-200 bg-white"
                            }`}
                          >
                            <p className="text-sm font-semibold text-slate-900">{preset.name}</p>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-600">
                              {preset.description ?? "No default description yet."}
                            </p>
                          </button>
                        ))}
                      </div>

                      <div className="grid gap-3">
                        <Select
                          label="Saved job"
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
                      </div>

                      {selectedPreset ? (
                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-sm font-semibold text-slate-900">{selectedPreset.name}</p>
                          <p className="mt-1 text-xs text-slate-600">
                            {selectedPreset.description ?? "No default description yet."}
                          </p>
                          <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3 xl:grid-cols-1">
                            <MiniMetric
                              label="Default unit cost"
                              value={`${money(Number(selectedPreset.unitCost))} / ${formatPresetUnitLabel(selectedPreset.unitType)}`}
                            />
                            <MiniMetric
                              label="Default unit price"
                              value={`${money(Number(selectedPreset.unitPrice))} / ${formatPresetUnitLabel(selectedPreset.unitType)}`}
                            />
                            <MiniMetric
                              label="Applied totals"
                              value={`${money(selectedPresetCostTotal)} cost · ${money(selectedPresetPriceTotal)} price`}
                            />
                          </div>
                        </div>
                      ) : null}

                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <Button type="button" variant="outline" onClick={applyPresetToLineItemForm} disabled={!selectedPreset || saving}>
                          Load Into Form
                        </Button>
                        <Button type="button" onClick={() => void addPresetAsLineItem()} disabled={!selectedPreset || saving}>
                          Add Saved Job Now
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <form onSubmit={(event) => { track("line_item_add"); void addLineItem(event); }} className="mt-4 space-y-3">
                  <Input
                    label="Description"
                    placeholder="Install new condenser"
                    value={lineItemForm.description}
                    onChange={(event) => setLineItemForm((prev) => ({ ...prev, description: event.target.value }))}
                  />
                  <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                    <Input
                      label="Quantity"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="1"
                      value={lineItemForm.quantity}
                      onChange={(event) => setLineItemForm((prev) => ({ ...prev, quantity: event.target.value }))}
                    />
                    <Input
                      label="Unit cost"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={lineItemForm.unitCost}
                      onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitCost: event.target.value }))}
                    />
                    <Input
                      label="Unit price"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={lineItemForm.unitPrice}
                      onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitPrice: event.target.value }))}
                    />
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Draft line math</p>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600">
                      <MiniMetric label="Cost" value={money(lineItemMath.costTotal)} />
                      <MiniMetric label="Price" value={money(lineItemMath.priceTotal)} />
                      <MiniMetric
                        label="Profit"
                        value={money(lineItemMath.profit)}
                        valueClassName={lineItemMath.profit >= 0 ? "text-emerald-700" : "text-red-700"}
                      />
                    </div>
                  </div>

                  <Button type="submit" loading={saving} fullWidth>
                    Add Line Item
                  </Button>
                </form>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-5 xl:sticky xl:top-24 xl:self-start">
          <Card variant="blue" padding="lg">
            <CardHeader
              title="Operator Actions"
              subtitle="Save internal changes first, then move or send the quote."
            />

            <div className="rounded-2xl border border-white/60 bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Customer snapshot</p>
              <p className="mt-2 text-base font-semibold text-slate-900">{customerName}</p>
              <div className="mt-2 space-y-1 text-sm text-slate-600">
                <p className="inline-flex items-center gap-2">
                  <MessageIcon size={14} />
                  {customerPhone}
                </p>
                <p className="inline-flex items-center gap-2">
                  <EmailIcon size={14} />
                  {customerEmail ?? "Add customer email before sending by email"}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Internal actions</p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <Button type="button" loading={saving} onClick={() => void persistSelectedQuote()}>
                  Save Quote
                </Button>
                {selectedQuote.status !== "ACCEPTED" && (
                  <Button
                    type="button"
                    variant="success"
                    icon={<QuoteIcon size={14} />}
                    onClick={() => { track("quote_mark_won"); void updateQuoteLifecycle(selectedQuote.id, { status: "ACCEPTED" }); }}
                    disabled={saving}
                  >
                    Mark Won
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  icon={<SendIcon size={14} />}
                  onClick={() => { track("quote_mark_quoted"); void sendDecision("send"); }}
                  disabled={saving}
                >
                  Mark Quoted
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { track("quote_revise"); void sendDecision("revise"); }}
                  disabled={saving}
                >
                  Revise
                </Button>
                {selectedQuote.status === "ACCEPTED" && selectedQuote.jobStatus !== "IN_PROGRESS" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => { track("quote_job_in_progress"); void updateQuoteLifecycle(selectedQuote.id, { jobStatus: "IN_PROGRESS" }); }}
                    disabled={saving}
                  >
                    Start Job
                  </Button>
                )}
                {selectedQuote.status === "ACCEPTED" && selectedQuote.jobStatus !== "COMPLETED" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => { track("quote_job_complete"); void updateQuoteLifecycle(selectedQuote.id, { jobStatus: "COMPLETED" }); }}
                    disabled={saving}
                  >
                    Complete Job
                  </Button>
                )}
                {selectedQuote.status === "ACCEPTED" && selectedQuote.afterSaleFollowUpStatus === "DUE" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      track("quote_after_sale_complete");
                      void updateQuoteLifecycle(selectedQuote.id, { afterSaleFollowUpStatus: "COMPLETED" });
                    }}
                    disabled={saving}
                  >
                    Follow-Up Done
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Send and export</p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <Button
                  type="button"
                  variant="outline"
                  icon={<EmailIcon size={14} />}
                  onClick={() => { track("quote_email"); openSendComposer("email"); }}
                  disabled={saving}
                >
                  Email App
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  icon={<MessageIcon size={14} />}
                  onClick={() => { track("quote_sms"); openSendComposer("sms"); }}
                  disabled={saving}
                >
                  Text App
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  icon={<CopyIcon size={14} />}
                  onClick={() => { track("quote_copy"); openSendComposer("copy"); }}
                  disabled={saving}
                >
                  Copy Message
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  icon={<InvoiceIcon size={14} />}
                  onClick={() => { track("quote_pdf"); void downloadQuotePdf(); }}
                  disabled={saving}
                >
                  Download PDF
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  icon={<SendIcon size={14} />}
                  onClick={() => { track("quote_send_pdf"); void downloadQuotePdf({ afterSend: true }); }}
                  disabled={saving}
                >
                  Send + PDF
                </Button>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-blue-200 bg-white/80 px-3 py-3 text-xs text-slate-600">
              Email and text actions open the device apps after confirmation, so v1 does not require a paid messaging provider.
            </div>
          </Card>
        </div>
      </div>

      <div className="sticky bottom-16 z-20 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg sm:hidden">
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" loading={saving} onClick={() => void persistSelectedQuote()}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={() => void sendDecision("send")} disabled={saving}>
            Mark Quoted
          </Button>
          <Button size="sm" variant="outline" onClick={() => openSendComposer("email")} disabled={saving}>
            Email
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void downloadQuotePdf({ afterSend: true })} disabled={saving}>
            Send + PDF
          </Button>
        </div>
      </div>

      {canViewQuoteHistory ? (
        <Card padding="lg">
          <CardHeader
            title="Quote Revision History"
            subtitle="Track original values, revisions, and decision changes."
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
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {mode === "quote" ? "Selected Quote" : mode === "customer" ? "By Customer" : "All Activity"}
              </button>
            ))}
            {historyMode === "customer" && (
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
            )}
          </div>
          {historyLoading ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">Loading revision history...</p>
          ) : quoteHistory.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">No history entries for this filter yet.</p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-auto">
              {quoteHistory.map((revision) => (
                <div key={revision.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <HistoryEventPill eventType={revision.eventType} />
                      <QuoteStatusPill status={revision.status} compact />
                      <p className="text-sm font-semibold text-slate-900">{revision.title}</p>
                    </div>
                    <p className="text-xs text-slate-500">{formatDateTime(revision.createdAt)}</p>
                  </div>
                  <p className="mt-2 text-xs text-slate-600">
                    v{revision.version} / Customer: {revision.customer.fullName} / Total {money(revision.totalAmount)}
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

      {canViewCommunicationLog ? (
        <Card padding="lg">
          <CardHeader
            title="Send Activity"
            subtitle="Logged email, text, and copy actions for this quote."
            actions={<Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>Refresh</Button>}
          />
          {outboundEventsLoading ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">Loading send activity...</p>
          ) : outboundEvents.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">No send actions logged yet.</p>
          ) : (
            <div className="max-h-60 space-y-2 overflow-auto">
              {outboundEvents.map((event) => (
                <div key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <OutboundChannelPill channel={event.channel} />
                    <p className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</p>
                  </div>
                  <p className="mt-2 text-xs text-slate-600">
                    {event.destination ? `Destination: ${event.destination}` : "Destination not captured"}
                  </p>
                  {event.subject && <p className="mt-1 text-xs text-slate-500">Subject: {event.subject}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <FeatureLockedCard
          title="Communication Log"
          description="Email, text, and copy activity tracking unlocks on Professional."
          currentPlanLabel={currentPlanLabel}
          requiredPlanLabel="Professional"
          showUpgradeHint={canAutoUpgradeMessage}
        />
      )}

      <ConfirmModal
        open={lineItemPendingDeleteId !== null}
        onClose={() => setLineItemPendingDeleteId(null)}
        onConfirm={() => void confirmDeleteLineItem()}
        title="Delete line item"
        description="This removes the line item from the quote and recalculates the totals."
        confirmLabel="Delete line item"
        loading={saving}
      />

      {sendComposer && (
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
            {sendComposer.channel === "email" && (
              <Input
                label="Subject"
                value={sendComposer.subject}
                onChange={(event) =>
                  setSendComposer((prev) => (prev ? { ...prev, subject: event.target.value } : prev))
                }
              />
            )}
            <Textarea
              label="Message"
              rows={8}
              value={sendComposer.body}
              onChange={(event) =>
                setSendComposer((prev) => (prev ? { ...prev, body: event.target.value } : prev))
              }
            />
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-slate-700">
              Confirming will mark the quote as quoted, log the action, and open the selected app.
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onClick={() => setSendComposer(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => { track("send_composer_confirm"); void confirmSendComposer(); }} loading={saving}>
              {sendComposer.channel === "copy" ? "Copy and Mark Quoted" : "Open App and Mark Quoted"}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

function formatServiceTypeLabel(serviceType: string) {
  if (serviceType === "HVAC") return "HVAC";
  return serviceType.charAt(0) + serviceType.slice(1).toLowerCase();
}

function formatQuoteStatusLabel(status: string) {
  if (status === "READY_FOR_REVIEW") return "Ready for review";
  if (status === "SENT_TO_CUSTOMER") return "Quoted";
  if (status === "ACCEPTED") return "Won";
  if (status === "REJECTED") return "Lost";
  return "Draft";
}

function formatJobStatusLabel(status: string) {
  if (status === "NOT_STARTED") return "Not started";
  if (status === "IN_PROGRESS") return "In progress";
  return status.charAt(0) + status.slice(1).toLowerCase().replace("_", " ");
}

function formatAfterSaleStatusLabel(status: string) {
  if (status === "NOT_READY") return "Not ready";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function HeaderMetaChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
      <span className="text-quotefly-blue">{icon}</span>
      {label}
    </span>
  );
}

function DeskMetricCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "blue" | "emerald" | "amber" | "rose" | "slate";
}) {
  const toneClass =
    tone === "blue"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : tone === "emerald"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : tone === "amber"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : tone === "rose"
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-3 text-2xl font-bold">{value}</p>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-sm font-semibold text-slate-900 ${valueClassName ?? ""}`}>{value}</p>
    </div>
  );
}
