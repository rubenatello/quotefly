import { useEffect } from "react";
import { CheckIcon } from "../components/Icons";
import { setSEOMetadata } from "../lib/seo";

interface PricingPageProps {
  onOpenAuth: () => void;
}

export function PricingPage({ onOpenAuth }: PricingPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Pricing - QuoteFly",
      description:
        "Simple, transparent pricing for contractor teams. Start free for 14 days and upgrade when your crew needs more seats and automation.",
      keywords: "contractor software pricing, quote tool cost, contractor CRM pricing",
    });
  }, []);

  const plans = [
    {
      name: "Starter",
      price: "$19",
      period: "/month",
      description: "Live now for solo operators and lean crews that need customer tracking and quoting fast.",
      features: [
        "Up to 600 quotes/month",
        "30 AI quote drafts/month",
        "Quick customer intake and lead pipeline",
        "PDF quote generation",
        "Customer and quote status tracking",
        "7 team members",
        "30-day quote history",
      ],
      cta: "Start Free Trial",
      highlighted: true,
      availableNow: true,
      note: "Available now",
    },
    {
      name: "Professional",
      price: "$59",
      period: "/month",
      description: "Planned for the next release once advanced analytics, history, and accounting workflows are fully hardened.",
      features: [
        "Everything in Starter, plus:",
        "300 AI quote drafts/month",
        "Advanced analytics and reporting",
        "Customer communication log",
        "Quote versioning and history",
        "15 team members",
        "Accounting workflow upgrades",
      ],
      cta: "Coming Soon",
      highlighted: false,
      availableNow: false,
      note: "V2 roadmap",
    },
    {
      name: "Enterprise",
      price: "$249",
      period: "/month",
      description: "Planned after Professional for larger operations that need deeper automation and integration control.",
      features: [
        "Everything in Professional, plus:",
        "800 AI quote drafts/month",
        "Unlimited team members",
        "Advanced AI automation layer",
        "API access and audit logs",
        "Priority support and rollout planning",
      ],
      cta: "Coming Soon",
      highlighted: false,
      availableNow: false,
      note: "Later release",
    },
  ];

  const faqs = [
    {
      q: "Can I cancel anytime?",
      a: "Yes. There are no long-term contracts. Cancel anytime from your account billing settings.",
    },
    {
      q: "Is there a free trial?",
      a: "Yes. Every workspace starts with a 14-day free trial so you can test the CRM, quoting flow, and PDF output.",
    },
    {
      q: "Can I change plans later?",
      a: "Yes. Upgrade or downgrade from the admin billing area. Stripe handles the billing change and QuoteFly updates tenant access.",
    },
    {
      q: "Do you support QuickBooks?",
      a: "Not as a sellable launch feature. Starter is focused on customer management, quoting, and PDF workflow first. Accounting integrations are planned after launch.",
    },
    {
      q: "Do you offer annual billing?",
      a: "Not yet. We are keeping V1 simple with monthly billing first.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Simple, transparent pricing</h1>
          <p className="text-lg text-slate-600">
            Starter is the launch plan. It covers fast customer intake, quoting, and follow-up today. Advanced plans are being staged after the core workflow hardens.
          </p>

          <div className="mt-8 flex items-center justify-center gap-4">
            <span className="text-sm text-slate-600">Billed monthly</span>
            <span className="inline-flex items-center rounded-full border border-quotefly-blue/15 bg-quotefly-blue/[0.06] px-4 py-2 text-xs font-semibold text-quotefly-blue">
              Starter is live now
            </span>
          </div>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-lg border transition-colors ${
                  plan.highlighted
                    ? "border-quotefly-blue bg-quotefly-blue/5"
                    : "border-slate-200 bg-white shadow-sm hover:border-slate-300"
                }`}
              >
                {plan.highlighted && (
                  <div className="border-b border-quotefly-blue/20 bg-quotefly-blue/10 px-6 py-2 text-center text-sm font-semibold text-quotefly-blue">
                    Launch Plan
                  </div>
                )}

                <div className="p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-xl font-bold text-slate-900">{plan.name}</h3>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${plan.availableNow ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "border border-slate-200 bg-slate-50 text-slate-500"}`}>
                      {plan.note}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">{plan.description}</p>

                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-slate-900">{plan.price}</span>
                    <span className="text-slate-600">{plan.period}</span>
                  </div>

                  <button
                    onClick={plan.availableNow ? onOpenAuth : undefined}
                    disabled={!plan.availableNow}
                    className={`mt-6 w-full rounded-lg px-6 py-3 font-semibold transition-colors ${
                      plan.highlighted
                        ? "bg-quotefly-blue text-white hover:bg-blue-600"
                        : "border border-slate-300 text-slate-900"
                    } ${
                      !plan.availableNow ? "cursor-not-allowed bg-slate-100 text-slate-400" : ""
                    }`}
                  >
                    {plan.cta}
                  </button>

                  <div className="mt-8 space-y-3">
                    {plan.features.map((feature) => (
                      <div key={feature} className="flex items-start gap-3">
                        <CheckIcon size={16} className="mt-0.5 text-quotefly-blue" />
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
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">Frequently asked questions</h2>

          <div className="space-y-6">
            {faqs.map((faq) => (
              <div key={faq.q} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="mb-2 font-semibold text-slate-900">{faq.q}</h3>
                <p className="text-slate-600">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-slate-900">Start with Starter</h2>
          <p className="mb-8 text-lg text-slate-600">No credit card required. Full access to the launch workflow for 14 days.</p>
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
