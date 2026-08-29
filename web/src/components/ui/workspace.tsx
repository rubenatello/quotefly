import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface WorkspaceLink {
  id: string;
  label: string;
  hint?: string;
}

export function jumpToWorkspaceSection(id: string) {
  const section = document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  section?.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  section?.focus({ preventScroll: true });
}

export function WorkspaceJumpBar({
  links,
  className,
  activeId,
  ariaLabel,
  onSelect,
}: {
  links: WorkspaceLink[];
  className?: string;
  activeId?: string;
  ariaLabel?: string;
  onSelect?: (link: WorkspaceLink) => void;
}) {
  return (
    <nav className={cn(className)} aria-label={ariaLabel}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {links.map((link, index) => (
          <button
            key={link.id}
            type="button"
            onClick={() => onSelect ? onSelect(link) : jumpToWorkspaceSection(link.id)}
            title={link.hint ?? link.label}
            aria-current={activeId === link.id ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)] focus-visible:ring-offset-2 motion-reduce:transition-none",
              activeId === link.id
                ? "border-[var(--qf-primary)] bg-[var(--qf-primary-soft)] text-[var(--qf-text)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-panel-muted)]",
            )}
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-[11px] font-semibold text-[var(--qf-text-muted)]">
              {index + 1}
            </span>
            <span className="font-semibold text-[var(--qf-text)]">{link.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export function WorkspaceSection({
  id,
  step,
  title,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  step: string;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} tabIndex={-1} className={cn("scroll-mt-28 space-y-2.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)]", className)}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-link)]">
            {step}
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-[var(--qf-text)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function WorkspaceRailCard({
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3.5", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{eyebrow}</p>
      <h3 className="mt-2 text-lg font-semibold tracking-tight text-[var(--qf-text)]">{title}</h3>
      <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
