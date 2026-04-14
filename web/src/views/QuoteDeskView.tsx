import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Eye,
  FileOutput,
  Lock,
  Mail,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Send,
  Sparkles,
  Trash2,
  X,
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
import { QuoteAiPromptModal } from "../components/quotes/QuoteAiPromptModal";
import { QuoteSheetEditor } from "../components/quotes/QuoteSheetEditor";
import { SaveLinePresetModal } from "../components/quotes/SaveLinePresetModal";
import { WorkPresetPickerModal } from "../components/quotes/WorkPresetPickerModal";
import { buildQuoteFooterText, shouldShowQuoteFlyAttribution } from "../components/quotes/quote-footer";
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
import { api, type AiProgressEvent, type AiQuoteInsight, type AiQuoteRun, type QuoteRevision, type TenantBranding, type WorkPreset } from "../lib/api";
import { formatAiUsageAvailability, formatAiUsageNotice } from "../lib/ai-credits";
import { canNativePdfShareOnDevice } from "../lib/quote-pdf-actions";
import {
  applyAiQuoteLinePatch,
  buildPresetPayloadFromLine,
  isIncludedEditableQuoteLine,
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

function buildBusinessHint(branding: TenantBranding | null): string | undefined {
  if (!branding) return undefined;

  const location = [branding.city, branding.state].filter(Boolean).join(", ");
  const parts = [branding.businessPhone, branding.businessEmail, location].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  return parts.length ? parts.join(" / ") : undefined;
}

function resolveQuoteAccentColor(branding: TenantBranding | null): string {
  return branding?.componentColors?.headerBgColor ?? branding?.primaryColor ?? "#4F7FD2";
}

function buildDeskAiPromptStarters(
  serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
  customerName: string,
  customerPhone: string,
  quoteTitle: string,
) {
  const customerLead = `${customerName} ${customerPhone}`.trim();

  if (serviceType === "ROOFING") {
    return [
      `Revise ${quoteTitle} for ${customerLead}. Add permit fee, cleanup, and stronger customer-facing scope wording.`,
      `Update ${quoteTitle} for ${customerLead}. Include flashing, disposal, and warranty language.`,
    ];
  }

  if (serviceType === "HVAC") {
    return [
      `Revise ${quoteTitle} for ${customerLead}. Add startup testing, thermostat hookup, and cleanup.`,
      `Update ${quoteTitle} for ${customerLead}. Add haul-away, install materials, and a clearer customer overview.`,
    ];
  }

  return [
    `Revise ${quoteTitle} for ${customerLead}. Add any missing line items, tighten the scope, and keep the quote customer-friendly.`,
    `Update ${quoteTitle} for ${customerLead}. Make the quote clearer for the customer and add any missing job lines.`,
  ];
}

type DeskTab = "quote" | "send" | "history" | "log";
type DeskPane = "editor" | "preview";

export function QuoteDeskView() {
  usePageView("quote_desk");
  const track = useTrack();
  const navigate = useNavigate();
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
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiProgressEvent, setAiProgressEvent] = useState<AiProgressEvent | null>(null);
  const [aiInsight, setAiInsight] = useState<AiQuoteInsight | null>(null);
  const [aiRuns, setAiRuns] = useState<AiQuoteRun[]>([]);
  const [aiRunsLoading, setAiRunsLoading] = useState(false);
  const [unlockConfirmOpen, setUnlockConfirmOpen] = useState(false);
  const [quoteRetentionAction, setQuoteRetentionAction] = useState<"archive" | "delete" | null>(null);
  const [quoteRetentionSaving, setQuoteRetentionSaving] = useState(false);
  const [restoreRevisionTarget, setRestoreRevisionTarget] = useState<QuoteRevision | null>(null);
  const [restoreRevisionSaving, setRestoreRevisionSaving] = useState(false);
  const [isEditUnlocked, setIsEditUnlocked] = useState(true);
  const [mobilePane, setMobilePane] = useState<DeskPane>("editor");
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const canSharePdfFromDevice = useMemo(() => canNativePdfShareOnDevice(), []);
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
    canUseChatToQuote,
    chatPrompt,
    setChatPrompt,
    setChatParsed,
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
    loadAll,
    loadQuoteHistory,
    refreshSelectedQuote,
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
    if (!session?.tenantId) return;

    let mounted = true;
    api.branding
      .get(session.tenantId)
      .then((result) => {
        if (!mounted) return;
        setBranding(result.branding);
      })
      .catch(() => {
        if (!mounted) return;
        setBranding(null);
      });

    return () => {
      mounted = false;
    };
  }, [session?.tenantId]);

  useEffect(() => {
    if (!selectedQuote) {
      setEditableLines([]);
      setNewLine(makeEditableQuoteLine());
      setAiInsight(null);
      setAiRuns([]);
      return;
    }

    setEditableLines((selectedQuote.lineItems ?? []).map(toEditableQuoteLine));
    setNewLine(makeEditableQuoteLine());
    setMobilePane("editor");
    setAiInsight(null);
    setAiRuns([]);
  }, [selectedQuote?.id, selectedQuote?.updatedAt]);

  const requiresExplicitUnlock = useMemo(() => {
    if (!selectedQuote) return false;
    return ["SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"].includes(selectedQuote.status);
  }, [selectedQuote?.id, selectedQuote?.status]);

  useEffect(() => {
    setIsEditUnlocked(!requiresExplicitUnlock);
  }, [selectedQuote?.id, requiresExplicitUnlock]);

  useEffect(() => {
    if (activeTab !== "history" || !selectedQuote?.id) return;
    void loadAiRuns(selectedQuote.id);
  }, [activeTab, selectedQuote?.id]);

  async function loadAiRuns(targetQuoteId = selectedQuote?.id) {
    if (!targetQuoteId) {
      setAiRuns([]);
      return;
    }

    setAiRunsLoading(true);
    try {
      const { runs } = await api.quotes.getAiRuns(targetQuoteId, { limit: 8 });
      setAiRuns(runs);
    } catch (err) {
      setAiRuns([]);
      setError(err instanceof Error ? err.message : "Failed loading AI runs.");
    } finally {
      setAiRunsLoading(false);
    }
  }

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
          original.sectionType !== line.sectionType ||
          original.sectionLabel !== line.sectionLabel ||
          original.quantity !== line.quantity ||
          original.unitCost !== line.unitCost ||
          original.unitPrice !== line.unitPrice
        );
      })
      .map((line) => line.id);
  }, [editableLines, originalLineMap]);

  const lineItemCount = editableLines.length;
  const includedEditableLines = useMemo(
    () => editableLines.filter((line) => isIncludedEditableQuoteLine(line)),
    [editableLines],
  );
  const internalSubtotal = useMemo(
    () => includedEditableLines.reduce((total, line) => total + quoteLineCostTotal(line.quantity, line.unitCost), 0),
    [includedEditableLines],
  );
  const customerSubtotal = useMemo(
    () => includedEditableLines.reduce((total, line) => total + quoteLineAmount(line.quantity, line.unitPrice), 0),
    [includedEditableLines],
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
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: quoteLineAmount(line.quantity, line.unitPrice),
    })),
    [editableLines],
  );
  const businessHint = useMemo(() => buildBusinessHint(branding), [branding]);
  const quoteAccentColor = useMemo(() => resolveQuoteAccentColor(branding), [branding]);
  const quoteFooterText = useMemo(
    () =>
      buildQuoteFooterText({
        businessName: session?.tenantName ?? "QuoteFly",
        businessPhone: branding?.businessPhone ?? null,
        businessEmail: branding?.businessEmail ?? null,
      }),
    [branding?.businessEmail, branding?.businessPhone, session?.tenantName],
  );
  const showQuoteFlyAttribution = useMemo(
    () => shouldShowQuoteFlyAttribution(session?.effectivePlanCode, branding?.hideQuoteFlyAttribution),
    [branding?.hideQuoteFlyAttribution, session?.effectivePlanCode],
  );
  const selectedQuoteTitle = selectedQuote?.title ?? "Current quote";
  const aiUsageHint = useMemo(
    () =>
      formatAiUsageAvailability({
        usedUsd: session?.usage?.monthlyAiSpendUsd,
        limitUsd: session?.entitlements?.limits.aiSpendUsdPerMonth,
        estimatedPromptsRemaining: session?.usage?.monthlyAiEstimatedPromptsRemaining,
        renewsAtUtc: session?.usage?.periodEndUtc,
      }),
    [
      session?.entitlements?.limits.aiSpendUsdPerMonth,
      session?.usage?.monthlyAiSpendUsd,
      session?.usage?.monthlyAiEstimatedPromptsRemaining,
      session?.usage?.periodEndUtc,
    ],
  );
  const aiPromptStarters = useMemo(
    () =>
      buildDeskAiPromptStarters(
        quoteEditForm.serviceType,
        customerName,
        customerPhone,
        quoteEditForm.title || selectedQuoteTitle,
      ),
    [customerName, customerPhone, quoteEditForm.serviceType, quoteEditForm.title, selectedQuoteTitle],
  );
  const isQuoteLocked = requiresExplicitUnlock && !isEditUnlocked;
  const metadataDirty = useMemo(() => {
    if (!selectedQuote) return false;
    return (
      quoteEditForm.serviceType !== selectedQuote.serviceType ||
      quoteEditForm.status !== selectedQuote.status ||
      quoteEditForm.jobStatus !== selectedQuote.jobStatus ||
      quoteEditForm.afterSaleFollowUpStatus !== selectedQuote.afterSaleFollowUpStatus ||
      quoteEditForm.title !== selectedQuote.title ||
      quoteEditForm.scopeText !== selectedQuote.scopeText ||
      String(Number(quoteEditForm.taxAmount)) !== String(Number(selectedQuote.taxAmount))
    );
  }, [quoteEditForm, selectedQuote]);
  const hasDraftNewLine = useMemo(
    () =>
      Boolean(
        newLine.title.trim() ||
          newLine.details.trim() ||
          String(newLine.quantity) !== "1" ||
          String(newLine.unitCost) !== "0" ||
          String(newLine.unitPrice) !== "0",
      ),
    [newLine],
  );
  const hasUnsavedQuoteSheetChanges = metadataDirty || dirtyLineIds.length > 0 || hasDraftNewLine;

  function updateEditableLine(lineId: string, field: keyof EditableQuoteLine, value: string) {
    setEditableLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
    );
  }

  async function saveLine(lineId: string) {
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
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
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel || null,
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
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
    if (!newLine.title.trim()) {
      setError("Add a line title before inserting a new row.");
      return;
    }

    const lineToMaybeSave = newLine;
    track("quote_line_add");
    await addLineItemDraft(
      {
        description: joinQuoteLineDescription(lineToMaybeSave.title, lineToMaybeSave.details),
        sectionType: lineToMaybeSave.sectionType,
        sectionLabel: lineToMaybeSave.sectionLabel || null,
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
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
    track("quote_sheet_save");
    await persistSelectedQuote();
    if (dirtyLineIds.length) {
      await saveAllLineEdits();
    }
  }

  async function handleAiSuggestSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedQuote) {
      setError("Open a quote before using AI suggestions.");
      return;
    }

    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }

    if (!canUseChatToQuote) {
      setError("AI drafting is not available on this workspace.");
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setError("Enter a prompt before generating a quote.");
      return;
    }

    track("quote_desk_ai_modal_submit");
    try {
      setAiSubmitting(true);
      setAiProgressEvent(null);
      const { customer, parsed, suggestion, patch, insight, usage } = await api.quotes.suggestWithAi({
        prompt,
        quoteId: selectedQuote.id,
        customerId: selectedQuote.customerId,
        serviceType: quoteEditForm.serviceType,
        currentTitle: quoteEditForm.title || undefined,
        currentScopeText: quoteEditForm.scopeText || undefined,
        currentLineItems: editableLines.map((line) => ({
          id: line.id,
          description: joinQuoteLineDescription(line.title, line.details),
          sectionType: line.sectionType,
          sectionLabel: line.sectionLabel || null,
          quantity: Number(line.quantity) || 1,
          unitCost: Number(line.unitCost) || 0,
          unitPrice: Number(line.unitPrice) || 0,
        })),
      }, {
        onProgress: setAiProgressEvent,
      });

      setChatParsed(parsed);
      setChatPrompt("");
      setQuoteEditForm((prev) => ({
        ...prev,
        serviceType: suggestion.serviceType,
        title: suggestion.title,
        scopeText: suggestion.scopeText,
        taxAmount: String(suggestion.taxAmount),
      }));
      setEditableLines((current) => applyAiQuoteLinePatch(current, patch));
      setNewLine(makeEditableQuoteLine());
      setAiInsight(insight);
      void loadAiRuns(selectedQuote.id);
      setAiModalOpen(false);
      setMobilePane("editor");
      const usageSummary = formatAiUsageNotice(usage);
      const patchSummary = [
        patch.updated ? `updated ${patch.updated}` : null,
        patch.added ? `added ${patch.added}` : null,
        patch.removed ? `removed ${patch.removed}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setNotice(
        `AI suggestion applied for ${customer?.fullName ?? parsed.customerName ?? customerName}. ${patchSummary ? `${patchSummary}. ` : ""}${usageSummary} Review the sheet, then save tracked edits.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed applying AI suggestion.");
    } finally {
      setAiSubmitting(false);
      setAiProgressEvent(null);
    }
  }

  function handleUnlockEditing() {
    setIsEditUnlocked(true);
    setUnlockConfirmOpen(false);
    setNotice("Quote unlocked. Any saved edits will be tracked in history.");
  }

  async function confirmRestoreRevision() {
    if (!selectedQuote || !restoreRevisionTarget) return;
    setRestoreRevisionSaving(true);
    setError(null);
    try {
      const result = await api.quotes.restoreRevision(selectedQuote.id, restoreRevisionTarget.id);
      await Promise.all([refreshSelectedQuote(), loadQuoteHistory()]);
      void loadAiRuns(selectedQuote.id);
      setRestoreRevisionTarget(null);
      setAiInsight(null);
      setMobilePane("editor");
      setNotice(`${result.quote.title} restored to revision v${restoreRevisionTarget.version}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed restoring the selected revision.");
    } finally {
      setRestoreRevisionSaving(false);
    }
  }

  function revertQuoteSheetToLastSaved() {
    if (!selectedQuote) return;
    setQuoteEditForm({
      serviceType: selectedQuote.serviceType,
      status: selectedQuote.status,
      jobStatus: selectedQuote.jobStatus,
      afterSaleFollowUpStatus: selectedQuote.afterSaleFollowUpStatus,
      title: selectedQuote.title,
      scopeText: selectedQuote.scopeText,
      taxAmount: String(Number(selectedQuote.taxAmount)),
    });
    setEditableLines((selectedQuote.lineItems ?? []).map(toEditableQuoteLine));
    setNewLine(makeEditableQuoteLine());
    setPresetPromptLine(null);
    setNotice("Reverted to the last saved quote version.");
  }

  function loadPresetToNewLine(preset: WorkPreset) {
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
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
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
    track("quote_line_preset_add");
    await addLineItemDraft(
      {
        description: joinQuoteLineDescription(preset.name, preset.description ?? ""),
        sectionType: "INCLUDED",
        sectionLabel: null,
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

  async function confirmQuoteRetentionAction() {
    if (!selectedQuote || !quoteRetentionAction) return;

    setQuoteRetentionSaving(true);
    setError(null);

    try {
      if (quoteRetentionAction === "archive") {
        await api.quotes.archive(selectedQuote.id);
        setNotice(`Archived ${selectedQuote.title}. The quote and its history were retained.`);
      } else {
        await api.quotes.delete(selectedQuote.id);
        setNotice(`Deleted ${selectedQuote.title}. The quote and its history were retained.`);
      }

      setQuoteRetentionAction(null);
      await loadAll();
      navigate("/app/quotes");
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${quoteRetentionAction} the quote.`);
    } finally {
      setQuoteRetentionSaving(false);
    }
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
            <QuoteStatusPill status={selectedQuote.status} />
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {aiInsight ? (
        <div className="rounded-lg border border-quotefly-blue/20 bg-quotefly-blue/[0.05] px-4 py-3 text-sm text-slate-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">Why AI suggested this</p>
              <p className="mt-1 font-medium text-slate-900">{aiInsight.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => setAiInsight(null)}
              className="self-start min-h-[44px] rounded-lg px-2 text-xs font-medium text-slate-500 hover:text-slate-700 sm:min-h-[36px]"
            >
              Dismiss
            </button>
          </div>
          {aiInsight.reasons.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {aiInsight.reasons.map((reason) => (
                <Badge key={reason} tone="blue">{reason}</Badge>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={aiInsight.confidence.level === "high" ? "emerald" : aiInsight.confidence.level === "medium" ? "amber" : "red"}>
              {aiInsight.confidence.label}
            </Badge>
            {aiInsight.riskNote ? <span className="text-xs text-slate-600">{aiInsight.riskNote}</span> : null}
          </div>
          {aiInsight.sources.length ? (
            <p className="mt-2 text-xs text-slate-500">
              Context used: {aiInsight.sources.map((source) => source.label).join(" • ")}
            </p>
          ) : null}
        </div>
      ) : null}

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
              className={`flex-1 rounded-full border px-4 py-2 text-sm font-medium transition min-h-[44px] ${
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

      <div className="-mx-1 flex flex-wrap items-center gap-2 overflow-x-auto px-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition min-h-[44px] ${
              activeTab === tab.id
                ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-quotefly-blue"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {isQuoteLocked ? (
          <Badge tone="amber" icon={<Lock size={12} />}>
            Locked until you unlock edits
          </Badge>
        ) : null}
      </div>

      {activeTab === "quote" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className={mobilePane === "preview" ? "hidden lg:block" : ""}>
            <QuoteSheetEditor
              title={quoteEditForm.title}
              onTitleChange={(value) => setQuoteEditForm((prev) => ({ ...prev, title: value }))}
              businessName={session?.tenantName ?? "QuoteFly"}
              businessHint={businessHint}
              customerName={customerName}
              customerHint={`${customerPhone}${customerEmail ? ` / ${customerEmail}` : ""}`}
              preparedDateLabel={formatDateTime(selectedQuote.createdAt)}
              sentDateLabel={sentDateLabel}
              overview={quoteEditForm.scopeText}
              onOverviewChange={(value) => setQuoteEditForm((prev) => ({ ...prev, scopeText: value }))}
              overviewPlaceholder="Optional overview shown near the top of the quote."
              logoUrl={branding?.logoUrl ?? null}
              logoPosition={branding?.logoPosition ?? "left"}
              templateId={branding?.templateId ?? "modern"}
              accentColor={quoteAccentColor}
              componentColors={branding?.componentColors ?? null}
              footerText={quoteFooterText}
              showQuoteFlyAttribution={showQuoteFlyAttribution}
              readOnly={isQuoteLocked}
              actions={
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="md"
                    className="h-11 w-11 min-h-[44px] rounded-full border-0 p-0 text-quotefly-blue hover:bg-transparent active:bg-transparent lg:hidden"
                    icon={<Sparkles size={18} />}
                    onClick={() => {
                      if (isQuoteLocked) {
                        setUnlockConfirmOpen(true);
                        return;
                      }
                      setAiModalOpen(true);
                    }}
                    disabled={!canUseChatToQuote}
                    aria-label="AI Prompt"
                    title="AI Prompt"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="hidden lg:inline-flex"
                    icon={<Sparkles size={14} />}
                    onClick={() => {
                      if (isQuoteLocked) {
                        setUnlockConfirmOpen(true);
                        return;
                      }
                      setAiModalOpen(true);
                    }}
                    disabled={!canUseChatToQuote}
                  >
                    AI Prompt
                  </Button>
                  <Button variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                    Preview
                  </Button>
                  {isQuoteLocked ? (
                    <Button variant="outline" size="sm" icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                      Unlock to edit
                    </Button>
                  ) : hasUnsavedQuoteSheetChanges ? (
                    <Badge tone="amber">Unsaved edits</Badge>
                  ) : (
                    <Badge tone="blue">Line editor live</Badge>
                  )}
                </div>
              }
            >
              {isQuoteLocked ? (
                <Alert tone="warning">
                  This quote is locked because it has already been sent or closed. Unlock it to edit. All saved changes will be tracked.
                </Alert>
              ) : null}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Common work names</p>
                    <p className="mt-1 text-sm text-slate-600">Load prior jobs into the new line row or insert them directly into the quote.</p>
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
                          disabled={isQuoteLocked}
                        />
                      </div>
                      <Button size="sm" variant="outline" onClick={() => loadPresetToNewLine(selectedPreset)} disabled={isQuoteLocked}>
                        Load to new row
                      </Button>
                      <Button size="sm" onClick={() => void addPresetToQuote(selectedPreset)} disabled={isQuoteLocked}>
                        Add to quote
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
                    <div className="mt-3 grid gap-2">
                      <Input
                        label={formatPresetUnitLabel(selectedPreset.unitType)}
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={selectedPresetQuantity}
                        onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                        disabled={isQuoteLocked}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="outline" onClick={() => loadPresetToNewLine(selectedPreset)} disabled={isQuoteLocked}>
                          Load row
                        </Button>
                        <Button size="sm" onClick={() => void addPresetToQuote(selectedPreset)} disabled={isQuoteLocked}>
                          Add to quote
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 hidden gap-2 overflow-x-auto pb-1 lg:flex">
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
                    startExpanded={dirtyLineIds.includes(line.id)}
                    readOnly={isQuoteLocked}
                    onChange={updateEditableLine}
                    onSave={saveLine}
                    onDelete={() => setLineItemPendingDeleteId(line.id)}
                    />
                  ))}
                  <div className="px-4 py-4">
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Add line</p>
                          <p className="mt-1 text-sm text-slate-600">
                            {isQuoteLocked
                              ? "Unlock the quote to add new rows."
                              : "Keep adding rows directly in the quote sheet."}
                          </p>
                        </div>
                      </div>
                      <NewLineEditorRow line={newLine} onChange={setNewLine} onAdd={addNewLine} saving={saving} readOnly={isQuoteLocked} />
                    </div>
                  </div>
                </div>
              </div>
            </QuoteSheetEditor>
          </div>

          <div className="space-y-5">
            <div className={mobilePane === "preview" ? "block lg:hidden" : "hidden"}>
              <QuoteLivePreview
                businessName={session?.tenantName ?? "QuoteFly"}
                businessHint={businessHint}
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
                logoUrl={branding?.logoUrl ?? null}
                logoPosition={branding?.logoPosition ?? "left"}
                templateId={branding?.templateId ?? "modern"}
                accentColor={quoteAccentColor}
                componentColors={branding?.componentColors ?? null}
                footerText={quoteFooterText}
                showQuoteFlyAttribution={showQuoteFlyAttribution}
              />
            </div>

            <Card variant="blue" padding="md" className={mobilePane === "editor" ? "hidden lg:block" : ""}>
              <CardHeader
                title="Quote actions"
                subtitle="Use the same control rail whether you are opening, reviewing, or editing a quote."
              />
              <div className="mb-4 space-y-3">
                <Select
                  label="Trade"
                  value={quoteEditForm.serviceType}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as typeof prev.serviceType }))
                  }
                  disabled={isQuoteLocked}
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
                  disabled={isQuoteLocked}
                  options={[
                    { value: "DRAFT", label: "Draft" },
                    { value: "READY_FOR_REVIEW", label: "Completed" },
                    { value: "SENT_TO_CUSTOMER", label: "Sent" },
                    { value: "ACCEPTED", label: "Closed" },
                    { value: "REJECTED", label: "Lost" },
                  ]}
                />
              </div>
              <div className="space-y-3 text-sm">
                <SummaryRow label="Line items" value={String(lineItemCount)} />
                <SummaryRow label="Customer subtotal" value={money(customerSubtotal)} />
                <div className="space-y-1">
                  <Input
                    label="Tax"
                    type="number"
                    min="0"
                    step="0.01"
                    value={quoteEditForm.taxAmount}
                    onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))}
                    disabled={isQuoteLocked}
                  />
                </div>
                <SummaryRow label="Total" value={money(totalAmount)} strong />
                <SummaryRow label="Internal subtotal" value={money(internalSubtotal)} />
                <SummaryRow label="Est. profit" value={money(estimatedProfit)} tone={estimatedProfit >= 0 ? "good" : "bad"} />
                <SummaryRow label="Margin" value={`${estimatedMarginPercent.toFixed(1)}%`} tone={estimatedMarginPercent >= 10 ? "good" : "bad"} />
              </div>
              <div className="mt-4 space-y-2 text-sm text-slate-700">
                <ChecklistItem compact complete={Boolean(selectedQuote.customerId)} label="Customer attached" />
                <ChecklistItem compact complete={Boolean(quoteEditForm.title.trim())} label="Quote title present" />
                <ChecklistItem compact complete={lineItemCount > 0} label={`${lineItemCount} line${lineItemCount === 1 ? "" : "s"} in quote`} />
              </div>
              {isQuoteLocked ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  This quote is currently locked because it has already been sent or closed.
                </div>
              ) : null}
              <div className="mt-4 grid gap-2">
                {isQuoteLocked ? (
                  <Button fullWidth icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                    Unlock to Edit
                  </Button>
                ) : (
                  <Button fullWidth loading={saving} icon={<Save size={14} />} onClick={() => void handleSaveQuoteSheet()}>
                    Save Quote Sheet
                  </Button>
                )}
                <div className="grid gap-2 lg:hidden">
                  <Button fullWidth variant="outline" onClick={() => navigateToBuilder(selectedQuote.customerId)}>
                    Start Another Quote
                  </Button>
                  <details className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <summary className="cursor-pointer list-none text-sm font-semibold text-slate-700">
                      More actions
                    </summary>
                    <div className="mt-3 grid gap-2">
                      <Button
                        fullWidth
                        variant="outline"
                        icon={<RotateCcw size={14} />}
                        onClick={revertQuoteSheetToLastSaved}
                        disabled={!hasUnsavedQuoteSheetChanges}
                      >
                        Revert to Last Saved
                      </Button>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          fullWidth
                          variant="warning"
                          icon={<Archive size={14} />}
                          onClick={() => setQuoteRetentionAction("archive")}
                        >
                          Archive
                        </Button>
                        <Button
                          fullWidth
                          variant="danger"
                          icon={<Trash2 size={14} />}
                          onClick={() => setQuoteRetentionAction("delete")}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </details>
                </div>
                <div className="hidden gap-2 lg:grid">
                  <Button fullWidth variant="outline" icon={<RotateCcw size={14} />} onClick={revertQuoteSheetToLastSaved} disabled={!hasUnsavedQuoteSheetChanges}>
                    Revert to Last Saved
                  </Button>
                  <Button fullWidth variant="outline" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                    Preview PDF
                  </Button>
                  <Button fullWidth variant="outline" onClick={() => navigateToBuilder(selectedQuote.customerId)}>
                    Start Another Quote
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      fullWidth
                      variant="warning"
                      icon={<Archive size={14} />}
                      onClick={() => setQuoteRetentionAction("archive")}
                    >
                      Archive
                    </Button>
                    <Button
                      fullWidth
                      variant="danger"
                      icon={<Trash2 size={14} />}
                      onClick={() => setQuoteRetentionAction("delete")}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-500">Prepared on {formatDateTime(selectedQuote.createdAt)} - Sent {sentDateLabel}</p>
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

      {activeTab === "quote" ? (
        <div className="lg:hidden">
          <div className="h-24" />
          <div className="fixed inset-x-4 bottom-20 z-40 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span>{lineItemCount} line{lineItemCount === 1 ? "" : "s"}</span>
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
              {isQuoteLocked ? (
                <Button icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                  Unlock
                </Button>
              ) : (
                <Button loading={saving} icon={<Save size={14} />} onClick={() => void handleSaveQuoteSheet()}>
                  Save Quote
                </Button>
              )}
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
              <p>Email and text actions use the native share sheet with the PDF attached on supported phones.</p>
              <p>If file sharing is not available, QuoteFly falls back to the device app and you can attach the downloaded PDF manually.</p>
              <p>Sent date updates once the quote is marked sent.</p>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "history" ? (
        <Card variant="default" padding="md">
          <CardHeader
            title="History"
            subtitle="Review AI runs and quote revisions from one audit surface."
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadAiRuns(selectedQuote.id)}>Refresh AI Runs</Button>
                {canViewQuoteHistory ? (
                  <Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>Refresh Revisions</Button>
                ) : null}
              </div>
            }
          />

          <div className="space-y-5">
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">AI runs</p>
                  <p className="mt-1 text-sm text-slate-600">Inspect prompts, context quality, and AI cost for this quote.</p>
                </div>
              </div>

              {aiRunsLoading ? (
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">Loading AI runs…</p>
              ) : aiRuns.length === 0 ? (
                <EmptyState title="No AI runs yet" description="AI prompt history appears here after draft or revise actions." />
              ) : (
                <div className="space-y-2">
                  {aiRuns.map((run) => (
                    <div key={run.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={run.eventType === "REVISE" ? "orange" : "blue"}>{run.eventType === "REVISE" ? "AI Revise" : "AI Draft"}</Badge>
                          {run.confidenceLabel ? (
                            <Badge tone={run.confidenceLevel === "high" ? "emerald" : run.confidenceLevel === "medium" ? "amber" : "red"}>
                              {run.confidenceLabel}
                            </Badge>
                          ) : null}
                          {typeof run.patchAdded === "number" || typeof run.patchUpdated === "number" || typeof run.patchRemoved === "number" ? (
                            <span className="text-xs text-slate-500">
                              {run.patchUpdated ?? 0} updated • {run.patchAdded ?? 0} added • {run.patchRemoved ?? 0} removed
                            </span>
                          ) : null}
                        </div>
                        <span className="text-xs text-slate-500">{formatDateTime(run.createdAt)}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{run.insightSummary || "AI prepared a quote update."}</p>
                      <p className="mt-1 text-sm text-slate-600">{run.promptText}</p>
                      {run.riskNote ? <p className="mt-2 text-xs text-slate-600">{run.riskNote}</p> : null}
                      {run.insightReasons.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {run.insightReasons.map((reason) => (
                            <Badge key={`${run.id}-${reason}`} tone="blue">{reason}</Badge>
                          ))}
                        </div>
                      ) : null}
                      {run.insightSourceLabels.length ? (
                        <p className="mt-2 text-xs text-slate-500">
                          Context used: {run.insightSourceLabels.join(" • ")}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <span>By {run.actorName || run.actorEmail || "Unknown"}</span>
                        <span>
                          {run.totalTokens ? `${run.totalTokens.toLocaleString()} tokens` : "Tokens not captured"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Revision history</p>
                  <p className="mt-1 text-sm text-slate-600">Track title, status, and pricing changes for this quote.</p>
                </div>
              </div>

              {canViewQuoteHistory ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {(["quote", "customer", "all"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setHistoryMode(mode)}
                        className={`min-h-[44px] rounded-full border px-3 py-2 text-xs font-semibold transition sm:min-h-[36px] sm:py-1 ${
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
                        className="min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 sm:min-h-[36px] sm:py-1"
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
                            <div className="flex flex-wrap items-center gap-2">
                              {selectedQuote && revision.quote.id === selectedQuote.id ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  icon={<RotateCcw size={13} />}
                                  onClick={() => setRestoreRevisionTarget(revision)}
                                >
                                  Restore
                                </Button>
                              ) : null}
                              <span className="text-xs text-slate-500">{formatDateTime(revision.createdAt)}</span>
                            </div>
                          </div>
                          <p className="mt-2 text-xs text-slate-600">
                            v{revision.version} - Total {money(revision.totalAmount)} - By {revision.actorName || revision.actorEmail || "Unknown"}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <FeatureLockedCard
                  title="Revision history"
                  description="Revision history unlocks on Professional."
                  currentPlanLabel={currentPlanLabel}
                  requiredPlanLabel="Professional"
                  showUpgradeHint={canAutoUpgradeMessage}
                />
              )}
            </section>
          </div>
        </Card>
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
                    <p className="mt-1 text-xs text-slate-500">
                      By {event.actorName || event.actorEmail || "Unknown"}
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

      <ConfirmModal
        open={unlockConfirmOpen}
        onClose={() => setUnlockConfirmOpen(false)}
        onConfirm={handleUnlockEditing}
        title="Unlock quote for editing"
        description="This quote has already been sent or closed. If you unlock it and save changes, the update will be tracked in quote history."
        confirmLabel="Unlock quote"
        confirmVariant="warning"
      >
        <div className="space-y-2 text-sm text-slate-600">
          <p>Use this when you need to revise a sent quote, correct pricing, or update scope after the customer has already seen it.</p>
          <p>Revert only resets unsaved edits in the current session. Saved changes remain in the audit trail.</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={quoteRetentionAction !== null}
        onClose={() => setQuoteRetentionAction(null)}
        onConfirm={() => void confirmQuoteRetentionAction()}
        title={quoteRetentionAction === "archive" ? "Archive quote" : "Delete quote"}
        description={
          quoteRetentionAction === "archive"
            ? "This hides the quote from active views but retains it in the database and audit history."
            : "This removes the quote from active views but retains it in the database and audit history."
        }
        confirmLabel={quoteRetentionAction === "archive" ? "Archive quote" : "Delete quote"}
        confirmVariant={quoteRetentionAction === "archive" ? "warning" : "danger"}
        loading={quoteRetentionSaving}
      >
        <div className="space-y-2 text-sm text-slate-600">
          <p>
            {quoteRetentionAction === "archive"
              ? "Archived quotes stay retained for audit purposes and can be referenced later."
              : "Deleted quotes stay retained for audit purposes, but they are removed from active workflow views."}
          </p>
          <p>All existing quote history remains stored.</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={restoreRevisionTarget !== null}
        onClose={() => setRestoreRevisionTarget(null)}
        onConfirm={() => void confirmRestoreRevision()}
        title="Restore quote revision"
        description="This will replace the current quote sheet with the selected saved revision and track the restore in history."
        confirmLabel={restoreRevisionTarget ? `Restore v${restoreRevisionTarget.version}` : "Restore revision"}
        confirmVariant="warning"
        loading={restoreRevisionSaving}
      >
        {restoreRevisionTarget ? (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              Restoring revision <strong>v{restoreRevisionTarget.version}</strong> will bring back the saved title,
              totals, status, and line items from {formatDateTime(restoreRevisionTarget.createdAt)}.
            </p>
            <p>The current version remains in history, so you can track this restore action later.</p>
          </div>
        ) : null}
      </ConfirmModal>

      <SaveLinePresetModal
        open={Boolean(presetPromptLine)}
        line={presetPromptLine}
        saving={presetPromptSaving}
        onClose={dismissPresetPrompt}
        onSaveFull={() => void saveNewLineAsPreset(true)}
        onSaveNameOnly={() => void saveNewLineAsPreset(false)}
      />

      <WorkPresetPickerModal
        open={presetPickerOpen}
        onClose={() => setPresetPickerOpen(false)}
        presets={availablePresets}
        selectedPresetId={selectedPresetId}
        onSelectPreset={setSelectedPresetId}
        quantity={selectedPresetQuantity}
        onQuantityChange={setSelectedPresetQuantity}
        primaryActionLabel="Add to quote"
        onPrimaryAction={() => {
          if (!selectedPreset) return;
          void addPresetToQuote(selectedPreset);
          setPresetPickerOpen(false);
        }}
        secondaryActionLabel="Load to new row"
        onSecondaryAction={() => {
          if (!selectedPreset) return;
          loadPresetToNewLine(selectedPreset);
          setPresetPickerOpen(false);
        }}
      />

      <QuoteAiPromptModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        serviceType={quoteEditForm.serviceType}
        onServiceTypeChange={(value) =>
          setQuoteEditForm((prev) => ({
            ...prev,
            serviceType: value,
          }))
        }
        prompt={chatPrompt}
        onPromptChange={setChatPrompt}
        starterPrompts={aiPromptStarters}
        onUseStarterPrompt={setChatPrompt}
        customerContextName={customerName}
        customerContextDetails={[customerPhone, customerEmail].filter(Boolean).join(" • ")}
        customerContextText={`${customerName}${customerPhone ? ` • ${customerPhone}` : ""}${customerEmail ? ` • ${customerEmail}` : ""}`}
        customerContextBadge="Using current quote"
        usageHint={aiUsageHint}
        progressEvent={aiProgressEvent}
        loading={aiSubmitting}
        disabled={!canUseChatToQuote}
        onSubmit={(event) => void handleAiSuggestSubmit(event)}
        title="Revise quote with AI"
        description="Apply an AI suggestion into the current quote sheet, then review and save the tracked edits."
        submitLabel="Apply AI Suggestion"
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
            businessHint={businessHint}
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
            logoUrl={branding?.logoUrl ?? null}
            logoPosition={branding?.logoPosition ?? "left"}
            templateId={branding?.templateId ?? "modern"}
            accentColor={quoteAccentColor}
            componentColors={branding?.componentColors ?? null}
            footerText={quoteFooterText}
            showQuoteFlyAttribution={showQuoteFlyAttribution}
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
              Confirming will mark the quote sent, log the action, and {canSharePdfFromDevice ? "open the share sheet with the PDF when supported." : "open the selected app."}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onClick={() => setSendComposer(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => { track("send_composer_confirm"); void confirmSendComposer(); }} loading={saving}>
              {sendComposer.channel === "copy"
                ? "Copy and Mark Sent"
                : canSharePdfFromDevice
                  ? "Share PDF and Mark Sent"
                  : "Open App and Mark Sent"}
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
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--qf-border)] bg-white px-3 py-2.5">
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
    <div className={`flex items-center gap-2 rounded-lg border px-3 ${compact ? "py-2" : "py-2"} ${complete ? "border-emerald-200 bg-emerald-50" : "border-[var(--qf-border)] bg-white"}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${complete ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
        {complete ? "OK" : "-"}
      </span>
      <span className="text-sm text-slate-700">{label}</span>
    </div>
  );
}

function ExistingLineEditorRow({
  line,
  index,
  dirty,
  readOnly,
  startExpanded,
  onChange,
  onSave,
  onDelete,
}: {
  line: EditableQuoteLine;
  index: number;
  dirty: boolean;
  readOnly?: boolean;
  startExpanded?: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onSave: (lineId: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);
  const sectionPillLabel =
    line.sectionType === "ALTERNATE"
      ? line.sectionLabel?.trim() || "Alternate option"
      : "Included in total";
  const sectionPillClassName =
    line.sectionType === "ALTERNATE"
      ? "border-orange-200 bg-orange-50 text-orange-700"
      : "border-slate-200 bg-slate-100 text-slate-600";

  useEffect(() => {
    setExpanded(startExpanded ?? false);
  }, [line.id, startExpanded]);

  return (
    <div className="px-3 py-2.5 lg:hover:bg-[var(--qf-panel-muted)]/60">
      <div className="lg:hidden">
        <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)]">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Line {index + 1}</p>
                {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${sectionPillClassName}`}>
                  {sectionPillLabel}
                </span>
              </div>
              <p className="truncate text-sm font-semibold text-slate-900">{line.title.trim() || "Untitled line"}</p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                <span>Qty {line.quantity}</span>
                <span>Price {money(line.unitPrice)}</span>
                <span>Total {money(lineTotal)}</span>
              </div>
            </div>
            <span className="rounded-lg border border-[var(--qf-border)] bg-white p-2 text-slate-500">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>
          <div className={expanded ? "border-t border-slate-200 px-3 py-3" : "hidden"}>
            <div className="mb-2 flex items-center justify-end gap-2">
              <Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => void onSave(line.id)} disabled={!dirty || readOnly}>
                Save
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onDelete} disabled={readOnly}>
                Remove
              </Button>
            </div>
            <div className="space-y-3">
              <Input label="Line" value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} disabled={readOnly} />
              <Textarea label="Description" rows={3} value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} disabled={readOnly} />
              <div className="grid grid-cols-3 gap-2">
                <Input label="Qty" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} disabled={readOnly} />
                <Input label="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} disabled={readOnly} />
                <Input label="Price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} disabled={readOnly} />
              </div>
              <div className="rounded-lg border border-[var(--qf-border)] bg-white px-3 py-2.5 text-sm font-semibold text-slate-900">
                Line total {money(lineTotal)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="hidden lg:grid lg:grid-cols-[36px_minmax(0,1.05fr)_minmax(0,1.15fr)_72px_96px_96px_108px_128px] lg:items-start lg:gap-2.5">
        <div className="flex h-[38px] items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-slate-500">
          {index + 1}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${sectionPillClassName}`}>
              {sectionPillLabel}
            </span>
          </div>
          <Input className="min-h-[38px] rounded-lg" value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} disabled={readOnly} />
        </div>
        <Textarea rows={2} className="min-h-[64px] rounded-lg" value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} disabled={readOnly} />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} disabled={readOnly} />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} disabled={readOnly} />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} disabled={readOnly} />
        <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-semibold text-slate-900 tabular-nums">
          {money(lineTotal)}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            icon={<Save size={14} />}
            className="w-9 px-0"
            onClick={() => void onSave(line.id)}
            disabled={!dirty || readOnly}
            aria-label="Save line"
            title="Save line"
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            className="w-9 px-0 text-slate-500 hover:text-red-600"
            onClick={onDelete}
            disabled={readOnly}
            aria-label="Remove line"
            title="Remove line"
          />
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
  readOnly,
}: {
  line: EditableQuoteLine;
  onChange: (line: EditableQuoteLine) => void;
  onAdd: () => Promise<void>;
  saving: boolean;
  readOnly?: boolean;
}) {
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[36px_minmax(0,1.05fr)_minmax(0,1.15fr)_72px_96px_96px_108px]">
        <div className="hidden lg:flex h-[38px] items-center justify-center rounded-lg border border-dashed border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-slate-500">
          New
        </div>
        <Input
          className="min-h-[38px] rounded-lg"
          label="Line"
          placeholder="Service or job name"
          value={line.title}
          onChange={(event) => onChange({ ...line, title: event.target.value })}
          disabled={readOnly}
        />
        <Textarea
          label="Description"
          rows={3}
          className="rounded-lg lg:min-h-[64px]"
          placeholder="Optional line description"
          value={line.details}
          onChange={(event) => onChange({ ...line, details: event.target.value })}
          disabled={readOnly}
        />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" label="Qty" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange({ ...line, quantity: event.target.value })} disabled={readOnly} />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" label="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange({ ...line, unitCost: event.target.value })} disabled={readOnly} />
        <Input className="min-h-[38px] rounded-lg text-right tabular-nums" label="Price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange({ ...line, unitPrice: event.target.value })} disabled={readOnly} />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-600">Total</label>
          <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2.5 text-sm font-semibold text-slate-900 tabular-nums">
            {money(lineTotal)}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          icon={<X size={14} />}
          onClick={() => onChange(makeEditableQuoteLine())}
          disabled={readOnly}
        >
          Clear
        </Button>
        <Button icon={<Plus size={14} />} loading={saving} onClick={() => void onAdd()} disabled={readOnly}>
          Add line
        </Button>
      </div>
    </div>
  );
}

export default QuoteDeskView;

