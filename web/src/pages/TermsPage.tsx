import { useEffect } from "react";
import { ScrollText } from "lucide-react";
import { PolicyPageLayout, PolicySection } from "../components/marketing/PublicPageLayout";
import { CURRENT_TERMS_UPDATED_LABEL } from "../lib/legal";
import { setPublicSEOMetadata } from "../lib/seo";

export function TermsPage() {
  useEffect(() => {
    setPublicSEOMetadata("/terms");
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
        "AI-assisted drafts may be incomplete or inaccurate. Review customer details, scope, line items, costs, and prices before saving or sending a quote.",
      ],
    },
  ];

  return (
    <PolicyPageLayout
      eyebrow="Terms of Service"
      title="Using QuoteFly"
      description="These terms describe the basic rules and responsibilities for using the QuoteFly service."
      updated={CURRENT_TERMS_UPDATED_LABEL}
      icon={ScrollText}
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
    </PolicyPageLayout>
  );
}
