import type { ReactNode } from "react";
import { FileText, UserRound } from "lucide-react";
import { money } from "../dashboard/DashboardContext";
import { Badge } from "../ui";

export type QuotePreviewLine = {
  id: string;
  title: string;
  details: string;
  quantity: string;
  unitPrice: string;
  lineTotal: number;
};

export function QuoteLivePreview({
  businessName,
  customerName,
  customerPhone,
  customerEmail,
  preparedDateLabel,
  sentDateLabel,
  quoteTitle,
  scopeText,
  lines,
  customerSubtotal,
  taxAmount,
  totalAmount,
}: {
  businessName: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  preparedDateLabel: string;
  sentDateLabel: string;
  quoteTitle: string;
  scopeText: string;
  lines: QuotePreviewLine[];
  customerSubtotal: number;
  taxAmount: number;
  totalAmount: number;
}) {
  return (
    <div className="rounded-[24px] border border-slate-200 bg-slate-100/70 p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-4">
      <div className="rounded-[20px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
        <div className="h-1.5 rounded-t-[20px] bg-quotefly-blue" />

        <div className="flex items-start justify-between gap-3 px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Live quote preview</p>
            <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">
              {quoteTitle.trim() || "Untitled quote"}
            </h3>
          </div>
          <Badge tone="blue" icon={<FileText size={12} />}>
            Customer view
          </Badge>
        </div>

        <div className="space-y-6 border-t border-slate-200 px-5 py-5 sm:px-6 sm:py-6">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <PreviewPartyBlock label="Business" value={businessName} />
            <PreviewPartyBlock
              label="Customer"
              value={customerName || "Select customer"}
              hint={[customerPhone, customerEmail].filter(Boolean).join(" / ") || "Customer details will show here."}
              icon={<UserRound size={14} />}
            />
          </div>

          <div className="grid gap-4 border-y border-slate-200 py-4 sm:grid-cols-2">
            <PreviewMeta label="Prepared" value={preparedDateLabel} />
            <PreviewMeta label="Sent" value={sentDateLabel || "N/A"} />
          </div>

          {scopeText.trim() ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{scopeText}</p>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_72px_96px_110px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 md:grid">
              <span>Line</span>
              <span>Qty</span>
              <span>Price</span>
              <span>Total</span>
            </div>
            <div className="divide-y divide-slate-200">
              {lines.length ? (
                lines.map((line) => (
                  <div
                    key={line.id}
                    className="space-y-3 px-4 py-3 text-sm md:grid md:grid-cols-[minmax(0,1.6fr)_72px_96px_110px] md:gap-3 md:space-y-0"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{line.title || "Untitled line"}</p>
                      {line.details.trim() ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500">{line.details}</p>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 md:contents md:rounded-none md:border-0 md:bg-transparent md:p-0">
                      <PreviewLineMeta label="Qty" value={line.quantity} />
                      <PreviewLineMeta label="Price" value={money(line.unitPrice)} />
                      <PreviewLineMeta label="Total" value={money(line.lineTotal)} strong />
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-sm text-slate-500">
                  Add quote lines to see the customer-facing document take shape.
                </div>
              )}
            </div>
          </div>

          <div className="ml-auto max-w-[280px] space-y-2">
            <PreviewTotalRow label="Subtotal" value={money(customerSubtotal)} />
            <PreviewTotalRow label="Tax" value={money(taxAmount)} />
            <PreviewTotalRow label="Total" value={money(totalAmount)} strong />
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewPartyBlock({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-2 flex items-start gap-2">
        {icon ? <span className="mt-0.5 text-slate-400">{icon}</span> : null}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 sm:text-[15px]">{value}</p>
          {hint ? <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p> : null}
        </div>
      </div>
    </div>
  );
}

function PreviewMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function PreviewLineMeta({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="space-y-1 md:space-y-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 md:hidden">{label}</p>
      <p className={`text-xs md:text-sm ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}>{value}</p>
    </div>
  );
}

function PreviewTotalRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={strong ? "font-semibold text-slate-950" : "font-medium text-slate-900"}>{value}</span>
    </div>
  );
}
