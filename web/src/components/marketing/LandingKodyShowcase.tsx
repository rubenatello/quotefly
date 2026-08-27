import { useState } from "react";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarClock,
  CalendarPlus2,
  Check,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  FilePlus2,
  Mail,
  Phone,
  Search,
  ShieldCheck,
  Sparkles,
  Truck,
  UserPlus,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";

type KodyScenarioId = "customer" | "quote" | "attention" | "booking";

type KodyScenario = {
  id: KodyScenarioId;
  label: string;
  eyebrow: string;
  prompt: string;
  summary: string;
  icon: LucideIcon;
};

const KODY_SCENARIOS: readonly KodyScenario[] = [
  {
    id: "customer",
    label: "Add customer",
    eyebrow: "Customer intake",
    prompt: "Add customer Jon Bacon 555-555-0168 jon.bacon@example.com",
    summary: "Kody separates the contact details and prepares a customer record for review.",
    icon: UserPlus,
  },
  {
    id: "quote",
    label: "New quote",
    eyebrow: "Quote preparation",
    prompt: "Prepare a construction quote for Rober California: custom dining table, $2,000 materials and $1,500 labor.",
    summary: "Kody matches the customer and turns the scope and prices into editable quote fields.",
    icon: FilePlus2,
  },
  {
    id: "attention",
    label: "Today’s priorities",
    eyebrow: "Workspace review",
    prompt: "Kody, what needs my attention today?",
    summary: "Kody ranks the active tasks assigned to you that are overdue or due today.",
    icon: ClipboardCheck,
  },
  {
    id: "booking",
    label: "Book job from quote",
    eyebrow: "Schedule and dispatch review",
    prompt: "Find a 2-hour opening next Thursday between 8 AM and 5 PM for Job #104, then prepare it for review.",
    summary: "Kody checks the assigned team member’s active QuoteFly bookings and prepares up to three non-overlapping openings.",
    icon: CalendarPlus2,
  },
] as const;

interface LandingKodyShowcaseProps {
  onOpenAuth: () => void;
  variant?: "full" | "teaser";
}

function CustomerResult() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <PreviewField label="First name" value="Jon" />
      <PreviewField label="Last name" value="Bacon" />
      <PreviewField label="Phone" value="(555) 555-0168" icon={Phone} />
      <PreviewField label="Email" value="jon.bacon@example.com" icon={Mail} />
      <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950 sm:col-span-2">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />
        <span><strong>Ready for review.</strong> Confirm once to add Jon to the customer list.</span>
      </div>
    </div>
  );
}

function QuoteResult() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <PreviewField label="Customer" value="Rober California" icon={UsersRound} />
        <PreviewField label="Trade" value="Construction" icon={BriefcaseBusiness} />
      </div>
      <PreviewField label="Quote title" value="Custom Wooden Dining Table Quote" />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-100 px-4 py-3 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
          <span>Separate line items</span>
          <span>Customer price</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-sm text-slate-700">
          <span>Custom wooden table materials</span>
          <strong className="text-slate-950">$2,000</strong>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-700">
          <span>Custom wooden table labor</span>
          <strong className="text-slate-950">$1,500</strong>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <span className="text-sm font-bold text-slate-700">Customer total</span>
          <span className="text-lg font-bold text-slate-950">$3,500</span>
        </div>
      </div>
    </div>
  );
}

function AttentionResult() {
  const priorities = [
    { icon: Phone, label: "Call Morgan about the sent estimate", status: "Overdue", detail: "Customer follow-up · assigned to you" },
    { icon: CalendarClock, label: "Confirm tomorrow’s HVAC access", status: "Due today", detail: "Appointment prep · assigned to you" },
    { icon: ClipboardCheck, label: "Review the table quote measurements", status: "Due today", detail: "Quote follow-up · assigned to you" },
  ] as const;

  return (
    <div className="space-y-3">
      {priorities.map((priority) => {
        const PriorityIcon = priority.icon;
        return (
          <div key={priority.label} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-quotefly-blue">
              <PriorityIcon size={20} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-slate-950">{priority.label}</p>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">{priority.detail}</p>
            </div>
            <span className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-900">{priority.status}</span>
          </div>
        );
      })}
      <p className="flex items-start gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">
        <Search size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        Read-only task review using fictional sample data. Kody only ranks your assigned active tasks; this example does not change any record.
      </p>
    </div>
  );
}

