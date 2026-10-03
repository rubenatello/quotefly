// Public availability is evidence-based; a sandbox connection does not release a feature.
export const QUICKBOOKS_PUBLIC_STATUS = {
  path: "/integrations/quickbooks" as const,
  updated: "2026-09-13",
  updatedLabel: "September 13, 2026",
  label: "Staging validation · Not available to customers",
  summary: "QuoteFly supports a QuickBooks-friendly CSV export today. A direct QuickBooks Online integration is being validated in staging and is not available to customers.",
  connection: "A QuickBooks Online sandbox connection has been verified. Invoice publishing, payment links, and accounting reconciliation still require separate validation before release.",
  candidateScope: "The current validation candidate covers non-taxable invoices in USD with explicit mappings to existing QuickBooks customers and items. Final launch scope and availability have not been announced.",
} as const;

export const QUICKBOOKS_CANDIDATE_WORKFLOW = [
  { title: "Review the customer and item mappings", description: "Match the QuoteFly customer and invoice lines to existing QuickBooks Online records before publishing." },
  { title: "Publish a reviewed invoice", description: "Review a QuoteFly invoice, then explicitly publish it to QuickBooks Online. This is a specific invoice workflow, not a general two-way sync." },
  { title: "Use a provider-hosted payment link", description: "Where supported by the QuickBooks account, use the QuickBooks-hosted invoice payment experience. QuoteFly would not process the payment." },
  { title: "Reconcile accounting status", description: "Check QuickBooks records for payment, refund, and void changes, with signed notifications and recovery checks. These workflows still need provider validation." },
] as const;

export const QUICKBOOKS_PUBLIC_FAQS = [
  { question: "Does QuoteFly integrate with QuickBooks Online today?", answer: QUICKBOOKS_PUBLIC_STATUS.summary },
  { question: "What can I use for accounting today?", answer: "Use QuoteFly's internal invoice records and QuickBooks-friendly CSV export for a file-based accounting handoff. A CSV export does not automatically create or reconcile a QuickBooks invoice." },
  { question: "What has been verified?", answer: QUICKBOOKS_PUBLIC_STATUS.connection },
  { question: "Will it sync everything in both directions?", answer: "No broad two-way synchronization is promised. The candidate focuses on reviewed invoice publishing and accounting status reconciliation, using explicit customer and item mappings." },
  { question: "Will it support sales tax and multiple currencies?", answer: QUICKBOOKS_PUBLIC_STATUS.candidateScope + " Sales-tax synchronization and multi-currency support are not claimed." },
  { question: "Does QuoteFly process QuickBooks payments?", answer: "No. The candidate uses provider-hosted payment links where supported. Payment eligibility and processing belong to the provider; this capability is not yet available to QuoteFly customers." },
  { question: "When can I connect my business?", answer: "There is no announced launch date or integration-specific pricing. Contact QuoteFly support to request integration updates and share your accounting requirements. Choose a plan based on the features available today." },
] as const;
