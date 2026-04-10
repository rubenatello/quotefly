import { useEffect } from "react";
import { Zap, Wrench, Hammer, Leaf } from "lucide-react";
import { setSEOMetadata } from "../lib/seo";

interface SolutionsPageProps {
  onOpenAuth: () => void;
}

export function SolutionsPage({ onOpenAuth }: SolutionsPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Solutions for HVAC, Plumbing, Flooring and More - QuoteFly",
      description:
        "Industry-specific quoting workflows for contractors in HVAC, plumbing, flooring, roofing, landscaping, and more.",
      keywords:
        "HVAC quoting software, plumbing quotes, flooring estimates, roofing quotes, landscaping software",
    });
  }, []);

  const solutions = [
    {
      id: "hvac",
      name: "HVAC",
      icon: <Zap className="h-12 w-12 text-blue-600" />,
      description: "Furnace replacement, repairs, and seasonal peak demand quoting for service crews.",
      benefits: [
        "Service calls to quotes in minutes",
        "Preset seasonal and emergency pricing scenarios",
        "Track equipment and warranty notes",
        "Built for service fleets and growing HVAC teams",
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
        "Material costs by job type",
        "Labor rates for diagnostic versus replacement work",
        "Emergency call-out pricing support",
        "Useful for solo plumbers and multi-location shops",
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
        "Material-specific pricing and labor rates",
        "Room-dimension-based estimating",
        "Subfloor prep and repair support",
        "Designed for installation teams and design-build firms",
      ],
      example:
        "New hardwood flooring quote for 800 square feet. Material costs and labor per square foot are loaded and ready to adjust.",
    },
    {
      id: "roofing",
      name: "Roofing",
      icon: <Hammer className="h-12 w-12 text-red-600" />,
      description: "Repairs, replacements, and claim-ready scopes for roofing contractors.",
      benefits: [
        "Roof material pricing for shingles, metal, and tile",
        "Square footage estimating support",
        "Claim-ready quote documentation",
        "Useful for restoration teams and insurance-driven jobs",
      ],
      example:
        "New roofing replacement quote for hail damage. Scope, materials, and claim-ready line items are assembled fast.",
    },
    {
      id: "gardening",
      name: "Landscaping and Gardening",
      icon: <Leaf className="h-12 w-12 text-green-600" />,
      description: "Lawn care, cleanup, and landscape installs with hourly or area-based pricing.",
      benefits: [
        "Per-square-foot and hourly flexibility",
        "Seasonal package setup",
        "Equipment rental pricing support",
        "Works for solo landscapers and maintenance crews",
      ],
      example:
        "New landscaping quote for spring cleanup, hedge trimming, and mulch beds. Labor and area-based pricing are ready to send.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Built for every trade</h1>
          <p className="text-lg text-slate-600">
            Whether you install HVAC systems or manage landscaping crews, QuoteFly adapts to the way contractors quote in the real world.
          </p>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl space-y-12">
          {solutions.map((solution, idx) => (
            <div
              key={solution.id}
              className={`overflow-hidden rounded-lg border border-slate-200 bg-white transition-colors hover:border-slate-300 ${
                idx % 2 === 0 ? "" : "lg:flex-row-reverse"
              }`}
            >
              <div className="grid gap-8 md:grid-cols-2">
                <div className="flex flex-col justify-between p-8">
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

                <div className="flex items-center border-t border-slate-200 bg-slate-50 p-8 md:border-l md:border-t-0">
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
