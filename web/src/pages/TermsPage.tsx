import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

export function TermsPage() {
  useEffect(() => {
    setSEOMetadata({
      title: "Terms of Service - QuoteFly",
      description: "Review the service terms for using QuoteFly, including billing, acceptable use, and account responsibilities.",
    });
  }, []);

  const sections = [
    {
      title: "Accounts and workspace responsibility",
      points: [
        "You are responsible for keeping account credentials secure and for activity that happens under your workspace.",
        "Workspace owners control team access, role assignments, and the customer data entered into the service.",
      ],
    },
    {
      title: "Acceptable use",
      points: [
        "Do not use QuoteFly for unlawful activity, abusive conduct, or to upload data you do not have the right to process.",
        "Do not attempt to disrupt, reverse engineer, or bypass access controls in the application.",
      ],
    },
    {
      title: "Billing",
      points: [
        "Paid plans are billed through Stripe on a recurring basis unless canceled.",
        "Plan changes affect seat limits and feature access tied to the workspace.",
        "You are responsible for keeping billing details current and resolving failed payments promptly.",
      ],
    },
    {
      title: "Service changes",
      points: [
        "QuoteFly may update features, pricing, and service capabilities over time.",
        "We may suspend or limit access when necessary for security, abuse prevention, or unpaid billing issues.",
      ],
    },
    {
      title: "Disclaimers",
      points: [
        "QuoteFly is provided on an as-available basis while the product continues to mature.",
        "You remain responsible for verifying quotes, pricing, customer communications, and downstream accounting imports before relying on them.",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-16 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Terms of Service</p>
          <h1 className="mt-2 text-4xl font-bold text-slate-900">Using QuoteFly</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: April 10, 2026</p>
          <p className="mt-4 text-slate-600">
            These terms describe the basic rules and responsibilities for using the QuoteFly service.
          </p>
        </div>

        {sections.map((section) => (
          <section key={section.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">{section.title}</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-600">
              {section.points.map((point) => (
                <li key={point} className="flex gap-3">
                  <span className="text-quotefly-blue">+</span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
