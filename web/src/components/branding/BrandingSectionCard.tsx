import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface BrandingSummaryTileProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function BrandingSummaryTile({ label, children, className }: BrandingSummaryTileProps) {
  return (
    <div className={cn("rounded-[20px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export interface BrandingSectionCardProps {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  isOpen: boolean;
  completionLabel?: string;
  onToggle: () => void;
  children: ReactNode;
}

export function BrandingSectionCard({
  id,
  title,
  description,
  icon: Icon,
  isOpen,
  completionLabel,
  onToggle,
  children,
}: BrandingSectionCardProps) {
  return (
    <section
      id={id}
      className="scroll-mt-24 overflow-hidden rounded-[28px] border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--qf-focus)] sm:px-6"
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-quotefly-primary">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold text-slate-900">{title}</h2>
              {completionLabel ? (
                <span className="rounded-full bg-quotefly-blue/[0.08] px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--qf-link)]">
                  {completionLabel}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          </div>
        </div>
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-slate-500">
          <ChevronDown size={18} className={cn("transition-transform", isOpen && "rotate-180")} />
        </div>
      </button>

      {isOpen ? <div className="border-t border-[var(--qf-border)] px-5 py-5 sm:px-6">{children}</div> : null}
    </section>
  );
}
