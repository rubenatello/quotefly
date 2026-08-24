import { useEffect } from "react";
import { ArrowRight, Check } from "lucide-react";
import { LandingKodyShowcase } from "../components/marketing/LandingKodyShowcase";
import { LandingProductDemo } from "../components/marketing/LandingProductDemo";
import { LandingProductShowcase } from "../components/marketing/LandingProductShowcase";
import { LandingTradeRail } from "../components/marketing/LandingTradeRail";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
import { useMarketingReveal } from "../hooks/useMarketingReveal";
import { LANDING_FAQS } from "../lib/landing-content";
import { BASIC_PLAN, basicFirstPaidMonthPriceLabel } from "../lib/plans";
import { setPublicSEOMetadata } from "../lib/seo";

interface LandingPageProps {
  onOpenAuth: () => void;
}

const WORKFLOW = [
  ["01", "Capture and price", "Find or add the customer, then build the scope, quantities, and customer price while the details are fresh."],
  ["02", "Review and share", "Check the customer-facing total and branded PDF before you create and share the quote."],
  ["03", "Turn yes into a Job", "Move an accepted quote into a numbered Job without re-entering the customer or approved scope."],
  ["04", "Assign and schedule", "Choose an active teammate, book the visit, and see scheduled work by day or week."],
  ["05", "Run the field visit", "Move eligible appointments through dispatch, arrival, and completion from the Jobs workspace."],
  ["06", "Record the invoice", "Create an internal invoice record from an accepted quote or completed Job and keep the next action visible."],
] as const;

