import { useEffect } from "react";
import { BadgeDollarSign } from "lucide-react";
import { CheckIcon } from "../components/Icons";
import { MarketingCta, MarketingHero } from "../components/marketing/PublicPageLayout";
import { INFO_MAILTO } from "../lib/contact";
import { PUBLIC_BASIC_PLAN } from "../lib/public-seo-data";
import { setPublicSEOMetadata } from "../lib/seo";

interface PricingPageProps {
  onOpenAuth: () => void;
}

export function PricingPage({ onOpenAuth }: PricingPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/pricing");
  }, []);

  const plans = [
    {
      name: "Basic",
      price: `$${PUBLIC_BASIC_PLAN.monthlyPriceUsd}`,
      period: "/month",
      seats: `${PUBLIC_BASIC_PLAN.teamMembers} users included`,
      description: "Live now for solo operators and lean crews that need customer tracking and quoting fast.",
      offer: `${PUBLIC_BASIC_PLAN.trialDays}-day free trial · first paid month $${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}`,
      features: [
        `Up to ${PUBLIC_BASIC_PLAN.quotesPerMonth} quotes/month`,
        "Monthly AI usage included",
        "Quick customer intake and lead pipeline",
        "PDF quote generation",
        "Customer and quote status tracking",
        `${PUBLIC_BASIC_PLAN.teamMembers} team members`,
        `${PUBLIC_BASIC_PLAN.quoteHistoryDays}-day quote history`,
      ],
      cta: "Start Free Trial",
      highlighted: true,
      availableNow: true,
      note: "Available now",
      badge: "Most popular",
    },
    {
      name: "Professional",
      price: "$59",
      period: "/month",
      seats: "15 users included",
      description: "For growing teams that need deeper reporting, quote history, and accounting workflows.",
      offer: null,
      features: [
        "Everything in Basic, plus:",
        "Higher monthly AI allowance",
        "Advanced analytics and reporting",
        "Customer communication log",
        "Quote versioning and history",
        "15 team members",
        "Accounting workflow upgrades",
      ],
      cta: "Coming Soon",
      highlighted: false,
      availableNow: false,
      note: "Planned for V2",
      badge: "Coming soon",
    },
    {
      name: "Enterprise",
      price: "$249",
      period: "/month",
      seats: "Unlimited users",
      description: "For larger operations that need deeper automation, integration controls, and rollout support.",
      offer: null,
      features: [
        "Everything in Professional, plus:",
        "Expanded AI usage and automation",
        "Unlimited team members",
        "Advanced AI automation layer",
        "API access and audit logs",
        "Priority support and rollout planning",
      ],
      cta: "Coming Soon",
      highlighted: false,
      availableNow: false,
      note: "Planned for a later release",
      badge: "Coming soon",
    },
  ];

  const faqs = [
    {
      q: "What can each team role see?",
      a: "Owners and admins see the full workspace, product catalog, internal costs, and margins. Members work only with customers, follow-ups, jobs, and quotes assigned to them; internal costs and margins stay hidden.",
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes. There are no long-term contracts. Cancel anytime from your account billing settings.",
    },
    {
      q: "Is there a free trial?",
      a: `Yes. Every workspace starts with a ${PUBLIC_BASIC_PLAN.trialDays}-day free trial with no credit card required, so you can test the CRM, quoting flow, and PDF output.`,
    },
    {
      q: "How does the first-month discount work?",
      a: `If you choose Basic, the first paid month is $${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)} (${PUBLIC_BASIC_PLAN.firstPaidMonthDiscountPercent}% off). Basic is $${PUBLIC_BASIC_PLAN.monthlyPriceUsd}/month after that. The introductory discount applies once to an eligible workspace and is automatically added at checkout.`,
    },
    {
      q: "Can I change plans later?",
      a: "Yes. Upgrade or downgrade from the admin billing area. Stripe handles the billing change and QuoteFly updates tenant access.",
    },
    {
      q: "Do you support QuickBooks?",
      a: "QuickBooks integration is planned for a future plan. Basic currently focuses on customer management, quoting, branded PDFs, and follow-up.",
    },
    {
      q: "How does AI usage work?",
      a: "AI is metered by usage, not by quotes sent. The app shows a monthly progress bar and warns at 25%, 50%, 75%, 85%, 95%, and 100%. At 100%, Kody and AI tools pause until the monthly reset; manual edits remain available.",
    },
    {
      q: "Do you offer annual billing?",
      a: "Not yet. We are keeping V1 simple with monthly billing first.",
    },
  ];

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-slate-900">
      <MarketingHero
        eyebrow="Simple, honest pricing"
        icon={BadgeDollarSign}
        title="Contractor quoting software pricing"
        description={
          <>
            Start with QuoteFly Basic today. Additional plans will open as advanced reporting, team, and accounting features become available.
          </>
        }
        actions={
          <>
            <span className="text-sm font-medium text-slate-600">Billed monthly</span>
            <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-300 px-4 py-2 text-xs font-bold text-slate-950">
              Basic · Most popular
            </span>
          </>
        }
      />

      <section className="px-4 py-14 sm:px-6 sm:py-16 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-quotefly-blue">Compare plans</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Start with the plan built for quoting today</h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Basic is available now. Preview what is planned for growing teams while we finish Professional and Enterprise.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <article
                key={plan.name}
                aria-disabled={!plan.availableNow || undefined}
                className={`relative rounded-3xl border transition duration-200 ${
                  plan.highlighted
                    ? "border-quotefly-blue bg-gradient-to-b from-blue-50 to-white shadow-[0_18px_46px_rgba(47,111,214,0.16)] lg:-translate-y-2"
                    : "border-slate-200 bg-slate-100/80 shadow-[0_8px_24px_rgba(15,23,42,0.04)]"
                }`}
              >
                <span
                  className={`absolute -right-2 -top-3 z-10 rounded-full border px-3 py-1.5 text-xs font-bold shadow-sm ${
                    plan.availableNow
                      ? "border-orange-400 bg-orange-300 text-slate-950"
                      : "border-slate-300 bg-slate-200 text-slate-600"
                  }`}
                >
                  {plan.badge}
                </span>

                <div className={`p-6 ${plan.availableNow ? "" : "opacity-65"}`}>
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
                  {plan.offer ? (
                    <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                      {plan.offer}
                    </p>
                  ) : null}
                  <div className="mt-3 inline-flex rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-bold text-blue-800">
                    {plan.seats}
                  </div>

                  <button
                    onClick={plan.availableNow ? onOpenAuth : undefined}
                    disabled={!plan.availableNow}
                    className={`mt-6 min-h-12 w-full rounded-xl px-6 py-3 font-semibold transition duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-blue/20 ${
                      plan.highlighted
                        ? "bg-quotefly-blue text-white shadow-[0_10px_24px_rgba(47,111,214,0.22)] hover:-translate-y-0.5 hover:bg-blue-600"
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
                        <CheckIcon size={16} className={`mt-0.5 ${plan.availableNow ? "text-quotefly-blue" : "text-slate-400"}`} />
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
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-slate-900">Frequently asked questions</h2>

          <div className="space-y-6">
            {faqs.map((faq) => (
              <div key={faq.q} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.045)]">
                <h3 className="mb-2 font-semibold text-slate-900">{faq.q}</h3>
                <p className="text-slate-600">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta
        title="Start with Basic"
        description={`No credit card required. Get full access for ${PUBLIC_BASIC_PLAN.trialDays} days. If you continue, your first paid month is $${PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}, then $${PUBLIC_BASIC_PLAN.monthlyPriceUsd}/month.`}
        actionLabel="Start Free Trial"
        onAction={onOpenAuth}
        supportingText={
          <>
            AI usage applies only when you draft or revise with AI. Have a sales or plan question?{" "}
            <a href={INFO_MAILTO} className="font-semibold text-blue-300 hover:text-blue-200">
              Email our team
            </a>
            .
          </>
        }
      />
    </div>
  );
}
