import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

interface AboutPageProps {
  onOpenAuth: () => void;
}

export function AboutPage({ onOpenAuth }: AboutPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "About QuoteFly - Our Story",
      description:
        "Built by contractors for contractors. QuoteFly solves the quote-writing bottleneck that costs trades thousands in lost productivity.",
    });
  }, []);

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Built by Contractors</h1>
          <p className="text-lg text-slate-500">
            For contractors. We understand your pain because we've lived it.
          </p>
        </div>
      </section>

      {/* Story */}
      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-8">
          <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">How QuoteFly Started</h2>
            <p className="mb-4 text-slate-600">
              Our founder spent 10 years running an HVAC repair company. His biggest frustration: writing quotes.
            </p>
            <p className="mb-4 text-slate-600">
              Customers would call or text describing a job. He'd spend 30-60 minutes calculating costs, markup,
              equipment details, and labor. By the time the quote was ready, the customer had already called three
              other contractors.
            </p>
            <p className="mb-4 text-slate-600">
              "I realized I was losing deals because I was too slow," he recalls. "But if I hired someone to write quotes,
              the overhead killed my margins. There had to be a better way."
            </p>
            <p className="text-slate-600">
              After talking to dozens of contractors in different trades, the pattern was clear: quote writing was
              broken. QuoteFly was built to fix it.
            </p>
          </div>

          {/* Mission */}
          <div className="rounded-lg border border-quotefly-blue/30 bg-quotefly-blue/5 p-8">
            <h2 className="mb-4 text-2xl font-bold text-slate-900">Our Mission</h2>
            <p className="text-slate-600">
              Get contractors back to doing what they do best: building, fixing, and improving homes. We handle the
              paperwork so you can focus on the work.
            </p>
          </div>

          {/* How We're Different */}
          <div>
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Why We're Different</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {[
                {
                  title: "Built for You",
                  description:
                    "We understand contractor workflows because we've lived them. No unnecessary complexity.",
                },
                {
                  title: "Simple Pricing",
                  description:
                    "One price per month. No per-quote fees. No upsells for basic features. Transparent & honest.",
                },
                {
                  title: "Actually Fast",
                  description:
                    "Not just marketing hype. SMS-to-quote in seconds. Real time savings on every quote.",
                },
                {
                  title: "Multi-Trade",
                  description: "Whether you're HVAC, plumbing, flooring, or landscaping — we've got you covered.",
                },
                {
                  title: "Made to Integrate",
                  description:
                    "Plays well with Stripe (payments), Twilio (SMS), and QuickBooks (back-office). No silos.",
                },
                {
                  title: "Customer-Obsessed",
                  description:
                    "You contact us with a feature request, we listen. Contractors drive our roadmap.",
                },
              ].map((item, idx) => (
                <div key={idx} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-2 font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-sm text-slate-500">{item.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Team */}
          <div>
            <h2 className="mb-6 text-2xl font-bold text-slate-900">The Team</h2>
            <p className="mb-6 text-slate-600">
              QuoteFly is a small, focused team of contractors, engineers, and business operators working to make the
              construction industry less painful.
            </p>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { name: "Alex Chen", role: "Founder & CEO", bio: "10-year HVAC contractor + software engineer" },
                { name: "Maria Garcia", role: "Head of Product", bio: "Former plumbing business owner" },
                { name: "James Wilson", role: "Lead Engineer", bio: "Built backend systems at scale" },
              ].map((member, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
                >
                  <div className="mb-4 flex justify-center">
                    <div className="h-16 w-16 rounded-full bg-quotefly-blue/20" />
                  </div>
                  <h3 className="font-semibold text-slate-900">{member.name}</h3>
                  <p className="text-sm text-quotefly-blue font-medium">{member.role}</p>
                  <p className="mt-2 text-xs text-slate-500">{member.bio}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Values */}
          <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="mb-6 text-2xl font-bold text-slate-900">Our Values</h2>
            <div className="space-y-4">
              {[
                {
                  title: "Respect Contractors' Time",
                  desc: "Every minute we save is a minute you can spend on the job or with family.",
                },
                {
                  title: "Radical Transparency",
                  desc: "No hidden fees. No surprise charges. You know what you're paying and why.",
                },
                {
                  title: "Builder's Mindset",
                  desc: "We build things to last. Code quality, user experience, and support that matters.",
                },
                {
                  title: "Customer Driven",
                  desc: "Your feedback directly influences our roadmap. We listen and iterate fast.",
                },
              ].map((value, idx) => (
                <div key={idx} className="flex gap-4 border-b border-slate-200 pb-4 last:border-b-0">
                  <div className="flex-shrink-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-quotefly-blue/20 text-quotefly-blue font-bold">
                      ✓
                    </div>
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

      {/* CTA */}
      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Join Hundreds of Contractors Using QuoteFly</h2>
          <p className="mb-8 text-lg text-slate-500">See for yourself how much time you can save.</p>
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