export function LandingPage({ onOpenAuth }: LandingPageProps) {
  useMarketingReveal();

  useEffect(() => {
    setPublicSEOMetadata("/");
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-stone-50 text-slate-900">
      <section className="relative isolate overflow-hidden bg-slate-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-30" />
        <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--blue pointer-events-none absolute -left-28 top-10 -z-10 h-80 w-80 rounded-full bg-quotefly-blue/25 blur-3xl" />
        <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--orange pointer-events-none absolute -right-24 bottom-8 -z-10 h-72 w-72 rounded-full bg-quotefly-orange/20 blur-3xl" />
        <div className="mx-auto grid max-w-7xl items-center gap-9 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:gap-12">
          <div className="text-center lg:text-left">
            <div className="qf-hero-badge mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-sm font-semibold text-blue-200 shadow-sm backdrop-blur">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-quotefly-orange shadow-[0_0_16px_rgba(255,137,18,0.8)]" />
              Quoting software built for contractors
            </div>

            <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-[-0.05em] text-white sm:text-5xl lg:mx-0 lg:text-[3.8rem] lg:leading-[1.01]">
              Build the quote while the job is still fresh.
            </h1>

            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl lg:mx-0">
              Keep the customer, scope, pricing, branded PDF, Job, schedule, and internal invoice record in one practical workflow. Ask Kody for a useful first pass, then review before anything changes.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>
                Start your {BASIC_PLAN.trialDays}-day free trial
              </MarketingAction>
              <MarketingAction href="#product-story" variant="dark-secondary">
                See the quote-to-job workflow
              </MarketingAction>
            </div>

            <p className="mt-5 text-sm font-medium text-slate-300">
              No credit card · First paid month {basicFirstPaidMonthPriceLabel()} · Then ${BASIC_PLAN.monthlyPriceUsd}/month
            </p>
          </div>

          <LandingProductDemo />
        </div>
      </section>

      <section id="workflow" className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="grid gap-6 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-quotefly-blue">Less paperwork drift</p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-4xl">The job is clear. The paperwork gets scattered.</h2>
            </div>
            <p className="max-w-3xl text-lg leading-8 text-slate-600">
              QuoteFly keeps the practical steps connected, so a lead does not disappear between a phone call, a note, a spreadsheet, and an unfinished estimate.
            </p>
          </div>

          <ol aria-label="Quote to internal invoice workflow" className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {WORKFLOW.map(([step, title, description]) => (
              <li key={step} data-marketing-reveal className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
                <span className="text-xs font-bold tracking-[0.2em] text-[var(--qf-brand-orange-text)]">{step}</span>
                <h3 className="mt-4 text-xl font-bold text-slate-950">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <LandingProductShowcase onOpenAuth={onOpenAuth} />
      <LandingKodyShowcase onOpenAuth={onOpenAuth} />
      <LandingTradeRail />

      <section className="border-y border-slate-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="basic-plan-heading">
        <div className="mx-auto grid max-w-6xl gap-8 overflow-hidden rounded-[32px] border border-slate-200 bg-stone-50 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)] sm:p-10 lg:grid-cols-[1fr_0.9fr] lg:items-center">
          <div data-marketing-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-quotefly-blue">A simple place to start</p>
            <h2 id="basic-plan-heading" className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-4xl">Basic keeps the quote and the work that follows together.</h2>
            <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">
              Test QuoteFly with your own customers and job scopes for {BASIC_PLAN.trialDays} days. Review the workflow before deciding whether it belongs in your business.
            </p>
            <ul className="mt-7 grid gap-3 sm:grid-cols-2">
              {[
                `${BASIC_PLAN.teamMembers} included users`,
                `${BASIC_PLAN.quotesPerMonth} quotes each month`,
                `Branded PDFs and ${BASIC_PLAN.quoteHistoryDays}-day quote history`,
                "Jobs, day/week scheduling, and dispatch controls",
                "Kody drafting plus no-credit schedule review tools",
                "Internal invoice records without payment collection",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm font-medium text-slate-700">
                  <Check size={17} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div data-marketing-reveal="scale" className="rounded-3xl bg-slate-950 p-7 text-white shadow-[0_24px_54px_rgba(15,23,42,0.18)] sm:p-9">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-bold">Basic</p>
              <span className="rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900">Available now</span>
            </div>
            <p className="mt-7 flex items-end gap-2"><span className="text-5xl font-bold tracking-tight">${BASIC_PLAN.monthlyPriceUsd}</span><span className="pb-1 text-slate-400">/month</span></p>
            <p className="mt-3 text-sm leading-6 text-slate-300">Your first paid month is {basicFirstPaidMonthPriceLabel()} after the free trial. Then the standard monthly price applies.</p>
            <MarketingAction onClick={onOpenAuth} variant="orange" fullWidth className="mt-7">
              Start free for {BASIC_PLAN.trialDays} days
            </MarketingAction>
            <p className="mt-3 text-center text-xs text-slate-400">No credit card required to start.</p>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 lg:px-8" aria-labelledby="landing-faq-heading">
        <div className="mx-auto max-w-4xl">
          <div className="text-center">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-quotefly-blue">Straight answers</p>
            <h2 id="landing-faq-heading" className="mt-3 text-3xl font-bold text-slate-950 sm:text-4xl">Questions contractors ask before trying QuoteFly</h2>
          </div>
          <div className="mt-9 divide-y divide-slate-200 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            {LANDING_FAQS.map((faq) => (
              <details key={faq.q} className="group px-5 py-1 sm:px-7">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold text-slate-950 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-quotefly-blue/20 [&::-webkit-details-marker]:hidden">
                  {faq.q}
                  <span aria-hidden="true" className="text-xl font-normal text-quotefly-blue transition group-open:rotate-45">+</span>
                </summary>
                <p className="max-w-3xl pb-5 text-sm leading-7 text-slate-600">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta
        title="Keep the work moving before you leave the job."
        description={`Start free for ${BASIC_PLAN.trialDays} days. If QuoteFly fits, your first paid month is ${basicFirstPaidMonthPriceLabel()}, then $${BASIC_PLAN.monthlyPriceUsd}/month.`}
        actionLabel={`Start your ${BASIC_PLAN.trialDays}-day free trial`}
        onAction={onOpenAuth}
        supportingText="Kody helps with the first pass. You stay in control of the final quote."
      />
    </div>
  );
}
