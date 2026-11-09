import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileSpreadsheet } from "lucide-react";
import { MarketingAction, MarketingHero } from "../components/marketing/PublicPageLayout";
import { QUICKBOOKS_CANDIDATE_WORKFLOW, QUICKBOOKS_PUBLIC_FAQS, QUICKBOOKS_PUBLIC_STATUS } from "../lib/public-integration-data";
import { setPublicSEOMetadata } from "../lib/seo";

export function QuickBooksIntegrationPage() {
  useEffect(() => setPublicSEOMetadata(QUICKBOOKS_PUBLIC_STATUS.path), []);

  return (
    <div className="bg-[#f7f4ee] text-slate-900">
      <nav aria-label="Breadcrumb" className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 text-sm sm:px-6">
        <Link to="/" className="inline-flex min-h-11 items-center text-blue-800 underline underline-offset-4">Home</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">QuickBooks</span>
      </nav>
      <MarketingHero
        eyebrow={QUICKBOOKS_PUBLIC_STATUS.label}
        title="QuoteFly and QuickBooks Online"
        description={<p>{QUICKBOOKS_PUBLIC_STATUS.summary}</p>}
        meta={<>Updated by QuoteFly · <time dateTime={QUICKBOOKS_PUBLIC_STATUS.updated}>{QUICKBOOKS_PUBLIC_STATUS.updatedLabel}</time></>}
        actions={<>
          <MarketingAction href="/pricing#basic-plan" icon={<ArrowRight size={18} aria-hidden="true" />}>See current features and pricing</MarketingAction>
          <MarketingAction href="/support#feature-request" variant="secondary">Request integration updates</MarketingAction>
        </>}
      />
      <section aria-labelledby="available-accounting-heading" className="border-b border-slate-200 bg-white px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-2">
          <div>
            <FileSpreadsheet size={28} className="text-blue-800" aria-hidden="true" />
            <h2 id="available-accounting-heading" className="mt-4 text-2xl font-bold">Available now: CSV export</h2>
            <p className="mt-4 leading-7 text-slate-700">Keep customer, quote, Job, and internal invoice records in QuoteFly, then export reviewed accounting data for a file-based QuickBooks handoff. Review the file with your bookkeeper before importing it.</p>
            <p className="mt-4 leading-7 text-slate-700">CSV export does not establish a live connection or automatically reconcile payments.</p>
          </div>
          <div className="border-l-4 border-orange-400 pl-6">
            <h2 className="text-2xl font-bold">Verified in staging: sandbox connection</h2>
            <p className="mt-4 leading-7 text-slate-700">{QUICKBOOKS_PUBLIC_STATUS.connection}</p>
            <p className="mt-4 font-semibold leading-7 text-slate-900">A successful sandbox connection is not a production release. Direct accounting features remain unavailable to customers.</p>
          </div>
        </div>
      </section>
      <section aria-labelledby="candidate-workflow-heading" className="px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-bold uppercase tracking-widest text-blue-800">Under validation</p>
          <h2 id="candidate-workflow-heading" className="mt-3 text-3xl font-bold">The invoice workflow being tested</h2>
          <p className="mt-4 max-w-3xl leading-7 text-slate-700">{QUICKBOOKS_PUBLIC_STATUS.candidateScope}</p>
          <ol className="mt-8 grid gap-6 md:grid-cols-2">
            {QUICKBOOKS_CANDIDATE_WORKFLOW.map((step, index) => <li key={step.title} className="border-t border-slate-300 pt-5">
              <p className="text-sm font-bold text-blue-800">Step {index + 1} · Pending validation</p>
              <h3 className="mt-2 text-xl font-bold">{step.title}</h3>
              <p className="mt-3 leading-7 text-slate-700">{step.description}</p>
            </li>)}
          </ol>
          <p className="mt-8 max-w-3xl leading-7 text-slate-700">Before availability is announced, validation must cover duplicate prevention, retries, access controls, accounting accuracy, recovery, and operational support. No launch date is promised.</p>
        </div>
      </section>
      <section aria-labelledby="quickbooks-questions-heading" className="border-t border-slate-200 bg-white px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto max-w-4xl">
          <h2 id="quickbooks-questions-heading" className="text-3xl font-bold">QuickBooks integration questions</h2>
          <div className="mt-8 divide-y divide-slate-200">
            {QUICKBOOKS_PUBLIC_FAQS.map((faq) => <div key={faq.question} className="py-6 first:pt-0">
              <h3 className="text-lg font-bold">{faq.question}</h3>
              <p className="mt-3 leading-7 text-slate-700">{faq.answer}</p>
            </div>)}
          </div>
          <MarketingAction href="/support#feature-request" variant="secondary" className="mt-4">Request integration updates</MarketingAction>
          <p className="mt-8 text-sm leading-6 text-slate-600">QuickBooks is a trademark of Intuit Inc. This page describes QuoteFly's integration status and does not imply Intuit endorsement.</p>
        </div>
      </section>
    </div>
  );
}
