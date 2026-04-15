import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, CircleDashed, LoaderCircle, Sparkles, UserRound } from "lucide-react";
import type { AiProgressEvent, ServiceType } from "../../lib/api";
import { Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader, ProgressBar, Select, Textarea } from "../ui";

const AI_PROGRESS_STAGES = [
  {
    step: "analyzing_prompt" as const,
    value: 18,
    label: "Reading prompt",
    detail: "Parsing scope, job type, and customer details from the request.",
  },
  {
    step: "loading_customer_context" as const,
    value: 36,
    label: "Loading customer context",
    detail: "Pulling customer notes, recent activity, and quote context when available.",
  },
  {
    step: "retrieving_workspace_context" as const,
    value: 58,
    label: "Matching saved jobs + similar quotes",
    detail: "Comparing saved jobs and past tenant quotes to anchor names, scope, and pricing.",
  },
  {
    step: "drafting_quote_patch" as const,
    value: 78,
    label: "Preparing line changes",
    detail: "Drafting adds, updates, and removals for the editable quote sheet.",
  },
  {
    step: "reviewing_line_changes" as const,
    value: 88,
    label: "Reviewing patch impact",
    detail: "Checking how many lines will be added, updated, or removed before applying the suggestion.",
  },
  {
    step: "finalizing_suggestion" as const,
    value: 92,
    label: "Applying the quote patch",
    detail: "Finalizing the suggestion so it can be reviewed line by line before save.",
  },
];

function buildPromptPlaceholder(serviceType: ServiceType, customerName?: string | null) {
  const lead = customerName?.trim() || "Alan Johnson";

  if (serviceType === "HVAC") {
    return [
      `Example: Quote for ${lead}. Add a priority work fee $75, major AC repair $1,500, and AC unit replacement $4,500 as separate lines.`,
      "",
      `Example: Revise this quote for ${lead}. Keep the repair line, then add a second high-efficiency heat pump replacement option (SEER2/HSPF2) with evaporator coil and thermostat setup.`,
    ].join("\n");
  }

  if (serviceType === "ROOFING") {
    return [
      `Example: New quote for ${lead}. Replace a 1,250 square foot asphalt shingle roof and include tear-off, disposal, underlayment, and installation as separate lines.`,
      "",
      "Example: Draft a Spanish tile roof quote at 20 roofing squares and include underlayment, flashing, and one optional deck repair allowance line.",
    ].join("\n");
  }

  if (serviceType === "PLUMBING") {
    return [
      `Example: Quote for ${lead}. Add one line for burst pipe repair and another line for drywall patch after access.`,
      "",
      "Example: Add separate lines for sewer camera + hydro-jet, plus an alternate trenchless repair line if the blockage persists.",
    ].join("\n");
  }

  if (serviceType === "FLOORING") {
    return [
      `Example: New quote for ${lead}. Install linoleum/LVT in two bathrooms and hallway with separate lines per area.`,
      "",
      "Example: Add separate prep lines for moisture barrier, subfloor leveling allowance, uncoupling membrane, and trim/transition finish.",
    ].join("\n");
  }

  if (serviceType === "GARDENING") {
    return [
      `Example: New quote for ${lead}. Add sod replacement, aeration + overseed, and irrigation controller setup by hydrozone as separate lines.`,
      "",
      "Example: Add pre-emergent + mulch refresh and optional drainage correction allowance if pooling persists.",
    ].join("\n");
  }

  return [
    `Example: New quote for ${lead}. Break the work into separate billable lines with price per line.`,
    "",
    "Example: If there is a fallback option or alternate scope, add it as another line instead of combining everything together.",
  ].join("\n");
}

