import { Layers3, Sparkles } from "lucide-react";
import { Input } from "../ui";

export function QuoteLineSectionField({
  sectionType,
  sectionLabel,
  onSectionTypeChange,
  onSectionLabelChange,
  disabled,
  optionNameLabel = "Option name",
}: {
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel: string;
  onSectionTypeChange: (next: "INCLUDED" | "ALTERNATE") => void;
  onSectionLabelChange: (next: string) => void;
  disabled?: boolean;
  optionNameLabel?: string;
}) {
  const isAlternate = sectionType === "ALTERNATE";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSectionTypeChange("INCLUDED")}
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
            !isAlternate
              ? "border-quotefly-blue bg-quotefly-blue text-white shadow-[var(--qf-shadow-sm)]"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Layers3 size={12} />
          Included
        </button>
        <button
          type="button"
          onClick={() => onSectionTypeChange("ALTERNATE")}
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
            isAlternate
              ? "border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] text-white shadow-[var(--qf-shadow-sm)]"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Sparkles size={12} />
          Alternate
        </button>
      </div>

      {isAlternate ? (
        <div className="space-y-1">
          <Input
            label={optionNameLabel}
            placeholder="Option A • Replacement"
            value={sectionLabel}
            onChange={(event) => onSectionLabelChange(event.target.value)}
            disabled={disabled}
          />
          <p className="text-[11px] leading-5 text-slate-500">
            Give alternate lines the same option name to group them together in the customer quote.
          </p>
        </div>
      ) : null}
    </div>
  );
}