function BookingResult() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <PreviewField label="Accepted quote" value="Custom dining table · $3,500" icon={CheckCircle2} />
        <PreviewField label="Linked Job" value="#104 · Rober California" icon={BriefcaseBusiness} />
        <PreviewField label="Assigned to" value="Alex Rivera" icon={UsersRound} />
        <PreviewField label="QuoteFly calendar opening" value="Thursday · 10:00 AM–12:00 PM" icon={CalendarClock} />
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />
        <span><strong>No active booking overlap.</strong> Review this opening, then confirm once to add the visit to QuoteFly’s schedule.</span>
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700">
        <Truck size={18} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
        <span>Dispatch is a second confirmed step after booking. This preview does not send email or text messages, optimize routes, or update an external calendar.</span>
      </div>
    </div>
  );
}

function PreviewField({ label, value, icon: Icon }: { label: string; value: string; icon?: LucideIcon }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.13em] text-slate-500">{label}</p>
      <p className="mt-1 flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-950">
        {Icon ? <Icon size={15} className="shrink-0 text-quotefly-blue" aria-hidden="true" /> : null}
        <span className="truncate">{value}</span>
      </p>
    </div>
  );
}

function ScenarioResult({ scenario }: { scenario: KodyScenario }) {
  if (scenario.id === "customer") return <CustomerResult />;
  if (scenario.id === "quote") return <QuoteResult />;
  if (scenario.id === "attention") return <AttentionResult />;
  return <BookingResult />;
}

