import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  ClipboardCheck,
  Search,
  ShieldCheck,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { KodySparkIcon } from "../ai/KodySparkIcon";
import { MarketingAction } from "./PublicPageLayout";

type PitchSlide = {
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
  icon: LucideIcon | typeof KodySparkIcon;
  accent: "blue" | "orange" | "emerald";
  highlights: readonly string[];
};

const PITCH_SLIDES: readonly PitchSlide[] = [
  {
    label: "Capture",
    eyebrow: "Start where the work starts",
    title: "Keep the job moving while you are still on site.",
    description:
      "Look up or add the customer, capture the scope, and keep the history attached to the work instead of scattered across notes and messages.",
    image: "/images/solutions/landscaping-field-work.jpg",
    imageAlt: "Field professional working on a landscaping job",
    icon: Search,
    accent: "emerald",
    highlights: ["Fast customer intake", "Mobile-first workspace", "One source of truth"],
  },
  {
    label: "Draft with Kody",
    eyebrow: "AI that helps with the first pass",
    title: "Turn plain-language job details into a useful starting point.",
    description:
      "Kody can help find the right customer, organize a rough scope, suggest quote items, and surface follow-up work. It accelerates familiar steps without replacing trade judgment.",
    image: "/quote-workflow.jpg",
    imageAlt: "QuoteFly customer, estimate builder, and quote preview workflow",
    icon: KodySparkIcon,
    accent: "blue",
    highlights: ["Uses your workspace context", "Drafts, not decisions", "No blank-page slowdown"],
  },
  {
    label: "Review",
    eyebrow: "Your price. Your call.",
    title: "Stay in control before anything reaches the customer.",
    description:
      "Review scope, quantities, internal costs, markup, and the customer-facing total. QuoteFly keeps the assistant helpful while you remain the final decision-maker.",
    image: "/images/solutions/roofing-materials.jpg",
    imageAlt: "Roofing professional carrying materials on an active job",
    icon: ClipboardCheck,
    accent: "orange",
    highlights: ["Human review required", "Internal costs stay internal", "Branded PDF preview"],
  },
  {
    label: "Follow through",
    eyebrow: "From sent quote to next action",
    title: "Know what needs attention without rebuilding your day.",
    description:
      "See new leads, open quotes, follow-up needs, and pipeline activity in one place. Kody can help surface the next step while QuoteFly remains the system of record.",
    image: "/images/solutions/electrical-service.jpg",
    imageAlt: "Service professional working with electrical equipment in the field",
    icon: TrendingUp,
    accent: "emerald",
    highlights: ["Practical follow-up queue", "Clear quote pipeline", "Tenant-scoped assistance"],
  },
] as const;

const ACCENT_STYLES = {
  blue: {
    icon: "bg-blue-500/15 text-blue-200 ring-blue-400/25",
    eyebrow: "text-blue-200",
    line: "bg-blue-400",
  },
  orange: {
    icon: "bg-orange-400/15 text-orange-200 ring-orange-300/25",
    eyebrow: "text-orange-200",
    line: "bg-orange-400",
  },
  emerald: {
    icon: "bg-emerald-400/15 text-emerald-200 ring-emerald-300/25",
    eyebrow: "text-emerald-200",
    line: "bg-emerald-400",
  },
} as const;

interface LandingPitchDeckProps {
  onOpenAuth: () => void;
}

