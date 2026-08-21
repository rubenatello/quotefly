import { Layers3, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui";

export function QuoteLineSectionField({
  sectionType,
  sectionLabel,
  onSectionTypeChange,
  onSectionLabelChange,
  disabled,
  optionNameLabel,
  compact = false,
}: {
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel: string;
  onSectionTypeChange: (next: "INCLUDED" | "ALTERNATE") => void;
  onSectionLabelChange: (next: string) => void;
  disabled?: boolean;
  optionNameLabel?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const isAlternate = sectionType === "ALTERNATE";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSectionTypeChange("INCLUDED")}
          disabled={disabled}
          aria-pressed={!isAlternate}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${compact ? "min-h-[36px] py-1" : "min-h-[44px] py-2 sm:min-h-[36px] sm:py-1"} ${
            !isAlternate
              ? "border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] shadow-[var(--qf-shadow-sm)]"
              : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Layers3 size={12} />
          {compact ? <span className="2xl:hidden">{t("quoteComponents.line.includedShort")}</span> : null}
          <span className={compact ? "hidden 2xl:inline" : ""}>{t("quoteComponents.line.included")}</span>
        </button>
        <button
          type="button"
          onClick={() => onSectionTypeChange("ALTERNATE")}
          disabled={disabled}
          aria-pressed={isAlternate}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${compact ? "min-h-[36px] py-1" : "min-h-[44px] py-2 sm:min-h-[36px] sm:py-1"} ${
            isAlternate
              ? "border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] text-[var(--qf-brand-orange-contrast)] shadow-[var(--qf-shadow-sm)]"
              : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Sparkles size={12} />
          {compact ? <span className="2xl:hidden">{t("quoteComponents.line.alternateShort")}</span> : null}
          <span className={compact ? "hidden 2xl:inline" : ""}>{t("quoteComponents.line.alternate")}</span>
        </button>
      </div>

      {isAlternate ? (
        <div className="space-y-1">
          <Input
            label={optionNameLabel ?? t("quoteComponents.line.optionName")}
            placeholder={t("quoteComponents.line.optionPlaceholder")}
            value={sectionLabel}
            onChange={(event) => onSectionLabelChange(event.target.value)}
            disabled={disabled}
          />
          <p className="text-[11px] leading-5 text-[var(--qf-text-muted)]">
            {t("quoteComponents.line.optionHelp")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
