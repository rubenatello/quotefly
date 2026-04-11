import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

export function DataPrivacyPage() {
  useEffect(() => {
    setSEOMetadata({
      title: "Data Privacy and Security - QuoteFly",
      description: "Review QuoteFly's approach to tenant isolation, access controls, retention, and data handling.",
    });
  }, []);

  const sections = [
    {
      title: "Tenant separation",
      text:
        "QuoteFly is designed so each workspace is scoped by tenant and user membership. Users should only be able to access records tied to their own organization.",
    },
    {
      title: "Access controls",
      text:
        "Account access is role-based. Owners, admins, and members have different capabilities inside the workspace. Team seats and feature access are enforced by plan and membership.",
    },
    {
      title: "Authentication and billing",
      text:
        "Authentication is handled through account credentials and session tokens. Billing is managed through Stripe, and payment card details are not stored inside QuoteFly.",
    },
    {
      title: "Operational security",
      text:
        "We use hosted infrastructure providers to run the application, database, and website. We continue to harden logging, access reviews, and operational controls as the product matures.",
    },
    {
      title: "Retention and export",
      text:
        "Customers control the records they add to QuoteFly. Data export and accounting paths such as PDF quotes, QuickBooks CSV, and direct QuickBooks invoice sync are part of the product so you keep operational portability from the beginning.",
    },
    {
      title: "Reporting a concern",
      text:
        "If you believe data has been exposed or mishandled, email support@quotefly.us with 'Security' or 'Privacy Request' in the subject line and include the affected workspace details.",
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-16 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Data Privacy</p>
          <h1 className="mt-2 text-4xl font-bold text-slate-900">Data handling and security posture</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: April 10, 2026</p>
          <p className="mt-4 text-slate-600">
            This page explains the practical controls and product design choices that protect workspace data.
          </p>
        </div>

        {sections.map((section) => (
          <section key={section.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">{section.title}</h2>
            <p className="mt-4 text-sm leading-6 text-slate-600">{section.text}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
