import { useEffect } from "react";
import { CheckIcon } from "../components/Icons";
import { setSEOMetadata } from "../lib/seo";

interface AboutPageProps {
  onOpenAuth: () => void;
}

export function AboutPage({ onOpenAuth }: AboutPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "About QuoteFly - Our Story",
      description:
        "Built for contractors who need faster quoting, cleaner follow-up, and less operational drag.",
    });
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
      description: "Stripe billing works now. Starter is focused on CRM and quoting first, with accounting integrations staged after launch.",
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

  return (
    <div className="min-h-screen bg-stone-50">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Built by people who respect the trades</h1>
          <p className="text-lg text-slate-500">
            QuoteFly exists to remove quoting drag, not add another bloated back-office tool.
          </p>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-8">
          <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">How QuoteFly started</h2>
            <p className="mb-4 text-slate-600">
              QuoteFly started from a simple operational problem: good contractors were losing time and deals because quoting was slow.
            </p>
            <p className="mb-4 text-slate-600">
              Customers would call, email, or send rough job details. The contractor still had to dig through notes, calculate labor and materials, and assemble a quote manually.
            </p>
            <p className="mb-4 text-slate-600">
              By the time the quote was ready, the customer had already contacted other crews. The problem was not skill. It was workflow.
            </p>
            <p className="text-slate-600">
              QuoteFly is being built to fix that bottleneck with a cleaner, faster system that works well on phones and in the field.
            </p>
          </div>

          <div className="rounded-lg border border-quotefly-blue/30 bg-quotefly-blue/5 p-8">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">Our mission</h2>
            <p className="text-slate-600">
              Help contractors move from lead to quote to follow-up without wasting time on clumsy software.
            </p>
          </div>

          <div>
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Why we're different</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {differentiators.map((item) => (
                <div key={item.title} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-2 font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-sm text-slate-500">{item.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-6 text-2xl font-bold text-slate-900">The team</h2>
            <p className="mb-6 text-slate-600">
              QuoteFly is being built by a small team of operators and engineers focused on contractor workflows, fast iteration, and clean execution.
            </p>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { name: "Alex Chen", role: "Founder & CEO", bio: "10-year HVAC contractor plus software engineer" },
                { name: "Maria Garcia", role: "Head of Product", bio: "Former plumbing business owner" },
                { name: "James Wilson", role: "Lead Engineer", bio: "Built backend systems at scale" },
              ].map((member) => (
                <div
                  key={member.name}
                  className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
                >
                  <div className="mb-4 flex justify-center">
                    <div className="h-16 w-16 rounded-full bg-quotefly-blue/20" />
                  </div>
                  <h3 className="font-semibold text-slate-900">{member.name}</h3>
                  <p className="font-medium text-quotefly-blue">{member.role}</p>
                  <p className="mt-2 text-xs text-slate-500">{member.bio}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Our values</h2>
            <div className="space-y-4">
              {values.map((value) => (
                <div key={value.title} className="flex gap-4 border-b border-slate-200 pb-4 last:border-b-0">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-quotefly-blue/15 text-quotefly-blue">
                    <CheckIcon size={16} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{value.title}</h3>
                    <p className="text-sm text-slate-500">{value.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">See how much quoting time you can save</h2>
          <p className="mb-8 text-lg text-slate-500">Start a trial and run the workflow against your real jobs.</p>
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
