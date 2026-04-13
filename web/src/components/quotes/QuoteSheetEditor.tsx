import type { ReactNode } from "react";
import { FileText, UserRound } from "lucide-react";
import type { BrandingLogoPosition } from "../../lib/api";
import { Badge } from "../ui";

export function QuoteSheetEditor({
  title,
  onTitleChange,
  titlePlaceholder,
  businessName,
  businessHint,
  customerName,
  customerHint,
  headerTools,
  customerTools,
  preparedDateLabel,
  sentDateLabel,
  overview,
  onOverviewChange,
  overviewPlaceholder,
  actions,
  logoUrl,
  logoPosition = "left",
  accentColor = "#4F7FD2",
  readOnly = false,
  children,
}: {
  title: string;
  onTitleChange: (value: string) => void;
  titlePlaceholder?: string;
  businessName: string;
  businessHint?: string;
  customerName: string;
  customerHint?: string;
  headerTools?: ReactNode;
  customerTools?: ReactNode;
  preparedDateLabel: string;
  sentDateLabel: string;
  overview: string;
  onOverviewChange: (value: string) => void;
  overviewPlaceholder?: string;
  actions?: ReactNode;
  logoUrl?: string | null;
  logoPosition?: BrandingLogoPosition;
  accentColor?: string;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const logo = logoUrl ? <BrandLogo logoUrl={logoUrl} /> : null;

  return (
    <div className="rounded-[20px] border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-2.5 shadow-[var(--qf-shadow-sm)] sm:p-3">
      <div className="rounded-[16px] border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-md)]">
        <div className="h-1.5 rounded-t-[16px]" style={{ backgroundColor: accentColor }} />

        <div className="px-5 py-4 sm:px-6 sm:py-4.5">
          {logoPosition === "center" && logo ? <div className="mb-4 flex justify-center">{logo}</div> : null}
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-4">
                {logoPosition === "left" ? logo : null}
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Editable quote sheet</p>
                  <input
                    value={title}
                    onChange={(event) => onTitleChange(event.target.value)}
                    placeholder={titlePlaceholder ?? "Untitled quote"}
                    readOnly={readOnly}
                    className={`mt-2 w-full border-0 px-0 text-[1.7rem] font-semibold tracking-tight text-slate-950 placeholder:text-slate-400 sm:text-[1.9rem] ${
                      readOnly
                        ? "cursor-default bg-transparent focus:outline-none"
                        : "bg-transparent focus:outline-none"
                    }`}
                  />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 self-start">
              {logoPosition === "right" ? logo : null}
              <Badge tone="blue" icon={<FileText size={12} />}>
                Customer view
              </Badge>
              {actions}
            </div>
          </div>
          {headerTools ? <div className="mt-3 flex justify-end">{headerTools}</div> : null}
        </div>

        <div className="space-y-5 border-t border-[var(--qf-border)] px-5 py-5 sm:px-6 sm:py-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <SheetParty label="Business" value={businessName} hint={businessHint} />
            <SheetParty
              label="Customer"
              value={customerName}
              hint={customerHint}
              icon={<UserRound size={14} />}
              tools={customerTools}
            />
          </div>

          <div className="grid gap-4 border-y border-[var(--qf-border)] py-4 sm:grid-cols-2">
            <SheetMeta label="Prepared" value={preparedDateLabel} />
            <SheetMeta label="Sent" value={sentDateLabel} />
          </div>

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</label>
            <textarea
              rows={3}
              value={overview}
              onChange={(event) => onOverviewChange(event.target.value)}
              placeholder={overviewPlaceholder ?? "Optional overview shown near the top of the quote."}
              readOnly={readOnly}
              className={`mt-2 min-h-[104px] w-full rounded-xl border border-[var(--qf-border)] px-4 py-3 text-sm leading-6 text-slate-800 placeholder:text-slate-400 ${
                readOnly
                  ? "cursor-default bg-slate-50 focus:outline-none"
                  : "bg-white focus:border-[var(--qf-brand-blue)] focus:outline-none focus:ring-4 focus:ring-[color:rgba(47,111,214,0.12)]"
              }`}
            />
          </div>

          {children}
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

function SheetParty({
  label,
  value,
  hint,
  icon,
  tools,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-2 flex items-start gap-2">
        {icon ? <span className="mt-0.5 text-slate-400">{icon}</span> : null}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 sm:text-[15px]">{value}</p>
          {hint ? <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p> : null}
          {tools ? <div className="mt-2.5">{tools}</div> : null}
        </div>
      </div>
    </div>
  );
}

function SheetMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
