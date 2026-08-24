import { useEffect } from "react";
import { BadgeDollarSign } from "lucide-react";
import { CheckIcon } from "../components/Icons";
import { MarketingCta, MarketingHero } from "../components/marketing/PublicPageLayout";
import { INFO_MAILTO } from "../lib/contact";
import { PUBLIC_BASIC_PLAN } from "../lib/public-seo-data";
import { setPublicSEOMetadata } from "../lib/seo";

interface PricingPageProps {
  onOpenAuth: () => void;
}

const PLANNED_PLANS = [
  {
    name: "Professional",
    description: "Planned for teams that need broader reporting, history, and accounting workflows.",
  },
  {
    name: "Enterprise",
    description: "Planned for larger operations that need additional integration controls and rollout support.",
  },
] as const;

export function PricingPage({ onOpenAuth }: PricingPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/pricing");
  }, []);

  const basicFeatures = [
    `Up to ${PUBLIC_BASIC_PLAN.quotesPerMonth} quotes each month`,
    `${PUBLIC_BASIC_PLAN.teamMembers} users included`,
    `${PUBLIC_BASIC_PLAN.quoteHistoryDays}-day quote history`,
    "Customer intake, reusable pricing, and branded PDF quotes",
    "Accepted-quote Jobs with day/week scheduling and dispatch controls",
    "Internal invoice records from accepted quotes or completed Jobs",
    "Kody AI usage budget plus deterministic schedule and review tools",
  ];

  const faqs = [
    {
      q: "What can each team role see?",
      a: "Owners and admins see the full workspace, product catalog, internal costs, and margins. Members work only with customers, follow-ups, jobs, and quotes assigned to them; internal costs and margins stay hidden.",
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes. There are no long-term contracts. Cancel anytime from your account billing settings.",
    },
    {
      q: "Is there a free trial?",
      a: `Yes. Every workspace starts with a ${PUBLIC_BASIC_PLAN.trialDays}-day free trial with no credit card required, so you can test customer intake, quoting, Jobs, scheduling, and internal invoice records.`,
    },
    {
      q: "How does the first-month discount work?",
      a: `If you choose Basic, the first paid month is $${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)} (${PUBLIC_BASIC_PLAN.firstPaidMonthDiscountPercent}% off). Basic is $${PUBLIC_BASIC_PLAN.monthlyPriceUsd}/month after that. The introductory discount applies once to an eligible workspace and is automatically added at checkout.`,
    },
    {
      q: "Can I change plans later?",
      a: "Basic is the only plan available today. We will publish the eligibility, pricing, and billing behavior for any additional plan before customers can change to it.",
    },
    {
      q: "Do you support QuickBooks?",
      a: "Basic can create an internal QuoteFly invoice record. It does not send that invoice, collect payment, or create and reconcile a QuickBooks invoice. Provider-backed invoicing and payments will stay unavailable until those workflows are release-verified.",
    },
    {
      q: "How does AI usage work?",
      a: "AI is metered by usage, not by quotes sent. The app shows progress for the current billing cycle and warns at 25%, 50%, 75%, 85%, 95%, and 100%. At the billing-cycle limit, AI drafting and analysis pause until the next billing cycle. Kody's schedule, task, product-catalog, navigation, and review actions remain available, along with manual editing.",
    },
    {
      q: "Do you offer annual billing?",
      a: "Not yet. We are keeping V1 simple with monthly billing first.",
    },
  ];

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-slate-900">
      <MarketingHero
        eyebrow="Simple, honest pricing"
        icon={BadgeDollarSign}
        title="Contractor quoting software pricing"
        description={
          <>
            Basic is the plan available today, with quoting, Jobs, scheduling, dispatch controls, and internal invoice records in one workspace.
          </>
        }
        actions={
          <>
            <span className="text-sm font-medium text-slate-700">Billed monthly</span>
            <span className="inline-flex items-center rounded-full border border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] px-4 py-2 text-xs font-bold text-[var(--qf-brand-orange-contrast)]">
              Basic · Available now
            </span>
          </>
        }
      />

      <section id="basic-plan" className="scroll-mt-24 px-4 py-14 sm:px-6 sm:py-16 lg:px-8" aria-labelledby="current-plan-heading">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-10 max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-800">Current plan</p>
            <h2 id="current-plan-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">One available plan, with the operational workflow included</h2>
            <p className="mt-4 text-base leading-7 text-slate-700">
              Start with Basic now. Planned tiers are shown separately without publishing unverified prices or feature commitments.
            </p>
          </div>

          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
            <article className="rounded-3xl border border-blue-300 bg-gradient-to-b from-blue-50 to-white p-6 shadow-[0_18px_46px_rgba(47,111,214,0.13)] sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-2xl font-bold text-slate-950">Basic</h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">For solo operators and lean crews that need to quote the work and keep the resulting Job moving.</p>
                </div>
                <span className="rounded-full border border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] px-3 py-1.5 text-xs font-bold text-[var(--qf-brand-orange-contrast)]">Available now</span>
              </div>

              <p className="mt-7 flex items-baseline gap-1">
                <span className="text-5xl font-bold tracking-tight text-slate-950">${PUBLIC_BASIC_PLAN.monthlyPriceUsd}</span>
                <span className="text-slate-700">/month</span>
              </p>
              <p className="mt-3 rounded-xl border border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] px-3 py-2 text-sm font-semibold text-[var(--qf-brand-orange-contrast)]">
                {PUBLIC_BASIC_PLAN.trialDays}-day free trial · first paid month ${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}
              </p>

              <button
                type="button"
                onClick={onOpenAuth}
                className="mt-6 min-h-12 w-full rounded-xl bg-blue-800 px-6 py-3 font-semibold text-white shadow-[0_10px_24px_rgba(30,64,175,0.2)] transition hover:-translate-y-0.5 hover:bg-blue-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-300"
              >
                Start Free Trial
              </button>

              <ul className="mt-8 grid gap-3 sm:grid-cols-2">
                {basicFeatures.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                    <CheckIcon size={16} className="mt-1 shrink-0 text-blue-800" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </article>

            <aside aria-labelledby="planned-plans-heading" className="rounded-3xl border border-slate-300 bg-slate-100 p-5 sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-700">Roadmap preview</p>
              <h3 id="planned-plans-heading" className="mt-2 text-xl font-bold text-slate-950">Planned plans</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">Names and direction only. Final pricing, limits, and features will be published before launch.</p>
              <div className="mt-5 space-y-3">
                {PLANNED_PLANS.map((plan) => (
                  <article key={plan.name} className="rounded-2xl border border-slate-300 bg-white p-4">
                    <h4 className="font-bold text-slate-950">{plan.name}</h4>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{plan.description}</p>
                    <button type="button" disabled className="mt-4 min-h-11 w-full cursor-not-allowed rounded-xl border border-slate-300 bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                      Coming Soon
                    </button>
                  </article>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8" aria-labelledby="pricing-faq-heading">
        <div className="mx-auto max-w-4xl">
          <h2 id="pricing-faq-heading" className="mb-12 text-center text-3xl font-bold text-slate-950">Frequently asked questions</h2>

          <div className="space-y-6">
            {faqs.map((faq) => (
              <div key={faq.q} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.045)]">
                <h3 className="mb-2 font-semibold text-slate-950">{faq.q}</h3>
                <p className="text-slate-700">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta
        title="Start with Basic"
        description={`No credit card required. Get full access for ${PUBLIC_BASIC_PLAN.trialDays} days. If you continue, your first paid month is $${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}, then $${PUBLIC_BASIC_PLAN.monthlyPriceUsd}/month.`}
        actionLabel="Start Free Trial"
        onAction={onOpenAuth}
        supportingText={
          <>
            Paid AI usage applies only when QuoteFly calls the AI provider. Deterministic schedule and review tools remain available without AI credits. Have a sales or plan question?{" "}
            <a href={INFO_MAILTO} className="font-semibold text-blue-300 hover:text-blue-200">
              Email our team
            </a>
            .
          </>
        }
      />
    </div>
  );
}
