import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, Plus, Sparkles, X } from "lucide-react";
import { useDashboard, money } from "../components/dashboard/DashboardContext";
import { QuickCustomerModal, type QuickCustomerForm } from "../components/customers/QuickCustomerModal";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
import { QuoteAiPromptModal } from "../components/quotes/QuoteAiPromptModal";
import { QuoteLineSectionField } from "../components/quotes/QuoteLineSectionField";
import { QuoteSheetEditor } from "../components/quotes/QuoteSheetEditor";
import { InlineCustomerLookup } from "../components/quotes/InlineCustomerLookup";
import { SaveLinePresetModal } from "../components/quotes/SaveLinePresetModal";
import { WorkPresetPickerModal } from "../components/quotes/WorkPresetPickerModal";
import { buildQuoteFooterText, shouldShowQuoteFlyAttribution } from "../components/quotes/quote-footer";
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
import { api, type AiProgressEvent, type AiQuoteInsight, type TenantBranding, type WorkPreset } from "../lib/api";
import { formatAiUsageAvailability, formatAiUsageNotice } from "../lib/ai-credits";
import {
  quoteBuilderDraftStorageKey,
  readQuoteBuilderDraft,
  removeQuoteBuilderDraft,
  writeQuoteBuilderDraft,
} from "../lib/quote-builder-draft-storage";
import {
  applyAiQuoteLinePatch,
  buildPresetPayloadFromLine,
  isIncludedEditableQuoteLine,
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

function buildStructuredAiPromptStarter(
  serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
  customerLead: string,
) {
  const tradeLabel = serviceType.toLowerCase();
  return [
    `New quote for ${customerLead}. Trade: ${tradeLabel}.`,
    "Line 1: Primary scope here | Qty: 1",
    "Line 2: Secondary scope here | Qty: 1",
    "Line 3: Optional/alternate scope here (optional) | Qty: 1",
    "Notes: Keep each line separate and preserve quantities.",
  ].join("\n");
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
      `Draft a roofing quote for ${customerLead}. Replace a Spanish tile roof at 22 roofing squares, include underlayment and flashing, and keep deck repair as an optional allowance line.`,
      buildStructuredAiPromptStarter(serviceType, customerLead),
    ];
  }

  if (serviceType === "HVAC") {
    return [
      `New quote for ${customerLead}. Install a new AC condenser and reconnect refrigerant lines with startup testing.`,
      `Draft an HVAC quote for ${customerLead}. Replace a 4-ton high-efficiency heat pump (SEER2/HSPF2), include evaporator coil, thermostat setup, duct sealing, startup/commissioning, and one optional electrical upgrade line if needed.`,
      buildStructuredAiPromptStarter(serviceType, customerLead),
    ];
  }

  if (serviceType === "PLUMBING") {
    return [
      `New quote for ${customerLead}. Replace a burst pipe section, patch wall access, and test the line after repair.`,
      `Draft a plumbing quote for ${customerLead}. Combine partial PEX repipe, tankless water heater upgrade with venting, sewer camera + hydro-jet line service, and optional trenchless sewer repair allowance as separate lines.`,
      buildStructuredAiPromptStarter(serviceType, customerLead),
    ];
  }

  if (serviceType === "FLOORING") {
    return [
      `New quote for ${customerLead}. Install 650 square feet of LVP flooring with underlayment and trim.`,
      `Draft a flooring quote for ${customerLead}. Install linoleum tile in two bathrooms and one hallway, include moisture barrier, subfloor leveling allowance, uncoupling membrane + thinset/grout prep, and transition/baseboard finish lines.`,
      buildStructuredAiPromptStarter(serviceType, customerLead),
    ];
  }

  if (serviceType === "GARDENING") {
    return [
      `New quote for ${customerLead}. Monthly landscaping maintenance with mowing, edging, cleanup, and shrub trimming.`,
      `Draft a gardening quote for ${customerLead}. Add sod replacement, lawn aeration + overseed, irrigation controller setup by hydrozone, pre-emergent treatment, mulch refresh, and debris haul-away with an optional drainage correction allowance.`,
      buildStructuredAiPromptStarter(serviceType, customerLead),
    ];
  }

  return [
    `New quote for ${customerLead}. Remodel a small bathroom and include demolition, framing touchups, finish work, and cleanup.`,
    `Draft a construction quote for ${customerLead}. Build a backyard patio cover and include labor, materials, and site cleanup.`,
    buildStructuredAiPromptStarter(serviceType, customerLead),
  ];
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

type BuilderPane = "editor" | "preview";
type BuilderDraftLine = Omit<EditableQuoteLine, "id">;
type BuilderDraftData = {
  quote: {
    customerId: string;
    serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION";
    title: string;
    scopeText: string;
    taxAmount: string;
  };
  lines: BuilderDraftLine[];
  mobilePane: BuilderPane;
  quickCustomerOpen: boolean;
  quickCustomerForm: QuickCustomerForm;
  lastAppliedAiRunId: string | null;
};
type StoredBuilderDraft = BuilderDraftData & { version: 1; savedAtUtc: string };

