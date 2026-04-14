import { useEffect, useMemo, useState } from "react";
import { CheckIcon } from "../components/Icons";
import { setSEOMetadata } from "../lib/seo";

interface AboutPageProps {
  onOpenAuth: () => void;
}

type Testimonial = {
  quote: string;
  name: string;
  trade: string;
  location: string;
};

export function AboutPage({ onOpenAuth }: AboutPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "About QuoteFly Contractor Quoting Software",
      description:
        "Learn how QuoteFly was built as contractor quoting software and contractor estimating software to reduce quoting delays and follow-up friction.",
      keywords:
        "about contractor quoting software, contractor estimating software platform, quoting crm for contractors",
      canonicalUrl: "https://quotefly.us/about",
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

  const baseTestimonials: Testimonial[] = [
    {
      quote: "We send quotes same-day now. That alone changed how many jobs we close.",
      name: "Ryan T.",
      trade: "HVAC",
      location: "Phoenix, AZ",
    },
    {
      quote: "The quote flow feels straightforward. No hunting through tabs while on a service call.",
      name: "Chris M.",
      trade: "Plumbing",
      location: "Dallas, TX",
    },
    {
      quote: "Customers respond faster when I can send a clean quote right after the walkthrough.",
      name: "Eric P.",
      trade: "Roofing",
      location: "San Diego, CA",
    },
    {
      quote: "The mobile workflow is good enough to run from the truck between jobs.",
      name: "Daniel R.",
      trade: "Construction",
      location: "Tampa, FL",
    },
    {
      quote: "Saving preset work lines cut my quote prep time in half.",
      name: "Mark L.",
      trade: "Flooring",
      location: "Charlotte, NC",
    },
    {
      quote: "Follow-up status keeps my pipeline from going stale.",
      name: "Steve B.",
      trade: "HVAC",
      location: "Boise, ID",
    },
    {
      quote: "It feels like a contractor tool, not generic office software.",
      name: "Anthony G.",
      trade: "Plumbing",
      location: "Las Vegas, NV",
    },
    {
      quote: "The PDF output is clean and looks professional without extra editing.",
      name: "Jose C.",
      trade: "Roofing",
      location: "Austin, TX",
    },
    {
      quote: "The customer board helps us move from lead to sold without dropped handoffs.",
      name: "Kevin H.",
      trade: "Construction",
      location: "Nashville, TN",
    },
    {
      quote: "Quote updates are quick. We can revise scope while still on site.",
      name: "Brandon W.",
      trade: "Flooring",
      location: "Sacramento, CA",
    },
  ];

  const testimonials = useMemo(() => {
    return [...baseTestimonials].sort(() => Math.random() - 0.5);
  }, []);
  const [activeTestimonialIndex, setActiveTestimonialIndex] = useState(0);

  useEffect(() => {
    if (testimonials.length <= 1) return;
    const interval = window.setInterval(() => {
      setActiveTestimonialIndex((current) => (current + 1) % testimonials.length);
    }, 5200);

    return () => window.clearInterval(interval);
  }, [testimonials.length]);

  return (
    <div className="min-h-screen bg-stone-50">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Built for contractors who move fast</h1>
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

          <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-bold text-slate-900">Contractor feedback</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setActiveTestimonialIndex((current) =>
                      current === 0 ? testimonials.length - 1 : current - 1,
                    )
                  }
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                  aria-label="Previous testimonial"
                >
                  {"<"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setActiveTestimonialIndex((current) => (current + 1) % testimonials.length)
                  }
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                  aria-label="Next testimonial"
                >
                  {">"}
                </button>
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              <div
                className="flex transition-transform duration-700 ease-out"
                style={{ transform: `translateX(-${activeTestimonialIndex * 100}%)` }}
              >
                {testimonials.map((item) => (
                  <article key={`${item.name}-${item.location}`} className="w-full flex-none px-6 py-6 sm:px-8 sm:py-8">
                    <p className="text-lg leading-relaxed text-slate-700">"{item.quote}"</p>
                    <div className="mt-5 border-t border-slate-200 pt-4">
                      <p className="font-semibold text-slate-900">{item.name}</p>
                      <p className="text-sm text-slate-500">
                        {item.trade} • {item.location}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {testimonials.map((item, index) => (
                <button
                  key={`dot-${item.name}-${item.location}`}
                  type="button"
                  onClick={() => setActiveTestimonialIndex(index)}
                  className={`h-2.5 rounded-full transition-all ${
                    index === activeTestimonialIndex
                      ? "w-8 bg-quotefly-blue"
                      : "w-2.5 bg-slate-300 hover:bg-slate-400"
                  }`}
                  aria-label={`Show testimonial ${index + 1}`}
                />
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
