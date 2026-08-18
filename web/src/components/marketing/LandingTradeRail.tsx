import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";

const TRADES = [
  { name: "HVAC", label: "HVAC quoting software", to: "/solutions/hvac", image: "/images/solutions/hvac-service.jpg", alt: "HVAC technician servicing residential equipment" },
  { name: "Plumbing", label: "Plumbing estimate software", to: "/solutions/plumbing", image: "/images/solutions/plumbing-service.jpg", alt: "Plumber working on a service connection" },
  { name: "Roofing", label: "Roofing quote software", to: "/solutions/roofing", image: "/images/solutions/roofing-materials.jpg", alt: "Roofing professional carrying materials" },
  { name: "Flooring", label: "Flooring estimating software", to: "/solutions/flooring", image: "/images/solutions/flooring-installation.jpg", alt: "Flooring professional installing material" },
  { name: "Landscaping", label: "Landscaping quote software", to: "/solutions/landscaping", image: "/images/solutions/gardening-watering.jpg", alt: "Gardener watering plants in the field" },
  { name: "Construction", label: "Construction estimating software", to: "/solutions/construction", image: "/images/solutions/construction-framing.jpg", alt: "Construction framing at an active job" },
] as const;

export function LandingTradeRail() {
  return (
    <section className="bg-slate-950 px-4 py-16 text-white sm:px-6 sm:py-20 lg:px-8" aria-labelledby="trade-rail-heading">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-orange-300">Built around the way trades quote</p>
            <h2 id="trade-rail-heading" className="mt-3 text-3xl font-bold tracking-[-0.035em] sm:text-4xl">Start with your trade. Keep your own pricing.</h2>
          </div>
          <p className="max-w-3xl text-lg leading-8 text-slate-300">Use reusable products and service patterns as a starting point, then adjust the scope, units, costs, and customer price to match how your business actually works.</p>
        </div>

        <div className="hide-scrollbar mt-10 flex snap-x gap-4 overflow-x-auto pb-2 lg:grid lg:grid-cols-3 lg:overflow-visible">
          {TRADES.map((trade) => (
            <Link key={trade.name} to={trade.to} className="group relative min-h-[290px] min-w-[82%] snap-start overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-[0_18px_44px_rgba(0,0,0,0.2)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/40 sm:min-w-[46%] lg:min-w-0">
              <img src={trade.image} alt={trade.alt} width="800" height="600" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.035]" />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/35 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-200">{trade.name}</p>
                  <h3 className="mt-2 text-xl font-bold text-white">{trade.label}</h3>
                </div>
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-slate-950 transition group-hover:bg-quotefly-orange" aria-hidden="true"><ArrowUpRight size={19} /></span>
              </div>
            </Link>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-2 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <p>Swipe to explore trades on mobile.</p>
          <Link to="/solutions" className="inline-flex min-h-11 items-center gap-2 self-start font-semibold text-white underline decoration-white/30 underline-offset-4 transition hover:text-orange-200 hover:decoration-orange-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/40 sm:self-auto">
            View all contractor solutions <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
