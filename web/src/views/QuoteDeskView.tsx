import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { TFunction } from "i18next";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  ExternalLink,
  FileOutput,
  Lock,
  Mail,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useDashboard, formatDateTime, money, type SendChannel } from "../components/dashboard/DashboardContext";
import { AiPaidPauseNotice, KodyFieldAssistButton } from "../components/ai/KodyFieldAssistButton";
import { InvoicePanel } from "../components/invoices/InvoicePanel";
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
import { notify } from "../lib/notifications";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageHeader,
  Select,
  Textarea,
  WorkflowActionDock,
} from "../components/ui";
import { api, ApiError, type AiProgressEvent, type AiQuoteInsight, type AiQuoteRun, type OrganizationUser, type Quote, type QuoteAcceptedJobSummary, type QuoteRevision, type TenantBranding, type WorkPreset } from "../lib/api";
import { aiUsageUpdateFromApiError, formatAiPaidUsagePause, formatAiUsageAvailability, formatAiUsageNotice, publishAiUsageUpdate, resolveAiUsagePresentation } from "../lib/ai-credits";
import { canNativePdfShareOnDevice } from "../lib/quote-pdf-actions";
import {
  isQuoteDraftTimestampFresh,
  quoteDeskDraftStorageKey,
  readQuoteDeskDraft,
  removeQuoteDeskDraft,
  writeQuoteDeskDraft,
} from "../lib/quote-builder-draft-storage";
import {
  isCompleteQuoteLine,
  QUOTE_LINE_CHANGE_LIMIT,
  validateQuoteHeading,
  validateQuoteLine,
} from "../lib/quote-form-validation";
import { formatUsPhoneDisplay } from "../lib/phone";
import {
  applyAiQuoteLinePatch,
  buildPresetPayloadFromLine,
  isIncludedEditableQuoteLine,
  joinQuoteLineDescription,
  makeEditableQuoteLine,
  quoteLineAmount,
  quoteLineCostTotal,
  splitQuoteLineDescription,
  toEditableQuoteLine,
  type EditableQuoteLine,
} from "../lib/quote-lines";
import { usePageView, useTrack } from "../lib/analytics";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { formatQuoteDocumentDate, quoteDocumentCopy } from "../lib/quote-document-copy";
import { localizedApiError } from "../lib/localized-api-error";
import {
  applyQuotePreparationPricingGuard,
  formatQuotePricingReviewLineDescriptions,
  hasUnsupportedStructuralQuotePatch,
  isQuotePricingReviewBlocking,
  parseQuotePricingReviewState,
  resolveQuotePreparationRetryIdentity,
  type QuotePricingReviewState,
} from "../lib/quote-preparation";

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
  t: TFunction,
  serviceType: "HVAC" | "PLUMBING" | "FLOORING" | "ROOFING" | "GARDENING" | "CONSTRUCTION",
  customerName: string,
  customerPhone: string,
  quoteTitle: string,
) {
  const customerLead = `${customerName} ${customerPhone}`.trim();

  const tradeKey = serviceType === "ROOFING" ? "roofing" : serviceType === "HVAC" ? "hvac" : "default";
  return [
    t(`quoteDesk.aiStarters.${tradeKey}.one`, { title: quoteTitle, customer: customerLead }),
    t(`quoteDesk.aiStarters.${tradeKey}.two`, { title: quoteTitle, customer: customerLead }),
  ];
}

function localizedQuoteHeadingError(
  t: TFunction,
  title: string,
  scopeText: string,
  taxAmount: string,
) {
  const error = validateQuoteHeading(title, scopeText, taxAmount);
  if (!error) return null;
  if (error.startsWith("Quote title")) return t("quoteComponents.validation.title");
  if (error.startsWith("Quote scope")) return t("quoteComponents.validation.scope");
  if (error.startsWith("Tax")) return t("quoteComponents.validation.tax");
  return t("quoteComponents.validation.generic");
}

function localizedQuoteLineError(t: TFunction, line: EditableQuoteLine, label: string) {
  const error = validateQuoteLine(line, label);
  if (!error) return null;
  if (error.endsWith("needs a title.")) return t("quoteComponents.validation.lineTitle", { label });
  if (error.includes("option label")) return t("quoteComponents.validation.optionLabel", { label });
  if (error.includes("quantity")) return t("quoteComponents.validation.quantity", { label });
  if (error.includes(" cost ")) return t("quoteComponents.validation.cost", { label });
  if (error.includes(" price ")) return t("quoteComponents.validation.price", { label });
  return t("quoteComponents.validation.generic");
}

type DeskTab = "quote" | "send" | "history" | "log";
type DeskPane = "editor" | "preview";
type PendingOutboundAction = "send-tab" | "email" | "sms" | "copy" | "pdf" | "pdf-preview";
type KodyQuoteSendHandoff = { quoteId: string; channel: SendChannel };
type QuoteDeskAiAssistTarget =
  | { kind: "quote" }
  | { kind: "title" }
  | { kind: "overview" }
  | { kind: "lineDescription"; lineId: string }
  | { kind: "newLineDescription" };
type StoredDeskDraft = {
  version: 1;
  savedAtUtc: string;
  quoteId: string;
  baseUpdatedAtUtc: string;
  quote: {
    serviceType: Quote["serviceType"];
    status: Quote["status"];
    afterSaleFollowUpStatus: Quote["afterSaleFollowUpStatus"];
    title: string;
    scopeText: string;
    taxAmount: string;
    documentLocale: Quote["documentLocale"];
  };
  lines: EditableQuoteLine[];
  newLine: EditableQuoteLine;
  mobilePane: DeskPane;
  aiPricingReview: QuotePricingReviewState | null;
};
type PendingLifecycleStatus = Quote["status"] | null;

const SERVICE_TYPES = new Set(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);
const QUOTE_STATUSES = new Set(["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"]);
const FOLLOW_UP_STATUSES = new Set(["NOT_READY", "DUE", "COMPLETED"]);

function canEditQuoteDocumentLocale(status: Quote["status"]): boolean {
  return status === "DRAFT" || status === "READY_FOR_REVIEW";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function parseKodyQuoteSendHandoff(value: unknown): KodyQuoteSendHandoff | null {
  if (!isRecord(value) || !isRecord(value.kodyQuoteSend)) return null;
  const handoff = value.kodyQuoteSend;
  if (
    !isBoundedString(handoff.quoteId, 200) ||
    !handoff.quoteId.trim() ||
    (handoff.channel !== "email" && handoff.channel !== "sms" && handoff.channel !== "copy")
  ) return null;
  return { quoteId: handoff.quoteId, channel: handoff.channel };
}

function parseStoredDeskLine(value: unknown): EditableQuoteLine | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.id, 200) ||
    !isBoundedString(value.title, 1_000) ||
    !isBoundedString(value.details, 20_000) ||
    (value.sectionType !== "INCLUDED" && value.sectionType !== "ALTERNATE") ||
    !isBoundedString(value.sectionLabel, 80) ||
    !isBoundedString(value.quantity, 100) ||
    !isBoundedString(value.unitCost, 100) ||
    !isBoundedString(value.unitPrice, 100) ||
    (value.sourcePresetId !== undefined && value.sourcePresetId !== null && !isBoundedString(value.sourcePresetId, 200)) ||
    (value.presetPromptHandled !== undefined && typeof value.presetPromptHandled !== "boolean")
  ) return null;

  return {
    ...makeEditableQuoteLine({
    title: value.title,
    details: value.details,
    sectionType: value.sectionType,
    sectionLabel: value.sectionLabel,
    quantity: value.quantity,
    unitCost: value.unitCost,
    unitPrice: value.unitPrice,
    sourcePresetId: value.sourcePresetId as string | null | undefined,
    presetPromptHandled: value.presetPromptHandled as boolean | undefined,
    }),
    id: value.id,
  };
}

function parseStoredDeskDraft(raw: string): StoredDeskDraft | null {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isBoundedString(value.savedAtUtc, 64) ||
    !isQuoteDraftTimestampFresh(value.savedAtUtc) ||
    !isBoundedString(value.quoteId, 200) ||
    !isBoundedString(value.baseUpdatedAtUtc, 64) ||
    !isRecord(value.quote) ||
    !Array.isArray(value.lines) ||
    value.lines.length > QUOTE_LINE_CHANGE_LIMIT ||
    !isRecord(value.newLine) ||
    (value.mobilePane !== "editor" && value.mobilePane !== "preview")
  ) return null;

  const quote = value.quote;
  if (
    !isBoundedString(quote.serviceType, 32) || !SERVICE_TYPES.has(quote.serviceType) ||
    !isBoundedString(quote.status, 32) || !QUOTE_STATUSES.has(quote.status) ||
    !isBoundedString(quote.afterSaleFollowUpStatus, 32) || !FOLLOW_UP_STATUSES.has(quote.afterSaleFollowUpStatus) ||
    !isBoundedString(quote.title, 1_000) ||
    !isBoundedString(quote.scopeText, 20_000) ||
    !isBoundedString(quote.taxAmount, 100)
  ) return null;

  const documentLocale =
    quote.documentLocale === "es-US" || quote.documentLocale === "en-US"
      ? quote.documentLocale
      : "en-US";

  const lines = value.lines.map(parseStoredDeskLine);
  const newLine = parseStoredDeskLine(value.newLine);
  if (lines.some((line) => line === null) || !newLine) return null;
  const aiPricingReview = value.aiPricingReview == null
    ? null
    : parseQuotePricingReviewState(value.aiPricingReview, value.quoteId);
  if (value.aiPricingReview != null && !aiPricingReview) return null;

  return {
    version: 1,
    savedAtUtc: value.savedAtUtc,
    quoteId: value.quoteId,
    baseUpdatedAtUtc: value.baseUpdatedAtUtc,
    quote: {
      serviceType: quote.serviceType as Quote["serviceType"],
      status: quote.status as Quote["status"],
      afterSaleFollowUpStatus: quote.afterSaleFollowUpStatus as Quote["afterSaleFollowUpStatus"],
      title: quote.title,
      scopeText: quote.scopeText,
      taxAmount: quote.taxAmount,
      documentLocale,
    },
    lines: lines as EditableQuoteLine[],
    newLine,
    mobilePane: value.mobilePane,
    aiPricingReview,
  };
}

async function persistStoredDeskDraft(
  storageKey: string,
  draft: StoredDeskDraft,
  options?: { keepalive?: boolean },
) {
  const savedAtUtc = new Date().toISOString();
  const stored = { ...draft, savedAtUtc } satisfies StoredDeskDraft;
  return writeQuoteDeskDraft(storageKey, JSON.stringify(stored), options);
}
const QUOTE_DESK_HEADER_GRID_COLUMNS =
  "xl:grid-cols-[minmax(10rem,0.95fr)_minmax(15rem,1.35fr)_72px_92px_92px_106px_130px] 2xl:grid-cols-[minmax(11rem,1.05fr)_minmax(16rem,1.3fr)_72px_96px_96px_110px_140px]";
const QUOTE_DESK_EXISTING_LINE_GRID_COLUMNS =
  "xl:grid-cols-[32px_minmax(10rem,0.95fr)_minmax(15rem,1.35fr)_72px_92px_92px_104px_120px] 2xl:grid-cols-[36px_minmax(11rem,1.05fr)_minmax(16rem,1.3fr)_72px_96px_96px_108px_128px]";
const QUOTE_DESK_NEW_LINE_GRID_COLUMNS =
  "xl:grid-cols-[32px_minmax(10rem,0.95fr)_minmax(15rem,1.35fr)_72px_92px_92px_104px] 2xl:grid-cols-[36px_minmax(11rem,1.05fr)_minmax(16rem,1.3fr)_72px_96px_96px_108px]";
const QUOTE_DESK_LINE_GRID_MIN_WIDTH = "xl:min-w-[900px] 2xl:min-w-[980px]";

function editableQuoteLinesMatch(left: EditableQuoteLine, right: EditableQuoteLine): boolean {
  return (
    left.title.trim() === right.title.trim() &&
    left.details.trim() === right.details.trim() &&
    left.sectionType === right.sectionType &&
    left.sectionLabel === right.sectionLabel &&
    Number(left.quantity) === Number(right.quantity) &&
    Number(left.unitCost) === Number(right.unitCost) &&
    Number(left.unitPrice) === Number(right.unitPrice)
  );
}

