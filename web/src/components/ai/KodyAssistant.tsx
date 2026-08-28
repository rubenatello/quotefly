import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  CalendarClock,
  CalendarPlus2,
  ChevronDown,
  Clock3,
  FilePlus2,
  ListChecks,
  PackagePlus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  Truck,
  UserPlus,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  type AiAssistantAction,
  type AiAssistantConversationTurn,
  type AiAssistantFeedbackRating,
  type AiAssistantResponse,
  type AiAssistantTool,
  type DataClassification,
} from "../../lib/api";
import {
  formatAiRenewalDate,
  formatAiUsageNotice,
  assistantToolConsumesAiBudget,
  aiUsageUpdateFromApiError,
  publishAiUsageUpdate,
} from "../../lib/ai-credits";
import { useTrack } from "../../lib/analytics";
import { formatBackendLabel, isDateResultKey } from "../../lib/display-format";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/utils";
import { Alert, Button, ConfirmModal, IconButton, LoadingState, Textarea } from "../ui";
import { workspacePageFromPath, type WorkspacePage } from "../crm/workspace-navigation";
import { KodySparkIcon } from "./KodySparkIcon";
import { visibleKodyResultEntries } from "./kody-result-display";
import {
  KODY_OPEN_EVENT,
  KODY_OUTCOME_EVENT,
  type KodyBookingReviewDetail,
  type KodyDispatchReviewDetail,
  type KodyOpenDetail,
  type KodyOutcomeDetail,
} from "./kody-events";
import { normalizeKodyAssistantResponse } from "./kody-response-normalization";
import { localizedApiError } from "../../lib/localized-api-error";

type KodyMessage = {
  id: string;
  role: "user" | "kody";
  text: string;
  pending?: boolean;
  response?: AiAssistantResponse["assistant"];
  usageNotice?: string;
};

type QuickPrompt = {
  tool: AiAssistantTool | "AUTO";
  label: string;
  description: string;
  prompt: string;
  icon: ReactNode;
  submitImmediately?: boolean;
};

function quickPrompts(t: TFunction): QuickPrompt[] {
  return [
  {
    tool: "PRIORITIZE_MY_DAY",
    label: t("kody.quick.prioritizeDay.label"),
    description: t("kody.quick.prioritizeDay.description"),
    prompt: t("kody.quick.prioritizeDay.prompt"),
    icon: <ListChecks size={15} />,
    submitImmediately: true,
  },
  {
    tool: "LIST_MY_ACTIVITIES",
    label: t("kody.quick.myTasks.label"),
    description: t("kody.quick.myTasks.description"),
    prompt: t("kody.quick.myTasks.prompt"),
    icon: <Clock3 size={15} />,
    submitImmediately: true,
  },
  {
    tool: "LIST_SCHEDULE",
    label: t("kody.quick.mySchedule.label"),
    description: t("kody.quick.mySchedule.description"),
    prompt: t("kody.quick.mySchedule.prompt"),
    icon: <CalendarClock size={15} />,
    submitImmediately: true,
  },
  {
    tool: "PREPARE_BOOKING",
    label: t("kody.quick.bookWork.label"),
    description: t("kody.quick.bookWork.description"),
    prompt: t("kody.quick.bookWork.prompt"),
    icon: <CalendarPlus2 size={15} />,
  },
  {
    tool: "PREPARE_DISPATCH",
    label: t("kody.quick.dispatchWork.label"),
    description: t("kody.quick.dispatchWork.description"),
    prompt: t("kody.quick.dispatchWork.prompt"),
    icon: <Truck size={15} />,
  },
  {
    tool: "DRAFT_CUSTOMER",
    label: t("kody.quick.addCustomer.label"),
    description: t("kody.quick.addCustomer.description"),
    prompt: t("kody.quick.addCustomer.prompt"),
    icon: <UserPlus size={15} />,
  },
  {
    tool: "DRAFT_QUOTE",
    label: t("kody.quick.draftQuote.label"),
    description: t("kody.quick.draftQuote.description"),
    prompt: t("kody.quick.draftQuote.prompt"),
    icon: <FilePlus2 size={15} />,
  },
  {
    tool: "PREPARE_QUOTE_SEND",
    label: t("kody.quick.sendQuote.label"),
    description: t("kody.quick.sendQuote.description"),
    prompt: t("kody.quick.sendQuote.prompt"),
    icon: <Send size={15} />,
  },
  {
    tool: "DRAFT_PRODUCT",
    label: t("kody.quick.addProduct.label"),
    description: t("kody.quick.addProduct.description"),
    prompt: t("kody.quick.addProduct.prompt"),
    icon: <PackagePlus size={15} />,
  },
  {
    tool: "SEARCH_CUSTOMERS",
    label: t("kody.quick.findCustomer.label"),
    description: t("kody.quick.findCustomer.description"),
    prompt: t("kody.quick.findCustomer.prompt"),
    icon: <Search size={15} />,
  },
  {
    tool: "SEARCH_PRODUCTS",
    label: t("kody.quick.findProduct.label"),
    description: t("kody.quick.findProduct.description"),
    prompt: t("kody.quick.findProduct.prompt"),
    icon: <PackagePlus size={15} />,
  },
  {
    tool: "SUMMARIZE_PIPELINE",
    label: t("kody.quick.pipeline.label"),
    description: t("kody.quick.pipeline.description"),
    prompt: t("kody.quick.pipeline.prompt"),
    icon: <BarChart3 size={15} />,
    submitImmediately: true,
  },
  {
    tool: "FOLLOW_UP_QUEUE",
    label: t("kody.quick.followUp.label"),
    description: t("kody.quick.followUp.description"),
    prompt: t("kody.quick.followUp.prompt"),
    icon: <Clock3 size={15} />,
    submitImmediately: true,
  },
  {
    tool: "RANK_PROFITABLE_JOBS",
    label: t("kody.quick.profitability.label"),
    description: t("kody.quick.profitability.description"),
    prompt: t("kody.quick.profitability.prompt"),
    icon: <TrendingUp size={15} />,
    submitImmediately: true,
  },
  ];
}

const QUICK_PROMPT_PRIORITY: Partial<Record<WorkspacePage, AiAssistantTool[]>> = {
  home: ["PRIORITIZE_MY_DAY", "DRAFT_QUOTE", "DRAFT_CUSTOMER"],
  customers: ["DRAFT_CUSTOMER", "SEARCH_CUSTOMERS", "DRAFT_QUOTE"],
  quotes: ["DRAFT_QUOTE", "PREPARE_QUOTE_SEND", "SUMMARIZE_PIPELINE"],
  "quote-desk": ["PREPARE_QUOTE_SEND", "DRAFT_QUOTE", "SUMMARIZE_PIPELINE"],
  products: ["SEARCH_PRODUCTS", "DRAFT_PRODUCT", "DRAFT_QUOTE"],
  build: ["DRAFT_QUOTE", "DRAFT_CUSTOMER", "DRAFT_PRODUCT"],
  "follow-up": ["PRIORITIZE_MY_DAY", "LIST_MY_ACTIVITIES", "PREPARE_ACTIVITY"],
  jobs: ["LIST_SCHEDULE", "PREPARE_BOOKING", "PREPARE_DISPATCH"],
  analytics: ["SUMMARIZE_PIPELINE", "RANK_PROFITABLE_JOBS", "PRIORITIZE_MY_DAY"],
};

function orderQuickPrompts(page: WorkspacePage, available: QuickPrompt[]) {
  const priority = QUICK_PROMPT_PRIORITY[page] ?? ["DRAFT_QUOTE", "DRAFT_CUSTOMER", "SEARCH_CUSTOMERS"];
  const priorityIndex = new Map<AiAssistantTool | "AUTO", number>(
    priority.map((tool, index) => [tool, index]),
  );
  return [...available].sort((left, right) => {
    const leftIndex = priorityIndex.get(left.tool) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = priorityIndex.get(right.tool) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function KodyQuickPromptButton({
  quickPrompt,
  selected,
  disabled,
  disabledReason,
  onSelect,
}: {
  quickPrompt: QuickPrompt;
  selected: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (quickPrompt: QuickPrompt) => void;
}) {
  return (
    <button
      type="button"
      title={disabledReason ?? quickPrompt.description}
      aria-description={disabledReason}
      onClick={() => onSelect(quickPrompt)}
      disabled={disabled}
      data-testid={`kody-quick-${quickPrompt.tool.toLowerCase()}`}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 rounded-xl border bg-[var(--qf-kody-assistant-surface)] px-2.5 py-2 text-left motion-safe:transition hover:border-[var(--qf-info-border)] hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-[var(--qf-focus)] ring-2 ring-[var(--qf-focus-ring)]" : "border-[var(--qf-border)]",
      )}
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]">
        {quickPrompt.icon}
      </span>
      <span className="min-w-0 whitespace-normal text-xs font-semibold leading-4 text-[var(--qf-text)] sm:text-sm">
        {quickPrompt.label}
      </span>
    </button>
  );
}

function assistantContextFromPage(page: WorkspacePage): "quotes" | "customers" | "analytics" | "products" | "dashboard" | "jobs" {
  if (page === "customers") return "customers";
  if (page === "products") return "products";
  if (page === "analytics" || page === "follow-up") return "analytics";
  if (page === "jobs") return "jobs";
  if (page === "quotes" || page === "build" || page === "quote-desk") return "quotes";
  return "dashboard";
}

function jobIdFromPath(pathname: string) {
  const match = pathname.match(/^\/app\/jobs\/([^/?#]+)$/);
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return null; }
}

function makeMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function recentConversation(messages: readonly KodyMessage[]): AiAssistantConversationTurn[] {
  const turns: AiAssistantConversationTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const responseMessage = messages[index + 1];
    if (!responseMessage?.response) continue;
    turns.push({
      message: message.text.slice(0, 500),
      resolvedTool: responseMessage.response.diagnostics.resolvedTool,
    });
  }
  return turns.slice(-4);
}

function elapsedSince(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1));
}

