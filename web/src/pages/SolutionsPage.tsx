import { useEffect } from "react";
import {
  AirVent,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  FileCheck2,
  HardHat,
  House,
  Leaf,
  MessageSquareQuote,
  PanelsTopLeft,
  Search,
  TimerReset,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { LandingProductDemo } from "../components/marketing/LandingProductDemo";
import { MarketingAction } from "../components/marketing/PublicPageLayout";
import { useMarketingReveal } from "../hooks/useMarketingReveal";
import { setPublicSEOMetadata } from "../lib/seo";

interface SolutionsPageProps {
  onOpenAuth: () => void;
}

type TradeSolution = {
  id: string;
  name: string;
  icon: LucideIcon;
  iconClass: string;
  iconBackground: string;
  problem: string;
  response: string;
  quoteItems: string[];
  capabilities: string[];
};

const PAIN_POINTS: Array<{
  icon: LucideIcon;
  problem: string;
  detail: string;
  answer: string;
}> = [
  {
    icon: MessageSquareQuote,
    problem: "Customer details live everywhere",
    detail: "A name in your phone, a scope in a text, and the job address on a scrap of paper.",
    answer: "Keep contact details, notes, and quote history together in one searchable customer record.",
  },
  {
    icon: TimerReset,
    problem: "The estimate happens after hours",
    detail: "The workday ends, then the real paperwork starts back at the kitchen table.",
    answer: "Build and review the quote from your phone while the job details are still fresh.",
  },
  {
    icon: CircleDollarSign,
    problem: "Pricing gets rebuilt from memory",
    detail: "Labor, material, and markup drift when every estimate starts from a blank page.",
    answer: "Reuse work names and pricing defaults, then adjust cost and customer price for the job.",
  },
  {
    icon: ClipboardCheck,
    problem: "Good quotes lose momentum",
    detail: "A professional estimate still goes cold when nobody can see what needs follow-up.",
    answer: "Track quote status and next actions without running a separate sales spreadsheet.",
  },
];

const TRADES: TradeSolution[] = [
  {
    id: "hvac",
    name: "HVAC",
    icon: AirVent,
    iconClass: "text-blue-700",
    iconBackground: "bg-blue-50",
    problem: "Replacement options should not wait for the office.",
    response: "Build the base system scope, separate startup work, and give upgrades or ductwork their own clear option.",
    quoteItems: ["Equipment and installation", "Startup and testing", "Ductwork alternate"],
    capabilities: ["Saved work", "Alternate lines", "Branded PDF"],
  },
  {
    id: "plumbing",
    name: "Plumbing",
    icon: Wrench,
    iconClass: "text-cyan-700",
    iconBackground: "bg-cyan-50",
    problem: "Diagnosis can change the job in a hurry.",
    response: "Keep the service call, likely repair, and possible add-on separate so the customer can understand the path forward.",
    quoteItems: ["Diagnostic visit", "Primary repair", "Replacement option"],
    capabilities: ["Clear scope", "Cost vs. price", "Customer notes"],
  },
  {
    id: "flooring",
    name: "Flooring",
    icon: PanelsTopLeft,
    iconClass: "text-amber-700",
    iconBackground: "bg-amber-50",
    problem: "Prep and finish work are where margins disappear.",
    response: "Price the square footage, then keep demolition, leveling, waste, transitions, and finish work visible.",
    quoteItems: ["Floor preparation", "Material by square foot", "Transitions and finish"],
    capabilities: ["Flexible quantities", "Pricing defaults", "Optional upgrades"],
  },
  {
    id: "roofing",
    name: "Roofing",
    icon: House,
    iconClass: "text-rose-700",
    iconBackground: "bg-rose-50",
    problem: "One lump sum hides the work that protects the job.",
    response: "Spell out tear-off, disposal, flashing, underlayment, and allowances without making the quote hard to read.",
    quoteItems: ["Tear-off and disposal", "Roofing system", "Deck repair allowance"],
    capabilities: ["Detailed lines", "Clear allowances", "Quote tracking"],
  },
  {
    id: "landscaping",
    name: "Landscaping",
    icon: Leaf,
    iconClass: "text-emerald-700",
    iconBackground: "bg-emerald-50",
    problem: "Recurring work and one-off installs price differently.",
    response: "Mix area, hourly, and flat-quantity work in one quote while keeping materials and optional services easy to scan.",
    quoteItems: ["Site preparation", "Labor and materials", "Ongoing service option"],
    capabilities: ["Flexible units", "Reusable work", "Fast follow-up"],
  },
  {
    id: "construction",
    name: "Construction",
    icon: HardHat,
    iconClass: "text-slate-700",
    iconBackground: "bg-slate-100",
    problem: "Complex work still needs a simple customer decision.",
    response: "Organize multi-step labor, material, cleanup, and upgrade alternates into a quote the customer can actually follow.",
    quoteItems: ["Demolition and prep", "Labor and materials", "Upgrade alternate"],
    capabilities: ["Multi-step scope", "Internal costs", "Customer options"],
  },
];

const WORKFLOW_STEPS = [
  {
    number: "01",
    title: "Find the customer",
    detail: "Search the customer list or add a new lead without leaving the quote flow.",
    icon: Search,
  },
  {
    number: "02",
    title: "Price the real work",
    detail: "Add labor, material, quantity, fees, and options with customer price kept clear.",
    icon: CircleDollarSign,
  },
  {
    number: "03",
    title: "Review what they see",
    detail: "Check the scope and customer-facing total before creating the final quote.",
    icon: FileCheck2,
  },
  {
    number: "04",
    title: "Share and follow up",
    detail: "Open your email or text app, send the branded PDF, and keep the quote moving.",
    icon: CheckCircle2,
  },
];

export function SolutionsPage({ onOpenAuth }: SolutionsPageProps) {
  useMarketingReveal();

  useEffect(() => {
    setPublicSEOMetadata("/solutions");
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-[#f7f4ee] text-slate-900">
      <section className="relative isolate overflow-hidden bg-slate-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="pointer-events-none absolute -left-32 top-0 -z-10 h-96 w-96 rounded-full bg-quotefly-blue/20 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 bottom-0 -z-10 h-80 w-80 rounded-full bg-quotefly-orange/15 blur-3xl" />

        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
          <div className="text-center lg:text-left">
            <p className="qf-hero-badge inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-sm font-bold text-blue-200 backdrop-blur">
              <HardHat size={16} aria-hidden="true" />
              Built for the trades
            </p>
            <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-[-0.045em] text-white sm:text-5xl lg:mx-0 lg:text-[3.75rem] lg:leading-[1.02]">
              Built for the work. <span className="text-blue-300">Not the paperwork.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl lg:mx-0">
              QuoteFly is the easiest quoting software for on-the-go contractors and professionals who need to turn job details into a clear, customer-ready quote before the day gets away from them.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <MarketingAction
                onClick={onOpenAuth}
                icon={<ArrowRight size={18} aria-hidden="true" />}
              >
                Start free trial
              </MarketingAction>
              <MarketingAction
                href="#workflow"
                variant="dark-secondary"
              >
                See the field workflow
              </MarketingAction>
            </div>

            <div className="mt-7 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-slate-300 lg:justify-start">
              {["Customer records", "Mobile estimates", "Branded PDFs", "Quote follow-up"].map((item) => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <Check size={15} className="text-quotefly-orange" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <figure className="qf-hero-product relative min-h-[430px] overflow-hidden rounded-[30px] border border-white/15 bg-slate-900 shadow-[0_32px_90px_rgba(0,0,0,0.36)] sm:min-h-[520px]">
            <img
              src="/images/solutions/construction-framing.jpg"
              alt="Residential construction worker framing a new structure beneath a clear sky"
              width="1600"
              height="1067"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-transparent to-slate-950/5" />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/20 bg-slate-950/80 p-4 shadow-2xl backdrop-blur-md sm:inset-x-6 sm:bottom-6 sm:p-5">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-quotefly-orange text-slate-950">
                  <FileCheck2 size={20} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-200">The QuoteFly difference</p>
                  <p className="mt-1 text-base font-semibold text-white sm:text-lg">Finish the visit. Build the quote. Keep moving.</p>
                </div>
              </div>
            </div>
            <figcaption className="sr-only">Photo by Josh Olalde. QuoteFly helps field contractors turn fresh job details into reviewed customer quotes.</figcaption>
          </figure>
        </div>
      </section>

      <section className="border-b border-stone-200 bg-white px-4 py-6 sm:px-6 lg:px-8">
        <nav aria-label="Trade solutions" className="mx-auto flex max-w-7xl gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="inline-flex min-h-11 shrink-0 items-center pr-2 text-sm font-bold text-slate-500">Jump to your trade</span>
          {TRADES.map((trade) => {
            const TradeIcon = trade.icon;
            return (
              <a
                key={trade.id}
                href={`#${trade.id}`}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-quotefly-blue/40 hover:bg-blue-50 hover:text-quotefly-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-blue/20"
              >
                <TradeIcon size={16} aria-hidden="true" />
                {trade.name}
              </a>
            );
          })}
        </nav>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="problems-heading">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-quotefly-orange">The real problem</p>
            <h2 id="problems-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              The work changes. The quoting headaches do not.
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Small crews do not need more software to manage. They need fewer loose ends between the first call and the customer saying yes.
            </p>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {PAIN_POINTS.map((item, index) => {
              const PainIcon = item.icon;
              return (
                <article
                  key={item.problem}
                  data-marketing-reveal
                  style={{ transitionDelay: `${index * 55}ms` }}
                  className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.05)] transition duration-200 hover:-translate-y-1 hover:border-quotefly-blue/20 hover:shadow-[0_18px_42px_rgba(15,23,42,0.09)]"
                >
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-700">
                    <PainIcon size={23} aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-bold text-slate-950">{item.problem}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">{item.detail}</p>
                  <div className="my-5 h-px bg-slate-100" />
                  <p className="flex gap-2 text-sm font-medium leading-6 text-slate-700">
                    <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />
                    <span>{item.answer}</span>
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-24 border-y border-slate-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="workflow-heading">
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-16">
          <div data-marketing-reveal>
            <LandingProductDemo priority={false} />
          </div>

          <div data-marketing-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-quotefly-blue">One clean field workflow</p>
            <h2 id="workflow-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              From job details to a quote the customer can trust
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              The screen stays simple because the path stays simple. QuoteFly keeps the important decisions together and leaves the busywork behind.
            </p>

            <ol className="mt-8 space-y-3">
              {WORKFLOW_STEPS.map((step) => {
                const StepIcon = step.icon;
                return (
                  <li key={step.number} className="flex gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
                    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm">
                      <StepIcon size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold tracking-[0.16em] text-quotefly-orange">{step.number}</span>
                        <h3 className="font-bold text-slate-950">{step.title}</h3>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{step.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="trades-heading">
        <div className="mx-auto max-w-7xl">
          <div data-marketing-reveal className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-quotefly-blue">Built around real jobs</p>
            <h2 id="trades-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Your trade has its own details. QuoteFly gives them a clear place.
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Start with the same fast customer-to-quote workflow, then shape the labor, materials, quantities, and options around how your business actually prices work.
            </p>
          </div>

          <div className="mt-10 grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
            {TRADES.map((trade, index) => {
              const TradeIcon = trade.icon;
              return (
                <article
                  key={trade.id}
                  id={trade.id}
                  data-marketing-reveal
                  style={{ transitionDelay: `${(index % 3) * 55}ms` }}
                  className="scroll-mt-24 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_12px_34px_rgba(15,23,42,0.055)] sm:p-7"
                >
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl ${trade.iconBackground} ${trade.iconClass}`}>
                      <TradeIcon size={24} aria-hidden="true" />
                    </span>
                    <h3 className="text-2xl font-bold text-slate-950">{trade.name}</h3>
                  </div>

                  <p className="mt-5 text-lg font-bold leading-7 text-slate-900">{trade.problem}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{trade.response}</p>

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-slate-500">A typical quote</p>
                    <ul className="mt-3 space-y-2.5">
                      {trade.quoteItems.map((item) => (
                        <li key={item} className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
                          <span className="flex min-w-0 items-center gap-2">
                            <Check size={15} className="shrink-0 text-quotefly-blue" aria-hidden="true" />
                            <span>{item}</span>
                          </span>
                          <span aria-hidden="true" className="w-10 shrink-0 border-b border-dashed border-slate-300" />
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2" aria-label={`${trade.name} QuoteFly capabilities`}>
                    {trade.capabilities.map((capability) => (
                      <span key={capability} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">
                        {capability}
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="px-4 pb-16 sm:px-6 sm:pb-20 lg:px-8" aria-labelledby="real-work-heading">
        <div data-marketing-reveal className="mx-auto max-w-7xl overflow-hidden rounded-[30px] bg-slate-950 p-3 text-white shadow-[0_28px_70px_rgba(15,23,42,0.2)] sm:p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <div className="flex flex-col justify-center rounded-[24px] border border-white/10 bg-white/[0.04] p-7 sm:p-10 lg:p-12">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-300">For working crews</p>
              <h2 id="real-work-heading" className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">The app should fit the job. Not slow it down.</h2>
              <p className="mt-5 text-base leading-7 text-slate-300 sm:text-lg">
                QuoteFly is designed for the person answering the call, walking the site, pricing the work, and keeping the customer informed—often all in the same day.
              </p>
              <ul className="mt-7 space-y-4">
                {[
                  "44px mobile controls built for fast field use",
                  "Customer-visible pricing kept separate from internal cost",
                  "A focused workspace for customers, quotes, and follow-up",
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-slate-200 sm:text-base">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-quotefly-blue/25 text-blue-200">
                      <Check size={14} aria-hidden="true" />
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <figure className="group relative min-h-[360px] overflow-hidden rounded-[24px] sm:min-h-[460px]">
              <img
                src="/images/solutions/electrical-service.jpg"
                alt="Contractor inspecting field equipment while wearing protective gear"
                width="1600"
                height="1068"
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover object-center transition duration-500 group-hover:scale-[1.015]"
              />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-transparent to-transparent" />
              <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                <p className="text-lg font-bold text-white">Inspect the job</p>
                <p className="mt-1 text-xs text-slate-300">Photo by Emmanuel Ikwuegbu</p>
              </figcaption>
            </figure>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {[
              {
                src: "/images/solutions/carpentry-measurement.jpg",
                alt: "Carpenter measuring and marking a wood panel",
                width: 1400,
                height: 1400,
                label: "Measure the work",
                credit: "Photo by Valentina Giarre",
                position: "object-center",
              },
              {
                src: "/images/solutions/contractor-tools.jpg",
                alt: "Hand tools and measuring equipment arranged on a workbench",
                width: 1600,
                height: 1067,
                label: "Price the details",
                credit: "Photo by Bermix Studio",
                position: "object-center",
              },
              {
                src: "/images/solutions/construction-silhouette.jpg",
                alt: "Silhouette of a construction worker against the evening sky",
                width: 1600,
                height: 1067,
                label: "Keep the job moving",
                credit: "Photo by Jason Richard",
                position: "object-[40%_center]",
              },
            ].map((photo) => (
              <figure key={photo.src} className="group relative min-h-[250px] overflow-hidden rounded-[24px] sm:min-h-[290px]">
                <img
                  src={photo.src}
                  alt={photo.alt}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  decoding="async"
                  className={`absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.02] ${photo.position}`}
                />
                <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/5 to-transparent" />
                <figcaption className="absolute inset-x-0 bottom-0 p-5">
                  <p className="font-bold text-white">{photo.label}</p>
                  <p className="mt-1 text-xs text-slate-300">{photo.credit}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-stone-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div data-marketing-reveal className="mx-auto max-w-5xl rounded-[30px] bg-gradient-to-br from-blue-50 via-white to-orange-50 p-8 text-center ring-1 ring-slate-200 sm:p-12">
          <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-quotefly-blue text-white shadow-[0_12px_26px_rgba(47,111,214,0.25)]">
            <UsersRound size={26} aria-hidden="true" />
          </span>
          <h2 className="mx-auto mt-5 max-w-3xl text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Give your next quote the same care you give the work.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-slate-600">
            Start with a sample customer, price a real job, and review the customer-facing PDF during your 14-day trial. No credit card required.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <MarketingAction
              onClick={onOpenAuth}
              className="px-8"
              icon={<ArrowRight size={18} aria-hidden="true" />}
            >
              Start free trial
            </MarketingAction>
            <MarketingAction
              href="/services"
              variant="secondary"
              className="px-8"
            >
              Explore QuoteFly services
            </MarketingAction>
          </div>
        </div>
      </section>
    </div>
  );
}
