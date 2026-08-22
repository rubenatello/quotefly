import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, FileText, UserRound } from "lucide-react";
import type { BrandingComponentColors, BrandingLogoPosition, BrandingTemplateId, SupportedLocale } from "../../lib/api";
import { isSupportedBrandLogoDataUrl } from "../../lib/brand-logo";
import { quoteDocumentCopy } from "../../lib/quote-document-copy";
import { Badge } from "../ui";
import { QuoteAttributionFooter } from "./quote-footer";
import { getQuoteTemplateOption } from "./quote-template";

export function QuoteSheetEditor({
  title,
  onTitleChange,
  titlePlaceholder,
  titleTools,
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
  overviewTools,
  actions,
  logoUrl,
  logoPosition = "left",
  templateId = "modern",
  accentColor = "#4F7FD2",
  componentColors,
  footerText,
  showQuoteFlyAttribution,
  documentLocale = "en-US",
  readOnly = false,
  children,
}: {
  title: string;
  onTitleChange: (value: string) => void;
  titlePlaceholder?: string;
  titleTools?: ReactNode;
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
  overviewTools?: ReactNode;
  actions?: ReactNode;
  logoUrl?: string | null;
  logoPosition?: BrandingLogoPosition;
  templateId?: BrandingTemplateId;
  accentColor?: string;
  componentColors?: BrandingComponentColors | null;
  footerText?: string;
  showQuoteFlyAttribution?: boolean;
  documentLocale?: SupportedLocale;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const copy = quoteDocumentCopy(documentLocale);
  const logo = isSupportedBrandLogoDataUrl(logoUrl) ? <BrandLogo logoUrl={logoUrl} /> : null;
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const template = getQuoteTemplateOption(templateId);
  const sectionLabelColor = componentColors?.sectionTitleColor ?? "#64748b";
  const usesFullBleedAccent = template.headerStyle === "bar";

  return (
    <div
      data-testid="quote-sheet-editor"
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                      <span className="sm:hidden">{t("quoteComponents.sheet.details")}</span>
                      <span className="hidden sm:inline">{t("quoteComponents.sheet.editable")}</span>
                    </p>
                    {titleTools}
                  </div>
                  <input
                    aria-label={t("quoteComponents.sheet.titleLabel")}
                    value={title}
                    onChange={(event) => onTitleChange(event.target.value)}
                    placeholder={titlePlaceholder ?? copy.untitledQuote}
                    readOnly={readOnly}
                    className={`mt-2 w-full border-0 px-0 text-[1.4rem] font-semibold tracking-tight text-slate-950 placeholder:text-slate-400 sm:text-[1.9rem] ${
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
              <Badge tone="blue" icon={<FileText size={12} />} className="hidden border-transparent bg-[var(--qf-brand-blue-soft)] text-[var(--qf-link)] sm:inline-flex">
                {t("quoteComponents.sheet.customerView")}
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
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: sectionLabelColor }}>{copy.customer}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{customerName}</p>
                  {customerHint ? <p className="mt-1 text-xs leading-5 text-slate-500">{customerHint}</p> : null}
                </div>
                <button
                  type="button"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1 rounded-lg border border-[var(--qf-border)] bg-white px-3 text-xs font-medium text-slate-700 sm:min-h-[36px]"
                >
                  {mobileDetailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {mobileDetailsOpen ? t("quoteComponents.sheet.hideDetails") : t("quoteComponents.sheet.showDetails")}
                </button>
              </div>
              {customerTools ? <div className="mt-3">{customerTools}</div> : null}
            </div>
          </div>

          <div className={`space-y-5 ${mobileDetailsOpen ? "" : "hidden"} sm:block`}>
            <div className="hidden gap-5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <SheetParty label={copy.business} value={businessName} hint={businessHint} labelColor={sectionLabelColor} />
              <SheetParty
                label={copy.customer}
                value={customerName}
                hint={customerHint}
                icon={<UserRound size={14} />}
                tools={customerTools}
                labelColor={sectionLabelColor}
              />
            </div>

            <div className="hidden gap-4 border-y border-[var(--qf-border)] py-4 sm:grid sm:grid-cols-2">
              <SheetMeta label={copy.prepared} value={preparedDateLabel} labelColor={sectionLabelColor} />
              <SheetMeta label={copy.sent} value={sentDateLabel} labelColor={sectionLabelColor} />
            </div>

            <div className="sm:hidden rounded-xl border border-[var(--qf-border)] bg-white px-3 py-3">
              <SheetParty label={copy.business} value={businessName} hint={businessHint} labelColor={sectionLabelColor} />
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: sectionLabelColor }}>
                  {copy.overview}
                </label>
                {overviewTools}
              </div>
              <textarea
                aria-label={t("quoteComponents.sheet.overviewLabel")}
                rows={3}
                value={overview}
                onChange={(event) => onOverviewChange(event.target.value)}
                placeholder={overviewPlaceholder ?? t("quoteComponents.sheet.overviewPlaceholder")}
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
        <div className="hidden sm:block">
          <QuoteAttributionFooter footerText={footerText} showQuoteFlyAttribution={showQuoteFlyAttribution} documentLocale={documentLocale} />
        </div>
      </div>
    </div>
  );
}

function BrandLogo({ logoUrl }: { logoUrl: string }) {
  return (
    <div className="flex h-14 max-w-[220px] items-center">
      <img src={logoUrl} alt="" aria-hidden="true" className="max-h-12 w-auto max-w-full object-contain" />
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
  labelColor,
}: {
  label: string;
  value: string;
  labelColor?: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: labelColor ?? "#64748b" }}>
        {label}
      </p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
