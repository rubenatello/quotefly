import { ArrowRight, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import { MarketingAction } from "./PublicPageLayout";

interface LandingProductShowcaseProps {
  onOpenAuth: () => void;
}

const DEMO_LABEL = "Actual QuoteFly interface · Sanitized demo data";

export function LandingProductShowcase({ onOpenAuth }: LandingProductShowcaseProps) {
  return (
    <section
      id="product-story"
      aria-labelledby="product-story-heading"
      className="scroll-mt-24 border-y border-slate-800 bg-slate-950 px-4 py-16 text-white sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-7xl">
        <div data-marketing-reveal className="grid items-end gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-300">The real QuoteFly workspace</p>
            <h2 id="product-story-heading" className="mt-3 max-w-3xl text-3xl font-bold tracking-[-0.035em] sm:text-4xl lg:text-5xl">
              See what needs attention. Move the next job.
            </h2>
          </div>
          <div>
            <p className="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              QuoteFly keeps leads, quotes, follow-up, and Kody in one practical workspace—from your phone in the field to your desktop at the office. These screens use demo data, but what you see is the real product.
            </p>
            <p className="mt-3 flex items-start gap-2 text-sm text-slate-400">
              <ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
              Customer contact details are removed from public product images.
            </p>
          </div>
        </div>

        <figure data-marketing-reveal className="mt-10 overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 p-2 shadow-[0_30px_80px_rgba(0,0,0,0.38)] sm:p-3 lg:p-4">
          <div className="flex min-h-11 items-center justify-between gap-3 px-2 pb-2 text-xs font-semibold text-slate-400 sm:px-3 sm:pb-3">
            <span className="inline-flex items-center gap-2"><Monitor size={16} className="text-blue-300" aria-hidden="true" />Activity center · Desktop</span>
            <span className="hidden sm:inline">{DEMO_LABEL}</span>
          </div>
          <picture>
            <source
              srcSet="/images/product/quotefly-activity-center-desktop-v1-960.webp 960w, /images/product/quotefly-activity-center-desktop-v1-1440.webp 1440w, /images/product/quotefly-activity-center-desktop-v1-1890.webp 1890w"
              sizes="(max-width: 640px) calc(100vw - 48px), (max-width: 1280px) calc(100vw - 80px), 1248px"
              type="image/webp"
            />
            <img
              src="/images/product/quotefly-activity-center-desktop-v1-1890.webp"
              alt="QuoteFly desktop activity center showing prioritized leads, quote status, and follow-up actions."
              width="1890"
              height="908"
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              className="h-auto w-full rounded-[20px] border border-white/10 bg-white object-contain"
            />
          </picture>
          <figcaption className="px-2 pb-1 pt-3 text-sm leading-6 text-slate-300 sm:px-3">
            <strong className="text-white">Keep the whole queue visible without rebuilding your day.</strong>
            <span className="ml-2 sm:hidden">{DEMO_LABEL}</span>
          </figcaption>
        </figure>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <figure data-marketing-reveal className="grid overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 p-4 shadow-[0_22px_54px_rgba(0,0,0,0.28)] sm:grid-cols-[minmax(0,1fr)_minmax(260px,0.74fr)] sm:items-center sm:gap-6 sm:p-6">
            <figcaption className="pb-5 sm:pb-0">
              <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300"><Smartphone size={16} aria-hidden="true" />Mobile dashboard</span>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-white">Open the app and know what matters.</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">See unquoted leads, follow-up needs, open pipeline, and the oldest customer actions before the day gets away from you.</p>
              <p className="mt-4 text-xs font-semibold text-slate-400">{DEMO_LABEL}</p>
            </figcaption>
            <img
              src="/images/product/quotefly-mobile-dashboard-v1.webp"
              alt="QuoteFly mobile dashboard showing lead, follow-up, pipeline, and activity summaries."
              width="373"
              height="817"
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              className="mx-auto h-auto w-full max-w-[330px] rounded-[24px] border border-white/15 bg-white shadow-[0_22px_48px_rgba(0,0,0,0.35)]"
            />
          </figure>

          <figure data-marketing-reveal className="grid overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 p-4 shadow-[0_22px_54px_rgba(0,0,0,0.28)] sm:grid-cols-[minmax(0,1fr)_minmax(260px,0.74fr)] sm:items-center sm:gap-6 sm:p-6">
            <figcaption className="pb-5 sm:pb-0">
              <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-orange-300"><Smartphone size={16} aria-hidden="true" />Kody on mobile</span>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-white">Ask for the next step without leaving the workflow.</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">Kody can surface the tenant-scoped follow-up queue and offer reviewable actions while the customer or quote stays close at hand.</p>
              <p className="mt-4 text-xs font-semibold text-slate-400">{DEMO_LABEL}</p>
            </figcaption>
            <img
              src="/images/product/kody-follow-up-mobile-v1.webp"
              alt="Kody assistant showing a workspace-scoped customer follow-up queue on mobile."
              width="374"
              height="809"
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              className="mx-auto h-auto w-full max-w-[330px] rounded-[24px] border border-white/15 bg-white shadow-[0_22px_48px_rgba(0,0,0,0.35)]"
            />
          </figure>
        </div>

        <div data-marketing-reveal className="mt-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-5 sm:flex-row sm:px-6">
          <p className="max-w-2xl text-sm leading-6 text-slate-300">Start with the same customer, quote, and follow-up workflow shown here. Kody assists; you review every customer-facing action.</p>
          <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>
            Try the real workflow free
          </MarketingAction>
        </div>
      </div>
    </section>
  );
}
