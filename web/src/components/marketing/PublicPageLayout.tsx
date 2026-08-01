import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/utils";

type MarketingActionVariant = "primary" | "secondary" | "dark-secondary" | "light";

interface MarketingActionProps {
  children: ReactNode;
  variant?: MarketingActionVariant;
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  iconPosition?: "start" | "end";
  className?: string;
  fullWidth?: boolean;
  disabled?: boolean;
}

const MARKETING_ACTION_VARIANTS: Record<MarketingActionVariant, string> = {
  primary:
    "bg-quotefly-blue text-white shadow-[0_12px_28px_rgba(47,111,214,0.24)] hover:bg-blue-600 hover:shadow-[0_16px_34px_rgba(47,111,214,0.3)] focus-visible:ring-quotefly-blue/25",
  secondary:
    "border border-slate-300 bg-white/80 text-slate-800 hover:border-slate-400 hover:bg-white focus-visible:ring-slate-300/60",
  "dark-secondary":
    "border border-white/20 bg-white/[0.06] text-white hover:bg-white/[0.1] focus-visible:ring-white/25",
  light: "bg-white text-slate-950 hover:bg-slate-100 focus-visible:ring-white/30",
};

export function MarketingAction({
  children,
  variant = "primary",
  href,
  onClick,
  icon,
  iconPosition = "end",
  className,
  fullWidth = false,
  disabled = false,
}: MarketingActionProps) {
  const classes = cn(
    "group inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-7 py-3 font-semibold transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0",
    MARKETING_ACTION_VARIANTS[variant],
    fullWidth && "w-full",
    className,
  );
  const content = (
    <>
      {icon && iconPosition === "start" ? <span className="inline-flex">{icon}</span> : null}
      {children}
      {icon && iconPosition === "end" ? <span className="inline-flex transition-transform duration-200 group-hover:translate-x-0.5">{icon}</span> : null}
    </>
  );

  if (href) {
    return (
      <a href={href} className={classes}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={classes}>
      {content}
    </button>
  );
}

interface MarketingHeroProps {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  icon?: LucideIcon;
  meta?: ReactNode;
  actions?: ReactNode;
  width?: "standard" | "wide";
}

export function MarketingHero({
  eyebrow,
  title,
  description,
  icon: Icon,
  meta,
  actions,
  width = "standard",
}: MarketingHeroProps) {
  return (
    <section className="relative isolate overflow-hidden border-b border-stone-200 bg-gradient-to-b from-white to-[#f7f4ee] px-4 py-14 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
      <div aria-hidden="true" className="pointer-events-none absolute -left-28 top-8 -z-10 h-72 w-72 rounded-full bg-quotefly-blue/[0.09] blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-20 bottom-0 -z-10 h-64 w-64 rounded-full bg-quotefly-orange/[0.1] blur-3xl" />
      <div className={`qf-page-enter mx-auto text-center ${width === "wide" ? "max-w-5xl" : "max-w-4xl"}`}>
        <p className="qf-hero-badge inline-flex items-center gap-2 rounded-full border border-quotefly-blue/15 bg-white/80 px-4 py-2 text-sm font-bold text-quotefly-blue shadow-sm backdrop-blur">
          {Icon ? <Icon size={16} aria-hidden="true" /> : null}
          {eyebrow}
        </p>
        <h1 className="mx-auto mt-6 text-4xl font-bold tracking-[-0.045em] text-slate-950 sm:text-5xl lg:text-[3.5rem] lg:leading-[1.04]">
          {title}
        </h1>
        <div className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-slate-600 sm:text-xl">{description}</div>
        {meta ? <div className="mt-5 text-sm font-medium text-slate-500">{meta}</div> : null}
        {actions ? <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">{actions}</div> : null}
      </div>
    </section>
  );
}

interface MarketingCtaProps {
  title: ReactNode;
  description: ReactNode;
  actionLabel: string;
  onAction: () => void;
  supportingText?: ReactNode;
}

export function MarketingCta({ title, description, actionLabel, onAction, supportingText }: MarketingCtaProps) {
  return (
    <section className="border-t border-stone-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="qf-page-enter relative mx-auto max-w-5xl overflow-hidden rounded-[30px] bg-slate-950 px-6 py-12 text-center text-white shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:px-12">
        <div aria-hidden="true" className="absolute -left-16 -top-20 h-56 w-56 rounded-full bg-quotefly-blue/30 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-24 -right-12 h-56 w-56 rounded-full bg-quotefly-orange/25 blur-3xl" />
        <h2 className="relative mx-auto max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
        <div className="relative mx-auto mt-4 max-w-2xl text-lg leading-8 text-slate-300">{description}</div>
        <MarketingAction
          onClick={onAction}
          variant="light"
          className="relative mt-8 px-8"
          icon={<ArrowRight size={18} aria-hidden="true" />}
        >
          {actionLabel}
        </MarketingAction>
        {supportingText ? <div className="relative mt-5 text-sm text-slate-400">{supportingText}</div> : null}
      </div>
    </section>
  );
}

interface PolicyPageLayoutProps {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  updated: string;
  icon?: LucideIcon;
  children: ReactNode;
}

export function PolicyPageLayout({ eyebrow, title, description, updated, icon, children }: PolicyPageLayoutProps) {
  return (
    <div className="min-h-screen bg-[#f7f4ee] text-slate-900">
      <MarketingHero
        eyebrow={eyebrow}
        title={title}
        description={description}
        meta={`Last updated: ${updated}`}
        icon={icon}
      />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">{children}</div>
    </div>
  );
}

interface PolicySectionProps {
  title: ReactNode;
  children: ReactNode;
  tone?: "default" | "accent";
}

export function PolicySection({ title, children, tone = "default" }: PolicySectionProps) {
  return (
    <section
      className={`rounded-3xl border p-6 shadow-[0_10px_30px_rgba(15,23,42,0.045)] sm:p-8 ${
        tone === "accent" ? "border-blue-200 bg-gradient-to-br from-blue-50 to-white" : "border-slate-200 bg-white"
      }`}
    >
      <h2 className="text-2xl font-bold tracking-tight text-slate-950">{title}</h2>
      {children}
    </section>
  );
}
