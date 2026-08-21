import { Languages } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocale, type SupportedLocale } from "../../i18n";
import { cn } from "../../lib/utils";

interface LanguageSelectorProps {
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  onPreferenceChange?: (locale: SupportedLocale) => Promise<void> | void;
}

export function LanguageSelector({ className, compact = false, disabled = false, onPreferenceChange }: LanguageSelectorProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const [saving, setSaving] = useState(false);

  async function selectLocale(nextLocale: SupportedLocale) {
    if (nextLocale === locale || disabled || saving) return;
    const previousLocale = locale;
    setSaving(true);
    try {
      await setLocale(nextLocale);
      await onPreferenceChange?.(nextLocale);
    } catch {
      // Account preferences are authoritative for signed-in users. Restore both
      // visible copy and qf_locale when persistence fails so reloads cannot drift.
      await setLocale(previousLocale);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)]", compact ? "p-2" : "p-4", className)}>
      {!compact ? (
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-info-surface)] text-[var(--qf-link)]">
            <Languages size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--qf-text)]">{t("language.label")}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{t("language.description")}</p>
          </div>
        </div>
      ) : null}
      <div role="group" aria-label={t("language.label")} className={cn("grid grid-cols-2 gap-2", compact ? "" : "mt-4")}>
        {(["en-US", "es-US"] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled || saving}
            aria-pressed={locale === option}
            onClick={() => void selectLocale(option)}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-xl border px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-60",
              locale === option
                ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-link)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)]",
            )}
          >
            {option === "en-US" ? t("language.english") : t("language.spanish")}
          </button>
        ))}
      </div>
    </div>
  );
}
