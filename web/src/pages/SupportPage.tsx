import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

interface SupportPageProps {
  onOpenAuth: () => void;
}

export function SupportPage({ onOpenAuth }: SupportPageProps) {
  useEffect(() => {
    setSEOMetadata({
      title: "Support - QuoteFly",
      description:
        "Get help with billing, setup, quote workflows, and workspace issues in QuoteFly.",
    });
  }, []);

  const supportAreas = [
    {
      title: "Account and billing help",
      text: "Plan changes, Stripe billing issues, seat limits, and workspace access questions.",
    },
    {
      title: "Quote workflow help",
      text: "Customer setup, quote drafting, template questions, PDF output, and QuickBooks-friendly CSV export.",
    },
    {
      title: "Technical troubleshooting",
      text: "Login issues, browser problems, mobile layout bugs, and performance concerns.",
    },
  ];

  const responseTargets = [
    { plan: "Starter", target: "Within 2 business days" },
    { plan: "Professional", target: "Within 1 business day" },
    { plan: "Enterprise", target: "Priority handling, same business day when possible" },
  ];

  const checklist = [
    "Your company name and workspace email",
    "A short summary of the issue",
    "Screenshots or screen recording when relevant",
    "The page or action where the issue happened",
    "Whether it happened on desktop or mobile",
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Support</h1>
          <p className="text-lg text-slate-600">
            When something blocks your workflow, we want the next step to be obvious.
          </p>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-2xl font-bold text-slate-900">Contact support</h2>
              <p className="mt-3 text-slate-600">
                Email{" "}
                <a href="mailto:support@quotefly.us" className="font-semibold text-quotefly-blue hover:text-blue-700">
                  support@quotefly.us
                </a>{" "}
                and include enough detail for us to reproduce the issue quickly.
              </p>
              <p className="mt-3 text-sm text-slate-500">
                V1 support is email-first. We are optimizing for fast, clear responses before we add more channels.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {supportAreas.map((area) => (
                <div key={area.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">{area.title}</h3>
                  <p className="mt-2 text-sm text-slate-600">{area.text}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Before you email us</h2>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {checklist.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="text-quotefly-blue">+</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Response targets</h2>
              <div className="mt-4 space-y-3">
                {responseTargets.map((target) => (
                  <div key={target.plan} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="font-semibold text-slate-900">{target.plan}</p>
                    <p className="mt-1 text-sm text-slate-600">{target.target}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-6">
              <h2 className="text-xl font-semibold text-slate-900">New to QuoteFly?</h2>
              <p className="mt-3 text-sm text-slate-700">
                The fastest way to evaluate the product is to create a workspace, add one customer, draft one quote, and export one invoice CSV. That shows the real workflow immediately.
              </p>
              <button
                onClick={onOpenAuth}
                className="mt-4 rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
              >
                Start Free Trial
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