export function LandingKodyShowcase({ onOpenAuth, variant = "full" }: LandingKodyShowcaseProps) {
  const [activeId, setActiveId] = useState<KodyScenarioId>("customer");
  const active = KODY_SCENARIOS.find((scenario) => scenario.id === activeId) ?? KODY_SCENARIOS[0];

  if (variant === "teaser") {
    return (
      <section className="border-t border-slate-200 bg-gradient-to-b from-white to-blue-50/60 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="kody-teaser-heading">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:items-center">
          <div data-marketing-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-800">Kody turns requests into reviewable work</p>
            <h2 id="kody-teaser-heading" className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-4xl">Ask naturally. Review structured results.</h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              See how Kody can prepare a customer, organize a new quote, surface today’s priorities, or find a QuoteFly calendar opening for an accepted-quote Job—without saving or sending anything before you confirm.
            </p>
            <Link to="/solutions#kody" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-quotefly-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200">
              Explore the guided Kody simulation <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>

          <div data-marketing-reveal="scale" className="overflow-hidden rounded-[28px] border border-slate-200 bg-slate-950 p-3 shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:p-4">
            <div className="rounded-[22px] border border-white/10 bg-white/[0.05] p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-white/[0.08] ring-1 ring-white/15">
                  <img src="/images/kody/kody-ai-thumbnail.webp" alt="" width="112" height="112" loading="lazy" decoding="async" className="h-10 w-10 object-contain" />
                </span>
                <div>
                  <p className="font-bold text-white">Four workflows. One assistant.</p>
                  <p className="text-xs text-slate-400">Fictional sample workspace</p>
                </div>
              </div>
              <div className="mt-5 grid gap-2">
                {KODY_SCENARIOS.map((scenario) => {
                  const ScenarioIcon = scenario.icon;
                  return (
                    <div key={scenario.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/15 px-4 py-3 text-sm text-slate-200">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-200"><ScenarioIcon size={17} aria-hidden="true" /></span>
                      <span className="font-semibold">{scenario.label}</span>
                      <CheckCircle2 size={17} className="ml-auto shrink-0 text-quotefly-orange" aria-hidden="true" />
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-400"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-blue-300" aria-hidden="true" />Guided product simulation. No AI API call or record mutation.</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="kody" className="scroll-mt-24 border-t border-slate-200 bg-gradient-to-b from-white to-blue-50/60 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="kody-showcase-heading">
      <div className="mx-auto max-w-7xl">
        <div data-marketing-reveal className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-800">See Kody in action</p>
            <h2 id="kody-showcase-heading" className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-4xl">One request becomes organized work.</h2>
          </div>
          <div className="max-w-3xl">
            <p className="text-lg leading-8 text-slate-600">
              Kody can understand a plain-language request, find the right workspace context, and prepare structured fields for review. Choose a sample workflow to see the handoff.
            </p>
            <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">
              <ShieldCheck size={15} className="text-quotefly-blue" aria-hidden="true" /> Guided product simulation. Fictional sample workspace. No AI API call or record mutation.
            </p>
          </div>
        </div>

        <div data-marketing-reveal="scale" className="mt-10 overflow-hidden rounded-[30px] border border-slate-200 bg-slate-950 shadow-[0_28px_70px_rgba(15,23,42,0.2)]">
          <div className="border-b border-white/10 px-4 py-4 sm:px-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-white/[0.08] ring-1 ring-white/15">
                  <img src="/images/kody/kody-ai-thumbnail.webp" alt="" width="112" height="112" loading="lazy" decoding="async" className="h-10 w-10 object-contain" />
                </span>
                <div>
                  <p className="font-bold text-white">Kody workspace preview</p>
                  <p className="text-xs text-slate-400">Human review stays in control</p>
                </div>
              </div>
              <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-slate-300 sm:inline-flex">
                <span className="h-2 w-2 rounded-full bg-quotefly-orange" aria-hidden="true" /> Demo mode
              </span>
            </div>
          </div>

          <div className="grid lg:grid-cols-[0.72fr_1.28fr]">
            <div className="border-b border-white/10 p-4 sm:p-6 lg:border-b-0 lg:border-r">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Choose a workflow</p>
              <div role="group" aria-label="Kody scripted workflows" className="mt-4 grid gap-2">
                {KODY_SCENARIOS.map((scenario) => {
                  const ScenarioIcon = scenario.icon;
                  const isActive = scenario.id === active.id;
                  return (
                    <button
                      key={scenario.id}
                      id={`kody-tab-${scenario.id}`}
                      type="button"
                      aria-pressed={isActive}
                      aria-controls={`kody-panel-${scenario.id}`}
                      onClick={() => setActiveId(scenario.id)}
                      className={`min-h-14 rounded-2xl border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-300/30 ${
                        isActive
                          ? "border-blue-400/60 bg-blue-500/15 text-white"
                          : "border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/20 hover:bg-white/[0.07]"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <ScenarioIcon size={18} className={isActive ? "text-blue-300" : "text-slate-400"} aria-hidden="true" />
                        <span className="font-bold">{scenario.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-300">What Kody does</p>
                <ol className="mt-4 space-y-3 text-sm text-slate-300">
                  {["Understand the request", "Structure the right fields", "Prepare a reviewable result"].map((step, index) => (
                    <li key={step} className="flex items-center gap-3">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-xs font-bold text-blue-200">{index + 1}</span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="bg-slate-50 p-4 sm:p-6 lg:p-8">
              <p className="sr-only" role="status">Showing the {active.label} sample result.</p>
              {KODY_SCENARIOS.map((scenario) => (
                <div
                  key={scenario.id}
                  id={`kody-panel-${scenario.id}`}
                  role="region"
                  aria-labelledby={`kody-tab-${scenario.id}`}
                  hidden={scenario.id !== active.id}
                  className="qf-demo-pane-enter"
                >
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                    <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-500">You ask Kody</p>
                    <p className="mt-2 text-base font-semibold leading-7 text-slate-950">“{scenario.prompt}”</p>
                  </div>

                  <div className="my-4 flex items-center gap-3 px-1 text-xs font-bold uppercase tracking-[0.13em] text-blue-700">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-blue-100 text-quotefly-blue">
                      <Sparkles size={16} aria-hidden="true" />
                    </span>
                    {scenario.eyebrow}
                    <span className="h-px flex-1 bg-blue-100" aria-hidden="true" />
                  </div>

                  <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-4 sm:p-5">
                    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-bold text-slate-950">Prepared for your review</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{scenario.summary}</p>
                      </div>
                      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-800">
                        <Check size={14} aria-hidden="true" /> Structured
                      </span>
                    </div>
                    <ScenarioResult scenario={scenario} />
                  </div>
                </div>
              ))}

              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />
                  Review the customer, scope, quantities, prices, and next action before confirming.
                </p>
                <button type="button" onClick={onOpenAuth} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-quotefly-orange px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-orange-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-300/40">
                  Try QuoteFly free <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          <p className="flex items-start gap-2"><CheckCircle2 size={17} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />Customer search and structured intake</p>
          <p className="flex items-start gap-2"><CircleDollarSign size={17} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />Separate, editable quote line items</p>
          <p className="flex items-start gap-2"><CalendarPlus2 size={17} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />Accepted-quote Job booking review</p>
          <p className="flex items-start gap-2"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-quotefly-blue" aria-hidden="true" />Tenant-scoped, permission-aware review</p>
        </div>
      </div>
    </section>
  );
}
