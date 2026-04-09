import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";
import { Zap, Wrench, Hammer, Leaf } from "lucide-react";

interface SolutionsPageProps {
  onOpenAuth: () => void;
}

export function SolutionsPage({ onOpenAuth }: SolutionsPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Solutions for HVAC, Plumbing, Flooring & More - QuoteFly",
      description:
        "Industry-specific solutions for contractors. HVAC, Plumbing, Flooring, Roofing, Gardening. Tailored pricing and workflows.",
      keywords:
        "HVAC quoting software, plumbing quotes, flooring estimates, roofing quotes, gardening software",
    });
  }, []);

  const solutions = [
    {
      id: "hvac",
      name: "HVAC",
      icon: <Zap className="w-12 h-12" />,
      color: "from-blue-500 to-blue-600",
      description: "Furnace replacement? AC repair? QuoteFly handles seasonal peak demand.",
      benefits: [
        "Service calls to quotes in 2 minutes",
        "Pre-set HVAC pricing scenarios (seasonal rates, emergency surcharge)",
        "Track customer equipment & warranty dates",
        "Popular with: Large service fleets, seasonal contractors",
      ],
      quote:
        "Customer texts: 'Need new AC unit, 15 ton, existing ducts.' QuoteFly suggests your current AC pricing + markup. You approve and send.",
    },
    {
      id: "plumbing",
      name: "Plumbing",
      icon: <Wrench className="w-12 h-12" />,
      color: "from-cyan-500 to-cyan-600",
      description: "Leak diagnosis? Pipe replacement? Smart pricing for every scenario.",
      benefits: [
        "Material costs calculated by job type",
        "Labor rates for diagnostic vs. replacement work",
        "Emergency call–out pricing built-in",
        "Popular with: Solo plumbers, multi-location shops",
      ],
      quote:
        "Customer texts: 'Kitchen sink backing up, might need pipe replacement.' Auto-generated quote includes diagnostic + potential replacement cost.",
    },
    {
      id: "flooring",
      name: "Flooring",
      icon: <Hammer className="w-12 h-12" />,
      color: "from-amber-500 to-amber-600",
      description: "Tile, hardwood, vinyl — pricing by material & square footage.",
      benefits: [
        "Material-specific pricing & labor costs",
        "Auto-calculate by room dimensions",
        "SubFloor repair & prep estimates included",
        "Popular with: Installation teams, design-build firms",
      ],
      quote:
        "Customer texts: 'Main floor hardwood, 800 sq ft, existing subfloor in good shape.' Quote auto-loads material costs + labor per sq ft.",
    },
    {
      id: "roofing",
      name: "Roofing",
      icon: <Hammer className="w-12 h-12" />,
      color: "from-red-500 to-red-600",
      description: "Insurance claims, repairs, full replacements — accurate roofing estimates.",
      benefits: [
        "Roof material pricing (shingles, metal, tile)",
        "Square footage auto-calc from drone/measurements",
        "Insurance claim documentation ready",
        "Popular with: Restoration companies, insurance adjuster networks",
      ],
      quote:
        "Customer texts: 'Hail damage, 30 square, needs full replacement.' Quote ready for insurance claim with damage photos & materials.",
    },
    {
      id: "gardening",
      name: "Landscaping & Gardening",
      icon: <Leaf className="w-12 h-12" />,
      color: "from-green-500 to-green-600",
      description: "Lawn care, garden design, landscaping — seasonal and one-time jobs.",
      benefits: [
        "Per-square-foot & hourly rate flexibility",
        "Seasonal service packages (spring cleanup, fall leaf removal)",
        "Equipment rental pricing built-in",
        "Popular with: Solo landscapers, maintenance crews",
      ],
      quote:
        "Customer texts: 'Spring cleanup, about 4000 sq ft lot, trim hedges, mulch beds.' Auto-quotes based on your per-sq-ft rate + trimming labor.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      {/* Header */}
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">
            Built for Every Trade
          </h1>
          <p className="text-lg text-slate-600">
            Whether you're installing HVAC systems or maintaining lawns, QuoteFly has you covered.
          </p>
        </div>
      </section>

      {/* Solutions Grid */}
      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl space-y-12">
          {solutions.map((solution, idx) => (
            <div
              key={solution.id}
              className={`rounded-lg border border-slate-200 bg-white overflow-hidden transition-colors hover:border-slate-300 ${
                idx % 2 === 0 ? "" : "lg:flex-row-reverse"
              }`}
            >
              <div className="grid gap-8 md:grid-cols-2">
                {/* Content */}
                <div className="p-8 flex flex-col justify-between">
                  <div>
                    <div className="mb-4 flex items-center gap-3">
                      <div className={`text-${solution.color}`}>{solution.icon}</div>
                      <h2 className="text-3xl font-bold text-slate-900">{solution.name}</h2>
                    </div>
                    <p className="mb-6 text-lg text-slate-700">{solution.description}</p>

                    <div className="mb-6">
                      <h3 className="mb-3 font-semibold text-slate-900">Key Benefits:</h3>
                      <ul className="space-y-2">
                        {solution.benefits.map((benefit, bidx) => (
                          <li key={bidx} className="flex gap-3 text-slate-700">
                            <span className="text-quotefly-blue">→</span>
                            {benefit}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <button
                    onClick={onOpenAuth}
                    className="w-full rounded-lg bg-quotefly-blue px-6 py-3 font-semibold text-white hover:bg-blue-600 transition-colors"
                  >
                    Try for {solution.name}
                  </button>
                </div>

                {/* Example Quote */}
                <div className="p-8 bg-slate-50 border-t md:border-t-0 md:border-l border-slate-200 flex items-center">
                  <div>
                    <h3 className="mb-4 font-semibold text-slate-900">Real Example:</h3>
                    <p className="text-sm text-slate-700 italic">"{solution.quote}"</p>
                    <div className="mt-6 p-4 rounded-lg bg-quotefly-blue/10 border border-quotefly-blue/20">
                      <p className="text-xs text-slate-600 mb-2">Generated Quote Preview:</p>
                      <p className="text-sm font-mono text-quotefly-blue">Professional quote + PDF</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Whatever Your Trade, We've Got You</h2>
          <p className="mb-8 text-lg text-slate-600">Start your free trial today. Configure your pricing in minutes.</p>
          <button
            onClick={onOpenAuth}
            className="rounded-lg bg-quotefly-blue px-8 py-4 text-lg font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            Start Free Trial
          </button>
        </div>
      </section>
    </div>
  );
}
