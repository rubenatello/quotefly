import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  ChevronDown,
  Clock3,
  FilePlus2,
  Search,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  UserRound,
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
import { formatAiUsageNotice } from "../../lib/ai-credits";
import { useTrack } from "../../lib/analytics";
import { cn } from "../../lib/utils";
import { Alert, Button, ConfirmModal, LoadingState, Textarea } from "../ui";
import { workspacePageFromPath, type WorkspacePage } from "../crm/workspace-navigation";
import { KodySparkIcon } from "./KodySparkIcon";
import { KODY_OPEN_EVENT, type KodyOpenDetail } from "./kody-events";
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
    tool: "DRAFT_QUOTE",
    label: "Draft quote",
    description: "Start with customer, job, and rough scope.",
    prompt: "Draft a quote for ",
    icon: <FilePlus2 size={15} />,
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
    if (tool === "DRAFT_PRODUCT") return "Preparing your product details...";
    if (tool === "DRAFT_QUOTE") return "Gathering quote details...";
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

function formatResultValue(key: string, value: string | number | boolean | null) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/amount|revenue|cost|profit|price|total/i.test(key)) {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
    }
    if (/percent|rate/i.test(key)) return `${value}%`;
    return value.toLocaleString();
  }
  if (/AtUtc$|Date$/i.test(key)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
  }
  return value;
}

function visibleResultEntries(result: Record<string, string | number | boolean | null>) {
  return Object.entries(result)
    .filter(([key]) => !/^(customerId|quoteId|quoteRefHash|id|tenantId)$/i.test(key))
    .slice(0, 6);
}

