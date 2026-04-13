import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Sparkles } from "lucide-react";
import type { ServiceType } from "../../lib/api";
import { Badge, Button, Modal, ModalBody, ModalHeader, ProgressBar, Select, Textarea } from "../ui";

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
      <ModalBody className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Customer context</p>
            {customerContextBadge ? <Badge tone="blue">{customerContextBadge}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-slate-600">{customerContextText}</p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-[color:rgba(47,111,214,0.05)] px-4 py-4">
            <ProgressBar value={progress} label="AI progress" hint={`${progress}%`} />
            <p className="mt-3 text-sm font-medium text-slate-800">{progressLabel}</p>
            <p className="mt-1 text-sm text-slate-600">
              QuoteFly is reading the prompt, matching saved jobs, and preparing the sheet for review.
            </p>
          </div>
        ) : null}

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
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
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              AI uses the customer, the current quote sheet, and saved jobs for this trade when that context is available.
            </div>
          </div>

          {canUseStarterPrompts ? (
            <div className="flex flex-wrap gap-2">
              {starterPrompts!.map((starter, index) => (
                <button
                  key={`${serviceType}-${index}`}
                  type="button"
                  onClick={() => onUseStarterPrompt?.(starter)}
                  disabled={loading}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {index === 0 ? "Use starter prompt" : "Alt prompt"}
                </button>
              ))}
            </div>
          ) : null}

          <Textarea
            label="Prompt"
            rows={7}
            placeholder="Add a permit fee, update the roof scope, and make the quote more customer-friendly."
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            disabled={loading}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-500">
              AI applies a suggested draft into the quote sheet. You still review every title, description, cost, and price.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" loading={loading} icon={<Sparkles size={14} />} disabled={disabled}>
                {submitLabel}
              </Button>
            </div>
          </div>
        </form>
      </ModalBody>
    </Modal>
  );
}
