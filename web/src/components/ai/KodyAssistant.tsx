import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bot,
  CheckCircle2,
  FilePlus2,
  LockKeyhole,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRound,
} from "lucide-react";
import { ApiError, api, type AiAssistantAction, type AiAssistantResponse, type AiAssistantTool, type DataClassification } from "../../lib/api";
import { formatAiUsageNotice } from "../../lib/ai-credits";
import { useTrack } from "../../lib/analytics";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, LoadingState, Modal, ModalBody, ModalHeader, Textarea } from "../ui";
import { workspacePageFromPath, type WorkspacePage } from "../crm/workspace-navigation";
import { KODY_OPEN_EVENT, type KodyOpenDetail } from "./kody-events";

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

function elapsedSince(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1));
}

function kodyLoadingText(elapsedMs: number, tool: AiAssistantTool | "AUTO") {
  if (elapsedMs < 900) return "Checking approved workspace tools...";
  if (elapsedMs >= 8_000) return "Still working. AI and retrieval can take a few more seconds on larger workspaces.";
  if (elapsedMs >= 3_500) return "Preparing a cited answer and checking guardrails...";

  if (tool === "SEARCH_CUSTOMERS") return "Searching tenant-scoped customers and quote activity...";
  if (tool === "DRAFT_QUOTE") return "Loading allowed customer, product, and quote context...";
  if (tool === "SUMMARIZE_PIPELINE") return "Summarizing your tenant-scoped sales pipeline...";
  if (tool === "RANK_PROFITABLE_JOBS") return "Filtering profitability data to your role permissions...";

  return "Retrieving only the data Kody is allowed to use...";
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

function classificationTone(classification: string): "amber" | "blue" | "slate" | "emerald" {
  if (classification.startsWith("C3")) return "amber";
  if (classification.startsWith("C2")) return "blue";
  if (classification.startsWith("C1")) return "slate";
  return "emerald";
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

function compactAuditId(auditEventId: string) {
  return auditEventId.length > 10 ? auditEventId.slice(-10) : auditEventId;
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
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-quotefly-blue/25 hover:shadow-md">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-quotefly-blue/[0.08] text-[11px] font-bold text-quotefly-blue">
          {index + 1}
        </span>
        <p className="min-w-0 text-sm font-semibold text-slate-900">{resultTitle(result, `Result ${index + 1}`)}</p>
      </div>
      {entries.length ? (
        <dl className="mt-2 grid gap-1.5 text-xs text-slate-600">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-slate-500">{formatKey(key)}</dt>
              <dd className="min-w-0 text-right font-medium text-slate-800">{formatResultValue(key, value)}</dd>
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
  const meta = classificationMeta(response.maxClassification);
  return (
    <div className="space-y-3">
      <div className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone={classificationTone(response.maxClassification)}>
            {meta.label}
          </Badge>
          <Badge tone="slate" icon={<ShieldCheck size={12} />}>
            Tenant-scoped
          </Badge>
          <Badge tone="blue" icon={<CheckCircle2 size={12} />}>
            Cited answer
          </Badge>
        </div>
        <p className="text-sm leading-6 text-slate-700">{response.answer}</p>
      </div>

      {response.results.length ? (
        <div className="grid gap-2">
          {response.results.slice(0, 4).map((result, index) => (
            <KodyResultCard key={`${response.auditEventId}-${index}`} result={result} index={index} />
          ))}
        </div>
      ) : null}

      {response.actions.length ? (
        <div className="flex flex-wrap gap-2">
          {response.actions.slice(0, 4).map((action, index) => (
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

      <div
        className="rounded-2xl border border-quotefly-blue/15 bg-quotefly-blue/[0.04] px-3 py-2 text-xs text-slate-600"
        data-testid="kody-data-guardrails"
      >
        <div className="flex items-start gap-2">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-quotefly-blue" />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">Data guardrails</p>
            <p className="mt-1">{meta.description}</p>
          </div>
        </div>
        <dl className="mt-2 grid gap-1.5 sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-slate-500">Sources</dt>
            <dd className="mt-0.5 text-slate-700">{compactSourceList(response.citations)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Hidden</dt>
            <dd className="mt-0.5 text-slate-700">{compactHiddenList(response.fieldsExcluded)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Audit</dt>
            <dd className="mt-0.5 font-mono text-[11px] text-slate-700">#{compactAuditId(response.auditEventId)}</dd>
          </div>
        </dl>
        {usageNotice ? <p className="mt-1">{usageNotice}</p> : null}
        <p className="sr-only">Policy class {response.maxClassification}</p>
      </div>
    </div>
  );
}

export function KodyAssistant({ currentPage }: { currentPage?: WorkspacePage }) {
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const pendingMessageIdRef = useRef<string | null>(null);
  const workspacePage = currentPage ?? workspacePageFromPath(location.pathname);
  const currentContextPage = assistantContextFromPage(workspacePage);
  const hasMobileActionDock = workspacePage === "build" || workspacePage === "quote-desk" || workspacePage === "branding";

  const starterText = useMemo(() => {
    if (messages.length) return "Ask a follow-up or choose another Kody action.";
    return "Ask Kody to find customers, draft quotes, summarize pipeline, or rank profitable work.";
  }, [messages.length]);

  useEffect(() => {
    const handleOpenKody = (event: Event) => {
      const detail = (event as CustomEvent<KodyOpenDetail>).detail;
      if (!detail || typeof detail.prompt !== "string") return;
      setOpen(true);
      setError(null);
      setPrompt(detail.prompt);
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
      });
      track("kody_response", {
        tool,
        page: currentContextPage,
        ok: true,
        durationMs: elapsedSince(startedAt),
        resultCount: response.assistant.results.length,
        citationCount: response.assistant.citations.length,
        maxClassification: response.assistant.maxClassification,
      });
      setMessages((current) => {
        const replacement: KodyMessage = {
          id: pendingMessageId,
          role: "kody",
          text: response.assistant.answer,
          pending: false,
          response: response.assistant,
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

  function handleAction(action: AiAssistantAction) {
    track("kody_action", { type: action.type });
    if (action.type === "OPEN_CUSTOMER") {
      const customerId = getString(action.payload.customerId);
      if (!customerId) return;
      setOpen(false);
      navigate("/app/customers", { state: { kodyCustomerId: customerId } });
      return;
    }

    if (action.type === "OPEN_QUOTE_DRAFT") {
      setOpen(false);
      navigate("/app/build", { state: { kodyQuoteDraft: action.payload } });
      return;
    }

    if (action.type === "OPEN_ANALYTICS") {
      setOpen(false);
      navigate("/app/analytics", { state: { kodyInsight: action.payload } });
      return;
    }

    if (action.type === "REQUEST_ADMIN_ACCESS") {
      setOpen(false);
      navigate("/app/settings/users");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          track("kody_open", { page: currentContextPage });
        }}
        className={cn(
          "fixed right-[max(1rem,env(safe-area-inset-right))] z-[55] inline-flex h-[52px] min-h-[52px] items-center gap-2 rounded-2xl border border-quotefly-blue/20 bg-slate-950 px-4 text-sm font-semibold text-white shadow-[0_16px_36px_rgba(15,23,42,0.25)] transition hover:-translate-y-0.5 hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue lg:bottom-6 lg:right-6",
          hasMobileActionDock
            ? "bottom-[calc(var(--qf-mobile-nav-clearance)+5.5rem)]"
            : "bottom-[calc(var(--qf-mobile-nav-clearance)+0.75rem)]",
        )}
        aria-label="Ask Kody"
        data-testid="kody-launcher"
      >
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-quotefly-blue text-white">
          <Bot size={18} />
        </span>
        <span className="hidden sm:inline">Ask Kody</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="xl"
        ariaLabel="Kody assistant"
        panelClassName="h-[calc(100dvh-0.75rem)] border-quotefly-blue/10 bg-gradient-to-b from-white to-slate-50 sm:h-[min(88dvh,760px)]"
      >
        <ModalHeader
          title={
            <span className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-950 text-white">
                <Bot size={18} />
              </span>
              Kody
            </span>
          }
          description="QuoteFly assistant for customer lookup, quote drafting, pipeline, and profitability."
          className="bg-white/90 backdrop-blur"
          onClose={() => setOpen(false)}
        />
        <ModalBody className="flex flex-col gap-4 bg-slate-50">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {QUICK_PROMPTS.map((quickPrompt) => (
              <button
                key={quickPrompt.label}
                type="button"
                onClick={() => handleQuickPrompt(quickPrompt)}
                disabled={loading}
                data-testid={`kody-quick-${quickPrompt.tool.toLowerCase()}`}
                className={cn(
                  "rounded-2xl border bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-quotefly-blue/40 disabled:cursor-not-allowed disabled:opacity-60",
                  selectedTool === quickPrompt.tool ? "border-quotefly-blue ring-2 ring-quotefly-blue/10" : "border-slate-200",
                )}
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                  {quickPrompt.icon}
                </span>
                <span className="mt-2 block text-sm font-semibold text-slate-900">{quickPrompt.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-slate-500">{quickPrompt.description}</span>
              </button>
            ))}
          </div>

          <div ref={conversationRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-3xl border border-slate-200 bg-white p-3 shadow-inner sm:p-4">
            {!messages.length ? (
              <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                  <Sparkles size={22} />
                </span>
                <p className="mt-3 text-base font-semibold text-slate-900">What should Kody help with?</p>
                <p className="mt-1 max-w-md text-sm leading-6 text-slate-600">{starterText}</p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                  <LockKeyhole size={13} />
                  Backend-only AI. Tenant-scoped data.
                </div>
                <div className="mt-4 grid w-full max-w-xl gap-2 text-left sm:grid-cols-3">
                  {["Find customers due for follow-up", "Draft a quote from job notes", "Rank profitable jobs"].map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => {
                        setPrompt(example);
                        window.setTimeout(() => inputRef.current?.focus(), 0);
                      }}
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium leading-5 text-slate-600 shadow-sm transition hover:border-quotefly-blue/30 hover:text-slate-900"
                    >
                      {example}
                    </button>
                  ))}
                </div>
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
                    <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
                      <Bot size={16} />
                    </span>
                  ) : null}
                  <div
                    className={cn(
                      "max-w-[92%] rounded-3xl px-4 py-3 sm:max-w-[82%]",
                      message.pending
                        ? "w-full p-0 sm:max-w-[78%]"
                        : message.role === "user"
                          ? "bg-quotefly-blue text-white"
                          : "border border-slate-200 bg-slate-50 text-slate-800",
                    )}
                  >
                    {message.pending ? (
                      <LoadingState
                        title={message.text}
                        description="Backend-only AI. Tenant-scoped retrieval. No browser API key."
                        variant="compact"
                        className="border-quotefly-blue/20 bg-quotefly-blue/[0.04]"
                      />
                    ) : message.response ? (
                      <KodyResponse response={message.response} usageNotice={message.usageNotice} onAction={handleAction} />
                    ) : (
                      <p className="text-sm leading-6">{message.text}</p>
                    )}
                  </div>
                  {message.role === "user" ? (
                    <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-quotefly-blue/10 text-quotefly-blue">
                      <UserRound size={16} />
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}

          <form
            className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm"
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
              rows={3}
              label="Ask Kody"
              placeholder="Example: Draft a quote for Ruben, 20 squares asphalt shingle roof replacement, about $12,000."
              className="min-h-[88px] resize-none"
              disabled={loading}
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">
                Kody can suggest actions, but you review before creating, saving, or sending.
              </p>
              <Button type="submit" loading={loading} disabled={!prompt.trim()} icon={<Send size={14} />}>
                Send
              </Button>
            </div>
          </form>
        </ModalBody>
      </Modal>
    </>
  );
}
