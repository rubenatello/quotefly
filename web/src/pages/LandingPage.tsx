import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";
import { QuoteIcon, InvoiceIcon, CustomerIcon, SendIcon } from "../components/Icons";

interface LandingPageProps {
  onOpenAuth: () => void;
}

export function LandingPage({ onOpenAuth }: LandingPageProps) {
  const seoFaqs = [
    {
      q: "What is contractor quoting software?",
      a: "Contractor quoting software helps service businesses create, price, send, and track quotes from one workflow.",
    },
    {
      q: "Is QuoteFly also contractor estimating software?",
      a: "Yes. QuoteFly supports estimating labor, materials, markup, and customer totals before you send the final quote.",
    },
    {
      q: "Which trades can use QuoteFly?",
      a: "HVAC, plumbing, roofing, flooring, construction, and landscaping teams can use the same core quote workflow.",
    },
    {
      q: "Can I send branded quote PDFs from my phone?",
      a: "Yes. QuoteFly is mobile-first and lets you generate and share branded quote PDFs from the field.",
    },
    {
      q: "Does QuoteFly include customer tracking?",
      a: "Yes. QuoteFly includes customer intake, follow-up status tracking, and quote pipeline visibility.",
    },
  ];

  useEffect(() => {
    setSEOMetadata({
      title: "Contractor Quoting Software and Estimating Software",
      description:
        "QuoteFly is contractor quoting software and contractor estimating software for field teams. Add leads, estimate fast, and send branded quote PDFs.",
      keywords:
        "contractor quoting software, contractor estimating software, estimate software for contractors, contractor estimate app, contractor quote app, hvac estimating software, plumbing estimating software, roofing estimating software",
      canonicalUrl: "https://quotefly.us/",
      ogType: "website",
    });
  }, []);

  useEffect(() => {
    const scriptId = "qf-landing-faq-jsonld";
    const existing = document.getElementById(scriptId);
    if (existing) existing.remove();

    const script = document.createElement("script");
    script.id = scriptId;
    script.type = "application/ld+json";
    script.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: seoFaqs.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.a,
        },
      })),
    });
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, []);

  const testimonials = [
    {
      name: "Adam J",
      location: "Charlotte, North Carolina",
      text: "QuoteFly cleaned up our quote process fast. My team can get a draft out while the lead is still fresh.",
    },
    {
      name: "Marissa T",
      location: "Tampa, Florida",
      text: "The biggest win is speed. Customer info, pricing, and the PDF are all in one place instead of three different tools.",
    },
    {
      name: "Carlos R",
      location: "Phoenix, Arizona",
      text: "We stopped losing quotes in text threads and notes. That alone made the software worth it.",
    },
  ];

  const features = [
    {
      icon: <SendIcon size={32} className="text-quotefly-blue" />,
      title: "Chat-to-Quote",
      description: "Draft a usable quote from customer details and job scope without starting from a blank page.",
    },
    {
      icon: <QuoteIcon size={32} className="text-quotefly-orange" />,
      title: "Smart Pricing",
      description: "Keep labor, materials, markup, and customer price visible in one fast editing flow.",
    },
    {
      icon: <InvoiceIcon size={32} className="text-quotefly-gold" />,
      title: "Branded PDFs",
      description: "Send polished, contractor-ready quotes that match your logo, colors, and template style.",
    },
    {
      icon: <CustomerIcon size={32} className="text-quotefly-blue" />,
      title: "Lead Pipeline",
      description: "Track new leads, quoted jobs, closed work, and follow-up without leaving the app.",
    },
  ];

  const workflow = [
    {
      step: "1",
      title: "Add the customer fast",
      description: "Create a lead in seconds with name, phone, email, and notes from the field.",
    },
    {
      step: "2",
      title: "Draft the quote",
      description: "Describe the work in chat or the builder, then shape line items, labor, materials, and totals.",
    },
    {
      step: "3",
      title: "Review before sending",
      description: "Check scope, margin, and customer-facing price before the quote leaves your workspace.",
    },
    {
      step: "4",
      title: "Send and track",
      description: "Open the email or text app, share the branded PDF, and move the lead through the pipeline.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="relative overflow-hidden px-4 py-20 sm:px-6 sm:py-32 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-block">
            <span className="rounded-full bg-quotefly-blue/10 px-4 py-2 text-sm font-medium text-quotefly-blue">
              Free for 14 days. No credit card required.
            </span>
          </div>

          <h1 className="mb-6 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
            Contractor quoting software and estimating software built for field teams
          </h1>

          <p className="mb-8 text-lg text-slate-600 sm:text-xl">
            QuoteFly gives contractors one place to intake customers, build estimates, send branded quotes, and track follow-up without workflow drag.
          </p>

          <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
            <button
              onClick={onOpenAuth}
              className="rounded-lg bg-quotefly-blue px-8 py-3 font-semibold text-white transition-colors hover:bg-blue-600"
            >
              Start Free Trial
            </button>
            <button
              onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}
              className="rounded-lg border border-slate-300 px-8 py-3 font-semibold text-slate-800 transition-colors hover:border-slate-400"
            >
              See Demo
            </button>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">Built for real contractor workflows</h2>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-slate-300"
              >
                <div className="mb-4">{feature.icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900">{feature.title}</h3>
                <p className="text-sm text-slate-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-3xl font-bold text-slate-900">One platform for quoting and estimating</h2>
          <p className="mt-4 text-slate-600">
            QuoteFly combines <strong>contractor quoting software</strong> and <strong>contractor estimating software</strong> so crews can move from lead details to priced scope and customer-ready PDF in one system.
          </p>
          <p className="mt-3 text-slate-600">
            Common use cases include HVAC estimate software workflows, plumbing estimate workflows, roofing replacement quotes, and flooring project pricing.
          </p>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">How it works</h2>

          <div className="space-y-8">
            {workflow.map((item) => (
              <div key={item.step} className="flex gap-6">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-quotefly-blue">
                  <span className="text-lg font-bold text-white">{item.step}</span>
                </div>
                <div>
                  <h3 className="mb-2 text-lg font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-slate-600">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">What contractors are saying</h2>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {testimonials.map((testimonial) => (
              <div
                key={testimonial.name}
                className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-slate-300"
              >
                <div className="mb-4">
                  <p className="font-semibold text-slate-900">
                    {testimonial.name} - <span className="text-quotefly-blue">{testimonial.location}</span>
                  </p>
                </div>
                <p className="text-slate-700 italic">"{testimonial.text}"</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-10 text-center text-3xl font-bold text-slate-900">Contractor quoting software FAQ</h2>
          <div className="space-y-4">
            {seoFaqs.map((faq) => (
              <article key={faq.q} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold text-slate-900">{faq.q}</h3>
                <p className="mt-2 text-slate-600">{faq.a}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Ready to stop losing time on quotes?</h2>
          <p className="mb-8 text-lg text-slate-600">
            Start your free trial today. Full access, clean setup, and a contractor-first workflow from day one.
          </p>
          <button
            onClick={onOpenAuth}
            className="rounded-lg bg-quotefly-blue px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-blue-600"
          >
            Start Free Trial Now
          </button>
        </div>
      </section>
    </div>
  );
}
