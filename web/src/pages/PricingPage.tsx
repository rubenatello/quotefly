import { useEffect } from "react";
import {
  BadgeDollarSign,
  CalendarClock,
  Check,
  ChevronDown,
  CreditCard,
  FileCheck2,
  Route,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { CheckIcon } from "../components/Icons";
import { IntegrationRoadmapSection } from "../components/marketing/IntegrationRoadmapSection";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
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

const BASIC_FEATURES = [
  "Up to " + PUBLIC_BASIC_PLAN.quotesPerMonth + " quotes each month",
  PUBLIC_BASIC_PLAN.teamMembers + " users included",
  PUBLIC_BASIC_PLAN.quoteHistoryDays + "-day quote history",
  "Customer intake, reusable pricing, and branded PDF quotes",
  "Accepted-quote Jobs with day/week scheduling and dispatch controls",
  "Internal invoice records from accepted quotes or completed Jobs",
  "Kody AI usage budget plus deterministic schedule and review tools",
] as const;

const PRICING_TIMELINE = [
  {
    step: "01",
    label: "Try QuoteFly",
    price: "$0",
    detail: PUBLIC_BASIC_PLAN.trialDays + "-day free trial",
  },
  {
    step: "02",
    label: "First paid month",
    price: "$" + PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2),
    detail: PUBLIC_BASIC_PLAN.firstPaidMonthDiscountPercent + "% introductory discount",
  },
  {
    step: "03",
    label: "Then monthly",
    price: "$" + PUBLIC_BASIC_PLAN.monthlyPriceUsd,
    detail: "Cancel anytime",
  },
] as const;

const BASIC_CAPABILITY_MATRIX = [
  {
    icon: FileCheck2,
    capability: "Customers and quoting",
    included: "Customer intake, reusable pricing, branded PDFs, quote follow-up, and accepted-quote Job creation.",
    boundary: "Quotes stay editable and require human review before they are sent.",
  },
  {
    icon: UsersRound,
    capability: "Team access",
    included: PUBLIC_BASIC_PLAN.teamMembers + " users with owner, admin, and member roles.",
    boundary: "Members see only the customers, quotes, jobs, and follow-ups assigned to them.",
  },
  {
    icon: CalendarClock,
    capability: "Jobs and scheduling",
    included: "Day and week scheduling, crew assignment, dispatch controls, and quote-to-job handoff.",
    boundary: "QuoteFly calendar only; no external-calendar sync or route optimization.",
  },
  {
    icon: CreditCard,
    capability: "Internal invoicing",
    included: "Internal invoice records can be created from accepted quotes or completed Jobs.",
    boundary: "Basic does not send that invoice, collect payment, or create and reconcile a QuickBooks invoice.",
  },
  {
    icon: Sparkles,
    capability: "Kody assistance",
    included: "AI-assisted drafting plus deterministic schedule, task, catalog, navigation, and review tools.",
    boundary: "Kody requires human confirmation, and provider-backed AI pauses at the billing-cycle usage limit.",
  },
  {
    icon: Route,
    capability: "Quote history",
    included: PUBLIC_BASIC_PLAN.quoteHistoryDays + " days of quote history for active workspace follow-up.",
    boundary: "Longer historical reporting is not included in Basic today.",
  },
] as const;

const PRICING_FAQS = [
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
    a: "Yes. Every workspace starts with a " + PUBLIC_BASIC_PLAN.trialDays + "-day free trial with no credit card required, so you can test customer intake, quoting, Jobs, scheduling, and internal invoice records.",
  },
  {
    q: "How does the first-month discount work?",
    a: "If you choose Basic, the first paid month is $" + PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2) + " (" + PUBLIC_BASIC_PLAN.firstPaidMonthDiscountPercent + "% off). Basic is $" + PUBLIC_BASIC_PLAN.monthlyPriceUsd + "/month after that. The introductory discount applies once to an eligible workspace and is automatically added at checkout.",
  },
  {
    q: "Can I change plans later?",
    a: "Basic is the only plan available today. We will publish the eligibility, pricing, and billing behavior for any additional plan before customers can change to it.",
  },
    {
      q: "Do you support QuickBooks?",
      a: "Basic can create an internal QuoteFly invoice record and export reviewed accounting data through a QuickBooks-friendly CSV workflow. QuoteFly does not currently connect to QuickBooks Online, send that invoice, collect payment, or create and reconcile a QuickBooks invoice. Provider-backed workflows will stay unavailable until they are release-verified.",
  },
  {
    q: "How does AI usage work?",
    a: "AI is metered by usage, not by quotes sent. The app shows progress for the current billing cycle and warns at 25%, 50%, 75%, 85%, 95%, and 100%. At the billing-cycle limit, AI drafting and analysis pause until the next billing cycle. Kody's schedule, task, product-catalog, navigation, and review actions remain available, along with manual editing.",
  },
  {
    q: "Do you offer annual billing?",
    a: "Not yet. We are keeping V1 simple with monthly billing first.",
  },
] as const;

