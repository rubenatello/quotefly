import { useEffect } from "react";
import { Database } from "lucide-react";
import { PolicyPageLayout, PolicySection } from "../components/marketing/PublicPageLayout";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/contact";
import { setPublicSEOMetadata } from "../lib/seo";

export function DataPrivacyPage() {
  useEffect(() => {
    setPublicSEOMetadata("/data-privacy");
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
      title: "AI-assisted features",
      text:
        "When a user invokes AI-assisted quoting, QuoteFly may send the prompt and relevant customer, activity, pricing, saved-job, or quote context to OpenAI. AI output is a draft for human review, and prompts plus usage details may be retained in the workspace for operational and quality review.",
    },
    {
      title: "Retention and export",
      text:
        "Customers control the records they add to QuoteFly. The current export paths include PDF quotes and QuickBooks-compatible CSV files. Direct QuickBooks sync remains a staged integration and is not presented as a launch feature.",
    },
    {
      title: "Reporting a concern",
      text: null,
    },
  ];

  return (
    <PolicyPageLayout
      eyebrow="Data Privacy"
      title="Data handling and security posture"
      description="This page explains the practical controls and product design choices that protect workspace data."
      updated="July 30, 2026"
      icon={Database}
    >
        {sections.map((section) => (
          <PolicySection key={section.title} title={section.title}>
            {section.text ? (
              <p className="mt-5 text-sm leading-6 text-slate-600">{section.text}</p>
            ) : (
              <p className="mt-5 text-sm leading-6 text-slate-600">
                If you believe data has been exposed or mishandled, email{" "}
                <a className="font-semibold text-quotefly-blue hover:text-blue-700" href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>{" "}
                with “Security” or “Privacy Request” in the subject line and include the affected workspace details.
              </p>
            )}
          </PolicySection>
        ))}
    </PolicyPageLayout>
  );
}