function kodyLoadingText(elapsedMs: number, tool: AiAssistantTool | "AUTO", t: TFunction) {
  if (elapsedMs < 900) return t("kody.loading.thinking");

  if (elapsedMs < 2_700) {
    if (tool === "SEARCH_CUSTOMERS") return t("kody.loading.customers");
    if (tool === "SEARCH_PRODUCTS") return t("kody.loading.products");
    if (tool === "SEARCH_JOBS" || tool === "GET_JOB_STATUS") return t("kody.loadingExtensions.jobs");
    if (tool === "LIST_INVOICES" || tool === "GET_INVOICE_STATUS") return t("kody.loadingExtensions.invoices");
    if (tool === "GET_QUICKBOOKS_SETUP_STATUS") return t("kody.loadingExtensions.quickBooks");
    if (tool === "NAVIGATE_WORKSPACE") return t("kody.loading.navigation");
    if (tool === "FOLLOW_UP_QUEUE") return t("kody.loading.followUps");
    if (tool === "LIST_SCHEDULE") return t("kody.loading.schedule");
    if (tool === "LIST_MY_ACTIVITIES") return t("kody.loading.activities");
    if (tool === "PRIORITIZE_MY_DAY") return t("kody.loading.prioritizeDay");
    if (tool === "CUSTOMERS_WITHOUT_QUOTES") return t("kody.loading.unquoted");
    if (tool === "PIPELINE_SCENARIO") return t("kody.loading.math");
    if (tool === "DRAFT_CUSTOMER") return t("kody.loading.customerDraft");
    if (tool === "DRAFT_PRODUCT") return t("kody.loading.productDraft");
    if (tool === "DRAFT_QUOTE") return t("kody.loading.quoteDraft");
    if (tool === "PREPARE_BOOKING") return t("kody.loading.bookingReview");
    if (tool === "PREPARE_DISPATCH") return t("kody.loading.dispatchReview");
    if (tool === "PREPARE_ACTIVITY") return t("kody.loading.activityDraft");
    if (tool === "PREPARE_QUOTE_SEND") return t("kody.loading.quoteSend");
    if (tool === "SUMMARIZE_PIPELINE") return t("kody.loading.pipeline");
    if (tool === "RANK_PROFITABLE_JOBS") return t("kody.loading.profitability");
    if (tool === "ASSISTANT_HELP") return t("kody.loading.help");
    if (tool === "OUT_OF_SCOPE") return t("kody.loading.scope");
    return t("kody.loading.gathering");
  }

  if (elapsedMs < 4_500) return t("kody.loading.preparing");
  if (elapsedMs < 8_000) return t("kody.loading.checking");
  return t("kody.loading.stillWorking");
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getIsoDateTime(value: unknown) {
  const stringValue = getString(value);
  return stringValue && Number.isFinite(new Date(stringValue).getTime()) ? stringValue : null;
}

function localizedToolLabel(tool: AiAssistantTool, t: TFunction) {
  const labels: Record<AiAssistantTool, string> = {
    NAVIGATE_WORKSPACE: t("kody.tools.navigate"), DRAFT_CUSTOMER: t("kody.tools.draftCustomer"),
    SEARCH_CUSTOMERS: t("kody.tools.searchCustomers"), CUSTOMERS_WITHOUT_QUOTES: t("kody.tools.customersWithoutQuotes"),
    DRAFT_PRODUCT: t("kody.tools.draftProduct"), SEARCH_PRODUCTS: t("kody.tools.searchProducts"),
    SEARCH_JOBS: t("kody.toolExtensions.searchJobs"), GET_JOB_STATUS: t("kody.toolExtensions.jobStatus"),
    LIST_INVOICES: t("kody.toolExtensions.listInvoices"), GET_INVOICE_STATUS: t("kody.toolExtensions.invoiceStatus"),
    GET_QUICKBOOKS_SETUP_STATUS: t("kody.toolExtensions.quickBooksStatus"),
    LIST_SCHEDULE: t("kody.tools.listSchedule"), PREPARE_BOOKING: t("kody.tools.prepareBooking"),
    PREPARE_DISPATCH: t("kody.tools.prepareDispatch"),
    LIST_MY_ACTIVITIES: t("kody.tools.listActivities"), PRIORITIZE_MY_DAY: t("kody.tools.prioritizeDay"),
    PREPARE_ACTIVITY: t("kody.tools.prepareActivity"),
    DRAFT_QUOTE: t("kody.tools.draftQuote"), PREPARE_QUOTE_SEND: t("kody.tools.prepareQuoteSend"),
    FOLLOW_UP_QUEUE: t("kody.tools.followUpQueue"), SUMMARIZE_PIPELINE: t("kody.tools.pipeline"),
    PIPELINE_SCENARIO: t("kody.tools.pipelineScenario"), RANK_PROFITABLE_JOBS: t("kody.tools.profitability"),
    ASSISTANT_HELP: t("kody.tools.help"), OUT_OF_SCOPE: t("kody.tools.outOfScope"),
  };
  return labels[tool];
}

function localizedActionLabel(action: AiAssistantAction, t: TFunction) {
  if (action.type === "OPEN_QUOTE_DRAFT" && action.label.trim()) {
    return action.label;
  }
  if (action.type === "OPEN_WORKSPACE_PAGE") {
    const invoiceNumber = getFiniteNumber(action.payload.invoiceNumber);
    if (invoiceNumber !== null) return t("kody.actions.openInvoice", { number: invoiceNumber });
    const jobNumber = getFiniteNumber(action.payload.jobNumber);
    if (jobNumber !== null) return t("kody.actions.openJob", { number: jobNumber });
  }
  const labels: Record<AiAssistantAction["type"], string> = {
    OPEN_CUSTOMER: t("kody.actions.openCustomer"), OPEN_CUSTOMER_DRAFT: t("kody.actions.reviewCustomer"),
    OPEN_PRODUCT_DRAFT: t("kody.actions.reviewProduct"), OPEN_QUOTE_DRAFT: t("kody.actions.reviewQuote"),
    OPEN_QUOTE_SEND: t("kody.actions.reviewSend"), OPEN_ACTIVITY_DRAFT: t("kody.actions.reviewActivity"),
    OPEN_SCHEDULE: t("kody.actions.openSchedule"), OPEN_BOOKING_REVIEW: t("kody.actions.reviewBooking"),
    OPEN_DISPATCH_REVIEW: t("kody.actions.reviewDispatch"),
    OPEN_ANALYTICS: t("kody.actions.openAnalytics"),
    OPEN_WORKSPACE_PAGE: t("kody.actions.openPage"), OPEN_QUICKBOOKS_SETUP: t("kody.actions.openQuickBooks"), REQUEST_ADMIN_ACCESS: t("kody.actions.requestAccess"),
  };
  return labels[action.type];
}

function localizedResultField(key: string, t: TFunction, isInvoiceResult = false) {
  const labels: Record<string, string> = {
    fullName: t("kody.resultFields.fullName"), name: t("kody.resultFields.name"), title: t("kody.resultFields.title"),
    customerName: t("kody.resultFields.customerName"), quoteTitle: t("kody.resultFields.quoteTitle"),
    quoteNumber: t("kody.resultFields.quoteNumber"), phone: t("kody.resultFields.phone"), email: t("kody.resultFields.email"),
    status: isInvoiceResult ? t("kody.resultFieldExtensions.invoiceStatus") : t("kody.resultFields.status"), serviceType: t("kody.resultFields.trade"), category: t("kody.resultFields.category"),
    unitType: t("kody.resultFields.unit"), defaultQuantity: t("kody.resultFields.quantity"),
    unitPrice: t("kody.resultFields.customerPrice"), unitCost: t("kody.resultFields.internalCost"),
    quoteAmount: t("kody.resultFields.quoteAmount"), amount: t("kody.resultFields.amount"), revenue: t("kody.resultFields.revenue"),
    cost: t("kody.resultFields.cost"), profit: t("kody.resultFields.profit"), margin: t("kody.resultFields.margin"),
    followUpType: t("kody.resultFields.followUpType"), dueSince: t("kody.resultFields.dueSince"),
    activityRank: t("kody.resultFields.activityRank"), taskType: t("kody.resultFields.taskType"),
    priority: t("kody.resultFields.priority"), dueBucket: t("kody.resultFields.dueBucket"),
    dueAtUtc: t("kody.resultFields.dueAt"),
    jobNumber: t("kody.resultFields.jobNumber"), jobTitle: t("kody.resultFields.jobTitle"),
    invoiceNumber: t("kody.resultFieldExtensions.invoiceNumber"), invoiceStatus: t("kody.resultFieldExtensions.invoiceStatus"),
    paymentStatus: t("kody.resultFieldExtensions.paymentStatus"), totalAmount: t("kody.resultFieldExtensions.totalAmount"),
    amountPaid: t("kody.resultFieldExtensions.amountPaid"), balanceDue: t("kody.resultFieldExtensions.balance"),
    balanceAmount: t("kody.resultFieldExtensions.balance"),
    startsAtUtc: t("kody.resultFields.startsAt"), endsAtUtc: t("kody.resultFields.endsAt"),
    assigneeName: t("kody.resultFields.assignee"),
    assignedTo: t("kody.resultFields.assignedTo"), description: t("kody.resultFields.description"), notes: t("kody.resultFields.notes"),
    createdAtUtc: t("kody.resultFields.created"), updatedAtUtc: t("kody.resultFields.updated"),
  };
  return labels[key] ?? t("kody.resultFields.detail");
}

function localizedKnownValue(value: string, t: TFunction) {
  const values: Record<string, string> = {
    DRAFT: t("domain.quoteStatus.DRAFT"), READY_FOR_REVIEW: t("domain.quoteStatus.READY_FOR_REVIEW"),
    SENT_TO_CUSTOMER: t("domain.quoteStatus.SENT_TO_CUSTOMER"), ACCEPTED: t("domain.quoteStatus.ACCEPTED"),
    REJECTED: t("domain.quoteStatus.REJECTED"), NEW: t("domain.customerStage.NEW"),
    CONTACTED: t("domain.customerStage.CONTACTED"), READY: t("domain.customerStage.READY"),
    SENT: t("domain.customerStage.SENT"), WON: t("domain.customerStage.WON"), LOST: t("domain.customerStage.LOST"),
    NEEDS_FOLLOW_UP: t("kody.values.needsFollowUp"), FOLLOWED_UP: t("kody.values.followedUp"),
    NEW_CUSTOMER: t("kody.values.newCustomer"), SENT_QUOTE: t("kody.values.sentQuote"),
    CUSTOMER_CHECK_IN: t("kody.values.customerCheckIn"), PREPARE_QUOTE: t("kody.values.prepareQuote"),
    FOLLOW_UP: t("kody.values.followUp"), SEND_QUOTE: t("kody.values.sendQuote"), CHECK_IN: t("kody.values.checkIn"),
    CUSTOM: t("kody.values.custom"), LOW: t("kody.values.low"), NORMAL: t("kody.values.normal"),
    HIGH: t("kody.values.high"), URGENT: t("kody.values.urgent"),
    ACTIVE: t("kody.values.active"), ARCHIVED: t("kody.values.archived"), DELETED: t("kody.values.deleted"),
    QUOTED: t("kody.values.quoted"), CLOSED: t("kody.values.closed"), POST_JOB: t("kody.values.postJob"),
    SCHEDULED: t("kody.values.scheduled"), DISPATCHED: t("kody.values.dispatched"),
    ARRIVED: t("kody.values.arrived"), IN_PROGRESS: t("kody.values.inProgress"),
    COMPLETED: t("kody.values.completed"), CANCELED: t("kody.values.canceled"),
    OVERDUE: t("kody.values.overdue"), TODAY: t("kody.values.today"), UPCOMING: t("kody.values.upcoming"),
    EMAIL: t("kody.values.email"), SMS: t("kody.values.text"), COPY: t("kody.values.copy"),
    CONSTRUCTION: t("domain.trade.CONSTRUCTION"), HVAC: t("domain.trade.HVAC"), PLUMBING: t("domain.trade.PLUMBING"),
    FLOORING: t("domain.trade.FLOORING"), ROOFING: t("domain.trade.ROOFING"), GARDENING: t("domain.trade.GARDENING"),
    SERVICE: t("domain.category.SERVICE"), LABOR: t("domain.category.LABOR"), MATERIAL: t("domain.category.MATERIAL"),
    FEE: t("domain.category.FEE"), FLAT: t("domain.unit.FLAT"), FLAT_RATE: t("domain.unit.FLAT"),
    SQ_FT: t("domain.unit.SQ_FT"), HOUR: t("domain.unit.HOUR"), EACH: t("domain.unit.EACH"),
  };
  // Unknown values may be tenant-entered titles or notes. Preserve them
  // verbatim; only known backend enums are localized above.
  return values[value] ?? value;
}

function formatKodyDate(value: string, locale: string, displayTimeZone?: string | null, includeTime = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = includeTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" };
  if (displayTimeZone) options.timeZone = displayTimeZone;
  try { return new Intl.DateTimeFormat(locale, options).format(date); }
  catch { delete options.timeZone; return new Intl.DateTimeFormat(locale, options).format(date); }
}

function formatResultValue(key: string, value: string | number | boolean | null, locale: string, t: TFunction, displayTimeZone?: string | null, isInvoiceResult = false) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? t("kody.values.yes") : t("kody.values.no");
  if (typeof value === "number") {
    if (/amount|revenue|cost|profit|price|total/i.test(key)) return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    if (/percent|rate/i.test(key)) return `${value}%`;
    return value.toLocaleString(locale);
  }
  if (isDateResultKey(key)) {
    const formattedDate = /(?:starts|ends|due)AtUtc$/i.test(key)
      ? formatKodyDate(value, locale, displayTimeZone, true)
      : formatKodyDate(value, locale, displayTimeZone);
    if (formattedDate) return formattedDate;
  }
  if (key === "paymentStatus") {
    const paymentStatuses: Record<string, string> = {
      PENDING: t("domain.invoicePaymentStatus.PENDING"), SUCCEEDED: t("domain.invoicePaymentStatus.SUCCEEDED"),
      FAILED: t("domain.invoicePaymentStatus.FAILED"), REFUNDED: t("domain.invoicePaymentStatus.REFUNDED"),
      PARTIALLY_REFUNDED: t("domain.invoicePaymentStatus.PARTIALLY_REFUNDED"), CANCELED: t("domain.invoicePaymentStatus.CANCELED"),
    };
    return paymentStatuses[value] ?? value;
  }
  if (key === "status" && isInvoiceResult) {
    const invoiceStatuses: Record<string, string> = {
      DRAFT: t("domain.invoiceStatus.DRAFT"), OPEN: t("domain.invoiceStatus.OPEN"),
      PAID: t("domain.invoiceStatus.PAID"), VOID: t("domain.invoiceStatus.VOID"),
      UNCOLLECTIBLE: t("domain.invoiceStatus.UNCOLLECTIBLE"),
    };
    return invoiceStatuses[value] ?? value;
  }
  return localizedKnownValue(value, t);
}

