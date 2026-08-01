import { useEffect } from "react";
import { HardHat } from "lucide-react";
import { CheckIcon } from "../components/Icons";
import { MarketingCta, MarketingHero } from "../components/marketing/PublicPageLayout";
import { setPublicSEOMetadata } from "../lib/seo";

interface AboutPageProps {
  onOpenAuth: () => void;
}

export function AboutPage({ onOpenAuth }: AboutPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/about");
  }, []);

  const differentiators = [
    {
      title: "Built for you",
      description: "We understand contractor workflows because we are designing for speed in the field, not office bloat.",
    },
    {
      title: "Simple pricing",
      description: "Clear monthly plans. No per-quote fees. No confusing add-on maze before launch.",
    },
    {
      title: "Actually fast",
      description: "Lead intake, quote drafting, and branded PDF delivery happen in one short workflow.",
    },
    {
      title: "Multi-trade",
      description: "HVAC, plumbing, flooring, roofing, construction, and other service trades fit the same core system.",
    },
    {
      title: "Made to integrate",
      description: "Stripe billing works now. Basic is focused on CRM and quoting first, with accounting integrations staged after launch.",
    },
    {
      title: "Customer-obsessed",
      description: "Feature requests from contractors directly shape the roadmap and the launch priorities.",
    },
  ];

  const values = [
    {
      title: "Respect contractors' time",
      desc: "Every minute we save should help crews move faster, answer customers sooner, or close more jobs.",
    },
    {
      title: "Radical transparency",
      desc: "Clear pricing, honest limitations, and straightforward product direction matter more than hype.",
    },
    {
      title: "Builder's mindset",
      desc: "We want the product to feel durable: clean data, reliable workflows, and quality code underneath.",
    },
    {
      title: "Customer driven",
      desc: "We listen closely, ship pragmatically, and keep pushing toward the operational problems that matter most.",
    },
  ];

  const evaluationSteps = [
    "Add a sample customer from your phone.",
    "Build a quote with the labor and materials you normally use.",
    "Review the customer-facing PDF for accuracy and clarity.",
    "Test the share workflow before using QuoteFly for a live job.",
  ];

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-slate-900">
      <MarketingHero
        eyebrow="Why QuoteFly"
        icon={HardHat}
        title="Built for contractors who move fast"
        description={
          <>
            QuoteFly exists to remove quoting drag, not add another bloated back-office tool.
          </>
        }
      />

      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_12px_34px_rgba(15,23,42,0.055)] sm:p-10">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">How QuoteFly started</h2>
            <p className="mb-4 leading-7 text-slate-600">
              QuoteFly started from a simple operational problem: good contractors were losing time and deals because quoting was slow.
            </p>
            <p className="mb-4 leading-7 text-slate-600">
              Customers would call, email, or send rough job details. The contractor still had to dig through notes, calculate labor and materials, and assemble a quote manually.
            </p>
            <p className="mb-4 leading-7 text-slate-600">
              By the time the quote was ready, the customer had already contacted other crews. The problem was not skill. It was workflow.
            </p>
            <p className="leading-7 text-slate-600">
              QuoteFly is being built to fix that bottleneck with a cleaner, faster system that works well on phones and in the field.
            </p>
          </div>

          <div className="relative overflow-hidden rounded-3xl border border-quotefly-blue/25 bg-gradient-to-br from-blue-50 via-white to-orange-50 p-7 sm:p-10">
            <div aria-hidden="true" className="absolute -right-12 -top-16 h-44 w-44 rounded-full bg-quotefly-orange/15 blur-3xl" />
            <h2 className="mb-4 text-2xl font-bold text-slate-900">Our mission</h2>
            <p className="relative max-w-3xl text-lg leading-8 text-slate-600">
              Help contractors move from lead to quote to follow-up without wasting time on clumsy software.
            </p>
          </div>

          <div>
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Why we're different</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {differentiators.map((item) => (
                <div key={item.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.045)] transition duration-200 hover:-translate-y-1 hover:border-quotefly-blue/20 hover:shadow-[0_18px_42px_rgba(15,23,42,0.08)]">
                  <h3 className="mb-2 font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-sm leading-6 text-slate-600">{item.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_12px_34px_rgba(15,23,42,0.055)] sm:p-10">
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Our values</h2>
            <div className="space-y-4">
              {values.map((value) => (
                <div key={value.title} className="flex gap-4 border-b border-slate-200 pb-4 last:border-b-0">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-quotefly-blue/15 text-quotefly-blue">
                    <CheckIcon size={16} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{value.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{value.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_12px_34px_rgba(15,23,42,0.055)] sm:p-10">
            <h2 className="text-2xl font-bold text-slate-900">Evaluate the current product</h2>
            <p className="mt-3 text-slate-600">
              QuoteFly is in controlled beta. Use sample job information to confirm that the launch workflow fits your business before relying on it in the field.
            </p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {evaluationSteps.map((step) => (
                <li key={step} className="flex gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                  <CheckIcon size={18} className="mt-0.5 flex-none text-quotefly-blue" />
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <MarketingCta
        title="See how much quoting time you can save"
        description="Start a trial and run the workflow against a sample job from your trade."
        actionLabel="Start Free Trial"
        onAction={onOpenAuth}
      />
    </div>
  );
}