export function LandingPitchDeck({ onOpenAuth }: LandingPitchDeckProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const pointerStartX = useRef<number | null>(null);
  const slide = PITCH_SLIDES[activeIndex];
  const accent = ACCENT_STYLES[slide.accent];

  function selectSlide(index: number) {
    setActiveIndex((index + PITCH_SLIDES.length) % PITCH_SLIDES.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectSlide(activeIndex - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectSlide(activeIndex + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectSlide(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectSlide(PITCH_SLIDES.length - 1);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      pointerStartX.current = event.clientX;
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    if (pointerStartX.current === null) return;
    const distance = event.clientX - pointerStartX.current;
    pointerStartX.current = null;
    if (Math.abs(distance) < 48) return;
    selectSlide(activeIndex + (distance < 0 ? 1 : -1));
  }

  const ActiveIcon = slide.icon;

  return (
    <section
      id="product-story"
      aria-labelledby="product-story-heading"
      className="scroll-mt-24 border-y border-slate-800 bg-slate-950 px-4 py-16 text-white sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-7xl">
        <div data-marketing-reveal className="grid items-end gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-300">The QuoteFly story</p>
            <h2 id="product-story-heading" className="mt-3 max-w-2xl text-3xl font-bold tracking-[-0.035em] sm:text-4xl lg:text-5xl">
              Your workflow, moving faster.
            </h2>
          </div>
          <p className="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
            A visual tour of how QuoteFly helps contractors capture, quote, review, and follow up—with AI as a practical assistant, never a replacement for experience.
          </p>
        </div>

        <div
          data-testid="landing-pitch-deck"
          data-marketing-reveal
          role="region"
          aria-roledescription="carousel"
          aria-label="QuoteFly product story"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { pointerStartX.current = null; }}
          className="mt-10 overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 shadow-[0_30px_80px_rgba(0,0,0,0.35)] outline-none [touch-action:pan-y] focus-visible:ring-4 focus-visible:ring-blue-400/40"
        >
          <div className="grid min-h-[610px] lg:min-h-[580px] lg:grid-cols-[minmax(0,1.08fr)_minmax(380px,0.92fr)]">
            <figure className="relative min-h-[280px] overflow-hidden sm:min-h-[360px] lg:min-h-full">
              <img
                key={slide.image}
                src={slide.image}
                alt={slide.imageAlt}
                width={1600}
                height={1067}
                loading="lazy"
                decoding="async"
                className="qf-demo-pane-enter absolute inset-0 h-full w-full object-cover"
              />
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-slate-950/10" />
              <figcaption className="absolute inset-x-5 bottom-5 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/85 sm:inset-x-7 sm:bottom-7">
                <span>Built around real work</span>
                <span>{String(activeIndex + 1).padStart(2, "0")} / {String(PITCH_SLIDES.length).padStart(2, "0")}</span>
              </figcaption>
            </figure>

            <article
              key={slide.title}
              role="group"
              aria-roledescription="slide"
              aria-label={`${activeIndex + 1} of ${PITCH_SLIDES.length}: ${slide.label}`}
              className="qf-demo-pane-enter flex flex-col justify-center p-6 sm:p-9 lg:p-11"
            >
              <div className={cn("inline-flex h-12 w-12 items-center justify-center rounded-2xl ring-1", accent.icon)}>
                <ActiveIcon size={23} aria-hidden="true" />
              </div>
              <p className={cn("mt-7 text-xs font-bold uppercase tracking-[0.2em]", accent.eyebrow)}>{slide.eyebrow}</p>
              <h3 className="mt-3 text-2xl font-bold leading-tight tracking-[-0.025em] text-white sm:text-3xl">{slide.title}</h3>
              <p className="mt-4 text-base leading-7 text-slate-300">{slide.description}</p>
              <ul className="mt-6 space-y-3">
                {slide.highlights.map((highlight) => (
                  <li key={highlight} className="flex items-center gap-3 text-sm font-medium text-slate-100">
                    <CircleCheck size={17} className="shrink-0 text-emerald-300" aria-hidden="true" />
                    {highlight}
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <MarketingAction onClick={onOpenAuth} className="px-5 py-2.5 text-sm">
                  Try QuoteFly free
                </MarketingAction>
                <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-400">
                  <ShieldCheck size={15} className="text-blue-300" aria-hidden="true" />
                  You review before creating or sending
                </span>
              </div>
            </article>
          </div>

          <div className="border-t border-white/10 bg-slate-950/70 px-3 py-3 sm:px-5 sm:py-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => selectSlide(activeIndex - 1)}
                aria-label="Previous story slide"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.05] text-white transition hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/35"
              >
                <ArrowLeft size={18} aria-hidden="true" />
              </button>

              <div role="group" aria-label="Choose a product story slide" className="hide-scrollbar flex min-w-0 flex-1 snap-x gap-2 overflow-x-auto">
                {PITCH_SLIDES.map((item, index) => (
                  <button
                    key={item.label}
                    type="button"
                    aria-pressed={index === activeIndex}
                    aria-label={`Show slide ${index + 1}: ${item.label}`}
                    onClick={() => selectSlide(index)}
                    className={cn(
                      "relative min-h-11 min-w-[128px] snap-start rounded-xl border px-3 py-2 text-left text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/35 sm:min-w-0 sm:flex-1",
                      index === activeIndex
                        ? "border-white/25 bg-white/[0.1] text-white"
                        : "border-transparent text-slate-400 hover:border-white/10 hover:bg-white/[0.05] hover:text-slate-200",
                    )}
                  >
                    <span className="block text-[10px] font-bold tracking-[0.18em] text-slate-500">{String(index + 1).padStart(2, "0")}</span>
                    <span className="mt-0.5 block truncate">{item.label}</span>
                    {index === activeIndex ? <span aria-hidden="true" className={cn("absolute inset-x-3 bottom-0 h-0.5 rounded-full", accent.line)} /> : null}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => selectSlide(activeIndex + 1)}
                aria-label="Next story slide"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.05] text-white transition hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/35"
              >
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="sr-only" aria-live="polite">Showing slide {activeIndex + 1} of {PITCH_SLIDES.length}: {slide.label}</p>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">Use the controls, arrow keys, or swipe to explore. Slides do not auto-advance.</p>
      </div>
    </section>
  );
}
