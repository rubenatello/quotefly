import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../theme/theme-context";
import { Card } from "../ui";
import { cn } from "../../lib/utils";
import type { ThemePreference } from "../../lib/theme";

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Monitor;
}> = [
  {
    value: "system",
    label: "System",
    description: "Match this device automatically.",
    icon: Monitor,
  },
  {
    value: "light",
    label: "Light",
    description: "Bright, crisp workspace surfaces.",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Lower-glare surfaces for night work.",
    icon: Moon,
  },
];

export function ThemeSelector() {
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <Card variant="elevated" padding="lg">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--qf-text)]">Choose your workspace look</p>
          <p className="mt-1 max-w-2xl text-sm text-[var(--qf-text-soft)]">
            This preference stays on this device. System mode follows your phone or computer as it changes.
          </p>
        </div>
        <span
          className="inline-flex w-fit items-center rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-2.5 py-1 text-xs font-semibold capitalize text-[var(--qf-text-soft)]"
          aria-live="polite"
        >
          Currently {resolvedTheme}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3" role="group" aria-label="Workspace color theme">
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
                "relative flex min-h-[112px] items-start gap-3 rounded-2xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue",
                selected
                  ? "border-quotefly-blue bg-quotefly-blue/[0.08] shadow-[var(--qf-shadow-sm)]"
                  : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-panel-muted)]",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                  selected
                    ? "border-quotefly-blue/20 bg-quotefly-blue text-white"
                    : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]",
                )}
                aria-hidden="true"
              >
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
                  {option.label}
                  {selected ? <Check size={15} className="text-quotefly-blue" aria-hidden="true" /> : null}
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--qf-text-muted)]">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
