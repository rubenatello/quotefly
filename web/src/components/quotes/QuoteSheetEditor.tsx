import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, FileText, UserRound } from "lucide-react";
import type { BrandingComponentColors, BrandingLogoPosition, BrandingTemplateId } from "../../lib/api";
import { Badge } from "../ui";
import { QuoteAttributionFooter } from "./quote-footer";
import { getQuoteTemplateOption } from "./quote-template";

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
  templateId = "modern",
  accentColor = "#4F7FD2",
  componentColors,
  footerText,
  showQuoteFlyAttribution,
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
  templateId?: BrandingTemplateId;
  accentColor?: string;
  componentColors?: BrandingComponentColors | null;
  footerText?: string;
  showQuoteFlyAttribution?: boolean;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const logo = logoUrl ? <BrandLogo logoUrl={logoUrl} /> : null;
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const template = getQuoteTemplateOption(templateId);
  const sectionLabelColor = componentColors?.sectionTitleColor ?? "#64748b";
  const usesFullBleedAccent = template.headerStyle === "bar";

  return (
    <div
      className={`overflow-hidden rounded-[20px] border border-[var(--qf-border)] shadow-[var(--qf-shadow-sm)] ${
        usesFullBleedAccent ? "bg-[var(--qf-panel)]" : "p-2.5 sm:p-3"
      } ${
        template.id === "minimal" ? "bg-white" : "bg-[var(--qf-panel-muted)]"
      }`}
    >
      {usesFullBleedAccent ? <div className="h-1.5 w-full" style={{ backgroundColor: accentColor }} /> : null}
      <div
        className={`${
          usesFullBleedAccent ? "rounded-none border-0 shadow-none" : "rounded-[16px] border border-[var(--qf-border)] shadow-[var(--qf-shadow-md)]"
        } ${
          template.id === "professional" ? "bg-slate-50/70" : "bg-[var(--qf-panel)]"
        }`}
      >
        {template.headerStyle === "bar" && !usesFullBleedAccent ? <div className="h-1.5 rounded-t-[16px]" style={{ backgroundColor: accentColor }} /> : null}

        <div className={`px-5 py-4 sm:px-6 sm:py-4.5 ${template.headerStyle === "card" ? "relative sm:pl-9" : ""}`}>
          {template.headerStyle === "card" ? (
            <div
              className="absolute bottom-4 left-5 top-4 hidden w-1 rounded-full sm:block"
              style={{ backgroundColor: accentColor }}
            />
          ) : null}
          {logoPosition === "center" && logo ? <div className="mb-4 flex justify-center">{logo}</div> : null}
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-4">
                {logoPosition === "left" ? logo : null}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Editable quote sheet</p>
                  </div>
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
              <Badge tone="blue" icon={<FileText size={12} />} className="border-transparent bg-[var(--qf-brand-blue-soft)] text-[var(--qf-brand-blue)]">
                Customer view
              </Badge>
              {actions}
            </div>
          </div>
          {headerTools ? <div className="mt-3 flex justify-end">{headerTools}</div> : null}
        </div>

        <div className="space-y-5 border-t border-[var(--qf-border)] px-5 py-5 sm:px-6 sm:py-5">
          <div className="sm:hidden">
            <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: sectionLabelColor }}>Customer</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{customerName}</p>
                  {customerHint ? <p className="mt-1 text-xs leading-5 text-slate-500">{customerHint}</p> : null}
                </div>
                <button
                  type="button"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg border border-[var(--qf-border)] bg-white px-3 text-xs font-medium text-slate-700"
                >
                  {mobileDetailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {mobileDetailsOpen ? "Hide details" : "Show details"}
                </button>
              </div>
              {customerTools ? <div className="mt-3">{customerTools}</div> : null}
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[var(--qf-border)] pt-3">
                <SheetMeta label="Prepared" value={preparedDateLabel} compact labelColor={sectionLabelColor} />
                <SheetMeta label="Sent" value={sentDateLabel} compact labelColor={sectionLabelColor} />
              </div>
            </div>
          </div>

          <div className={`space-y-5 ${mobileDetailsOpen ? "" : "hidden"} sm:block`}>
            <div className="hidden gap-5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <SheetParty label="Business" value={businessName} hint={businessHint} labelColor={sectionLabelColor} />
              <SheetParty
                label="Customer"
                value={customerName}
                hint={customerHint}
                icon={<UserRound size={14} />}
                tools={customerTools}
                labelColor={sectionLabelColor}
              />
            </div>

            <div className="hidden gap-4 border-y border-[var(--qf-border)] py-4 sm:grid sm:grid-cols-2">
              <SheetMeta label="Prepared" value={preparedDateLabel} labelColor={sectionLabelColor} />
              <SheetMeta label="Sent" value={sentDateLabel} labelColor={sectionLabelColor} />
            </div>

            <div className="sm:hidden rounded-xl border border-[var(--qf-border)] bg-white px-3 py-3">
              <SheetParty label="Business" value={businessName} hint={businessHint} labelColor={sectionLabelColor} />
            </div>

            <div>
              <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: sectionLabelColor }}>
                Overview
              </label>
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
          </div>

          {children}
        </div>
        <QuoteAttributionFooter footerText={footerText} showQuoteFlyAttribution={showQuoteFlyAttribution} />
      </div>
    </div>
  );
}

function BrandLogo({ logoUrl }: { logoUrl: string }) {
  return (
    <div className="flex h-14 max-w-[220px] items-center">
      <img src={logoUrl} alt="Company logo" className="max-h-12 w-auto max-w-full object-contain" />
    </div>
  );
}

function SheetParty({
  label,
  value,
  hint,
  icon,
  tools,
  labelColor,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tools?: ReactNode;
  labelColor?: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: labelColor ?? "#64748b" }}>
        {label}
      </p>
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

function SheetMeta({
  label,
  value,
  compact,
  labelColor,
}: {
  label: string;
  value: string;
  compact?: boolean;
  labelColor?: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: labelColor ?? "#64748b" }}>
        {label}
      </p>
      <p className={`text-sm font-semibold text-slate-900 ${compact ? "mt-1" : "mt-2"}`}>{value}</p>
    </div>
  );
}
