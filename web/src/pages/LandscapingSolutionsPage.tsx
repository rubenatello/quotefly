import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, FileCheck2, Leaf, Repeat2, Ruler, Shovel } from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingAction, MarketingCta } from "../components/marketing/PublicPageLayout";
import { setPublicSEOMetadata } from "../lib/seo";

interface LandscapingSolutionsPageProps {
  onOpenAuth: () => void;
}

const PRICING_METHODS = [
  {
    icon: Repeat2,
    title: "Per visit or recurring",
    description: "Use a clear flat price for mowing, garden care, seasonal cleanup, and repeat maintenance.",
  },
  {
    icon: Clock3,
    title: "Hourly labor",
    description: "Price pruning, troubleshooting, hand work, and uncertain site conditions by crew time.",
  },
  {
    icon: Ruler,
    title: "Area and quantity",
    description: "Estimate sod, mulch, planting, irrigation, or ground cover by square foot, yard, or each.",
  },
  {
    icon: Shovel,
    title: "Materials plus installation",
    description: "Keep plants, soil, disposal, delivery, equipment, and labor understandable in one quote.",
  },
] as const;

const QUOTE_BLUEPRINT = [
  "Site preparation, cleanup, and haul-away",
  "Labor with the unit that matches the job",
  "Plants, soil, mulch, irrigation, and other materials",
  "Optional upgrades or an ongoing maintenance visit",
] as const;

export function LandscapingSolutionsPage({ onOpenAuth }: LandscapingSolutionsPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/solutions/landscaping");
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-[#f7f4ee] text-slate-900">
      <section className="relative isolate overflow-hidden bg-emerald-950 px-4 py-14 text-white sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="qf-marketing-grid pointer-events-none absolute inset-0 -z-20 opacity-20" />
        <div aria-hidden="true" className="qf-marketing-orbit qf-marketing-orbit--blue pointer-events-none absolute -left-24 top-10 -z-10 h-80 w-80 rounded-full bg-lime-400/15 blur-3xl" />
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-14">
          <div className="qf-page-enter">
            <Link to="/solutions#landscaping" className="flex min-h-11 w-fit items-center gap-2 text-sm font-semibold text-emerald-200 transition hover:text-white">
              <ArrowLeft size={16} aria-hidden="true" /> All trade solutions
            </Link>
            <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-sm font-bold text-emerald-100">
              <Leaf size={16} aria-hidden="true" /> Landscaping estimating software
            </p>
            <h1 className="mt-6 text-4xl font-bold tracking-[-0.045em] text-white sm:text-5xl lg:text-[3.55rem] lg:leading-[1.03]">
              Landscaping and gardening quotes built around the way you work
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-emerald-50/80 sm:text-xl">
              Build clear estimates for maintenance, planting, irrigation, cleanup, and installation using the pricing unit that fits each part of the job.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>
                Start free trial
              </MarketingAction>
              <MarketingAction href="#pricing-methods" variant="dark-secondary">See landscaping pricing methods</MarketingAction>
            </div>
          </div>

          <figure className="qf-hero-product relative min-h-[430px] overflow-hidden rounded-[30px] border border-white/15 bg-emerald-900 shadow-[0_32px_90px_rgba(0,0,0,0.34)] sm:min-h-[540px]">
            <img
              src="/images/solutions/landscaping-field-work.jpg"
              alt="Landscaping professional preparing a planted garden bed beside a wheelbarrow"
              width="1600"
              height="1031"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-emerald-950/85 via-transparent to-emerald-950/5" />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/20 bg-emerald-950/80 p-4 backdrop-blur-md sm:inset-x-6 sm:bottom-6 sm:p-5">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-200">Quote the actual job</p>
              <p className="mt-1 text-base font-semibold text-white sm:text-lg">Mix recurring, hourly, area-based, and flat-rate work in one estimate.</p>
            </div>
            <figcaption className="sr-only">Photo by Nel Ranoko via Unsplash.</figcaption>
          </figure>
        </div>
      </section>

      <section id="pricing-methods" className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="pricing-methods-heading">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-emerald-700">Flexible landscaping estimates</p>
            <h2 id="pricing-methods-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Use the pricing method that makes sense for the work
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Gardening companies rarely price every service the same way. QuoteFly lets each line carry the right quantity and customer price while owners and admins keep internal cost private.
            </p>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {PRICING_METHODS.map((method) => {
              const Icon = method.icon;
              return (
                <article key={method.title} className="rounded-3xl border border-emerald-100 bg-white p-6 shadow-[0_12px_34px_rgba(15,23,42,0.05)]">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
                    <Icon size={23} aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-bold text-slate-950">{method.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{method.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-emerald-100 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="landscaping-blueprint-heading">
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:gap-14">
          <figure className="relative min-h-[500px] overflow-hidden rounded-[30px] bg-emerald-950 shadow-[0_24px_60px_rgba(15,23,42,0.16)]">
            <img
              src="/images/solutions/gardening-watering.jpg"
              alt="Gardener watering flowering plants with a green watering can"
              width="1000"
              height="1500"
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-emerald-950/55 via-transparent to-transparent" />
            <figcaption className="sr-only">Photo by Almani via Unsplash.</figcaption>
          </figure>

          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-emerald-700">A reusable quote blueprint</p>
            <h2 id="landscaping-blueprint-heading" className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Start fast without forcing every garden job into one flat rate
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Save common services as reusable products, adjust the quantity at the site, and keep the scope readable for the customer. Pricing defaults are starting points that your owner or admin controls—not market-price promises.
            </p>
            <ol className="mt-8 space-y-3">
              {QUOTE_BLUEPRINT.map((item, index) => (
                <li key={item} className="flex gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-sm font-bold text-white">{index + 1}</span>
                  <span className="self-center font-semibold text-slate-800">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="landscaping-workflow-heading">
        <div className="mx-auto max-w-7xl rounded-[30px] bg-emerald-950 p-7 text-white sm:p-10 lg:p-12">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-center">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-lime-200">From request to follow-up</p>
              <h2 id="landscaping-workflow-heading" className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Keep seasonal work and new installs moving</h2>
              <p className="mt-4 text-lg leading-8 text-emerald-50/80">
                Find or add the customer, build the estimate, review the branded PDF, and keep the next follow-up visible from a phone or desktop.
              </p>
            </div>
            <ul className="space-y-3">
              {["Searchable customer and quote history", "Approved reusable service items", "Clear branded customer PDF", "Quote status and follow-up visibility"].map((item) => (
                <li key={item} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4 text-emerald-50">
                  <Check size={18} className="mt-0.5 shrink-0 text-lime-300" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <MarketingCta
        title="Build a landscaping quote while the site details are fresh"
        description="Try the customer-to-quote workflow with one of your own gardening, maintenance, or installation jobs."
        actionLabel="Start free trial"
        onAction={onOpenAuth}
        supportingText={<span className="inline-flex items-center gap-2"><FileCheck2 size={15} aria-hidden="true" /> Human review stays required before sending.</span>}
      />
    </div>
  );
}
