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
    <div className={cn("overflow-x-auto", className)}>
      <div className="flex min-w-max gap-2 rounded-[24px] border border-slate-200 bg-white p-2 shadow-sm">
        {links.map((link, index) => (
          <button
            key={link.id}
            type="button"
            onClick={() => jumpToWorkspaceSection(link.id)}
            className="rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2 text-left transition hover:border-slate-300 hover:bg-white"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              {index + 1}
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{link.label}</p>
            {link.hint ? <p className="mt-0.5 text-xs text-slate-500">{link.hint}</p> : null}
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
    <section id={id} className={cn("scroll-mt-28 space-y-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-quotefly-blue">
            {step}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
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
    <div className={cn("rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{eyebrow}</p>
      <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
