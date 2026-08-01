import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { PolicyPageLayout, PolicySection } from "../components/marketing/PublicPageLayout";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/contact";
import { setPublicSEOMetadata } from "../lib/seo";

export function PrivacyPage() {
  useEffect(() => {
    setPublicSEOMetadata("/privacy");
  }, []);

  const sections = [
    {
      title: "Information we collect",
      points: [
        "Account data such as name, email address, company name, role, and workspace membership.",
        "Customer and quote data that you add to the workspace, including names, phone numbers, emails, addresses, notes, scopes, line items, internal costs, customer prices, and generated documents.",
        "AI inputs and usage records, including prompts, relevant customer or quote context, model details, and usage telemetry when you choose an AI-assisted feature.",
        "Operational data such as sign-in activity, usage events, device or browser details, and billing metadata needed to run the service.",
      ],
    },
    {
      title: "How we use information",
      points: [
        "To operate the CRM, quoting, branding, export, and billing workflows.",
        "To prepare quote drafts or revisions with OpenAI when you intentionally use an AI-assisted feature. You must review AI output before relying on or sending it.",
        "To secure accounts, prevent abuse, troubleshoot issues, and improve product performance.",
        "To communicate about the service, support requests, billing updates, and important account notices.",
      ],
    },
    {
      title: "How data is shared",
      points: [
        "We do not sell customer or workspace data.",
        "We share data with service providers needed to operate the platform, such as hosting, managed database, email or communications, authentication, and Stripe billing providers.",
        "When you use AI-assisted quoting, relevant prompt and workspace context is sent to OpenAI for processing. Connected QuickBooks or Twilio features may send data to those providers only when the integration is configured and used.",
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
        "You can manage optional analytics preferences from the Cookie Policy at any time. Optional analytics remain disabled until you opt in.",
        "You can request access, correction, deletion, or export help by emailing QuoteFly support with 'Privacy Request' in the subject line.",
        "You remain responsible for the customer information you upload into the platform.",
      ],
    },
  ];

  return (
    <PolicyPageLayout
      eyebrow="Privacy Policy"
      title="How QuoteFly handles personal data"
      description="This policy describes how QuoteFly collects, uses, stores, and discloses information when you use the service."
      updated="July 30, 2026"
      icon={ShieldCheck}
    >
        {sections.map((section) => (
          <PolicySection key={section.title} title={section.title}>
            <ul className="mt-5 space-y-3 text-sm leading-6 text-slate-600">
              {section.points.map((point) => (
                <li key={point} className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-quotefly-blue" aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </PolicySection>
        ))}

        <PolicySection title="Privacy requests" tone="accent">
          <p className="mt-4 text-sm leading-6 text-slate-700">
            Email <a className="font-semibold text-quotefly-blue hover:text-blue-700" href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> with
            “Privacy Request” in the subject line. You can also review or change optional analytics choices in the{" "}
            <Link className="font-semibold text-quotefly-blue hover:text-blue-700" to="/cookies">Cookie Policy</Link>.
          </p>
        </PolicySection>
    </PolicyPageLayout>
  );
}