function resultTitle(result: Record<string, string | number | boolean | null>, fallback: string, t: TFunction) {
  const tenantTitle = getString(result.fullName) ?? getString(result.name) ?? getString(result.title)
    ?? getString(result.customerName) ?? getString(result.jobTitle) ?? getString(result.item);
  if (tenantTitle) return tenantTitle;
  const enumTitle = getString(result.serviceType) ?? getString(result.status);
  return enumTitle ? localizedKnownValue(enumTitle, t) : fallback;
}

function classificationMeta(classification: DataClassification, t: TFunction) {
  if (classification === "C4_RESTRICTED") return { label: t("kody.classification.restricted"), description: t("kody.classification.restrictedDescription") };
  if (classification === "C3_FINANCIAL_CONFIDENTIAL") return { label: t("kody.classification.financial"), description: t("kody.classification.financialDescription") };
  if (classification === "C2_CUSTOMER_CONFIDENTIAL") return { label: t("kody.classification.customer"), description: t("kody.classification.customerDescription") };
  if (classification === "C1_BUSINESS_INTERNAL") return { label: t("kody.classification.workspace"), description: t("kody.classification.workspaceDescription") };
  return { label: t("kody.classification.public"), description: t("kody.classification.publicDescription") };
}

function compactSourceList(citations: AiAssistantResponse["assistant"]["citations"], t: TFunction) {
  const sources = Array.from(new Set(citations.map((citation) => citation.sourceType))).filter(Boolean);
  if (!sources.length) return t("kody.safety.noSources");
  const knownSources: Record<string, string> = {
    WORKSPACE: t("kody.sources.workspace"), Workspace: t("kody.sources.workspace"), Customer: t("kody.sources.customers"), Customers: t("kody.sources.customers"),
    Quote: t("kody.sources.quotes"), Quotes: t("kody.sources.quotes"), Product: t("kody.sources.products"),
    Products: t("kody.sources.products"), Analytics: t("kody.sources.analytics"), Job: t("kody.sources.jobs"), Jobs: t("kody.sources.jobs"),
    ActivityTask: t("kody.sources.activities"), "ActivityTask + Customer + Quote": t("kody.sources.activities"),
    Invoice: t("kody.sourceExtensions.invoices"), Invoices: t("kody.sourceExtensions.invoices"),
  };
  return sources.slice(0, 3).map((source) => knownSources[source] ?? formatBackendLabel(source)).join(" + ");
}

function formatHiddenField(field: string, t: TFunction) {
  const normalized = field.toLowerCase();
  if (normalized.includes("tenant")) return t("kody.hidden.tenant");
  if (normalized.includes("deleted")) return t("kody.hidden.deleted");
  if (normalized.includes("archived")) return t("kody.hidden.archived");
  if (normalized.includes("internal cost")) return t("kody.hidden.costs");
  if (normalized.includes("margin")) return t("kody.hidden.margin");
  if (normalized.includes("password") || normalized.includes("token") || normalized.includes("secret")) return t("kody.hidden.secrets");
  return t("kody.hidden.protected");
}

