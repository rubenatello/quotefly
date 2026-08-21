import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../theme/theme-context";
import { Card } from "../ui";
import { cn } from "../../lib/utils";
import type { ThemePreference } from "../../lib/theme";
import { useTranslation } from "react-i18next";

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  labelKey: string;
  descriptionKey: string;
  icon: typeof Monitor;
}> = [
  {
    value: "system",
    labelKey: "settings.theme.system",
    descriptionKey: "settings.theme.systemDescription",
    icon: Monitor,
  },
  {
    value: "light",
    labelKey: "settings.theme.light",
    descriptionKey: "settings.theme.lightDescription",
    icon: Sun,
  },
  {
    value: "dark",
    labelKey: "settings.theme.dark",
    descriptionKey: "settings.theme.darkDescription",
    icon: Moon,
  },
];

export function ThemeSelector() {
  const { t } = useTranslation();
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <Card variant="elevated" padding="lg">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--qf-text)]">{t("settings.theme.title")}</p>
          <p className="mt-1 max-w-2xl text-sm text-[var(--qf-text-soft)]">
            {t("settings.theme.description")}
          </p>
        </div>
        <span
          className="inline-flex w-fit items-center rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-2.5 py-1 text-xs font-semibold capitalize text-[var(--qf-text-soft)]"
          aria-live="polite"
        >
          {t("settings.theme.current", { theme: t(`settings.theme.${resolvedTheme}`) })}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3" role="group" aria-label={t("settings.theme.group")}>
        {THEME_OPTIONS.map((option) => {
          const selected = preference === option.value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              data-testid={`theme-option-${option.value}`}
              onClick={() => setPreference(option.value)}
              className={cn(
                "relative flex min-h-[112px] items-start gap-3 rounded-2xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]",
                selected
                  ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] shadow-[var(--qf-shadow-sm)]"
                  : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] active:bg-[var(--qf-interactive-active)]",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                  selected
                    ? "border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]"
                    : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]",
                )}
                aria-hidden="true"
              >
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
                  {t(option.labelKey)}
                  {selected ? <Check size={15} className="text-[var(--qf-link)]" aria-hidden="true" /> : null}
                </span>
                <span className={cn("mt-1 block text-xs leading-5", selected ? "text-[var(--qf-text-soft)]" : "text-[var(--qf-text-muted)]")}>
                  {t(option.descriptionKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