function resultTitle(result: Record<string, string | number | boolean | null>, fallback: string) {
  return (
    getString(result.fullName) ??
    getString(result.title) ??
    getString(result.serviceType) ??
    getString(result.item) ??
    getString(result.status) ??
    fallback
  );
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
}: {
  result: Record<string, string | number | boolean | null>;
  index: number;
}) {
  const entries = visibleResultEntries(result);
  return (
    <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 shadow-[var(--qf-shadow-sm)] transition hover:border-[var(--qf-info-border)] hover:shadow-[var(--qf-shadow-md)]">
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
              <dd className="min-w-0 text-right font-medium text-[var(--qf-text)]">{formatResultValue(key, value)}</dd>
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
}: {
  response: AiAssistantResponse["assistant"];
  usageNotice?: string;
  onAction: (action: AiAssistantAction) => void;
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
    <div className="space-y-3">
      <div className="space-y-3">
        {response.conversation.mode === "SHIFTED" && response.conversation.acknowledgement ? (
          <p
            className="mb-3 rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-3 py-2 text-sm leading-5 text-[var(--qf-text-soft)]"
            data-testid="kody-context-shift"
          >
            {response.conversation.acknowledgement}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text)]">
          {visibleAnswer || "Kody returned a response, but there was no answer text to show."}
        </p>

        {response.actions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {response.actions.slice(0, 3).map((action, index) => (
              <Button
                key={`${action.type}-${index}`}
                type="button"
                size="sm"
                variant={action.type === "REQUEST_ADMIN_ACCESS" ? "outline" : "primary"}
                onClick={() => onAction(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex min-h-11 flex-wrap items-center gap-2 border-t border-[var(--qf-border)] pt-3">
          <span className="mr-1 text-xs font-medium text-[var(--qf-text-muted)]">Helpful?</span>
          <button
            type="button"
            onClick={() => void submitFeedback("UP")}
            disabled={feedbackStatus === "saving" || response.auditEventId === "audit-unavailable"}
            aria-label="Good response"
            aria-pressed={feedback === "UP"}
            data-testid="kody-feedback-up"
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded-xl border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-50",
              feedback === "UP"
                ? "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)] hover:border-[var(--qf-success-border)] hover:bg-[var(--qf-success-surface)] hover:text-[var(--qf-success-text)]",
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
              "inline-flex h-11 w-11 items-center justify-center rounded-xl border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-50",
              feedback === "DOWN"
                ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)] hover:border-[var(--qf-warning-border)] hover:bg-[var(--qf-warning-surface)] hover:text-[var(--qf-warning-text)]",
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
            className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3"
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
          className="group rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2 shadow-[var(--qf-shadow-sm)]"
          data-testid="kody-results"
        >
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--qf-text)] marker:hidden">
            <span>View {response.results.length} {response.results.length === 1 ? "result" : "results"}</span>
            <ChevronDown
              size={16}
              className="text-[var(--qf-text-muted)] transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-2 grid gap-2 border-t border-[var(--qf-border)] pt-3">
            {response.results.slice(0, 4).map((result, index) => (
              <KodyResultCard key={`${response.auditEventId}-${index}`} result={result} index={index} />
            ))}
          </div>
        </details>
      ) : null}

      <details
        className="group rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-xs text-[var(--qf-text-soft)] shadow-[var(--qf-shadow-sm)]"
        data-testid="kody-data-guardrails"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[var(--qf-text-soft)] marker:hidden">
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
}: {
  currentPage?: WorkspacePage;
  canViewInternalCosts?: boolean;
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
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const pendingMessageIdRef = useRef<string | null>(null);
  const workspacePage = currentPage ?? workspacePageFromPath(location.pathname);
  const currentContextPage = assistantContextFromPage(workspacePage);
  const hasMobileActionDock = workspacePage === "build" || workspacePage === "quote-desk" || workspacePage === "branding";
  const visibleQuickPrompts = canViewInternalCosts
    ? QUICK_PROMPTS
    : QUICK_PROMPTS.filter((quickPrompt) => quickPrompt.tool !== "RANK_PROFITABLE_JOBS");

  const starterText = useMemo(() => {
    if (messages.length) return "Ask a follow-up in plain language. Kody will keep the recent conversation in mind.";
    return "Ask about customers, quotes, follow-ups, products, pipeline, or job profitability.";
  }, [messages.length]);

  const closeKody = useCallback((source: "button" | "keyboard") => {
    setOpen(false);
    track("kody_close", { source, page: currentContextPage });
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }, [currentContextPage, track]);

  useEffect(() => {
    const handleOpenKody = (event: Event) => {
      const detail = (event as CustomEvent<KodyOpenDetail>).detail;
      if (!detail || typeof detail.prompt !== "string") return;
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
    if (!open) return undefined;

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const activeElement = document.activeElement;
      if (activeElement && panelRef.current && !panelRef.current.contains(activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      closeKody("keyboard");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeKody, open]);

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
        behavior: messages.length > 2 ? "smooth" : "auto",
      });
    });
  }, [open, messages.length, loading]);

  async function submitPrompt(options?: { prompt?: string; tool?: AiAssistantTool | "AUTO" }) {
    const messageText = (options?.prompt ?? prompt).trim();
    if (!messageText || loading) return;
    const tool = options?.tool ?? selectedTool;
    const context = {
      ...(contextOverride ?? {}),
      currentPage: contextOverride?.currentPage ?? currentContextPage,
      limit: contextOverride?.limit ?? 8,
    };
    const conversation = recentConversation(messages);

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
      setSelectedTool("AUTO");
      setContextOverride(null);
    } catch (err) {
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
    setSelectedTool(quickPrompt.tool);
    setError(null);
    if (quickPrompt.submitImmediately) {
      void submitPrompt({ prompt: quickPrompt.prompt, tool: quickPrompt.tool });
      return;
    }
    setPrompt(quickPrompt.prompt);
    window.setTimeout(() => inputRef.current?.focus(), 0);
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
      if (!customerId) return;
      if (window.matchMedia("(max-width: 639px)").matches) {
        setOpen(false);
        track("kody_mobile_handoff_collapsed", { type: action.type });
      }
      navigate("/app/customers", { state: { kodyCustomerId: customerId } });
      return;
    }

    if (action.type === "OPEN_QUOTE_DRAFT") {
      navigate("/app/build", { state: { kodyQuoteDraft: action.payload } });
      return;
    }

    if (action.type === "OPEN_PRODUCT_DRAFT") {
      navigate("/app/products", { state: { kodyProductDraft: action.payload } });
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
            setOpen(true);
            track("kody_open", { page: currentContextPage });
          }}
          className={cn(
            "fixed right-[max(0.875rem,env(safe-area-inset-right))] z-[55] inline-flex h-[52px] min-h-[52px] items-center gap-2 rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-2.5 text-sm font-semibold text-[var(--qf-text)] shadow-[var(--qf-shadow-md)] transition hover:-translate-y-0.5 hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:px-3.5 lg:right-6",
            hasMobileActionDock
              ? "bottom-[calc(var(--qf-mobile-nav-clearance)+5.5rem)] lg:bottom-[7rem] xl:bottom-6"
              : "bottom-[calc(var(--qf-mobile-nav-clearance)+0.5rem)] lg:bottom-6",
          )}
          aria-label="Ask Kody"
          aria-expanded="false"
          data-testid="kody-launcher"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-white p-1 shadow-[0_6px_16px_rgba(47,111,214,0.24)]">
            <KodySparkIcon size={28} />
          </span>
          <span className="hidden sm:inline">Ask Kody</span>
        </button>
      ) : null}

      {open ? (
        <section
          ref={panelRef}
          aria-label="Kody assistant"
          aria-modal="false"
          role="dialog"
          data-testid="kody-chat-panel"
          className={cn(
            "qf-kody-chat-panel fixed z-[70] flex flex-col overflow-hidden rounded-[24px] border border-[var(--qf-border-strong)] bg-gradient-to-b from-[var(--qf-panel)] to-[var(--qf-panel-muted)] shadow-[var(--qf-shell-shadow)]",
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3 backdrop-blur sm:px-5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--qf-text)]">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--qf-border)] bg-white p-1 shadow-[var(--qf-shadow-sm)]">
                  <KodySparkIcon size={30} />
                </span>
                Kody
              </h2>
              <p className="mt-1 text-xs leading-5 text-[var(--qf-text-soft)]">Your QuoteFly workspace assistant.</p>
            </div>
            <button
              type="button"
              onClick={() => closeKody("button")}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--qf-border-strong)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)] transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
              aria-label="Close Kody"
            >
              <X size={18} />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 bg-[var(--qf-panel-muted)] p-3 sm:p-4">
          <details
            className="group shrink-0 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]"
            data-testid="kody-quick-prompts"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-semibold text-[var(--qf-text)] marker:hidden">
              <span>Try a prompt</span>
              <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--qf-text-muted)]">
                {visibleQuickPrompts.length} ideas
                <ChevronDown size={16} className="transition-transform group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="grid gap-2 border-t border-[var(--qf-border)] p-2 sm:grid-cols-2">
              {visibleQuickPrompts.map((quickPrompt) => (
                <button
                  key={quickPrompt.label}
                  type="button"
                  onClick={() => handleQuickPrompt(quickPrompt)}
                  disabled={loading}
                  data-testid={`kody-quick-${quickPrompt.tool.toLowerCase()}`}
                  className={cn(
                    "flex min-h-12 items-center gap-2 rounded-xl border bg-[var(--qf-panel)] px-3 py-2 text-left transition hover:border-[var(--qf-info-border)] hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-60",
                    selectedTool === quickPrompt.tool ? "border-[var(--qf-focus)] ring-2 ring-[var(--qf-focus-ring)]" : "border-[var(--qf-border)]",
                  )}
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]">
                    {quickPrompt.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[var(--qf-text)]">{quickPrompt.label}</span>
                    <span className="block truncate text-xs text-[var(--qf-text-muted)]">{quickPrompt.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </details>

          <div ref={conversationRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 shadow-inner sm:p-4">
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
                    "flex gap-2",
                    message.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {message.role === "kody" ? (
                    <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-white p-1 shadow-[var(--qf-shadow-sm)]">
                      <KodySparkIcon size={27} thinking={message.pending} />
                    </span>
                  ) : null}
                  <div
                    className={cn(
                      "max-w-[92%] rounded-3xl px-4 py-3 sm:max-w-[82%]",
                      message.pending
                        ? "w-full p-0 sm:max-w-[78%]"
                        : message.role === "user"
                          ? "bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]"
                          : "border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text)]",
                    )}
                  >
                    {message.pending ? (
                      <LoadingState
                        title={message.text}
                        description="Checking your workspace safely."
                        variant="compact"
                        className="border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]"
                      />
                    ) : message.response ? (
                      <KodyResponse response={message.response} usageNotice={message.usageNotice} onAction={handleAction} />
                    ) : (
                      <p className="text-sm leading-6">{message.text}</p>
                    )}
                  </div>
                  {message.role === "user" ? (
                    <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]">
                      <UserRound size={16} />
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}

          <form
            className="rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 shadow-[var(--qf-shadow-sm)]"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPrompt();
            }}
          >
            <Textarea
              ref={inputRef}
              data-testid="kody-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submitPrompt();
                }
              }}
              rows={2}
              label="Ask Kody"
              placeholder="Ask about a customer, quote, follow-up, product, or job..."
              className="min-h-[72px] resize-none"
              disabled={loading}
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-[var(--qf-text-muted)]">
                Review before saving or sending.
              </p>
              <Button type="submit" loading={loading} disabled={!prompt.trim()} icon={<Send size={14} />}>
                Send
              </Button>
            </div>
          </form>
          </div>
        </section>
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
        confirmVariant="primary"
      />
    </>
  );
}