function compactHiddenList(fieldsExcluded: string[], t: TFunction) {
  if (!fieldsExcluded.length) return t("kody.safety.noHidden");
  const visible = fieldsExcluded.slice(0, 3).map((field) => formatHiddenField(field, t));
  const remaining = fieldsExcluded.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? t("kody.safety.moreHidden", { count: remaining }) : ""}`;
}

function bookingReviewFromAction(action: AiAssistantAction): KodyBookingReviewDetail | null {
  if (action.type !== "OPEN_BOOKING_REVIEW") return null;
  const mode = action.payload.mode === "CREATE" || action.payload.mode === "RESCHEDULE" ? action.payload.mode : null;
  const jobId = getString(action.payload.jobId);
  const jobNumber = getFiniteNumber(action.payload.jobNumber);
  const jobTitle = getString(action.payload.jobTitle);
  const customerId = getString(action.payload.customerId);
  const customerName = getString(action.payload.customerName);
  const assignedTenantUserId = getString(action.payload.assignedTenantUserId);
  const assigneeName = getString(action.payload.assigneeName);
  const startsAtUtc = getIsoDateTime(action.payload.startsAtUtc);
  const endsAtUtc = getIsoDateTime(action.payload.endsAtUtc);
  const timeZone = getString(action.payload.timeZone);
  if (!mode || !jobId || jobNumber === null || !Number.isInteger(jobNumber) || !jobTitle || !customerId || !customerName
    || !assignedTenantUserId || !assigneeName || !startsAtUtc || !endsAtUtc || !timeZone
    || new Date(startsAtUtc) >= new Date(endsAtUtc)) return null;
  if (mode === "CREATE") {
    return { mode, jobId, jobNumber, jobTitle, customerId, customerName, assignedTenantUserId, assigneeName, startsAtUtc, endsAtUtc, timeZone };
  }
  const appointmentId = getString(action.payload.appointmentId);
  const appointmentVersion = getFiniteNumber(action.payload.appointmentVersion);
  if (!appointmentId || appointmentVersion === null || !Number.isInteger(appointmentVersion) || action.payload.expectedStatus !== "SCHEDULED") return null;
  return {
    mode,
    jobId,
    jobNumber,
    jobTitle,
    customerId,
    customerName,
    assignedTenantUserId,
    assigneeName,
    startsAtUtc,
    endsAtUtc,
    timeZone,
    appointmentId,
    appointmentVersion,
    expectedStatus: "SCHEDULED",
  };
}

function dispatchReviewFromAction(action: AiAssistantAction): KodyDispatchReviewDetail | null {
  if (action.type !== "OPEN_DISPATCH_REVIEW") return null;
  const jobId = getString(action.payload.jobId);
  const jobNumber = getFiniteNumber(action.payload.jobNumber);
  const jobTitle = getString(action.payload.jobTitle);
  const customerId = getString(action.payload.customerId);
  const customerName = getString(action.payload.customerName);
  const appointmentId = getString(action.payload.appointmentId);
  const appointmentVersion = getFiniteNumber(action.payload.appointmentVersion);
  const startsAtUtc = getIsoDateTime(action.payload.startsAtUtc);
  const endsAtUtc = getIsoDateTime(action.payload.endsAtUtc);
  const timeZone = getString(action.payload.timeZone);
  const assignedTenantUserId = getString(action.payload.assignedTenantUserId);
  const assigneeName = getString(action.payload.assigneeName);
  if (!jobId || jobNumber === null || !Number.isInteger(jobNumber) || !jobTitle || !customerId || !customerName
    || !appointmentId || appointmentVersion === null || !Number.isInteger(appointmentVersion)
    || action.payload.expectedStatus !== "SCHEDULED" || !startsAtUtc || !endsAtUtc || !timeZone
    || !assignedTenantUserId || !assigneeName || new Date(startsAtUtc) >= new Date(endsAtUtc)) return null;
  return {
    jobId,
    jobNumber,
    jobTitle,
    customerId,
    customerName,
    appointmentId,
    appointmentVersion,
    expectedStatus: "SCHEDULED",
    startsAtUtc,
    endsAtUtc,
    timeZone,
    assignedTenantUserId,
    assigneeName,
  };
}

function formatVisibleAnswer(answer: string) {
  return answer
    .replace(/\s*\[(?:[A-Z]\d+(?:\s*,\s*)?)+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function actionConfirmationCopy(
  action: AiAssistantAction,
  t: TFunction,
  locale: string,
  displayTimeZone?: string | null,
) {
  if (action.type === "OPEN_CUSTOMER_DRAFT") {
    const fullName = getString(action.payload.fullName) ?? t("kody.confirm.thisCustomer");
    const phone = getString(action.payload.phone);
    const email = getString(action.payload.email);
    const contactSummary = [phone, email].filter(Boolean).join(" · ");
    return {
      title: t("kody.confirm.customerTitle", { name: fullName }),
      description: t("kody.confirm.customerDescription", { contact: contactSummary ? `${contactSummary}. ` : "" }),
      confirmLabel: t("kody.confirm.customerButton"),
    };
  }
  if (action.type === "OPEN_PRODUCT_DRAFT") {
    return {
      title: t("kody.confirm.productTitle"),
      description: t("kody.confirm.productDescription"),
      confirmLabel: t("kody.confirm.productButton"),
    };
  }
  if (action.type === "OPEN_QUOTE_DRAFT") {
    const customerName = getString(action.payload.customerName);
    const phone = getString(action.payload.customerPhone);
    const email = getString(action.payload.customerEmail);
    const contactSummary = [phone, email].filter(Boolean).join(" · ");
    return {
      title: customerName ? t("kody.confirm.quoteCustomerTitle", { name: customerName }) : t("kody.confirm.quoteTitle"),
      description: t("kody.confirm.quoteDescription", { contact: contactSummary ? `${contactSummary}. ` : "" }),
      confirmLabel: t("kody.confirm.quoteButton"),
    };
  }
  if (action.type === "OPEN_QUOTE_SEND") {
    const quoteTitle = getString(action.payload.quoteTitle) ?? t("kody.confirm.thisQuote");
    const customerName = getString(action.payload.customerName) ?? t("kody.confirm.theCustomer");
    const destination = getString(action.payload.destination);
    const channel = getString(action.payload.channel);
    const channelLabel = channel === "sms" ? t("kody.values.text") : channel === "copy" ? t("kody.values.copy") : t("kody.values.email");
    return {
      title: t("kody.confirm.sendTitle", { channel: channelLabel, customer: customerName }),
      description: t("kody.confirm.sendDescription", { quote: quoteTitle, destination: destination ? ` · ${destination}` : "" }),
      confirmLabel: t("kody.confirm.sendButton"),
    };
  }
  if (action.type === "OPEN_ACTIVITY_DRAFT") {
    const title = getString(action.payload.title) ?? t("kody.confirm.thisTask");
    const customerName = getString(action.payload.customerName) ?? t("kody.confirm.theCustomer");
    return {
      title: t("kody.confirm.activityTitle", { task: title }),
      description: t("kody.confirm.activityDescription", { customer: customerName }),
      confirmLabel: t("kody.confirm.activityButton"),
    };
  }
  if (action.type === "OPEN_BOOKING_REVIEW") {
    const customerName = getString(action.payload.customerName) ?? t("kody.confirm.theCustomer");
    const startsAtUtc = getIsoDateTime(action.payload.startsAtUtc);
    const timeZone = getString(action.payload.timeZone) ?? displayTimeZone;
    const startsAt = startsAtUtc ? formatKodyDate(startsAtUtc, locale, timeZone, true) : t("kody.confirm.proposedTime");
    return {
      title: t("kody.confirm.bookingTitle", { customer: customerName }),
      description: t("kody.confirm.bookingDescription", { start: startsAt }),
      confirmLabel: t("kody.confirm.bookingButton"),
    };
  }
  if (action.type === "OPEN_DISPATCH_REVIEW") {
    const customerName = getString(action.payload.customerName) ?? t("kody.confirm.theCustomer");
    const startsAtUtc = getIsoDateTime(action.payload.startsAtUtc);
    const timeZone = getString(action.payload.timeZone) ?? displayTimeZone;
    const startsAt = startsAtUtc ? formatKodyDate(startsAtUtc, locale, timeZone, true) : t("kody.confirm.proposedTime");
    return {
      title: t("kody.confirm.dispatchTitle", { customer: customerName }),
      description: t("kody.confirm.dispatchDescription", { start: startsAt }),
      confirmLabel: t("kody.confirm.dispatchButton"),
    };
  }
  if (action.type === "REQUEST_ADMIN_ACCESS") {
    return {
      title: t("kody.confirm.accessTitle"),
      description: t("kody.confirm.accessDescription"),
      confirmLabel: t("kody.confirm.accessButton"),
    };
  }
  return {
    title: t("kody.confirm.defaultTitle"),
    description: t("kody.confirm.defaultDescription"),
    confirmLabel: t("kody.confirm.continue"),
  };
}

function KodyResultCard({
  result,
  index,
  displayTimeZone,
}: {
  result: Record<string, string | number | boolean | null>;
  index: number;
  displayTimeZone?: string | null;
}) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const isScheduleResult = "appointmentId" in result || ("jobNumber" in result && "startsAtUtc" in result);
  const isInvoiceResult = "invoiceId" in result || "invoiceNumber" in result;
  const protectedScheduleFields = /(?:address|instruction|phone|email|contact|cost|margin)/i;
  const entries = visibleKodyResultEntries(result)
    .filter(([key]) => !isScheduleResult || !protectedScheduleFields.test(key));
  if (isScheduleResult) {
    const timeZone = getString(result.timeZone) ?? displayTimeZone ?? "UTC";
    const startsAtUtc = getString(result.startsAtUtc);
    const endsAtUtc = getString(result.endsAtUtc);
    const start = startsAtUtc ? formatKodyDate(startsAtUtc, locale, timeZone, true) : null;
    const end = endsAtUtc ? formatKodyDate(endsAtUtc, locale, timeZone, true) : null;
    const customerName = getString(result.customerName) ?? t("kody.confirm.theCustomer");
    const jobTitle = getString(result.jobTitle);
    const jobNumber = getFiniteNumber(result.jobNumber);
    const assigneeName = getString(result.assigneeName);
    const status = getString(result.appointmentStatus) ?? getString(result.status);
    const scheduleOpening = result.scheduleOpening === true;
    return (
      <div data-testid="kody-schedule-card" className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] p-3 transition-colors hover:border-[var(--qf-info-border)]">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--qf-info-surface)] text-[11px] font-bold text-[var(--qf-info-text)]">
            {index + 1}
          </span>
          <p className="min-w-0 text-sm font-semibold text-[var(--qf-text)]">{customerName}</p>
        </div>
        <dl className="mt-2 grid gap-1.5 text-xs text-[var(--qf-text-soft)]">
          {scheduleOpening ? (
            <div className="grid gap-0.5 sm:flex sm:items-start sm:justify-between sm:gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{t("kody.scheduleCard.availability")}</dt>
              <dd className="min-w-0 break-words text-left font-medium text-[var(--qf-success-text)] sm:text-right">{t("kody.scheduleCard.opening")}</dd>
            </div>
          ) : null}
          {start && end ? (
            <div className="grid gap-0.5 sm:flex sm:items-start sm:justify-between sm:gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{t("kody.scheduleCard.window", { timeZone })}</dt>
              <dd className="min-w-0 break-words text-left font-medium text-[var(--qf-text)] sm:text-right">{t("kody.scheduleCard.windowValue", { start, end })}</dd>
            </div>
          ) : null}
          {jobNumber !== null || jobTitle ? (
            <div className="grid gap-0.5 sm:flex sm:items-start sm:justify-between sm:gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{t("kody.resultFields.jobTitle")}</dt>
              <dd className="min-w-0 break-words text-left font-medium text-[var(--qf-text)] sm:text-right">{t("kody.scheduleCard.job", { number: jobNumber ?? "—", title: jobTitle ?? "—" })}</dd>
            </div>
          ) : null}
          {assigneeName ? (
            <div className="grid gap-0.5 sm:flex sm:items-start sm:justify-between sm:gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{t("kody.resultFields.assignee")}</dt>
              <dd className="min-w-0 break-words text-left font-medium text-[var(--qf-text)] sm:text-right">{assigneeName}</dd>
            </div>
          ) : null}
          {status ? (
            <div className="grid gap-0.5 sm:flex sm:items-start sm:justify-between sm:gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{t("kody.resultFields.status")}</dt>
              <dd className="min-w-0 break-words text-left font-medium text-[var(--qf-text)] sm:text-right">{localizedKnownValue(status, t)}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] p-3 transition-colors hover:border-[var(--qf-info-border)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--qf-info-surface)] text-[11px] font-bold text-[var(--qf-info-text)]">
          {index + 1}
        </span>
        <p className="min-w-0 text-sm font-semibold text-[var(--qf-text)]">{resultTitle(result, t("kody.results.item", { number: index + 1 }), t)}</p>
      </div>
      {entries.length ? (
        <dl className="mt-2 grid gap-1.5 text-xs text-[var(--qf-text-soft)]">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{localizedResultField(key, t, isInvoiceResult)}</dt>
              <dd className="min-w-0 text-right font-medium text-[var(--qf-text)]">{formatResultValue(key, value, locale, t, displayTimeZone, isInvoiceResult)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function KodyResponse({
  response,
  usageNotice,
  onAction,
  displayTimeZone,
}: {
  response: AiAssistantResponse["assistant"];
  usageNotice?: string;
  onAction: (action: AiAssistantAction, auditEventId: string) => void;
  displayTimeZone?: string | null;
}) {
  const { t } = useTranslation();
  const track = useTrack();
  const meta = classificationMeta(response.maxClassification, t);
  const visibleAnswer = formatVisibleAnswer(response.answer);
  const [feedback, setFeedback] = useState<AiAssistantFeedbackRating | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [showFeedbackNote, setShowFeedbackNote] = useState(false);
  const [lastFeedbackSave, setLastFeedbackSave] = useState<"rating" | "note" | null>(null);
  const [visibleActionCount, setVisibleActionCount] = useState(3);
  const [visibleResultCount, setVisibleResultCount] = useState(4);
  const [resultsOpen, setResultsOpen] = useState(response.diagnostics.resolvedTool === "PREPARE_BOOKING");
  const isScheduleResponse = response.diagnostics.resolvedTool === "LIST_SCHEDULE"
    || response.diagnostics.resolvedTool === "PREPARE_BOOKING"
    || response.diagnostics.resolvedTool === "PREPARE_DISPATCH"
    || response.results.some((result) => "appointmentId" in result || ("jobNumber" in result && "startsAtUtc" in result));
  const shownResultCount = Math.min(response.results.length, visibleResultCount);
  const shownActionCount = Math.min(response.actions.length, visibleActionCount);
  const resultsTruncated = response.diagnostics.filters.resultsTruncated === true;

  async function submitFeedback(rating: AiAssistantFeedbackRating, nextNote?: string | null) {
    if (feedbackStatus === "saving" || response.auditEventId === "audit-unavailable") return;
    const previousFeedback = feedback;
    setFeedback(rating);
    if (rating === "DOWN") setShowFeedbackNote(true);
    setFeedbackStatus("saving");
    try {
      const result = await api.ai.submitAssistantFeedback(response.auditEventId, {
        rating,
        ...(nextNote !== undefined ? { note: nextNote } : {}),
      });
      setFeedback(result.feedback.rating);
      if (nextNote !== undefined) setFeedbackNote(result.feedback.note ?? "");
      setLastFeedbackSave(nextNote === undefined ? "rating" : "note");
      setFeedbackStatus("saved");
      track("kody_feedback", {
        rating,
        tool: response.diagnostics.resolvedTool,
        answerMode: response.diagnostics.answerMode,
        hasNote: Boolean(nextNote),
        noteLength: nextNote?.length ?? 0,
      });
    } catch {
      setFeedback(previousFeedback);
      setFeedbackStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="contents">
        {response.conversation.mode === "SHIFTED" && response.conversation.acknowledgement ? (
          <p
            className="mb-3 rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-3 py-2 text-sm leading-5 text-[var(--qf-text-soft)]"
            data-testid="kody-context-shift"
          >
            {response.conversation.acknowledgement}
          </p>
        ) : null}
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--qf-kody-eyebrow)]">
          {localizedToolLabel(response.diagnostics.resolvedTool, t)}
        </p>
        <p
          className="whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text)]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {visibleAnswer || t("kody.response.emptyAnswer")}
        </p>

        {response.actions.length ? (
          <div id={`kody-actions-${response.auditEventId}`} className="mt-3 flex flex-wrap gap-2">
            {response.actions.slice(0, shownActionCount).map((action, index) => (
              <Button
                key={`${action.type}-${index}`}
                type="button"
                size="sm"
                variant={action.type === "REQUEST_ADMIN_ACCESS" || index > 0 ? "outline" : "kody"}
                onClick={() => onAction(action, response.auditEventId)}
                className="w-full sm:w-auto"
              >
                {localizedActionLabel(action, t)}
              </Button>
            ))}
            {response.actions.length > shownActionCount ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setVisibleActionCount((count) => Math.min(count + 3, response.actions.length))}
                className="w-full sm:w-auto"
                aria-controls={`kody-actions-${response.auditEventId}`}
              >
                {t("kody.actionDisclosure.showMore", { count: response.actions.length - shownActionCount })}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="order-5 flex min-h-11 flex-wrap items-center gap-2 border-t border-[var(--qf-border)] pt-3">
          <span className="mr-1 text-xs font-medium text-[var(--qf-text-muted)]">{t("kody.feedback.helpful")}</span>
          <button
            type="button"
            onClick={() => void submitFeedback("UP")}
            disabled={feedbackStatus === "saving" || response.auditEventId === "audit-unavailable"}
            aria-label={t("kody.feedback.good")}
            aria-pressed={feedback === "UP"}
            data-testid="kody-feedback-up"
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded-xl border motion-safe:transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-50",
              feedback === "UP"
                ? "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"
                : "border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] text-[var(--qf-text-muted)] hover:border-[var(--qf-success-border)] hover:bg-[var(--qf-success-surface)] hover:text-[var(--qf-success-text)]",
            )}
          >
            <ThumbsUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void submitFeedback("DOWN")}
            disabled={feedbackStatus === "saving" || response.auditEventId === "audit-unavailable"}
            aria-label={t("kody.feedback.poor")}
            aria-pressed={feedback === "DOWN"}
            data-testid="kody-feedback-down"
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded-xl border motion-safe:transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-50",
              feedback === "DOWN"
                ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]"
                : "border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] text-[var(--qf-text-muted)] hover:border-[var(--qf-warning-border)] hover:bg-[var(--qf-warning-surface)] hover:text-[var(--qf-warning-text)]",
            )}
          >
            <ThumbsDown size={16} aria-hidden="true" />
          </button>
          <span
            className={cn(
              "min-w-[9rem] text-xs",
              feedbackStatus === "error" ? "text-[var(--qf-danger-text)]" : "text-[var(--qf-text-muted)]",
            )}
            role="status"
            aria-live="polite"
          >
            {feedbackStatus === "saving"
              ? t("kody.feedback.saving")
              : feedbackStatus === "saved"
                ? lastFeedbackSave === "note"
                  ? t("kody.feedback.noteSaved")
                  : t("kody.feedback.thanks")
                : feedbackStatus === "error"
                  ? t("kody.feedback.error")
                  : ""}
          </span>
          {feedback && !showFeedbackNote ? (
            <button
              type="button"
              onClick={() => setShowFeedbackNote(true)}
              className="ml-auto min-h-11 rounded-lg px-2 text-xs font-semibold text-[var(--qf-info-text)] hover:bg-[var(--qf-info-surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            >
              {t("kody.feedback.addNote")}
            </button>
          ) : null}
        </div>
        {feedback && showFeedbackNote ? (
          <div
            className="order-6 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] p-3"
            data-testid="kody-feedback-note-panel"
          >
            <Textarea
              data-testid="kody-feedback-note"
              label={feedback === "DOWN" ? t("kody.feedback.downLabel") : t("kody.feedback.upLabel")}
              value={feedbackNote}
              onChange={(event) => setFeedbackNote(event.target.value)}
              maxLength={500}
              rows={2}
              className="min-h-[76px] resize-none"
              placeholder={t("kody.feedback.placeholder")}
              disabled={feedbackStatus === "saving"}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] leading-4 text-[var(--qf-text-muted)]">
                {t("kody.feedback.privacy", { count: feedbackNote.length })}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowFeedbackNote(false)}>
                  {t("common.close")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={feedbackStatus === "saving"}
                  onClick={() => void submitFeedback(feedback, feedbackNote.trim() || null)}
                >
                  {t("kody.feedback.saveNote")}
                </Button>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[var(--qf-text-muted)]">
              {t("kody.feedback.usage")}
            </p>
          </div>
        ) : null}
      </div>

      {response.results.length ? (
        <details
          open={resultsOpen}
          onToggle={(event) => setResultsOpen(event.currentTarget.open)}
          className="group order-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] px-3 py-2"
          data-testid="kody-results"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-semibold text-[var(--qf-text)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
            <span>{t("kody.results.view", { count: response.results.length })}</span>
            <ChevronDown
              size={16}
              className="text-[var(--qf-text-muted)] motion-safe:transition-transform motion-safe:group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div id={`kody-results-${response.auditEventId}`} className="mt-2 grid gap-2 border-t border-[var(--qf-border)] pt-3">
            {response.results.slice(0, shownResultCount).map((result, index) => (
              <KodyResultCard
                key={`${response.auditEventId}-${index}`}
                result={result}
                index={index}
                displayTimeZone={displayTimeZone}
              />
            ))}
            {response.results.length > shownResultCount ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setVisibleResultCount((count) => Math.min(count + 4, response.results.length))}
                className="w-full"
                aria-controls={`kody-results-${response.auditEventId}`}
                data-testid="kody-results-show-more"
              >
                {t("kody.results.showMore", { count: response.results.length - shownResultCount })}
              </Button>
            ) : null}
            <p className="text-xs font-medium text-[var(--qf-text-muted)]" data-testid="kody-results-count" aria-live="polite">
              {resultsTruncated
                ? t("kody.results.showingTruncated", { shown: shownResultCount })
                : t("kody.results.showing", { shown: shownResultCount, total: response.results.length })}
              {isScheduleResponse ? ` ${t("kody.results.scheduleScope")}` : ""}
            </p>
          </div>
        </details>
      ) : null}

      <details
        className="group order-4 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] px-3 py-2 text-xs text-[var(--qf-text-soft)]"
        data-testid="kody-data-guardrails"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-[var(--qf-text-soft)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
          <span className="inline-flex min-w-0 items-center gap-2">
            <ShieldCheck size={14} className="shrink-0 text-[var(--qf-info-text)]" />
            <span className="font-semibold text-[var(--qf-text)]">{t("kody.safety.title")}</span>
          </span>
          <span className="text-[11px] text-[var(--qf-text-muted)] group-open:hidden">{t("kody.safety.workspaceOnly")}</span>
        </summary>
        <div className="mt-3 space-y-2 border-t border-[var(--qf-border)] pt-3">
          <p className="font-semibold text-[var(--qf-text)]">{meta.label}</p>
          <p>{meta.description}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="font-semibold text-[var(--qf-text-muted)]">{t("kody.safety.sources")}</p>
              <p className="mt-0.5 text-[var(--qf-text)]">{compactSourceList(response.citations, t)}</p>
            </div>
            <div>
              <p className="font-semibold text-[var(--qf-text-muted)]">{t("kody.safety.hidden")}</p>
              <p className="mt-0.5 text-[var(--qf-text)]">{compactHiddenList(response.fieldsExcluded, t)}</p>
            </div>
          </div>
          {usageNotice ? <p>{usageNotice}</p> : null}
        </div>
        <p className="sr-only">{t("kody.safety.policyClass", { classification: response.maxClassification })}</p>
      </details>
    </div>
  );
}

export function KodyAssistant({
  currentPage,
  canViewInternalCosts = false,
  aiPaidActionsUnavailable = false,
  aiUsageReconciliationPending = false,
  aiUsageAccountingUnavailable = false,
  aiUsageRenewsAtUtc,
  displayTimeZone,
}: {
  currentPage?: WorkspacePage;
  canViewInternalCosts?: boolean;
  aiPaidActionsUnavailable?: boolean;
  aiUsageReconciliationPending?: boolean;
  aiUsageAccountingUnavailable?: boolean;
  aiUsageRenewsAtUtc?: string | null;
  displayTimeZone?: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const track = useTrack();
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedTool, setSelectedTool] = useState<AiAssistantTool | "AUTO">("AUTO");
  const [contextOverride, setContextOverride] = useState<KodyOpenDetail["context"] | null>(null);
  const [messages, setMessages] = useState<KodyMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [loadingTool, setLoadingTool] = useState<AiAssistantTool | "AUTO">("AUTO");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AiAssistantAction | null>(null);
  const [isModalViewport, setIsModalViewport] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  const launcherRef = useRef<HTMLButtonElement>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const quickPromptsRef = useRef<HTMLDetailsElement>(null);
  const pendingMessageIdRef = useRef<string | null>(null);
  const submitInFlightRef = useRef(false);
  const activeRequestRef = useRef<{
    id: string;
    controller: AbortController;
    prompt: string;
    matchFingerprint: string;
    requestFingerprint: string;
    idempotencyKey: string;
    conversation: AiAssistantConversationTurn[];
    userMessageId: string;
  } | null>(null);
  const retryIdentityRef = useRef<{
    matchFingerprint: string;
    requestFingerprint: string;
    idempotencyKey: string;
    conversation: AiAssistantConversationTurn[];
    userMessageId: string;
    responseMessageId: string | null;
  } | null>(null);
  const workspacePage = currentPage ?? workspacePageFromPath(location.pathname);
  const currentContextPage = assistantContextFromPage(workspacePage);
  const aiUsageRenewalLabel = formatAiRenewalDate(aiUsageRenewsAtUtc, locale);
  const aiUsageUnavailableMessage = aiUsageReconciliationPending
    ? t("billing.aiUsage.reconciliationDescription")
    : aiUsageAccountingUnavailable
      ? t("kody.usage.accountingUnavailable")
    : aiUsageRenewalLabel
      ? t("kody.usage.paidPausedUntil", { date: aiUsageRenewalLabel })
      : t("kody.usage.paidPaused");
  const hasContextualKodyLauncher = workspacePage === "home" || workspacePage === "build";
  const hasMobileActionDock = workspacePage === "build" || workspacePage === "quote-desk" || workspacePage === "branding";
  const allQuickPrompts = useMemo(() => quickPrompts(t), [t]);
  const availableQuickPrompts = canViewInternalCosts
    ? allQuickPrompts
    : allQuickPrompts.filter((quickPrompt) => quickPrompt.tool !== "RANK_PROFITABLE_JOBS");
  const orderedQuickPrompts = orderQuickPrompts(workspacePage, availableQuickPrompts);
  const primaryQuickPrompts = orderedQuickPrompts.slice(0, 3);
  const additionalQuickPrompts = orderedQuickPrompts.slice(3);

  useEffect(() => {
    if (aiPaidActionsUnavailable && assistantToolConsumesAiBudget(selectedTool)) setSelectedTool("AUTO");
  }, [aiPaidActionsUnavailable, selectedTool]);

  const starterText = useMemo(() => {
    if (messages.length) return t("kody.starter.followUp");
    return t("kody.starter.initial");
  }, [messages.length, t]);
  const closeKody = useCallback((source: "button" | "keyboard") => {
    setOpen(false);
    track("kody_close", { source, page: currentContextPage });
    window.setTimeout(() => {
      const origin = originFocusRef.current;
      if (origin?.isConnected) origin.focus();
      else launcherRef.current?.focus();
      originFocusRef.current = null;
    }, 0);
  }, [currentContextPage, track]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const updateViewportMode = () => setIsModalViewport(mediaQuery.matches);
    updateViewportMode();
    mediaQuery.addEventListener("change", updateViewportMode);
    return () => mediaQuery.removeEventListener("change", updateViewportMode);
  }, []);

  useEffect(() => {
    const handleOpenKody = (event: Event) => {
      const detail = (event as CustomEvent<KodyOpenDetail>).detail;
      if (!detail || typeof detail.prompt !== "string") return;
      originFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      setError(null);
      setPrompt(detail.prompt);
      // Preserve the launcher's requested workflow for its untouched seed.
      // Editing the seed below releases it back to automatic routing.
      setSelectedTool(detail.tool ?? "AUTO");
      setContextOverride(detail.context ?? null);
      window.setTimeout(() => inputRef.current?.focus(), 0);
      track("kody_context_received", {
        tool: detail.tool ?? "AUTO",
        currentPage: detail.context?.currentPage ?? currentContextPage,
      });
    };

    window.addEventListener(KODY_OPEN_EVENT, handleOpenKody);
    return () => window.removeEventListener(KODY_OPEN_EVENT, handleOpenKody);
  }, [currentContextPage, track]);

  useEffect(() => {
    const handleKodyOutcome = (event: Event) => {
      const detail = (event as CustomEvent<KodyOutcomeDetail>).detail;
      if (!detail) return;
      let text: string;
      if (detail.type === "CUSTOMER_CREATED") {
        text = t("kody.outcomes.customerCreated", { customer: detail.customerName });
      } else if (detail.type === "QUOTE_CREATED") {
        text = detail.customerName
          ? t("kody.outcomes.quoteCreatedFor", { quote: detail.quoteTitle, customer: detail.customerName })
          : t("kody.outcomes.quoteCreated", { quote: detail.quoteTitle });
      } else if (detail.type === "QUOTE_MARKED_SENT") {
        text = t("kody.outcomes.quoteSent", { quote: detail.quoteTitle, customer: detail.customerName });
      } else if (detail.type === "BOOKING_CREATED") {
        text = t("kody.outcomes.bookingCreated", {
          job: detail.jobNumber,
          customer: detail.customerName,
          start: formatKodyDate(detail.startsAtUtc, locale, displayTimeZone, true),
        });
      } else if (detail.type === "BOOKING_RESCHEDULED") {
        text = t("kody.outcomes.bookingRescheduled", {
          job: detail.jobNumber,
          customer: detail.customerName,
          start: formatKodyDate(detail.startsAtUtc, locale, displayTimeZone, true),
        });
      } else {
        text = t("kody.outcomes.bookingDispatched", { job: detail.jobNumber, customer: detail.customerName });
      }
      if (detail.type === "BOOKING_CREATED" || detail.type === "BOOKING_RESCHEDULED" || detail.type === "BOOKING_DISPATCHED") {
        text = `${text} ${t(detail.inAppNotificationCreated ? "kody.outcomes.inAppAvailable" : "kody.outcomes.noInAppCreated")}`;
      }
      setMessages((current) => current.length
        ? [...current, { id: makeMessageId(), role: "kody", text }]
        : current);
      track("kody_action_outcome", { type: detail.type });
    };
    window.addEventListener(KODY_OUTCOME_EVENT, handleKodyOutcome);
    return () => window.removeEventListener(KODY_OUTCOME_EVENT, handleKodyOutcome);
  }, [displayTimeZone, locale, t, track]);

  useEffect(() => {
    if (!open) return undefined;

    const backgroundTargets = isModalViewport
      ? Array.from(new Set(document.querySelectorAll<HTMLElement>(
          ".qf-mobile-header, #main-content, .qf-mobile-bottom-nav, .qf-kody-underlay",
        )))
      : [];
    const backgroundStates = backgroundTargets.map((target) => ({ target, inert: target.inert }));
    const previousBodyOverflow = document.body.style.overflow;
    for (const target of backgroundTargets) target.inert = true;
    if (isModalViewport) document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && isModalViewport && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), summary, textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first && last) {
          if (!panelRef.current.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }

      if (event.key === "Escape") {
        const activeElement = document.activeElement;
        if (!isModalViewport && activeElement && panelRef.current && !panelRef.current.contains(activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        closeKody("keyboard");
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown, true);
      for (const { target, inert } of backgroundStates) target.inert = inert;
      if (isModalViewport) document.body.style.overflow = previousBodyOverflow;
    };
  }, [closeKody, isModalViewport, open]);

  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.kodyOpen = "true";
    else delete root.dataset.kodyOpen;
    return () => {
      delete root.dataset.kodyOpen;
    };
  }, [open]);

  useEffect(() => {
    if (loadingStartedAt === null) return undefined;

    const updatePendingMessage = () => {
      const pendingMessageId = pendingMessageIdRef.current;
      if (!pendingMessageId) return;
      const text = kodyLoadingText(elapsedSince(loadingStartedAt), loadingTool, t);
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId && message.pending ? { ...message, text } : message,
        ),
      );
    };

    updatePendingMessage();
    const timer = window.setInterval(updatePendingMessage, 900);
    return () => window.clearInterval(timer);
  }, [loadingStartedAt, loadingTool, t]);

  useEffect(() => {
    if (!open) return;
    const conversation = conversationRef.current;
    if (!conversation) return;
    window.requestAnimationFrame(() => {
      conversation.scrollTo({
        top: conversation.scrollHeight,
        behavior: messages.length > 2 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "auto",
      });
    });
  }, [open, messages.length, loading]);

  async function submitPrompt(options?: { prompt?: string; tool?: AiAssistantTool | "AUTO" }) {
    const messageText = (options?.prompt ?? prompt).trim();
    if (!messageText || loading || submitInFlightRef.current) return;
    const tool = options?.tool ?? selectedTool;
    if (aiPaidActionsUnavailable && assistantToolConsumesAiBudget(tool)) {
      setError(aiUsageUnavailableMessage);
      return;
    }
    submitInFlightRef.current = true;
    const routeJobId = workspacePage === "jobs" ? jobIdFromPath(location.pathname) : null;
    const context = {
      ...(contextOverride ?? {}),
      currentPage: contextOverride?.currentPage ?? currentContextPage,
      ...(contextOverride?.jobId ? {} : routeJobId ? { jobId: routeJobId } : {}),
      limit: contextOverride?.limit ?? 8,
    };
    const matchFingerprint = JSON.stringify({ message: messageText, tool, context });
    const retryIdentity = retryIdentityRef.current?.matchFingerprint === matchFingerprint
      ? retryIdentityRef.current
      : null;
    const conversation = retryIdentity?.conversation ?? recentConversation(messages);
    const requestFingerprint = JSON.stringify({ message: messageText, tool, context, conversation });
    const idempotencyKey = retryIdentity?.requestFingerprint === requestFingerprint
      ? retryIdentity.idempotencyKey
      : `qf-ai-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const userMessageId = retryIdentity?.userMessageId ?? makeMessageId();
    const pendingMessageId = retryIdentity?.responseMessageId ?? makeMessageId();
    activeRequestRef.current = {
      id: requestId,
      controller,
      prompt: messageText,
      matchFingerprint,
      requestFingerprint,
      idempotencyKey,
      conversation,
      userMessageId,
    };

    if (quickPromptsRef.current) quickPromptsRef.current.open = false;

    const startedAt = performance.now();
    pendingMessageIdRef.current = pendingMessageId;
    setError(null);
    setNotice(null);
    setLoading(true);
    setLoadingTool(tool);
    setLoadingStartedAt(startedAt);
    // Keep the exact in-flight request visible and recoverable. The composer is
    // disabled while loading, then cleared only after an accepted response.
    setPrompt(messageText);
    setMessages((current) => {
      const withUserMessage = current.some((message) => message.id === userMessageId)
        ? current
        : [...current, { id: userMessageId, role: "user" as const, text: messageText }];
      const pendingMessage: KodyMessage = {
        id: pendingMessageId,
        role: "kody",
        text: kodyLoadingText(0, tool, t),
        pending: true,
      };
      return withUserMessage.some((message) => message.id === pendingMessageId)
        ? withUserMessage.map((message) => (message.id === pendingMessageId ? pendingMessage : message))
        : [...withUserMessage, pendingMessage];
    });
    track("kody_submit", { tool, page: currentContextPage });

    try {
      const response = await api.ai.assistant({
        message: messageText,
        tool,
        context,
        conversation,
      }, {
        idempotencyKey,
        signal: controller.signal,
      });
      if (activeRequestRef.current?.id !== requestId || controller.signal.aborted) return;
      retryIdentityRef.current = null;
      setPrompt("");
      const assistantResponse = normalizeKodyAssistantResponse(response.assistant);
      track("kody_response", {
        tool,
        page: currentContextPage,
        ok: true,
        durationMs: elapsedSince(startedAt),
        resultCount: assistantResponse.results.length,
        citationCount: assistantResponse.citations.length,
        maxClassification: assistantResponse.maxClassification,
      });
      setMessages((current) => {
        const replacement: KodyMessage = {
          id: pendingMessageId,
          role: "kody",
          text: assistantResponse.answer,
          pending: false,
          response: assistantResponse,
          usageNotice: formatAiUsageNotice(response.usage, locale),
        };
        return current.some((message) => message.id === pendingMessageId)
          ? current.map((message) => (message.id === pendingMessageId ? replacement : message))
          : [...current, replacement];
      });
      publishAiUsageUpdate(response.usage);
      setSelectedTool("AUTO");
      const bookingOutcome = assistantResponse.diagnostics.filters.outcome;
      const bookingNeedsClarification = assistantResponse.tool === "PREPARE_BOOKING"
        && typeof bookingOutcome === "string"
        && ["MISSING_DATE", "MISSING_TIME", "MISSING_DURATION", "MISSING_SEARCH_WINDOW"].includes(bookingOutcome);
      if (!bookingNeedsClarification) setContextOverride(null);
    } catch (err) {
      if (activeRequestRef.current?.id !== requestId || controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      const errorCode =
        err instanceof ApiError && err.details && typeof err.details === "object"
          ? (err.details as { code?: unknown }).code
          : null;
      const usageUpdate = aiUsageUpdateFromApiError(err);
      if (usageUpdate) publishAiUsageUpdate(usageUpdate);
      const message = errorCode === "AI_USAGE_LIMIT_REACHED"
        ? t("kody.usage.paidNotRun")
        : errorCode === "AI_USAGE_REQUEST_ALREADY_PROCESSED"
          ? t("apiErrors.aiAlreadyProcessed")
        : err instanceof ApiError && err.status === 409
          ? t("kody.usage.requestInProgress")
          : errorCode === "AI_USAGE_ACCOUNTING_UNAVAILABLE"
            ? t("kody.usage.accountingUnavailable")
            : err instanceof ApiError && err.status === 503
              ? t("kody.errors.temporaryFailure")
            : localizedApiError(err, t, { fallbackKey: "kody.errors.requestFailed" });
      const ambiguousFailure = !(err instanceof ApiError) || err.status === 409 || err.status === 503;
      retryIdentityRef.current = ambiguousFailure
        ? {
          matchFingerprint,
          requestFingerprint,
          idempotencyKey,
          conversation,
          userMessageId,
          responseMessageId: pendingMessageId,
        }
        : null;
      setPrompt(messageText);
      setError(message);
      track("kody_response", {
        tool,
        page: currentContextPage,
        ok: false,
        durationMs: elapsedSince(startedAt),
        status: err instanceof ApiError ? err.status : 0,
      });
      setMessages((current) => {
        const replacement: KodyMessage = {
          id: pendingMessageId,
          role: "kody",
          text: message,
          pending: false,
        };
        return current.some((existingMessage) => existingMessage.id === pendingMessageId)
          ? current.map((existingMessage) => (existingMessage.id === pendingMessageId ? replacement : existingMessage))
          : [...current, replacement];
      });
    } finally {
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
        submitInFlightRef.current = false;
      }
      if (pendingMessageIdRef.current === pendingMessageId) {
        pendingMessageIdRef.current = null;
      }
      if (!activeRequestRef.current) {
        setLoadingStartedAt(null);
        setLoadingTool("AUTO");
        setLoading(false);
      }
    }
  }

  function cancelPrompt() {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    activeRequest.controller.abort();
    activeRequestRef.current = null;
    submitInFlightRef.current = false;
    retryIdentityRef.current = {
      matchFingerprint: activeRequest.matchFingerprint,
      requestFingerprint: activeRequest.requestFingerprint,
      idempotencyKey: activeRequest.idempotencyKey,
      conversation: activeRequest.conversation,
      userMessageId: activeRequest.userMessageId,
      responseMessageId: null,
    };
    setPrompt(activeRequest.prompt);
    setLoading(false);
    setLoadingStartedAt(null);
    setLoadingTool("AUTO");
    setError(null);
    setNotice(t("kody.composer.cancelled"));
    const pendingMessageId = pendingMessageIdRef.current;
    pendingMessageIdRef.current = null;
    if (pendingMessageId) {
      setMessages((current) => current.filter((message) => message.id !== pendingMessageId));
    }
    track("kody_cancel", { page: currentContextPage });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleQuickPrompt(quickPrompt: QuickPrompt) {
    if (quickPromptsRef.current) quickPromptsRef.current.open = false;
    setSelectedTool(quickPrompt.tool);
    setError(null);
    setNotice(null);
    if (quickPrompt.submitImmediately) {
      void submitPrompt({ prompt: quickPrompt.prompt, tool: quickPrompt.tool });
      return;
    }
    setPrompt(quickPrompt.prompt);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function startNewConversation() {
    if (loading) return;
    setMessages([]);
    setPrompt("");
    setSelectedTool("AUTO");
    setContextOverride(null);
    setError(null);
    retryIdentityRef.current = null;
    if (quickPromptsRef.current) quickPromptsRef.current.open = false;
    track("kody_conversation_reset", { page: currentContextPage });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function collapseForMobileHandoff(type: AiAssistantAction["type"]) {
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    setOpen(false);
    track("kody_mobile_handoff_collapsed", { type });
  }

  function rejectInvalidAction(message: string, action: AiAssistantAction) {
    setError(message);
    track("kody_action_invalid", { type: action.type });
  }

  function executeAction(action: AiAssistantAction, source: "direct" | "confirmed") {
    if (action.requiresConfirmation && source !== "confirmed") {
      setPendingAction(action);
      track("kody_action_confirmation_enforced", { type: action.type });
      return;
    }
    track("kody_action", { type: action.type, source, requiresConfirmation: action.requiresConfirmation });
    if (action.type === "OPEN_CUSTOMER") {
      const customerId = getString(action.payload.customerId);
      if (!customerId) return rejectInvalidAction(t("kody.errors.openCustomer"), action);
      collapseForMobileHandoff(action.type);
      navigate("/app/customers", { state: { kodyCustomerId: customerId } });
      return;
    }

    if (action.type === "OPEN_CUSTOMER_DRAFT") {
      const fullName = getString(action.payload.fullName);
      const phone = getString(action.payload.phone);
      if (!fullName || !phone) {
        return rejectInvalidAction(t("kody.errors.customerDraft"), action);
      }
      collapseForMobileHandoff(action.type);
      navigate("/app/customers", {
        state: {
          kodyCustomerDraft: {
            fullName,
            phone,
            email: getString(action.payload.email) ?? "",
            notes: getString(action.payload.notes) ?? "",
          },
        },
      });
      return;
    }

    if (action.type === "OPEN_QUOTE_DRAFT") {
      collapseForMobileHandoff(action.type);
      navigate("/app/build", { state: { kodyQuoteDraft: action.payload } });
      return;
    }

    if (action.type === "OPEN_PRODUCT_DRAFT") {
      collapseForMobileHandoff(action.type);
      navigate("/app/products", { state: { kodyProductDraft: action.payload } });
      return;
    }

    if (action.type === "OPEN_QUOTE_SEND") {
      const quoteId = getString(action.payload.quoteId);
      const channel = getString(action.payload.channel);
      if (!quoteId || (channel !== "email" && channel !== "sms" && channel !== "copy")) {
        return rejectInvalidAction(t("kody.errors.quoteSend"), action);
      }
      collapseForMobileHandoff(action.type);
      navigate(`/app/quotes/${encodeURIComponent(quoteId)}`, {
        state: { kodyQuoteSend: { quoteId, channel } },
      });
      return;
    }

    if (action.type === "OPEN_ACTIVITY_DRAFT") {
      const customerId = getString(action.payload.customerId);
      const customerName = getString(action.payload.customerName);
      const title = getString(action.payload.title);
      const dueAtUtc = getString(action.payload.dueAtUtc);
      const type = getString(action.payload.type);
      const priority = getString(action.payload.priority);
      if (!customerId || !customerName || !title || !dueAtUtc || !type || !priority) {
        return rejectInvalidAction(t("kody.errors.activityDraft"), action);
      }
      collapseForMobileHandoff(action.type);
      navigate("/app/follow-up", {
        state: {
          kodyActivityDraft: {
            customerId,
            customerName,
            quoteId: getString(action.payload.quoteId),
            quoteTitle: getString(action.payload.quoteTitle),
            type,
            priority,
            title,
            dueAtUtc,
          },
        },
      });
      return;
    }

    if (action.type === "OPEN_SCHEDULE") {
      const range = action.payload.range === "day" || action.payload.range === "week" || action.payload.range === "next7"
        ? action.payload.range
        : null;
      const date = getString(action.payload.date);
      const mine = typeof action.payload.mine === "boolean" ? action.payload.mine : null;
      if (!range || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || mine === null) {
        return rejectInvalidAction(t("kody.errors.schedule"), action);
      }
      collapseForMobileHandoff(action.type);
      navigate(`/app/jobs?${new URLSearchParams({ view: "schedule", range, date, assignee: mine ? "me" : "all" })}`);
      return;
    }

    if (action.type === "OPEN_BOOKING_REVIEW") {
      const review = bookingReviewFromAction(action);
      if (!review) return rejectInvalidAction(t("kody.errors.bookingReview"), action);
      // The Jobs workspace owns the actual create/reschedule request. Closing
      // Kody avoids stacking its review dialog with the booking surface. The
      // launcher persists across the route transition, so it is also a valid
      // return target when a Kody-initiated reschedule is canceled.
      originFocusRef.current = null;
      setOpen(false);
      navigate(`/app/jobs/${encodeURIComponent(review.jobId)}`, {
        state: { kodyBookingReview: review, kodyFocusReturnId: "kody-launcher" },
      });
      return;
    }

    if (action.type === "OPEN_DISPATCH_REVIEW") {
      const review = dispatchReviewFromAction(action);
      if (!review) return rejectInvalidAction(t("kody.errors.dispatchReview"), action);
      originFocusRef.current = null;
      setOpen(false);
      navigate(`/app/jobs/${encodeURIComponent(review.jobId)}`, { state: { kodyDispatchReview: review } });
      return;
    }

    if (action.type === "OPEN_ANALYTICS") {
      navigate("/app/analytics", { state: { kodyInsight: action.payload } });
      return;
    }

    if (action.type === "OPEN_WORKSPACE_PAGE") {
      const page = getString(action.payload.page);
      const jobId = getString(action.payload.jobId);
      const invoiceId = getString(action.payload.invoiceId);
      const routes: Record<string, string> = {
        customers: "/app/customers",
        quotes: "/app/quotes",
        products: "/app/products",
        "follow-up": "/app/follow-up",
        jobs: "/app/jobs",
        analytics: "/app/analytics",
        build: "/app/build",
      };
      const path = page ? routes[page] : null;
      if (!path) return;
      if (page === "jobs") {
        navigate(jobId ? `/app/jobs/${encodeURIComponent(jobId)}` : path, {
          state: {
            ...(jobId ? { kodyJobId: jobId } : {}),
            ...(invoiceId ? { kodyInvoiceId: invoiceId } : {}),
          },
        });
        return;
      }
      navigate(path);
      return;
    }

    if (action.type === "REQUEST_ADMIN_ACCESS") {
      navigate("/app/settings/users");
    }
  }

  function handleAction(action: AiAssistantAction, auditEventId: string) {
    const boundAction = action.type === "OPEN_QUOTE_DRAFT" && auditEventId !== "audit-unavailable"
      ? {
          ...action,
          payload: {
            ...action.payload,
            auditEventId,
          },
        }
      : action;
    if (boundAction.requiresConfirmation) {
      setPendingAction(boundAction);
      track("kody_action_confirmation_requested", { type: boundAction.type });
      return;
    }

    if (action.type === "OPEN_QUICKBOOKS_SETUP") {
      collapseForMobileHandoff(action.type);
      navigate("/app/settings#admin-quickbooks");
      return;
    }
    executeAction(boundAction, "direct");
  }

  const pendingActionCopy = pendingAction
    ? actionConfirmationCopy(pendingAction, t, locale, displayTimeZone)
    : null;

  return (
    <>
      {!open && !hasContextualKodyLauncher ? (
        <button
          ref={launcherRef}
          type="button"
          onClick={() => {
            originFocusRef.current = launcherRef.current;
            setOpen(true);
            track("kody_open", { page: currentContextPage });
          }}
          className={cn(
            "fixed right-[max(0.875rem,env(safe-area-inset-right))] z-[55] inline-flex h-[60px] min-h-[60px] w-[60px] items-center justify-center rounded-full border border-[var(--qf-kody-trigger-border)] bg-[var(--qf-kody-trigger)] text-[var(--qf-kody-trigger-text)] shadow-[0_12px_28px_rgba(3,7,18,0.3)] motion-safe:transition motion-safe:hover:-translate-y-0.5 hover:border-[var(--qf-kody-trigger-hover)] hover:bg-[var(--qf-kody-trigger-hover)] hover:shadow-[0_16px_34px_rgba(3,7,18,0.36)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] active:bg-[var(--qf-kody-trigger-active)] lg:right-6",
            hasMobileActionDock
              ? "bottom-[calc(var(--qf-mobile-nav-clearance)+5.5rem)] lg:bottom-[7rem] xl:bottom-6"
              : "bottom-[calc(var(--qf-mobile-nav-clearance)+0.5rem)] lg:bottom-6",
          )}
          aria-label={t("kody.button")}
          aria-expanded="false"
          id="kody-launcher"
          data-testid="kody-launcher"
        >
          <KodySparkIcon size={46} />
        </button>
      ) : null}

      {open ? (
        <>
          {isModalViewport ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => closeKody("button")}
              className="fixed inset-0 z-[65] cursor-default bg-[var(--qf-overlay)]"
              data-testid="kody-modal-backdrop"
            />
          ) : null}
          <section
            ref={panelRef}
            aria-label={t("kody.assistantLabel")}
            aria-modal={isModalViewport ? "true" : "false"}
            role="dialog"
            data-testid="kody-chat-panel"
            className={cn(
              "qf-kody-chat-panel fixed z-[70] flex flex-col overflow-hidden rounded-[22px] border border-[var(--qf-kody-header-border)] bg-[var(--qf-kody-shell)] shadow-[var(--qf-shell-shadow)]",
              hasMobileActionDock && "qf-kody-chat-panel--with-dock",
            )}
          >
          <header
            className="qf-kody-header flex min-h-[72px] items-center justify-between gap-4 px-4 py-3 sm:px-5"
            data-testid="kody-header"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[var(--qf-kody-header-border)] bg-[var(--qf-kody-avatar-surface)] p-1">
                <KodySparkIcon size={40} />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--qf-kody-header-text)]">Kody</h2>
                <p className="mt-0.5 truncate text-xs leading-5 text-[var(--qf-kody-header-muted)]">
                  {t("kody.subtitle")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length ? (
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={<RotateCcw size={17} />}
                  label={t("kody.newConversation")}
                  disabled={loading}
                  onClick={startNewConversation}
                  className="qf-kody-header-control !h-11 !min-h-11 !w-11 rounded-full"
                />
              ) : null}
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                icon={<X size={18} />}
                label={t("kody.close")}
                onClick={() => closeKody("button")}
                className="qf-kody-header-control !h-11 !min-h-11 !w-11 rounded-full"
              />
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 bg-[var(--qf-kody-shell)] p-3 sm:p-4">
          <details
            ref={quickPromptsRef}
            className="group shrink-0 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)]"
            data-testid="kody-quick-prompts"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--qf-text)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
              <span>{t("kody.suggestions.title")}</span>
              <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--qf-text-muted)]">
                {t("kody.suggestions.count", { count: primaryQuickPrompts.length })}
                <ChevronDown size={16} className="motion-safe:transition-transform motion-safe:group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="border-t border-[var(--qf-border)] p-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {primaryQuickPrompts.map((quickPrompt) => (
                  <KodyQuickPromptButton
                    key={quickPrompt.label}
                    quickPrompt={quickPrompt}
                    selected={selectedTool === quickPrompt.tool}
                    disabled={loading || (aiPaidActionsUnavailable && assistantToolConsumesAiBudget(quickPrompt.tool))}
                    disabledReason={aiPaidActionsUnavailable && assistantToolConsumesAiBudget(quickPrompt.tool) ? aiUsageUnavailableMessage : undefined}
                    onSelect={handleQuickPrompt}
                  />
                ))}
              </div>
              {additionalQuickPrompts.length ? (
                <details className="group/more mt-2 border-t border-[var(--qf-border)] pt-1">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-xs font-semibold text-[var(--qf-text-soft)] marker:hidden hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
                    <span>{t("kody.suggestions.more")}</span>
                    <span className="inline-flex items-center gap-2 text-[var(--qf-text-muted)]">
                      {additionalQuickPrompts.length}
                      <ChevronDown size={15} className="motion-safe:transition-transform motion-safe:group-open/more:rotate-180" aria-hidden="true" />
                    </span>
                  </summary>
                  <div className="grid grid-cols-1 gap-2 pb-1 pt-2 sm:grid-cols-3">
                    {additionalQuickPrompts.map((quickPrompt) => (
                      <KodyQuickPromptButton
                        key={quickPrompt.label}
                        quickPrompt={quickPrompt}
                        selected={selectedTool === quickPrompt.tool}
                        disabled={loading || (aiPaidActionsUnavailable && assistantToolConsumesAiBudget(quickPrompt.tool))}
                        disabledReason={aiPaidActionsUnavailable && assistantToolConsumesAiBudget(quickPrompt.tool) ? aiUsageUnavailableMessage : undefined}
                        onSelect={handleQuickPrompt}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </details>
          {aiPaidActionsUnavailable ? <Alert tone="warning">{aiUsageUnavailableMessage}</Alert> : null}

          <div
            ref={conversationRef}
            role="log"
            aria-label={t("kody.conversationLabel")}
            tabIndex={0}
            className="qf-kody-thread min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-[var(--qf-border)] p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:p-4"
          >
            {!messages.length ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center px-4 text-center">
                <p className="text-base font-semibold text-[var(--qf-text)]">{t("kody.empty.title")}</p>
                <p className="mt-1 max-w-md text-sm leading-6 text-[var(--qf-text-soft)]">{starterText}</p>
                <p className="mt-3 text-xs font-medium text-[var(--qf-info-text)]">{t("kody.empty.safety")}</p>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex min-w-0 gap-2",
                    message.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {message.role === "kody" ? (
                    <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-kody-header-border)] bg-[var(--qf-kody-avatar-surface)] p-0.5">
                      <KodySparkIcon size={27} thinking={message.pending} />
                    </span>
                  ) : null}
                  <div
                    className={cn(
                      "min-w-0 [overflow-wrap:anywhere] rounded-[18px] px-4 py-3",
                      message.pending
                        ? "w-[calc(100%-2.5rem)] p-0 sm:max-w-[78%]"
                        : message.role === "user"
                          ? "max-w-[88%] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] sm:max-w-[82%]"
                          : "qf-kody-assistant-bubble w-[calc(100%-2.5rem)] border border-[var(--qf-border)] text-[var(--qf-text)] sm:max-w-[82%]",
                    )}
                  >
                    {message.pending ? (
                      <>
                        <div aria-hidden="true">
                          <LoadingState
                            title={message.text}
                            description={t("kody.loading.safeCheck")}
                            variant="compact"
                            className="border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]"
                          />
                        </div>
                        <span className="sr-only" role="status" aria-live="polite">{t("kody.loading.working")}</span>
                      </>
                    ) : message.response ? (
                      <KodyResponse
                        response={message.response}
                        usageNotice={message.usageNotice}
                        onAction={handleAction}
                        displayTimeZone={displayTimeZone}
                      />
                    ) : (
                      <p
                        className="text-sm leading-6"
                        role={message.role === "kody" ? "status" : undefined}
                        aria-live={message.role === "kody" ? "polite" : undefined}
                      >
                        {message.text}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="qf-kody-composer-footer -mx-3 -mb-3 mt-auto shrink-0 border-t border-[var(--qf-border)] p-3 sm:-mx-4 sm:-mb-4 sm:p-4">
            {error ? <div className="mb-2"><Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert></div> : null}
            {notice ? <div className="mb-2"><Alert tone="info" onDismiss={() => setNotice(null)}>{notice}</Alert></div> : null}
            <form
              className="qf-kody-composer flex items-end gap-2 rounded-2xl border border-[var(--qf-border-strong)] p-2 focus-within:border-[var(--qf-focus)] focus-within:ring-4 focus-within:ring-[var(--qf-focus-ring)]"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPrompt();
              }}
            >
              <label htmlFor="kody-prompt-input" className="sr-only">{t("kody.button")}</label>
              <textarea
                id="kody-prompt-input"
                ref={inputRef}
                data-testid="kody-prompt"
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (selectedTool !== "AUTO") setSelectedTool("AUTO");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
                rows={1}
                maxLength={2_000}
                aria-label={t("kody.button")}
                aria-describedby="kody-prompt-instructions"
                placeholder={t("kody.composer.placeholder")}
                className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-3 text-base leading-6 text-[var(--qf-text)] outline-none placeholder:text-[var(--qf-text-muted)] sm:text-sm"
                disabled={loading}
              />
              {loading ? (
                <IconButton
                  type="button"
                  variant="outline"
                  icon={<X size={17} />}
                  label={t("kody.composer.stop")}
                  onPointerDown={() => cancelPrompt()}
                  onClick={cancelPrompt}
                  className="rounded-xl"
                  data-testid="kody-cancel-request"
                />
              ) : (
                <IconButton
                  type="submit"
                  variant="kody"
                  icon={<Send size={17} />}
                  label={t("kody.composer.send")}
                  disabled={!prompt.trim()}
                  className="rounded-xl"
                />
              )}
            </form>
            <span id="kody-prompt-instructions" className="sr-only">
              {t("kody.composer.instructions")}
            </span>
          </div>
          </div>
          </section>
        </>
      ) : null}

      <ConfirmModal
        open={Boolean(pendingAction)}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          if (action) executeAction(action, "confirmed");
        }}
        title={pendingActionCopy?.title ?? t("kody.confirm.defaultTitle")}
        description={pendingActionCopy?.description}
        confirmLabel={pendingActionCopy?.confirmLabel ?? t("kody.confirm.continue")}
        cancelLabel={t("common.cancel")}
        confirmVariant="kody"
      />
    </>
  );
}
