import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  ChevronDown,
  Clock3,
  FilePlus2,
  PackagePlus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
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
  publishAiUsageUpdate,
  type AiUsageUpdateDetail,
} from "../../lib/ai-credits";
import { useTrack } from "../../lib/analytics";
import { formatBackendLabel, formatShortLocalDate, isDateResultKey } from "../../lib/display-format";
import { cn } from "../../lib/utils";
import { Alert, Button, ConfirmModal, IconButton, LoadingState, Textarea } from "../ui";
import { workspacePageFromPath, type WorkspacePage } from "../crm/workspace-navigation";
import { KodySparkIcon } from "./KodySparkIcon";
import { KODY_OPEN_EVENT, KODY_OUTCOME_EVENT, type KodyOpenDetail, type KodyOutcomeDetail } from "./kody-events";
import { normalizeKodyAssistantResponse } from "./kody-response-normalization";

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

const QUICK_PROMPTS: QuickPrompt[] = [
  {
    tool: "DRAFT_CUSTOMER",
    label: "Add customer",
    description: "Prepare a contact for review.",
    prompt: "Add a new customer named ",
    icon: <UserPlus size={15} />,
  },
  {
    tool: "DRAFT_QUOTE",
    label: "Draft quote",
    description: "Start with customer, job, and rough scope.",
    prompt: "Draft a quote for ",
    icon: <FilePlus2 size={15} />,
  },
  {
    tool: "PREPARE_QUOTE_SEND",
    label: "Send quote",
    description: "Find a saved quote and review the recipient.",
    prompt: "Send the latest quote to ",
    icon: <Send size={15} />,
  },
  {
    tool: "DRAFT_PRODUCT",
    label: "Add product",
    description: "Prepare a priced catalog item for review.",
    prompt: "Add a new product or service named ",
    icon: <PackagePlus size={15} />,
  },
  {
    tool: "SEARCH_CUSTOMERS",
    label: "Find customer",
    description: "Search by name, phone, or email.",
    prompt: "Find customer ",
    icon: <Search size={15} />,
  },
  {
    tool: "SUMMARIZE_PIPELINE",
    label: "Pipeline",
    description: "Revenue-only status summary.",
    prompt: "Summarize my sales pipeline for the last 90 days.",
    icon: <BarChart3 size={15} />,
    submitImmediately: true,
  },
  {
    tool: "FOLLOW_UP_QUEUE",
    label: "Needs follow-up",
    description: "See who needs attention today and why.",
    prompt: "Who needs follow-up today, and why?",
    icon: <Clock3 size={15} />,
    submitImmediately: true,
  },
  {
    tool: "RANK_PROFITABLE_JOBS",
    label: "Profitability",
    description: "Owner/admin cost and margin view.",
    prompt: "Rank profitable jobs by service for the last 90 days.",
    icon: <TrendingUp size={15} />,
    submitImmediately: true,
  },
];

