import { useState } from "react";
import { ArrowRight, CheckCircle2, Search, ShieldCheck, Sparkles } from "lucide-react";

const KODY_EXAMPLES = [
  {
    prompt: "Find Michael Scott.",
    eyebrow: "Customer lookup",
    answer: "I found one active customer named Michael Scott in this workspace. I can open the customer record or start a quote with that customer selected.",
    action: "Start free to try this",
  },
  {
    prompt: "Draft a quote for a 20-square roof replacement.",
    eyebrow: "Quote drafting",
    answer: "I can prepare a reviewable draft with tear-off, underlayment, shingles, flashing, ventilation, disposal, and an allowance for decking. You set the final quantities and prices.",
    action: "Start free to try this",
  },
  {
    prompt: "Who needs follow-up today?",
    eyebrow: "Follow-up",
    answer: "I can check this workspace for new customers without quotes, sent quotes due for follow-up, and open work that has not had a recent activity update.",
    action: "Start free to try this",
  },
  {
    prompt: "What would closing 30% of open quotes mean?",
    eyebrow: "Pipeline math",
    answer: "I can total the authorized open pipeline, calculate the 30% scenario, and cite the records used so an owner or admin can review the result.",
    action: "Start free to try this",
  },
] as const;

interface LandingKodyShowcaseProps {
  onOpenAuth: () => void;
}

export function LandingKodyShowcase({ onOpenAuth }: LandingKodyShowcaseProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = KODY_EXAMPLES[activeIndex];

  return (
    <section className="border-t border-slate-200 bg-gradient-to-b from-white to-blue-50/60 px-4 py-16 sm:px-6 sm:py-20 lg:px-8" aria-labelledby="kody-showcase-heading">
      <div className="mx-auto max-w-7xl">
        <div data-marketing-reveal className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-quotefly-blue">AI for the work already on your plate</p>
            <h2 id="kody-showcase-heading" className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-4xl">Tell Kody what you are trying to get done.</h2>
          </div>
          <p className="max-w-3xl text-lg leading-8 text-slate-600">
            Kody can help find customers, organize quote drafts, surface follow-up, and explain pipeline math using the data and permissions inside your QuoteFly workspace.
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-[0.82fr_1.18fr]">
          <div role="group" aria-label="Choose a Kody example" className="hide-scrollbar flex snap-x gap-3 overflow-x-auto pb-1 lg:grid lg:overflow-visible">
            {KODY_EXAMPLES.map((example, index) => (
              <button
                key={example.prompt}
                type="button"
                aria-pressed={index === activeIndex}
                onClick={() => setActiveIndex(index)}
                className={`min-h-14 min-w-[82%] snap-start rounded-2xl border px-5 py-4 text-left text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-blue/20 sm:min-w-[48%] lg:min-w-0 ${
                  index === activeIndex
                    ? "border-quotefly-blue bg-quotefly-blue text-white shadow-[0_14px_30px_rgba(47,111,214,0.2)]"
                    : "border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50"
                }`}
              >
                <span className="flex items-start gap-3"><Sparkles size={17} className="mt-0.5 shrink-0" aria-hidden="true" />{example.prompt}</span>
              </button>
            ))}
          </div>

          <article data-marketing-reveal="scale" className="relative overflow-hidden rounded-[30px] border border-slate-200 bg-slate-950 p-5 text-white shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:p-8">
            <div aria-hidden="true" className="absolute -right-14 -top-20 h-52 w-52 rounded-full bg-quotefly-blue/25 blur-3xl" />
            <div className="relative flex items-center gap-4 border-b border-white/10 pb-5">
              <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white/[0.07] ring-1 ring-white/15">
                <img
                  src="/images/kody/kody-ai-thumbnail.webp"
                  alt=""
                  width="112"
                  height="112"
                  loading="lazy"
                  decoding="async"
                  className="h-14 w-14 object-contain"
                />
              </span>
              <div>
                <p className="font-bold">Kody</p>
                <p className="mt-1 text-sm text-slate-400">QuoteFly assistant · Interactive example</p>
              </div>
            </div>

            <div key={active.prompt} className="qf-demo-pane-enter relative py-7" aria-live="polite">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-300">{active.eyebrow}</p>
              <p className="mt-4 text-lg leading-8 text-slate-100">{active.answer}</p>
              <button type="button" onClick={onOpenAuth} className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl bg-quotefly-orange px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-orange-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-300/40">
                {active.action}<ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="relative grid gap-3 border-t border-white/10 pt-5 sm:grid-cols-2">
              <p className="flex items-start gap-2 text-xs leading-5 text-slate-400"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-blue-300" aria-hidden="true" />Tenant-scoped and permission-aware</p>
              <p className="flex items-start gap-2 text-xs leading-5 text-slate-400"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />You review before creating or sending</p>
            </div>
            <Search aria-hidden="true" className="absolute bottom-5 right-5 text-white/[0.04]" size={92} />
          </article>
        </div>
      </div>
    </section>
  );
}
