import { ArrowRight, FileSpreadsheet, Landmark, ShieldCheck, Webhook } from "lucide-react";
import { Link } from "react-router-dom";

const INTEGRATION_ROADMAP = [
  {
    icon: FileSpreadsheet,
    status: "Available now",
    statusClass: "border-blue-200 bg-blue-50 text-blue-800",
    iconClass: "bg-blue-800 text-white",
    title: "QuickBooks-friendly CSV export",
    description:
      "Export reviewed accounting data for a file-based QuickBooks handoff. This is an export workflow, not a live QuickBooks connection.",
  },
  {
    icon: Landmark,
    status: "On the horizon",
    statusClass: "border-orange-200 bg-orange-50 text-orange-900",
    iconClass: "bg-[var(--qf-brand-orange)] text-[var(--qf-brand-orange-contrast)]",
    title: "QuickBooks Online",
    description:
      "The planned direction is a secure OAuth and API connection for reviewed invoice publishing and status reconciliation. No launch date is promised.",
  },
  {
    icon: Webhook,
    status: "Future exploration",
    statusClass: "border-slate-300 bg-slate-100 text-slate-700",
    iconClass: "bg-slate-900 text-white",
    title: "Broader accounting APIs",
    description:
      "Additional provider APIs and controlled QuoteFly webhooks will be evaluated from customer demand and provider readiness. EDI is not currently planned.",
  },
] as const;

const RELEASE_REQUIREMENTS = [
  "Secure provider authorization and tenant isolation",
  "Tax, duplicate, retry, and reconciliation safeguards",
  "Sandbox evidence, monitoring, rollback, and support readiness",
] as const;

export function IntegrationRoadmapSection() {
  return (
    <section
      id="integrations"
      className="scroll-mt-24 border-b border-slate-200 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
      aria-labelledby="integration-roadmap-heading"
    >
      <div className="mx-auto max-w-7xl">
        <div className="grid items-end gap-8 lg:grid-cols-[minmax(0,0.68fr)_minmax(300px,0.32fr)]">
          <div className="max-w-3xl">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-800">Integration roadmap</p>
            <h2
              id="integration-roadmap-heading"
              className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl"
            >
              Integrations on the horizon
            </h2>
            <p className="mt-5 text-base leading-7 text-slate-700">
              QuoteFly does not currently connect to QuickBooks Online or another external accounting platform. Today, Basic supports internal invoice records and a QuickBooks-friendly CSV export. Live provider connections remain unavailable until they are release-verified.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-[#f7f4ee] p-5">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-700">Roadmap snapshot · August 2026</p>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Customer demand helps set priority, but user count alone does not make an accounting integration ready.
            </p>
          </div>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {INTEGRATION_ROADMAP.map((item) => (
            <article
              key={item.title}
              className="relative overflow-hidden rounded-[1.75rem] border border-slate-200 bg-[#f8fbff] p-6 shadow-[0_16px_38px_rgba(15,23,42,0.06)]"
            >
              <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-700 via-blue-400 to-[var(--qf-brand-orange)]" />
              <div className="flex items-start justify-between gap-4">
                <span className={"inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl " + item.iconClass}>
                  <item.icon size={22} aria-hidden="true" />
                </span>
                <span className={"rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] " + item.statusClass}>
                  {item.status}
                </span>
              </div>
              <h3 className="mt-6 text-xl font-bold text-slate-950">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-700">{item.description}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 grid gap-6 rounded-[1.75rem] bg-slate-950 p-6 text-white shadow-[0_18px_46px_rgba(15,23,42,0.16)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:p-8">
          <div>
            <div className="flex items-center gap-3">
              <ShieldCheck size={22} className="text-orange-300" aria-hidden="true" />
              <h3 className="text-xl font-bold">What “ready” means at QuoteFly</h3>
            </div>
            <ul className="mt-5 grid gap-3 text-sm leading-6 text-slate-300 md:grid-cols-3">
              {RELEASE_REQUIREMENTS.map((requirement) => (
                <li key={requirement} className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-300" />
                  <span>{requirement}</span>
                </li>
              ))}
            </ul>
          </div>
          <Link
            to="/support#feature-request"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-slate-950 transition hover:-translate-y-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-300"
          >
            Request an integration
            <ArrowRight size={17} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