const EMPTY_QUICK_CUSTOMER_FORM: QuickCustomerForm = { fullName: "", phone: "", email: "", notes: "" };
const SERVICE_TYPE_SET = new Set(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDraftString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function parseStoredBuilderDraft(raw: string): StoredBuilderDraft | null {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !isDraftString(value.savedAtUtc, 64)) return null;
  const savedAt = Date.parse(value.savedAtUtc);
  if (!Number.isFinite(savedAt) || savedAt > Date.now() + 60_000) return null;
  if (!isRecord(value.quote) || !Array.isArray(value.lines) || value.lines.length === 0 || value.lines.length > 100) return null;
  if (
    !isDraftString(value.quote.customerId, 200) ||
    !isDraftString(value.quote.serviceType, 32) ||
    !SERVICE_TYPE_SET.has(value.quote.serviceType) ||
    !isDraftString(value.quote.title, 500) ||
    !isDraftString(value.quote.scopeText, 20_000) ||
    !isDraftString(value.quote.taxAmount, 100)
  ) return null;
  if (value.mobilePane !== "editor" && value.mobilePane !== "preview") return null;
  if (typeof value.quickCustomerOpen !== "boolean" || !isRecord(value.quickCustomerForm)) return null;
  const quickCustomerForm = value.quickCustomerForm;
  if (
    !isDraftString(quickCustomerForm.fullName, 500) ||
    !isDraftString(quickCustomerForm.phone, 100) ||
    !isDraftString(quickCustomerForm.email, 500) ||
    !isDraftString(quickCustomerForm.notes, 20_000)
  ) return null;
  if (value.lastAppliedAiRunId !== null && !isDraftString(value.lastAppliedAiRunId, 200)) return null;

  const lines: BuilderDraftLine[] = [];
  for (const candidate of value.lines) {
    if (!isRecord(candidate)) return null;
    if (
      !isDraftString(candidate.title, 1_000) ||
      !isDraftString(candidate.details, 20_000) ||
      (candidate.sectionType !== "INCLUDED" && candidate.sectionType !== "ALTERNATE") ||
      !isDraftString(candidate.sectionLabel, 1_000) ||
      !isDraftString(candidate.quantity, 100) ||
      !isDraftString(candidate.unitCost, 100) ||
      !isDraftString(candidate.unitPrice, 100) ||
      (candidate.sourcePresetId !== undefined && candidate.sourcePresetId !== null && !isDraftString(candidate.sourcePresetId, 200)) ||
      (candidate.presetPromptHandled !== undefined && typeof candidate.presetPromptHandled !== "boolean")
    ) return null;
    lines.push({
      title: candidate.title,
      details: candidate.details,
      sectionType: candidate.sectionType,
      sectionLabel: candidate.sectionLabel,
      quantity: candidate.quantity,
      unitCost: candidate.unitCost,
      unitPrice: candidate.unitPrice,
      sourcePresetId: candidate.sourcePresetId as string | null | undefined,
      presetPromptHandled: candidate.presetPromptHandled as boolean | undefined,
    });
  }

  return {
    version: 1,
    savedAtUtc: value.savedAtUtc,
    quote: {
      customerId: value.quote.customerId,
      serviceType: value.quote.serviceType as BuilderDraftData["quote"]["serviceType"],
      title: value.quote.title,
      scopeText: value.quote.scopeText,
      taxAmount: value.quote.taxAmount,
    },
    lines,
    mobilePane: value.mobilePane,
    quickCustomerOpen: value.quickCustomerOpen,
    quickCustomerForm: {
      fullName: quickCustomerForm.fullName,
      phone: quickCustomerForm.phone,
      email: quickCustomerForm.email,
      notes: quickCustomerForm.notes,
    },
    lastAppliedAiRunId: value.lastAppliedAiRunId as string | null,
  };
}

function hasMeaningfulBuilderDraft(draft: BuilderDraftData) {
  const quoteIsMeaningful = Boolean(
    draft.quote.customerId || draft.quote.title.trim() || draft.quote.scopeText.trim() || Number(draft.quote.taxAmount) !== 0,
  );
  const linesAreMeaningful = draft.lines.some((line) =>
    Boolean(
      line.title.trim() || line.details.trim() || line.sectionType === "ALTERNATE" || line.sectionLabel.trim() ||
      Number(line.quantity) !== 1 || Number(line.unitCost) !== 0 || Number(line.unitPrice) !== 0,
    ),
  );
  const customerIsMeaningful = Object.values(draft.quickCustomerForm).some((value) => value.trim().length > 0);
  return quoteIsMeaningful || linesAreMeaningful || customerIsMeaningful;
}

function writeStoredBuilderDraft(storageKey: string, draft: BuilderDraftData) {
  if (!hasMeaningfulBuilderDraft(draft)) {
    removeQuoteBuilderDraft(storageKey);
    return null;
  }
  const savedAtUtc = new Date().toISOString();
  const stored = JSON.stringify({ ...draft, version: 1, savedAtUtc } satisfies StoredBuilderDraft);
  return writeQuoteBuilderDraft(storageKey, stored) ? savedAtUtc : null;
}

const QUOTE_BUILDER_LINE_GRID_COLUMNS =
  "xl:grid-cols-[32px_minmax(10rem,0.95fr)_minmax(15rem,1.35fr)_72px_92px_92px_108px_84px] 2xl:grid-cols-[36px_minmax(11rem,1.05fr)_minmax(16rem,1.3fr)_72px_96px_96px_108px_88px]";
