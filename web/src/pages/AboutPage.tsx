import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  FileCheck2,
  MessageSquareQuote,
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

interface AboutPageProps {
  onOpenAuth: () => void;
}

type WorkflowStage = {
  number: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

const HERO_STAGES: Array<{ label: string; icon: LucideIcon }> = [
  { label: "Customer", icon: UsersRound },
  { label: "Quote", icon: FileCheck2 },
  { label: "Job", icon: BriefcaseBusiness },
  { label: "Dispatch", icon: Truck },
];

const WORKFLOW_STAGES: WorkflowStage[] = [
  {
    number: "01",
    title: "Customer",
    description: "Find a customer by name, email, or phone, or add a new record without leaving the workflow.",
    icon: UsersRound,
  },
  {
    number: "02",
    title: "Quote",
    description: "Build labor, materials, products, and services into separate line items, then review the customer-facing price.",
    icon: FileCheck2,
  },
  {
    number: "03",
    title: "Job",
    description: "Turn accepted work into a numbered Job while carrying the customer and approved scope forward.",
    icon: BriefcaseBusiness,
  },
  {
    number: "04",
    title: "Dispatch",
    description: "Assign an active teammate, schedule the visit, and move eligible appointments through field status changes.",
    icon: CalendarDays,
  },
  {
    number: "05",
    title: "Invoice record",
    description: "Create an internal invoice record from an accepted quote or completed Job for operational follow-through.",
    icon: ReceiptText,
  },
];

const PRINCIPLES: Array<{ title: string; description: string; icon: LucideIcon }> = [
  {
    title: "Field speed",
    description: "The next action should be obvious on a phone, with fewer handoffs and less information entered twice.",
    icon: Search,
  },
  {
    title: "Human control",
    description: "Kody can prepare a first pass, but you review the customer, scope, price, schedule, and anything sent outside QuoteFly.",
    icon: ShieldCheck,
  },
  {
    title: "Honest boundaries",
    description: "Customer-visible prices stay separate from internal cost, and roadmap ideas are not presented as finished features.",
    icon: Check,
  },
];

const DIRECT_ANSWERS = [
  {
    question: "What is QuoteFly?",
    answer:
      "QuoteFly is web-based contractor operations software that connects customer records, quotes, accepted-quote Jobs, day and week scheduling, dispatch status, and internal invoice records.",
  },
  {
    question: "Who is QuoteFly for?",
    answer:
      "QuoteFly is designed for solo operators, owner-operators, and small service teams that need a practical workflow without the overhead of a large field-service platform.",
  },
  {
    question: "What does Kody do?",
    answer:
      "Kody helps draft and review work inside QuoteFly. It can turn a natural-language request into a structured starting point, surface customer or work-item matches, and ask for clarification when important details are missing. A person reviews the result before using it.",
  },
  {
    question: "What are the current product boundaries?",
    answer:
      "QuoteFly does not claim autonomous booking or sending, route optimization, customer payment collection, or automatic QuickBooks reconciliation. Internal invoice records are for operations; they are not customer invoices and do not collect payment.",
  },
];

export function AboutPage({ onOpenAuth }: AboutPageProps) {
  useMarketingReveal();

  useEffect(() => {
    setPublicSEOMetadata("/about");
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-[#f7f4ee] text-slate-900">
      <section className="relative isolate overflow-hidden bg-slate-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-20" />
        <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--blue pointer-events-none absolute -left-36 -top-20 -z-10 h-96 w-96 rounded-full bg-quotefly-blue/25 blur-3xl" />
        <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--orange pointer-events-none absolute -bottom-28 -right-24 -z-10 h-96 w-96 rounded-full bg-quotefly-orange/20 blur-3xl" />

        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-16">
          <div className="qf-page-enter text-center lg:text-left">
            <p className="qf-hero-badge inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-sm font-bold text-orange-200 backdrop-blur">
              <Sparkles size={16} aria-hidden="true" />
              The QuoteFly mission
            </p>
            <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-[-0.05em] text-white sm:text-5xl lg:mx-0 lg:text-[3.65rem] lg:leading-[1.02]">
              We are building the easiest way to quote, manage customers, and dispatch work.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl lg:mx-0">
              QuoteFly is lightweight quoting, customer management, job scheduling, and dispatch software for solo contractors and small service teams.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <MarketingAction
                onClick={onOpenAuth}
                variant="orange"
                icon={<ArrowRight size={18} aria-hidden="true" />}
              >
                Start free trial
              </MarketingAction>
              <MarketingAction href="/solutions#workflow" variant="dark-secondary">
                See how QuoteFly works
              </MarketingAction>
            </div>

            <div className="mt-7 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-slate-300 lg:justify-start">
              {["Built for field use", "Human-reviewed AI", "Clear product boundaries"].map((item) => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <Check size={15} className="text-quotefly-orange" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <figure className="qf-page-enter relative mx-auto min-h-[500px] w-full max-w-[680px] overflow-hidden rounded-[32px] border border-white/15 bg-slate-900 shadow-[0_36px_100px_rgba(0,0,0,0.42)] sm:min-h-[610px]">
            <img
              src="/images/solutions/construction-silhouette.jpg"
              alt="Construction professional at work against an evening sky"
              width="1600"
              height="1067"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-[58%_center] opacity-70"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-slate-950/25 via-slate-950/15 to-slate-950/90" />

            <div className="qf-about-proof-float absolute -right-7 top-9 w-[54%] min-w-[220px] rotate-1 overflow-hidden rounded-[26px] border border-white/20 bg-white p-2 shadow-[0_30px_80px_rgba(0,0,0,0.44)] sm:right-7 sm:top-12 sm:w-[48%]">
              <img
                src="/images/product/job-detail-mobile-v1.webp"
                alt="QuoteFly mobile Job detail showing customer, schedule, and dispatch information"
                width="390"
                height="844"
                loading="eager"
                decoding="async"
                className="h-auto w-full rounded-[20px]"
              />
            </div>

            <div className="absolute inset-x-4 bottom-4 rounded-[24px] border border-white/15 bg-slate-950/88 p-4 shadow-2xl backdrop-blur-xl sm:inset-x-7 sm:bottom-7 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-200">One connected record</p>
                  <p className="mt-1 font-semibold text-white">From first call to finished work</p>
                </div>
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-quotefly-orange text-slate-950">
                  <MessageSquareQuote size={20} aria-hidden="true" />
                </span>
              </div>
              <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="QuoteFly customer-to-dispatch workflow">
                {HERO_STAGES.map((stage, index) => {
                  const StageIcon = stage.icon;
                  return (
                    <li key={stage.label} className="relative rounded-xl border border-white/10 bg-white/[0.06] px-3 py-3 text-center">
                      <StageIcon size={18} className="mx-auto text-blue-200" aria-hidden="true" />
                      <span className="mt-1.5 block text-xs font-semibold text-white">{stage.label}</span>
                      {index < HERO_STAGES.length - 1 ? (
                        <ArrowRight size={13} className="absolute -right-2.5 top-5 hidden text-orange-200 sm:block" aria-hidden="true" />
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
            <figcaption className="sr-only">
              Photo by Jason Richard. The overlaid screen is an actual QuoteFly Job detail capture using sanitized fictional data.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="border-b border-stone-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="what-is-quotefly-heading">
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)] lg:gap-16">
          <div data-marketing-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--qf-brand-orange-text)]">A direct answer</p>
            <h2 id="what-is-quotefly-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              What is QuoteFly?
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              QuoteFly is contractor operations software that keeps customers, quotes, accepted Jobs, scheduled visits, dispatch status, and internal invoice records connected. It is built for solo operators and small service teams that want one practical workflow from the first request to completed work.
            </p>
            <p className="mt-4 leading-7 text-slate-600">
              Start with searchable customer records and reusable work items, build a clear quote, carry accepted scope into the Job, then keep the schedule and field status visible without rebuilding the record.
            </p>
            <ul className="mt-7 flex flex-wrap gap-2" aria-label="Businesses QuoteFly is built for">
              {["Solo operator", "Owner-operator", "Small field crew", "Office-and-field team"].map((item) => (
                <li key={item} className="rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-900">
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <MarketingAction href="/services" variant="secondary">
                Explore the product
              </MarketingAction>
              <MarketingAction href={BASIC_PLAN_PRICING_PATH} variant="secondary">
                See Basic pricing
              </MarketingAction>
            </div>
          </div>

          <figure data-marketing-reveal className="overflow-hidden rounded-[30px] border border-slate-200 bg-slate-950 p-2 shadow-[0_26px_70px_rgba(15,23,42,0.18)] sm:p-3">
            <picture>
              <source media="(max-width: 639px)" srcSet="/images/product/activity-my-day-mobile-v1.webp" />
              <img
                src="/images/product/activity-my-day-desktop-v1.webp"
                alt="QuoteFly My Day workspace showing follow-up activity, scheduled work, and quote status"
                width="1440"
                height="900"
                loading="lazy"
                decoding="async"
                className="h-auto w-full rounded-[23px]"
              />
            </picture>
            <figcaption className="px-3 pb-2 pt-3 text-center text-xs leading-5 text-slate-400">
              Actual QuoteFly interface shown with sanitized fictional customer and Job data.
            </figcaption>
          </figure>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-24 bg-slate-950 px-4 py-16 text-white sm:px-6 sm:py-20 lg:px-8" aria-labelledby="about-workflow-heading">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-orange-200">The operational flight path</p>
            <h2 id="about-workflow-heading" className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              One customer-to-invoice record. Five clear stages.
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-300">
              Each stage has a distinct job, while the customer and approved work stay connected as the work moves forward.
            </p>
          </div>

          <div className="relative mt-12">
            <div aria-hidden="true" className="absolute left-[10%] right-[10%] top-7 hidden h-px overflow-hidden bg-white/15 lg:block">
              <span className="qf-about-flow-signal block h-full w-1/5 bg-gradient-to-r from-transparent via-quotefly-orange to-transparent" />
            </div>
            <ol className="relative grid gap-4 lg:grid-cols-5">
              {WORKFLOW_STAGES.map((stage, index) => {
                const StageIcon = stage.icon;
                return (
                  <li
                    key={stage.number}
                    data-marketing-reveal
                    style={{ transitionDelay: `${index * 55}ms` }}
                    className="relative rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-slate-950 text-orange-200 shadow-lg">
                        <StageIcon size={24} aria-hidden="true" />
                      </span>
                      <span className="text-xs font-bold tracking-[0.18em] text-blue-200">{stage.number}</span>
                    </div>
                    <h3 className="mt-5 text-lg font-bold text-white">{stage.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-300">{stage.description}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="why-heading">
        <div className="mx-auto grid max-w-7xl overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-[0_24px_65px_rgba(15,23,42,0.08)] lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
          <figure data-marketing-reveal className="relative min-h-[360px] overflow-hidden lg:min-h-full">
            <img
              src="/images/solutions/contractor-tools.jpg"
              alt="Hand tools and measuring equipment arranged on a contractor workbench"
              width="1600"
              height="1067"
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-transparent" />
            <figcaption className="absolute inset-x-0 bottom-0 p-6 text-xs text-slate-200">Photo by Bermix Studio.</figcaption>
          </figure>

          <div data-marketing-reveal className="p-7 sm:p-10 lg:p-14">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-800">Why we are building it</p>
            <h2 id="why-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Good work should not create a second shift of paperwork.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Small service businesses often have the same person answering the phone, inspecting the work, preparing the quote, and coordinating the crew. The software should respect that reality.
            </p>
            <p className="mt-4 leading-7 text-slate-600">
              QuoteFly is being shaped around fast field use, deliberate review, and a record that follows the work. The aim is simple: less re-entry, fewer loose ends, and a cleaner handoff from customer request to completed Job.
            </p>

            <div className="mt-8 grid gap-4">
              {PRINCIPLES.map((principle) => {
                const PrincipleIcon = principle.icon;
                return (
                  <article key={principle.title} className="flex gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
                    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-quotefly-orange text-slate-950">
                      <PrincipleIcon size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="font-bold text-slate-950">{principle.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{principle.description}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-stone-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="answers-heading">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,0.68fr)_minmax(0,1.32fr)] lg:gap-16">
          <div data-marketing-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--qf-brand-orange-text)]">Citation-ready product facts</p>
            <h2 id="answers-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Straight answers about QuoteFly
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Useful software should be easy to understand before you sign in. These answers describe the product and its current boundaries in plain language.
            </p>
            <div className="mt-7 flex flex-col items-start gap-2 text-sm font-semibold">
              <Link to="/solutions" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-quotefly-blue transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200">
                Explore trade workflows <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link to="/data-privacy" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-quotefly-blue transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200">
                Read how QuoteFly handles data <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link to="/support" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-quotefly-blue transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200">
                Ask a product question <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <dl className="divide-y divide-slate-200 border-y border-slate-200">
            {DIRECT_ANSWERS.map((item, index) => (
              <div key={item.question} data-marketing-reveal style={{ transitionDelay: `${index * 45}ms` }} className="py-6 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[minmax(0,0.66fr)_minmax(0,1.34fr)] sm:gap-8">
                <dt className="text-base font-bold text-slate-950">{item.question}</dt>
                <dd className="mt-2 text-base leading-7 text-slate-600 sm:mt-0">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCta
        title="Put the customer, quote, and Job on one flight path."
        description="Start with a real customer and a real scope. QuoteFly keeps the workflow focused while you stay in control of the final details."
        actionLabel="Start free trial"
        onAction={onOpenAuth}
        supportingText={
          <span>
            Prefer to look first? <a href={BASIC_PLAN_PRICING_PATH} className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30">See the Basic plan.</a>
          </span>
        }
      />
    </div>
  );
}
