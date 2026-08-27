import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Check, ChevronDown, ChevronUp, Eye, Plus, Sparkles, Trash2, X } from "lucide-react";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import { AiPaidPauseNotice } from "../components/ai/KodyFieldAssistButton";
import { KodySparkIcon } from "../components/ai/KodySparkIcon";
import { publishKodyOutcome } from "../components/ai/kody-events";
import {
  QuickCustomerModal,
  type QuickCustomerForm,
  type QuoteDraftDuplicateErrorCode,
} from "../components/customers/QuickCustomerModal";
import { QuoteLivePreview } from "../components/quotes/QuoteLivePreview";
import {
  QuoteKodyPrepareModal,
  type QuoteKodyPreparedReview,
} from "../components/quotes/QuoteKodyPrepareModal";
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
  ConfirmModal,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalHeader,
  PageHeader,
  Select,
  Textarea,
  WorkflowActionDock,
} from "../components/ui";
import {
  api,
  ApiError,
  type AiProgressEvent,
  type AiQuoteInsight,
  type AiQuoteSuggestionCustomerAmbiguousResult,
  type AiQuoteSuggestionNeedsClarificationResult,
  type AiQuoteSuggestionReadyResult,
  type CustomerDuplicateMatch,
  type QuoteCustomerDraft,
  type ServiceType,
  type SupportedLocale,
  type TenantBranding,
  type WorkPreset,
} from "../lib/api";
import { aiUsageUpdateFromApiError, formatAiPaidUsagePause, formatAiUsageNotice, publishAiUsageUpdate, resolveAiUsagePresentation } from "../lib/ai-credits";
import {
  applyKodyQuoteAiProvenance,
  clearQuoteAiProvenanceForAudit,
  quoteBuilderDraftStorageKey,
  hashQuoteCreateCommand,
  isQuoteDraftTimestampFresh,
  readQuoteBuilderDraft,
  readQuoteCreateRetryIdentity,
  reconcileQuoteAiProvenanceCustomer,
  removeQuoteBuilderDraft,
  resolveQuoteCreateRetryIdentity,
  writeQuoteBuilderDraft,
  type QuoteAiProvenance,
  type QuoteCreateRetryIdentity,
} from "../lib/quote-builder-draft-storage";
import { QUOTE_LINE_CHANGE_LIMIT, validateQuoteHeading, validateQuoteLine } from "../lib/quote-form-validation";
import {
  applyAiQuoteLinePatch,
  buildPresetPayloadFromLine,
  isIncludedEditableQuoteLine,
  joinQuoteLineDescription,
  makeEditableQuoteLine,
  quoteLineAmount,
  quoteLineCostTotal,
  splitQuoteLineDescription,
  type EditableQuoteLine,
} from "../lib/quote-lines";
import { usePageView, useTrack } from "../lib/analytics";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { formatQuoteDocumentDate, quoteDocumentCopy } from "../lib/quote-document-copy";
import { localizedApiError } from "../lib/localized-api-error";
import {
  applyQuotePreparationPricingGuard,
  resolveQuoteHandoffCustomerTotal,
  type AppliedQuotePreparation,
} from "../lib/quote-preparation";

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
    documentLocale: SupportedLocale;
  };
  lines: BuilderDraftLine[];
  mobilePane: BuilderPane;
  quickCustomerOpen: boolean;
  quickCustomerForm: QuickCustomerForm;
  quickCustomerDraft: QuoteCustomerDraft | null;
  lastAppliedAiRunId: string | null;
  lastAppliedAiCustomerId: string | null;
  quoteCreateRetryIdentity: QuoteCreateRetryIdentity | null;
};
type StoredBuilderDraft = BuilderDraftData & { version: 1; savedAtUtc: string };
type KodyQuoteDraftHandoff = {
  prompt: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  serviceType: BuilderDraftData["quote"]["serviceType"] | null;
  title: string | null;
  scopeText: string | null;
  estimatedDurationHoursLow: number | null;
  estimatedDurationHoursHigh: number | null;
  estimatedTotalAmount: number | null;
  estimatedTaxAmount: number | null;
  auditEventId: string | null;
  lineItems: Array<{
    description: string;
    quantity: number | null;
    sectionType: "INCLUDED" | "ALTERNATE" | null;
    sourcePresetId: string | null;
    unitPrice: number | null;
    unitCost: number | null;
    priceProvenance: "EXPLICIT_PROMPT" | "TENANT_PRESET" | "STANDARD_CATALOG" | "CURRENT_QUOTE" | "UNRESOLVED" | null;
  }>;
  editableLines: EditableQuoteLine[];
  hasStructuredDraft: boolean;
  hasQuickCustomerDraft: boolean;
  needsDraftChoice: boolean;
  pricingNeedsReview: boolean;
  useWorkspaceContext: boolean;
  retrievedSourceCount: number;
  retrievedSourceLabels: string[];
  receivedAtUtc: string;
};

const EMPTY_QUICK_CUSTOMER_FORM: QuickCustomerForm = { fullName: "", phone: "", email: "", notes: "" };
const SERVICE_TYPE_SET = new Set(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDraftString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function cleanKodyDraftText(value: unknown, maxLength: number): string | null {
  if (!isDraftString(value, maxLength)) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanKodyDraftLongText(value: unknown, maxLength: number): string | null {
  if (!isDraftString(value, maxLength)) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function readKodyDraftNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readKodySourceLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((candidate) => {
    const label = cleanKodyDraftText(candidate, 160);
    return label ? [label] : [];
  });
}

function readKodyDraftLineItems(value: unknown): KodyQuoteDraftHandoff["lineItems"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const description = cleanKodyDraftText(candidate.description, 500);
    if (!description) return [];
    const sectionType =
      candidate.sectionType === "INCLUDED" || candidate.sectionType === "ALTERNATE"
        ? candidate.sectionType
        : null;
    return [{
      description,
      quantity: readKodyDraftNumber(candidate.quantity),
      sectionType,
      sourcePresetId: cleanKodyDraftText(candidate.sourcePresetId, 200),
      unitPrice: readKodyDraftNumber(candidate.unitPrice),
      unitCost: readKodyDraftNumber(candidate.unitCost),
      priceProvenance:
        candidate.priceProvenance === "EXPLICIT_PROMPT" ||
        candidate.priceProvenance === "TENANT_PRESET" ||
        candidate.priceProvenance === "STANDARD_CATALOG" ||
        candidate.priceProvenance === "CURRENT_QUOTE" ||
        candidate.priceProvenance === "UNRESOLVED"
          ? candidate.priceProvenance
          : null,
    }];
  });
}

function buildEditableKodyDraftLines(
  t: TFunction,
  lineItems: KodyQuoteDraftHandoff["lineItems"],
  estimatedTotalAmount: number | null,
  estimatedTaxAmount: number | null,
): EditableQuoteLine[] {
  if (!lineItems.length) return [];
  const includedLineIndexes = lineItems
    .map((lineItem, index) => (lineItem.sectionType === "ALTERNATE" ? null : index))
    .filter((index): index is number => index !== null);
  const singlePricedLineIndex = includedLineIndexes.length === 1 ? includedLineIndexes[0] : null;
  const estimatedSubtotal =
    estimatedTotalAmount !== null
      ? Math.max(estimatedTotalAmount - (estimatedTaxAmount ?? 0), 0)
      : null;

  return lineItems.map((lineItem, index) => {
    const quantity = lineItem.quantity && lineItem.quantity > 0 ? lineItem.quantity : 1;
    const shouldSeedEstimate = lineItem.unitPrice === null
      && singlePricedLineIndex === index
      && estimatedSubtotal !== null
      && estimatedSubtotal > 0;
    const { title, details } = splitQuoteLineDescription(lineItem.description);

    return makeEditableQuoteLine({
      title: title || lineItem.description,
      details,
      sectionType: lineItem.sectionType ?? "INCLUDED",
      sectionLabel: lineItem.sectionType === "ALTERNATE" ? t("quoteComponents.line.alternate") : "",
      quantity: String(quantity),
      unitCost: (lineItem.unitCost ?? 0).toFixed(2),
      unitPrice: lineItem.priceProvenance === "UNRESOLVED"
        ? "0.00"
        : lineItem.unitPrice !== null
        ? lineItem.unitPrice.toFixed(2)
        : shouldSeedEstimate
          ? (estimatedSubtotal / quantity).toFixed(2)
          : "0.00",
      sourcePresetId: lineItem.sourcePresetId,
      presetPromptHandled: true,
    });
  });
}

function readKodyQuoteDraftState(t: TFunction, value: unknown): KodyQuoteDraftHandoff | null {
  if (!isRecord(value) || !isRecord(value.kodyQuoteDraft)) return null;
  const payload = value.kodyQuoteDraft;
  const preparation = isRecord(payload.preparation) ? payload.preparation : null;
  const preparedDraft = preparation && isRecord(preparation.draft) ? preparation.draft : null;
  const preparedCustomer = preparation && isRecord(preparation.customer) ? preparation.customer : null;
  const preparedCustomerDraft = preparation && isRecord(preparation.customerDraft) ? preparation.customerDraft : null;
  if (preparation && preparation.status !== "READY") return null;
  const draft: Record<string, unknown> = preparedDraft
    ? {
        ...payload,
        customerId: preparedCustomer?.id ?? payload.customerId,
        customerName: preparedCustomer?.fullName ?? preparedCustomerDraft?.fullName ?? payload.customerName,
        customerEmail: preparedCustomer?.email ?? preparedCustomerDraft?.email ?? payload.customerEmail,
        customerPhone: preparedCustomer?.phone ?? preparedCustomerDraft?.phone ?? payload.customerPhone,
        quoteId: preparedDraft.quoteId ?? payload.quoteId,
        serviceType: preparedDraft.serviceType ?? payload.serviceType,
        title: preparedDraft.title ?? payload.title,
        scopeText: preparedDraft.scopeText ?? payload.scopeText,
        estimatedDurationHoursLow: preparedDraft.estimatedDurationHoursLow ?? payload.estimatedDurationHoursLow,
        estimatedDurationHoursHigh: preparedDraft.estimatedDurationHoursHigh ?? payload.estimatedDurationHoursHigh,
        estimatedTotalAmount: resolveQuoteHandoffCustomerTotal(preparedDraft, payload.estimatedTotalAmount),
        estimatedTaxAmount: preparedDraft.taxAmount ?? payload.estimatedTaxAmount,
        estimatedInternalCostAmount: preparedDraft.internalCostSubtotal ?? payload.estimatedInternalCostAmount,
        lineItems: preparedDraft.lineItems ?? payload.lineItems,
        requiresPricingReview: preparedDraft.requiresPricingReview ?? payload.requiresPricingReview,
        retrievedSourceCount: preparation?.retrievedSourceCount ?? payload.retrievedSourceCount,
        retrievedSourceLabels: preparation?.retrievedSourceLabels ?? payload.retrievedSourceLabels,
        auditEventId: preparation?.auditEventId ?? payload.auditEventId,
      }
    : payload;
  const prompt = cleanKodyDraftLongText(draft.prompt, 2_000);
  const title = cleanKodyDraftText(draft.title, 500);
  const scopeText = cleanKodyDraftLongText(draft.scopeText, 4_000);
  const customerName = cleanKodyDraftText(draft.customerName, 500);
  const customerPhone = cleanKodyDraftText(draft.customerPhone, 100);
  const customerEmail = cleanKodyDraftText(draft.customerEmail, 500);
  const lineItems = readKodyDraftLineItems(draft.lineItems);
  const estimatedDurationHoursLow = readKodyDraftNumber(draft.estimatedDurationHoursLow);
  const estimatedDurationHoursHigh = readKodyDraftNumber(draft.estimatedDurationHoursHigh);
  const estimatedTotalAmount = readKodyDraftNumber(draft.estimatedTotalAmount);
  const estimatedTaxAmount = readKodyDraftNumber(draft.estimatedTaxAmount);
  const auditEventId = cleanKodyDraftText(draft.auditEventId, 200);
  const useWorkspaceContext = draft.useWorkspaceContext === true;
  const retrievedSourceLabels = readKodySourceLabels(draft.retrievedSourceLabels);
  const retrievedSourceCount = Math.max(
    0,
    Math.min(Math.floor(readKodyDraftNumber(draft.retrievedSourceCount) ?? retrievedSourceLabels.length), 20),
  );
  const promptParts = [
    prompt ?? "",
    customerName ? t("quoteBuilder.handoff.promptCustomer", { customer: customerName }) : "",
    title ? t("quoteBuilder.handoff.promptTitle", { title }) : "",
    scopeText ? t("quoteBuilder.handoff.promptScope", { scope: scopeText }) : "",
    lineItems.length
      ? [
          t("quoteBuilder.handoff.promptLines"),
          ...lineItems.map((lineItem, index) => {
            const quantity = lineItem.quantity ? t("quoteBuilder.handoff.promptQuantity", { count: lineItem.quantity }) : "";
            const section = lineItem.sectionType === "ALTERNATE" ? t("quoteBuilder.handoff.promptAlternate") : "";
            return t("quoteBuilder.handoff.promptLine", { number: index + 1, description: lineItem.description, quantity, section });
          }),
        ].join("\n")
      : "",
    estimatedTotalAmount !== null ? t("quoteBuilder.handoff.promptEstimate", { amount: estimatedTotalAmount }) : "",
    estimatedDurationHoursLow !== null && estimatedDurationHoursHigh !== null
      ? t("quoteBuilder.handoff.promptDurationRange", {
          low: estimatedDurationHoursLow,
          high: estimatedDurationHoursHigh,
        })
      : "",
  ].filter(Boolean);
  const serviceType = isDraftString(draft.serviceType, 32) && SERVICE_TYPE_SET.has(draft.serviceType)
    ? draft.serviceType as BuilderDraftData["quote"]["serviceType"]
    : null;
  const customerId = isDraftString(draft.customerId, 200) && draft.customerId.trim() ? draft.customerId.trim() : null;
  const editableLines = buildEditableKodyDraftLines(t, lineItems, estimatedTotalAmount, estimatedTaxAmount);
  const hasQuickCustomerDraft = Boolean(!customerId && customerName && customerPhone);
  const hasStructuredDraft = Boolean(
    customerId ||
      customerName ||
      customerPhone ||
      customerEmail ||
      serviceType ||
      title ||
      scopeText ||
      lineItems.length ||
      estimatedDurationHoursLow !== null ||
      estimatedDurationHoursHigh !== null ||
      estimatedTotalAmount !== null ||
      estimatedTaxAmount !== null,
  );

  return {
    prompt: promptParts.join("\n\n"),
    customerId,
    customerName,
    customerPhone,
    customerEmail,
    serviceType,
    title,
    scopeText,
    estimatedDurationHoursLow,
    estimatedDurationHoursHigh,
    estimatedTotalAmount,
    estimatedTaxAmount,
    auditEventId,
    lineItems,
    editableLines,
    hasStructuredDraft,
    hasQuickCustomerDraft,
    needsDraftChoice: false,
    pricingNeedsReview:
      draft.requiresPricingReview === true ||
      lineItems.some((line) => line.priceProvenance === "UNRESOLVED") ||
      editableLines.some((line) => Number(line.unitPrice) <= 0),
    useWorkspaceContext,
    retrievedSourceCount,
    retrievedSourceLabels,
    receivedAtUtc: new Date().toISOString(),
  };
}