export function QuoteAiPromptModal({
  open,
  onClose,
  serviceType,
  onServiceTypeChange,
  prompt,
  onPromptChange,
  starterPrompts,
  onUseStarterPrompt,
  customerContextText,
  customerContextName,
  customerContextDetails,
  customerContextBadge,
  usageHint,
  errorMessage,
  progressEvent,
  loading,
  disabled,
  onSubmit,
  title = "Draft quote with AI",
  description = "Generate the first version of the quote, then clean it up line by line in the editable sheet.",
  submitLabel = "Apply AI Suggestion",
}: {
  open: boolean;
  onClose: () => void;
  serviceType: ServiceType;
  onServiceTypeChange: (value: ServiceType) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  starterPrompts?: string[];
  onUseStarterPrompt?: (prompt: string) => void;
  customerContextText: string;
  customerContextName?: string | null;
  customerContextDetails?: string | null;
  customerContextBadge?: string | null;
  usageHint?: string | null;
  errorMessage?: string | null;
  progressEvent?: AiProgressEvent | null;
  loading?: boolean;
  disabled?: boolean;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  title?: string;
  description?: string;
  submitLabel?: string;
}) {
  const [progress, setProgress] = useState(0);
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Waiting to start");
  const [progressDetail, setProgressDetail] = useState("AI will prepare a tracked suggestion for the quote sheet.");

  useEffect(() => {
    if (!open || !loading) {
      setProgress(0);
      setProgressIndex(0);
      setProgressLabel("Waiting to start");
      setProgressDetail("AI will prepare a tracked suggestion for the quote sheet.");
      return;
    }

    setProgressIndex(0);
    setProgress(AI_PROGRESS_STAGES[0].value);
    setProgressLabel(AI_PROGRESS_STAGES[0].label);
    setProgressDetail(AI_PROGRESS_STAGES[0].detail);

    let index = 0;
    const interval = window.setInterval(() => {
      index += 1;
      if (index >= AI_PROGRESS_STAGES.length) {
        window.clearInterval(interval);
        return;
      }
      setProgressIndex(index);
      setProgress(AI_PROGRESS_STAGES[index].value);
      setProgressLabel(AI_PROGRESS_STAGES[index].label);
      setProgressDetail(AI_PROGRESS_STAGES[index].detail);
    }, 650);

    return () => window.clearInterval(interval);
  }, [open, loading]);

  const canUseStarterPrompts = useMemo(
    () => Boolean(starterPrompts?.length && onUseStarterPrompt),
    [onUseStarterPrompt, starterPrompts],
  );
  const hasAssignedCustomer = Boolean(customerContextName?.trim());
  const promptPlaceholder = useMemo(
    () => buildPromptPlaceholder(serviceType, customerContextName),
    [customerContextName, serviceType],
  );
  const activeProgress = progressEvent
    ? {
        value: progressEvent.value,
        label: progressEvent.label,
        detail: progressEvent.detail,
        index: Math.max(
          AI_PROGRESS_STAGES.findIndex((stage) => stage.step === progressEvent.step),
          0,
        ),
        sourceHints: progressEvent.sourceHints ?? [],
        patchCounts: progressEvent.patchCounts,
      }
    : {
        value: progress,
        label: progressLabel,
        detail: progressDetail,
        index: progressIndex,
        sourceHints: [] as string[],
        patchCounts: undefined as { added: number; updated: number; removed: number } | undefined,
      };

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} size="lg" ariaLabel={title}>
      <ModalHeader title={title} description={description} onClose={loading ? undefined : onClose} />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <ModalBody className="space-y-5 bg-[linear-gradient(180deg,rgba(47,111,214,0.035),rgba(255,255,255,0)_180px)] pb-4">
          <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-[color:rgba(242,140,40,0.12)] text-[var(--qf-brand-orange)]">
                  <Sparkles size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">AI drafting workspace</p>
                  <p className="mt-1 text-sm text-slate-700">
                    Use tenant context, saved jobs, customer activity, and similar quotes to prepare a faster first pass.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Badge tone="orange">Token-based AI meter</Badge>
                {usageHint ? <Badge tone="blue">{usageHint}</Badge> : null}
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px]">
            <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-[linear-gradient(135deg,rgba(47,111,214,0.08),rgba(255,255,255,0.98))] px-4 py-3.5 shadow-[0_10px_24px_rgba(47,111,214,0.05)]">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-quotefly-blue">Customer context</p>
                {customerContextBadge ? <Badge tone="blue">{customerContextBadge}</Badge> : null}
              </div>
              <div className="mt-2.5 flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-quotefly-blue/[0.12] text-quotefly-blue">
                  <UserRound size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-950">
                    {hasAssignedCustomer ? customerContextName : "No customer assigned yet"}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {hasAssignedCustomer ? customerContextDetails ?? customerContextText : customerContextText}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[color:rgba(242,140,40,0.18)] bg-[color:rgba(242,140,40,0.05)] px-4 py-3.5 shadow-[0_10px_24px_rgba(242,140,40,0.06)]">
              <Select
                label="Trade"
                value={serviceType}
                onChange={(event) => onServiceTypeChange(event.target.value as ServiceType)}
                options={[
                  { value: "HVAC", label: "HVAC" },
                  { value: "PLUMBING", label: "Plumbing" },
                  { value: "FLOORING", label: "Flooring" },
                  { value: "ROOFING", label: "Roofing" },
                  { value: "GARDENING", label: "Gardening" },
                  { value: "CONSTRUCTION", label: "Construction" },
                ]}
                disabled={loading}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.04)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Prompt</p>
                  <Badge tone="slate">Review before saving</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  AI uses the selected customer, customer notes, recent activity, current quote sheet, saved jobs, and similar past quotes for the chosen trade when available.
                </p>
              </div>
              {canUseStarterPrompts ? (
                <div className="grid grid-cols-2 gap-2 sm:min-w-[240px] sm:max-w-[280px]">
                  {starterPrompts!.map((starter, index) => (
                    <button
                      key={`${serviceType}-${index}`}
                      type="button"
                      onClick={() => onUseStarterPrompt?.(starter)}
                      disabled={loading}
                      className="min-h-[44px] rounded-xl border border-quotefly-blue/15 bg-quotefly-blue/[0.08] px-3 py-2 text-left text-xs font-semibold text-quotefly-blue transition hover:border-quotefly-blue/30 hover:bg-quotefly-blue/[0.14] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[36px]"
                    >
                      {index === 0 ? "Starter prompt" : `Alt ${index}`}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <Textarea
              className="mt-4 min-h-[260px] border-[color:rgba(47,111,214,0.16)] bg-[linear-gradient(180deg,rgba(47,111,214,0.03),rgba(255,255,255,0.96))] text-[15px] leading-7 text-quotefly-blue placeholder:text-quotefly-blue/45 caret-quotefly-blue shadow-inner selection:bg-quotefly-blue/15"
              rows={9}
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              disabled={loading}
            />
          </div>

          {loading ? (
            <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-[linear-gradient(135deg,rgba(47,111,214,0.08),rgba(242,140,40,0.06))] px-4 py-4 shadow-[0_10px_24px_rgba(47,111,214,0.05)]">
              <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="blue">AI working</Badge>
                    <Badge tone="orange">Tracked suggestion</Badge>
                  </div>
                  <div>
                    <p className="text-base font-semibold text-slate-900">{activeProgress.label}</p>
                    <p className="mt-1 text-sm text-slate-600">{activeProgress.detail}</p>
                  </div>
                  <ProgressBar value={activeProgress.value} label="AI progress" hint={`${activeProgress.value}%`} />
                  {activeProgress.sourceHints.length ? (
                    <div className="flex flex-wrap gap-2">
                      {activeProgress.sourceHints.map((hint) => (
                        <Badge key={hint} tone="slate">
                          {hint}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {activeProgress.patchCounts ? (
                    <div className="flex flex-wrap gap-2">
                      <Badge tone="orange">{activeProgress.patchCounts.updated} updated</Badge>
                      <Badge tone="blue">{activeProgress.patchCounts.added} added</Badge>
                      <Badge tone="slate">{activeProgress.patchCounts.removed} removed</Badge>
                    </div>
                  ) : null}
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    AI is building line-level changes for the quote sheet, not sending anything to the customer.
                  </p>
                </div>

                <div className="rounded-2xl border border-white/70 bg-white/70 px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)] backdrop-blur">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">AI run log</p>
                  <div className="mt-3 space-y-0">
                    {AI_PROGRESS_STAGES.map((stage, index) => {
                      const isComplete = index < activeProgress.index;
                      const isCurrent = index === activeProgress.index;
                      const isLast = index === AI_PROGRESS_STAGES.length - 1;

                      return (
                        <div key={stage.label} className="relative flex gap-3 pb-4 last:pb-0">
                          <div className="relative flex w-6 flex-col items-center">
                            <div
                              className={
                                isComplete
                                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white"
                                  : isCurrent
                                    ? "flex h-6 w-6 items-center justify-center rounded-full bg-[var(--qf-brand-orange)] text-white shadow-[0_6px_18px_rgba(242,140,40,0.24)]"
                                    : "flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400"
                              }
                            >
                              {isComplete ? (
                                <CheckCircle2 size={14} />
                              ) : isCurrent ? (
                                <LoaderCircle size={14} className="animate-spin" />
                              ) : (
                                <CircleDashed size={14} />
                              )}
                            </div>
                            {!isLast ? (
                              <span
                                className={
                                  isComplete
                                    ? "mt-1 h-full w-px bg-emerald-300"
                                    : "mt-1 h-full w-px bg-slate-200"
                                }
                              />
                            ) : null}
                          </div>
                          <div className="min-w-0 pt-0.5">
                            <p className={isCurrent ? "text-sm font-semibold text-slate-900" : "text-sm font-medium text-slate-700"}>
                              {stage.label}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-slate-500">{stage.detail}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}
        </ModalBody>

        <ModalFooter className="justify-between gap-3 border-t border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(47,111,214,0.03))]">
          <div className="max-w-[34rem] space-y-1">
            <p className="text-sm text-slate-500">
              AI builds the first draft only. You still review every line title, description, cost, and price before saving.
            </p>
            <p className="text-xs text-slate-500">
              AI usage is metered by token usage. Prompt usage varies based on context size and response length.
            </p>
            <p className="text-xs font-medium text-amber-700">
              AI can make mistakes. Please revise the quote before sending.
            </p>
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" loading={loading} icon={<Sparkles size={14} />} disabled={disabled}>
              {submitLabel}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
