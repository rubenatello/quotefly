import type { ReactNode } from "react";
import { FileText, UserRound } from "lucide-react";
import type { BrandingLogoPosition } from "../../lib/api";
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
  businessHint,
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
  logoUrl,
  logoPosition = "left",
  accentColor = "#4F7FD2",
}: {
  businessName: string;
  businessHint?: string;
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
  logoUrl?: string | null;
  logoPosition?: BrandingLogoPosition;
  accentColor?: string;
}) {
  const logo = logoUrl ? <BrandLogo logoUrl={logoUrl} /> : null;

  return (
    <div className="rounded-[20px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-2.5 shadow-[var(--qf-shadow-sm)] sm:p-3">
      <div className="rounded-[16px] border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-md)]">
        <div className="h-1.5 rounded-t-[16px]" style={{ backgroundColor: accentColor }} />

        <div className="px-5 py-4 sm:px-6 sm:py-5">
          {logoPosition === "center" && logo ? <div className="mb-4 flex justify-center">{logo}</div> : null}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-4">
                {logoPosition === "left" ? logo : null}
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Live quote preview</p>
                  <h3 className="mt-2 text-[1.3rem] font-semibold tracking-tight text-slate-950 sm:text-[1.45rem]">
                    {quoteTitle.trim() || "Untitled quote"}
                  </h3>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {logoPosition === "right" ? logo : null}
              <Badge tone="blue" icon={<FileText size={12} />}>
                Customer view
              </Badge>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-[var(--qf-border)] px-5 py-5 sm:px-6 sm:py-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <PreviewPartyBlock label="Business" value={businessName} hint={businessHint} />
            <PreviewPartyBlock
              label="Customer"
              value={customerName || "Select customer"}
              hint={[customerPhone, customerEmail].filter(Boolean).join(" / ") || "Customer details will show here."}
              icon={<UserRound size={14} />}
            />
          </div>

          <div className="grid gap-4 border-y border-[var(--qf-border)] py-4 sm:grid-cols-2">
            <PreviewMeta label="Prepared" value={preparedDateLabel} />
            <PreviewMeta label="Sent" value={sentDateLabel || "N/A"} />
          </div>

          {scopeText.trim() ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{scopeText}</p>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-xl border border-[var(--qf-border)]">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_72px_96px_110px] gap-3 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 md:grid">
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
                    className="space-y-3 px-4 py-2.5 text-sm md:grid md:grid-cols-[minmax(0,1.6fr)_72px_96px_110px] md:gap-3 md:space-y-0"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{line.title || "Untitled line"}</p>
                      {line.details.trim() ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500">{line.details}</p>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-2 md:contents md:rounded-none md:border-0 md:bg-transparent md:p-0">
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

function BrandLogo({ logoUrl }: { logoUrl: string }) {
  return (
    <div className="flex h-12 max-w-[180px] items-center">
      <img src={logoUrl} alt="Company logo" className="max-h-10 w-auto max-w-full object-contain" />
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
    <div className="flex items-center justify-between rounded-lg border border-[var(--qf-border)] bg-white px-3 py-2.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={strong ? "font-semibold text-slate-950" : "font-medium text-slate-900"}>{value}</span>
    </div>
  );
}