function parseStoredBuilderDraft(raw: string): StoredBuilderDraft | null {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !isDraftString(value.savedAtUtc, 64)) return null;
  const savedAt = Date.parse(value.savedAtUtc);
  if (!Number.isFinite(savedAt) || !isQuoteDraftTimestampFresh(value.savedAtUtc)) return null;
  if (!isRecord(value.quote) || !Array.isArray(value.lines) || value.lines.length === 0 || value.lines.length > QUOTE_LINE_CHANGE_LIMIT) return null;
  if (
    !isDraftString(value.quote.customerId, 200) ||
    !isDraftString(value.quote.serviceType, 32) ||
    !SERVICE_TYPE_SET.has(value.quote.serviceType) ||
    !isDraftString(value.quote.title, 500) ||
    !isDraftString(value.quote.scopeText, 20_000) ||
    !isDraftString(value.quote.taxAmount, 100) ||
    (value.quote.documentLocale !== undefined && value.quote.documentLocale !== "en-US" && value.quote.documentLocale !== "es-US")
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
  if (
    value.lastAppliedAiCustomerId !== undefined
    && value.lastAppliedAiCustomerId !== null
    && !isDraftString(value.lastAppliedAiCustomerId, 200)
  ) return null;
  if (value.quickCustomerDraft !== undefined && value.quickCustomerDraft !== null) {
    if (!isRecord(value.quickCustomerDraft)) return null;
    if (
      !isDraftString(value.quickCustomerDraft.fullName, 500)
      || !isDraftString(value.quickCustomerDraft.phone, 100)
      || (value.quickCustomerDraft.email !== undefined
        && value.quickCustomerDraft.email !== null
        && !isDraftString(value.quickCustomerDraft.email, 500))
      || (value.quickCustomerDraft.notes !== undefined
        && value.quickCustomerDraft.notes !== null
        && !isDraftString(value.quickCustomerDraft.notes, 20_000))
      || (value.quickCustomerDraft.preferredLocale !== undefined
        && value.quickCustomerDraft.preferredLocale !== null
        && value.quickCustomerDraft.preferredLocale !== "en-US"
        && value.quickCustomerDraft.preferredLocale !== "es-US")
      || (value.quickCustomerDraft.duplicateAction !== undefined
        && value.quickCustomerDraft.duplicateAction !== "merge"
        && value.quickCustomerDraft.duplicateAction !== "create_new"
        && value.quickCustomerDraft.duplicateAction !== "use_existing")
      || (value.quickCustomerDraft.duplicateCustomerId !== undefined
        && !isDraftString(value.quickCustomerDraft.duplicateCustomerId, 200))
    ) return null;
  }

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
      documentLocale: value.quote.documentLocale === "es-US" ? "es-US" : "en-US",
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
    quickCustomerDraft: value.quickCustomerDraft
      ? {
          fullName: value.quickCustomerDraft.fullName as string,
          phone: value.quickCustomerDraft.phone as string,
          email: value.quickCustomerDraft.email as string | null | undefined,
          notes: value.quickCustomerDraft.notes as string | null | undefined,
          preferredLocale: value.quickCustomerDraft.preferredLocale as SupportedLocale | null | undefined,
          duplicateAction: value.quickCustomerDraft.duplicateAction as QuoteCustomerDraft["duplicateAction"],
          duplicateCustomerId: value.quickCustomerDraft.duplicateCustomerId as string | undefined,
        }
      : null,
    lastAppliedAiRunId: value.lastAppliedAiRunId as string | null,
    lastAppliedAiCustomerId: value.lastAppliedAiRunId
      ? value.lastAppliedAiCustomerId === undefined
        ? value.quote.customerId || null
        : value.lastAppliedAiCustomerId as string | null
      : null,
    quoteCreateRetryIdentity: readQuoteCreateRetryIdentity(value.quoteCreateRetryIdentity),
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

async function writeStoredBuilderDraft(
  storageKey: string,
  draft: BuilderDraftData,
  options?: { keepalive?: boolean },
) {
  if (!hasMeaningfulBuilderDraft(draft)) {
    await removeQuoteBuilderDraft(storageKey, options);
    return null;
  }
  const savedAtUtc = new Date().toISOString();
  const stored = JSON.stringify({ ...draft, version: 1, savedAtUtc } satisfies StoredBuilderDraft);
  return writeQuoteBuilderDraft(storageKey, stored, options);
}

const QUOTE_BUILDER_LINE_GRID_COLUMNS =
  "xl:grid-cols-[32px_minmax(10rem,0.95fr)_minmax(15rem,1.35fr)_72px_92px_92px_108px_84px] 2xl:grid-cols-[36px_minmax(11rem,1.05fr)_minmax(16rem,1.3fr)_72px_96px_96px_108px_88px]";
const QUOTE_BUILDER_LINE_GRID_MIN_WIDTH = "xl:min-w-[860px] 2xl:min-w-[920px]";

type BuilderKodyReview = QuoteKodyPreparedReview & {
  result: AiQuoteSuggestionReadyResult;
  patch: AppliedQuotePreparation["patch"];
  requestFingerprint: string;
  requestCustomerId: string | null;
  baseBuilderStateFingerprint: string;
};

type BuilderKodyClarification =
  | AiQuoteSuggestionNeedsClarificationResult
  | AiQuoteSuggestionCustomerAmbiguousResult;

type AiPricingReview = {
  lineDescriptions: string[];
  acknowledged: boolean;
};

export function QuoteBuilderView() {
  usePageView("quote_builder");
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const formatMoney = (value: string | number) => money(value, locale);
  const navigate = useNavigate();
  const location = useLocation();
  const track = useTrack();
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quickCustomerForm, setQuickCustomerForm] = useState<QuickCustomerForm>(EMPTY_QUICK_CUSTOMER_FORM);
  const [quickCustomerDraft, setQuickCustomerDraft] = useState<QuoteCustomerDraft | null>(null);
  const [quickCustomerDuplicateMatches, setQuickCustomerDuplicateMatches] = useState<CustomerDuplicateMatch[]>([]);
  const [quickCustomerDuplicateErrorCode, setQuickCustomerDuplicateErrorCode] = useState<QuoteDraftDuplicateErrorCode | null>(null);
  const [hydratedDraftStorageKey, setHydratedDraftStorageKey] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAtUtc, setDraftSavedAtUtc] = useState<string | null>(null);
  const [draftPersistenceFailed, setDraftPersistenceFailed] = useState(false);
  const [draftRecoveryMessage, setDraftRecoveryMessage] = useState<string | null>(null);
  const [draftRecoveryStatus, setDraftRecoveryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draftRecoveryAttempt, setDraftRecoveryAttempt] = useState(0);
  const [conflictingStoredDraft, setConflictingStoredDraft] = useState<StoredBuilderDraft | null>(null);
  const [discardDraftConfirmOpen, setDiscardDraftConfirmOpen] = useState(false);
  const keepDraftButtonRef = useRef<HTMLButtonElement | null>(null);
  const latestDraftRef = useRef<BuilderDraftData | null>(null);
  const quoteCreationCompletedRef = useRef(false);
  const quoteCreateInFlightRef = useRef(false);
  const draftAutosaveEpochRef = useRef(0);
  const pendingDraftAutosavesRef = useRef(new Set<Promise<string | null>>());
  const draftRecoveryStorageKeyRef = useRef<string | null>(null);
  const handledKodyDraftStateRef = useRef<unknown>(null);
  const kodyCustomerRequestIdRef = useRef(0);
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
  const [aiTradeHint, setAiTradeHint] = useState<ServiceType | null>(null);
  const [aiUseSelectedCustomer, setAiUseSelectedCustomer] = useState(true);
  const [aiDraftReview, setAiDraftReview] = useState<BuilderKodyReview | null>(null);
  const [aiClarification, setAiClarification] = useState<BuilderKodyClarification | null>(null);

  async function waitForPendingDraftAutosaves() {
    while (pendingDraftAutosavesRef.current.size > 0) {
      await Promise.allSettled([...pendingDraftAutosavesRef.current]);
    }
  }
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiProgressEvent, setAiProgressEvent] = useState<AiProgressEvent | null>(null);
  const [aiErrorMessage, setAiErrorMessage] = useState<string | null>(null);
  const [aiStatusMessage, setAiStatusMessage] = useState<string | null>(null);
  const aiRequestRef = useRef<{
    id: string;
    controller: AbortController;
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  const aiRetryIdentityRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const [aiInsight, setAiInsight] = useState<AiQuoteInsight | null>(null);
  const [aiPricingReview, setAiPricingReview] = useState<AiPricingReview | null>(null);
  const [lastAppliedAiProvenance, setLastAppliedAiProvenance] = useState<QuoteAiProvenance | null>(null);
  const [quoteCreateRetryIdentity, setQuoteCreateRetryIdentity] = useState<QuoteCreateRetryIdentity | null>(null);
  const [kodyDraftHandoff, setKodyDraftHandoff] = useState<KodyQuoteDraftHandoff | null>(null);
  const [kodyCustomerStatus, setKodyCustomerStatus] = useState<"idle" | "loading" | "error" | "stale">("idle");
  const [replaceKodyDraftConfirmOpen, setReplaceKodyDraftConfirmOpen] = useState(false);
  const [focusedKodyLineId, setFocusedKodyLineId] = useState<string | null>(null);
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
    canViewInternalCosts,
    canManageCatalog,
    defaultCustomerLocale,
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
    ensureCustomerLoaded,
  } = useDashboard();
  const selectedCustomerIdRef = useRef(quoteForm.customerId);
  const lastAppliedAiRunId = lastAppliedAiProvenance?.auditEventId ?? null;

  const activeCustomer = useMemo(
    () => customers.find((customer) => customer.id === quoteForm.customerId) ?? null,
    [customers, quoteForm.customerId],
  );
  const quoteCustomer = useMemo(
    () => activeCustomer ?? (quickCustomerDraft
      ? {
          fullName: quickCustomerDraft.fullName,
          phone: quickCustomerDraft.phone,
          email: quickCustomerDraft.email ?? null,
        }
      : null),
    [activeCustomer, quickCustomerDraft],
  );
  const customerReady = Boolean(quoteCustomer);
  const aiUsage = useMemo(() => resolveAiUsagePresentation(session?.usage), [session?.usage]);
  const aiUsageLimitMessage = useMemo(
    () => formatAiPaidUsagePause(session?.usage ?? {}, locale),
    [locale, session?.usage],
  );
  const preparedDateLabel = useMemo(
    () => formatQuoteDocumentDate(new Date(), quoteForm.documentLocale, session?.timezone),
    [quoteForm.documentLocale, session?.timezone],
  );
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
        documentLocale: quoteForm.documentLocale,
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
      quickCustomerDraft,
      lastAppliedAiRunId,
      lastAppliedAiCustomerId: lastAppliedAiProvenance?.customerId ?? null,
      quoteCreateRetryIdentity,
    }),
    [draftLines, lastAppliedAiProvenance, lastAppliedAiRunId, mobilePane, quickCustomerDraft, quickCustomerForm, quickCustomerOpen, quoteCreateRetryIdentity, quoteForm],
  );
  const hasMeaningfulDraft = useMemo(() => hasMeaningfulBuilderDraft(currentBuilderDraft), [currentBuilderDraft]);
  const {
    navigationPromptOpen,
    requestNavigation,
    cancelNavigation,
    continueNavigation,
  } = useUnsavedChangesGuard(
    hasMeaningfulDraft && hydratedDraftStorageKey === draftStorageKey && !saving && !quoteCreationCompletedRef.current,
  );
  latestDraftRef.current = currentBuilderDraft;
  selectedCustomerIdRef.current = quoteForm.customerId;

  useEffect(() => {
    setLastAppliedAiProvenance((current) => reconcileQuoteAiProvenanceCustomer(current, quoteForm.customerId));
  }, [quoteForm.customerId]);

  useEffect(() => {
    if (!quoteForm.customerId) return;
    setQuickCustomerDraft(null);
    setQuickCustomerDuplicateMatches([]);
    setQuickCustomerDuplicateErrorCode(null);
  }, [quoteForm.customerId]);

  useEffect(() => {
    if (!draftStorageKey) return;
    let cancelled = false;
    quoteCreationCompletedRef.current = false;
    setDraftRestored(false);
    setDraftRecoveryStatus("loading");
    setHydratedDraftStorageKey((current) => current === draftStorageKey ? null : current);
    if (draftRecoveryStorageKeyRef.current !== draftStorageKey) {
      draftRecoveryStorageKeyRef.current = draftStorageKey;
      setDraftRecoveryMessage(null);
    }
    void (async () => {
      let hydrationDeferred = false;
      let recoveryFailed = false;
      try {
        const result = await readQuoteBuilderDraft(draftStorageKey);
        if (cancelled) return;
        if (result.status === "error") {
          recoveryFailed = true;
          setDraftRecoveryStatus("error");
          return;
        }
        if (result.status === "not-found") {
          setDraftRecoveryStatus("ready");
          return;
        }
        const stored = parseStoredBuilderDraft(result.raw);
        if (!stored || !hasMeaningfulBuilderDraft(stored)) {
          await removeQuoteBuilderDraft(draftStorageKey);
          if (!cancelled) setDraftRecoveryMessage(t("quoteBuilder.recovery.incompatible"));
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
          documentLocale: stored.quote.documentLocale,
          internalCostSubtotal: "0",
          customerPriceSubtotal: "0",
        }));
        setDraftLines(stored.lines.map((line) => makeEditableQuoteLine(line)));
        setMobilePane(stored.mobilePane);
        setQuickCustomerOpen(stored.quickCustomerOpen);
        setQuickCustomerForm(stored.quickCustomerForm);
        setQuickCustomerDraft(stored.quickCustomerDraft);
        setLastAppliedAiProvenance(stored.lastAppliedAiRunId ? {
          auditEventId: stored.lastAppliedAiRunId,
          customerId: stored.lastAppliedAiCustomerId,
        } : null);
        setQuoteCreateRetryIdentity(stored.quoteCreateRetryIdentity);
        setDraftSavedAtUtc(stored.savedAtUtc);
        setDraftPersistenceFailed(false);
        setDraftRestored(true);
        setConflictingStoredDraft(null);
        setDraftRecoveryStatus("ready");
      } catch {
        await removeQuoteBuilderDraft(draftStorageKey);
        if (!cancelled) {
          setDraftRecoveryStatus("ready");
          setDraftRecoveryMessage(t("quoteBuilder.recovery.unreadable"));
        }
      } finally {
        if (!cancelled && !hydrationDeferred && !recoveryFailed) {
          setDraftRecoveryStatus("ready");
          setHydratedDraftStorageKey(draftStorageKey);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftRecoveryAttempt, draftStorageKey, setQuoteForm, t]);

  useEffect(() => {
    if (draftStorageKey && hydratedDraftStorageKey !== draftStorageKey) return;
    const draft = readKodyQuoteDraftState(t, location.state);
    if (!draft) return;
    if (handledKodyDraftStateRef.current === location.state) return;
    handledKodyDraftStateRef.current = location.state;

    const canApplyKodyContext = !hasMeaningfulDraft;
    if (canApplyKodyContext && draft.customerId) {
      selectQuoteCustomer(draft.customerId);
      const requestId = ++kodyCustomerRequestIdRef.current;
      setKodyCustomerStatus("loading");
      void ensureCustomerLoaded(draft.customerId)
        .then((customer) => {
          if (kodyCustomerRequestIdRef.current !== requestId) return;
          if (!customer) {
            setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, draft.auditEventId));
            setQuoteForm((current) => current.customerId === draft.customerId
              ? { ...current, customerId: "" }
              : current);
            setKodyDraftHandoff((current) => current?.customerId === draft.customerId
              ? { ...current, customerId: null }
              : current);
            setKodyCustomerStatus("stale");
            return;
          }
          setKodyCustomerStatus("idle");
        })
        .catch((error: unknown) => {
          if (kodyCustomerRequestIdRef.current !== requestId) return;
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, draft.auditEventId));
            setQuoteForm((current) => current.customerId === draft.customerId
              ? { ...current, customerId: "" }
              : current);
            setKodyDraftHandoff((current) => current?.customerId === draft.customerId
              ? { ...current, customerId: null }
              : current);
            setKodyCustomerStatus("stale");
            return;
          }
          setKodyCustomerStatus("error");
        });
    }
    if (canApplyKodyContext && !draft.customerId && draft.hasQuickCustomerDraft) {
      setQuickCustomerForm((current) => ({
        ...current,
        fullName: draft.customerName ?? current.fullName,
        phone: draft.customerPhone ?? current.phone,
        email: draft.customerEmail ?? current.email,
      }));
      setQuickCustomerDraft(null);
      setQuickCustomerDuplicateMatches([]);
      setQuickCustomerDuplicateErrorCode(null);
      setQuickCustomerOpen(true);
    }
    if (canApplyKodyContext && (draft.serviceType || draft.title || draft.scopeText || draft.estimatedTaxAmount !== null)) {
      setQuoteForm((current) => ({
        ...current,
        serviceType: draft.serviceType ?? current.serviceType,
        title: draft.title ?? current.title,
        scopeText: draft.scopeText ?? current.scopeText,
        taxAmount: draft.estimatedTaxAmount !== null ? String(draft.estimatedTaxAmount) : current.taxAmount,
      }));
    }
    if (canApplyKodyContext && draft.editableLines.length) {
      setDraftLines(draft.editableLines);
    }
    if (canApplyKodyContext && draft.auditEventId) {
      setLastAppliedAiProvenance({
        auditEventId: draft.auditEventId,
        customerId: draft.customerId,
      });
    }
    if (draft.prompt) {
      setChatPrompt(draft.prompt);
    }
    setKodyDraftHandoff({ ...draft, needsDraftChoice: !canApplyKodyContext && draft.hasStructuredDraft });
    setAiModalOpen(!draft.hasStructuredDraft);
    setMobilePane("editor");
    setNotice(
      canApplyKodyContext
        ? t("quoteBuilder.notices.kodyReviewDraft")
        : t("quoteBuilder.notices.kodyPromptReady"),
    );
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [
    location.pathname,
    location.search,
    location.state,
    navigate,
    draftStorageKey,
    ensureCustomerLoaded,
    hasMeaningfulDraft,
    hydratedDraftStorageKey,
    selectQuoteCustomer,
    setChatPrompt,
    setNotice,
    setQuoteForm,
    t,
  ]);

  useEffect(() => {
    if (!draftStorageKey || hydratedDraftStorageKey !== draftStorageKey || quoteCreationCompletedRef.current) return;
    let cancelled = false;
    const autosaveEpoch = draftAutosaveEpochRef.current;
    const timer = window.setTimeout(() => {
      if (quoteCreationCompletedRef.current || autosaveEpoch !== draftAutosaveEpochRef.current) return;
      const writePromise = writeStoredBuilderDraft(draftStorageKey, currentBuilderDraft);
      pendingDraftAutosavesRef.current.add(writePromise);
      void writePromise
        .then((savedAtUtc) => {
          if (cancelled || autosaveEpoch !== draftAutosaveEpochRef.current) return;
          setDraftSavedAtUtc(savedAtUtc);
          setDraftPersistenceFailed(hasMeaningfulDraft && !savedAtUtc);
        })
        .finally(() => {
          pendingDraftAutosavesRef.current.delete(writePromise);
        });
    }, 650);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentBuilderDraft, draftStorageKey, hasMeaningfulDraft, hydratedDraftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey || hydratedDraftStorageKey !== draftStorageKey) return;
    const persistLatestDraft = () => {
      if (quoteCreationCompletedRef.current || !latestDraftRef.current) return;
      const writePromise = writeStoredBuilderDraft(draftStorageKey, latestDraftRef.current, { keepalive: true });
      pendingDraftAutosavesRef.current.add(writePromise);
      void writePromise.finally(() => {
        pendingDraftAutosavesRef.current.delete(writePromise);
      });
    };
    window.addEventListener("pagehide", persistLatestDraft);
    return () => {
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
  const effectiveAiPricingReview = useMemo<AiPricingReview | null>(() => {
    if (aiPricingReview) return aiPricingReview;
    if (!lastAppliedAiRunId) return null;
    const zeroPricedLines = includedDraftLines.filter((line) => Number(line.unitPrice) <= 0);
    if (!zeroPricedLines.length) return null;
    return {
      lineDescriptions: zeroPricedLines.map((line) => line.title.trim() || t("quoteBuilder.aiPricingReview.untitledLine")),
      acknowledged: false,
    };
  }, [aiPricingReview, includedDraftLines, lastAppliedAiRunId, t]);

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
  const businessHint = useMemo(() => buildBusinessHint(branding), [branding]);
  const quoteAccentColor = useMemo(() => resolveQuoteAccentColor(branding), [branding]);
  const quoteFooterText = useMemo(
    () =>
      buildQuoteFooterText({
        businessName: session?.tenantName ?? "QuoteFly",
        businessPhone: branding?.businessPhone ?? null,
        businessEmail: branding?.businessEmail ?? null,
        documentLocale: quoteForm.documentLocale,
      }),
    [branding?.businessEmail, branding?.businessPhone, quoteForm.documentLocale, session?.tenantName],
  );
  const showQuoteFlyAttribution = useMemo(
    () => shouldShowQuoteFlyAttribution(session?.effectivePlanCode, branding?.hideQuoteFlyAttribution),
    [branding?.hideQuoteFlyAttribution, session?.effectivePlanCode],
  );

  function buildBuilderKodyRequest(customerOverrideId?: string | null) {
    const requestCustomerId = customerOverrideId !== undefined
      ? customerOverrideId
      : aiUseSelectedCustomer
        ? activeCustomer?.id ?? null
        : null;
    const stagedCustomerContext =
      customerOverrideId === undefined &&
      aiUseSelectedCustomer &&
      !activeCustomer
        ? quickCustomerDraft
        : null;
    const requestPrompt = stagedCustomerContext
      ? [
          `Customer: ${stagedCustomerContext.fullName}`,
          `Phone: ${stagedCustomerContext.phone}`,
          stagedCustomerContext.email ? `Email: ${stagedCustomerContext.email}` : null,
          chatPrompt.trim(),
        ].filter(Boolean).join("\n")
      : chatPrompt.trim();
    const requestBody = {
      prompt: requestPrompt,
      ...(requestCustomerId ? { customerId: requestCustomerId } : {}),
      ...(aiTradeHint ? { serviceType: aiTradeHint } : {}),
      ...(quoteForm.title ? { currentTitle: quoteForm.title } : {}),
      ...(quoteForm.scopeText ? { currentScopeText: quoteForm.scopeText } : {}),
      currentLineItems: filteredDraftLines.map((line) => ({
        id: line.id,
        description: joinQuoteLineDescription(line.title, line.details),
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel || null,
        quantity: Number(line.quantity) || 1,
        unitCost: Number(line.unitCost) || 0,
        unitPrice: Number(line.unitPrice) || 0,
        sourcePresetId: line.sourcePresetId ?? undefined,
      })),
    };

    return { requestBody, requestCustomerId };
  }

  function buildBuilderKodyApplyStateFingerprint() {
    return JSON.stringify({
      quote: {
        customerId: quoteForm.customerId,
        serviceType: quoteForm.serviceType,
        title: quoteForm.title,
        scopeText: quoteForm.scopeText,
        internalCostSubtotal: quoteForm.internalCostSubtotal,
        customerPriceSubtotal: quoteForm.customerPriceSubtotal,
        taxAmount: quoteForm.taxAmount,
        documentLocale: quoteForm.documentLocale,
      },
      customerDraft: quickCustomerDraft
        ? {
            fullName: quickCustomerDraft.fullName,
            phone: quickCustomerDraft.phone,
            email: quickCustomerDraft.email ?? null,
            notes: quickCustomerDraft.notes ?? null,
            preferredLocale: quickCustomerDraft.preferredLocale ?? null,
            duplicateAction: quickCustomerDraft.duplicateAction ?? null,
            duplicateCustomerId: quickCustomerDraft.duplicateCustomerId ?? null,
          }
        : null,
      customerForm: {
        fullName: quickCustomerForm.fullName,
        phone: quickCustomerForm.phone,
        email: quickCustomerForm.email,
        notes: quickCustomerForm.notes,
      },
      lines: draftLines.map((line) => ({
        id: line.id,
        title: line.title.trim(),
        details: line.details.replace(/\r\n/g, "\n").trim(),
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel.trim(),
        quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : line.quantity.trim(),
        unitCost: Number.isFinite(Number(line.unitCost)) ? Number(line.unitCost) : line.unitCost.trim(),
        unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : line.unitPrice.trim(),
        sourcePresetId: line.sourcePresetId ?? null,
        presetPromptHandled: Boolean(line.presetPromptHandled),
      })),
      prompt: chatPrompt,
      kodyDraftHandoff,
      mobilePane,
      priorPricingReview: aiPricingReview,
      priorInsight: aiInsight,
      priorProvenance: lastAppliedAiProvenance,
    });
  }

  function openBuilderKodyDraft() {
    if (!canUseChatToQuote || aiUsage.paidActionsUnavailable) {
      setError(t("quoteBuilder.errors.aiUnavailable"));
      return;
    }
    if (!chatPrompt.trim() && !aiDraftReview && !aiClarification) {
      setAiUseSelectedCustomer(Boolean(quoteCustomer));
      setAiTradeHint(null);
      setAiClarification(null);
    }
    setAiErrorMessage(null);
    setAiStatusMessage(null);
    setAiModalOpen(true);
  }

  async function handleAiDraftSubmit(event: React.FormEvent) {
    event.preventDefault();
    await prepareBuilderKodyDraft();
  }

  async function prepareBuilderKodyDraft(customerOverrideId?: string | null) {
    if (!canUseChatToQuote || aiUsage.paidActionsUnavailable) {
      setError(t("quoteBuilder.errors.aiUnavailable"));
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setError(t("quoteBuilder.errors.promptRequired"));
      return;
    }

    if (aiUsage.paidActionsUnavailable) {
      setAiErrorMessage(aiUsageLimitMessage);
      return;
    }

    const { requestBody, requestCustomerId } = buildBuilderKodyRequest(customerOverrideId);
    const fingerprint = JSON.stringify(requestBody);
    const idempotencyKey = aiRetryIdentityRef.current?.fingerprint === fingerprint
      ? aiRetryIdentityRef.current.idempotencyKey
      : `qf-ai-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    aiRequestRef.current = { id: requestId, controller, fingerprint, idempotencyKey };

    track("builder_ai_modal_submit");
    try {
      setAiSubmitting(true);
      setError(null);
      setAiProgressEvent(null);
      setAiErrorMessage(null);
      setAiStatusMessage(null);
      const result = await api.quotes.suggestWithAi(requestBody, {
        onProgress: (event) => {
          if (aiRequestRef.current?.id === requestId && !controller.signal.aborted) {
            setAiProgressEvent(event);
          }
        },
        idempotencyKey,
        signal: controller.signal,
      });
      if (aiRequestRef.current?.id !== requestId || controller.signal.aborted) return;
      if (result.status !== "READY") {
        aiRetryIdentityRef.current = null;
        setChatParsed(result.parsed);
        setAiClarification(result);
        setAiDraftReview(null);
        publishAiUsageUpdate(result.usage);
        return;
      }
      const { parsed, suggestion, patch, preparation, usage } = result;
      aiRetryIdentityRef.current = null;
      const {
        suggestion: reviewedSuggestion,
        patch: reviewedPatch,
        pricingReviewLines,
      } = applyQuotePreparationPricingGuard({ preparation, suggestion, patch });

      setChatParsed(parsed);
      setAiClarification(null);
      setAiDraftReview({
        result,
        preparation,
        suggestion: reviewedSuggestion,
        patch: reviewedPatch,
        pricingReviewDescriptions: pricingReviewLines.map(
          (line) => splitQuoteLineDescription(line.description).title || line.description,
        ),
        requestFingerprint: fingerprint,
        requestCustomerId,
        baseBuilderStateFingerprint: buildBuilderKodyApplyStateFingerprint(),
      });
      publishAiUsageUpdate(usage);
    } catch (err) {
      if (aiRequestRef.current?.id !== requestId || controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      const usageUpdate = aiUsageUpdateFromApiError(err);
      if (usageUpdate) publishAiUsageUpdate(usageUpdate);
      const message = localizedApiError(err, t, { fallbackKey: "quoteBuilder.errors.aiApply" });
      setAiErrorMessage(message);
      setError(message);
      const ambiguousFailure = !(err instanceof ApiError) || err.status === 409 || err.status === 503;
      aiRetryIdentityRef.current = ambiguousFailure ? { fingerprint, idempotencyKey } : null;
    } finally {
      if (aiRequestRef.current?.id === requestId) {
        aiRequestRef.current = null;
        setAiSubmitting(false);
        setAiProgressEvent(null);
      }
    }
  }

  async function applyBuilderKodyReview() {
    if (!aiDraftReview) return;

    const { requestBody } = buildBuilderKodyRequest(aiDraftReview.requestCustomerId);
    if (
      JSON.stringify(requestBody) !== aiDraftReview.requestFingerprint ||
      buildBuilderKodyApplyStateFingerprint() !== aiDraftReview.baseBuilderStateFingerprint
    ) {
      setAiErrorMessage(t("quoteBuilder.kodyPrepare.stale"));
      return;
    }

    const { result, preparation, suggestion, patch, pricingReviewDescriptions } = aiDraftReview;
    const matchedCustomer = result.customer;
    let loadedMatchedCustomer = null;
    if (matchedCustomer) {
      try {
        setAiSubmitting(true);
        setAiErrorMessage(null);
        loadedMatchedCustomer = await ensureCustomerLoaded(matchedCustomer.id, { forceRefresh: true });
        if (!loadedMatchedCustomer) {
          setAiErrorMessage(t("quoteBuilder.kodyPrepare.customerLoadError"));
          return;
        }
      } catch {
        setAiErrorMessage(t("quoteBuilder.kodyPrepare.customerLoadError"));
        return;
      } finally {
        setAiSubmitting(false);
      }
    }
    const stagedCustomerDraft =
      !matchedCustomer &&
      preparation.customerResolution === "NEW_CUSTOMER_DRAFT" &&
      preparation.customerDraft.fullName?.trim() &&
      preparation.customerDraft.phone?.trim()
        ? {
            fullName: preparation.customerDraft.fullName.trim(),
            phone: preparation.customerDraft.phone.trim(),
            email: preparation.customerDraft.email?.trim() || null,
            preferredLocale: quoteForm.documentLocale,
          }
        : null;

    if (matchedCustomer) {
      setQuickCustomerDraft(null);
      setQuickCustomerForm(EMPTY_QUICK_CUSTOMER_FORM);
    } else if (stagedCustomerDraft) {
      setQuickCustomerForm({
        fullName: stagedCustomerDraft.fullName,
        phone: stagedCustomerDraft.phone,
        email: stagedCustomerDraft.email ?? "",
        notes: "",
      });
      setQuickCustomerDraft(stagedCustomerDraft);
    }

    setQuoteForm((current) => ({
      ...current,
      customerId: matchedCustomer?.id ?? (stagedCustomerDraft ? "" : current.customerId),
      documentLocale: loadedMatchedCustomer?.preferredLocale ?? (matchedCustomer ? defaultCustomerLocale : current.documentLocale),
      serviceType: suggestion.serviceType,
      title: suggestion.title,
      scopeText: suggestion.scopeText,
      internalCostSubtotal: String(suggestion.internalCostSubtotal ?? 0),
      customerPriceSubtotal: String(suggestion.customerPriceSubtotal),
      taxAmount: String(suggestion.taxAmount),
    }));
    setDraftLines((current) => {
      const appliedLines = applyAiQuoteLinePatch(current, patch);
      const meaningfulLines = appliedLines.filter((line) => line.title.trim() || line.details.trim());
      return meaningfulLines.length ? meaningfulLines : [makeEditableQuoteLine()];
    });
    const requiresPricingReview = suggestion.requiresPricingReview === true || pricingReviewDescriptions.length > 0;
    setAiPricingReview(requiresPricingReview ? {
      lineDescriptions: pricingReviewDescriptions,
      acknowledged: false,
    } : null);
    setAiInsight(result.insight);
    setLastAppliedAiProvenance({
      auditEventId: result.aiRunId,
      customerId: matchedCustomer?.id ?? null,
    });
    setKodyDraftHandoff(null);
    void loadCustomers();
    setChatPrompt("");
    setAiDraftReview(null);
    setAiClarification(null);
    setAiErrorMessage(null);
    setAiStatusMessage(null);
    setError(null);
    setAiModalOpen(false);
    setMobilePane("editor");

    const usageSummary = formatAiUsageNotice(result.usage, locale);
    const patchSummary = [
      patch.updated ? t("quoteBuilder.aiPatch.updated", { count: patch.updated }) : null,
      patch.added ? t("quoteBuilder.aiPatch.added", { count: patch.added }) : null,
      patch.removed ? t("quoteBuilder.aiPatch.removed", { count: patch.removed }) : null,
    ]
      .filter(Boolean)
      .join(", ");
    setNotice(
      t("quoteBuilder.notices.aiApplied", {
        customer:
          matchedCustomer?.fullName ??
          stagedCustomerDraft?.fullName ??
          result.parsed.customerName ??
          t("quoteBuilder.customerGeneric"),
        changes: patchSummary ? `${patchSummary}. ` : "",
        usage: usageSummary ? `${usageSummary} ` : "",
      }),
    );
  }

  function cancelAiDraftRequest() {
    const activeRequest = aiRequestRef.current;
    if (!activeRequest) return;
    activeRequest.controller.abort();
    aiRetryIdentityRef.current = {
      fingerprint: activeRequest.fingerprint,
      idempotencyKey: activeRequest.idempotencyKey,
    };
    aiRequestRef.current = null;
    setAiSubmitting(false);
    setAiProgressEvent(null);
    setAiErrorMessage(null);
    setAiStatusMessage(t("quoteComponents.aiModal.cancelled"));
    track("builder_ai_modal_cancel");
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
    setNotice(t("quoteBuilder.notices.presetLoaded", { name: preset.name }));
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
      setNotice(includeDescription ? t("quoteBuilder.notices.presetFullSaved") : t("quoteBuilder.notices.presetNameSaved"));
      setPresetPromptLine(null);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "quoteBuilder.errors.presetSave" }));
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
      documentLocale: stored.quote.documentLocale,
      internalCostSubtotal: "0",
      customerPriceSubtotal: "0",
    }));
    setDraftLines(stored.lines.map((line) => makeEditableQuoteLine(line)));
    setMobilePane(stored.mobilePane);
    setQuickCustomerOpen(stored.quickCustomerOpen);
    setQuickCustomerForm(stored.quickCustomerForm);
    setQuickCustomerDraft(stored.quickCustomerDraft);
    setLastAppliedAiProvenance(stored.lastAppliedAiRunId ? {
      auditEventId: stored.lastAppliedAiRunId,
      customerId: stored.lastAppliedAiCustomerId,
    } : null);
    setQuoteCreateRetryIdentity(stored.quoteCreateRetryIdentity);
    setDraftSavedAtUtc(stored.savedAtUtc);
    setDraftRestored(true);
    setConflictingStoredDraft(null);
    setDraftRecoveryStatus("ready");
    setDraftRecoveryMessage(null);
    setHydratedDraftStorageKey(draftStorageKey);
    setNotice(t("quoteBuilder.notices.draftRestored"));
  }

  function retryBuilderDraftRecovery() {
    if (!draftStorageKey || draftRecoveryStatus === "loading") return;
    setDraftRecoveryMessage(null);
    setDraftRecoveryAttempt((current) => current + 1);
  }

  async function startFreshAfterRecoveryError() {
    if (!draftStorageKey) return;
    setDraftRecoveryStatus("loading");
    setDraftRecoveryMessage(null);
    const cleared = await removeQuoteBuilderDraft(draftStorageKey);
    if (!cleared) {
      setDraftRecoveryStatus("error");
      setDraftRecoveryMessage(t("quoteBuilder.recovery.clearFailed"));
      return;
    }
    setDraftRecoveryStatus("ready");
    setHydratedDraftStorageKey(draftStorageKey);
    setNotice(t("quoteBuilder.notices.recoveryFresh"));
  }

  function retryKodyCustomerVerification() {
    const customerId = kodyDraftHandoff?.customerId;
    const handoffAuditEventId = kodyDraftHandoff?.auditEventId ?? null;
    if (!customerId || kodyCustomerStatus === "loading") return;
    const requestId = ++kodyCustomerRequestIdRef.current;
    setKodyCustomerStatus("loading");
    void ensureCustomerLoaded(customerId)
      .then((customer) => {
        if (kodyCustomerRequestIdRef.current !== requestId) return;
        if (!customer) {
          setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, handoffAuditEventId));
          setQuoteForm((current) => current.customerId === customerId
            ? { ...current, customerId: "" }
            : current);
          setKodyDraftHandoff((current) => current?.customerId === customerId
            ? { ...current, customerId: null }
            : current);
          setKodyCustomerStatus("stale");
          return;
        }
        selectQuoteCustomer(customerId);
        setKodyCustomerStatus("idle");
      })
      .catch((error: unknown) => {
        if (kodyCustomerRequestIdRef.current !== requestId) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, handoffAuditEventId));
          setQuoteForm((current) => current.customerId === customerId
            ? { ...current, customerId: "" }
            : current);
          setKodyDraftHandoff((current) => current?.customerId === customerId
            ? { ...current, customerId: null }
            : current);
          setKodyCustomerStatus("stale");
          return;
        }
        setKodyCustomerStatus("error");
      });
  }

  async function startFreshForSelectedCustomer() {
    if (!draftStorageKey || quoteCreationCompletedRef.current) return;
    quoteCreationCompletedRef.current = true;
    draftAutosaveEpochRef.current += 1;
    await waitForPendingDraftAutosaves();
    const cleared = await removeQuoteBuilderDraft(draftStorageKey);
    if (!cleared) {
      quoteCreationCompletedRef.current = false;
      setDraftRecoveryStatus("error");
      setDraftRecoveryMessage(t("quoteBuilder.recovery.clearFailed"));
      return;
    }
    setConflictingStoredDraft(null);
    setDraftRestored(false);
    setDraftSavedAtUtc(null);
    setDraftPersistenceFailed(false);
    setQuoteCreateRetryIdentity(null);
    setDraftRecoveryStatus("ready");
    setDraftRecoveryMessage(null);
    setHydratedDraftStorageKey(draftStorageKey);
    setNotice(t("quoteBuilder.notices.freshForCustomer"));
    window.setTimeout(() => {
      quoteCreationCompletedRef.current = false;
    }, 0);
  }

  async function clearStoredBuilderDraft() {
    quoteCreationCompletedRef.current = true;
    draftAutosaveEpochRef.current += 1;
    await waitForPendingDraftAutosaves();
    if (draftStorageKey && hydratedDraftStorageKey === draftStorageKey) {
      const cleared = await removeQuoteBuilderDraft(draftStorageKey);
      if (!cleared) {
        quoteCreationCompletedRef.current = false;
        setError(t("quoteBuilder.recovery.clearFailed"));
        return false;
      }
    }
    setDraftSavedAtUtc(null);
    setDraftPersistenceFailed(false);
    setDraftRestored(false);
    return true;
  }

  async function startBuilderOver() {
    if (!(await clearStoredBuilderDraft())) return;
    setQuoteForm({
      customerId: "",
      serviceType: session?.primaryTrade ?? "HVAC",
      title: "",
      scopeText: "",
      internalCostSubtotal: "0",
      customerPriceSubtotal: "0",
      taxAmount: "0",
      documentLocale: defaultCustomerLocale,
    });
    setDraftLines([makeEditableQuoteLine()]);
    setQuickCustomerOpen(false);
    setQuickCustomerForm(EMPTY_QUICK_CUSTOMER_FORM);
    setQuickCustomerDraft(null);
    setQuickCustomerDuplicateMatches([]);
    setQuickCustomerDuplicateErrorCode(null);
    setMobilePane("editor");
    setAiModalOpen(false);
    setAiInsight(null);
    setAiPricingReview(null);
    setLastAppliedAiProvenance(null);
    setQuoteCreateRetryIdentity(null);
    setKodyDraftHandoff(null);
    setChatPrompt("");
    setChatParsed(null);
    setPresetPromptLine(null);
    setDiscardDraftConfirmOpen(false);
    setDraftRecoveryMessage(null);
    setConflictingStoredDraft(null);
    setNotice(t("quoteBuilder.notices.fresh"));
    window.setTimeout(() => {
      quoteCreationCompletedRef.current = false;
    }, 0);
  }

  async function handleCreateQuote() {
    if (quoteCreateInFlightRef.current) return;
    if (!quoteForm.customerId && !quickCustomerDraft) {
      setError(t("quoteBuilder.errors.customerRequired"));
      return;
    }

    if (filteredDraftLines.length === 0) {
      setError(t("quoteBuilder.errors.lineRequired"));
      return;
    }

    if (filteredDraftLines.length > QUOTE_LINE_CHANGE_LIMIT) {
      setError(t("quoteBuilder.errors.lineLimit", { count: QUOTE_LINE_CHANGE_LIMIT }));
      return;
    }

    const linesToCreate = filteredDraftLines;
    const scopeText =
      quoteForm.scopeText.trim() ||
      linesToCreate.map((line) => joinQuoteLineDescription(line.title, line.details)).join("\n");
    const headingError = localizedQuoteHeadingError(t, quoteForm.title, scopeText, quoteForm.taxAmount);
    if (headingError) {
      setError(headingError);
      return;
    }
    const invalidLineIndex = linesToCreate.findIndex((line) => validateQuoteLine(line) !== null);
    if (invalidLineIndex >= 0) {
      setError(localizedQuoteLineError(t, linesToCreate[invalidLineIndex], t("quoteDesk.line.number", { number: invalidLineIndex + 1 })));
      return;
    }
    if (kodyCustomerStatus === "loading" || kodyCustomerStatus === "error") {
      setError(t("quoteBuilder.errors.customerVerification"));
      return;
    }
    if (effectiveAiPricingReview && !effectiveAiPricingReview.acknowledged) {
      setError(t("quoteBuilder.errors.aiPricingAcknowledgement"));
      setMobilePane("editor");
      return;
    }
    if (!draftStorageKey || hydratedDraftStorageKey !== draftStorageKey || draftRecoveryStatus !== "ready") {
      setError(t("quoteBuilder.errors.recoveryNotReady"));
      return;
    }
    const promptCandidate = canManageCatalog ?
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
        ) ?? null : null;

    const initialLineItems = linesToCreate.map((line) => ({
      description: joinQuoteLineDescription(line.title, line.details),
      sectionType: line.sectionType,
      sectionLabel: line.sectionLabel || null,
      quantity: Number(line.quantity) || 1,
      unitCost: Number(line.unitCost) || 0,
      unitPrice: Number(line.unitPrice) || 0,
      sourcePresetId: line.sourcePresetId ?? undefined,
    }));
    quoteCreateInFlightRef.current = true;
    track("builder_quote_create");
    try {
      const quoteCustomerDraft = quickCustomerDraft
        ? { ...quickCustomerDraft, preferredLocale: quoteForm.documentLocale }
        : undefined;
      const serializedCreateCommand = JSON.stringify({
        ...(quoteForm.customerId
          ? { customerId: quoteForm.customerId }
          : { customerDraft: quoteCustomerDraft }),
        serviceType: quoteForm.serviceType,
        title: quoteForm.title,
        scopeText,
        internalCostSubtotal: Number(internalSubtotal.toFixed(2)),
        customerPriceSubtotal: Number(customerSubtotal.toFixed(2)),
        taxAmount: Number(quoteForm.taxAmount),
        documentLocale: quoteForm.documentLocale,
        aiUsageEventId: lastAppliedAiRunId ?? undefined,
        aiPricingReviewAcknowledged: effectiveAiPricingReview?.acknowledged === true ? true : undefined,
        lineItems: initialLineItems,
      });
      const payloadHash = await hashQuoteCreateCommand(serializedCreateCommand);
      if (quoteCreateRetryIdentity && quoteCreateRetryIdentity.payloadHash !== payloadHash) {
        setError(t("quoteBuilder.errors.retryPayloadChanged"));
        return;
      }
      const retryIdentity = resolveQuoteCreateRetryIdentity(payloadHash, quoteCreateRetryIdentity);
      draftAutosaveEpochRef.current += 1;
      await waitForPendingDraftAutosaves();
      const draftWithRetryIdentity: BuilderDraftData = {
        ...currentBuilderDraft,
        quoteCreateRetryIdentity: retryIdentity,
      };
      const retryIdentitySavedAtUtc = await writeStoredBuilderDraft(draftStorageKey, draftWithRetryIdentity);
      if (!retryIdentitySavedAtUtc) {
        setError(t("quoteBuilder.errors.retryIdentitySave"));
        return;
      }
      latestDraftRef.current = draftWithRetryIdentity;
      setQuoteCreateRetryIdentity(retryIdentity);
      setDraftSavedAtUtc(retryIdentitySavedAtUtc);
      setDraftPersistenceFailed(false);

      const createdQuote = await createQuoteDraftFromForm({
        quoteOverride: {
          scopeText,
          internalCostSubtotal: internalSubtotal.toFixed(2),
          customerPriceSubtotal: customerSubtotal.toFixed(2),
        },
        aiUsageEventId: lastAppliedAiRunId ?? undefined,
        aiPricingReviewAcknowledged: effectiveAiPricingReview?.acknowledged === true ? true : undefined,
        initialLineItems,
        idempotencyKey: retryIdentity.idempotencyKey,
        customerDraft: quoteCustomerDraft,
        onCreateError: (createError) => {
          if (!(createError instanceof ApiError)) return false;
          const details = createError.details as {
            code?: string;
            matches?: CustomerDuplicateMatch[];
          } | undefined;
          const duplicateCode = details?.code;
          if (![
            "DUPLICATE_CANDIDATE",
            "STALE_DUPLICATE_TARGET",
            "USE_EXISTING_REQUIRES_RESTORE",
            "MERGE_CONTACT_CONFLICT",
            "PHONE_CONFLICT",
          ].includes(duplicateCode ?? "")) return false;
          setQuickCustomerDuplicateMatches(Array.isArray(details?.matches) ? details.matches : []);
          setQuickCustomerDuplicateErrorCode(duplicateCode as QuoteDraftDuplicateErrorCode);
          setQuoteCreateRetryIdentity(null);
          setQuickCustomerOpen(true);
          setError(null);
          return true;
        },
        beforeSuccessNavigation: async () => {
          quoteCreationCompletedRef.current = true;
          draftAutosaveEpochRef.current += 1;
          await waitForPendingDraftAutosaves();
          const cleared = await removeQuoteBuilderDraft(draftStorageKey);
          if (!cleared) {
            quoteCreationCompletedRef.current = false;
            setError(t("quoteBuilder.errors.createdCleanupFailed"));
            return false;
          }
          setQuoteCreateRetryIdentity(null);
          setDraftSavedAtUtc(null);
          setDraftPersistenceFailed(false);
          setDraftRestored(false);
          return true;
        },
        successNotice: t("quoteBuilder.notices.quoteReady"),
      });

      if (createdQuote) {
        void loadCustomers();
        if (kodyDraftHandoff) {
          publishKodyOutcome({
            type: "QUOTE_CREATED",
            quoteTitle: createdQuote.title,
            customerName: quoteCustomer?.fullName,
          });
        }
        setQuickCustomerDraft(null);
        setQuickCustomerDuplicateMatches([]);
        setQuickCustomerDuplicateErrorCode(null);
        setQuickCustomerForm(EMPTY_QUICK_CUSTOMER_FORM);
        setDraftLines([makeEditableQuoteLine()]);
        setAiInsight(null);
        setAiPricingReview(null);
        setLastAppliedAiProvenance(null);
        if (!presetPromptLine && promptCandidate) {
          setPresetPromptLine(promptCandidate);
        }
      }
    } finally {
      quoteCreateInFlightRef.current = false;
    }
  }

  function applyKodyDraftChoice(strategy: "merge" | "replace") {
    const handoff = kodyDraftHandoff;
    if (!handoff) return;
    const finalCustomerId = strategy === "replace"
      ? handoff.customerId ?? ""
      : quoteForm.customerId || handoff.customerId || "";
    setQuoteForm((current) => ({
      ...current,
      customerId: strategy === "replace"
        ? handoff.customerId ?? ""
        : current.customerId || handoff.customerId || "",
      serviceType: strategy === "replace"
        ? handoff.serviceType ?? current.serviceType
        : current.serviceType,
      title: strategy === "replace"
        ? handoff.title ?? ""
        : current.title || handoff.title || "",
      scopeText: strategy === "replace"
        ? handoff.scopeText ?? ""
        : current.scopeText || handoff.scopeText || "",
      taxAmount: strategy === "replace"
        ? String(handoff.estimatedTaxAmount ?? 0)
        : current.taxAmount,
    }));
    setDraftLines((current) => {
      const incoming = handoff.editableLines;
      if (strategy === "replace") return incoming.length ? incoming : [makeEditableQuoteLine()];
      const meaningfulCurrent = current.filter((line) => Boolean(
        line.title.trim()
        || line.details.trim()
        || line.sectionType === "ALTERNATE"
        || line.sectionLabel.trim()
        || Number(line.quantity) !== 1
        || Number(line.unitCost) !== 0
        || Number(line.unitPrice) !== 0,
      ));
      const merged = [...meaningfulCurrent, ...incoming].slice(0, QUOTE_LINE_CHANGE_LIMIT);
      return merged.length ? merged : [makeEditableQuoteLine()];
    });

    const shouldAdoptHandoffCustomer = strategy === "replace" || !quoteForm.customerId;
    if (shouldAdoptHandoffCustomer && handoff.customerId) {
      const customerId = handoff.customerId;
      const requestId = ++kodyCustomerRequestIdRef.current;
      setKodyCustomerStatus("loading");
      void ensureCustomerLoaded(customerId)
        .then((customer) => {
          if (kodyCustomerRequestIdRef.current !== requestId) return;
          if (!customer) {
            setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, handoff.auditEventId));
            setQuoteForm((current) => current.customerId === customerId
              ? { ...current, customerId: "" }
              : current);
            setKodyDraftHandoff((current) => current?.customerId === customerId
              ? { ...current, customerId: null }
              : current);
            setKodyCustomerStatus("stale");
            return;
          }
          setKodyCustomerStatus("idle");
        })
        .catch((error: unknown) => {
          if (kodyCustomerRequestIdRef.current !== requestId) return;
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            setLastAppliedAiProvenance((current) => clearQuoteAiProvenanceForAudit(current, handoff.auditEventId));
            setQuoteForm((current) => current.customerId === customerId
              ? { ...current, customerId: "" }
              : current);
            setKodyDraftHandoff((current) => current?.customerId === customerId
              ? { ...current, customerId: null }
              : current);
            setKodyCustomerStatus("stale");
            return;
          }
          setKodyCustomerStatus("error");
        });
    }
    if (shouldAdoptHandoffCustomer && !handoff.customerId && handoff.hasQuickCustomerDraft) {
      setQuickCustomerForm({
        fullName: handoff.customerName ?? "",
        phone: handoff.customerPhone ?? "",
        email: handoff.customerEmail ?? "",
        notes: "",
      });
      setQuickCustomerDraft(null);
      setQuickCustomerDuplicateMatches([]);
      setQuickCustomerDuplicateErrorCode(null);
      setQuickCustomerOpen(true);
    } else if (strategy === "replace" && handoff.customerId) {
      setQuickCustomerOpen(false);
      setQuickCustomerForm(EMPTY_QUICK_CUSTOMER_FORM);
      setQuickCustomerDraft(null);
      setQuickCustomerDuplicateMatches([]);
      setQuickCustomerDuplicateErrorCode(null);
    }

    setKodyDraftHandoff({ ...handoff, needsDraftChoice: false });
    setReplaceKodyDraftConfirmOpen(false);
    setAiModalOpen(false);
    setLastAppliedAiProvenance((current) => applyKodyQuoteAiProvenance(current, handoff, finalCustomerId));
    setMobilePane("editor");
    setNotice(t("quoteBuilder.notices.kodyReviewDraft"));
  }

  function focusKodyDraftLines() {
    const firstLineId = draftLines[0]?.id ?? null;
    setFocusedKodyLineId(firstLineId);
    setMobilePane("editor");
  }

  const mobileBuilderStep = mobilePane === "preview" ? 3 : customerReady ? 2 : 1;

  return (
    <div className="space-y-5" data-testid="quote-builder">
      <PageHeader
        title={t("quoteBuilder.title")}
        subtitle={t("quoteBuilder.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {selectedQuoteId ? (
              <Button onClick={() => requestNavigation(() => navigateToQuote(selectedQuoteId))}>{t("quoteBuilder.openActive")}</Button>
            ) : null}
          </div>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {draftRecoveryMessage ? (
        <Alert tone="warning" onDismiss={() => setDraftRecoveryMessage(null)}>{draftRecoveryMessage}</Alert>
      ) : null}
      {draftRecoveryStatus === "error" ? (
        <div
          role="alert"
          data-testid="quote-builder-recovery-error"
          className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]"
        >
          <p className="text-sm font-semibold">{t("quoteBuilder.recovery.loadFailedTitle")}</p>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteBuilder.recovery.loadFailedDescription")}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={retryBuilderDraftRecovery}>{t("quoteBuilder.recovery.retry")}</Button>
            <Button onClick={() => void startFreshAfterRecoveryError()}>{t("quoteBuilder.recovery.startFresh")}</Button>
          </div>
        </div>
      ) : null}
      {kodyDraftHandoff ? (
          <KodyDraftHandoffBanner
          handoff={kodyDraftHandoff}
          activeCustomer={activeCustomer ? {
            id: activeCustomer.id,
            fullName: activeCustomer.fullName,
            phone: activeCustomer.phone,
            email: activeCustomer.email,
          } : null}
          onMerge={() => applyKodyDraftChoice("merge")}
          onReplace={() => setReplaceKodyDraftConfirmOpen(true)}
          onReview={focusKodyDraftLines}
          onDismiss={() => {
            setReplaceKodyDraftConfirmOpen(false);
            setKodyDraftHandoff(null);
          }}
        />
      ) : null}
      {kodyCustomerStatus === "error" || kodyCustomerStatus === "stale" ? (
        <div
          role="alert"
          data-testid="kody-customer-recovery"
          className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]"
        >
          <p className="text-sm font-semibold">
            {kodyCustomerStatus === "stale"
              ? t("quoteBuilder.handoff.customerStaleTitle")
              : t("quoteBuilder.handoff.customerVerifyTitle")}
          </p>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {kodyCustomerStatus === "stale"
              ? t("quoteBuilder.handoff.customerStaleDescription")
              : t("quoteBuilder.handoff.customerVerifyDescription")}
          </p>
          {kodyCustomerStatus === "error" ? (
            <Button className="mt-3" variant="outline" onClick={retryKodyCustomerVerification}>
              {t("quoteBuilder.handoff.retryCustomer")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {conflictingStoredDraft ? (
        <div
          role="alert"
          data-testid="quote-builder-draft-conflict"
          className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]"
        >
          <p className="text-sm font-semibold">{t("quoteBuilder.conflictTitle")}</p>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {t("quoteBuilder.conflictDescription")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" size="sm" onClick={restoreConflictingDraft}>
              {t("quoteBuilder.restoreDraft")}
            </Button>
            <Button size="sm" onClick={startFreshForSelectedCustomer}>
              {t("quoteBuilder.startFresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {hasMeaningfulDraft && hydratedDraftStorageKey === draftStorageKey ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="quote-builder-draft-status"
          className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-quotefly-blue/10 text-quotefly-blue">
                <Check size={15} strokeWidth={2.5} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--qf-text)]">
                  {draftPersistenceFailed
                    ? t("quoteBuilder.draftOpen")
                    : draftRestored
                      ? t("quoteBuilder.draftRestored")
                      : t("quoteBuilder.draftAutosaved")}
                </p>
                <p className="truncate text-xs text-[var(--qf-text-soft)]">
                  {draftPersistenceFailed
                    ? t("quoteBuilder.keepOpen")
                    : t("quoteBuilder.savedWorkspace", { time: draftSavedAtUtc ? ` · ${formatDateTime(draftSavedAtUtc, locale, session?.timezone)}` : "" })}
                </p>
              </div>
            </div>
            {!discardDraftConfirmOpen ? (
              <button
                type="button"
                className="min-h-[44px] shrink-0 rounded-lg px-2 text-xs font-semibold text-[var(--qf-text-soft)] transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-danger-text)] sm:min-h-[36px]"
                onClick={() => setDiscardDraftConfirmOpen(true)}
                aria-label={t("quoteBuilder.discardAria")}
              >
                {t("quoteBuilder.startOver")}
              </button>
            ) : null}
          </div>
          {discardDraftConfirmOpen ? (
            <div role="group" aria-label={t("quoteBuilder.confirmDiscardAria")} className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-quotefly-blue/10 pt-2">
              <span className="mr-auto text-xs font-semibold text-[var(--qf-text-soft)]">{t("quoteBuilder.discardQuestion")}</span>
              <Button ref={keepDraftButtonRef} variant="outline" size="sm" onClick={() => setDiscardDraftConfirmOpen(false)}>
                {t("quoteBuilder.keepDraft")}
              </Button>
              <Button variant="danger" size="sm" onClick={startBuilderOver}>
                {t("quoteBuilder.discardDraft")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {aiInsight ? (
        <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-3 text-sm text-[var(--qf-text-soft)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">{t("quoteBuilder.whyAi")}</p>
              <p className="mt-1 font-medium text-[var(--qf-text)]">{aiInsight.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => setAiInsight(null)}
              className="self-start min-h-[44px] rounded-lg px-2 text-xs font-medium text-[var(--qf-text-muted)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] sm:min-h-[36px]"
            >
              {t("quoteBuilder.dismiss")}
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
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--qf-text-soft)]">
              <span className="font-semibold text-[var(--qf-text)]">{t("quoteBuilder.contextUsed")}</span>
              {aiInsight.sources.map((source, index) => (
                <span
                  key={`${source.type}-${source.label}-${index}`}
                  className="rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel)] px-2.5 py-1"
                >
                  {source.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {effectiveAiPricingReview ? (
        <div
          role="alert"
          data-testid="ai-pricing-review"
          className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] px-4 py-4 text-[var(--qf-text)]"
        >
          <p className="text-sm font-semibold">{t("quoteBuilder.aiPricingReview.title")}</p>
          <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">
            {t("quoteBuilder.aiPricingReview.description")}
          </p>
          {effectiveAiPricingReview.lineDescriptions.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--qf-text-soft)]">
              {effectiveAiPricingReview.lineDescriptions.slice(0, 6).map((description, index) => (
                <li key={`${description}-${index}`}>{description}</li>
              ))}
            </ul>
          ) : null}
          <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-[var(--qf-warning-border)] bg-[var(--qf-panel)] px-3 py-2.5 text-sm font-medium text-[var(--qf-text)] focus-within:ring-4 focus-within:ring-[var(--qf-focus-ring)]">
            <input
              type="checkbox"
              checked={effectiveAiPricingReview.acknowledged}
              onChange={(event) => setAiPricingReview({ ...effectiveAiPricingReview, acknowledged: event.target.checked })}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--qf-action-primary)]"
            />
            <span>{t("quoteBuilder.aiPricingReview.acknowledge")}</span>
          </label>
        </div>
      ) : null}

      <ol className="grid grid-cols-3 overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-1.5 xl:hidden" aria-label={t("quoteBuilder.progressAria")}>
        {[t("quoteBuilder.steps.customer"), t("quoteBuilder.steps.work"), t("quoteBuilder.steps.review")].map((label, index) => {
          const step = index + 1;
          const active = step === mobileBuilderStep;
          const complete = step < mobileBuilderStep;
          return (
            <li
              key={label}
              aria-current={active ? "step" : undefined}
              className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-2 text-xs font-semibold transition ${
                active ? "bg-[var(--qf-selected)] text-[var(--qf-link)]" : complete ? "text-[var(--qf-text-soft)]" : "text-[var(--qf-text-muted)]"
              }`}
            >
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                active ? "bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]" : complete ? "bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]" : "bg-[var(--qf-panel-muted)] text-[var(--qf-text-muted)]"
              }`}>
                {complete ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : step}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card variant="blue" padding="md" className="order-2 hidden self-start xl:block xl:sticky xl:top-24">
          <CardHeader
            title={t("quoteBuilder.actionsTitle")}
            subtitle={t("quoteBuilder.actionsDescription")}
          />
          <div className="mb-4">
            <Select
              label={t("quoteBuilder.trade")}
              value={quoteForm.serviceType}
              onChange={(event) =>
                setQuoteForm((prev) => ({
                  ...prev,
                  serviceType: event.target.value as typeof prev.serviceType,
                }))
              }
              options={[
                { value: "HVAC", label: t("domain.trade.HVAC") },
                { value: "PLUMBING", label: t("domain.trade.PLUMBING") },
                { value: "FLOORING", label: t("domain.trade.FLOORING") },
                { value: "ROOFING", label: t("domain.trade.ROOFING") },
                { value: "GARDENING", label: t("domain.trade.GARDENING") },
                { value: "CONSTRUCTION", label: t("domain.trade.CONSTRUCTION") },
              ]}
            />
          </div>
          <div className="space-y-3 text-sm">
            {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.internalCost")} value={formatMoney(internalSubtotal)} /> : null}
            <SummaryRow label={t("quoteComponents.math.customerSubtotal")} value={formatMoney(customerSubtotal)} />
            <SummaryRow label={t("quoteComponents.math.tax")} value={formatMoney(taxAmount)} />
            <SummaryRow label={t("quoteComponents.math.total")} value={formatMoney(totalAmount)} strong />
            {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.estimatedProfit")} value={formatMoney(estimatedProfit)} tone={estimatedProfit >= 0 ? "good" : "bad"} /> : null}
            {canViewInternalCosts ? <SummaryRow label={t("quoteComponents.math.margin")} value={new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(estimatedMarginPercent / 100)} tone={estimatedMarginPercent >= 10 ? "good" : "bad"} /> : null}
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-700">
            <ChecklistItem compact complete={customerReady} label={t("quoteBuilder.selected")} />
            <ChecklistItem compact complete={Boolean(quoteForm.title.trim())} label={t("quoteBuilder.titleAdded")} />
            <ChecklistItem compact complete={filteredDraftLines.length > 0} label={t("quoteBuilder.linesReady", { count: filteredDraftLines.length || 0 })} />
          </div>
          <div className="mt-4 grid gap-2">
            <Button fullWidth loading={saving} onClick={() => void handleCreateQuote()}>
              {t("quoteBuilder.create")}
            </Button>
          </div>
        </Card>

        <div className={`order-1 ${mobilePane === "preview" ? "hidden xl:block" : ""}`}>
          <QuoteSheetEditor
            title={quoteForm.title}
            onTitleChange={(value) => setQuoteForm((prev) => ({ ...prev, title: value }))}
            titlePlaceholder={t("quoteBuilder.titlePlaceholder")}
            businessName={session?.tenantName ?? "QuoteFly"}
            businessHint={businessHint}
            customerName={quoteCustomer?.fullName ?? t("quoteBuilder.selectCustomer")}
            customerHint={quoteCustomer ? `${quoteCustomer.phone}${quoteCustomer.email ? ` / ${quoteCustomer.email}` : ""}` : t("quoteBuilder.customerHint")}
            headerTools={
              <InlineCustomerLookup
                selectedCustomer={activeCustomer}
                onSelectCustomer={(customer) => {
                  selectQuoteCustomer(customer.id);
                  setNotice(t("quoteBuilder.notices.customerLoaded", { name: customer.fullName }));
                }}
                onAddCustomer={() => setQuickCustomerOpen(true)}
              />
            }
            customerTools={
              <div className="min-w-[190px]">
                <Select
                  label={t("quoteComponents.documentLanguage.label")}
                  value={quoteForm.documentLocale}
                  onChange={(event) => setQuoteForm((previous) => ({
                    ...previous,
                    documentLocale: event.target.value as SupportedLocale,
                  }))}
                  options={[
                    { value: "en-US", label: t("quoteComponents.documentLanguage.english") },
                    { value: "es-US", label: t("quoteComponents.documentLanguage.spanish") },
                  ]}
                />
                <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("quoteComponents.documentLanguage.help")}</p>
              </div>
            }
            preparedDateLabel={preparedDateLabel}
            sentDateLabel={quoteDocumentCopy(quoteForm.documentLocale).notAvailable}
            overview={quoteForm.scopeText}
            onOverviewChange={(value) => setQuoteForm((prev) => ({ ...prev, scopeText: value }))}
            overviewPlaceholder={t("quoteComponents.sheet.overviewPlaceholder")}
            logoUrl={branding?.logoUrl ?? null}
            logoPosition={branding?.logoPosition ?? "left"}
            templateId={branding?.templateId ?? "modern"}
            accentColor={quoteAccentColor}
            componentColors={branding?.componentColors ?? null}
            footerText={quoteFooterText}
            showQuoteFlyAttribution={showQuoteFlyAttribution}
            documentLocale={quoteForm.documentLocale}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<KodySparkIcon size={18} />}
                  className="hidden xl:inline-flex"
                  onClick={openBuilderKodyDraft}
                  disabled={!canUseChatToQuote || aiUsage.paidActionsUnavailable}
                  aria-describedby={aiUsage.paidActionsUnavailable ? "quote-builder-ai-pause-desktop" : undefined}
                >
                  {t("quoteBuilder.kodyPrepare.open")}
                </Button>
                <Button className="hidden xl:inline-flex" variant="outline" size="sm" icon={<Eye size={14} />} onClick={() => setPreviewOpen(true)}>
                  {t("quoteBuilder.preview")}
                </Button>
                {aiUsage.paidActionsUnavailable ? (
                  <AiPaidPauseNotice id="quote-builder-ai-pause-desktop" message={aiUsageLimitMessage} className="hidden basis-full xl:block" />
                ) : null}
              </div>
            }
          >
            {!customerReady ? (
              <div className="space-y-3 rounded-xl border border-dashed border-quotefly-blue/25 bg-quotefly-blue/[0.04] px-3 py-3 text-sm text-slate-600 xl:hidden">
                <p>{t("quoteBuilder.selectToStart")}</p>
                <Button
                  variant="secondary"
                  icon={<KodySparkIcon size={18} />}
                  onClick={openBuilderKodyDraft}
                  disabled={!canUseChatToQuote || aiUsage.paidActionsUnavailable}
                  aria-describedby={aiUsage.paidActionsUnavailable ? "quote-builder-ai-pause-mobile-empty" : undefined}
                  className="w-full justify-center"
                >
                  {t("quoteBuilder.kodyPrepare.open")}
                </Button>
                {aiUsage.paidActionsUnavailable ? <AiPaidPauseNotice id="quote-builder-ai-pause-mobile-empty" message={aiUsageLimitMessage} /> : null}
              </div>
            ) : null}

            <div className={`grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2 ${customerReady ? "grid" : "hidden"} xl:hidden`}>
              <Select
                label={t("quoteBuilder.workType")}
                value={quoteForm.serviceType}
                onChange={(event) =>
                  setQuoteForm((prev) => ({
                    ...prev,
                    serviceType: event.target.value as typeof prev.serviceType,
                  }))
                }
                options={[
                  { value: "HVAC", label: t("domain.trade.HVAC") },
                  { value: "PLUMBING", label: t("domain.trade.PLUMBING") },
                  { value: "FLOORING", label: t("domain.trade.FLOORING") },
                  { value: "ROOFING", label: t("domain.trade.ROOFING") },
                  { value: "GARDENING", label: t("domain.trade.GARDENING") },
                  { value: "CONSTRUCTION", label: t("domain.trade.CONSTRUCTION") },
                ]}
              />
              <Button variant="outline" onClick={() => setPresetPickerOpen(true)}>
                <span className="sm:hidden">{t("quoteBuilder.productsShort")}</span>
                <span className="hidden sm:inline">{t("quoteBuilder.products")}</span>
              </Button>
              <Button
                variant="outline"
                icon={<KodySparkIcon size={17} />}
                onClick={openBuilderKodyDraft}
                disabled={!canUseChatToQuote || aiUsage.paidActionsUnavailable}
                aria-describedby={aiUsage.paidActionsUnavailable ? "quote-builder-ai-pause-mobile" : undefined}
                aria-label={t("quoteBuilder.kodyPrepare.open")}
                title={t("quoteBuilder.kodyPrepare.open")}
              >
                Kody
              </Button>
              {aiUsage.paidActionsUnavailable ? <AiPaidPauseNotice id="quote-builder-ai-pause-mobile" message={aiUsageLimitMessage} className="col-span-3" /> : null}
            </div>

            <div className="hidden rounded-2xl border border-slate-200 bg-slate-50 p-3 xl:block">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t("quoteBuilder.products")}</p>
                  <p className="mt-1 text-sm text-slate-600">{t("quoteBuilder.catalogDescription")}</p>
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
                      />
                    </div>
                    <Button size="sm" variant="outline" onClick={() => applyPresetToDraft(selectedPreset)}>
                      {t("quoteBuilder.loadSelected")}
                    </Button>
                  </div>
                ) : null}
              </div>

              {presetLoadError ? <p className="mt-3 text-xs text-red-600">{presetLoadError}</p> : null}

              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {presetsLoading ? (
                  <LoadingState
                    title={t("quoteBuilder.catalogLoading")}
                    description={t("quoteBuilder.catalogLoadingDescription")}
                    variant="compact"
                    className="min-w-[260px] bg-white"
                  />
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
                  <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{formatMoney(preset.unitPrice)} / {t(`quoteComponents.units.${preset.unitType}`)}</p>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-sm text-slate-500">
                    {t("quoteBuilder.catalogEmpty")}
                  </div>
                )}
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setPresetPickerOpen(true)}>
                  {t("quoteBuilder.browseAll")}
                </Button>
              </div>
            </div>

            <div className={`overflow-x-auto rounded-2xl border border-slate-200 bg-white ${customerReady ? "block" : "hidden"} xl:block`}>
              <div
                className={`hidden gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 xl:grid ${QUOTE_BUILDER_LINE_GRID_COLUMNS} ${QUOTE_BUILDER_LINE_GRID_MIN_WIDTH}`}
              >
                <span>#</span>
                <span>{t("quoteDesk.line.title")}</span>
                <span>{t("quoteDesk.line.description")}</span>
                <span>{t("quoteDesk.line.quantity")}</span>
                <span>{canViewInternalCosts ? t("quoteDesk.line.cost") : ""}</span>
                <span>{t("quoteDesk.line.price")}</span>
                <span>{t("quoteComponents.math.total")}</span>
                <span className="text-right">{t("quoteDesk.line.actions")}</span>
              </div>
              <div className="divide-y divide-slate-200">
                {draftLines.map((line, index) => (
                  <DraftLineEditorRow
                    key={line.id}
                    line={line}
                    index={index}
                    startExpanded={!line.title.trim() && !line.details.trim()}
                    forceExpanded={line.id === focusedKodyLineId}
                    canViewInternalCosts={canViewInternalCosts}
                    onChange={updateDraftLine}
                    onInsertBelow={addBlankLine}
                    onRemove={removeDraftLine}
                  />
                ))}
                <div className="px-3 py-3 xl:hidden">
                  <Button className="w-full" variant="outline" icon={<Plus size={15} />} onClick={() => addBlankLine()}>
                    {t("quoteBuilder.addItem")}
                  </Button>
                </div>
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
            customerName={quoteCustomer?.fullName ?? t("quoteBuilder.selectCustomer")}
            customerPhone={quoteCustomer?.phone ?? null}
            customerEmail={quoteCustomer?.email ?? null}
            preparedDateLabel={preparedDateLabel}
            sentDateLabel={quoteDocumentCopy(quoteForm.documentLocale).notAvailable}
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
            documentLocale={quoteForm.documentLocale}
          />
        </div>
      ) : null}

      {customerReady || mobilePane === "preview" ? <div className="xl:hidden">
        <div className="h-20" />
        <WorkflowActionDock className="px-3 py-2.5">
          {error ? <p role="alert" className="mb-2 line-clamp-2 text-xs font-medium text-red-700">{error}</p> : null}
          {mobilePane === "editor" ? (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 pl-1">
                <p className="text-[11px] font-medium text-[var(--qf-text-muted)]">
                  {t("quoteBuilder.workItems", { count: filteredDraftLines.length })}
                </p>
                <p className="text-sm font-bold text-[var(--qf-text)]">{t("quoteComponents.math.total")} {formatMoney(totalAmount)}</p>
              </div>
              <Button className="min-w-[148px]" icon={<Eye size={15} />} onClick={() => setMobilePane("preview")}>
                {t("quoteBuilder.review")}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <Button variant="outline" icon={<ArrowLeft size={15} />} onClick={() => setMobilePane("editor")}>
                {t("quoteBuilder.back")}
              </Button>
              <Button loading={saving} onClick={() => void handleCreateQuote()}>
                {t("quoteBuilder.create")}
              </Button>
            </div>
          )}
        </WorkflowActionDock>
      </div> : null}

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={() => setQuickCustomerOpen(false)}
        draftValue={quickCustomerForm}
        onDraftChange={(draft) => {
          setQuickCustomerForm(draft);
          setQuickCustomerDraft(null);
          setQuickCustomerDuplicateMatches([]);
          setQuickCustomerDuplicateErrorCode(null);
        }}
        quoteDraftMatches={quickCustomerDuplicateMatches}
        quoteDraftErrorCode={quickCustomerDuplicateErrorCode}
        onQuoteDraftReviewChange={() => setQuickCustomerDuplicateErrorCode(null)}
        onQuoteDraftStaged={(draft) => {
          setQuoteForm((current) => ({ ...current, customerId: "" }));
          setQuickCustomerDraft({ ...draft, preferredLocale: quoteForm.documentLocale });
          setQuickCustomerDuplicateMatches([]);
          setQuickCustomerDuplicateErrorCode(null);
          setNotice(t("quoteBuilder.notices.customerReady", { name: draft.fullName }));
        }}
        onCreated={async ({ customer, intent, merged, restored, reusedExisting }) => {
          setQuickCustomerDraft(null);
          setQuickCustomerDuplicateMatches([]);
          setQuickCustomerDuplicateErrorCode(null);
          void loadCustomers();
          selectQuoteCustomer(customer.id);
          const createNotice = reusedExisting
            ? t("quoteBuilder.notices.customerExisting")
            : merged
              ? restored
                ? t("quoteBuilder.notices.customerMergedRestored")
                : t("quoteBuilder.notices.customerMerged")
              : restored
                ? t("quoteBuilder.notices.customerRestored")
                : t("quoteBuilder.notices.customerCreated");
          setNotice(intent === "quote" ? t("quoteBuilder.notices.customerReady", { name: customer.fullName }) : createNotice);
        }}
      />

      <SaveLinePresetModal
        open={canManageCatalog && Boolean(presetPromptLine)}
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
        primaryActionLabel={t("quoteBuilder.loadSelectedProduct")}
        onPrimaryAction={() => {
          if (!selectedPreset) return;
          applyPresetToDraft(selectedPreset);
          setPresetPickerOpen(false);
        }}
        onManageProducts={canManageCatalog ? () => {
          setPresetPickerOpen(false);
          requestNavigation(() => navigate("/app/products"));
        } : undefined}
        canViewInternalCosts={canViewInternalCosts}
      />

      <QuoteKodyPrepareModal
        open={aiModalOpen}
        onClose={() => {
          if (aiSubmitting) {
            cancelAiDraftRequest();
            return;
          }
          setAiModalOpen(false);
          setAiErrorMessage(null);
          setAiStatusMessage(null);
        }}
        prompt={chatPrompt}
        onPromptChange={(value) => {
          setChatPrompt(value);
          setAiClarification(null);
          setAiErrorMessage(null);
          setAiStatusMessage(null);
        }}
        selectedCustomer={quoteCustomer}
        useSelectedCustomer={aiUseSelectedCustomer}
        onUseSelectedCustomerChange={(value) => {
          setAiUseSelectedCustomer(value);
          setAiClarification(null);
          setAiErrorMessage(null);
        }}
        tradeHint={aiTradeHint}
        onTradeHintChange={(value) => {
          setAiTradeHint(value);
          setAiClarification(null);
          setAiErrorMessage(null);
        }}
        clarification={aiClarification?.preparation ?? null}
        review={aiDraftReview}
        usageLimitMessage={aiUsage.paidActionsUnavailable ? aiUsageLimitMessage : null}
        errorMessage={aiErrorMessage}
        statusMessage={aiStatusMessage}
        loading={aiSubmitting}
        loadingLabel={aiProgressEvent?.label ?? null}
        disabled={!canUseChatToQuote || aiUsage.paidActionsUnavailable}
        onSubmit={(event) => void handleAiDraftSubmit(event)}
        onSelectCandidate={(customerId) => void prepareBuilderKodyDraft(customerId)}
        onEditRequest={() => {
          setAiDraftReview(null);
          setAiClarification(null);
          setAiErrorMessage(null);
        }}
        onApply={applyBuilderKodyReview}
      />

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="xl" ariaLabel={t("quoteBuilder.preview")}>
        <ModalHeader
          title={t("quoteBuilder.preview")}
          description={t("quoteBuilder.previewDescription")}
          onClose={() => setPreviewOpen(false)}
        />
        <ModalBody className="bg-[var(--qf-panel-muted)]">
          <QuoteLivePreview
            businessName={session?.tenantName ?? "QuoteFly"}
            businessHint={businessHint}
            customerName={quoteCustomer?.fullName ?? t("quoteBuilder.selectCustomer")}
            customerPhone={quoteCustomer?.phone ?? null}
            customerEmail={quoteCustomer?.email ?? null}
            preparedDateLabel={preparedDateLabel}
            sentDateLabel={quoteDocumentCopy(quoteForm.documentLocale).notAvailable}
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
            documentLocale={quoteForm.documentLocale}
          />
        </ModalBody>
      </Modal>

      <ConfirmModal
        open={replaceKodyDraftConfirmOpen}
        onClose={() => setReplaceKodyDraftConfirmOpen(false)}
        onConfirm={() => applyKodyDraftChoice("replace")}
        title={t("quoteBuilder.handoff.replaceConfirmTitle")}
        description={t("quoteBuilder.handoff.replaceConfirmDescription")}
        confirmLabel={t("quoteBuilder.handoff.replaceConfirm")}
        confirmVariant="warning"
      />

      <ConfirmModal
        open={navigationPromptOpen}
        onClose={cancelNavigation}
        onConfirm={continueNavigation}
        title={t("quoteBuilder.leaveTitle")}
        description={t("quoteBuilder.leaveDescription")}
        confirmLabel={t("quoteBuilder.leaveConfirm")}
        confirmVariant="warning"
      />
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
          strong ? "text-[var(--qf-text)]" : tone === "good" ? "text-[var(--qf-success-text)]" : tone === "bad" ? "text-[var(--qf-danger-text)]" : "text-[var(--qf-text)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function KodyDraftHandoffBanner({
  handoff,
  activeCustomer,
  onMerge,
  onReplace,
  onReview,
  onDismiss,
}: {
  handoff: KodyQuoteDraftHandoff;
  activeCustomer: { id: string; fullName: string; phone: string; email?: string | null } | null;
  onMerge: () => void;
  onReplace: () => void;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const customerLabel = handoff.customerName ?? activeCustomer?.fullName ?? t("quoteBuilder.handoff.customerNotSelected");
  const currentCustomerIdentity = activeCustomer
    ? [activeCustomer.fullName, activeCustomer.email || activeCustomer.phone].filter(Boolean).join(" · ")
    : null;
  const kodyCustomerIdentity = handoff.customerName
    ? [handoff.customerName, handoff.customerEmail || handoff.customerPhone].filter(Boolean).join(" · ")
    : null;
  const customerConflict = Boolean(
    handoff.needsDraftChoice
    && activeCustomer
    && (
      (handoff.customerId && handoff.customerId !== activeCustomer.id)
      || (!handoff.customerId && kodyCustomerIdentity && currentCustomerIdentity
        && kodyCustomerIdentity.toLowerCase() !== currentCustomerIdentity.toLowerCase())
    ),
  );
  const visibleLines = handoff.lineItems.slice(0, 3);
  const extraLineCount = Math.max(0, handoff.lineItems.length - visibleLines.length);

  return (
    <div
      data-testid="kody-draft-handoff"
      className="rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-4 shadow-[var(--qf-shadow-sm)]"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue" icon={<Sparkles size={12} />}>{t("quoteBuilder.handoff.prepared")}</Badge>
            <Badge tone="slate">{t("quoteBuilder.handoff.notSaved")}</Badge>
            <Badge tone="slate">{t("quoteBuilder.handoff.notSent")}</Badge>
            {handoff.useWorkspaceContext ? (
              <Badge tone="blue" icon={<Sparkles size={12} />}>
                {t("quoteBuilder.handoff.sources", { count: handoff.retrievedSourceCount })}
              </Badge>
            ) : null}
          </div>
          <h2 className="mt-3 text-base font-semibold text-[var(--qf-text)]">
            {t("quoteBuilder.handoff.reviewTitle")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--qf-text-soft)]">
            {handoff.useWorkspaceContext
              ? t("quoteBuilder.handoff.groundedDescription")
              : t("quoteBuilder.handoff.promptDescription")}
          </p>
          {handoff.pricingNeedsReview ? (
            <p className="mt-2 text-sm font-semibold text-[var(--qf-warning-text)]">
              {t("quoteBuilder.handoff.pricingReview")}
            </p>
          ) : null}
          {handoff.estimatedDurationHoursLow !== null
          && handoff.estimatedDurationHoursHigh !== null
          && handoff.estimatedDurationHoursHigh > handoff.estimatedDurationHoursLow ? (
            <p className="mt-2 text-sm font-semibold text-[var(--qf-info-text)]" data-testid="kody-duration-range-note">
              {t("quoteBuilder.handoff.durationRange", {
                low: new Intl.NumberFormat(locale).format(handoff.estimatedDurationHoursLow),
                high: new Intl.NumberFormat(locale).format(handoff.estimatedDurationHoursHigh),
              })}
            </p>
          ) : null}
          {customerConflict ? (
            <p className="mt-2 text-sm font-semibold text-[var(--qf-warning-text)]">
              {t("quoteBuilder.handoff.customerConflict", { current: currentCustomerIdentity, kody: kodyCustomerIdentity })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
          {handoff.needsDraftChoice ? (
            <>
              <Button size="sm" onClick={onMerge}>{t("quoteBuilder.handoff.mergeDraft")}</Button>
              <Button size="sm" variant="outline" onClick={onReplace}>{t("quoteBuilder.handoff.replaceDraft")}</Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>{t("quoteBuilder.handoff.keepCurrent")}</Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={onReview}>{t("quoteBuilder.handoff.reviewLines")}</Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>{t("quoteBuilder.dismiss")}</Button>
            </>
          )}
        </div>
      </div>

      {handoff.retrievedSourceLabels.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--qf-text-soft)]">
          <span className="font-semibold text-[var(--qf-text)]">{t("quoteBuilder.handoff.workspaceContext")}</span>
          {handoff.retrievedSourceLabels.slice(0, 4).map((label) => (
            <span key={label} className="rounded-full border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-2.5 py-1">
              {label}
            </span>
          ))}
          {handoff.retrievedSourceLabels.length > 4 ? (
            <span>{t("quoteBuilder.handoff.moreSources", { count: handoff.retrievedSourceLabels.length - 4 })}</span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.customer")}</p>
          <p className="mt-1 truncate font-semibold text-[var(--qf-text)]">{customerLabel}</p>
        </div>
        <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.trade")}</p>
          <p className="mt-1 font-semibold text-[var(--qf-text)]">{handoff.serviceType ? t(`domain.trade.${handoff.serviceType}`) : t("quoteBuilder.handoff.tradeNotLocked")}</p>
        </div>
        <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-3 py-2 sm:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.title")}</p>
          <p className="mt-1 truncate font-semibold text-[var(--qf-text)]">{handoff.title ?? t("quoteBuilder.handoff.titleFallback")}</p>
        </div>
      </div>

      {handoff.scopeText || visibleLines.length || handoff.estimatedTotalAmount !== null ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.42fr)]">
          <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.scopePreview")}</p>
            <p className="mt-1 line-clamp-3 text-sm leading-6 text-[var(--qf-text-soft)]">
              {handoff.scopeText ?? t("quoteBuilder.handoff.scopeFallback")}
            </p>
          </div>
          <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.suggestedWork")}</p>
            {visibleLines.length ? (
              <ul className="mt-1 space-y-1 text-sm text-[var(--qf-text-soft)]">
                {visibleLines.map((lineItem, index) => (
                  <li key={`${lineItem.description}-${index}`} className="flex items-start gap-2">
                    <span className="text-[var(--qf-text-muted)]">{index + 1}.</span>
                    <span className="min-w-0 flex-1">
                      {lineItem.description}
                      {lineItem.quantity ? <span className="text-[var(--qf-text-muted)]"> · {t("quoteBuilder.handoff.quantity", { count: lineItem.quantity })}</span> : null}
                    </span>
                    {lineItem.quantity !== null && lineItem.unitPrice !== null ? (
                      <span className="shrink-0 whitespace-nowrap font-semibold text-[var(--qf-text)]">
                        {t("quoteBuilder.handoff.lineAmount", { amount: money(lineItem.quantity * lineItem.unitPrice, locale) })}
                      </span>
                    ) : null}
                  </li>
                ))}
                {extraLineCount ? <li className="text-xs font-semibold text-[var(--qf-text-muted)]">{t("quoteBuilder.handoff.moreInPrompt", { count: extraLineCount })}</li> : null}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quoteBuilder.handoff.noLinePreview")}</p>
            )}
            {handoff.estimatedTotalAmount !== null ? (
              <p className="mt-2 text-xs font-semibold text-[var(--qf-text-soft)]">
                {t("quoteBuilder.handoff.estimate", { amount: money(handoff.estimatedTotalAmount, locale) })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
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

function DraftLineEditorRow({
  line,
  index,
  startExpanded,
  forceExpanded,
  onChange,
  onInsertBelow,
  onRemove,
  canViewInternalCosts,
}: {
  line: EditableQuoteLine;
  index: number;
  startExpanded?: boolean;
  forceExpanded?: boolean;
  onChange: (lineId: string, field: keyof EditableQuoteLine, value: string) => void;
  onInsertBelow: (lineId?: string) => void;
  onRemove: (lineId: string) => void;
  canViewInternalCosts: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formatLineMoney = (value: string | number) => money(value, i18n.resolvedLanguage ?? "en-US");
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const mobileTitleInputRef = useRef<HTMLInputElement | null>(null);
  const desktopTitleInputRef = useRef<HTMLInputElement | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(line.details.trim() || Number(line.unitCost) > 0 || line.sectionType === "ALTERNATE"),
  );
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
    if (startExpanded || forceExpanded) setExpanded(true);
  }, [forceExpanded, line.id, startExpanded]);

  useEffect(() => {
    if (!forceExpanded || !expanded) return;

    const frame = window.requestAnimationFrame(() => {
      const target = mobileTitleInputRef.current?.getClientRects().length
        ? mobileTitleInputRef.current
        : desktopTitleInputRef.current;
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [expanded, forceExpanded, line.id]);

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
              aria-label={t(expanded ? "quoteBuilder.line.collapseAria" : "quoteBuilder.line.expandAria", { number: index + 1 })}
            >
              <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteBuilder.line.item", { number: index + 1 })}</p>
                {line.sectionType === "ALTERNATE" ? (
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${sectionPillClassName}`}>
                    {sectionPillLabel}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{line.title.trim() || t("quoteComponents.savePreset.untitled")}</p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--qf-text-muted)]">
                <span>{t("quoteDesk.line.quantity")} {line.quantity}</span>
                <span>{t("quoteDesk.line.price")} {formatLineMoney(line.unitPrice)}</span>
                <span>{t("quoteComponents.math.total")} {formatLineMoney(lineTotal)}</span>
              </div>
              </div>
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)]">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </span>
            </button>
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => onRemove(line.id)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)] transition hover:border-[var(--qf-danger-border)] hover:bg-[var(--qf-danger-surface)] hover:text-[var(--qf-danger-text)]"
                aria-label={t("quoteBuilder.line.removeAria", { number: index + 1 })}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>

          <div className={expanded ? "border-t border-[var(--qf-border)] px-3 py-3" : "hidden"}>
            <div className="space-y-3">
              <Input
                ref={mobileTitleInputRef}
                label={t("quoteBuilder.line.workItem")}
                aria-label={t("quoteDesk.line.titleAria", { number: index + 1 })}
                placeholder={t("quoteBuilder.line.workPlaceholder")}
                value={line.title}
                onChange={(event) => onChange(line.id, "title", event.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input label={t("quoteDesk.line.quantity")} aria-label={t("quoteDesk.line.quantityAria", { number: index + 1 })} type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
                <Input label={t("quoteDesk.line.price")} aria-label={t("quoteDesk.line.priceAria", { number: index + 1 })} type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
              </div>
              <button
                type="button"
                onClick={() => setAdvancedOpen((current) => !current)}
                className="flex min-h-[44px] w-full items-center justify-between rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 text-sm font-medium text-[var(--qf-text-soft)] transition hover:bg-[var(--qf-interactive-hover)]"
                aria-expanded={advancedOpen}
              >
                {t("quoteBuilder.line.moreDetails")}
                {advancedOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              {advancedOpen ? (
                <div className="space-y-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3">
                  <Textarea
                    label={t("quoteDesk.line.description")}
                    aria-label={t("quoteDesk.line.descriptionAria", { number: index + 1 })}
                    rows={3}
                    placeholder={t("quoteBuilder.line.detailsPlaceholder")}
                    value={line.details}
                    onChange={(event) => onChange(line.id, "details", event.target.value)}
                  />
                  {canViewInternalCosts ? <Input
                    label={t("quoteComponents.math.internalCost")}
                    aria-label={t("quoteDesk.line.costAria", { number: index + 1 })}
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.unitCost}
                    onChange={(event) => onChange(line.id, "unitCost", event.target.value)}
                  /> : null}
                  <QuoteLineSectionField
                    sectionType={line.sectionType}
                    sectionLabel={line.sectionLabel}
                    onSectionTypeChange={updateSectionType}
                    onSectionLabelChange={(value) => onChange(line.id, "sectionLabel", value)}
                  />
                </div>
              ) : null}
              <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2.5 text-sm font-semibold text-[var(--qf-text)]">
                {t("quoteDesk.line.total", { amount: formatLineMoney(lineTotal) })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`hidden xl:grid xl:items-start xl:gap-2.5 ${QUOTE_BUILDER_LINE_GRID_COLUMNS} ${QUOTE_BUILDER_LINE_GRID_MIN_WIDTH}`}
      >
        <div className="flex h-[38px] items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-[var(--qf-text-muted)]">
          {index + 1}
        </div>
        <div className="space-y-1.5">
          <QuoteLineSectionField
            sectionType={line.sectionType}
            sectionLabel={line.sectionLabel}
            onSectionTypeChange={updateSectionType}
            onSectionLabelChange={(value) => onChange(line.id, "sectionLabel", value)}
            optionNameLabel={t("quoteComponents.line.alternateShort")}
            compact
          />
          <Input
            ref={desktopTitleInputRef}
            aria-label={t("quoteDesk.line.titleAria", { number: index + 1 })}
            className="min-h-[38px] rounded-lg"
            placeholder={t("quoteDesk.line.title")}
            value={line.title}
            onChange={(event) => onChange(line.id, "title", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Textarea
            aria-label={t("quoteDesk.line.descriptionAria", { number: index + 1 })}
            rows={2}
            className="min-h-[64px] rounded-lg"
            placeholder={t("quoteDesk.line.description")}
            value={line.details}
            onChange={(event) => onChange(line.id, "details", event.target.value)}
          />
        </div>
        <Input aria-label={t("quoteDesk.line.quantityAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.quantity} onChange={(event) => onChange(line.id, "quantity", event.target.value)} />
        {canViewInternalCosts ? (
          <Input aria-label={t("quoteDesk.line.costAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => onChange(line.id, "unitCost", event.target.value)} />
        ) : <span aria-hidden="true" />}
        <Input aria-label={t("quoteDesk.line.priceAria", { number: index + 1 })} className="min-h-[38px] rounded-lg text-right tabular-nums" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => onChange(line.id, "unitPrice", event.target.value)} />
        <div className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-semibold text-[var(--qf-text)] tabular-nums">
          {formatLineMoney(lineTotal)}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            icon={<Plus size={14} />}
            className="w-9 px-0"
            onClick={() => onInsertBelow(line.id)}
            aria-label={t("quoteBuilder.line.addBelow")}
            title={t("quoteBuilder.line.addBelow")}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            className="w-9 px-0 text-[var(--qf-text-muted)] hover:text-[var(--qf-danger-text)]"
            onClick={() => onRemove(line.id)}
            aria-label={t("quoteDesk.line.remove")}
            title={t("quoteDesk.line.remove")}
          />
        </div>
      </div>
    </div>
  );
}

export default QuoteBuilderView;




