import { useState, type ReactNode } from "react";
import {
  BarChart3,
  Check,
  ChevronDown,
  Eye,
  FilePlus2,
  MoreHorizontal,
  Phone,
  Search,
  Settings2,
  UsersRound,
} from "lucide-react";
import { QuoteIcon } from "../Icons";

type DemoPane = "editor" | "preview";

function DemoNavItem({ icon, label, active = false }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <span className={`flex min-w-0 flex-col items-center gap-0.5 text-[7px] font-semibold ${active ? "text-quotefly-blue" : "text-slate-500"}`}>
      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${active ? "bg-quotefly-blue/[0.09]" : ""}`}>
        {icon}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </span>
  );
}

function EditorPane() {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-[0.72fr_1.28fr] gap-2">
        <div className="rounded-xl border border-slate-200 bg-white px-2.5 py-2">
          <p className="text-[6px] font-bold uppercase tracking-[0.16em] text-slate-400">Trade</p>
          <div className="mt-1 flex items-center justify-between text-[10px] font-semibold text-slate-800">
            HVAC <ChevronDown size={10} className="text-slate-400" />
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[6px] font-bold uppercase tracking-[0.16em] text-slate-400">Quick actions</p>
            <p className="text-[9px] font-bold text-slate-800">Total $189.00</p>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-center text-[7px] font-semibold text-slate-600">
            <span className="rounded-lg border border-slate-200 bg-white px-1 py-1.5">Add customer</span>
            <span className="rounded-lg border border-slate-200 bg-white px-1 py-1.5">Browse jobs</span>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[6px] font-bold uppercase tracking-[0.17em] text-quotefly-blue">Editable quote sheet</p>
              <p className="mt-1 truncate text-[12px] font-bold text-slate-950">Heat pump tune-up</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[7px] font-semibold text-slate-600">
              <Eye size={9} /> Preview
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-2">
            <Search size={11} className="text-slate-400" />
            <span className="truncate text-[9px] font-medium text-slate-700">Sample Customer</span>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[6px] font-bold uppercase tracking-[0.16em] text-slate-400">Customer</p>
              <p className="mt-1 truncate text-[10px] font-bold text-slate-900">Sample Customer</p>
              <p className="mt-0.5 truncate text-[7px] text-slate-500">(555) 013-0198 · sample@example.com</p>
            </div>
            <span className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[7px] font-semibold text-slate-600">Show details</span>
          </div>
        </div>

        <div className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-[6px] font-bold uppercase tracking-[0.16em] text-slate-400">Line 1</p>
              <p className="mt-0.5 text-[10px] font-bold text-slate-900">Seasonal maintenance</p>
            </div>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[6px] font-bold text-emerald-700">Included</span>
          </div>
          <p className="text-[7px] leading-3 text-slate-500">Inspect, clean, and test the heat pump system.</p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {[
              ["Qty", "1"],
              ["Price", "$189"],
              ["Total", "$189"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                <p className="text-[6px] font-semibold text-slate-400">{label}</p>
                <p className="mt-0.5 text-[8px] font-bold text-slate-800">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewPane() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-100 p-2.5 shadow-sm">
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="h-1 rounded-full bg-gradient-to-r from-quotefly-blue via-quotefly-blue to-quotefly-orange" />
        <div className="mt-3 flex items-start justify-between gap-2">
          <div>
            <p className="text-[6px] font-bold uppercase tracking-[0.16em] text-quotefly-blue">Quote preview</p>
            <p className="mt-1 text-[13px] font-bold text-slate-950">Heat pump tune-up</p>
          </div>
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[6px] font-bold text-emerald-700">Ready</span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-slate-50 p-2">
            <p className="text-[6px] font-bold uppercase tracking-[0.14em] text-slate-400">Business</p>
            <p className="mt-1 text-[8px] font-bold text-slate-800">QuoteFly Demo Co.</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-2">
            <p className="text-[6px] font-bold uppercase tracking-[0.14em] text-slate-400">Customer</p>
            <p className="mt-1 text-[8px] font-bold text-slate-800">Sample Customer</p>
          </div>
        </div>

        <div className="mt-3 border-y border-slate-100 py-2.5">
          <p className="text-[6px] font-bold uppercase tracking-[0.14em] text-slate-400">Included work</p>
          <div className="mt-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold text-slate-900">Seasonal maintenance</p>
              <p className="mt-0.5 text-[7px] leading-3 text-slate-500">Inspection, cleaning, and startup testing.</p>
            </div>
            <p className="shrink-0 text-[9px] font-bold text-slate-900">$189.00</p>
          </div>
        </div>

        <div className="mt-3 space-y-1.5 text-[8px] text-slate-500">
          <div className="flex items-center justify-between"><span>Subtotal</span><span>$189.00</span></div>
          <div className="flex items-center justify-between"><span>Tax</span><span>$0.00</span></div>
          <div className="flex items-center justify-between rounded-lg bg-quotefly-blue/[0.08] px-2 py-2 text-[10px] font-bold text-slate-950">
            <span>Total</span><span>$189.00</span>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1.5 text-[7px] font-semibold text-emerald-700">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-50"><Check size={9} /></span>
          Customer-facing price is ready to review
        </div>
      </div>
    </div>
  );
}

export function LandingProductDemo() {
  const [pane, setPane] = useState<DemoPane>("editor");

  return (
    <figure className="qf-hero-product relative isolate min-h-[590px] overflow-hidden rounded-[30px] border border-white/80 bg-[#f7f1e8] shadow-[0_30px_80px_rgba(15,23,42,0.16)] sm:min-h-[640px] lg:min-h-[660px]">
      <img
        src="/contractor-workbench-hero.jpg"
        alt=""
        width="1448"
        height="1086"
        loading="eager"
        fetchPriority="high"
        decoding="async"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-white/5 via-white/15 to-slate-950/5" />

      <div className="relative flex min-h-[590px] items-center justify-center px-3 py-6 sm:min-h-[640px] sm:px-7 sm:py-8 lg:min-h-[660px]">
        <div aria-hidden="true" className="absolute left-5 top-20 hidden w-[168px] rounded-2xl border border-white/90 bg-white/92 p-3 shadow-[0_18px_44px_rgba(15,23,42,0.14)] backdrop-blur lg:block">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-quotefly-blue/[0.1] text-quotefly-blue"><UsersRound size={16} /></span>
            <div>
              <p className="text-[10px] font-bold text-slate-900">Sample Customer</p>
              <p className="text-[8px] text-slate-500">Customer selected</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[8px] font-semibold text-slate-600">
            <span className="rounded-xl border border-slate-200 bg-white px-2 py-2"><Phone size={12} className="mx-auto mb-1 text-quotefly-blue" />Call</span>
            <span className="rounded-xl border border-slate-200 bg-white px-2 py-2"><QuoteIcon size={12} className="mx-auto mb-1 text-quotefly-blue" />Quotes</span>
          </div>
        </div>

        <div className="relative z-10 w-full max-w-[332px] rounded-[42px] bg-slate-950 p-[8px] shadow-[0_32px_70px_rgba(15,23,42,0.3)] ring-1 ring-white/30 sm:max-w-[350px]">
          <div className="pointer-events-none absolute left-1/2 top-[12px] z-30 h-[18px] w-[72px] -translate-x-1/2 rounded-full bg-slate-950" />
          <div className="relative h-[560px] overflow-hidden rounded-[34px] bg-[#f4f7fb] sm:h-[585px]">
            <div className="flex h-[58px] items-end justify-between border-b border-slate-200 bg-white px-3 pb-2.5 pt-5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm">
                  <img src="/favicon.png" alt="" className="h-7 w-7" />
                </span>
                <div>
                  <p className="text-[10px] font-bold leading-none text-slate-950">Quotes</p>
                  <p className="mt-1 text-[7px] leading-none text-slate-500">QuoteFly workspace</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-slate-500">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white"><Search size={12} /></span>
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white"><MoreHorizontal size={13} /></span>
              </div>
            </div>

            <div className="h-[calc(100%-58px)] overflow-hidden px-3 pb-[106px] pt-3">
              <div className="mb-2.5">
                <p className="text-[13px] font-bold text-slate-950">Quick Quote</p>
                <p className="mt-0.5 text-[7px] text-slate-500">Choose a customer, price the work, preview, and create.</p>
              </div>

              <div className="mb-2.5 grid grid-cols-2 gap-2" role="group" aria-label="Quote demo view">
                {(["editor", "preview"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={pane === id}
                    onClick={() => setPane(id)}
                    className={`min-h-9 rounded-full border px-3 text-[9px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-quotefly-blue focus-visible:ring-offset-2 ${
                      pane === id
                        ? "border-quotefly-blue/20 bg-quotefly-blue/[0.09] text-quotefly-blue"
                        : "border-slate-200 bg-white text-slate-600"
                    }`}
                  >
                    {id === "editor" ? "Edit quote" : "Preview"}
                  </button>
                ))}
              </div>

              <div key={pane} className="qf-demo-pane-enter">
                {pane === "editor" ? <EditorPane /> : <PreviewPane />}
              </div>
            </div>

            <div className="absolute inset-x-2.5 bottom-[52px] z-20 rounded-2xl border border-slate-200 bg-white/96 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.16)] backdrop-blur">
              <div className="mb-1.5 flex items-center justify-between px-1 text-[7px] text-slate-500">
                <span>1 line</span><span>Total $189.00</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-center text-[8px] font-bold">
                <button
                  type="button"
                  onClick={() => setPane((current) => current === "editor" ? "preview" : "editor")}
                  className="inline-flex min-h-8 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-quotefly-blue"
                >
                  <Eye size={10} /> {pane === "editor" ? "Preview" : "Edit Quote"}
                </button>
                <span className="inline-flex min-h-8 items-center justify-center rounded-lg bg-quotefly-blue text-white shadow-sm">Create Quote</span>
              </div>
            </div>

            <div aria-label="Mobile workspace preview" className="absolute inset-x-2 bottom-1.5 z-10 grid h-[47px] grid-cols-5 items-center rounded-2xl border border-slate-200 bg-white/97 px-1 shadow-[0_10px_26px_rgba(15,23,42,0.12)]">
              <DemoNavItem icon={<UsersRound size={12} />} label="Customers" />
              <DemoNavItem icon={<QuoteIcon size={12} />} label="Quotes" active />
              <DemoNavItem icon={<FilePlus2 size={13} />} label="New quote" active />
              <DemoNavItem icon={<BarChart3 size={12} />} label="Analytics" />
              <DemoNavItem icon={<Settings2 size={12} />} label="Settings" />
            </div>
          </div>
        </div>

        <div aria-hidden="true" className="absolute bottom-20 right-5 hidden w-[184px] rotate-[2deg] rounded-2xl border border-white/90 bg-white/94 p-4 shadow-[0_20px_46px_rgba(15,23,42,0.16)] backdrop-blur xl:block">
          <div className="h-1 rounded-full bg-gradient-to-r from-quotefly-blue to-quotefly-orange" />
          <p className="mt-3 text-[8px] font-bold uppercase tracking-[0.16em] text-quotefly-blue">Ready to send</p>
          <p className="mt-1 text-[12px] font-bold text-slate-950">Heat pump tune-up</p>
          <p className="mt-1 text-[8px] text-slate-500">Sample Customer</p>
          <div className="my-3 h-px bg-slate-200" />
          <div className="space-y-2 text-[8px] text-slate-600">
            <div className="flex justify-between gap-2"><span>Seasonal maintenance</span><span className="font-bold text-slate-900">$189</span></div>
            <div className="flex justify-between gap-2 rounded-lg bg-quotefly-blue/[0.08] px-2 py-2 font-bold text-slate-900"><span>Total</span><span>$189</span></div>
          </div>
        </div>

        <div aria-hidden="true" className="absolute bottom-5 left-1/2 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-white/90 bg-white/94 px-4 py-2 text-[9px] font-bold text-slate-700 shadow-lg backdrop-blur sm:flex">
          <span>Find customer</span><span className="text-quotefly-orange">→</span><span>Price work</span><span className="text-quotefly-orange">→</span><span>Preview &amp; create</span>
        </div>
      </div>

      <figcaption className="sr-only">
        QuoteFly mobile Quick Quote workflow shown with sample data, including customer selection, line-item pricing, preview, create quote controls, and mobile navigation.
      </figcaption>
    </figure>
  );
}
