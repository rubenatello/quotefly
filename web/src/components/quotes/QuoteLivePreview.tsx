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
    <div className="rounded-[28px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Live quote preview</p>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">
            {quoteTitle.trim() || "Untitled quote"}
          </h3>
        </div>
        <Badge tone="blue" icon={<FileText size={12} />}>
          Customer view
        </Badge>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewBlock label="Business" value={businessName} />
          <PreviewBlock
            label="Customer"
            value={customerName || "Select customer"}
            hint={[customerPhone, customerEmail].filter(Boolean).join(" / ") || "Customer details will show here."}
            icon={<UserRound size={14} />}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewMeta label="Prepared" value={preparedDateLabel} />
          <PreviewMeta label="Sent" value={sentDateLabel || "N/A"} />
        </div>

        {scopeText.trim() ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{scopeText}</p>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-slate-200">
          <div className="grid grid-cols-[minmax(0,1.6fr)_72px_96px_110px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <span>Line</span>
            <span>Qty</span>
            <span>Price</span>
            <span>Total</span>
          </div>
          <div className="divide-y divide-slate-200">
            {lines.length ? (
              lines.map((line) => (
                <div key={line.id} className="grid grid-cols-[minmax(0,1.6fr)_72px_96px_110px] gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{line.title || "Untitled line"}</p>
                    {line.details.trim() ? (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500">{line.details}</p>
                    ) : null}
                  </div>
                  <span className="text-slate-700">{line.quantity}</span>
                  <span className="text-slate-700">{money(line.unitPrice)}</span>
                  <span className="font-semibold text-slate-900">{money(line.lineTotal)}</span>
                </div>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                Add quote lines to see the customer-facing document take shape.
              </div>
            )}
          </div>
        </div>

        <div className="ml-auto max-w-[260px] space-y-2">
          <PreviewTotalRow label="Subtotal" value={money(customerSubtotal)} />
          <PreviewTotalRow label="Tax" value={money(taxAmount)} />
          <PreviewTotalRow label="Total" value={money(totalAmount)} strong />
        </div>
      </div>
    </div>
  );
}

function PreviewBlock({
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
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-2 flex items-start gap-2">
        {icon ? <span className="mt-0.5 text-slate-400">{icon}</span> : null}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{value}</p>
          {hint ? <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p> : null}
        </div>
      </div>
    </div>
  );
}

function PreviewMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
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
