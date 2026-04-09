import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";
import { QuoteIcon, InvoiceIcon, CustomerIcon, SendIcon } from "../components/Icons";

interface LandingPageProps {
  onOpenAuth: () => void;
}

export function LandingPage({ onOpenAuth }: LandingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "QuoteFly - Fast Quote Generation for Contractors",
      description:
        "Generate professional quotes instantly from job texts. Save hours on paperwork. Start your free 14-day trial today.",
      keywords:
        "contractor quoting software, quote generator, HVAC quotes, plumbing quotes, free trial",
      ogType: "website",
    });
  }, []);

  const testimonials = [
    {
      name: "Mike Johnson",
      trade: "HVAC Contractor",
      text: "QuoteFly cut my quoting time in half. I used to spend 2 hours writing quotes by hand. Now it's instant.",
      image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Mike",
    },
    {
      name: "Sarah Williams",
      trade: "Plumbing Company Owner",
      text: "The SMS integration is a game-changer. Customers text details, I review and send in minutes. Love it.",
      image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah",
    },
    {
      name: "Tom Garcia",
      trade: "Flooring Specialist",
      text: "Our close rate went up 20% since we started sending quotes same-day with QuoteFly.",
      image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Tom",
    },
  ];

  const features = [
    {
      icon: <SendIcon size={32} className="text-quotefly-blue" />,
      title: "SMS-to-Quote",
      description: "Customers text job details. QuoteFly auto-generates accurate quotes in seconds.",
    },
    {
      icon: <QuoteIcon size={32} className="text-quotefly-orange" />,
      title: "Smart Pricing",
      description: "Set base rates and markups once. QuoteFly applies them automatically to every job.",
    },
    {
      icon: <InvoiceIcon size={32} className="text-quotefly-gold" />,
      title: "Professional PDFs",
      description: "Share polished, branded quotes that look like they took hours to create.",
    },
    {
      icon: <CustomerIcon size={32} className="text-quotefly-blue" />,
      title: "Built for Contractors",
      description: "Designed by people who understand trade workflows. No unnecessary complexity.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      {/* Hero Section */}
      <section className="relative overflow-hidden px-4 py-20 sm:px-6 sm:py-32 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-block">
            <span className="rounded-full bg-quotefly-blue/10 px-4 py-2 text-sm font-medium text-quotefly-blue">
              ✨ Free for 14 days. No credit card required.
            </span>
          </div>

          <h1 className="mb-6 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
            Generate Quotes in Seconds, Not Hours
          </h1>

          <p className="mb-8 text-lg text-slate-600 sm:text-xl">
            Stop wasting time on paperwork. QuoteFly turns SMS job details into professional quotes
            automatically. More quotes sent = more jobs won.
          </p>

          <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
            <button
              onClick={onOpenAuth}
              className="rounded-lg bg-quotefly-blue px-8 py-3 font-semibold text-white hover:bg-blue-600 transition-colors"
            >
              Start Free Trial
            </button>
            <button
              onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}
              className="rounded-lg border border-slate-300 px-8 py-3 font-semibold text-slate-800 hover:border-slate-400 transition-colors"
            >
              See Demo
            </button>
          </div>
        </div>
      </section>

      {/* Feature Cards */}
      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">Why Contractors Love QuoteFly</h2>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm hover:border-slate-300 transition-colors"
              >
                <div className="mb-4">{feature.icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900">{feature.title}</h3>
                <p className="text-sm text-slate-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">How It Works</h2>

          <div className="space-y-8">
            {[
              {
                step: "1",
                title: "Customer Texts Job Details",
                description: "They describe the work via SMS. Details go straight to your inbox.",
              },
              {
                step: "2",
                title: "Your Pricing Applied Instantly",
                description: "QuoteFly uses your base rates and markup rules to generate accurate pricing.",
              },
              {
                step: "3",
                title: "Review & Send in Seconds",
                description: "Approve the quote or make tweaks. Send to customer with one click.",
              },
              {
                step: "4",
                title: "Customer Gets Professional Quote",
                description: 'Branded PDF delivered via SMS or email. They sign and approve digitally.',
              },
            ].map((item, idx) => (
              <div key={idx} className="flex gap-6">
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

      {/* Testimonials */}
      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">What Contractors Are Saying</h2>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {testimonials.map((testimonial, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm hover:border-slate-300 transition-colors"
              >
                <div className="mb-4 flex gap-4">
                  <img
                    src={testimonial.image}
                    alt={testimonial.name}
                    className="h-12 w-12 rounded-full"
                  />
                  <div>
                    <h3 className="font-semibold text-slate-900">{testimonial.name}</h3>
                    <p className="text-sm text-quotefly-blue">{testimonial.trade}</p>
                  </div>
                </div>
                <p className="text-slate-700 italic">"{testimonial.text}"</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="border-t border-slate-200 px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Ready to Save Hours on Quotes?</h2>
          <p className="mb-8 text-lg text-slate-600">
            Start your free 14-day trial today. No credit card required. Full access to all features.
          </p>
          <button
            onClick={onOpenAuth}
            className="rounded-lg bg-quotefly-blue px-8 py-4 text-lg font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            Start Free Trial Now
          </button>
        </div>
      </section>
    </div>
  );
}
