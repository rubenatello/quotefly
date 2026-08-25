import { useState } from "react";
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
  label: string;
  alt: string;
  icon: LucideIcon;
};

type ProductStory = {
  key: string;
  step: string;
  eyebrow: string;
  title: string;
  description: string;
  boundary: string;
  captures: readonly [ProductCapture, ProductCapture];
};

const PRODUCT_STORIES: readonly ProductStory[] = [
  {
    key: "focus",
    step: "01",
    eyebrow: "Focus and review",
    title: "See the day, then ask Kody what deserves attention.",
    description:
      "Start with assigned tasks, quote momentum, and active jobs. When the schedule needs a second look, Kody can organize tenant-scoped appointments into a practical review.",
    boundary:
      "Tasks and Kody reviews are workspace guidance. These views do not contact customers or change the schedule.",
    captures: [
      {
        key: "activity-my-day",
        label: "My Day",
        alt: "QuoteFly My Day workspace showing due tasks, quote pipeline, active jobs, and recent customer work.",
        icon: ClipboardCheck,
      },
      {
        key: "kody-review",
        label: "Kody review",
        alt: "Kody displaying a review of three tenant-scoped appointments with times, jobs, assignees, and statuses.",
        icon: Bot,
      },
    ],
  },
  {
    key: "field-work",
    step: "02",
    eyebrow: "Schedule and dispatch",
    title: "Keep the accepted scope connected to the field visit.",
    description:
      "Book day or week appointments, assign an active teammate, and carry the source quote, access notes, and visit history into the Job workspace.",
    boundary:
      "Scheduling, dispatch, arrival, and completion remain deliberate team actions. QuoteFly does not perform route optimization.",
    captures: [
      {
        key: "jobs-schedule",
        label: "Schedule",
        alt: "QuoteFly day schedule showing booked field visits, assigned teammates, times, addresses, and dispatch status.",
        icon: CalendarDays,
      },
      {
        key: "job-detail",
        label: "Job detail",
        alt: "QuoteFly job detail showing an accepted scope, assignment, access instructions, and a scheduled visit.",
        icon: BriefcaseBusiness,
      },
    ],
  },
  {
    key: "billing",
    step: "03",
    eyebrow: "Invoice and follow-through",
    title: "Create the billing record and keep changes visible.",
    description:
      "Record the customer total, balance, due date, source quote, and Job, then keep booking and dispatch updates visible inside the workspace.",
    boundary:
      "Internal invoice records do not collect payment. In-app notifications do not send customer email or text messages.",
    captures: [
      {
        key: "internal-invoice",
        label: "Invoice record",
        alt: "QuoteFly internal invoice record showing draft and payment-pending status, customer total, balance, and due date.",
        icon: ReceiptText,
      },
      {
        key: "notification-center",
        label: "Notifications",
        alt: "QuoteFly notification center showing booked, rescheduled, and dispatched visit updates for fictional jobs.",
        icon: BellRing,
      },
    ],
  },
] as const;

function ProductPicture({ capture, panelId }: { capture: ProductCapture; panelId: string }) {
  const desktopPath = `/images/product/${capture.key}-desktop-v1.webp`;
  const desktopRetinaPath = `/images/product/${capture.key}-desktop-v2.webp`;
  const mobilePath = `/images/product/${capture.key}-mobile-v1.webp`;
  const mobileRetinaPath = `/images/product/${capture.key}-mobile-v2.webp`;

  return (
    <div
      key={capture.key}
      id={panelId}
      className="qf-demo-pane-enter overflow-hidden rounded-[22px] border border-white/15 bg-slate-950 shadow-[0_28px_70px_rgba(0,0,0,0.38)]"
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-4 py-2.5 sm:px-5">
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-quotefly-orange" />
          <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-600" />
        </div>
        <p className="truncate text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">
          {capture.label} · QuoteFly workspace
        </p>
      </div>
      <div className="bg-slate-950 p-2 sm:p-3">
        <picture className="mx-auto block max-w-[430px] sm:max-w-none">
          <source
            media="(max-width: 639px)"
            srcSet={`${mobilePath} 390w, ${mobileRetinaPath} 780w`}
            sizes="min(430px, calc(100vw - 48px))"
            width="390"
            height="844"
            type="image/webp"
          />
          <img
            src={desktopPath}
            srcSet={`${desktopPath} 1440w, ${desktopRetinaPath} 2880w`}
            sizes="(min-width: 1280px) 1216px, calc(100vw - 64px)"
            alt={capture.alt}
            width="1440"
            height="900"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-auto w-full rounded-[14px] border border-white/10 bg-white object-contain sm:rounded-[16px]"
          />
        </picture>
      </div>
    </div>
  );
}

function ProductStoryModule({ story }: { story: ProductStory }) {
  const [activeKey, setActiveKey] = useState(story.captures[0].key);
  const activeCapture = story.captures.find((capture) => capture.key === activeKey) ?? story.captures[0];
  const panelId = `product-story-${story.key}-panel`;

  return (
    <article
      data-marketing-reveal
      className="overflow-hidden rounded-[30px] border border-white/10 bg-slate-900/85 p-4 shadow-[0_26px_70px_rgba(0,0,0,0.24)] sm:p-6 lg:p-8"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)] lg:items-end">
        <div>
          <p className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.19em] text-blue-300">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-quotefly-orange/35 bg-quotefly-orange/10 text-quotefly-orange">
              {story.step}
            </span>
            {story.eyebrow}
          </p>
          <h3 className="mt-4 max-w-3xl text-2xl font-bold tracking-[-0.03em] text-white sm:text-3xl">
            {story.title}
          </h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">{story.description}</p>
        </div>

        <div>
          <div role="group" aria-label={`Choose the ${story.eyebrow.toLowerCase()} product view`} className="grid grid-cols-2 gap-2">
            {story.captures.map((capture) => {
              const CaptureIcon = capture.icon;
              const active = capture.key === activeCapture.key;
              return (
                <button
                  key={capture.key}
                  type="button"
                  aria-pressed={active}
                  aria-controls={panelId}
                  onClick={() => setActiveKey(capture.key)}
                  className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-orange/35 ${
                    active
                      ? "border-quotefly-orange bg-quotefly-orange text-slate-950 shadow-[0_10px_24px_rgba(255,137,18,0.2)]"
                      : "border-white/15 bg-white/[0.06] text-slate-200 hover:border-blue-300/60 hover:bg-white/[0.1]"
                  }`}
                >
                  <CaptureIcon size={17} aria-hidden="true" />
                  {capture.label}
                </button>
              );
            })}
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-400">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-orange-300" aria-hidden="true" />
            {story.boundary}
          </p>
        </div>
      </div>

      <div className="mt-6 sm:mt-8">
        <ProductPicture capture={activeCapture} panelId={panelId} />
      </div>
    </article>
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
              Follow three real product stories, then switch views to inspect the workspace at each step. Every screen uses the same deterministic fictional home-services business.
            </p>
            <p className="mt-3 flex items-start gap-2 text-sm text-slate-400">
              <ShieldCheck size={17} className="mt-0.5 shrink-0 text-orange-300" aria-hidden="true" />
              Actual QuoteFly interface · Sanitized fictional data · No production customer data, internal costs, or margins.
            </p>
          </div>
        </div>

        <div className="mt-10 space-y-6 sm:space-y-8">
          {PRODUCT_STORIES.map((story) => <ProductStoryModule key={story.key} story={story} />)}
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
