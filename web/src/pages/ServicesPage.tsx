import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  FileCheck2,
  ReceiptText,
  Search,
  ShieldCheck,
  Sparkles,
  Truck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
import { useMarketingReveal } from "../hooks/useMarketingReveal";
import { BASIC_PLAN_PRICING_PATH } from "../lib/plans";
import { setPublicSEOMetadata } from "../lib/seo";

interface ServicesPageProps {
  onOpenAuth: () => void;
}

type ProductCaptureKey = "kody-review" | "jobs-schedule" | "internal-invoice";

const WORKFLOW = [
  ["01", "Find or add the customer", "Search by name, phone, or email. Add a new customer without rebuilding the quote context.", UsersRound],
  ["02", "Draft and review the quote", "Use saved products and services as separate line items, or ask Kody for a structured first pass.", FileCheck2],
  ["03", "Carry accepted work into a Job", "An accepted quote becomes a numbered Job with the approved customer, scope, and price still connected.", BriefcaseBusiness],
  ["04", "Assign and schedule the visit", "Choose an active teammate, day, start time, duration, time zone, and field instructions.", CalendarDays],
  ["05", "Dispatch with deliberate controls", "Move eligible appointments through dispatch and field status changes after a person reviews the action.", Truck],
  ["06", "Record the internal invoice", "Create an operational invoice record from accepted or completed work for billing follow-through.", ReceiptText],
] as const;

const CAPABILITIES: Array<{
  title: string;
  description: string;
  bullets: string[];
  icon: LucideIcon;
}> = [
  {
    title: "Customer and follow-up workspace",
    description: "Keep contact details, notes, quotes, Jobs, and next actions tied to one customer record.",
    bullets: ["Fast customer intake", "Name, email, and phone search", "My Day and follow-up queues"],
    icon: Search,
  },
  {
    title: "Kody-assisted quote drafting",
    description: "Describe the trade, work, customer, time, and damage or inspection context in plain language.",
    bullets: ["Clarifies missing details", "Matches saved work and customer context", "Review-only draft handoff"],
    icon: Sparkles,
  },
  {
    title: "Scheduling and dispatch",
    description: "Keep accepted work, assigned teammates, appointment times, and field status visible together.",
    bullets: ["Day and week schedule", "Booking and rescheduling review", "In-app operational updates"],
    icon: CalendarDays,
  },
  {
    title: "Internal invoice records",
    description: "Track the billing record created from accepted quotes or completed Jobs without losing source context.",
    bullets: ["Customer total and balance", "Due date and source record", "Operational status history"],
    icon: ReceiptText,
  },
];

function ProductCapture({ capture, alt, eager = false }: { capture: ProductCaptureKey; alt: string; eager?: boolean }) {
  const desktop = `/images/product/${capture}-desktop-v1.webp`;
  const desktop2x = `/images/product/${capture}-desktop-v2.webp`;
  const mobile = `/images/product/${capture}-mobile-v1.webp`;
  const mobile2x = `/images/product/${capture}-mobile-v2.webp`;

  return (
    <picture className="mx-auto block max-w-[430px] sm:max-w-none">
      <source
        media="(max-width: 639px)"
        srcSet={`${mobile} 390w, ${mobile2x} 780w`}
        sizes="min(430px, calc(100vw - 48px))"
        width="390"
        height="844"
        type="image/webp"
      />
      <img
        src={desktop}
        srcSet={`${desktop} 1440w, ${desktop2x} 2880w`}
        sizes="(min-width: 1280px) 672px, (min-width: 640px) 52vw, calc(100vw - 48px)"
        alt={alt}
        width="1440"
        height="900"
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "low"}
        decoding="async"
        className="h-auto w-full rounded-[18px] border border-white/10 bg-white object-contain"
      />
    </picture>
  );
}

function ProductPanel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <figure className="overflow-hidden rounded-[26px] border border-slate-700 bg-slate-950 p-2 shadow-[0_26px_70px_rgba(15,23,42,0.22)] sm:p-3">
      <div className="flex min-h-11 items-center justify-between gap-3 px-2 pb-2 sm:px-3">
        <div aria-hidden="true" className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-quotefly-orange" />
          <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-600" />
        </div>
        <figcaption className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">{label} · actual product</figcaption>
      </div>
      {children}
    </figure>
  );
}