const QUOTE_BUILDER_LINE_GRID_MIN_WIDTH = "xl:min-w-[860px] 2xl:min-w-[920px]";

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const track = useTrack();
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quickCustomerForm, setQuickCustomerForm] = useState<QuickCustomerForm>(EMPTY_QUICK_CUSTOMER_FORM);
  const [hydratedDraftStorageKey, setHydratedDraftStorageKey] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAtUtc, setDraftSavedAtUtc] = useState<string | null>(null);
  const [draftPersistenceFailed, setDraftPersistenceFailed] = useState(false);
  const [draftRecoveryMessage, setDraftRecoveryMessage] = useState<string | null>(null);
  const [conflictingStoredDraft, setConflictingStoredDraft] = useState<StoredBuilderDraft | null>(null);
  const [discardDraftConfirmOpen, setDiscardDraftConfirmOpen] = useState(false);
  const keepDraftButtonRef = useRef<HTMLButtonElement | null>(null);
  const latestDraftRef = useRef<BuilderDraftData | null>(null);
  const quoteCreationCompletedRef = useRef(false);
  const draftRecoveryStorageKeyRef = useRef<string | null>(null);
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
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiProgressEvent, setAiProgressEvent] = useState<AiProgressEvent | null>(null);
  const [aiErrorMessage, setAiErrorMessage] = useState<string | null>(null);
  const [aiInsight, setAiInsight] = useState<AiQuoteInsight | null>(null);
  const [lastAppliedAiRunId, setLastAppliedAiRunId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<BuilderPane>("editor");
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const {
    session,
    customers,
    saving,
    error,
    notice,
    setError,
    setNotice,
    canUseChatToQuote,
    chatPrompt,
    setChatPrompt,
    setChatParsed,
    quoteForm,
    setQuoteForm,
    createQuoteDraftFromForm,
    selectQuoteCustomer,
    selectedQuoteId,
    navigateToQuote,
    loadCustomers,
  } = useDashboard();
  const selectedCustomerIdRef = useRef(quoteForm.customerId);

  const activeCustomer = useMemo(
    () => customers.find((customer) => customer.id === quoteForm.customerId) ?? null,
    [customers, quoteForm.customerId],
  );
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
  const preparedDateLabel = useMemo(() => new Date().toLocaleDateString(), []);
  const draftStorageKey = useMemo(
    () => session ? quoteBuilderDraftStorageKey(session.tenantId, session.userId) : null,
    [session],
  );
  const currentBuilderDraft = useMemo<BuilderDraftData>(
    () => ({
      quote: {
        customerId: quoteForm.customerId,
        serviceType: quoteForm.serviceType,
        title: quoteForm.title,
        scopeText: quoteForm.scopeText,
        taxAmount: quoteForm.taxAmount,
      },
      lines: draftLines.map((line) => ({
        title: line.title,
        details: line.details,
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel,
        quantity: line.quantity,
        unitCost: line.unitCost,
        unitPrice: line.unitPrice,
        sourcePresetId: line.sourcePresetId,
        presetPromptHandled: line.presetPromptHandled,
      })),
      mobilePane,
      quickCustomerOpen,
      quickCustomerForm,
      lastAppliedAiRunId,
    }),
    [draftLines, lastAppliedAiRunId, mobilePane, quickCustomerForm, quickCustomerOpen, quoteForm],
  );
  const hasMeaningfulDraft = useMemo(() => hasMeaningfulBuilderDraft(currentBuilderDraft), [currentBuilderDraft]);
  latestDraftRef.current = currentBuilderDraft;
  selectedCustomerIdRef.current = quoteForm.customerId;

  useEffect(() => {
    if (!draftStorageKey) return;
    let hydrationDeferred = false;
    quoteCreationCompletedRef.current = false;
    setDraftRestored(false);
    if (draftRecoveryStorageKeyRef.current !== draftStorageKey) {
      draftRecoveryStorageKeyRef.current = draftStorageKey;
      setDraftRecoveryMessage(null);
    }
    try {
      const raw = readQuoteBuilderDraft(draftStorageKey);
      if (!raw) {
        setHydratedDraftStorageKey(draftStorageKey);
        return;
      }
      const stored = parseStoredBuilderDraft(raw);
      if (!stored || !hasMeaningfulBuilderDraft(stored)) {
        removeQuoteBuilderDraft(draftStorageKey);
        setDraftRecoveryMessage("An incompatible saved draft was cleared safely.");
        setHydratedDraftStorageKey(draftStorageKey);
        return;
      }
      if (selectedCustomerIdRef.current && stored.quote.customerId !== selectedCustomerIdRef.current) {
        hydrationDeferred = true;
        setConflictingStoredDraft(stored);
        return;
      }
      setQuoteForm((current) => ({
        ...current,
        customerId: stored.quote.customerId,
        serviceType: stored.quote.serviceType,
        title: stored.quote.title,
        scopeText: stored.quote.scopeText,
        taxAmount: stored.quote.taxAmount,
        internalCostSubtotal: "0",
        customerPriceSubtotal: "0",
      }));
      setDraftLines(stored.lines.map((line) => makeEditableQuoteLine(line)));
      setMobilePane(stored.mobilePane);
      setQuickCustomerOpen(stored.quickCustomerOpen);
      setQuickCustomerForm(stored.quickCustomerForm);
      setLastAppliedAiRunId(stored.lastAppliedAiRunId);
      setDraftSavedAtUtc(stored.savedAtUtc);
      setDraftPersistenceFailed(false);
      setDraftRestored(true);
      setConflictingStoredDraft(null);
    } catch {
      try {
        removeQuoteBuilderDraft(draftStorageKey);
      } catch {
        // Storage can be unavailable in locked-down browser modes; the builder remains usable in memory.
      }
      setDraftRecoveryMessage("The saved draft could not be read and was cleared safely.");
    } finally {
      if (!hydrationDeferred) setHydratedDraftStorageKey(draftStorageKey);
    }
  }, [draftStorageKey, setQuoteForm]);

  useEffect(() => {
    if (!draftStorageKey || hydratedDraftStorageKey !== draftStorageKey || quoteCreationCompletedRef.current) return;
    const savedAtUtc = writeStoredBuilderDraft(draftStorageKey, currentBuilderDraft);
    setDraftSavedAtUtc(savedAtUtc);
    setDraftPersistenceFailed(hasMeaningfulDraft && !savedAtUtc);
  }, [currentBuilderDraft, draftStorageKey, hasMeaningfulDraft, hydratedDraftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey || hydratedDraftStorageKey !== draftStorageKey) return;
    const persistLatestDraft = () => {
      if (quoteCreationCompletedRef.current || !latestDraftRef.current) return;
      writeStoredBuilderDraft(draftStorageKey, latestDraftRef.current);
    };
    window.addEventListener("beforeunload", persistLatestDraft);
    window.addEventListener("pagehide", persistLatestDraft);
    return () => {
      window.removeEventListener("beforeunload", persistLatestDraft);
      window.removeEventListener("pagehide", persistLatestDraft);
      persistLatestDraft();
    };
  }, [draftStorageKey, hydratedDraftStorageKey]);

  useEffect(() => {
    if (discardDraftConfirmOpen) keepDraftButtonRef.current?.focus();
  }, [discardDraftConfirmOpen]);

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
  const includedDraftLines = useMemo(
    () => filteredDraftLines.filter((line) => isIncludedEditableQuoteLine(line)),
    [filteredDraftLines],
  );

  const savedPresetKeys = useMemo(
    () =>
      new Set(
        presetLibrary.map((preset) => `${preset.serviceType}:${preset.name.trim().toLowerCase()}:${(preset.description ?? "").trim().toLowerCase()}`),
      ),
    [presetLibrary],
  );

  const internalSubtotal = useMemo(
    () => includedDraftLines.reduce((total, line) => total + quoteLineCostTotal(line.quantity, line.unitCost), 0),
    [includedDraftLines],
  );
  const customerSubtotal = useMemo(
    () => includedDraftLines.reduce((total, line) => total + quoteLineAmount(line.quantity, line.unitPrice), 0),
    [includedDraftLines],
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
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel,
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

  async function handleAiDraftSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!canUseChatToQuote) {
      setError("AI drafting is not available on this workspace.");
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setError("Enter a prompt before generating a quote.");
      return;
    }

    track("builder_ai_modal_submit");
    try {
      setAiSubmitting(true);
      setAiProgressEvent(null);
      setAiErrorMessage(null);
      const { customer, parsed, suggestion, patch, insight, aiRunId, usage } = await api.quotes.suggestWithAi({
        prompt,
        customerId: activeCustomer?.id ?? undefined,
        serviceType: quoteForm.serviceType,
        currentTitle: quoteForm.title || undefined,
        currentScopeText: quoteForm.scopeText || undefined,
        currentLineItems: filteredDraftLines.map((line) => ({
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
      if (customer) {
        selectQuoteCustomer(customer.id);
      }
      setQuoteForm((prev) => ({
        ...prev,
        customerId: customer?.id ?? prev.customerId,
        serviceType: suggestion.serviceType,
        title: suggestion.title,
        scopeText: suggestion.scopeText,
        internalCostSubtotal: String(suggestion.internalCostSubtotal),
        customerPriceSubtotal: String(suggestion.customerPriceSubtotal),
        taxAmount: String(suggestion.taxAmount),
      }));
      setDraftLines((current) => applyAiQuoteLinePatch(current, patch));
      setAiInsight(insight);
      setLastAppliedAiRunId(aiRunId);
      void loadCustomers();
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
        `AI suggestion applied for ${customer?.fullName ?? parsed.customerName ?? "customer"}. ${patchSummary ? `${patchSummary}. ` : ""}${usageSummary} Review the sheet, then create the quote.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed applying AI suggestion.";
      setAiErrorMessage(message);
      setError(message);
    } finally {
      setAiSubmitting(false);
      setAiProgressEvent(null);
    }
  }

  function updateDraftLine(lineId: string, field: keyof EditableQuoteLine, value: string) {
    setDraftLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
    );
  }

  function maybeQueuePresetPrompt(previousLine?: EditableQuoteLine | null) {
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
  }

  function addBlankLine(afterLineId?: string) {
    const previousLine = afterLineId
      ? draftLines.find((line) => line.id === afterLineId) ?? draftLines[draftLines.length - 1]
      : draftLines[draftLines.length - 1];

    maybeQueuePresetPrompt(previousLine);

    setDraftLines((current) => {
      if (!afterLineId) return [...current, makeEditableQuoteLine()];
      const insertIndex = current.findIndex((line) => line.id === afterLineId);
      if (insertIndex === -1) return [...current, makeEditableQuoteLine()];
      const next = [...current];
      next.splice(insertIndex + 1, 0, makeEditableQuoteLine());
      return next;
    });
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

  function restoreConflictingDraft() {
    if (!conflictingStoredDraft || !draftStorageKey) return;
    const stored = conflictingStoredDraft;
    setQuoteForm((current) => ({
      ...current,
      customerId: stored.quote.customerId,
      serviceType: stored.quote.serviceType,
      title: stored.quote.title,
      scopeText: stored.quote.scopeText,
      taxAmount: stored.quote.taxAmount,
      internalCostSubtotal: "0",
      customerPriceSubtotal: "0",
    }));
    setDraftLines(stored.lines.map((line) => makeEditableQuoteLine(line)));
    setMobilePane(stored.mobilePane);
    setQuickCustomerOpen(stored.quickCustomerOpen);
    setQuickCustomerForm(stored.quickCustomerForm);
    setLastAppliedAiRunId(stored.lastAppliedAiRunId);
    setDraftSavedAtUtc(stored.savedAtUtc);
    setDraftRestored(true);
    setConflictingStoredDraft(null);
    setHydratedDraftStorageKey(draftStorageKey);
    setNotice("Restored the saved quote draft.");
  }

  function startFreshForSelectedCustomer() {
    if (!draftStorageKey) return;
    removeQuoteBuilderDraft(draftStorageKey);
    setConflictingStoredDraft(null);
    setDraftRestored(false);
    setDraftSavedAtUtc(null);
    setHydratedDraftStorageKey(draftStorageKey);
    setNotice("Started a fresh quote for the selected customer.");
  }

  function clearStoredBuilderDraft() {
    quoteCreationCompletedRef.current = true;
    if (draftStorageKey) removeQuoteBuilderDraft(draftStorageKey);
    setDraftSavedAtUtc(null);
    setDraftPersistenceFailed(false);
    setDraftRestored(false);
  }

  function startBuilderOver() {
    clearStoredBuilderDraft();
    setQuoteForm({
      customerId: "",
      serviceType: session?.primaryTrade ?? "HVAC",
      title: "",
      scopeText: "",
      internalCostSubtotal: "0",
      customerPriceSubtotal: "0",
      taxAmount: "0",
    });
    setDraftLines([makeEditableQuoteLine()]);
    setQuickCustomerOpen(false);
    setQuickCustomerForm(EMPTY_QUICK_CUSTOMER_FORM);
    setMobilePane("editor");
    setAiModalOpen(false);
    setAiInsight(null);
    setLastAppliedAiRunId(null);
    setChatPrompt("");
    setChatParsed(null);
    setPresetPromptLine(null);
    setDiscardDraftConfirmOpen(false);
    setDraftRecoveryMessage(null);
    setConflictingStoredDraft(null);
    setNotice("Started a fresh quote.");
    window.setTimeout(() => {
      quoteCreationCompletedRef.current = false;
    }, 0);
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
        scopeText:
          quoteForm.scopeText.trim() ||
          linesToCreate.map((line) => joinQuoteLineDescription(line.title, line.details)).join("\n"),
        internalCostSubtotal: internalSubtotal.toFixed(2),
        customerPriceSubtotal: customerSubtotal.toFixed(2),
      },
      aiUsageEventId: lastAppliedAiRunId ?? undefined,
      initialLineItems: linesToCreate.map((line) => ({
        description: joinQuoteLineDescription(line.title, line.details),
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel || null,
        quantity: Number(line.quantity) || 1,
        unitCost: Number(line.unitCost) || 0,
        unitPrice: Number(line.unitPrice) || 0,
      })),
      successNotice: "Quote ready. Review it, then share it from the quote desk.",
    });

    if (createdQuote) {
      clearStoredBuilderDraft();
      setDraftLines([makeEditableQuoteLine()]);
      setAiInsight(null);
      setLastAppliedAiRunId(null);
      if (!presetPromptLine && promptCandidate) {
        setPresetPromptLine(promptCandidate);
      }
    }
  }

  return (
    <div className="space-y-5" data-testid="quote-builder">
      <PageHeader
        title="Quick Quote"
        subtitle="Choose an existing customer or add one here, price the work, preview, and share from your phone."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>Open Active Quote</Button> : null}
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {draftRecoveryMessage ? (
        <Alert tone="warning" onDismiss={() => setDraftRecoveryMessage(null)}>{draftRecoveryMessage}</Alert>
      ) : null}
      {conflictingStoredDraft ? (
        <div
          role="alert"
          data-testid="quote-builder-draft-conflict"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-slate-900"
        >
          <p className="text-sm font-semibold">Saved quote draft found</p>
          <p className="mt-1 text-sm text-slate-700">
            This tab has a saved draft for a different customer. Choose which quote you want to continue.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" size="sm" onClick={restoreConflictingDraft}>
              Restore Saved Draft
            </Button>
            <Button size="sm" onClick={startFreshForSelectedCustomer}>
              Start Fresh for Selected Customer
            </Button>
          </div>
        </div>
      ) : null}
      {hasMeaningfulDraft && hydratedDraftStorageKey === draftStorageKey ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="quote-builder-draft-status"
          className="flex flex-col gap-3 rounded-xl border border-quotefly-blue/20 bg-quotefly-blue/[0.05] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {draftPersistenceFailed
                ? "Draft open in this tab"
                : draftRestored
                  ? "Draft restored in this tab"
                  : "Draft autosaved in this tab"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {draftPersistenceFailed
                ? "This browser blocked local draft storage. Keep this tab open until the quote is created."
                : `Saved only in this tab for the signed-in workspace account${draftSavedAtUtc ? ` at ${new Date(draftSavedAtUtc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Closing the tab clears it.`}
            </p>
          </div>
          {discardDraftConfirmOpen ? (
            <div role="group" aria-label="Confirm discard saved quote draft" className="flex flex-wrap items-center gap-2 sm:justify-end">
              <span className="w-full text-xs font-semibold text-slate-700 sm:w-auto">Discard this draft?</span>
              <Button ref={keepDraftButtonRef} variant="outline" size="sm" onClick={() => setDiscardDraftConfirmOpen(false)}>
                Keep Draft
              </Button>
              <Button variant="danger" size="sm" onClick={startBuilderOver}>
                Discard Draft
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setDiscardDraftConfirmOpen(true)}
              aria-label="Discard saved quote draft and start over"
            >
              Start Over
            </Button>
          )}
        </div>
      ) : null}
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

      <div className="flex gap-2 xl:hidden">
        {([
          { id: "editor", label: "Edit quote" },
          { id: "preview", label: "Preview" },
        ] as const).map((pane) => (
          <button
            key={pane.id}
            type="button"
            onClick={() => setMobilePane(pane.id)}
            aria-pressed={mobilePane === pane.id}
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

      <Card variant="default" padding="sm" className="xl:hidden">
        <div className="grid gap-3">
          <Select
            label="Trade"
            value={quoteForm.serviceType}
            onChange={(event) =>
              setQuoteForm((prev) => ({
                ...prev,
                serviceType: event.target.value as typeof prev.serviceType,
              }))
            }
            options={[
              { value: "HVAC", label: "HVAC" },
              { value: "PLUMBING", label: "Plumbing" },
              { value: "FLOORING", label: "Flooring" },
              { value: "ROOFING", label: "Roofing" },
              { value: "GARDENING", label: "Gardening" },
              { value: "CONSTRUCTION", label: "Construction" },
            ]}
          />
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Quick actions</p>
              <p className="text-sm font-semibold text-slate-900">Total {money(totalAmount)}</p>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => setQuickCustomerOpen(true)}>
                Add Customer
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPresetPickerOpen(true)}>
                Browse Jobs
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card variant="blue" padding="md" className="order-2 hidden self-start xl:block xl:sticky xl:top-24">
          <CardHeader
            title="Quote actions"
            subtitle="Keep math and create actions visible while you build."
          />
          <div className="mb-4">
            <Select
              label="Trade"
              value={quoteForm.serviceType}
              onChange={(event) =>
                setQuoteForm((prev) => ({
                  ...prev,
                  serviceType: event.target.value as typeof prev.serviceType,
                }))
              }
              options={[
                { value: "HVAC", label: "HVAC" },
                { value: "PLUMBING", label: "Plumbing" },
                { value: "FLOORING", label: "Flooring" },
                { value: "ROOFING", label: "Roofing" },
                { value: "GARDENING", label: "Gardening" },
                { value: "CONSTRUCTION", label: "Construction" },
              ]}
            />
          </div>
          <div className="space-y-3 text-sm">
            <SummaryRow label="Internal subtotal" value={money(internalSubtotal)} />
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
          </div>
        </Card>

        <div className={`order-1 ${mobilePane === "preview" ? "hidden xl:block" : ""}`}>
          <QuoteSheetEditor
            title={quoteForm.title}
            onTitleChange={(value) => setQuoteForm((prev) => ({ ...prev, title: value }))}
            titlePlaceholder="Asphalt shingle roof replacement"
            businessName={session?.tenantName ?? "QuoteFly"}
            businessHint={businessHint}
            customerName={activeCustomer?.fullName ?? "Select customer"}
            customerHint={activeCustomer ? `${activeCustomer.phone}${activeCustomer.email ? ` / ${activeCustomer.email}` : ""}` : "Use an existing customer or add one fast."}
            headerTools={
              <InlineCustomerLookup
                selectedCustomer={activeCustomer}
                onSelectCustomer={(customer) => {
                  selectQuoteCustomer(customer.id);
                  setNotice(`${customer.fullName} loaded into the quote.`);
                }}
                onAddCustomer={() => setQuickCustomerOpen(true)}
              />
            }
            preparedDateLabel={preparedDateLabel}
            sentDateLabel="N/A"
            overview={quoteForm.scopeText}
            onOverviewChange={(value) => setQuoteForm((prev) => ({ ...prev, scopeText: value }))}
            overviewPlaceholder="Optional overview shown near the top of the quote."
            logoUrl={branding?.logoUrl ?? null}
            logoPosition={branding?.logoPosition ?? "left"}
            templateId={branding?.templateId ?? "modern"}
            accentColor={quoteAccentColor}
            componentColors={branding?.componentColors ?? null}
            footerText={quoteFooterText}
            showQuoteFlyAttribution={showQuoteFlyAttribution}
            actions={
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  className="h-11 w-11 min-h-[44px] rounded-full border-0 p-0 text-quotefly-blue hover:bg-transparent active:bg-transparent xl:hidden"
                  icon={<Sparkles size={18} />}
                  onClick={() => setAiModalOpen(true)}
                  disabled={!canUseChatToQuote}
                  aria-label="AI Prompt"
                  title="AI Prompt"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="hidden xl:inline-flex"
                  icon={<Sparkles size={14} />}
                  onClick={() => setAiModalOpen(true)}
                  disabled={!canUseChatToQuote}
                >
                  AI Prompt
                </Button>
                <Button variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                  Preview
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
                <div className="xl:hidden">
                  <Button size="sm" variant="outline" onClick={() => setPresetPickerOpen(true)}>
                    Browse jobs
                  </Button>
                </div>
                {selectedPreset ? (
                  <div className="hidden flex-col gap-2 sm:flex-row sm:items-end xl:flex">
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
                <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 xl:hidden">
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

              <div className="mt-3 hidden gap-2 overflow-x-auto pb-1 xl:flex">
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

            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <div
                className={`hidden gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 xl:grid ${QUOTE_BUILDER_LINE_GRID_COLUMNS} ${QUOTE_BUILDER_LINE_GRID_MIN_WIDTH}`}
              >
                <span>#</span>
                <span>Line</span>
                <span>Description</span>
                <span>Qty</span>
                <span>Cost</span>
                <span>Price</span>
                <span>Total</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="divide-y divide-slate-200">
                {draftLines.map((line, index) => (
                  <DraftLineEditorRow
                    key={line.id}
                    line={line}
                    index={index}
                    startExpanded={!line.title.trim() && !line.details.trim()}
                    onChange={updateDraftLine}
                    onInsertBelow={addBlankLine}
                    onRemove={removeDraftLine}
                  />
                ))}
              </div>
            </div>
          </QuoteSheetEditor>
        </div>
      </div>

      {mobilePane === "preview" ? (
        <div className="xl:hidden">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            businessHint={businessHint}
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
            logoUrl={branding?.logoUrl ?? null}
            logoPosition={branding?.logoPosition ?? "left"}
            templateId={branding?.templateId ?? "modern"}
            accentColor={quoteAccentColor}
            componentColors={branding?.componentColors ?? null}
            footerText={quoteFooterText}
            showQuoteFlyAttribution={showQuoteFlyAttribution}
          />
        </div>
      ) : null}

      <div className="xl:hidden">
        <div className="h-24" />
        <div className="qf-mobile-action-dock fixed z-40 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur">
          {error ? <p role="alert" className="mb-2 line-clamp-2 text-xs font-medium text-red-700">{error}</p> : null}
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
        draftValue={quickCustomerForm}
        onDraftChange={setQuickCustomerForm}
        onCreated={async ({ customer, intent, merged, restored, reusedExisting }) => {
          void loadCustomers();
          selectQuoteCustomer(customer.id);
          const createNotice = reusedExisting
            ? "Using existing customer record."
            : merged
              ? restored
                ? "Customer merged and restored."
                : "Customer merged into existing record."
              : restored
                ? "Customer restored."
                : "Customer created.";
          setNotice(intent === "quote" ? `${customer.fullName} is ready for a quote.` : createNotice);
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

      <QuoteAiPromptModal
        open={aiModalOpen}
        onClose={() => {
          setAiModalOpen(false);
          setAiErrorMessage(null);
        }}
        serviceType={quoteForm.serviceType}
        onServiceTypeChange={(value) =>
          setQuoteForm((prev) => ({
            ...prev,
            serviceType: value,
          }))
        }
        prompt={chatPrompt}
        onPromptChange={setChatPrompt}
        starterPrompts={aiPromptStarters}
        onUseStarterPrompt={setChatPrompt}
        customerContextName={activeCustomer?.fullName ?? null}
        customerContextDetails={
          activeCustomer
            ? [activeCustomer.phone, activeCustomer.email].filter(Boolean).join(" • ")
            : null
        }
        customerContextText={
          activeCustomer
            ? `${activeCustomer.fullName}${activeCustomer.phone ? ` • ${activeCustomer.phone}` : ""}${activeCustomer.email ? ` • ${activeCustomer.email}` : ""}`
            : "No customer is locked yet. Select one in the quote sheet or include the name, phone, or email directly in the prompt."
        }
        customerContextBadge={activeCustomer ? "Using selected customer" : null}
        usageHint={aiUsageHint}
        errorMessage={aiErrorMessage}
        progressEvent={aiProgressEvent}
        loading={aiSubmitting}
        disabled={!canUseChatToQuote}
        onSubmit={(event) => void handleAiDraftSubmit(event)}
        submitLabel="Apply AI Suggestion"
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
            businessHint={businessHint}
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

function DraftLineEditorRow({
  line,
  index,
  startExpanded,
  onChange,
  onInsertBelow,
  onRemove,
}: {
  line: EditableQuoteLine;
  index: number;
  startExpanded?: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onInsertBelow: (lineId?: string) => void;
  onRemove: (lineId: string) => void;
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
    if (startExpanded) setExpanded(true);
  }, [line.id, startExpanded]);

  function updateSectionType(nextSectionType: "INCLUDED" | "ALTERNATE") {
    onChange(line.id, "sectionType", nextSectionType);
    if (nextSectionType === "INCLUDED") {
      onChange(line.id, "sectionLabel", "");
      return;
    }
    if (!line.sectionLabel.trim()) {
      onChange(line.id, "sectionLabel", "Alternate Option");
    }
  }

  return (
    <div className="px-3 py-2.5 xl:hover:bg-[var(--qf-panel-muted)]/60" data-testid={`quote-line-row-${index + 1}`}>
      <div className="xl:hidden">
        <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)]">
          <div className="flex items-center gap-2 px-3 py-3">
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-3 text-left"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} line ${index + 1}`}
            >
              <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Line {index + 1}</p>
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
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--qf-border)] bg-white text-slate-500">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => onInsertBelow(line.id)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--qf-border)] bg-white text-slate-500 transition hover:border-[var(--qf-border-strong)] hover:text-quotefly-blue"
                aria-label="Add line below"
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                onClick={() => onRemove(line.id)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--qf-border)] bg-white text-slate-500 transition hover:border-red-200 hover:text-red-600"
                aria-label="Remove line"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className={expanded ? "border-t border-slate-200 px-3 py-3" : "hidden"}>
            <div className="space-y-3">
              <Input
                label="Line"
                aria-label={`Line ${index + 1} title`}
                placeholder="Asphalt shingle tear-off"
                value={line.title}
                onChange={(event) => onChange(line.id, "title", event.target.value)}
              />
              <Textarea
                label="Description"
                aria-label={`Line ${index + 1} description`}
                rows={3}
                placeholder="Optional scope details for this line"
                value={line.details}
                onChange={(event) => onChange(line.id, "details", event.target.value)}
              />
              <QuoteLineSectionField
                sectionType={line.sectionType}
                sectionLabel={line.sectionLabel}
                onSectionTypeChange={updateSectionType}
                onSectionLabelChange={(value) => onChange(line.id, "sectionLabel", value)}
              />
              <div className="grid grid-cols-3 gap-2">
                <Input label="Qty" aria-label={`Line ${index + 1} quantity`} type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
                <Input label="Cost" aria-label={`Line ${index + 1} cost`} type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
                <Input label="Price" aria-label={`Line ${index + 1} price`} type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
              </div>
              <div className="rounded-lg border border-[var(--qf-border)] bg-white px-3 py-2.5 text-sm font-semibold text-slate-900">
                Line total {money(lineTotal)}
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => onInsertBelow(line.id)}>
                  Add below
                </Button>
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => onRemove(line.id)}>
                  Remove
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`hidden xl:grid xl:items-start xl:gap-2.5 ${QUOTE_BUILDER_LINE_GRID_COLUMNS} ${QUOTE_BUILDER_LINE_GRID_MIN_WIDTH}`}
      >
        <div className="flex h-[38px] items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-slate-500">
          {index + 1}
        </div>
        <div className="space-y-1.5">
          <QuoteLineSectionField
            sectionType={line.sectionType}
            sectionLabel={line.sectionLabel}
            onSectionTypeChange={updateSectionType}
            onSectionLabelChange={(value) => onChange(line.id, "sectionLabel", value)}
            optionNameLabel="Option"
            compact
          />
          <Input
            aria-label={`Line ${index + 1} title`}
            className="min-h-[38px] rounded-lg"
            placeholder="Line"
            value={line.title}
            onChange={(event) => onChange(line.id, "title", event.target.value)}
          />
        </div>
        <Textarea
          aria-label={`Line ${index + 1} description`}
          rows={2}
          className="min-h-[64px] rounded-lg"
          placeholder="Description"
          value={line.details}
          onChange={(event) => onChange(line.id, "details", event.target.value)}
        />
        <Input aria-label={`Line ${index + 1} quantity`} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
        <Input aria-label={`Line ${index + 1} cost`} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
        <Input aria-label={`Line ${index + 1} price`} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
        <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-semibold text-slate-900 tabular-nums">
          {money(lineTotal)}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            icon={<Plus size={14} />}
            className="w-9 px-0"
            onClick={() => onInsertBelow(line.id)}
            aria-label="Add line below"
            title="Add line below"
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            className="w-9 px-0 text-slate-500 hover:text-red-600"
            onClick={() => onRemove(line.id)}
            aria-label="Remove line"
            title="Remove line"
          />
        </div>
      </div>
    </div>
  );
}

export default QuoteBuilderView;