function PricingHero({ onOpenAuth }: PricingPageProps) {
  return (
    <section className="relative isolate overflow-hidden border-b border-blue-100 bg-[linear-gradient(135deg,#f8fbff_0%,#eef6ff_52%,#fff4e8_100%)] px-4 py-14 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
      <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-35" />
      <div aria-hidden="true" className="qf-marketing-orbit pointer-events-none absolute -left-24 -top-36 -z-10 h-80 w-80 rounded-full bg-blue-300/20 blur-3xl" />
      <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--orange pointer-events-none absolute -bottom-40 -right-24 -z-10 h-96 w-96 rounded-full bg-orange-300/25 blur-3xl" />

      <div className="qf-page-enter relative mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)] lg:gap-14">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/85 px-4 py-2 text-xs font-bold uppercase tracking-[0.14em] text-blue-800 shadow-sm backdrop-blur">
            <BadgeDollarSign size={16} aria-hidden="true" />
            Simple, honest pricing
          </span>
          <h1 className="mt-6 max-w-3xl text-4xl font-bold tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-6xl">
            Contractor quoting software pricing
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-700">
            Basic is the only plan available today: one practical workspace for customer intake, quotes, Jobs, scheduling, dispatch controls, and internal invoice records.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <MarketingAction onClick={onOpenAuth}>Start Free Trial</MarketingAction>
            <a
              href="#basic-plan"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-800 shadow-sm transition hover:border-blue-300 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200"
            >
              See everything in Basic
              <ChevronDown size={17} aria-hidden="true" />
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm font-semibold text-slate-700">
            <span className="inline-flex items-center gap-2">
              <Check size={17} className="text-blue-700" aria-hidden="true" />
              No credit card required
            </span>
            <span className="inline-flex items-center gap-2">
              <Check size={17} className="text-blue-700" aria-hidden="true" />
              Cancel anytime
            </span>
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={17} className="text-blue-700" aria-hidden="true" />
              Human-reviewed AI
            </span>
          </div>
        </div>

        <div className="relative">
          <div aria-hidden="true" className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-blue-300/25 via-transparent to-orange-300/25 blur-2xl" />
          <article className="relative overflow-hidden rounded-[2rem] border border-white/90 bg-white/92 p-5 shadow-[0_28px_80px_rgba(30,64,175,0.16)] backdrop-blur sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-800">Basic payment timeline</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Know exactly what you pay</h2>
              </div>
              <span className="rounded-full border border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] px-3 py-1.5 text-xs font-bold text-[var(--qf-brand-orange-contrast)]">
                Available now
              </span>
            </div>

            <ol className="relative mt-7 grid gap-3 sm:grid-cols-3">
              <div aria-hidden="true" className="absolute left-[16%] right-[16%] top-6 hidden h-px bg-gradient-to-r from-blue-300 via-blue-500 to-orange-300 sm:block" />
              {PRICING_TIMELINE.map((item, index) => (
                <li
                  key={item.step}
                  className={[
                    "relative rounded-2xl border p-4",
                    index === 1
                      ? "border-blue-300 bg-blue-50 shadow-[0_12px_28px_rgba(47,111,214,0.12)]"
                      : index === 2
                        ? "border-orange-200 bg-orange-50/70"
                        : "border-slate-200 bg-slate-50",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "relative z-10 inline-flex h-12 w-12 items-center justify-center rounded-full border-4 border-white text-xs font-black",
                      index === 2
                        ? "bg-[var(--qf-brand-orange)] text-[var(--qf-brand-orange-contrast)]"
                        : "bg-blue-800 text-white",
                    ].join(" ")}
                  >
                    {item.step}
                  </span>
                  <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-slate-600">{item.label}</p>
                  <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">{item.price}</p>
                  <p className="mt-1 text-sm leading-5 text-slate-600">{item.detail}</p>
                </li>
              ))}
            </ol>

            <div className="mt-5 grid grid-cols-3 divide-x divide-slate-200 rounded-2xl border border-slate-200 bg-slate-950 px-2 py-4 text-center text-white">
              <div className="px-2">
                <p className="text-lg font-black sm:text-xl">{PUBLIC_BASIC_PLAN.quotesPerMonth}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-300 sm:text-xs">Quotes / month</p>
              </div>
              <div className="px-2">
                <p className="text-lg font-black sm:text-xl">{PUBLIC_BASIC_PLAN.teamMembers}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-300 sm:text-xs">Users included</p>
              </div>
              <div className="px-2">
                <p className="text-lg font-black text-orange-300 sm:text-xl">Kody</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-300 sm:text-xs">AI assistance</p>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function BasicPlanSection({ onOpenAuth }: PricingPageProps) {
  const trustNotes = [
    { icon: ShieldCheck, title: "Role-aware access", detail: "Costs and margins stay restricted." },
    { icon: CalendarClock, title: "Schedule review", detail: "Kody suggests; your team confirms." },
    { icon: CreditCard, title: "No payment lock-in", detail: "Monthly billing. Cancel anytime." },
    { icon: Sparkles, title: "Honest boundaries", detail: "Planned tools are labeled before launch." },
  ] as const;

  return (
    <section id="basic-plan" className="scroll-mt-24 px-4 py-14 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="current-plan-heading">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-800">Current plan</p>
          <h2 id="current-plan-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
            One available plan, with the operational workflow included
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-700">
            Start with Basic now. Planned tiers are shown separately without publishing unverified prices or feature commitments.
          </p>
        </div>

        <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
          <article className="relative overflow-hidden rounded-[2rem] border border-blue-200 bg-white p-6 shadow-[0_24px_60px_rgba(30,64,175,0.12)] sm:p-8">
            <div aria-hidden="true" className="absolute inset-x-0 top-0 h-2 bg-gradient-to-r from-blue-700 via-blue-500 to-[var(--qf-brand-orange)]" />
            <div className="grid gap-8 xl:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.28fr)] xl:gap-10">
              <div className="xl:border-r xl:border-slate-200 xl:pr-9">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-3xl font-bold text-slate-950">Basic</h3>
                  <span className="rounded-full border border-[var(--qf-brand-orange)] bg-[var(--qf-brand-orange)] px-3 py-1.5 text-xs font-bold text-[var(--qf-brand-orange-contrast)]">
                    Available now
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-700">
                  For solo operators and lean crews that need to quote the work and keep the resulting Job moving.
                </p>
                <p className="mt-7 flex items-baseline gap-1">
                  <span className="text-6xl font-black tracking-tight text-slate-950">
                    {"$"}{PUBLIC_BASIC_PLAN.monthlyPriceUsd}
                  </span>
                  <span className="text-slate-700">/month</span>
                </p>
                <p className="mt-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-semibold leading-6 text-slate-800">
                  {PUBLIC_BASIC_PLAN.trialDays}-day free trial · first paid month {"$"}{PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}
                </p>
                <button
                  type="button"
                  onClick={onOpenAuth}
                  className="mt-6 min-h-12 w-full rounded-xl bg-blue-800 px-6 py-3 font-semibold text-white shadow-[0_12px_26px_rgba(30,64,175,0.22)] transition hover:-translate-y-0.5 hover:bg-blue-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-300"
                >
                  Start Free Trial
                </button>
                <p className="mt-3 text-center text-xs font-medium text-slate-500">No credit card required</p>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Everything available today</p>
                <ul className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {BASIC_FEATURES.map((feature) => (
                    <li key={feature} className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50">
                        <CheckIcon size={15} className="text-blue-800" />
                      </span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-7 grid gap-3 sm:grid-cols-2">
                  {trustNotes.map((item) => (
                    <div key={item.title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <item.icon size={18} className="text-blue-800" aria-hidden="true" />
                      <p className="mt-3 text-sm font-bold text-slate-950">{item.title}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">{item.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </article>

          <aside aria-labelledby="planned-plans-heading" className="rounded-[2rem] border border-slate-300 bg-slate-100/80 p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-600">Roadmap preview</p>
            <h3 id="planned-plans-heading" className="mt-2 text-xl font-bold text-slate-950">Planned plans</h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Names and direction only. Final pricing, limits, and features will be published before launch.
            </p>
            <div className="mt-5 space-y-3">
              {PLANNED_PLANS.map((plan) => (
                <article key={plan.name} className="rounded-2xl border border-slate-300 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="font-bold text-slate-950">{plan.name}</h4>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-600">
                      Planned
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{plan.description}</p>
                  <button
                    type="button"
                    disabled
                    className="mt-4 min-h-11 w-full cursor-not-allowed rounded-xl border border-slate-300 bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                  >
                    Coming Soon
                  </button>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function CapabilityMatrix() {
  return (
    <section className="border-y border-blue-100 bg-[#eef5ff] px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="capability-matrix-heading">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 lg:grid-cols-[minmax(260px,0.38fr)_minmax(0,0.62fr)] lg:gap-14">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-800">Capability guide</p>
            <h2 id="capability-matrix-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              What Basic includes—and where it stops
            </h2>
            <p className="mt-5 text-base leading-7 text-slate-700">
              A clear view of the working product and its current boundaries, so you can decide whether QuoteFly fits your business today.
            </p>
            <div className="mt-7 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
              <ShieldCheck size={22} className="text-blue-800" aria-hidden="true" />
              <p className="mt-3 font-bold text-slate-950">No feature bait-and-switch</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Basic is the only plan available today. Planned capabilities remain labeled until they are release-verified.
              </p>
            </div>
          </div>

          <div className="overflow-hidden rounded-[2rem] border border-blue-200 bg-white shadow-[0_20px_50px_rgba(30,64,175,0.08)]">
            <div className="hidden grid-cols-[minmax(190px,0.75fr)_minmax(0,1.25fr)_minmax(0,1fr)] border-b border-slate-200 bg-slate-950 px-5 py-4 text-xs font-bold uppercase tracking-[0.12em] text-white md:grid">
              <span>Capability</span>
              <span>Included in Basic</span>
              <span>Important boundary</span>
            </div>
            <div className="divide-y divide-slate-200">
              {BASIC_CAPABILITY_MATRIX.map((row) => (
                <article key={row.capability} className="grid gap-4 p-5 md:grid-cols-[minmax(190px,0.75fr)_minmax(0,1.25fr)_minmax(0,1fr)] md:gap-6">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-800">
                      <row.icon size={19} aria-hidden="true" />
                    </span>
                    <h3 className="pt-2 text-sm font-bold text-slate-950">{row.capability}</h3>
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-blue-800 md:hidden">Included in Basic</p>
                    <p className="text-sm leading-6 text-slate-700">{row.included}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-orange-800 md:hidden">Important boundary</p>
                    <p className="text-sm leading-6 text-slate-600">{row.boundary}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PricingFaqs() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="pricing-faq-heading">
      <div className="mx-auto max-w-5xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-800">Clear answers</p>
          <h2 id="pricing-faq-heading" className="mt-3 text-3xl font-bold text-slate-950 sm:text-4xl">Frequently asked questions</h2>
          <p className="mt-4 text-base leading-7 text-slate-700">Billing, permissions, AI usage, and current product boundaries—without the fine-print maze.</p>
        </div>

        <div className="mt-10 grid items-start gap-4 md:grid-cols-2">
          {PRICING_FAQS.map((faq, index) => (
            <details
              key={faq.q}
              open={index === 0}
              className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.045)] open:border-blue-200"
            >
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold text-slate-950 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-blue-200 [&::-webkit-details-marker]:hidden">
                <span>{faq.q}</span>
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-blue-800 transition group-open:rotate-180 group-open:bg-blue-50">
                  <ChevronDown size={17} aria-hidden="true" />
                </span>
              </summary>
              <div className="border-t border-slate-100 px-5 py-4">
                <p className="text-sm leading-6 text-slate-700">{faq.a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function PricingPage({ onOpenAuth }: PricingPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/pricing");
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-slate-900">
      <PricingHero onOpenAuth={onOpenAuth} />
      <BasicPlanSection onOpenAuth={onOpenAuth} />
      <CapabilityMatrix />
      <IntegrationRoadmapSection />
      <PricingFaqs />
      <MarketingCta
        title="Start with Basic"
        description={
          "No credit card required. Get full access for " +
          PUBLIC_BASIC_PLAN.trialDays +
          " days. If you continue, your first paid month is $" +
          PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2) +
          ", then $" +
          PUBLIC_BASIC_PLAN.monthlyPriceUsd +
          "/month."
        }
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