export function ServicesPage({ onOpenAuth }: ServicesPageProps) {
  useMarketingReveal();

  useEffect(() => {
    setPublicSEOMetadata("/services");
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-[#f7f4ee] text-slate-900">
      <section className="relative isolate overflow-hidden bg-slate-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-20" />
        <div aria-hidden="true" className="absolute -right-40 -top-28 -z-10 h-[30rem] w-[30rem] rounded-full bg-quotefly-orange/15 blur-3xl" />
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:gap-14">
          <div className="qf-page-enter">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-sm font-bold text-orange-200">
              <Sparkles size={16} aria-hidden="true" /> QuoteFly features
            </p>
            <h1 className="mt-6 text-4xl font-bold tracking-[-0.05em] text-white sm:text-5xl lg:text-[3.65rem] lg:leading-[1.02]">
              Customer management and quoting services in one simple app
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
              QuoteFly connects the customer, quote, accepted Job, schedule, dispatch status, and internal invoice record—without turning a small service business into a software project.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>Start free trial</MarketingAction>
              <MarketingAction href={BASIC_PLAN_PRICING_PATH} variant="dark-secondary">See Basic pricing</MarketingAction>
            </div>
            <p className="mt-6 flex items-start gap-2 text-sm leading-6 text-slate-300">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-blue-300" aria-hidden="true" />
              Kody prepares reviewable drafts and actions. QuoteFly does not autonomously book, dispatch, invoice, or send customer messages.
            </p>
          </div>
          <div className="qf-page-enter">
            <ProductPanel label="Kody quote review">
              <ProductCapture capture="kody-review" eager alt="Kody preparing a structured QuoteFly quote draft for human review with separate line items" />
            </ProductPanel>
          </div>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-24 border-b border-stone-200 bg-white px-4 py-14 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="services-workflow-heading">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="max-w-3xl">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--qf-brand-orange-text)]">One connected workflow</p>
            <h2 id="services-workflow-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">From customer request to billing follow-through</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">Each stage has a clear input, output, and review point. The customer and approved work stay connected instead of being entered again.</p>
          </div>
          <ol className="mt-10 grid gap-x-8 gap-y-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Customer to internal invoice workflow">
            {WORKFLOW.map(([number, title, description, Icon], index) => (
              <li key={number} data-marketing-reveal style={{ transitionDelay: `${index * 40}ms` }} className="flex gap-4 border-t border-slate-200 py-5">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-orange-200"><Icon size={20} aria-hidden="true" /></span>
                <div><p className="text-xs font-bold tracking-[0.16em] text-blue-700">{number}</p><h3 className="mt-1 font-bold text-slate-950">{title}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{description}</p></div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="px-4 py-14 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="product-proof-heading">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-800">Current product proof</p>
            <h2 id="product-proof-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">The field workflow, shown in the real interface</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">Sanitized fictional data is shown in deterministic mobile and desktop captures from the current QuoteFly workspace.</p>
          </div>
          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            <article data-marketing-reveal className="space-y-5">
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--qf-brand-orange-text)]">Schedule and field work</p><h3 className="mt-2 text-2xl font-bold text-slate-950">Know who is going, when, and what was approved.</h3><p className="mt-3 leading-7 text-slate-600">The day/week schedule and Job detail keep assignment, customer, scope, access instructions, and appointment status in reach.</p></div>
              <ProductPanel label="Job schedule"><ProductCapture capture="jobs-schedule" alt="QuoteFly day schedule showing booked visits, assigned teammates, customer addresses, and dispatch status" /></ProductPanel>
            </article>
            <article data-marketing-reveal className="space-y-5">
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--qf-brand-orange-text)]">Invoice and follow-through</p><h3 className="mt-2 text-2xl font-bold text-slate-950">Keep the source quote and Job attached to the billing record.</h3><p className="mt-3 leading-7 text-slate-600">The internal invoice record tracks totals, balance, due date, and operational status while notifications keep booking changes visible.</p></div>
              <ProductPanel label="Internal invoice"><ProductCapture capture="internal-invoice" alt="QuoteFly internal invoice record showing source Job, customer total, balance, due date, and payment-pending status" /></ProductPanel>
            </article>
          </div>
        </div>
      </section>

      <section className="border-y border-stone-200 bg-white px-4 py-14 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="capabilities-heading">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:gap-16">
            <div data-marketing-reveal>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-800">What is included now</p>
              <h2 id="capabilities-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">A focused toolkit for a small service business</h2>
              <p className="mt-4 text-lg leading-8 text-slate-600">Built for owners, office staff, and field workers who need the next action to be obvious on a phone or desktop.</p>
              <Link to="/solutions" className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 font-semibold text-quotefly-blue transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200">Explore trade workflows <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {CAPABILITIES.map((capability) => {
                const Icon = capability.icon;
                return (
                  <article key={capability.title} data-marketing-reveal className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-quotefly-orange text-slate-950"><Icon size={20} aria-hidden="true" /></span>
                    <h3 className="mt-4 text-lg font-bold text-slate-950">{capability.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{capability.description}</p>
                    <ul className="mt-4 space-y-2 text-sm text-slate-700">{capability.bullets.map((bullet) => <li key={bullet} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-blue-700" aria-hidden="true" /><span>{bullet}</span></li>)}</ul>
                  </article>
                );
              })}
            </div>
          </div>
          <aside data-marketing-reveal className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950 sm:p-6" aria-labelledby="service-boundaries-heading">
            <h2 id="service-boundaries-heading" className="font-bold">Current product boundaries</h2>
            <p className="mt-2">QuoteFly does not send customer invoices or collect payment from its internal invoice records. In-app notifications do not send customer email or text. QuoteFly does not currently claim autonomous booking, route optimization, or automatic QuickBooks reconciliation.</p>
          </aside>
        </div>
      </section>

      <MarketingCta title="Run one real customer-to-Job workflow." description="Use your own customer and scope, review the quote, then see how accepted work stays connected through scheduling and follow-through." actionLabel="Start free trial" onAction={onOpenAuth} supportingText={<span>Want the details first? <a href={BASIC_PLAN_PRICING_PATH} className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-white underline decoration-white/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30">See the Basic plan.</a></span>} />
    </div>
  );
}