const QUICK_PROMPT_PRIORITY: Partial<Record<WorkspacePage, AiAssistantTool[]>> = {
  home: ["DRAFT_QUOTE", "DRAFT_CUSTOMER", "FOLLOW_UP_QUEUE"],
  customers: ["DRAFT_CUSTOMER", "SEARCH_CUSTOMERS", "DRAFT_QUOTE"],
  quotes: ["DRAFT_QUOTE", "PREPARE_QUOTE_SEND", "SUMMARIZE_PIPELINE"],
  "quote-desk": ["PREPARE_QUOTE_SEND", "DRAFT_QUOTE", "SUMMARIZE_PIPELINE"],
  products: ["DRAFT_PRODUCT", "DRAFT_QUOTE", "SEARCH_CUSTOMERS"],
  build: ["DRAFT_QUOTE", "DRAFT_CUSTOMER", "DRAFT_PRODUCT"],
  "follow-up": ["FOLLOW_UP_QUEUE", "SEARCH_CUSTOMERS", "PREPARE_QUOTE_SEND"],
  analytics: ["SUMMARIZE_PIPELINE", "RANK_PROFITABLE_JOBS", "FOLLOW_UP_QUEUE"],
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
  onSelect,
}: {
  quickPrompt: QuickPrompt;
  selected: boolean;
  disabled: boolean;
  onSelect: (quickPrompt: QuickPrompt) => void;
}) {
  return (
    <button
      type="button"
      title={quickPrompt.description}
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

function assistantContextFromPage(page: WorkspacePage): "quotes" | "customers" | "analytics" | "products" | "dashboard" {
  if (page === "customers") return "customers";
  if (page === "products") return "products";
  if (page === "analytics" || page === "follow-up") return "analytics";
  if (page === "quotes" || page === "build" || page === "quote-desk") return "quotes";
  return "dashboard";
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

function kodyLoadingText(elapsedMs: number, tool: AiAssistantTool | "AUTO") {
  if (elapsedMs < 900) return "Thinking...";

  if (elapsedMs < 2_700) {
    if (tool === "SEARCH_CUSTOMERS") return "Looking through your customers...";
    if (tool === "NAVIGATE_WORKSPACE") return "Finding the right page...";
    if (tool === "FOLLOW_UP_QUEUE") return "Checking your follow-ups...";
    if (tool === "CUSTOMERS_WITHOUT_QUOTES") return "Checking who still needs a quote...";
    if (tool === "PIPELINE_SCENARIO") return "Crunching the numbers...";
    if (tool === "DRAFT_CUSTOMER") return "Preparing customer details...";
    if (tool === "DRAFT_PRODUCT") return "Preparing your product details...";
    if (tool === "DRAFT_QUOTE") return "Gathering quote details...";
    if (tool === "PREPARE_QUOTE_SEND") return "Checking the quote and recipient...";
    if (tool === "SUMMARIZE_PIPELINE") return "Gathering pipeline info...";
    if (tool === "RANK_PROFITABLE_JOBS") return "Comparing job performance...";
    if (tool === "ASSISTANT_HELP") return "Getting Kody ready...";
    if (tool === "OUT_OF_SCOPE") return "Checking what Kody can help with...";
    return "Gathering info...";
  }

  if (elapsedMs < 4_500) return "Preparing your response...";
  if (elapsedMs < 8_000) return "Double-checking the details...";
  return "Still working through it...";
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatKey(key: string) {
  return key
    .replace(/Id$/, "")
    .replace(/Utc$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatResultValue(
  key: string,
  value: string | number | boolean | null,
  displayTimeZone?: string | null,
) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/amount|revenue|cost|profit|price|total/i.test(key)) {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
    }
    if (/percent|rate/i.test(key)) return `${value}%`;
    return value.toLocaleString();
  }
  if (isDateResultKey(key)) {
    const formattedDate = formatShortLocalDate(value, displayTimeZone);
    if (formattedDate) return formattedDate;
  }
  return formatBackendLabel(value);
}

function visibleResultEntries(result: Record<string, string | number | boolean | null>) {
  return Object.entries(result)
    .filter(([key]) => !/^(customerId|quoteId|quoteRefHash|id|tenantId)$/i.test(key))
    .slice(0, 6);
}

function resultTitle(result: Record<string, string | number | boolean | null>, fallback: string) {
  const title = (
    getString(result.fullName) ??
    getString(result.title) ??
    getString(result.serviceType) ??
    getString(result.item) ??
    getString(result.status) ??
    fallback
  );
  return formatBackendLabel(title);
}

function classificationMeta(classification: DataClassification) {
  if (classification === "C4_RESTRICTED") {
    return {
      label: "Restricted data",
      description: "Kody should not use this unless a tightly approved internal workflow allows it.",
    };
  }
  if (classification === "C3_FINANCIAL_CONFIDENTIAL") {
    return {
      label: "Financial data",
      description: "Costs, margins, profit, and pricing insights are limited to owner/admin access.",
    };
  }
  if (classification === "C2_CUSTOMER_CONFIDENTIAL") {
    return {
      label: "Customer data",
      description: "Customer and quote context is limited to your signed-in workspace.",
    };
  }
  if (classification === "C1_BUSINESS_INTERNAL") {
    return {
      label: "Workspace data",
      description: "Internal business context is available only inside this tenant workspace.",
    };
  }
  return {
    label: "Public data",
    description: "This response only used data that is safe for public or product-level display.",
  };
}

function compactSourceList(citations: AiAssistantResponse["assistant"]["citations"]) {
  const sources = Array.from(new Set(citations.map((citation) => citation.sourceType))).filter(Boolean);
  if (!sources.length) return "No workspace rows were retrieved.";
  return sources.slice(0, 3).join(" + ");
}

function formatHiddenField(field: string) {
  const normalized = field.toLowerCase();
  if (normalized.includes("tenant")) return "tenant boundary fields";
  if (normalized.includes("deleted")) return "deleted records";
  if (normalized.includes("archived")) return "archived records";
  if (normalized.includes("internal cost")) return "internal costs";
  if (normalized.includes("margin")) return "margin details";
  if (normalized.includes("password") || normalized.includes("token") || normalized.includes("secret")) return "secrets";
  return formatKey(field);
}

function compactHiddenList(fieldsExcluded: string[]) {
  if (!fieldsExcluded.length) return "No extra fields hidden.";
  const visible = fieldsExcluded.slice(0, 3).map(formatHiddenField);
  const remaining = fieldsExcluded.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`;
}

function formatVisibleAnswer(answer: string) {
  return answer
    .replace(/\s*\[(?:[A-Z]\d+(?:\s*,\s*)?)+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function actionConfirmationCopy(action: AiAssistantAction) {
  if (action.type === "OPEN_CUSTOMER_DRAFT") {
    const fullName = getString(action.payload.fullName) ?? "this customer";
    const phone = getString(action.payload.phone);
    const email = getString(action.payload.email);
    const contactSummary = [phone, email].filter(Boolean).join(" · ");
    return {
      title: `Review ${fullName}?`,
      description: `${contactSummary ? `${contactSummary}. ` : ""}Kody will open the customer form with these details. Nothing is saved until you review the form and press Save customer.`,
      confirmLabel: "Open customer review",
    };
  }
  if (action.type === "OPEN_PRODUCT_DRAFT") {
    return {
      title: "Review Kody's product draft?",
      description:
        "Kody will open the Products form with the details it understood. Nothing is added until you review the unit, internal cost, customer price, and click Add product.",
      confirmLabel: "Open product review",
    };
  }
  if (action.type === "OPEN_QUOTE_DRAFT") {
    return {
      title: "Review Kody's quote draft?",
      description:
        "Kody will open this in the quote builder. Nothing will be saved or sent until you review the customer, scope, pricing, and click Create Quote.",
      confirmLabel: "Open review draft",
    };
  }
  if (action.type === "OPEN_QUOTE_SEND") {
    const quoteTitle = getString(action.payload.quoteTitle) ?? "this quote";
    const customerName = getString(action.payload.customerName) ?? "the customer";
    const destination = getString(action.payload.destination);
    const channel = getString(action.payload.channel);
    const channelLabel = channel === "sms" ? "text" : channel === "copy" ? "copy" : "email";
    return {
      title: `Review ${channelLabel} for ${customerName}?`,
      description: `${quoteTitle}${destination ? ` · ${destination}` : ""}. Kody will open the existing send composer for your review. It will not contact the customer or mark the quote sent automatically.`,
      confirmLabel: "Open send review",
    };
  }
  if (action.type === "REQUEST_ADMIN_ACCESS") {
    return {
      title: "Open access settings?",
      description:
        "Kody will take you to workspace settings so an owner or admin can review the required permission.",
      confirmLabel: "Open settings",
    };
  }
  return {
    title: "Continue with Kody action?",
    description:
      "Kody will move you to the matching workspace page. Review anything important before saving or sending.",
    confirmLabel: "Continue",
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
  const entries = visibleResultEntries(result);
  return (
    <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] p-3 transition-colors hover:border-[var(--qf-info-border)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--qf-info-surface)] text-[11px] font-bold text-[var(--qf-info-text)]">
          {index + 1}
        </span>
        <p className="min-w-0 text-sm font-semibold text-[var(--qf-text)]">{resultTitle(result, `Result ${index + 1}`)}</p>
      </div>
      {entries.length ? (
        <dl className="mt-2 grid gap-1.5 text-xs text-[var(--qf-text-soft)]">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-[var(--qf-text-muted)]">{formatKey(key)}</dt>
              <dd className="min-w-0 text-right font-medium text-[var(--qf-text)]">{formatResultValue(key, value, displayTimeZone)}</dd>
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
  onAction: (action: AiAssistantAction) => void;
  displayTimeZone?: string | null;
}) {
  const track = useTrack();
  const meta = classificationMeta(response.maxClassification);
  const visibleAnswer = formatVisibleAnswer(response.answer);
  const [feedback, setFeedback] = useState<AiAssistantFeedbackRating | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [showFeedbackNote, setShowFeedbackNote] = useState(false);
  const [lastFeedbackSave, setLastFeedbackSave] = useState<"rating" | "note" | null>(null);

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
          {formatKey(response.diagnostics.resolvedTool)}
        </p>
        <p
          className="whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text)]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {visibleAnswer || "Kody returned a response, but there was no answer text to show."}
        </p>

        {response.actions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {response.actions.slice(0, 3).map((action, index) => (
              <Button
                key={`${action.type}-${index}`}
                type="button"
                size="sm"
                variant={action.type === "REQUEST_ADMIN_ACCESS" || index > 0 ? "outline" : "kody"}
                onClick={() => onAction(action)}
                className="w-full sm:w-auto"
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="order-5 flex min-h-11 flex-wrap items-center gap-2 border-t border-[var(--qf-border)] pt-3">
          <span className="mr-1 text-xs font-medium text-[var(--qf-text-muted)]">Helpful?</span>
          <button
            type="button"
            onClick={() => void submitFeedback("UP")}
            disabled={feedbackStatus === "saving" || response.auditEventId === "audit-unavailable"}
            aria-label="Good response"
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
            aria-label="Poor response"
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
              ? "Saving feedback..."
              : feedbackStatus === "saved"
                ? lastFeedbackSave === "note"
                  ? "Thanks—your note was saved."
                  : "Thanks—this helps Kody improve."
                : feedbackStatus === "error"
                  ? "Feedback didn’t save. Try again."
                  : ""}
          </span>
          {feedback && !showFeedbackNote ? (
            <button
              type="button"
              onClick={() => setShowFeedbackNote(true)}
              className="ml-auto min-h-11 rounded-lg px-2 text-xs font-semibold text-[var(--qf-info-text)] hover:bg-[var(--qf-info-surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            >
              Add a note
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
              label={feedback === "DOWN" ? "What should Kody do differently? (optional)" : "What worked well? (optional)"}
              value={feedbackNote}
              onChange={(event) => setFeedbackNote(event.target.value)}
              maxLength={500}
              rows={2}
              className="min-h-[76px] resize-none"
              placeholder="Example: I asked for products, but the answer searched customers."
              disabled={feedbackStatus === "saving"}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] leading-4 text-[var(--qf-text-muted)]">
                {feedbackNote.length}/500 · Avoid customer contact details or secrets.
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowFeedbackNote(false)}>
                  Close
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={feedbackStatus === "saving"}
                  onClick={() => void submitFeedback(feedback, feedbackNote.trim() || null)}
                >
                  Save note
                </Button>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[var(--qf-text-muted)]">
              QuoteFly uses this feedback to improve Kody’s prompts and evaluations. It is not sent as a new Kody request.
            </p>
          </div>
        ) : null}
      </div>

      {response.results.length ? (
        <details
          className="group order-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)] px-3 py-2"
          data-testid="kody-results"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-semibold text-[var(--qf-text)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
            <span>View {response.results.length} {response.results.length === 1 ? "result" : "results"}</span>
            <ChevronDown
              size={16}
              className="text-[var(--qf-text-muted)] motion-safe:transition-transform motion-safe:group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-2 grid gap-2 border-t border-[var(--qf-border)] pt-3">
            {response.results.slice(0, 4).map((result, index) => (
              <KodyResultCard
                key={`${response.auditEventId}-${index}`}
                result={result}
                index={index}
                displayTimeZone={displayTimeZone}
              />
            ))}
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
            <span className="font-semibold text-[var(--qf-text)]">Sources & safety</span>
          </span>
          <span className="text-[11px] text-[var(--qf-text-muted)] group-open:hidden">Workspace-only</span>
        </summary>
        <div className="mt-3 space-y-2 border-t border-[var(--qf-border)] pt-3">
          <p>{meta.description}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="font-semibold text-[var(--qf-text-muted)]">Sources</p>
              <p className="mt-0.5 text-[var(--qf-text)]">{compactSourceList(response.citations)}</p>
            </div>
            <div>
              <p className="font-semibold text-[var(--qf-text-muted)]">Hidden for safety</p>
              <p className="mt-0.5 text-[var(--qf-text)]">{compactHiddenList(response.fieldsExcluded)}</p>
            </div>
          </div>
          {usageNotice ? <p>{usageNotice}</p> : null}
        </div>
        <p className="sr-only">Policy class {response.maxClassification}</p>
      </details>
    </div>
  );
}

export function KodyAssistant({
  currentPage,
  canViewInternalCosts = false,
  aiUsageLimitReached = false,
  aiUsageRenewsAtUtc,
  displayTimeZone,
}: {
  currentPage?: WorkspacePage;
  canViewInternalCosts?: boolean;
  aiUsageLimitReached?: boolean;
  aiUsageRenewsAtUtc?: string | null;
  displayTimeZone?: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const track = useTrack();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedTool, setSelectedTool] = useState<AiAssistantTool | "AUTO">("AUTO");
  const [contextOverride, setContextOverride] = useState<KodyOpenDetail["context"] | null>(null);
  const [messages, setMessages] = useState<KodyMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [loadingTool, setLoadingTool] = useState<AiAssistantTool | "AUTO">("AUTO");
  const [error, setError] = useState<string | null>(null);
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
  const workspacePage = currentPage ?? workspacePageFromPath(location.pathname);
  const currentContextPage = assistantContextFromPage(workspacePage);
  const aiUsageRenewalLabel = formatAiRenewalDate(aiUsageRenewsAtUtc);
  const aiUsageLimitMessage = aiUsageRenewalLabel
    ? `Kody and AI tools are paused until your monthly usage resets on ${aiUsageRenewalLabel}.`
    : "Kody and AI tools are paused until your monthly usage resets.";
  const hasMobileActionDock = workspacePage === "build" || workspacePage === "quote-desk" || workspacePage === "branding";
  const availableQuickPrompts = canViewInternalCosts
    ? QUICK_PROMPTS
    : QUICK_PROMPTS.filter((quickPrompt) => quickPrompt.tool !== "RANK_PROFITABLE_JOBS");
  const orderedQuickPrompts = orderQuickPrompts(workspacePage, availableQuickPrompts);
  const primaryQuickPrompts = orderedQuickPrompts.slice(0, 3);
  const additionalQuickPrompts = orderedQuickPrompts.slice(3);

  const starterText = useMemo(() => {
    if (messages.length) return "Ask a follow-up in plain language. Kody will keep the recent conversation in mind.";
    return "Ask about customers, quotes, follow-ups, products, pipeline, or job profitability.";
  }, [messages.length]);
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
      // Context buttons suggest useful starting text, but the user can replace
      // it with a completely different request. AUTO keeps that edited prompt
      // from being trapped in a stale customer/quote tool selection.
      setSelectedTool("AUTO");
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
      const text = detail.type === "CUSTOMER_CREATED"
        ? `${detail.customerName} is now in your workspace. You can ask me to draft their quote next.`
        : detail.type === "QUOTE_CREATED"
          ? `${detail.quoteTitle} was created${detail.customerName ? ` for ${detail.customerName}` : ""}. Open it when you’re ready to review and send.`
          : `${detail.quoteTitle} for ${detail.customerName} is now marked sent.`;
      setMessages((current) => current.length
        ? [...current, { id: makeMessageId(), role: "kody", text }]
        : current);
      track("kody_action_outcome", { type: detail.type });
    };
    window.addEventListener(KODY_OUTCOME_EVENT, handleKodyOutcome);
    return () => window.removeEventListener(KODY_OUTCOME_EVENT, handleKodyOutcome);
  }, [track]);

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
      const text = kodyLoadingText(elapsedSince(loadingStartedAt), loadingTool);
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId && message.pending ? { ...message, text } : message,
        ),
      );
    };

    updatePendingMessage();
    const timer = window.setInterval(updatePendingMessage, 900);
    return () => window.clearInterval(timer);
  }, [loadingStartedAt, loadingTool]);

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
    if (!messageText || loading) return;
    if (aiUsageLimitReached) {
      setError(aiUsageLimitMessage);
      return;
    }
    const tool = options?.tool ?? selectedTool;
    const context = {
      ...(contextOverride ?? {}),
      currentPage: contextOverride?.currentPage ?? currentContextPage,
      limit: contextOverride?.limit ?? 8,
    };
    const conversation = recentConversation(messages);

    if (quickPromptsRef.current) quickPromptsRef.current.open = false;

    const startedAt = performance.now();
    const userMessageId = makeMessageId();
    const pendingMessageId = makeMessageId();
    pendingMessageIdRef.current = pendingMessageId;
    setError(null);
    setLoading(true);
    setLoadingTool(tool);
    setLoadingStartedAt(startedAt);
    setPrompt("");
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: messageText },
      {
        id: pendingMessageId,
        role: "kody",
        text: kodyLoadingText(0, tool),
        pending: true,
      },
    ]);
    track("kody_submit", { tool, page: currentContextPage });

    try {
      const response = await api.ai.assistant({
        message: messageText,
        tool,
        context,
        conversation,
      });
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
          usageNotice: formatAiUsageNotice(response.usage),
        };
        return current.some((message) => message.id === pendingMessageId)
          ? current.map((message) => (message.id === pendingMessageId ? replacement : message))
          : [...current, replacement];
      });
      publishAiUsageUpdate(response.usage);
      setSelectedTool("AUTO");
      setContextOverride(null);
    } catch (err) {
      const errorCode =
        err instanceof ApiError && err.details && typeof err.details === "object"
          ? (err.details as { code?: unknown }).code
          : null;
      if (errorCode === "AI_USAGE_LIMIT_REACHED") {
        const usage = (err as ApiError).details as { usage?: AiUsageUpdateDetail };
        if (usage.usage) publishAiUsageUpdate(usage.usage);
      }
      const message =
        err instanceof ApiError
          ? err.message
          : "Kody could not complete that request. Try again or use the regular workspace tools.";
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
      if (pendingMessageIdRef.current === pendingMessageId) {
        pendingMessageIdRef.current = null;
      }
      setLoadingStartedAt(null);
      setLoadingTool("AUTO");
      setLoading(false);
    }
  }

  function handleQuickPrompt(quickPrompt: QuickPrompt) {
    if (quickPromptsRef.current) quickPromptsRef.current.open = false;
    setSelectedTool(quickPrompt.tool);
    setError(null);
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
      if (!customerId) return rejectInvalidAction("Kody could not open that customer. Try the search again.", action);
      collapseForMobileHandoff(action.type);
      navigate("/app/customers", { state: { kodyCustomerId: customerId } });
      return;
    }

    if (action.type === "OPEN_CUSTOMER_DRAFT") {
      const fullName = getString(action.payload.fullName);
      const phone = getString(action.payload.phone);
      if (!fullName || !phone) {
        return rejectInvalidAction("Kody needs a customer name and 10-digit phone before opening the review form.", action);
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
        return rejectInvalidAction("Kody could not open that send review. Ask Kody to find the quote again.", action);
      }
      collapseForMobileHandoff(action.type);
      navigate(`/app/quotes/${encodeURIComponent(quoteId)}`, {
        state: { kodyQuoteSend: { quoteId, channel } },
      });
      return;
    }

    if (action.type === "OPEN_ANALYTICS") {
      navigate("/app/analytics", { state: { kodyInsight: action.payload } });
      return;
    }

    if (action.type === "OPEN_WORKSPACE_PAGE") {
      const page = getString(action.payload.page);
      const routes: Record<string, string> = {
        customers: "/app/customers",
        quotes: "/app/quotes",
        products: "/app/products",
        "follow-up": "/app/follow-up",
        analytics: "/app/analytics",
        build: "/app/build",
      };
      const path = page ? routes[page] : null;
      if (!path) return;
      navigate(path);
      return;
    }

    if (action.type === "REQUEST_ADMIN_ACCESS") {
      navigate("/app/settings/users");
    }
  }

  function handleAction(action: AiAssistantAction) {
    if (action.requiresConfirmation) {
      setPendingAction(action);
      track("kody_action_confirmation_requested", { type: action.type });
      return;
    }
    executeAction(action, "direct");
  }

  const pendingActionCopy = pendingAction ? actionConfirmationCopy(pendingAction) : null;

  return (
    <>
      {!open ? (
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
          aria-label="Ask Kody"
          aria-expanded="false"
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
            aria-label="Kody assistant"
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
                  QuoteFly assistant · Workspace only
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
                  label="Start a new Kody conversation"
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
                label="Close Kody"
                onClick={() => closeKody("button")}
                className="qf-kody-header-control !h-11 !min-h-11 !w-11 rounded-full"
              />
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 bg-[var(--qf-kody-shell)] p-3 sm:p-4">
          {!aiUsageLimitReached ? <details
            ref={quickPromptsRef}
            className="group shrink-0 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-kody-assistant-surface)]"
            data-testid="kody-quick-prompts"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--qf-text)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
              <span>Suggested actions</span>
              <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--qf-text-muted)]">
                {primaryQuickPrompts.length} suggestions
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
                    disabled={loading || aiUsageLimitReached}
                    onSelect={handleQuickPrompt}
                  />
                ))}
              </div>
              {additionalQuickPrompts.length ? (
                <details className="group/more mt-2 border-t border-[var(--qf-border)] pt-1">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-xs font-semibold text-[var(--qf-text-soft)] marker:hidden hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
                    <span>More prompts</span>
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
                        disabled={loading || aiUsageLimitReached}
                        onSelect={handleQuickPrompt}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </details> : (
            <Alert tone="warning">{aiUsageLimitMessage}</Alert>
          )}

          <div ref={conversationRef} className="qf-kody-thread min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-[var(--qf-border)] p-3 sm:p-4">
            {!messages.length ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center px-4 text-center">
                <p className="text-base font-semibold text-[var(--qf-text)]">What can I help you get done?</p>
                <p className="mt-1 max-w-md text-sm leading-6 text-[var(--qf-text-soft)]">{starterText}</p>
                <p className="mt-3 text-xs font-medium text-[var(--qf-info-text)]">Workspace-only · You approve every change</p>
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
                            description="Checking your workspace safely."
                            variant="compact"
                            className="border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]"
                          />
                        </div>
                        <span className="sr-only" role="status" aria-live="polite">Kody is working.</span>
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
            <form
              className="qf-kody-composer flex items-end gap-2 rounded-2xl border border-[var(--qf-border-strong)] p-2 focus-within:border-[var(--qf-focus)] focus-within:ring-4 focus-within:ring-[var(--qf-focus-ring)]"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPrompt();
              }}
            >
              <label htmlFor="kody-prompt-input" className="sr-only">Ask Kody</label>
              <textarea
                id="kody-prompt-input"
                ref={inputRef}
                data-testid="kody-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
                rows={1}
                maxLength={2_000}
                aria-label="Ask Kody"
                aria-describedby="kody-prompt-instructions"
                placeholder={aiUsageLimitReached ? "Monthly AI limit reached" : "Ask Kody..."}
                className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-3 text-base leading-6 text-[var(--qf-text)] outline-none placeholder:text-[var(--qf-text-muted)] sm:text-sm"
                disabled={loading || aiUsageLimitReached}
              />
              <IconButton
                type="submit"
                variant="kody"
                icon={<Send size={17} />}
                label="Send"
                loading={loading}
                disabled={!prompt.trim() || aiUsageLimitReached}
                className="rounded-xl"
              />
            </form>
            <span id="kody-prompt-instructions" className="sr-only">
              Press Enter to send. Press Shift and Enter for a new line.
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
        title={pendingActionCopy?.title ?? "Continue with Kody action?"}
        description={pendingActionCopy?.description}
        confirmLabel={pendingActionCopy?.confirmLabel ?? "Continue"}
        confirmVariant="kody"
      />
    </>
  );
}
