import { useEffect } from "react";
import { setSEOMetadata } from "../lib/seo";

export function PrivacyPage() {
  useEffect(() => {
    setSEOMetadata({
      title: "Privacy Policy - QuoteFly",
      description: "Understand what data QuoteFly collects, why it is used, and how privacy requests are handled.",
    });
  }, []);

  const sections = [
    {
      title: "Information we collect",
      points: [
        "Account data such as name, email address, company name, role, and workspace membership.",
        "Customer and quote data that you add to the workspace, including names, phone numbers, emails, notes, pricing, and documents.",
        "Operational data such as sign-in activity, usage events, device or browser details, and billing metadata needed to run the service.",
      ],
    },
    {
      title: "How we use information",
      points: [
        "To operate the CRM, quoting, branding, export, and billing workflows.",
        "To secure accounts, prevent abuse, troubleshoot issues, and improve product performance.",
        "To communicate about the service, support requests, billing updates, and important account notices.",
      ],
    },
    {
      title: "How data is shared",
      points: [
        "We do not sell customer or workspace data.",
        "We share data only with service providers needed to operate the platform, such as hosting, database, authentication, and billing providers.",
        "We may disclose data when required by law or to protect the security and integrity of the service.",
      ],
    },
    {
      title: "Retention and deletion",
      points: [
        "Workspace data is retained while the account remains active and as needed for support, billing, and legal compliance.",
        "Some records may remain in backups or system logs for a limited period after deletion requests.",
        "You can contact support to request account closure or data export assistance.",
      ],
    },
    {
      title: "Your choices",
      points: [
        "You can manage cookie preferences on the website banner and review them in the Cookie Policy.",
        "You can request access, correction, or deletion help by emailing support@quotefly.us with 'Privacy Request' in the subject line.",
        "You remain responsible for the customer information you upload into the platform.",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-16 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Privacy Policy</p>
          <h1 className="mt-2 text-4xl font-bold text-slate-900">How QuoteFly handles personal data</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: April 10, 2026</p>
          <p className="mt-4 text-slate-600">
            This policy describes how QuoteFly collects, uses, stores, and discloses information when you use the service.
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