export function QuoteDeskView() {
  usePageView("quote_desk");
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const formatMoney = (value: string | number) => money(value, locale);
  const track = useTrack();
  const navigate = useNavigate();
  const location = useLocation();
  const [lineItemPendingDeleteId, setLineItemPendingDeleteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DeskTab>("quote");
  const [pendingOutboundAction, setPendingOutboundAction] = useState<PendingOutboundAction | null>(null);
  const [pendingOutboundOrigin, setPendingOutboundOrigin] = useState<"kody" | null>(null);
  const [outboundPreparationSaving, setOutboundPreparationSaving] = useState(false);
  const [presetLibrary, setPresetLibrary] = useState<WorkPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedPresetQuantity, setSelectedPresetQuantity] = useState("1");
  const [editableLines, setEditableLines] = useState<EditableQuoteLine[]>([]);
  const [newLine, setNewLine] = useState<EditableQuoteLine>(makeEditableQuoteLine());
  const [hydratedDeskDraftKey, setHydratedDeskDraftKey] = useState<string | null>(null);
  const [deskDraftRestored, setDeskDraftRestored] = useState(false);
  const [deskDraftSavedAtUtc, setDeskDraftSavedAtUtc] = useState<string | null>(null);
  const [deskDraftPersistenceFailed, setDeskDraftPersistenceFailed] = useState(false);
  const [deskDraftRecoveryMessage, setDeskDraftRecoveryMessage] = useState<string | null>(null);
  const [deskDraftRecoveryStatus, setDeskDraftRecoveryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [deskDraftRecoveryAttempt, setDeskDraftRecoveryAttempt] = useState(0);
  const [conflictingDeskDraft, setConflictingDeskDraft] = useState<StoredDeskDraft | null>(null);
  const latestDeskDraftRef = useRef<{ draft: StoredDeskDraft; hasChanges: boolean } | null>(null);
  const handledKodySendRef = useRef<string | null>(null);
  const preventDeskDraftPersistenceRef = useRef(false);
  const editableQuoteIdRef = useRef<string | null>(null);
  const savedLineBaselineRef = useRef<Map<string, EditableQuoteLine>>(new Map());
  const [presetPromptLine, setPresetPromptLine] = useState<EditableQuoteLine | null>(null);
  const [presetPromptSaving, setPresetPromptSaving] = useState(false);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiAssistTarget, setAiAssistTarget] = useState<QuoteDeskAiAssistTarget>({ kind: "quote" });
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiProgressEvent, setAiProgressEvent] = useState<AiProgressEvent | null>(null);
  const [aiErrorMessage, setAiErrorMessage] = useState<string | null>(null);
  const [aiInsight, setAiInsight] = useState<AiQuoteInsight | null>(null);
  const [aiPricingReview, setAiPricingReview] = useState<QuotePricingReviewState | null>(null);
  const aiRequestRef = useRef<{
    id: string;
    controller: AbortController;
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  const aiRetryIdentityRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const [aiRuns, setAiRuns] = useState<AiQuoteRun[]>([]);
  const [aiRunsLoading, setAiRunsLoading] = useState(false);
  const [unlockConfirmOpen, setUnlockConfirmOpen] = useState(false);
  const [quoteRetentionAction, setQuoteRetentionAction] = useState<"archive" | "delete" | null>(null);
  const [quoteRetentionSaving, setQuoteRetentionSaving] = useState(false);
  const [restoreRevisionTarget, setRestoreRevisionTarget] = useState<QuoteRevision | null>(null);
  const [restoreRevisionSaving, setRestoreRevisionSaving] = useState(false);
  const [pendingLifecycleStatus, setPendingLifecycleStatus] = useState<PendingLifecycleStatus>(null);
  const [acceptedJobAction, setAcceptedJobAction] = useState<QuoteAcceptedJobSummary | null>(null);
  const [lifecyclePreparationSaving, setLifecyclePreparationSaving] = useState(false);
  const [isEditUnlocked, setIsEditUnlocked] = useState(true);
  const [mobilePane, setMobilePane] = useState<DeskPane>("editor");
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<OrganizationUser[]>([]);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  useEffect(() => () => {
    aiRequestRef.current?.controller.abort();
  }, []);
  const canSharePdfFromDevice = useMemo(() => canNativePdfShareOnDevice(), []);
  const {
    session,
    selectedQuoteId,
    focusQuoteDesk,
    selectedQuote,
    quoteDetailLoading,
    quoteDetailError,
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
    saveQuoteSheet,
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
    canViewInternalCosts,
    canManageCatalog,
    canManageAssignments,
    canManageRecordRetention,
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
    loadQuotes,
    loadQuoteHistory,
    refreshSelectedQuote,
    retrySelectedQuote,
    loadOutboundEvents,
    navigateToBuilder,
    navigateToQuote,
  } = useDashboard();
  const canCreateInvoices = session?.role === "owner" || session?.role === "admin";

  useEffect(() => {
    setAcceptedJobAction(null);
  }, [selectedQuote?.id]);
  const formatLocalDateTime = (value: string | null | undefined) => value ? formatDateTime(value, locale, session?.timezone) : "—";
  const { quoteId } = useParams<{ quoteId: string }>();
  const deskDraftStorageKey = useMemo(
    () => session && quoteId ? quoteDeskDraftStorageKey(session.tenantId, session.userId, quoteId) : null,
    [quoteId, session],
  );

  useEffect(() => {
    if (!canManageAssignments) return;
    let mounted = true;
    api.org.users.list({ limit: 100 })
      .then((result) => { if (mounted) setWorkspaceMembers(result.members); })
      .catch(() => { if (mounted) setWorkspaceMembers([]); });
    return () => { mounted = false; };
  }, [canManageAssignments]);

  const updateQuoteAssignment = useCallback(async (assignedTenantUserId: string) => {
    if (!selectedQuote || !canManageAssignments || assignmentSaving) return;
    setAssignmentSaving(true);
    setError(null);
    try {
      await api.quotes.update(selectedQuote.id, { assignedTenantUserId: assignedTenantUserId || null });
      await refreshSelectedQuote();
      setNotice(assignedTenantUserId ? t("quoteDesk.notices.assignmentUpdated") : t("quoteDesk.notices.unassigned"));
    } catch (error) {
      setError(localizedApiError(error, t, { fallbackKey: "quoteDesk.errors.assignment" }));
    } finally {
      setAssignmentSaving(false);
    }
  }, [assignmentSaving, canManageAssignments, refreshSelectedQuote, selectedQuote, setError, setNotice, t]);

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

    api.products
      .list()
      .then((result) => {
        if (!mounted) return;
        setPresetLibrary(result.products);
      })
      .catch(() => {
        if (!mounted) return;
        setPresetLoadError(t("quoteBuilder.errors.catalogLoad"));
      })
      .finally(() => {
        if (mounted) setPresetsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [t]);

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
      editableQuoteIdRef.current = null;
      savedLineBaselineRef.current = new Map();
      setEditableLines([]);
      setNewLine(makeEditableQuoteLine());
      setAiInsight(null);
      setAiPricingReview(null);
      setAiRuns([]);
      return;
    }

    const serverLines = (selectedQuote.lineItems ?? []).map(toEditableQuoteLine);
    const nextBaseline = new Map(serverLines.map((line) => [line.id, line] as const));

    if (editableQuoteIdRef.current !== selectedQuote.id) {
      editableQuoteIdRef.current = selectedQuote.id;
      savedLineBaselineRef.current = nextBaseline;
      setEditableLines(serverLines);
      setNewLine(makeEditableQuoteLine());
      setMobilePane("editor");
      setAiInsight(null);
      setAiPricingReview(null);
      setAiRuns([]);
      return;
    }

    const previousBaseline = savedLineBaselineRef.current;
    setEditableLines((currentLines) => {
      const currentLineMap = new Map(currentLines.map((line) => [line.id, line] as const));
      const reconciledServerLines = serverLines.map((serverLine) => {
        const currentLine = currentLineMap.get(serverLine.id);
        const previousSavedLine = previousBaseline.get(serverLine.id);
        const hasLocalDraft = Boolean(
          currentLine && previousSavedLine && !editableQuoteLinesMatch(currentLine, previousSavedLine),
        );

        if (!hasLocalDraft || !currentLine) return serverLine;
        return editableQuoteLinesMatch(currentLine, serverLine) ? serverLine : currentLine;
      });
      const localOnlyDrafts = currentLines.filter(
        (line) => !nextBaseline.has(line.id) && !previousBaseline.has(line.id),
      );

      return [...reconciledServerLines, ...localOnlyDrafts];
    });
    savedLineBaselineRef.current = nextBaseline;
  }, [selectedQuote]);

  const requiresExplicitUnlock = useMemo(() => {
    if (!selectedQuote) return false;
    return ["SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"].includes(selectedQuote.status);
  }, [selectedQuote]);

  useEffect(() => {
    setIsEditUnlocked(!requiresExplicitUnlock);
  }, [selectedQuote?.id, requiresExplicitUnlock]);

  const loadAiRuns = useCallback(async (targetQuoteId = selectedQuote?.id) => {
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
      setError(localizedApiError(err, t, { fallbackKey: "quoteDesk.errors.aiRuns" }));
    } finally {
      setAiRunsLoading(false);
    }
  }, [selectedQuote?.id, setError, t]);

  useEffect(() => {
    if (activeTab !== "history" || !selectedQuote?.id) return;
    void loadAiRuns(selectedQuote.id);
  }, [activeTab, selectedQuote?.id, loadAiRuns]);

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
  }, [selectedQuote]);

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

  const completeDraftNewLine = useMemo(() => isCompleteQuoteLine(newLine) ? newLine : null, [newLine]);
  const effectiveEditableLines = useMemo(
    () => completeDraftNewLine ? [...editableLines, completeDraftNewLine] : editableLines,
    [completeDraftNewLine, editableLines],
  );
  const lineItemCount = effectiveEditableLines.length;
  const includedEditableLines = useMemo(
    () => effectiveEditableLines.filter((line) => isIncludedEditableQuoteLine(line)),
    [effectiveEditableLines],
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
  const sentDateLabel = selectedQuote?.sentAt
    ? formatQuoteDocumentDate(selectedQuote.sentAt, quoteEditForm.documentLocale, session?.timezone)
    : quoteDocumentCopy(quoteEditForm.documentLocale).notAvailable;
  const customerName = selectedQuote?.customer?.fullName ?? t("quoteDesk.customerUnavailable");
  const customerPhone = selectedQuote?.customer?.phone ?? t("quoteDesk.noPhone");
  const customerEmail = selectedQuote?.customer?.email ?? null;
  const previewLines = useMemo(
    () =>
      effectiveEditableLines.map((line) => ({
        id: line.id,
        title: line.title,
        details: line.details,
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: quoteLineAmount(line.quantity, line.unitPrice),
    })),
    [effectiveEditableLines],
  );
  const businessHint = useMemo(() => buildBusinessHint(branding), [branding]);
  const quoteAccentColor = useMemo(() => resolveQuoteAccentColor(branding), [branding]);
  const quoteFooterText = useMemo(
    () =>
      buildQuoteFooterText({
        businessName: session?.tenantName ?? "QuoteFly",
        businessPhone: branding?.businessPhone ?? null,
        businessEmail: branding?.businessEmail ?? null,
        documentLocale: quoteEditForm.documentLocale,
      }),
    [branding?.businessEmail, branding?.businessPhone, quoteEditForm.documentLocale, session?.tenantName],
  );
  const showQuoteFlyAttribution = useMemo(
    () => shouldShowQuoteFlyAttribution(session?.effectivePlanCode, branding?.hideQuoteFlyAttribution),
    [branding?.hideQuoteFlyAttribution, session?.effectivePlanCode],
  );
  const selectedQuoteTitle = selectedQuote?.title ?? t("quoteDesk.currentQuote");
  const aiUsage = useMemo(() => resolveAiUsagePresentation(session?.usage), [session?.usage]);
  const aiUsageLimitMessage = useMemo(
    () => formatAiPaidUsagePause(session?.usage ?? {}, locale),
    [locale, session?.usage],
  );
  const aiUsageHint = useMemo(
    () =>
      formatAiUsageAvailability({
        usage: session?.usage,
      }, locale),
    [
      session?.usage,
      locale,
    ],
  );
  const aiPromptStarters = useMemo(
    () =>
      buildDeskAiPromptStarters(
        t,
        quoteEditForm.serviceType,
        customerName,
        customerPhone,
        quoteEditForm.title || selectedQuoteTitle,
      ),
    [customerName, customerPhone, quoteEditForm.serviceType, quoteEditForm.title, selectedQuoteTitle, t],
  );
  const isQuoteLocked = requiresExplicitUnlock && !isEditUnlocked;
  const metadataDirty = useMemo(() => {
    if (!selectedQuote) return false;
    return (
      quoteEditForm.serviceType !== selectedQuote.serviceType ||
      quoteEditForm.status !== selectedQuote.status ||
      quoteEditForm.afterSaleFollowUpStatus !== selectedQuote.afterSaleFollowUpStatus ||
      quoteEditForm.title !== selectedQuote.title ||
      quoteEditForm.scopeText !== selectedQuote.scopeText ||
      String(Number(quoteEditForm.taxAmount)) !== String(Number(selectedQuote.taxAmount)) ||
      quoteEditForm.documentLocale !== selectedQuote.documentLocale
    );
  }, [quoteEditForm, selectedQuote]);
  const hasDraftNewLine = useMemo(
    () =>
      Boolean(
        newLine.title.trim() ||
          newLine.details.trim() ||
          Number(newLine.quantity) !== 1 ||
          Number(newLine.unitCost) !== 0 ||
          Number(newLine.unitPrice) !== 0,
      ),
    [newLine],
  );
  const activeAiPricingReview = aiPricingReview?.quoteId === selectedQuote?.id ? aiPricingReview : null;
  const hasUnsavedQuoteSheetChanges = metadataDirty || dirtyLineIds.length > 0 || hasDraftNewLine || Boolean(activeAiPricingReview);

  useEffect(() => {
    const handoff = parseKodyQuoteSendHandoff(location.state);
    if (!handoff) {
      handledKodySendRef.current = null;
      return;
    }
    if (!selectedQuote || selectedQuote.id !== handoff.quoteId) return;
    const handoffKey = `${handoff.quoteId}:${handoff.channel}`;
    if (handledKodySendRef.current === handoffKey) return;
    handledKodySendRef.current = handoffKey;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });

    if (hasUnsavedQuoteSheetChanges) {
      setActiveTab("quote");
      setMobilePane("editor");
      setPendingOutboundOrigin("kody");
      setPendingOutboundAction(handoff.channel);
      return;
    }

    setActiveTab("send");
    openSendComposer(handoff.channel, selectedQuote, { origin: "kody" });
  }, [hasUnsavedQuoteSheetChanges, location.pathname, location.search, location.state, navigate, openSendComposer, selectedQuote]);
  const currentDeskDraft = useMemo<StoredDeskDraft | null>(
    () => selectedQuote ? {
      version: 1,
      savedAtUtc: new Date().toISOString(),
      quoteId: selectedQuote.id,
      baseUpdatedAtUtc: selectedQuote.updatedAt,
      quote: {
        serviceType: quoteEditForm.serviceType,
        status: quoteEditForm.status,
        afterSaleFollowUpStatus: quoteEditForm.afterSaleFollowUpStatus,
        title: quoteEditForm.title,
        scopeText: quoteEditForm.scopeText,
        taxAmount: quoteEditForm.taxAmount,
        documentLocale: quoteEditForm.documentLocale,
      },
      lines: editableLines,
      newLine,
      mobilePane,
      aiPricingReview: activeAiPricingReview,
    } : null,
    [activeAiPricingReview, editableLines, mobilePane, newLine, quoteEditForm, selectedQuote],
  );
  latestDeskDraftRef.current = currentDeskDraft ? { draft: currentDeskDraft, hasChanges: hasUnsavedQuoteSheetChanges } : null;

  const applyStoredDeskDraft = useCallback((stored: StoredDeskDraft) => {
    setQuoteEditForm({ ...stored.quote });
    setEditableLines(stored.lines);
    setNewLine(stored.newLine);
    setAiPricingReview(stored.aiPricingReview);
    setMobilePane(stored.mobilePane);
    setActiveTab("quote");
    setDeskDraftSavedAtUtc(stored.savedAtUtc);
    setDeskDraftPersistenceFailed(false);
    setDeskDraftRestored(true);
    setConflictingDeskDraft(null);
  }, [setQuoteEditForm]);

  useEffect(() => {
    if (!deskDraftStorageKey || !selectedQuote || hydratedDeskDraftKey === deskDraftStorageKey) return;
    let cancelled = false;
    preventDeskDraftPersistenceRef.current = false;
    setDeskDraftRestored(false);
    setDeskDraftRecoveryMessage(null);
    setDeskDraftRecoveryStatus("loading");
    void (async () => {
      let hydrationDeferred = false;
      let recoveryFailed = false;
      try {
        const result = await readQuoteDeskDraft(deskDraftStorageKey);
        if (cancelled) return;
        if (result.status === "error") {
          recoveryFailed = true;
          setDeskDraftRecoveryStatus("error");
          return;
        }
        if (result.status === "not-found") return;
        const stored = parseStoredDeskDraft(result.raw);
        if (!stored || stored.quoteId !== selectedQuote.id) {
          await removeQuoteDeskDraft(deskDraftStorageKey);
          if (!cancelled) setDeskDraftRecoveryMessage(t("quoteDesk.recovery.incompatible"));
          return;
        }
        if (stored.baseUpdatedAtUtc !== selectedQuote.updatedAt) {
          hydrationDeferred = true;
          setConflictingDeskDraft(stored);
          return;
        }
        applyStoredDeskDraft(stored);
      } catch {
        await removeQuoteDeskDraft(deskDraftStorageKey);
        if (!cancelled) setDeskDraftRecoveryMessage(t("quoteDesk.recovery.unreadable"));
      } finally {
        if (!cancelled && !hydrationDeferred && !recoveryFailed) {
          setDeskDraftRecoveryStatus("ready");
          setHydratedDeskDraftKey(deskDraftStorageKey);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyStoredDeskDraft, deskDraftRecoveryAttempt, deskDraftStorageKey, hydratedDeskDraftKey, selectedQuote, t]);

  useEffect(() => {
    if (!deskDraftStorageKey || hydratedDeskDraftKey !== deskDraftStorageKey || !currentDeskDraft) return;
    if (preventDeskDraftPersistenceRef.current) return;
    if (!hasUnsavedQuoteSheetChanges) {
      void removeQuoteDeskDraft(deskDraftStorageKey);
      setDeskDraftSavedAtUtc(null);
      setDeskDraftPersistenceFailed(false);
      setDeskDraftRestored(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void persistStoredDeskDraft(deskDraftStorageKey, currentDeskDraft).then((savedAtUtc) => {
        if (cancelled) return;
        setDeskDraftSavedAtUtc(savedAtUtc);
        setDeskDraftPersistenceFailed(!savedAtUtc);
      });
    }, 650);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentDeskDraft, deskDraftStorageKey, hasUnsavedQuoteSheetChanges, hydratedDeskDraftKey]);

  useEffect(() => {
    if (!deskDraftStorageKey || hydratedDeskDraftKey !== deskDraftStorageKey) return;
    const persistLatestDraft = () => {
      const latest = latestDeskDraftRef.current;
      if (!latest?.hasChanges || preventDeskDraftPersistenceRef.current) return;
      void persistStoredDeskDraft(deskDraftStorageKey, latest.draft, { keepalive: true });
    };
    window.addEventListener("pagehide", persistLatestDraft);
    return () => {
      window.removeEventListener("pagehide", persistLatestDraft);
      persistLatestDraft();
    };
  }, [deskDraftStorageKey, hydratedDeskDraftKey]);

  const {
    navigationPromptOpen,
    requestNavigation,
    cancelNavigation,
    continueNavigation,
  } = useUnsavedChangesGuard(hasUnsavedQuoteSheetChanges && hydratedDeskDraftKey === deskDraftStorageKey && !saving);

  function clearStoredDeskDraft() {
    preventDeskDraftPersistenceRef.current = true;
    if (deskDraftStorageKey && hydratedDeskDraftKey === deskDraftStorageKey) {
      void removeQuoteDeskDraft(deskDraftStorageKey);
    }
    setDeskDraftSavedAtUtc(null);
    setDeskDraftPersistenceFailed(false);
    setDeskDraftRestored(false);
    setConflictingDeskDraft(null);
    window.setTimeout(() => {
      preventDeskDraftPersistenceRef.current = false;
    }, 0);
  }

  function retryDeskDraftRecovery() {
    if (!deskDraftStorageKey || deskDraftRecoveryStatus === "loading") return;
    setDeskDraftRecoveryMessage(null);
    setDeskDraftRecoveryAttempt((current) => current + 1);
  }

  async function startFreshAfterDeskRecoveryError() {
    if (!deskDraftStorageKey || !selectedQuote) return;
    setDeskDraftRecoveryStatus("loading");
    setDeskDraftRecoveryMessage(null);
    const cleared = await removeQuoteDeskDraft(deskDraftStorageKey);
    if (!cleared) {
      setDeskDraftRecoveryStatus("error");
      setDeskDraftRecoveryMessage(t("quoteDesk.recovery.clearFailed"));
      return;
    }
    preventDeskDraftPersistenceRef.current = true;
    restoreQuoteSheetFromSelectedQuote();
    setDeskDraftRecoveryStatus("ready");
    setHydratedDeskDraftKey(deskDraftStorageKey);
    setNotice(t("quoteDesk.notices.recoveryFresh"));
    window.setTimeout(() => {
      preventDeskDraftPersistenceRef.current = false;
    }, 0);
  }

  function restoreConflictingDeskDraft() {
    if (!conflictingDeskDraft || !deskDraftStorageKey) return;
    applyStoredDeskDraft(conflictingDeskDraft);
    setHydratedDeskDraftKey(deskDraftStorageKey);
    setNotice(t("quoteDesk.notices.recoveryRestored"));
  }

  function useLatestSavedQuote() {
    if (!deskDraftStorageKey) return;
    void removeQuoteDeskDraft(deskDraftStorageKey);
    setConflictingDeskDraft(null);
    setHydratedDeskDraftKey(deskDraftStorageKey);
    setDeskDraftRestored(false);
    setDeskDraftSavedAtUtc(null);
    setAiPricingReview(null);
    setNotice(t("quoteDesk.notices.latestSaved"));
  }

  function updateEditableLine(lineId: string, field: keyof EditableQuoteLine, value: string) {
    setEditableLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line)),
    );
  }

  async function saveLine(lineId: string): Promise<boolean> {
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return false;
    }
    if (isQuotePricingReviewBlocking(activeAiPricingReview, selectedQuote?.id)) {
      setError(t("quoteBuilder.aiPricingReview.description"));
      return false;
    }
    const line = editableLines.find((entry) => entry.id === lineId);
    if (!line) return false;
    const lineError = localizedQuoteLineError(t, line, t("quoteDesk.line.number", { number: editableLines.findIndex((entry) => entry.id === lineId) + 1 }));
    if (lineError) {
      setError(lineError);
      return false;
    }

    track("quote_line_save");
    return updateLineItem(
      lineId,
      {
        description: joinQuoteLineDescription(line.title, line.details),
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel || null,
        quantity: Number(line.quantity) || 1,
        unitCost: Number(line.unitCost) || 0,
        unitPrice: Number(line.unitPrice) || 0,
      },
      { notice: t("quoteDesk.notices.lineSaved", { name: line.title }) },
    );
  }

  async function addNewLine(options?: { offerPreset?: boolean }): Promise<boolean> {
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return false;
    }
    const lineError = localizedQuoteLineError(t, newLine, t("quoteDesk.line.new"));
    if (lineError) {
      setError(lineError);
      return false;
    }

    const lineToMaybeSave = newLine;
    track("quote_line_add");
    const added = await addLineItemDraft(
      {
        description: joinQuoteLineDescription(lineToMaybeSave.title, lineToMaybeSave.details),
        sectionType: lineToMaybeSave.sectionType,
        sectionLabel: lineToMaybeSave.sectionLabel || null,
        quantity: Number(lineToMaybeSave.quantity) || 1,
        unitCost: Number(lineToMaybeSave.unitCost) || 0,
        unitPrice: Number(lineToMaybeSave.unitPrice) || 0,
        sourcePresetId: lineToMaybeSave.sourcePresetId ?? undefined,
      },
      {
        notice: t("quoteDesk.notices.lineAdded", { name: lineToMaybeSave.title }),
      },
    );
    if (!added) return false;
    setNewLine(makeEditableQuoteLine());
    if (
      canManageCatalog &&
      options?.offerPreset !== false &&
      lineToMaybeSave.title.trim() &&
      !lineToMaybeSave.sourcePresetId &&
      !savedPresetKeys.has(
        `${quoteEditForm.serviceType}:${lineToMaybeSave.title.trim().toLowerCase()}:${lineToMaybeSave.details.trim().toLowerCase()}`,
      )
    ) {
      setPresetPromptLine(lineToMaybeSave);
    }
    return true;
  }

  async function handleSaveQuoteSheet(options?: { offerPreset?: boolean }): Promise<Quote | null> {
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return null;
    }
    const headingError = localizedQuoteHeadingError(t, quoteEditForm.title, quoteEditForm.scopeText, quoteEditForm.taxAmount);
    if (headingError) {
      setError(headingError);
      return null;
    }
    if (isQuotePricingReviewBlocking(activeAiPricingReview, selectedQuote?.id)) {
      setError(t("quoteBuilder.aiPricingReview.description"));
      return null;
    }
    const changedLines = editableLines.filter((line) => dirtyLineIds.includes(line.id));
    const linesToValidate = hasDraftNewLine ? [...changedLines, newLine] : changedLines;
    if (linesToValidate.length > QUOTE_LINE_CHANGE_LIMIT) {
      setError(t("quoteDesk.errors.lineLimit", { count: QUOTE_LINE_CHANGE_LIMIT }));
      return null;
    }
    const invalidLineIndex = linesToValidate.findIndex((line) => validateQuoteLine(line) !== null);
    if (invalidLineIndex >= 0) {
      setError(localizedQuoteLineError(t, linesToValidate[invalidLineIndex], t("quoteDesk.line.changed", { number: invalidLineIndex + 1 })));
      return null;
    }

    const linePayload = (line: EditableQuoteLine) => ({
      description: joinQuoteLineDescription(line.title, line.details),
      sectionType: line.sectionType,
      sectionLabel: line.sectionLabel || null,
      quantity: Number(line.quantity) || 1,
      unitCost: Number(line.unitCost) || 0,
      unitPrice: Number(line.unitPrice) || 0,
      sourcePresetId: line.sourcePresetId ?? undefined,
    });
    const lineToMaybeSave = newLine.title.trim() ? newLine : null;
    track("quote_sheet_save");
    const savedQuote = await saveQuoteSheet({
      quote: {
        serviceType: quoteEditForm.serviceType,
        status: quoteEditForm.status,
        afterSaleFollowUpStatus: quoteEditForm.afterSaleFollowUpStatus,
        title: quoteEditForm.title,
        scopeText: quoteEditForm.scopeText,
        taxAmount: Number(quoteEditForm.taxAmount),
        documentLocale: quoteEditForm.documentLocale,
      },
      lineItems: editableLines
        .filter((line) => dirtyLineIds.includes(line.id))
        .map((line) => ({ id: line.id, ...linePayload(line) })),
      newLineItems: lineToMaybeSave ? [linePayload(lineToMaybeSave)] : [],
    });
    if (!savedQuote) return null;
    clearStoredDeskDraft();
    setAiPricingReview(null);

    if (lineToMaybeSave) {
      setNewLine(makeEditableQuoteLine());
      if (
        options?.offerPreset !== false &&
        !lineToMaybeSave.sourcePresetId &&
        !savedPresetKeys.has(
          `${quoteEditForm.serviceType}:${lineToMaybeSave.title.trim().toLowerCase()}:${lineToMaybeSave.details.trim().toLowerCase()}`,
        )
      ) {
        setPresetPromptLine(lineToMaybeSave);
      }
    }
    return savedQuote;
  }

  async function runOutboundAction(
    action: PendingOutboundAction,
    quoteOverride = selectedQuote,
    origin?: "kody",
  ) {
    if (isQuotePricingReviewBlocking(activeAiPricingReview, quoteOverride?.id)) {
      setActiveTab("quote");
      setMobilePane("editor");
      setError(t("quoteBuilder.aiPricingReview.description"));
      return;
    }
    if (action === "pdf-preview") {
      await downloadQuotePdf({ inline: true, quoteOverride: quoteOverride ?? undefined });
      return;
    }
    setActiveTab("send");
    if (action === "send-tab") return;
    if (action === "pdf") {
      await downloadQuotePdf({ quoteOverride: quoteOverride ?? undefined });
      return;
    }
    openSendComposer(action, quoteOverride ?? undefined, { origin });
  }

  function requestOutboundAction(action: PendingOutboundAction) {
    if (isQuotePricingReviewBlocking(activeAiPricingReview, selectedQuote?.id)) {
      setActiveTab("quote");
      setMobilePane("editor");
      setError(t("quoteBuilder.aiPricingReview.description"));
      return;
    }
    if (hasUnsavedQuoteSheetChanges) {
      setActiveTab("quote");
      setMobilePane("editor");
      setPendingOutboundOrigin(null);
      setPendingOutboundAction(action);
      return;
    }
    void runOutboundAction(action);
  }

  function cancelOutboundPreparation() {
    if (outboundPreparationSaving) return;
    setPendingOutboundAction(null);
    setPendingOutboundOrigin(null);
    setActiveTab("quote");
    setMobilePane("editor");
  }

  function discardEditsAndContinueOutbound() {
    if (!pendingOutboundAction || outboundPreparationSaving) return;
    const action = pendingOutboundAction;
    const origin = pendingOutboundOrigin ?? undefined;
    revertQuoteSheetToLastSaved();
    setPendingOutboundAction(null);
    setPendingOutboundOrigin(null);
    void runOutboundAction(action, selectedQuote, origin);
  }

  async function requestLifecycleUpdate(status: Quote["status"]) {
    if (!selectedQuote) return;
    if (isQuotePricingReviewBlocking(activeAiPricingReview, selectedQuote.id)) {
      setActiveTab("quote");
      setMobilePane("editor");
      setError(t("quoteBuilder.aiPricingReview.description"));
      return;
    }
    if (hasUnsavedQuoteSheetChanges) {
      setPendingLifecycleStatus(status);
      setActiveTab("quote");
      setMobilePane("editor");
      return;
    }
    const result = await updateQuoteLifecycle(selectedQuote.id, { status });
    setAcceptedJobAction(status === "ACCEPTED" && result?.job ? result.job : null);
  }

  function discardEditsAndContinueLifecycle() {
    if (!pendingLifecycleStatus || !selectedQuote || lifecyclePreparationSaving) return;
    const status = pendingLifecycleStatus;
    revertQuoteSheetToLastSaved();
    setPendingLifecycleStatus(null);
    void updateQuoteLifecycle(selectedQuote.id, { status }).then((result) => {
      setAcceptedJobAction(status === "ACCEPTED" && result?.job ? result.job : null);
    });
  }

  async function saveAndContinueLifecycle() {
    if (!pendingLifecycleStatus || !selectedQuote || lifecyclePreparationSaving) return;
    const status = pendingLifecycleStatus;
    setLifecyclePreparationSaving(true);
    const savedQuote = await handleSaveQuoteSheet({ offerPreset: false });
    if (savedQuote) {
      setPendingLifecycleStatus(null);
      const result = await updateQuoteLifecycle(savedQuote.id, { status });
      setAcceptedJobAction(status === "ACCEPTED" && result?.job ? result.job : null);
    }
    setLifecyclePreparationSaving(false);
  }

  async function saveAndContinueOutbound() {
    if (!pendingOutboundAction || !selectedQuote || outboundPreparationSaving) return;
    const action = pendingOutboundAction;
    const origin = pendingOutboundOrigin ?? undefined;
    setOutboundPreparationSaving(true);
    const persistedQuote = await handleSaveQuoteSheet({ offerPreset: false });
    if (!persistedQuote) {
      setPendingOutboundAction(null);
      setPendingOutboundOrigin(null);
      setActiveTab("quote");
      setMobilePane("editor");
      setOutboundPreparationSaving(false);
      return;
    }

    try {
      setPendingOutboundAction(null);
      setPendingOutboundOrigin(null);
      await runOutboundAction(action, persistedQuote, origin);
    } catch (err) {
      setPendingOutboundAction(null);
      setPendingOutboundOrigin(null);
      setActiveTab("quote");
      setMobilePane("editor");
      setError(localizedApiError(err, t, { fallbackKey: "quoteDesk.errors.reloadSend" }));
    } finally {
      setOutboundPreparationSaving(false);
    }
  }

  function buildDeskAiAssistPrompt(target: QuoteDeskAiAssistTarget) {
    const trade = t(`domain.trade.${quoteEditForm.serviceType}`);
    const title = quoteEditForm.title.trim() || selectedQuote?.title?.trim() || t("quoteDesk.currentQuote");
    const overview = quoteEditForm.scopeText.trim();
    const targetLine =
      target.kind === "lineDescription"
        ? editableLines.find((line) => line.id === target.lineId) ?? null
        : target.kind === "newLineDescription"
          ? newLine
          : null;
    const lineDescription = targetLine ? joinQuoteLineDescription(targetLine.title, targetLine.details).trim() : "";

    if (target.kind === "title") {
      return t("quoteDesk.assistPrompts.title", {
        customer: customerName,
        trade,
        title,
        overview: overview || t("quoteBuilder.assistPrompts.blank"),
      });
    }

    if (target.kind === "overview") {
      return t("quoteDesk.assistPrompts.overview", {
        customer: customerName,
        trade,
        title,
        overview: overview || t("quoteBuilder.assistPrompts.blank"),
      });
    }

    if (target.kind === "lineDescription" || target.kind === "newLineDescription") {
      return t("quoteDesk.assistPrompts.lineDescription", {
        customer: customerName,
        trade,
        title,
        line: lineDescription || t("quoteBuilder.assistPrompts.blank"),
      });
    }

    return [
      t("quoteDesk.kodyPrompt.help", { customer: customerName }),
      t("quoteDesk.kodyPrompt.title", { title }),
      selectedQuote ? t("quoteDesk.kodyPrompt.status", { status: t(`domain.quoteStatus.${selectedQuote.status}`) }) : "",
      t("quoteDesk.kodyPrompt.guidance"),
    ].filter(Boolean).join("\n");
  }

  function openDeskAiAssist(target: QuoteDeskAiAssistTarget) {
    if (!selectedQuote) {
      setError(t("quoteDesk.errors.openForAi"));
      return;
    }
    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }
    if (!canUseChatToQuote || aiUsage.paidActionsUnavailable) {
      setError(t("quoteDesk.errors.aiUnavailable"));
      return;
    }
    setAiAssistTarget(target);
    setAiErrorMessage(null);
    setChatPrompt(buildDeskAiAssistPrompt(target));
    setAiModalOpen(true);
  }

  async function handleAiSuggestSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedQuote) {
      setError(t("quoteDesk.errors.openForAi"));
      return;
    }

    if (isQuoteLocked) {
      setUnlockConfirmOpen(true);
      return;
    }

    if (!canUseChatToQuote || aiUsage.paidActionsUnavailable) {
      setError(t("quoteDesk.errors.aiUnavailable"));
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setError(t("quoteDesk.errors.promptRequired"));
      return;
    }

    if (aiUsage.paidActionsUnavailable) {
      setAiErrorMessage(aiUsageLimitMessage);
      return;
    }

    const requestBody = {
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
    };
    const fingerprint = JSON.stringify(requestBody);
    const retryIdentity = resolveQuotePreparationRetryIdentity(
      aiRetryIdentityRef.current,
      fingerprint,
      () => `qf-ai-${crypto.randomUUID()}`,
    );
    const idempotencyKey = retryIdentity.idempotencyKey;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    aiRequestRef.current?.controller.abort();
    aiRequestRef.current = { id: requestId, controller, ...retryIdentity };

    track("quote_desk_ai_modal_submit");
    try {
      setAiSubmitting(true);
      setAiProgressEvent(null);
      setAiErrorMessage(null);
      const result = await api.quotes.suggestWithAi(requestBody, {
        onProgress: (progress) => {
          if (aiRequestRef.current?.id === requestId && !controller.signal.aborted) {
            setAiProgressEvent(progress);
          }
        },
        idempotencyKey,
        signal: controller.signal,
      });
      if (aiRequestRef.current?.id !== requestId || controller.signal.aborted) return;
      if (result.status !== "READY") {
        throw new ApiError(
          result.preparation.clarification.message ?? t("quoteDesk.errors.aiApply"),
          422,
          result.preparation,
        );
      }
      const { customer, parsed, suggestion, patch, preparation, insight, usage } = result;
      const guarded = applyQuotePreparationPricingGuard({ preparation, suggestion, patch });
      const reviewedSuggestion = guarded.suggestion;
      const reviewedPatch = guarded.patch;

      if (aiAssistTarget.kind === "quote" && hasUnsupportedStructuralQuotePatch(reviewedPatch)) {
        const message = t("quoteDesk.errors.aiStructuralPatch", {
          defaultValue: "Kody can update existing quote lines here, but adding or removing lines needs manual review. Ask Kody for updates only, then add or remove lines in the quote sheet.",
        });
        aiRetryIdentityRef.current = { fingerprint, idempotencyKey };
        setAiErrorMessage(message);
        setError(message);
        publishAiUsageUpdate(usage);
        return;
      }
      aiRetryIdentityRef.current = null;

      setChatParsed(parsed);
      setChatPrompt("");

      if (aiAssistTarget.kind !== "quote") {
        if (aiAssistTarget.kind === "title") {
          const nextTitle = reviewedSuggestion.title.trim();
          if (nextTitle) {
            setQuoteEditForm((prev) => ({ ...prev, title: nextTitle }));
          }
          setNotice(t("quoteDesk.notices.aiTitleApplied"));
        } else if (aiAssistTarget.kind === "overview") {
          const nextOverview =
            reviewedSuggestion.scopeText.trim() ||
            reviewedSuggestion.lineItems.map((line) => line.description.trim()).filter(Boolean).join("\n\n");
          if (nextOverview) {
            setQuoteEditForm((prev) => ({ ...prev, scopeText: nextOverview }));
          }
          setNotice(t("quoteDesk.notices.aiOverviewApplied"));
        } else {
          const targetLineId = aiAssistTarget.kind === "lineDescription" ? aiAssistTarget.lineId : null;
          const targetedPatch = targetLineId
            ? reviewedPatch.lineChanges.find((change) => change.action !== "REMOVE" && change.targetLineId === targetLineId)
            : null;
          const nextDescription =
            targetedPatch?.description.trim() ||
            reviewedSuggestion.lineItems[0]?.description?.trim() ||
            reviewedSuggestion.scopeText.trim();
          if (nextDescription) {
            const { title, details } = splitQuoteLineDescription(nextDescription);
            if (aiAssistTarget.kind === "newLineDescription") {
              setNewLine((line) => ({
                ...line,
                title: title.trim() || line.title,
                details: details.trim() || title.trim() || line.details,
              }));
            } else {
              setEditableLines((current) =>
                current.map((line) =>
                  line.id === aiAssistTarget.lineId
                    ? {
                        ...line,
                        title: title.trim() || line.title,
                        details: details.trim() || title.trim() || line.details,
                      }
                    : line,
                ),
              );
            }
          }
          setNotice(t("quoteDesk.notices.aiLineApplied"));
        }

        setAiInsight(insight);
        void loadAiRuns(selectedQuote.id);
        setAiModalOpen(false);
        setMobilePane("editor");
        publishAiUsageUpdate(usage);
        return;
      }

      setQuoteEditForm((prev) => ({
        ...prev,
        serviceType: reviewedSuggestion.serviceType,
        title: reviewedSuggestion.title,
        scopeText: reviewedSuggestion.scopeText,
        taxAmount: String(reviewedSuggestion.taxAmount),
      }));
      setEditableLines((current) => applyAiQuoteLinePatch(current, reviewedPatch));
      setAiPricingReview(reviewedSuggestion.requiresPricingReview || guarded.pricingReviewLines.length
        ? {
            quoteId: selectedQuote.id,
            lineDescriptions: guarded.pricingReviewLines.map((line) => splitQuoteLineDescription(line.description).title || line.description),
            acknowledged: false,
          }
        : null);
      setNewLine(makeEditableQuoteLine());
      setAiInsight(insight);
      void loadAiRuns(selectedQuote.id);
      setAiModalOpen(false);
      setMobilePane("editor");
      publishAiUsageUpdate(usage);
      const usageSummary = formatAiUsageNotice(usage, locale);
      const patchSummary = [
        reviewedPatch.updated ? t("quoteBuilder.aiPatch.updated", { count: reviewedPatch.updated }) : null,
        reviewedPatch.added ? t("quoteBuilder.aiPatch.added", { count: reviewedPatch.added }) : null,
        reviewedPatch.removed ? t("quoteBuilder.aiPatch.removed", { count: reviewedPatch.removed }) : null,
      ]
        .filter(Boolean)
        .join(", ");
      setNotice(
        t("quoteDesk.notices.aiApplied", {
          customer: customer?.fullName ?? parsed.customerName ?? customerName,
          changes: patchSummary ? `${patchSummary}. ` : "",
          usage: usageSummary ? `${usageSummary} ` : "",
        }),
      );
    } catch (err) {
      if (aiRequestRef.current?.id !== requestId || controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      aiRetryIdentityRef.current = { fingerprint, idempotencyKey };
      const usageUpdate = aiUsageUpdateFromApiError(err);
      if (usageUpdate) publishAiUsageUpdate(usageUpdate);
      const message = localizedApiError(err, t, { fallbackKey: "quoteDesk.errors.aiApply" });
      setAiErrorMessage(message);
      setError(message);
    } finally {
      if (aiRequestRef.current?.id === requestId) {
        aiRequestRef.current = null;
        setAiSubmitting(false);
        setAiProgressEvent(null);
      }
    }
  }

  function cancelAiRequest() {
    const activeRequest = aiRequestRef.current;
    activeRequest?.controller.abort();
    if (activeRequest) {
      aiRetryIdentityRef.current = {
        fingerprint: activeRequest.fingerprint,
        idempotencyKey: activeRequest.idempotencyKey,
      };
    }
    aiRequestRef.current = null;
    setAiSubmitting(false);
    setAiProgressEvent(null);
  }

  function handleUnlockEditing() {
    setIsEditUnlocked(true);
    setUnlockConfirmOpen(false);
    setNotice(t("quoteDesk.notices.unlocked"));
  }

  async function confirmRestoreRevision() {
    if (!selectedQuote || !restoreRevisionTarget) return;
    if (hasUnsavedQuoteSheetChanges) {
      setRestoreRevisionTarget(null);
      setError(t("quoteDesk.errors.restoreDirty"));
      return;
    }
    setRestoreRevisionSaving(true);
    setError(null);
    try {
      const result = await api.quotes.restoreRevision(selectedQuote.id, restoreRevisionTarget.id);
      await Promise.all([refreshSelectedQuote(), loadQuoteHistory()]);
      void loadAiRuns(selectedQuote.id);
      setRestoreRevisionTarget(null);
      setAiInsight(null);
      setMobilePane("editor");
      clearStoredDeskDraft();
      setNotice(t("quoteDesk.notices.revisionRestored", { title: result.quote.title, version: restoreRevisionTarget.version }));
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quoteDesk.errors.restore" }));
    } finally {
      setRestoreRevisionSaving(false);
    }
  }

  function restoreQuoteSheetFromSelectedQuote() {
    if (!selectedQuote) return;
    setQuoteEditForm({
      serviceType: selectedQuote.serviceType,
      status: selectedQuote.status,
      afterSaleFollowUpStatus: selectedQuote.afterSaleFollowUpStatus,
      title: selectedQuote.title,
      scopeText: selectedQuote.scopeText,
      taxAmount: String(Number(selectedQuote.taxAmount)),
      documentLocale: selectedQuote.documentLocale,
    });
    setEditableLines((selectedQuote.lineItems ?? []).map(toEditableQuoteLine));
    setNewLine(makeEditableQuoteLine());
    setAiPricingReview(null);
    setPresetPromptLine(null);
  }

  function revertQuoteSheetToLastSaved() {
    restoreQuoteSheetFromSelectedQuote();
    clearStoredDeskDraft();
    setNotice(t("quoteDesk.notices.reverted"));
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
    setNotice(t("quoteDesk.notices.presetLoaded", { name: preset.name }));
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
        sourcePresetId: preset.id,
      },
      { notice: t("quoteDesk.notices.presetAdded", { name: preset.name }) },
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
      setNotice(includeDescription ? t("quoteBuilder.notices.presetFullSaved") : t("quoteBuilder.notices.presetNameSaved"));
      setPresetPromptLine(null);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quoteBuilder.errors.presetSave" }));
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
    if (hasUnsavedQuoteSheetChanges) {
      setQuoteRetentionAction(null);
      setError(t("quoteDesk.errors.retentionDirty"));
      return;
    }

    setQuoteRetentionSaving(true);
    setError(null);

    try {
      if (quoteRetentionAction === "archive") {
        await api.quotes.archive(selectedQuote.id);
        notify.success(t("quoteDesk.notifications.archivedTitle"), {
          description: t("quoteDesk.notifications.archivedDescription", { title: selectedQuote.title }),
        });
      } else {
        await api.quotes.delete(selectedQuote.id);
        notify.success(t("quoteDesk.notifications.deletedTitle"), {
          description: t("quoteDesk.notifications.deletedDescription", { title: selectedQuote.title }),
        });
      }

      setQuoteRetentionAction(null);
      clearStoredDeskDraft();
      await loadQuotes();
      navigate("/app/quotes");
    } catch (err) {
      notify.error(quoteRetentionAction === "archive" ? t("quoteDesk.notifications.archiveFailed") : t("quoteDesk.notifications.deleteFailed"), {
        description: localizedApiError(err, t, { fallbackKey: "quoteDesk.notifications.unchanged" }),
      });
    } finally {
      setQuoteRetentionSaving(false);
    }
  }

  if (quoteDetailLoading && (!selectedQuote || selectedQuote.id !== quoteId)) {
    return (
      <div className="space-y-5" data-testid="quote-detail-loading">
        <PageHeader title={t("quoteDesk.loading.title")} subtitle={t("quoteDesk.loading.description")} />
        <Card variant="default" padding="lg">
          <div role="status" aria-live="polite" className="space-y-3">
            <div className="h-4 w-32 animate-pulse rounded-full bg-[var(--qf-interactive-active)]" aria-hidden="true" />
            <div className="h-8 w-3/4 animate-pulse rounded-lg bg-[var(--qf-interactive-active)]" aria-hidden="true" />
            <p className="text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.loading.status")}</p>
          </div>
        </Card>
      </div>
    );
  }

  if (quoteDetailError) {
    return (
      <div className="space-y-5" data-testid="quote-detail-error">
        <PageHeader
          title={quoteDetailError.kind === "not-found" ? t("quoteDesk.errors.unavailable") : t("quoteDesk.errors.load")}
          subtitle={quoteDetailError.message}
        />
        <Card variant="default" padding="lg">
          <div role="alert" className="space-y-4">
            <p className="text-sm text-[var(--qf-text-soft)]">
              {quoteDetailError.kind === "not-found"
                ? t("quoteDesk.errors.notFoundHelp")
                : t("quoteDesk.errors.retryHelp")}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className="min-h-[44px] sm:min-h-[44px]" onClick={() => void retrySelectedQuote()}>
                {t("quoteDesk.actions.retry")}
              </Button>
              <Button
                variant="outline"
                className="min-h-[44px] sm:min-h-[44px]"
                onClick={() => {
                  focusQuoteDesk(null);
                  navigate("/app/quotes");
                }}
              >
                {t("quoteDesk.actions.back")}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!selectedQuote || selectedQuote.id !== quoteId) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={<FileOutput size={18} />}
          title={t("quoteDesk.empty.title")}
          description={t("quoteDesk.empty.description")}
        />
        <QuickLookupCard
          title={t("quoteDesk.lookup.title")}
          subtitle={t("quoteDesk.lookup.description")}
          customerActionLabel={t("quoteDesk.actions.newQuote")}
          customerActionVariant="secondary"
          onCustomerAction={(customer) => {
            setNotice(t("quoteDesk.notices.customerReady", { name: customer.fullName }));
            requestNavigation(() => navigateToBuilder(customer.id));
          }}
          onQuoteAction={(quote) => requestNavigation(() => navigateToQuote(quote.id))}
        />
      </div>
    );
  }

  const tabs: Array<{ id: DeskTab; label: string }> = [
    { id: "quote", label: t("quoteDesk.tabs.quote") },
    { id: "send", label: t("quoteDesk.tabs.send") },
    { id: "history", label: t("quoteDesk.tabs.history") },
    { id: "log", label: t("quoteDesk.tabs.log") },
  ];

  return (
    <div className="space-y-5" data-testid="quote-desk">
      <PageHeader
        title={quoteEditForm.title || selectedQuote.title}
        subtitle={t("quoteDesk.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <QuoteStatusPill status={selectedQuote.status} />
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {acceptedJobAction ? (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] px-4 py-3 text-sm text-[var(--qf-success-text)] sm:flex-row sm:items-center sm:justify-between">
          <span>{t("quoteDesk.lifecycle.jobReady", { number: acceptedJobAction.jobNumber })}</span>
          <Button variant="outline" size="sm" onClick={() => navigate(`/app/jobs/${acceptedJobAction.id}`)}>
            <ExternalLink size={15} />
            {t("quoteDesk.lifecycle.openJob")}
          </Button>
        </div>
      ) : null}
      {selectedQuote.status === "ACCEPTED" ? (
        <InvoicePanel
          key={`quote:${selectedQuote.id}`}
          sourceQuoteId={selectedQuote.id}
          sourceLabel={t("invoices.sourceQuoteLabel", { title: selectedQuote.title })}
          sourceAmount={selectedQuote.totalAmount}
          canCreate={canCreateInvoices}
        />
      ) : null}
      {canManageAssignments || selectedQuote.assignedTenantUser ? (
        <Card variant="blue" padding="md" className="xl:hidden">
          {canManageAssignments ? (
            <Select
              label={t("quoteDesk.assignment.label")}
              value={selectedQuote.assignedTenantUserId ?? ""}
              onChange={(event) => void updateQuoteAssignment(event.target.value)}
              disabled={assignmentSaving}
              options={[
                { value: "", label: t("quoteDesk.assignment.unassigned") },
                ...workspaceMembers.map((member) => ({ value: member.id, label: `${member.user.fullName} · ${t(`domain.role.${member.role.toLowerCase()}`)}` })),
              ]}
            />
          ) : selectedQuote.assignedTenantUser ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-semibold text-blue-800">
              {t("quoteDesk.assignment.assignedTo", { name: selectedQuote.assignedTenantUser.user.fullName })}
            </div>
          ) : null}
        </Card>
      ) : null}
      {deskDraftRecoveryMessage ? (
        <Alert tone="warning" onDismiss={() => setDeskDraftRecoveryMessage(null)}>{deskDraftRecoveryMessage}</Alert>
      ) : null}
      {deskDraftRecoveryStatus === "error" ? (
        <div
          role="alert"
          data-testid="quote-desk-recovery-error"
          className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]"
        >
          <p className="text-sm font-semibold">{t("quoteDesk.recovery.loadFailedTitle")}</p>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.recovery.loadFailedDescription")}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={retryDeskDraftRecovery}>{t("quoteDesk.recovery.retry")}</Button>
            <Button onClick={() => void startFreshAfterDeskRecoveryError()}>{t("quoteDesk.recovery.startFresh")}</Button>
          </div>
        </div>
      ) : null}
      {conflictingDeskDraft ? (
        <div role="alert" className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]">
          <p className="text-sm font-semibold">{t("quoteDesk.recovery.conflictTitle")}</p>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {t("quoteDesk.recovery.conflictDescription")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" size="sm" onClick={restoreConflictingDeskDraft}>{t("quoteDesk.recovery.restore")}</Button>
            <Button size="sm" onClick={useLatestSavedQuote}>{t("quoteDesk.recovery.useLatest")}</Button>
          </div>
        </div>
      ) : null}
      {hasUnsavedQuoteSheetChanges && hydratedDeskDraftKey === deskDraftStorageKey ? (
        <div role="status" aria-live="polite" className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--qf-text)]">
            {deskDraftPersistenceFailed ? t("quoteDesk.recovery.open") : deskDraftRestored ? t("quoteDesk.recovery.restored") : t("quoteDesk.recovery.saved")}
          </p>
          <p className="mt-1 text-xs text-[var(--qf-text-soft)]">
            {deskDraftPersistenceFailed
              ? t("quoteDesk.recovery.keepOpen")
              : t("quoteDesk.recovery.stored", { updated: deskDraftSavedAtUtc ? t("quoteDesk.recovery.updated", { time: formatLocalDateTime(deskDraftSavedAtUtc) }) : "" })}
          </p>
        </div>
      ) : null}
      {activeAiPricingReview ? (
        <Alert tone="warning">
          <p className="text-sm font-semibold">{t("quoteBuilder.aiPricingReview.title")}</p>
          <p className="mt-1 text-sm">{t("quoteBuilder.aiPricingReview.description")}</p>
          {activeAiPricingReview.lineDescriptions.length ? (
            <p className="mt-2 text-xs">{formatQuotePricingReviewLineDescriptions(activeAiPricingReview.lineDescriptions)}</p>
          ) : null}
          <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={activeAiPricingReview.acknowledged}
              onChange={(event) => setAiPricingReview((current) => current
                ? { ...current, acknowledged: event.target.checked }
                : current)}
              className="h-5 w-5 rounded border-[var(--qf-border-strong)]"
            />
            <span>{t("quoteBuilder.aiPricingReview.acknowledge")}</span>
          </label>
        </Alert>
      ) : null}
      {aiInsight ? (
        <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-3 text-sm text-[var(--qf-text-soft)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">{t("quoteDesk.ai.why")}</p>
              <p className="mt-1 font-medium text-[var(--qf-text)]">{aiInsight.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => setAiInsight(null)}
              className="self-start min-h-[44px] rounded-lg px-2 text-xs font-medium text-[var(--qf-text-muted)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] sm:min-h-[36px]"
            >
              {t("quoteDesk.actions.dismiss")}
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
            {aiInsight.riskNote ? <span className="text-xs text-[var(--qf-text-soft)]">{aiInsight.riskNote}</span> : null}
          </div>
          {aiInsight.sources.length ? (
            <p className="mt-2 text-xs text-[var(--qf-text-muted)]">
              {t("quoteDesk.ai.contextUsed")}: {aiInsight.sources.map((source) => source.label).join(" | ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {activeTab === "quote" ? (
        <div className="flex gap-2 xl:hidden">
          {([
            { id: "editor", label: t("quoteDesk.mobile.edit") },
            { id: "preview", label: t("quoteDesk.mobile.preview") },
          ] as const).map((pane) => (
            <button
              key={pane.id}
              type="button"
              onClick={() => setMobilePane(pane.id)}
              aria-pressed={mobilePane === pane.id}
              className={`flex-1 rounded-full border px-4 py-2 text-sm font-medium transition min-h-[44px] ${
                mobilePane === pane.id
                  ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-link)]"
                  : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)]"
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
            onClick={() => tab.id === "send" ? requestOutboundAction("send-tab") : setActiveTab(tab.id)}
            aria-pressed={activeTab === tab.id}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition min-h-[44px] ${
              activeTab === tab.id
                ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-link)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {isQuoteLocked ? (
          <Badge tone="amber" icon={<Lock size={12} />}>
            {t("quoteDesk.locked.badge")}
          </Badge>
        ) : null}
      </div>

      {activeTab === "quote" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_288px] 2xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className={mobilePane === "preview" ? "hidden xl:block" : ""}>
            <QuoteSheetEditor
              title={quoteEditForm.title}
              onTitleChange={(value) => setQuoteEditForm((prev) => ({ ...prev, title: value }))}
              titleTools={
                <KodyFieldAssistButton
                  label={quoteEditForm.title.trim() ? t("quoteDesk.kodyAssist.improveTitle") : t("quoteDesk.kodyAssist.draftTitle")}
                  onClick={() => openDeskAiAssist({ kind: "title" })}
                  disabled={!canUseChatToQuote || isQuoteLocked || aiUsage.paidActionsUnavailable}
                />
              }
              businessName={session?.tenantName ?? "QuoteFly"}
              businessHint={businessHint}
              customerName={customerName}
              customerHint={`${customerPhone}${customerEmail ? ` / ${customerEmail}` : ""}`}
              headerTools={
                <div className="min-w-[180px]">
                  <Select
                    label={t("quoteComponents.documentLanguage.label")}
                    value={quoteEditForm.documentLocale}
                    disabled={!canEditQuoteDocumentLocale(selectedQuote.status)}
                    onChange={(event) =>
                      setQuoteEditForm((prev) => ({
                        ...prev,
                        documentLocale: event.target.value as Quote["documentLocale"],
                      }))
                    }
                    options={[
                      { value: "en-US", label: t("quoteComponents.documentLanguage.english") },
                      { value: "es-US", label: t("quoteComponents.documentLanguage.spanish") },
                    ]}
                  />
                  {!canEditQuoteDocumentLocale(selectedQuote.status) ? (
                    <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                      {t("quoteComponents.documentLanguage.locked")}
                    </p>
                  ) : null}
                </div>
              }
              preparedDateLabel={formatQuoteDocumentDate(selectedQuote.createdAt, quoteEditForm.documentLocale, session?.timezone)}
              sentDateLabel={sentDateLabel}
              overview={quoteEditForm.scopeText}
              onOverviewChange={(value) => setQuoteEditForm((prev) => ({ ...prev, scopeText: value }))}
              overviewPlaceholder={t("quoteComponents.sheet.overviewPlaceholder")}
              overviewTools={
                <KodyFieldAssistButton
                  label={quoteEditForm.scopeText.trim() ? t("quoteDesk.kodyAssist.improveOverview") : t("quoteDesk.kodyAssist.draftOverview")}
                  onClick={() => openDeskAiAssist({ kind: "overview" })}
                  disabled={!canUseChatToQuote || isQuoteLocked || aiUsage.paidActionsUnavailable}
                />
              }
              logoUrl={branding?.logoUrl ?? null}
              logoPosition={branding?.logoPosition ?? "left"}
              templateId={branding?.templateId ?? "modern"}
              accentColor={quoteAccentColor}
              componentColors={branding?.componentColors ?? null}
              footerText={quoteFooterText}
              showQuoteFlyAttribution={showQuoteFlyAttribution}
              documentLocale={quoteEditForm.documentLocale}
              readOnly={isQuoteLocked}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <KodyFieldAssistButton
                    label={t("quoteDesk.kodyAssist.fullQuote")}
                    onClick={() => openDeskAiAssist({ kind: "quote" })}
                    disabled={!canUseChatToQuote || isQuoteLocked || aiUsage.paidActionsUnavailable}
                    ariaDescribedBy={aiUsage.paidActionsUnavailable ? "quote-desk-ai-pause" : undefined}
                  />
                  <Button variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                    {t("quoteDesk.mobile.preview")}
                  </Button>
                  {isQuoteLocked ? (
                    <Button variant="outline" size="sm" icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                      {t("quoteDesk.actions.unlock")}
                    </Button>
                  ) : hasUnsavedQuoteSheetChanges ? (
                    <Badge tone="amber">{t("quoteDesk.unsaved")}</Badge>
                  ) : (
                    <Badge tone="blue">{t("quoteDesk.editorLive")}</Badge>
                  )}
                  {aiUsage.paidActionsUnavailable ? <AiPaidPauseNotice id="quote-desk-ai-pause" message={aiUsageLimitMessage} className="basis-full" /> : null}
                </div>
              }
            >
              {isQuoteLocked ? (
                <Alert tone="warning">
                  {t("quoteDesk.locked.description")}
                </Alert>
              ) : null}

              <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteDesk.catalog.title")}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.catalog.description")}</p>
                  </div>
                  <div>
                    <Button size="sm" variant="outline" onClick={() => setPresetPickerOpen(true)}>
                      {t("quoteDesk.catalog.browse")}
                    </Button>
                  </div>
                  {selectedPreset ? (
                    <div className="hidden flex-col gap-2 sm:flex-row sm:items-end xl:flex">
                      <div className="sm:w-24">
                        <Input
                          label={t(`quoteComponents.units.${selectedPreset.unitType}`)}
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={selectedPresetQuantity}
                          onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                          disabled={isQuoteLocked}
                        />
                      </div>
                      <Button size="sm" variant="outline" onClick={() => loadPresetToNewLine(selectedPreset)} disabled={isQuoteLocked}>
                        {t("quoteDesk.catalog.loadRow")}
                      </Button>
                      <Button size="sm" onClick={() => void addPresetToQuote(selectedPreset)} disabled={isQuoteLocked}>
                        {t("quoteDesk.catalog.add")}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {presetLoadError ? <p className="mt-3 text-xs text-red-600">{presetLoadError}</p> : null}

                {selectedPreset ? (
                  <div className="mt-3 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3 xl:hidden">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[var(--qf-text)]">{selectedPreset.name}</p>
                        <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                          {formatMoney(selectedPreset.unitPrice)} / {t(`quoteComponents.units.${selectedPreset.unitType}`)}
                        </p>
                      </div>
                      {selectedPreset.catalogKey ? <Badge tone="blue">{t("quoteComponents.presetPicker.standard")}</Badge> : <Badge tone="slate">{t("quoteComponents.presetPicker.saved")}</Badge>}
                    </div>
                    <div className="mt-3 grid gap-2">
                      <Input
                        label={t(`quoteComponents.units.${selectedPreset.unitType}`)}
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={selectedPresetQuantity}
                        onChange={(event) => setSelectedPresetQuantity(event.target.value)}
                        disabled={isQuoteLocked}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="outline" onClick={() => loadPresetToNewLine(selectedPreset)} disabled={isQuoteLocked}>
                          {t("quoteDesk.catalog.loadRowShort")}
                        </Button>
                        <Button size="sm" onClick={() => void addPresetToQuote(selectedPreset)} disabled={isQuoteLocked}>
                          {t("quoteDesk.catalog.add")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 hidden gap-2 overflow-x-auto pb-1 xl:flex">
                  {presetsLoading ? (
                    <LoadingState
                      title={t("quoteDesk.catalog.loading")}
                      description={t("quoteDesk.catalog.loadingDescription")}
                      variant="compact"
                      className="min-w-[260px] bg-[var(--qf-panel)]"
                    />
                  ) : availablePresets.length ? (
                    availablePresets.slice(0, 10).map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedPresetId(preset.id)}
                        className={`min-w-fit rounded-xl border px-3 py-2 text-left transition ${
                          preset.id === selectedPresetId
                            ? "border-quotefly-blue/30 bg-[var(--qf-panel)] text-quotefly-blue shadow-[0_0_0_2px_var(--qf-focus-ring)]"
                            : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
                        }`}
                      >
                        <p className="text-sm font-semibold">{preset.name}</p>
                        <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{formatMoney(preset.unitPrice)} / {t(`quoteComponents.units.${preset.unitType}`)}</p>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel)] px-3 py-3 text-sm text-[var(--qf-text-muted)]">
                      {t("quoteDesk.catalog.empty")}
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
                <div
                  className={`hidden gap-3 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] xl:grid ${QUOTE_DESK_HEADER_GRID_COLUMNS} ${QUOTE_DESK_LINE_GRID_MIN_WIDTH}`}
                >
                  <span>{t("quoteDesk.line.title")}</span>
                  <span>{t("quoteDesk.line.description")}</span>
                  <span>{t("quoteDesk.line.quantity")}</span>
                  <span>{canViewInternalCosts ? t("quoteDesk.line.cost") : ""}</span>
                  <span>{t("quoteDesk.line.price")}</span>
                  <span>{t("quoteComponents.math.total")}</span>
                  <span className="text-right">{t("quoteDesk.line.actions")}</span>
                </div>
                {lineItemCount === 0 ? (
                  <div className="p-4">
                    <EmptyState title={t("quoteDesk.line.empty")} description={t("quoteDesk.line.emptyDescription")} />
                  </div>
                ) : null}
                <div className="divide-y divide-[var(--qf-border)]">
                  {editableLines.map((line, index) => (
                  <ExistingLineEditorRow
                    key={line.id}
                    line={line}
                    index={index}
                    dirty={dirtyLineIds.includes(line.id)}
                    startExpanded={dirtyLineIds.includes(line.id)}
                    readOnly={isQuoteLocked}
                    canViewInternalCosts={canViewInternalCosts}
                    onChange={updateEditableLine}
                    onSave={saveLine}
                    onDelete={() => setLineItemPendingDeleteId(line.id)}
                    onAssistDescription={(lineId) => openDeskAiAssist({ kind: "lineDescription", lineId })}
                    assistDisabled={!canUseChatToQuote || isQuoteLocked || aiUsage.paidActionsUnavailable}
                    />
                  ))}
                  <div className="px-4 py-4">
                    <div className="rounded-2xl border border-dashed border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteDesk.line.add")}</p>
                          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                            {isQuoteLocked
                              ? t("quoteDesk.line.unlockToAdd")
                              : t("quoteDesk.line.addHelp")}
                          </p>
                        </div>
                      </div>
                      <NewLineEditorRow
                        line={newLine}
                        onChange={setNewLine}
                        onAdd={addNewLine}
                        saving={saving}
                        readOnly={isQuoteLocked}
                        canViewInternalCosts={canViewInternalCosts}
                        onAssistDescription={() => openDeskAiAssist({ kind: "newLineDescription" })}
                        assistDisabled={!canUseChatToQuote || isQuoteLocked || aiUsage.paidActionsUnavailable}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </QuoteSheetEditor>
          </div>

          <div className="space-y-5">
            <div className={mobilePane === "preview" ? "block xl:hidden" : "hidden"}>
              <QuoteLivePreview
                businessName={session?.tenantName ?? "QuoteFly"}
                quoteReferenceLabel={`${quoteDocumentCopy(quoteEditForm.documentLocale).customerQuote} #${selectedQuote.id.slice(0, 8).toUpperCase()}`}
                businessHint={businessHint}
                customerName={customerName}
                customerPhone={customerPhone}
                customerEmail={customerEmail}
                preparedDateLabel={formatQuoteDocumentDate(selectedQuote.createdAt, quoteEditForm.documentLocale, session?.timezone)}
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
                documentLocale={quoteEditForm.documentLocale}
              />
            </div>

            <Card variant="blue" padding="md" className="hidden xl:block">
              <CardHeader
                title={t("quoteDesk.controls.title")}
                subtitle={t("quoteDesk.controls.description")}
              />
              <div className="mb-4 space-y-3">
                {canManageAssignments ? (
                  <Select
                    label={t("quoteDesk.assignment.label")}
                    value={selectedQuote.assignedTenantUserId ?? ""}
                    onChange={(event) => void updateQuoteAssignment(event.target.value)}
                    disabled={assignmentSaving}
                    options={[
                      { value: "", label: t("quoteDesk.assignment.unassigned") },
                      ...workspaceMembers.map((member) => ({ value: member.id, label: `${member.user.fullName} · ${t(`domain.role.${member.role.toLowerCase()}`)}` })),
                    ]}
                  />
                ) : selectedQuote.assignedTenantUser ? (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-semibold text-blue-800">
                    {t("quoteDesk.assignment.assignedTo", { name: selectedQuote.assignedTenantUser.user.fullName })}
                  </div>
                ) : null}
                <Select
                  label={t("quoteBuilder.trade")}
                  value={quoteEditForm.serviceType}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as typeof prev.serviceType }))
                  }
                  disabled={isQuoteLocked}
                  options={[
                    { value: "HVAC", label: t("domain.trade.HVAC") },
                    { value: "PLUMBING", label: t("domain.trade.PLUMBING") },
                    { value: "FLOORING", label: t("domain.trade.FLOORING") },
                    { value: "ROOFING", label: t("domain.trade.ROOFING") },
                    { value: "GARDENING", label: t("domain.trade.GARDENING") },
                    { value: "CONSTRUCTION", label: t("domain.trade.CONSTRUCTION") },
                  ]}
                />
                <Select
                  label={t("quoteDesk.controls.status")}
                  value={quoteEditForm.status}
                  onChange={(event) =>
                    setQuoteEditForm((prev) => ({ ...prev, status: event.target.value as typeof prev.status }))
                  }
                  disabled={isQuoteLocked}
                  options={[
                    { value: "DRAFT", label: t("domain.quoteStatus.DRAFT") },
                    { value: "READY_FOR_REVIEW", label: t("domain.quoteStatus.READY_FOR_REVIEW") },
                    { value: "SENT_TO_CUSTOMER", label: t("domain.quoteStatus.SENT_TO_CUSTOMER") },
                    { value: "ACCEPTED", label: t("domain.quoteStatus.ACCEPTED") },
                    { value: "REJECTED", label: t("domain.quoteStatus.REJECTED") },
                  ]}
                />
              </div>
              <div className="space-y-3 text-sm">
                <SummaryRow label={t("quoteDesk.controls.lineItems")} value={String(lineItemCount)} />
                <SummaryRow label={t("quoteComponents.math.customerSubtotal")} value={formatMoney(customerSubtotal)} />
                <div className="space-y-1">
                  <Input
                    label={t("quoteComponents.math.tax")}
                    type="number"
                    min="0"
                    step="0.01"
                    value={quoteEditForm.taxAmount}
                    onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))}
                    disabled={isQuoteLocked}
                  />
                </div>
                <SummaryRow label={t("quoteComponents.math.total")} value={formatMoney(totalAmount)} strong />
                {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.internalCost")} value={formatMoney(internalSubtotal)} /> : null}
                {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.estimatedProfit")} value={formatMoney(estimatedProfit)} tone={estimatedProfit >= 0 ? "good" : "bad"} /> : null}
                {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.margin")} value={new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(estimatedMarginPercent / 100)} tone={estimatedMarginPercent >= 10 ? "good" : "bad"} /> : null}
              </div>
              <div className="mt-4 space-y-2 text-sm text-[var(--qf-text-soft)]">
                <ChecklistItem compact complete={Boolean(selectedQuote.customerId)} label={t("quoteDesk.controls.customerAttached")} />
                <ChecklistItem compact complete={Boolean(quoteEditForm.title.trim())} label={t("quoteDesk.controls.titlePresent")} />
                <ChecklistItem compact complete={lineItemCount > 0} label={t("quoteDesk.controls.linesInQuote", { count: lineItemCount })} />
              </div>
              {isQuoteLocked ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  {t("quoteDesk.controls.locked")}
                </div>
              ) : null}
              <div className="mt-4 grid gap-2">
                {isQuoteLocked ? (
                  <Button fullWidth icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                    {t("quoteDesk.actions.unlock")}
                  </Button>
                ) : (
                  <Button fullWidth loading={saving} icon={<Save size={14} />} onClick={() => void handleSaveQuoteSheet()}>
                    {t("quoteDesk.actions.saveSheet")}
                  </Button>
                )}
                <div className="grid gap-2 xl:hidden">
                  <Button fullWidth variant="outline" onClick={() => requestNavigation(() => navigateToBuilder(selectedQuote.customerId))}>
                    {t("quoteDesk.actions.startAnother")}
                  </Button>
                  {canManageRecordRetention ? <details className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2">
                    <summary className="min-h-11 cursor-pointer list-none py-3 text-sm font-semibold text-[var(--qf-text-soft)]">
                      {t("quoteDesk.actions.more")}
                    </summary>
                    <div className="mt-3 grid gap-2">
                      <Button
                        fullWidth
                        variant="outline"
                        icon={<RotateCcw size={14} />}
                        onClick={revertQuoteSheetToLastSaved}
                        disabled={!hasUnsavedQuoteSheetChanges}
                      >
                        {t("quoteDesk.actions.revert")}
                      </Button>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          fullWidth
                          variant="warning"
                          icon={<Archive size={14} />}
                          onClick={() => setQuoteRetentionAction("archive")}
                        >
                          {t("quoteDesk.actions.archive")}
                        </Button>
                        <Button
                          fullWidth
                          variant="danger"
                          icon={<Trash2 size={14} />}
                          onClick={() => setQuoteRetentionAction("delete")}
                        >
                          {t("quoteDesk.actions.delete")}
                        </Button>
                      </div>
                    </div>
                  </details> : null}
                </div>
                <div className="hidden gap-2 lg:grid">
                  <Button fullWidth variant="outline" icon={<RotateCcw size={14} />} onClick={revertQuoteSheetToLastSaved} disabled={!hasUnsavedQuoteSheetChanges}>
                    {t("quoteDesk.actions.revert")}
                  </Button>
                  <Button fullWidth variant="outline" icon={<Eye size={14} />} onClick={() => requestOutboundAction("pdf-preview")}>
                    {t("quoteDesk.actions.previewPdf")}
                  </Button>
                  <Button fullWidth variant="outline" onClick={() => requestNavigation(() => navigateToBuilder(selectedQuote.customerId))}>
                    {t("quoteDesk.actions.startAnother")}
                  </Button>
                  {canManageRecordRetention ? <div className="grid grid-cols-2 gap-2">
                    <Button
                      fullWidth
                      variant="warning"
                      icon={<Archive size={14} />}
                      onClick={() => setQuoteRetentionAction("archive")}
                    >
                      {t("quoteDesk.actions.archive")}
                    </Button>
                    <Button
                      fullWidth
                      variant="danger"
                      icon={<Trash2 size={14} />}
                      onClick={() => setQuoteRetentionAction("delete")}
                    >
                      {t("quoteDesk.actions.delete")}
                    </Button>
                  </div> : null}
                </div>
                <p className="text-xs text-[var(--qf-text-soft)]">{t("quoteDesk.preparedSent", { prepared: formatLocalDateTime(selectedQuote.createdAt), sent: sentDateLabel })}</p>
              </div>
            </Card>

            <div className={`space-y-5 ${mobilePane === "preview" ? "hidden xl:block" : ""}`}>
              <QuickLookupCard
                title={t("quoteDesk.switcher.title")}
                subtitle={t("quoteDesk.switcher.description")}
                customerActionLabel={t("quoteDesk.actions.newQuote")}
                customerActionVariant="outline"
                activeCustomerId={selectedQuote.customerId}
                activeQuoteId={selectedQuote.id}
                onCustomerAction={(customer) => {
                  setNotice(t("quoteDesk.notices.customerReady", { name: customer.fullName }));
                  requestNavigation(() => navigateToBuilder(customer.id));
                }}
                onQuoteAction={(quote) => requestNavigation(() => navigateToQuote(quote.id))}
              />

              <Card variant="default" padding="md">
                <CardHeader title={t("quoteDesk.lifecycle.title")} subtitle={t("quoteDesk.lifecycle.description")} />
                <div className="grid gap-2">
                  <Button variant="outline" onClick={() => void requestLifecycleUpdate("SENT_TO_CUSTOMER")}>
                    {t("quoteDesk.lifecycle.sent")}
                  </Button>
                  <Button variant="outline" onClick={() => void requestLifecycleUpdate("ACCEPTED")}>
                    {t("quoteDesk.lifecycle.acceptAndCreateJob")}
                  </Button>
                  <Button variant="outline" onClick={() => void requestLifecycleUpdate("REJECTED")}>
                    {t("quoteDesk.lifecycle.lost")}
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "quote" ? (
        <div className="xl:hidden">
          <div className="h-24" />
          <WorkflowActionDock>
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--qf-text-muted)]">
              <span>{t("quoteDesk.controls.lineCount", { count: lineItemCount })}</span>
              <span>{t("quoteComponents.math.total")} {formatMoney(totalAmount)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                icon={mobilePane === "preview" ? <ChevronDown size={14} /> : <Eye size={14} />}
                onClick={() => setMobilePane((current) => (current === "editor" ? "preview" : "editor"))}
              >
                {mobilePane === "preview" ? t("quoteDesk.mobile.edit") : t("quoteDesk.mobile.preview")}
              </Button>
              {isQuoteLocked ? (
                <Button icon={<Lock size={14} />} onClick={() => setUnlockConfirmOpen(true)}>
                  {t("quoteDesk.actions.unlockShort")}
                </Button>
              ) : (
                <Button loading={saving} icon={<Save size={14} />} onClick={() => void handleSaveQuoteSheet()}>
                  {t("quoteDesk.actions.save")}
                </Button>
              )}
            </div>
          </WorkflowActionDock>
        </div>
      ) : null}

      {activeTab === "send" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card variant="default" padding="md">
            <CardHeader title={t("quoteDesk.send.title")} subtitle={t("quoteDesk.send.description")} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Button variant="outline" icon={<Mail size={14} />} onClick={() => requestOutboundAction("email")} disabled={saving}>
                {t("quoteDesk.send.emailApp")}
              </Button>
              <Button variant="outline" icon={<MessageSquare size={14} />} onClick={() => requestOutboundAction("sms")} disabled={saving}>
                {t("quoteDesk.send.textApp")}
              </Button>
              <Button variant="outline" icon={<Copy size={14} />} onClick={() => requestOutboundAction("copy")} disabled={saving}>
                {t("quoteDesk.send.copyMessage")}
              </Button>
              <Button variant="secondary" icon={<FileOutput size={14} />} onClick={() => requestOutboundAction("pdf")} disabled={saving}>
                {t("quoteDesk.send.downloadPdf")}
              </Button>
            </div>
          </Card>

          <Card variant="blue" padding="md">
            <CardHeader title={t("quoteDesk.send.notesTitle")} subtitle={t("quoteDesk.send.notesDescription")} />
            <div className="space-y-2 text-sm text-[var(--qf-text-soft)]">
              <p>{t("quoteDesk.send.textNote")}</p>
              <p>{t("quoteDesk.send.emailNote")}</p>
              <p>{t("quoteDesk.send.sentDateNote")}</p>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "history" ? (
        <Card variant="default" padding="md">
          <CardHeader
            title={t("quoteDesk.history.title")}
            subtitle={t("quoteDesk.history.description")}
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadAiRuns(selectedQuote.id)}>{t("quoteDesk.history.refreshAi")}</Button>
                {canViewQuoteHistory ? (
                  <Button variant="outline" size="sm" onClick={() => void loadQuoteHistory()}>{t("quoteDesk.history.refreshRevisions")}</Button>
                ) : null}
              </div>
            }
          />

          <div className="space-y-5">
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">{t("quoteDesk.history.aiRuns")}</p>
                  <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.history.aiRunsDescription")}</p>
                </div>
              </div>

              {aiRunsLoading ? (
                <LoadingState
                  title={t("quoteDesk.history.loadingAi")}
                  description={t("quoteDesk.history.loadingAiDescription")}
                  variant="list"
                  rows={3}
                />
              ) : aiRuns.length === 0 ? (
                <EmptyState title={t("quoteDesk.history.noAi")} description={t("quoteDesk.history.noAiDescription")} />
              ) : (
                <div className="space-y-2">
                  {aiRuns.map((run) => (
                    <div key={run.id} className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={run.eventType === "REVISE" ? "orange" : "blue"}>{run.eventType === "REVISE" ? t("quoteDesk.history.aiRevise") : t("quoteDesk.history.aiDraft")}</Badge>
                          {run.confidenceLabel ? (
                            <Badge tone={run.confidenceLevel === "high" ? "emerald" : run.confidenceLevel === "medium" ? "amber" : "red"}>
                              {run.confidenceLabel}
                            </Badge>
                          ) : null}
                          {typeof run.patchAdded === "number" || typeof run.patchUpdated === "number" || typeof run.patchRemoved === "number" ? (
                            <span className="text-xs text-[var(--qf-text-muted)]">
                              {t("quoteDesk.history.patchSummary", { updated: run.patchUpdated ?? 0, added: run.patchAdded ?? 0, removed: run.patchRemoved ?? 0 })}
                            </span>
                          ) : null}
                        </div>
                    <span className="text-xs text-[var(--qf-text-muted)]">{formatLocalDateTime(run.createdAt)}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-[var(--qf-text)]">{run.insightSummary || t("quoteDesk.history.aiPrepared")}</p>
                      {run.promptRedacted ? (
                        <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{run.promptRedacted}</p>
                      ) : (
                        <p className="mt-1 text-sm text-[var(--qf-text-muted)]">{t("quoteDesk.history.promptUnavailable")}</p>
                      )}
                      {run.riskNote ? <p className="mt-2 text-xs text-[var(--qf-text-soft)]">{run.riskNote}</p> : null}
                      {run.insightReasons.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {run.insightReasons.map((reason) => (
                            <Badge key={`${run.id}-${reason}`} tone="blue">{reason}</Badge>
                          ))}
                        </div>
                      ) : null}
                      {run.insightSourceLabels.length ? (
                        <p className="mt-2 text-xs text-[var(--qf-text-muted)]">
                          {t("quoteDesk.ai.contextUsed")}: {run.insightSourceLabels.join(" | ")}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--qf-text-muted)]">
                        <span>{t("quoteDesk.history.by", { actor: run.actorName || run.actorEmail || t("quoteComponents.unknown") })}</span>
                        <span>
                          {run.totalTokens ? t("quoteDesk.history.tokens", { count: run.totalTokens, formatted: new Intl.NumberFormat(locale).format(run.totalTokens) }) : t("quoteDesk.history.tokensUnavailable")}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 border-t border-[var(--qf-border)] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteDesk.history.revisions")}</p>
                  <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.history.revisionsDescription")}</p>
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
                            : "border-[var(--qf-border-strong)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:bg-[var(--qf-interactive-hover)]"
                        }`}
                      >
                        {mode === "quote" ? t("quoteDesk.history.selectedQuote") : mode === "customer" ? t("quoteDesk.history.byCustomer") : t("quoteDesk.history.allActivity")}
                      </button>
                    ))}
                    {historyMode === "customer" ? (
                      <select
                        value={historyCustomerId}
                        onChange={(event) => setHistoryCustomerId(event.target.value)}
                        className="min-h-[44px] rounded-full border border-[var(--qf-border-strong)] bg-[var(--qf-panel)] px-3 py-2 text-xs text-[var(--qf-text-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[36px] sm:py-1"
                      >
                        <option value="ALL">{t("quoteDesk.history.selectCustomer")}</option>
                        {customers.map((customer) => (
                          <option key={customer.id} value={customer.id}>{customer.fullName}</option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                  {historyLoading ? (
                    <LoadingState
                      title={t("quoteDesk.history.loading")}
                      description={t("quoteDesk.history.loadingDescription")}
                      variant="list"
                      rows={4}
                    />
                  ) : quoteHistory.length === 0 ? (
                    <EmptyState title={t("quoteDesk.history.empty")} description={t("quoteDesk.history.emptyDescription")} />
                  ) : (
                    <div className="space-y-2">
                      {quoteHistory.map((revision) => (
                        <div key={revision.id} className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <HistoryEventPill eventType={revision.eventType} />
                              <QuoteStatusPill status={revision.status} compact />
                              <span className="text-sm font-semibold text-[var(--qf-text)]">{revision.title}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {canManageRecordRetention && selectedQuote && revision.quote.id === selectedQuote.id ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  icon={<RotateCcw size={13} />}
                                  onClick={() => setRestoreRevisionTarget(revision)}
                                >
                                  {t("quoteDesk.history.restore")}
                                </Button>
                              ) : null}
                    <span className="text-xs text-[var(--qf-text-muted)]">{formatLocalDateTime(revision.createdAt)}</span>
                            </div>
                          </div>
                          <p className="mt-2 text-xs text-[var(--qf-text-soft)]">
                      {t("quoteDesk.revisionSummary", { version: revision.version, total: formatMoney(revision.totalAmount), actor: revision.actorName || revision.actorEmail || t("quoteComponents.unknown") })}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <FeatureLockedCard
                  title={t("quoteDesk.history.revisions")}
                  description={t("quoteDesk.history.professionalRequired")}
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
              title={t("quoteComponents.sendLog.title")}
              subtitle={t("quoteDesk.sendLog.description")}
              actions={<Button variant="outline" size="sm" onClick={() => void loadOutboundEvents(selectedQuote.id)}>{t("quoteComponents.history.refresh")}</Button>}
            />
            {outboundEventsLoading ? (
              <LoadingState
                title={t("quoteComponents.sendLog.loading")}
                description={t("quoteDesk.sendLog.loadingDescription")}
                variant="list"
                rows={3}
              />
            ) : outboundEvents.length === 0 ? (
              <EmptyState title={t("quoteComponents.sendLog.empty")} description={t("quoteDesk.sendLog.emptyDescription")} />
            ) : (
              <div className="space-y-2">
                {outboundEvents.map((event) => (
                  <div key={event.id} className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <OutboundChannelPill channel={event.channel} />
                    <span className="text-xs text-[var(--qf-text-muted)]">{formatLocalDateTime(event.createdAt)}</span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--qf-text-soft)]">
                      {event.destination ? t("quoteDesk.sendLog.destination", { destination: event.destination }) : t("quoteDesk.sendLog.noDestination")}
                    </p>
                    <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                      {t("quoteComponents.sendLog.by", { actor: event.actorName || event.actorEmail || t("quoteComponents.unknown") })}
                    </p>
                    {event.subject ? <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("quoteComponents.sendLog.subject", { subject: event.subject })}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <FeatureLockedCard
            title={t("quoteComponents.sendLog.title")}
            description={t("quoteDesk.sendLog.professionalRequired")}
            currentPlanLabel={currentPlanLabel}
            requiredPlanLabel="Professional"
            showUpgradeHint={canAutoUpgradeMessage}
          />
        )
      ) : null}

      <Modal
        open={pendingOutboundAction !== null}
        onClose={cancelOutboundPreparation}
        closeOnBackdrop={!outboundPreparationSaving}
        size="md"
        ariaLabel={t("quoteDesk.saveBeforeSend.title")}
      >
        <ModalHeader
          title={t("quoteDesk.saveBeforeSend.title")}
          description={t("quoteDesk.saveBeforeSend.description")}
          onClose={cancelOutboundPreparation}
        />
        <ModalBody className="space-y-3">
          <Alert tone="warning">
            {t("quoteDesk.saveBeforeSend.warning")}
          </Alert>
          {newLine.title.trim() ? (
            <p className="text-sm text-[var(--qf-text-soft)]">{t("quoteDesk.saveBeforeSend.newLine")}</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={cancelOutboundPreparation} disabled={outboundPreparationSaving}>
            {t("common.cancel")}
          </Button>
          <Button variant="ghost" onClick={discardEditsAndContinueOutbound} disabled={outboundPreparationSaving}>
            {t("quoteDesk.actions.discardEdits")}
          </Button>
          <Button onClick={() => void saveAndContinueOutbound()} loading={outboundPreparationSaving}>
            {t("quoteDesk.actions.saveContinue")}
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        open={pendingLifecycleStatus !== null}
        onClose={() => {
          if (!lifecyclePreparationSaving) setPendingLifecycleStatus(null);
        }}
        closeOnBackdrop={!lifecyclePreparationSaving}
        size="md"
        ariaLabel={t("quoteDesk.saveBeforeStatus.title")}
      >
        <ModalHeader
          title={t("quoteDesk.saveBeforeStatus.title")}
          description={t("quoteDesk.saveBeforeStatus.description")}
          onClose={() => {
            if (!lifecyclePreparationSaving) setPendingLifecycleStatus(null);
          }}
        />
        <ModalBody>
          <Alert tone="warning">{t("quoteDesk.saveBeforeStatus.warning")}</Alert>
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setPendingLifecycleStatus(null)} disabled={lifecyclePreparationSaving}>{t("common.cancel")}</Button>
          <Button variant="ghost" onClick={discardEditsAndContinueLifecycle} disabled={lifecyclePreparationSaving}>{t("quoteDesk.actions.discardEdits")}</Button>
          <Button onClick={() => void saveAndContinueLifecycle()} loading={lifecyclePreparationSaving}>{t("quoteDesk.actions.saveContinue")}</Button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={navigationPromptOpen}
        onClose={cancelNavigation}
        onConfirm={continueNavigation}
        title={t("quoteDesk.leave.title")}
        description={t("quoteDesk.leave.description")}
        confirmLabel={t("quoteDesk.leave.confirm")}
        confirmVariant="warning"
      />

      <ConfirmModal
        open={lineItemPendingDeleteId !== null}
        onClose={() => setLineItemPendingDeleteId(null)}
        onConfirm={() => void confirmDeleteLineItem()}
        title={t("quoteDesk.deleteLine.title")}
        description={t("quoteDesk.deleteLine.description")}
        confirmLabel={t("quoteDesk.deleteLine.confirm")}
        loading={saving}
      />

      <ConfirmModal
        open={unlockConfirmOpen}
        onClose={() => setUnlockConfirmOpen(false)}
        onConfirm={handleUnlockEditing}
        title={t("quoteDesk.unlock.title")}
        description={t("quoteDesk.unlock.description")}
        confirmLabel={t("quoteDesk.unlock.confirm")}
        confirmVariant="warning"
      >
        <div className="space-y-2 text-sm text-[var(--qf-text-soft)]">
          <p>{t("quoteDesk.unlock.help")}</p>
          <p>{t("quoteDesk.unlock.revertHelp")}</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={quoteRetentionAction !== null}
        onClose={() => setQuoteRetentionAction(null)}
        onConfirm={() => void confirmQuoteRetentionAction()}
        title={quoteRetentionAction === "archive" ? t("quoteDesk.retention.archiveTitle") : t("quoteDesk.retention.deleteTitle")}
        description={
          quoteRetentionAction === "archive"
            ? t("quoteDesk.retention.archiveDescription")
            : t("quoteDesk.retention.deleteDescription")
        }
        confirmLabel={quoteRetentionAction === "archive" ? t("quoteDesk.retention.archiveConfirm") : t("quoteDesk.retention.deleteConfirm")}
        confirmVariant={quoteRetentionAction === "archive" ? "warning" : "danger"}
        loading={quoteRetentionSaving}
      >
        <div className="space-y-2 text-sm text-[var(--qf-text-soft)]">
          <p>
            {quoteRetentionAction === "archive"
              ? t("quoteDesk.retention.archiveHelp")
              : t("quoteDesk.retention.deleteHelp")}
          </p>
          <p>{t("quoteDesk.retention.historyStored")}</p>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={restoreRevisionTarget !== null}
        onClose={() => setRestoreRevisionTarget(null)}
        onConfirm={() => void confirmRestoreRevision()}
        title={t("quoteDesk.restore.title")}
        description={t("quoteDesk.restore.description")}
        confirmLabel={restoreRevisionTarget ? t("quoteDesk.restore.versionConfirm", { version: restoreRevisionTarget.version }) : t("quoteDesk.restore.confirm")}
        confirmVariant="warning"
        loading={restoreRevisionSaving}
      >
        {restoreRevisionTarget ? (
          <div className="space-y-2 text-sm text-[var(--qf-text-soft)]">
            <p>{t("quoteDesk.restore.help", { version: restoreRevisionTarget.version, date: formatLocalDateTime(restoreRevisionTarget.createdAt) })}</p>
            <p>{t("quoteDesk.restore.historyHelp")}</p>
          </div>
        ) : null}
      </ConfirmModal>

      <SaveLinePresetModal
        open={canManageCatalog && Boolean(presetPromptLine)}
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
        primaryActionLabel={t("quoteDesk.catalog.add")}
        onPrimaryAction={() => {
          if (!selectedPreset) return;
          void addPresetToQuote(selectedPreset);
          setPresetPickerOpen(false);
        }}
        secondaryActionLabel={t("quoteDesk.catalog.loadRow")}
        onSecondaryAction={() => {
          if (!selectedPreset) return;
          loadPresetToNewLine(selectedPreset);
          setPresetPickerOpen(false);
        }}
        onManageProducts={canManageCatalog ? () => {
          setPresetPickerOpen(false);
          requestNavigation(() => navigate("/app/products"));
        } : undefined}
        canViewInternalCosts={canViewInternalCosts}
      />

      <QuoteAiPromptModal
        open={aiModalOpen}
        onClose={() => {
          cancelAiRequest();
          setAiModalOpen(false);
          setAiErrorMessage(null);
        }}
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
        customerContextDetails={[customerPhone, customerEmail].filter(Boolean).join(" | ")}
        customerContextText={`${customerName}${customerPhone ? ` | ${customerPhone}` : ""}${customerEmail ? ` | ${customerEmail}` : ""}`}
        customerContextBadge={t("quoteDesk.ai.usingCurrent")}
        usageHint={aiUsageHint}
        usageLimitMessage={aiUsage.paidActionsUnavailable ? aiUsageLimitMessage : null}
        errorMessage={aiErrorMessage}
        progressEvent={aiProgressEvent}
        loading={aiSubmitting}
        onCancelRequest={cancelAiRequest}
        disabled={!canUseChatToQuote || aiUsage.paidActionsUnavailable}
        onSubmit={(event) => void handleAiSuggestSubmit(event)}
        title={
          aiAssistTarget.kind === "quote"
            ? t("quoteDesk.ai.reviseTitle")
            : t("quoteDesk.kodyAssist.modalTitle", {
                target:
                  aiAssistTarget.kind === "title"
                    ? t("quoteDesk.kodyAssist.targetTitle")
                    : aiAssistTarget.kind === "overview"
                      ? t("quoteDesk.kodyAssist.targetOverview")
                      : t("quoteDesk.kodyAssist.targetLine"),
              })
        }
        description={
          aiAssistTarget.kind === "quote"
            ? t("quoteDesk.ai.reviseDescription")
            : t("quoteDesk.kodyAssist.modalDescription")
        }
        submitLabel={
          aiAssistTarget.kind === "quote"
            ? t("quoteDesk.ai.apply")
            : t("quoteDesk.kodyAssist.applyField")
        }
      />

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="xl" ariaLabel={t("quoteDesk.preview.ariaLabel")}>
        <ModalHeader
          title={t("quoteDesk.preview.title")}
          description={t("quoteDesk.preview.description")}
          onClose={() => setPreviewOpen(false)}
        />
        <ModalBody className="bg-[var(--qf-panel-muted)]">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            quoteReferenceLabel={`${quoteDocumentCopy(quoteEditForm.documentLocale).customerQuote} #${selectedQuote.id.slice(0, 8).toUpperCase()}`}
            businessHint={businessHint}
            customerName={customerName}
            customerPhone={customerPhone}
            customerEmail={customerEmail}
            preparedDateLabel={formatQuoteDocumentDate(selectedQuote.createdAt, quoteEditForm.documentLocale, session?.timezone)}
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
            documentLocale={quoteEditForm.documentLocale}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setPreviewOpen(false)}>{t("common.close")}</Button>
          <Button
            icon={<FileOutput size={14} />}
            onClick={() => {
              setPreviewOpen(false);
              requestOutboundAction("pdf-preview");
            }}
          >
            {t("quoteDesk.actions.previewPdf")}
          </Button>
        </ModalFooter>
      </Modal>

      {sendComposer ? (
        <Modal open={true} onClose={() => { setError(null); setSendComposer(null); }} size="lg" ariaLabel={t("quoteDesk.composer.ariaLabel")}>
          <ModalHeader
            title={
              sendComposer.channel === "email"
                ? t("quoteDesk.composer.emailTitle")
                : sendComposer.channel === "sms"
                  ? t("quoteDesk.composer.textTitle")
                  : t("quoteDesk.composer.copyTitle")
            }
            description={t("quoteDesk.composer.customer", { customer: sendComposer.customerName, phone: sendComposer.channel === "sms" ? ` • ${formatUsPhoneDisplay(sendComposer.customerPhone)}` : "" })}
            onClose={() => { setError(null); setSendComposer(null); }}
          />
          <ModalBody className="space-y-4">
            {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
            {sendComposer.channel === "email" ? (
              <Input
                label={t("quoteDesk.composer.subject")}
                value={sendComposer.subject}
                onChange={(event) =>
                  setSendComposer((prev) => (prev ? { ...prev, subject: event.target.value } : prev))
                }
              />
            ) : null}
            <Textarea
              label={t("quoteDesk.composer.message")}
              rows={8}
              value={sendComposer.body}
              onChange={(event) =>
                setSendComposer((prev) => (prev ? { ...prev, body: event.target.value } : prev))
              }
            />
            <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-3 py-3 text-sm text-[var(--qf-text-soft)]">
              {sendComposer.handoffComplete
                ? t("quoteDesk.composer.confirmSent")
                : canSharePdfFromDevice && sendComposer.channel === "email"
                  ? t("quoteDesk.composer.sharePdfHelp")
                  : sendComposer.channel === "copy"
                    ? t("quoteDesk.composer.copyHelp")
                    : t("quoteDesk.composer.appHelp")}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                if (sendComposer.handoffComplete) {
                  setSendComposer((prev) => (prev ? { ...prev, handoffComplete: false } : prev));
                } else {
                  setSendComposer(null);
                }
              }}
              disabled={saving}
            >
              {sendComposer.handoffComplete ? t("quoteDesk.composer.shareAgain") : t("common.cancel")}
            </Button>
            <Button onClick={() => {
              if (isQuotePricingReviewBlocking(activeAiPricingReview, sendComposer.quoteId)) {
                setSendComposer(null);
                setActiveTab("quote");
                setMobilePane("editor");
                setError(t("quoteBuilder.aiPricingReview.description"));
                return;
              }
              track("send_composer_confirm");
              void confirmSendComposer();
            }} loading={saving}>
              {sendComposer.handoffComplete
                ? t("quoteDesk.composer.markSent")
                : sendComposer.channel === "copy"
                  ? t("quoteDesk.send.copyMessage")
                  : canSharePdfFromDevice && sendComposer.channel === "email"
                    ? t("quoteDesk.composer.sharePdf")
                    : sendComposer.channel === "sms"
                      ? t("quoteDesk.composer.openText")
                      : t("quoteDesk.composer.openEmail")}
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
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2.5">
      <span className="text-sm text-[var(--qf-text-soft)]">{label}</span>
      <span
        className={`text-sm font-semibold ${
          strong ? "text-[var(--qf-text)]" : tone === "good" ? "text-[var(--qf-success-strong)]" : tone === "bad" ? "text-[var(--qf-danger-strong)]" : "text-[var(--qf-text)]"
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
    <div className={`flex items-center gap-2 rounded-lg border px-3 ${compact ? "py-2" : "py-2"} ${complete ? "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)]" : "border-[var(--qf-border)] bg-[var(--qf-panel)]"}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${complete ? "bg-[var(--qf-success-strong)] text-white" : "bg-[var(--qf-interactive-active)] text-[var(--qf-text-muted)]"}`}>
        {complete ? "OK" : "-"}
      </span>
      <span className="text-sm text-[var(--qf-text-soft)]">{label}</span>
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
  onAssistDescription,
  assistDisabled,
  canViewInternalCosts,
}: {
  line: EditableQuoteLine;
  index: number;
  dirty: boolean;
  readOnly?: boolean;
  startExpanded?: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onSave: (lineId: string) => Promise<boolean>;
  onDelete: () => void;
  onAssistDescription: (lineId: string) => void;
  assistDisabled?: boolean;
  canViewInternalCosts: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formatLineMoney = (value: string | number) => money(value, i18n.resolvedLanguage ?? "en-US");
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);
  const sectionPillLabel =
    line.sectionType === "ALTERNATE"
      ? line.sectionLabel?.trim() || t("quoteComponents.line.alternate")
      : t("quoteComponents.line.included");
  const sectionPillClassName =
    line.sectionType === "ALTERNATE"
      ? "border-orange-200 bg-orange-50 text-orange-700"
      : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]";

  useEffect(() => {
    setExpanded(startExpanded ?? false);
  }, [line.id, startExpanded]);

  return (
    <div className="px-3 py-2.5 xl:hover:bg-[var(--qf-panel-muted)]/60" data-testid={`existing-quote-line-row-${index + 1}`}>
      <div className="xl:hidden">
        <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)]">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-3 text-left"
            aria-expanded={expanded}
            aria-controls={`existing-quote-line-${line.id}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteDesk.line.number", { number: index + 1 })}</p>
                {dirty ? <Badge tone="amber">{t("quoteDesk.unsaved")}</Badge> : null}
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${sectionPillClassName}`}>
                  {sectionPillLabel}
                </span>
              </div>
              <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{line.title.trim() || t("quoteComponents.savePreset.untitled")}</p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--qf-text-muted)]">
                <span>{t("quoteDesk.line.quantity")} {line.quantity}</span>
                <span>{t("quoteDesk.line.price")} {formatLineMoney(line.unitPrice)}</span>
                <span>{t("quoteComponents.math.total")} {formatLineMoney(lineTotal)}</span>
              </div>
            </div>
            <span className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] p-2 text-[var(--qf-text-muted)]">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>
          <div id={`existing-quote-line-${line.id}`} className={expanded ? "border-t border-[var(--qf-border)] px-3 py-3" : "hidden"}>
            <div className="mb-2 flex items-center justify-end gap-2">
              <Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => void onSave(line.id)} disabled={!dirty || readOnly}>
                {t("common.save")}
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onDelete} disabled={readOnly}>
                {t("quoteDesk.line.remove")}
              </Button>
            </div>
            <div className="space-y-3">
              <Input label={t("quoteDesk.line.title")} aria-label={t("quoteDesk.line.titleAria", { number: index + 1 })} value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} disabled={readOnly} />
              <div className="flex justify-end">
                <KodyFieldAssistButton
                  label={line.details.trim() ? t("quoteDesk.kodyAssist.improveLine") : t("quoteDesk.kodyAssist.draftLine")}
                  onClick={() => onAssistDescription(line.id)}
                  disabled={assistDisabled}
                />
              </div>
              <Textarea label={t("quoteDesk.line.description")} aria-label={t("quoteDesk.line.descriptionAria", { number: index + 1 })} rows={3} value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} disabled={readOnly} />
              <div className={`grid gap-2 ${canViewInternalCosts ? "grid-cols-3" : "grid-cols-2"}`}>
                <Input label={t("quoteDesk.line.quantity")} aria-label={t("quoteDesk.line.quantityAria", { number: index + 1 })} type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} disabled={readOnly} />
                {canViewInternalCosts ? <Input label={t("quoteDesk.line.cost")} aria-label={t("quoteDesk.line.costAria", { number: index + 1 })} type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} disabled={readOnly} /> : null}
                <Input label={t("quoteDesk.line.price")} aria-label={t("quoteDesk.line.priceAria", { number: index + 1 })} type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} disabled={readOnly} />
              </div>
              <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2.5 text-sm font-semibold text-[var(--qf-text)]">
                {t("quoteDesk.line.total", { amount: formatLineMoney(lineTotal) })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`hidden xl:grid xl:items-start xl:gap-2.5 ${QUOTE_DESK_EXISTING_LINE_GRID_COLUMNS} ${QUOTE_DESK_LINE_GRID_MIN_WIDTH}`}
      >
        <div className="flex h-[38px] items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-[var(--qf-text-muted)]">
          {index + 1}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {dirty ? <Badge tone="amber">{t("quoteDesk.unsaved")}</Badge> : null}
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${sectionPillClassName}`}>
              {sectionPillLabel}
            </span>
          </div>
          <Input aria-label={t("quoteDesk.line.titleAria", { number: index + 1 })} className="min-h-[38px] rounded-lg" value={line.title} onChange={(event) => onChange(line.id, "title", event.target.value)} disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-end">
            <KodyFieldAssistButton
              label={line.details.trim() ? t("quoteDesk.kodyAssist.improveLine") : t("quoteDesk.kodyAssist.draftLine")}
              onClick={() => onAssistDescription(line.id)}
              className="px-2.5"
              disabled={assistDisabled}
            />
          </div>
          <Textarea aria-label={t("quoteDesk.line.descriptionAria", { number: index + 1 })} rows={2} className="min-h-[64px] rounded-lg" value={line.details} onChange={(event) => onChange(line.id, "details", event.target.value)} disabled={readOnly} />
        </div>
        <Input aria-label={t("quoteDesk.line.quantityAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} disabled={readOnly} />
        {canViewInternalCosts ? <Input aria-label={t("quoteDesk.line.costAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} disabled={readOnly} /> : <span aria-hidden="true" />}
        <Input aria-label={t("quoteDesk.line.priceAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} disabled={readOnly} />
        <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-semibold text-[var(--qf-text)] tabular-nums">
          {formatLineMoney(lineTotal)}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            icon={<Save size={14} />}
            className="w-9 px-0"
            onClick={() => void onSave(line.id)}
            disabled={!dirty || readOnly}
            aria-label={t("quoteDesk.line.save")}
            title={t("quoteDesk.line.save")}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            className="w-9 px-0 text-[var(--qf-text-muted)] hover:text-[var(--qf-danger-strong)]"
            onClick={onDelete}
            disabled={readOnly}
            aria-label={t("quoteDesk.line.remove")}
            title={t("quoteDesk.line.remove")}
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
  canViewInternalCosts,
  onAssistDescription,
  assistDisabled,
}: {
  line: EditableQuoteLine;
  onChange: (line: EditableQuoteLine) => void;
  onAdd: () => Promise<unknown>;
  saving: boolean;
  readOnly?: boolean;
  canViewInternalCosts: boolean;
  onAssistDescription: () => void;
  assistDisabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formatLineMoney = (value: string | number) => money(value, i18n.resolvedLanguage ?? "en-US");
  const lineTotal = quoteLineAmount(line.quantity, line.unitPrice);

  return (
    <div className="space-y-3" data-testid="new-quote-line-row">
      <div
        className={`grid gap-3 ${QUOTE_DESK_NEW_LINE_GRID_COLUMNS} ${QUOTE_DESK_LINE_GRID_MIN_WIDTH}`}
      >
        <div className="hidden h-[38px] items-center justify-center rounded-lg border border-dashed border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-[var(--qf-text-muted)] xl:flex">
          {t("quoteDesk.line.new")}
        </div>
        <Input
          className="min-h-[38px] rounded-lg"
          label={t("quoteDesk.line.title")}
          aria-label={t("quoteDesk.line.newTitleAria")}
          placeholder={t("quoteDesk.line.titlePlaceholder")}
          value={line.title}
          onChange={(event) => onChange({ ...line, title: event.target.value })}
          disabled={readOnly}
        />
        <div className="space-y-1.5">
          <div className="flex justify-end">
            <KodyFieldAssistButton
              label={line.details.trim() ? t("quoteDesk.kodyAssist.improveLine") : t("quoteDesk.kodyAssist.draftLine")}
              onClick={onAssistDescription}
              className="px-2.5"
              disabled={assistDisabled}
            />
          </div>
          <Textarea
            label={t("quoteDesk.line.description")}
            aria-label={t("quoteDesk.line.newDescriptionAria")}
            rows={3}
            className="rounded-lg lg:min-h-[64px]"
            placeholder={t("quoteDesk.line.descriptionPlaceholder")}
            value={line.details}
            onChange={(event) => onChange({ ...line, details: event.target.value })}
            disabled={readOnly}
          />
        </div>
        <Input aria-label={t("quoteDesk.line.newQuantityAria")} className="min-h-[38px] rounded-lg text-right tabular-nums" label={t("quoteDesk.line.quantity")} type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange({ ...line, quantity: event.target.value })} disabled={readOnly} />
        {canViewInternalCosts ? <Input aria-label={t("quoteDesk.line.newCostAria")} className="min-h-[38px] rounded-lg text-right tabular-nums" label={t("quoteDesk.line.cost")} type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange({ ...line, unitCost: event.target.value })} disabled={readOnly} /> : <span aria-hidden="true" />}
        <Input aria-label={t("quoteDesk.line.newPriceAria")} className="min-h-[38px] rounded-lg text-right tabular-nums" label={t("quoteDesk.line.price")} type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange({ ...line, unitPrice: event.target.value })} disabled={readOnly} />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--qf-text-soft)]">{t("quoteComponents.math.total")}</label>
          <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2.5 text-sm font-semibold text-[var(--qf-text)] tabular-nums">
            {formatLineMoney(lineTotal)}
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t("quoteDesk.line.type")}
          value={line.sectionType}
          onChange={(event) =>
            onChange({
              ...line,
              sectionType: event.target.value as EditableQuoteLine["sectionType"],
              sectionLabel: event.target.value === "ALTERNATE" ? line.sectionLabel : "",
            })
          }
          disabled={readOnly}
          options={[
            { value: "INCLUDED", label: t("quoteComponents.line.included") },
            { value: "ALTERNATE", label: t("quoteComponents.line.alternate") },
          ]}
        />
        {line.sectionType === "ALTERNATE" ? (
          <Input
            label={t("quoteDesk.line.optionLabel")}
            value={line.sectionLabel}
            onChange={(event) => onChange({ ...line, sectionLabel: event.target.value })}
            placeholder={t("quoteDesk.line.optionPlaceholder")}
            disabled={readOnly}
          />
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          icon={<X size={14} />}
          onClick={() => onChange(makeEditableQuoteLine())}
          disabled={readOnly}
        >
          {t("quoteDesk.line.clear")}
        </Button>
        <Button icon={<Plus size={14} />} loading={saving} onClick={() => void onAdd()} disabled={readOnly}>
          {t("quoteDesk.line.add")}
        </Button>
      </div>
    </div>
  );
}

export default QuoteDeskView;

