import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

interface PricingPageProps {
  onOpenAuth: () => void;
}

export function PricingPage({ onOpenAuth }: PricingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Pricing - QuoteFly",
      description:
        "Simple, transparent pricing. Start free for 14 days. No hidden fees. Choose the plan that works for your team.",
      keywords: "contractor software pricing, quote tool cost, HVAC software pricing",
    });
  }, []);

  const plans = [
    {
      name: "Starter",
      price: "$29",
      period: "/month",
      description: "Perfect for solo contractors",
      features: [
        "Up to 600 quotes/month",
        "SMS job capture",
        "Auto-pricing from base rates",
        "PDF quote generation",
        "3 team members",
        "Email support",
        "30-day quote history",
      ],
      cta: "Start Free Trial",
      highlighted: false,
    },
    {
      name: "Professional",
      price: "$79",
      period: "/month",
      description: "Best for growing teams",
      features: [
        "Up to 5,000 quotes/month",
        "Everything in Starter, plus:",
        "Advanced analytics and reporting",
        "Customer communication log",
        "Quote versioning and history",
        "10 team members",
        "Multi-trade support",
        "Priority email and chat support",
        "180-day quote history",
      ],
      cta: "Start Free Trial",
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "$399",
      period: "/month",
      description: "For larger operations that need governance and scale",
      features: [
        "Everything in Professional, plus:",
        "Unlimited quotes",
        "Unlimited team members",
        "Advanced AI automation layer",
        "QuickBooks Online integration",
        "Custom branding",
        "API access",
        "Dedicated account manager",
        "SLA and priority support",
        "Custom integrations",
        "Audit logs",
      ],
      cta: "Start Free Trial",
      highlighted: false,
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Simple, Transparent Pricing</h1>
          <p className="text-lg text-slate-600">
            Choose the plan that fits your business. Upgrade or downgrade anytime.
          </p>

          <div className="mt-8 flex items-center justify-center gap-4">
            <span className="text-sm text-slate-600">Billed Monthly</span>
            <button className="inline-flex items-center rounded-full border border-quotefly-blue bg-quotefly-blue/10 px-4 py-2">
              <span className="text-xs font-semibold text-quotefly-blue">Coming Soon: Save 20% on Annual</span>
            </button>
          </div>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan, idx) => (
              <div
                key={idx}
                className={`rounded-lg border transition-colors ${
                  plan.highlighted
                    ? "border-quotefly-blue bg-quotefly-blue/5"
                    : "border-slate-200 bg-white shadow-sm hover:border-slate-300"
                }`}
              >
                {plan.highlighted && (
                  <div className="border-b border-quotefly-blue/20 bg-quotefly-blue/10 px-6 py-2 text-center text-sm font-semibold text-quotefly-blue">
                    Most Popular
                  </div>
                )}

                <div className="p-6">
                  <h3 className="text-xl font-bold text-slate-900">{plan.name}</h3>
                  <p className="mt-2 text-sm text-slate-600">{plan.description}</p>

                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-slate-900">{plan.price}</span>
                    {plan.period && <span className="text-slate-600">{plan.period}</span>}
                  </div>

                  <button
                    onClick={onOpenAuth}
                    className={`mt-6 w-full rounded-lg px-6 py-3 font-semibold transition-colors ${
                      plan.highlighted
                        ? "bg-quotefly-blue text-white hover:bg-blue-600"
                        : "border border-slate-300 text-slate-900 hover:border-slate-400"
                    }`}
                  >
                    {plan.cta}
                  </button>

                  <div className="mt-8 space-y-3">
                    {plan.features.map((feature, fidx) => (
                      <div key={fidx} className="flex items-start gap-3">
                        <span className="mt-1 text-quotefly-blue">✓</span>
                        <span
                          className={`text-sm ${
                            feature.includes("Everything") || feature.includes("plus:")
                              ? "font-semibold text-slate-900"
                              : "text-slate-600"
                          }`}
                        >
                          {feature}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">Frequently Asked Questions</h2>

          <div className="space-y-6">
            {[
              {
                q: "Can I cancel anytime?",
                a: "Yes. No contracts. Cancel anytime from your account settings.",
              },
              {
                q: "Is there a free trial?",
                a: "Yes. 14 days free. Full access to all features on any plan.",
              },
              {
                q: "Can I change plans?",
                a: "Absolutely. Upgrade or downgrade anytime. Changes take effect on your next billing cycle.",
              },
              {
                q: "What payment methods do you accept?",
                a: "We accept all major credit cards via Stripe. Annual invoicing is available for larger contracts.",
              },
              {
                q: "Do you offer discounts for annual billing?",
                a: "Coming soon. We plan to offer 20% off for annual plans.",
              },
            ].map((faq, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="mb-2 font-semibold text-slate-900">{faq.q}</h3>
                <p className="text-slate-600">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Start Your Free Trial Today</h2>
          <p className="mb-8 text-lg text-slate-600">No credit card required. Full access. 14 days free.</p>
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
