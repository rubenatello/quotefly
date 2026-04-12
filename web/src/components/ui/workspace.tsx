import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface WorkspaceLink {
  id: string;
  label: string;
  hint?: string;
}

export function jumpToWorkspaceSection(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

export function WorkspaceJumpBar({
  links,
  className,
}: {
  links: WorkspaceLink[];
  className?: string;
}) {
  return (
    <div className={cn(className)}>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link, index) => (
          <button
            key={link.id}
            type="button"
            onClick={() => jumpToWorkspaceSection(link.id)}
            title={link.hint ?? link.label}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500">
              {index + 1}
            </span>
            <span className="font-semibold text-slate-900">{link.label}</span>
          </button>
        ))}
      </div>
    </div>
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
    <section id={id} className={cn("scroll-mt-28 space-y-2.5", className)}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-quotefly-blue">
            {step}
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{description}</p>
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
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-3.5", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{eyebrow}</p>
      <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
