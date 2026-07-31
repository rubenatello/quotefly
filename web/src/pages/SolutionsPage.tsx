import { useEffect } from "react";
import { Zap, Wrench, Hammer, Leaf } from "lucide-react";
import { setPublicSEOMetadata } from "../lib/seo";

interface SolutionsPageProps {
  onOpenAuth: () => void;
}

export function SolutionsPage({ onOpenAuth }: SolutionsPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/solutions");
  }, []);

  const solutions = [
    {
      id: "hvac",
      name: "HVAC",
      icon: <Zap className="h-12 w-12 text-blue-600" />,
      description: "Furnace replacement, repairs, and seasonal peak demand quoting for service crews.",
      benefits: [
        "Reusable work names and pricing defaults",
        "Labor, material, quantity, and customer price controls",
        "Customer notes for job and equipment context",
        "Branded quote PDF review before sharing",
      ],
      example:
        "New quote for an AC unit replacement with existing ducts. QuoteFly drafts labor, materials, and totals so your team can review and send quickly.",
    },
    {
      id: "plumbing",
      name: "Plumbing",
      icon: <Wrench className="h-12 w-12 text-cyan-600" />,
      description: "Leak diagnosis, repairs, and replacement work with clear pricing controls.",
      benefits: [
        "Reusable work names for common service calls",
        "Separate internal cost and customer price fields",
        "Clear scope and line-item descriptions",
        "Customer and quote follow-up tracking",
      ],
      example:
        "New quote for a kitchen sink backup with possible pipe replacement. Diagnostic labor and likely repair costs are ready for review.",
    },
    {
      id: "flooring",
      name: "Flooring",
      icon: <Hammer className="h-12 w-12 text-amber-600" />,
      description: "Tile, hardwood, and vinyl pricing by square footage, prep, and labor complexity.",
      benefits: [
        "Square-foot quantities and adjustable unit prices",
        "Separate prep, labor, and material lines",
        "Customer-facing scope and alternate options",
        "Reusable defaults for common flooring work",
      ],
      example:
        "New hardwood flooring quote for 800 square feet. Material costs and labor per square foot are loaded and ready to adjust.",
    },
    {
      id: "roofing",
      name: "Roofing",
      icon: <Hammer className="h-12 w-12 text-red-600" />,
      description: "Repairs and replacements with clear scopes, quantities, and customer-facing prices.",
      benefits: [
        "Square-foot quantities and adjustable unit prices",
        "Separate tear-off, material, labor, and cleanup lines",
        "Branded PDF quotes for customer review",
        "Quote status and follow-up tracking",
      ],
      example:
        "New roofing replacement quote with tear-off, material, labor, and cleanup lines ready for contractor review.",
    },
    {
      id: "gardening",
      name: "Landscaping and Gardening",
      icon: <Leaf className="h-12 w-12 text-green-600" />,
      description: "Lawn care, cleanup, and landscape installs with hourly or area-based pricing.",
      benefits: [
        "Area, hourly, or flat-quantity line items",
        "Reusable work names for recurring services",
        "Separate material, labor, and optional service lines",
        "Customer and quote follow-up tracking",
      ],
      example:
        "New landscaping quote for spring cleanup, hedge trimming, and mulch beds. Labor and area-based pricing are ready to send.",
    },
    {
      id: "construction",
      name: "General Construction",
      icon: <Hammer className="h-12 w-12 text-slate-600" />,
      description: "Multi-step project scopes with separate labor, material, fee, and optional lines.",
      benefits: [
        "Detailed scope and line-item descriptions",
        "Separate internal cost and customer price fields",
        "Alternate options outside the customer total",
        "Quote status and follow-up tracking",
      ],
      example:
        "New renovation quote with demolition, framing, material, labor, cleanup, and alternate upgrade lines ready for contractor review.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Services and solutions by trade</p>
            <h1 className="mt-3 text-4xl font-bold text-slate-900 sm:text-5xl">Estimating workflows for small contractor teams</h1>
            <p className="mt-5 text-lg text-slate-600">
              Whether you install HVAC systems or manage landscaping crews, QuoteFly keeps customer intake, estimating, quote delivery, and follow-up in one field-ready workflow.
            </p>
            <nav aria-label="Trade solutions" className="mt-6 flex flex-wrap gap-2">
              {solutions.map((solution) => (
                <a
                  key={solution.id}
                  href={`#${solution.id}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-quotefly-blue hover:text-quotefly-blue"
                >
                  {solution.name}
                </a>
              ))}
            </nav>
          </div>
          <figure className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
            <img
              src="/quote-workflow.jpg"
              alt="Illustration of a contractor moving from customer lookup to estimate and quote sharing"
              width="1280"
              height="960"
              loading="eager"
              decoding="async"
              className="h-auto w-full"
            />
            <figcaption className="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-500">
              One connected workflow for customer management, estimating, and quote delivery.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl space-y-12">
          {solutions.map((solution, idx) => (
            <div
              key={solution.id}
              id={solution.id}
              className="scroll-mt-24 overflow-hidden rounded-lg border border-slate-200 bg-white transition-colors hover:border-slate-300"
            >
              <div className="grid gap-8 md:grid-cols-2">
                <div className={`flex flex-col justify-between p-6 sm:p-8 ${idx % 2 === 0 ? "" : "md:order-2"}`}>
                  <div>
                    <div className="mb-4 flex items-center gap-3">
                      <div>{solution.icon}</div>
                      <h2 className="text-3xl font-bold text-slate-900">{solution.name}</h2>
                    </div>
                    <p className="mb-6 text-lg text-slate-700">{solution.description}</p>

                    <div className="mb-6">
                      <h3 className="mb-3 font-semibold text-slate-900">Key benefits:</h3>
                      <ul className="space-y-2">
                        {solution.benefits.map((benefit) => (
                          <li key={benefit} className="flex gap-3 text-slate-700">
                            <span className="text-quotefly-blue">+</span>
                            <span>{benefit}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <button
                    onClick={onOpenAuth}
                    className="w-full rounded-lg bg-quotefly-blue px-6 py-3 font-semibold text-white transition-colors hover:bg-blue-600"
                  >
                    Try for {solution.name}
                  </button>
                </div>

                <div className={`flex items-center border-t border-slate-200 bg-slate-50 p-6 sm:p-8 md:border-t-0 ${idx % 2 === 0 ? "md:border-l" : "md:order-1 md:border-r"}`}>
                  <div>
                    <h3 className="mb-4 font-semibold text-slate-900">Example workflow:</h3>
                    <p className="text-sm italic text-slate-700">"{solution.example}"</p>
                    <div className="mt-6 rounded-lg border border-quotefly-blue/20 bg-quotefly-blue/10 p-4">
                      <p className="mb-2 text-xs text-slate-600">Output:</p>
                      <p className="text-sm font-medium text-quotefly-blue">Customer record, drafted quote, and branded PDF</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Whatever your trade, the workflow stays clean</h2>
          <p className="mb-8 text-lg text-slate-600">Start your free trial today and configure your quoting flow in minutes.</p>
          <button
            onClick={onOpenAuth}
            className="rounded-lg bg-quotefly-blue px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-blue-600"
          >
            Start Free Trial
          </button>
        </div>
      </section>
    </div>
  );
}
