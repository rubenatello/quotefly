import { useEffect } from "react";
import { BarChart3, FileCheck2, Send, Users } from "lucide-react";
import { setPublicSEOMetadata } from "../lib/seo";

interface ServicesPageProps {
  onOpenAuth: () => void;
}

const SERVICES = [
  {
    title: "Customer management",
    icon: Users,
    description: "Keep contact details, job notes, lead status, past quotes, and follow-up context together without adopting a heavyweight CRM.",
    details: ["Fast customer intake", "Searchable customer history", "Lead and follow-up status"],
  },
  {
    title: "Quotes and estimates",
    icon: FileCheck2,
    description: "Build clear scopes and line items with separate internal costs and customer-facing prices, then review every total before sending.",
    details: ["Labor and material line items", "Optional AI-assisted drafts", "Human review before sending"],
  },
  {
    title: "Branded delivery",
    icon: Send,
    description: "Generate a polished PDF with your business identity and open the phone's email, text, copy, or share flow when the quote is ready.",
    details: ["Branded PDF preview", "Phone-friendly sharing", "Outbound activity record"],
  },
  {
    title: "Pipeline analytics",
    icon: BarChart3,
    description: "See open work, quote value, status movement, and follow-up priorities without turning day-to-day quoting into reporting work.",
    details: ["Quote status visibility", "Customer follow-up queue", "Practical workspace metrics"],
  },
] as const;

export function ServicesPage({ onOpenAuth }: ServicesPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/services");
  }, []);

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">What QuoteFly does</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Customer management and quoting services in one simple app</h1>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              QuoteFly covers the practical path from a new customer request to a reviewed quote, branded PDF, and timely follow-up—on mobile or desktop.
            </p>
            <button
              type="button"
              onClick={onOpenAuth}
              className="mt-8 min-h-11 rounded-lg bg-quotefly-blue px-6 py-3 font-semibold text-white transition hover:bg-blue-700"
            >
              Start free trial
            </button>
          </div>
          <figure className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
            <img
              src="/quote-workflow.jpg"
              alt="Illustration of QuoteFly customer management, estimate building, and quote sharing"
              width="1280"
              height="960"
              loading="eager"
              decoding="async"
              className="h-auto w-full"
            />
            <figcaption className="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-500">
              Illustrative customer-to-quote workflow; the current interface may vary.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-bold">A focused toolkit for small service businesses</h2>
            <p className="mt-3 text-slate-600">Start with the essentials and keep the workflow understandable for owners, office staff, and technicians in the field.</p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {SERVICES.map((service) => {
              const Icon = service.icon;
              return (
                <article key={service.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-quotefly-blue/10 text-quotefly-blue">
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold">{service.title}</h2>
                  <p className="mt-3 leading-7 text-slate-600">{service.description}</p>
                  <ul className="mt-5 space-y-2 text-sm text-slate-700">
                    {service.details.map((detail) => (
                      <li key={detail} className="flex gap-3">
                        <span className="font-bold text-quotefly-blue">+</span>
                        <span>{detail}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl rounded-2xl bg-slate-900 p-8 text-center text-white sm:p-12">
          <h2 className="text-3xl font-bold">Built to stay easy as the work gets busy</h2>
          <p className="mx-auto mt-4 max-w-2xl text-slate-300">Try the complete customer-to-quote workflow with your own sample job before relying on it for live work.</p>
          <button
            type="button"
            onClick={onOpenAuth}
            className="mt-7 min-h-11 rounded-lg bg-white px-6 py-3 font-semibold text-slate-900 transition hover:bg-slate-100"
          >
            Start free trial
          </button>
        </div>
      </section>
    </div>
  );
}
