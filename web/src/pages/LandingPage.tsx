import { useEffect } from "react";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { setPublicSEOMetadata } from "../lib/seo";
import { QuoteIcon, InvoiceIcon, CustomerIcon, SendIcon } from "../components/Icons";
import { LandingProductDemo } from "../components/marketing/LandingProductDemo";

const SEO_FAQS = [
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

interface LandingPageProps {
  onOpenAuth: () => void;
}

export function LandingPage({ onOpenAuth }: LandingPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/");
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
      mainEntity: SEO_FAQS.map((item) => ({
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

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduceMotion.matches || !("IntersectionObserver" in window)) return;

    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-landing-reveal]"));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("qf-reveal-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8%", threshold: 0.12 },
    );

    elements.forEach((element) => {
      if (element.getBoundingClientRect().top <= window.innerHeight * 0.92) {
        element.classList.add("qf-reveal-visible");
        return;
      }
      element.classList.add("qf-reveal-pending");
      observer.observe(element);
    });

    return () => observer.disconnect();
  }, []);

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
    <div className="min-h-screen overflow-hidden bg-stone-50 text-slate-900">
      <section className="relative isolate px-4 py-14 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div aria-hidden="true" className="pointer-events-none absolute -left-28 top-10 -z-10 h-80 w-80 rounded-full bg-quotefly-blue/[0.08] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-8 -z-10 h-72 w-72 rounded-full bg-quotefly-orange/[0.09] blur-3xl" />
        <div className="mx-auto grid max-w-7xl items-center gap-9 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:gap-12">
          <div className="text-center lg:text-left">
            <div className="qf-hero-badge mb-5 inline-flex items-center gap-2 rounded-full border border-quotefly-blue/15 bg-white/80 px-4 py-2 text-sm font-semibold text-quotefly-blue shadow-sm backdrop-blur">
              <Sparkles size={15} aria-hidden="true" />
              Free for 14 days. No credit card required.
            </div>

            <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-[-0.045em] text-slate-950 sm:text-5xl lg:mx-0 lg:text-[3.6rem] lg:leading-[1.04]">
              The easiest quoting software for <span className="relative whitespace-nowrap text-quotefly-blue">on-the-go<span aria-hidden="true" className="absolute inset-x-0 -bottom-1 h-1 rounded-full bg-quotefly-orange/70" /></span> contractors and professionals
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600 sm:text-xl lg:mx-0">
              Find the customer, price the work, preview the quote, and keep follow-up moving—without going back to the office.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <button
                type="button"
                onClick={onOpenAuth}
                className="qf-primary-cta group inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-quotefly-blue px-7 py-3 font-semibold text-white shadow-[0_12px_28px_rgba(47,111,214,0.24)] transition duration-200 hover:-translate-y-0.5 hover:bg-blue-600 hover:shadow-[0_16px_34px_rgba(47,111,214,0.3)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-blue/25"
              >
                Start Free Trial
                <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
              </button>
              <a
                href="#workflow"
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white/75 px-7 py-3 font-semibold text-slate-800 transition duration-200 hover:-translate-y-0.5 hover:border-slate-400 hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300/60"
              >
                See how it works
              </a>
            </div>

            <div className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-slate-600 lg:justify-start">
              {["Customer-first workflow", "Mobile-ready", "Branded quote PDFs"].map((item) => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Check size={12} aria-hidden="true" /></span>
                  {item}
                </span>
              ))}
            </div>
          </div>

          <LandingProductDemo />
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div data-landing-reveal className="mx-auto mb-12 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-quotefly-blue">Built for the field</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-950 sm:text-4xl">Everything needed to move a quote forward</h2>
            <p className="mt-4 text-slate-600">Focused tools for the work between a new customer request and a confident yes.</p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, index) => (
              <div
                key={feature.title}
                data-landing-reveal
                style={{ transitionDelay: `${index * 55}ms` }}
                className="qf-hover-lift rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition duration-200 hover:-translate-y-1 hover:border-quotefly-blue/25 hover:shadow-[0_18px_38px_rgba(15,23,42,0.09)]"
              >
                <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50">{feature.icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900">{feature.title}</h3>
                <p className="text-sm leading-6 text-slate-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-24 border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div data-landing-reveal className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
          <h2 className="text-3xl font-bold text-slate-900">One platform for quoting and estimating</h2>
          <p className="mt-4 text-slate-600">
            QuoteFly combines <strong>contractor quoting software</strong> and <strong>contractor estimating software</strong> so crews can move from lead details to priced scope and customer-ready PDF in one system.
          </p>
          <p className="mt-3 text-slate-600">
            Common use cases include HVAC estimate software workflows, plumbing estimate workflows, roofing replacement quotes, and flooring project pricing.
          </p>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="how-it-works-heading">
        <div className="mx-auto max-w-4xl">
          <div data-landing-reveal className="mb-12 text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-quotefly-blue">A clean path from lead to quote</p>
            <h2 id="how-it-works-heading" className="mt-3 text-3xl font-bold text-slate-950 sm:text-4xl">How it works</h2>
          </div>

          <div className="relative grid gap-4 md:grid-cols-4">
            <div aria-hidden="true" className="absolute left-[12.5%] right-[12.5%] top-6 hidden h-px bg-gradient-to-r from-quotefly-blue/20 via-quotefly-blue/60 to-quotefly-orange/40 md:block" />
            {workflow.map((item, index) => (
              <div
                key={item.step}
                data-landing-reveal
                style={{ transitionDelay: `${index * 55}ms` }}
                className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-quotefly-blue shadow-[0_8px_20px_rgba(47,111,214,0.2)]">
                  <span className="text-lg font-bold text-white">{item.step}</span>
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div data-landing-reveal className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
          <h2 className="text-3xl font-bold text-slate-900">Evaluate the complete workflow during your trial</h2>
          <p className="mt-4 text-slate-600">
            Add a sample customer, build a quote from your own job scope, review the PDF, and test the phone sharing flow before deciding whether QuoteFly fits your business.
          </p>
          <p className="mt-3 text-sm text-slate-500">
            QuoteFly does not promise a specific close-rate or time-saving result. The trial is the clearest way to evaluate the current product with your process.
          </p>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-10 text-center text-3xl font-bold text-slate-900">Contractor quoting software FAQ</h2>
          <div className="space-y-4">
            {SEO_FAQS.map((faq) => (
              <article key={faq.q} data-landing-reveal className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold text-slate-900">{faq.q}</h3>
                <p className="mt-2 text-slate-600">{faq.a}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-20 sm:px-6 lg:px-8">
        <div data-landing-reveal className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl bg-slate-950 px-6 py-12 text-center shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:px-12">
          <div aria-hidden="true" className="absolute -left-16 -top-20 h-56 w-56 rounded-full bg-quotefly-blue/30 blur-3xl" />
          <div aria-hidden="true" className="absolute -bottom-24 -right-12 h-56 w-56 rounded-full bg-quotefly-orange/25 blur-3xl" />
          <h2 className="relative mb-4 text-3xl font-bold text-white sm:text-4xl">Ready to stop losing time on quotes?</h2>
          <p className="relative mx-auto mb-8 max-w-2xl text-lg text-slate-300">
            Start your free trial today. Full access, clean setup, and a contractor-first workflow from day one.
          </p>
          <button
            type="button"
            onClick={onOpenAuth}
            className="relative inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-8 py-3 text-lg font-semibold text-slate-950 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
          >
            Start Free Trial Now
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}
