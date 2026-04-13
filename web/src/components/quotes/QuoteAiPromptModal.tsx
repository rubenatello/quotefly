import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Sparkles } from "lucide-react";
import type { ServiceType } from "../../lib/api";
import { Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader, ProgressBar, Select, Textarea } from "../ui";

const AI_PROGRESS_STAGES = [
  { value: 18, label: "Reading prompt" },
  { value: 36, label: "Loading customer context" },
  { value: 58, label: "Matching saved jobs" },
  { value: 78, label: "Drafting quote lines" },
  { value: 92, label: "Applying to the quote sheet" },
];

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
  customerContextBadge,
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
  customerContextBadge?: string | null;
  loading?: boolean;
  disabled?: boolean;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  title?: string;
  description?: string;
  submitLabel?: string;
}) {
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Waiting to start");

  useEffect(() => {
    if (!open || !loading) {
      setProgress(0);
      setProgressLabel("Waiting to start");
      return;
    }

    setProgress(AI_PROGRESS_STAGES[0].value);
    setProgressLabel(AI_PROGRESS_STAGES[0].label);

    let index = 0;
    const interval = window.setInterval(() => {
      index += 1;
      if (index >= AI_PROGRESS_STAGES.length) {
        window.clearInterval(interval);
        return;
      }
      setProgress(AI_PROGRESS_STAGES[index].value);
      setProgressLabel(AI_PROGRESS_STAGES[index].label);
    }, 650);

    return () => window.clearInterval(interval);
  }, [open, loading]);

  const canUseStarterPrompts = useMemo(
    () => Boolean(starterPrompts?.length && onUseStarterPrompt),
    [onUseStarterPrompt, starterPrompts],
  );

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} size="lg" ariaLabel={title}>
      <ModalHeader title={title} description={description} onClose={loading ? undefined : onClose} />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <ModalBody className="space-y-5 pb-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_190px]">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer context</p>
                {customerContextBadge ? <Badge tone="blue">{customerContextBadge}</Badge> : null}
              </div>
              <p className="mt-1.5 text-sm leading-6 text-slate-700">{customerContextText}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5">
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

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Prompt</p>
                <p className="mt-1 text-sm text-slate-600">
                  AI uses the selected customer, current quote sheet, and saved jobs for the chosen trade when available.
                </p>
              </div>
              {canUseStarterPrompts ? (
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {starterPrompts!.map((starter, index) => (
                    <button
                      key={`${serviceType}-${index}`}
                      type="button"
                      onClick={() => onUseStarterPrompt?.(starter)}
                      disabled={loading}
                      className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {index === 0 ? "Starter prompt" : `Alt ${index}`}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <Textarea
              className="mt-4 min-h-[260px] text-[15px] leading-7"
              rows={9}
              placeholder="New quote for Alan Johnson 818-233-4333. Replace a 1,250 square foot asphalt shingle roof and include tear-off, disposal, underlayment, and installation."
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              disabled={loading}
            />
          </div>

          {loading ? (
            <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-[color:rgba(47,111,214,0.05)] px-4 py-4">
              <ProgressBar value={progress} label="AI progress" hint={`${progress}%`} />
              <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-slate-800">{progressLabel}</p>
                <p className="text-sm text-slate-600">Reading prompt, matching saved jobs, and preparing the quote sheet.</p>
              </div>
            </div>
          ) : null}
        </ModalBody>

        <ModalFooter className="justify-between gap-3">
          <div className="max-w-[34rem] space-y-1">
            <p className="text-sm text-slate-500">
              AI builds the first draft only. You still review every line title, description, cost, and price before saving.
            </p>
            <p className="text-xs text-slate-500">
              Each AI prompt uses 1 AI credit, whether you are drafting a new quote or revising an existing one.
            </p>
            <p className="text-xs font-medium text-amber-700">
              AI can make mistakes. Please revise the quote before sending.
            </p>
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} icon={<Sparkles size={14} />} disabled={disabled}>
              {submitLabel}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
