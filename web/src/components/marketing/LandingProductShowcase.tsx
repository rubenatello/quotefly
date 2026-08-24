import {
  ArrowRight,
  BellRing,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardCheck,
  ReceiptText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { MarketingAction } from "./PublicPageLayout";

interface LandingProductShowcaseProps {
  onOpenAuth: () => void;
}

type ProductCapture = {
  key: string;
  eyebrow: string;
  title: string;
  description: string;
  boundary: string;
  alt: string;
  icon: LucideIcon;
  featured?: boolean;
};

const DEMO_LABEL = "Actual QuoteFly interface · Sanitized fictional data";

const PRODUCT_CAPTURES: readonly ProductCapture[] = [
  {
    key: "activity-my-day",
    eyebrow: "Activity and My Day",
    title: "Start with the work that needs attention.",
    description: "See assigned tasks, due work, quote momentum, and active jobs in the same workspace your team uses every day.",
    boundary: "Tasks are internal workspace records. QuoteFly does not contact a customer from this view.",
    alt: "QuoteFly My Day workspace showing due tasks, quote pipeline, active jobs, and recent customer work.",
    icon: ClipboardCheck,
    featured: true,
  },
  {
    key: "jobs-schedule",
    eyebrow: "Booking and schedule",
    title: "Keep the field calendar connected to each job.",
    description: "Review day or week appointments, assigned teammates, visit windows, and current dispatch status without rebuilding a second calendar.",
    boundary: "This is scheduling and dispatch state, not automated route optimization or provider messaging.",
    alt: "QuoteFly day schedule showing booked field visits, assigned teammates, times, addresses, and dispatch status.",
    icon: CalendarDays,
  },
  {
    key: "job-detail",
    eyebrow: "Job detail",
    title: "Carry the accepted scope into field operations.",
    description: "Keep assignment, access notes, booking history, visit progress, and the source quote attached to the job.",
    boundary: "Dispatch, arrival, and completion are deliberate team actions with an in-app audit trail.",
    alt: "QuoteFly job detail showing an accepted scope, assignment, access instructions, and a scheduled visit.",
    icon: BriefcaseBusiness,
  },
  {
    key: "kody-review",
    eyebrow: "Kody schedule review",
    title: "Ask for the schedule, then review the result.",
    description: "Kody can read tenant-scoped appointments and organize the day into a practical review without exposing access notes or contact details.",
    boundary: "This deterministic review uses no paid AI. Kody never sends, books, or dispatches without a separate user action.",
    alt: "Kody displaying a review of three tenant-scoped appointments with times, jobs, assignees, and statuses.",
    icon: Bot,
  },
  {
    key: "internal-invoice",
    eyebrow: "Internal invoice ledger",
    title: "Create the billing record without overstating payment progress.",
    description: "Track the customer total, balance, due date, source quote, and job from a clear internal invoice record.",
    boundary: "A draft invoice does not send, collect payment, or create anything in QuickBooks, Stripe, or Square.",
    alt: "QuoteFly internal invoice record showing draft and payment-pending status, customer total, balance, and due date.",
    icon: ReceiptText,
  },
  {
    key: "notification-center",
    eyebrow: "In-app notifications",
    title: "Keep booking changes visible to the workspace.",
    description: "See booked, rescheduled, and dispatched visits with the related job and the time each notification was received.",
    boundary: "The notification center is in-app only. It does not send customer email or text messages.",
    alt: "QuoteFly notification center showing booked, rescheduled, and dispatched visit updates for fictional jobs.",
    icon: BellRing,
  },
] as const;

function ProductCaptureCard({ capture }: { capture: ProductCapture }) {
  const desktopPath = `/images/product/${capture.key}-desktop-v1.webp`;
  const mobilePath = `/images/product/${capture.key}-mobile-v1.webp`;
  const CaptureIcon = capture.icon;

  return (
    <figure
      data-marketing-reveal
      className={`overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 shadow-[0_24px_62px_rgba(0,0,0,0.3)] ${capture.featured ? "lg:col-span-2" : ""}`}
    >
      <figcaption className="grid gap-4 border-b border-white/10 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.62fr)] lg:items-end">
        <div>
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            <CaptureIcon size={17} aria-hidden="true" />
            {capture.eyebrow}
          </p>
          <h3 className="mt-3 text-xl font-bold tracking-tight text-white sm:text-2xl">{capture.title}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{capture.description}</p>
        </div>
        <div>
          <p className="flex items-start gap-2 text-xs leading-5 text-slate-400">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
            {capture.boundary}
          </p>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">{DEMO_LABEL}</p>
        </div>
      </figcaption>
      <div className="bg-slate-950 p-2 sm:p-3">
        <picture>
          <source
            media="(max-width: 640px)"
            srcSet={mobilePath}
            width="390"
            height="844"
            type="image/webp"
          />
          <img
            src={desktopPath}
            alt={capture.alt}
            width="1440"
            height="900"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-auto w-full rounded-[18px] border border-white/10 bg-white object-contain"
          />
        </picture>
      </div>
    </figure>
  );
}

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
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-300">The real QuoteFly operations workspace</p>
            <h2 id="product-story-heading" className="mt-3 max-w-3xl text-3xl font-bold tracking-[-0.035em] sm:text-4xl lg:text-5xl">
              Move from accepted quote to a finished, billable job.
            </h2>
          </div>
          <div>
            <p className="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              These are real QuoteFly screens rendered with a fictional home-services workspace. They show the current product boundaries as clearly as the workflow itself.
            </p>
            <p className="mt-3 flex items-start gap-2 text-sm text-slate-400">
              <ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
              No production or real customer data, internal costs, or margins appear in these images.
            </p>
          </div>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          {PRODUCT_CAPTURES.map((capture) => <ProductCaptureCard key={capture.key} capture={capture} />)}
        </div>

        <div data-marketing-reveal className="mt-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-5 sm:flex-row sm:px-6">
          <p className="max-w-2xl text-sm leading-6 text-slate-300">
            Start with the same customer-to-job workflow shown here. Your team stays in control of every schedule, dispatch, invoice, and customer-facing action.
          </p>
          <MarketingAction onClick={onOpenAuth} variant="orange" icon={<ArrowRight size={18} aria-hidden="true" />}>
            Try the real workflow free
          </MarketingAction>
        </div>
      </div>
    </section>
  );
}
