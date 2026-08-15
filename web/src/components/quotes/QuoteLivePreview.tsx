import type { ReactNode } from "react";
import type { BrandingComponentColors, BrandingLogoPosition, BrandingTemplateId } from "../../lib/api";
import { isSupportedBrandLogoDataUrl } from "../../lib/brand-logo";
import { money } from "../dashboard/DashboardContext";
import { QuoteAttributionFooter } from "./quote-footer";
import { getQuoteTemplateOption } from "./quote-template";

export type QuotePreviewLine = {
  id: string;
  title: string;
  details: string;
  sectionType?: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
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
  templateId = "modern",
  accentColor = "#4F7FD2",
  componentColors,
  footerText,
  showQuoteFlyAttribution,
  quoteReferenceLabel = "Quote preview",
  subtitle = "Customer quote",
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
  templateId?: BrandingTemplateId;
  accentColor?: string;
  componentColors?: BrandingComponentColors | null;
  footerText?: string;
  showQuoteFlyAttribution?: boolean;
  quoteReferenceLabel?: string;
  subtitle?: string;
}) {
  const logo = isSupportedBrandLogoDataUrl(logoUrl) ? <BrandLogo logoUrl={logoUrl} /> : null;
  const template = getQuoteTemplateOption(templateId);
  const headerBgColor = componentColors?.headerBgColor ?? accentColor;
  const headerTextColor = componentColors?.headerTextColor ?? getContrastingTextColor(headerBgColor);
  const sectionLabelColor = componentColors?.sectionTitleColor ?? "#64748b";
  const tableHeaderBgColor = componentColors?.tableHeaderBgColor ?? accentColor;
  const tableHeaderTextColor = componentColors?.tableHeaderTextColor ?? getContrastingTextColor(tableHeaderBgColor);
  const totalsColor = componentColors?.totalsColor ?? accentColor;
  const includedLines = lines.filter((line) => line.sectionType !== "ALTERNATE");
  const alternateSections = Object.values(
    lines
      .filter((line) => line.sectionType === "ALTERNATE")
      .reduce<Record<string, QuotePreviewLine[]>>((groups, line) => {
        const key = line.sectionLabel?.trim() || "Alternate Option";
        groups[key] = groups[key] ? [...groups[key], line] : [line];
        return groups;
      }, {}),
  ).map((sectionLines) => ({
    label: sectionLines[0]?.sectionLabel?.trim() || "Alternate Option",
    lines: sectionLines,
    subtotal: sectionLines.reduce((sum, line) => sum + line.lineTotal, 0),
  }));

  return (
    <div
      className={`rounded-[28px] border border-[var(--qf-border)] p-3 shadow-[var(--qf-shadow-sm)] sm:p-4 ${
        template.id === "professional" ? "bg-slate-50/80" : "bg-[var(--qf-panel-muted)]"
      }`}
    >
      <div className="rounded-[24px] border border-[var(--qf-border)] bg-white p-4 shadow-[var(--qf-shadow-md)] sm:p-6">
        <PreviewHeaderCard
          headerBgColor={headerBgColor}
          headerTextColor={headerTextColor}
          logo={logo}
          logoPosition={logoPosition}
          quoteTitle={quoteTitle}
          preparedDateLabel={preparedDateLabel}
          sentDateLabel={sentDateLabel}
          quoteReferenceLabel={quoteReferenceLabel}
          subtitle={subtitle}
          templateId={template.id}
        />

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <PreviewInfoCard
            label="Business"
            value={businessName}
            hint={businessHint}
            labelColor={sectionLabelColor}
          />
          <PreviewInfoCard
            label="Customer"
            value={customerName || "Select customer"}
            hint={[customerPhone, customerEmail].filter(Boolean).join(" / ") || "Customer details will show here."}
            labelColor={sectionLabelColor}
          />
        </div>

        {scopeText.trim() ? (
          <div className="mt-5">
            <p
              className="text-[11px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: sectionLabelColor }}
            >
              Overview
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-700">{scopeText}</p>
          </div>
        ) : null}

        <div className="mt-5">
          <p
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: sectionLabelColor }}
          >
            Included Work
          </p>

          <div className="mt-3 overflow-hidden rounded-xl border border-[var(--qf-border)] bg-white">
            <div
              className="hidden grid-cols-[minmax(0,1.7fr)_72px_96px_110px] gap-3 border-b border-[var(--qf-border)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] md:grid"
              style={{ backgroundColor: tableHeaderBgColor, color: tableHeaderTextColor }}
            >
              <span>Description</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Unit</span>
              <span className="text-right">Total</span>
            </div>

            <div className="divide-y divide-slate-200">
              {includedLines.length ? (
                includedLines.map((line) => (
                  <div
                    key={line.id}
                    className="space-y-3 px-4 py-3 text-sm md:grid md:grid-cols-[minmax(0,1.7fr)_72px_96px_110px] md:gap-3 md:space-y-0"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{line.title || "Untitled line"}</p>
                      {line.details.trim() ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500">{line.details}</p>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-3 gap-2 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-2 md:contents md:rounded-none md:border-0 md:bg-transparent md:p-0">
                      <PreviewLineMeta label="Qty" value={line.quantity} />
                      <PreviewLineMeta label="Unit" value={money(line.unitPrice)} />
                      <PreviewLineMeta label="Total" value={money(line.lineTotal)} strong accentColor={totalsColor} />
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
        </div>

        {alternateSections.length ? (
          <div className="mt-5 space-y-3">
            <p
              className="text-[11px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: sectionLabelColor }}
            >
              Alternate pricing
            </p>

            <div className="space-y-3">
              {alternateSections.map((section) => (
                <div key={section.label} className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{section.label}</p>
                      <p className="text-xs text-slate-500">
                        Optional pricing. Not included in the main total below.
                      </p>
                    </div>
                    <div className="text-sm font-semibold text-amber-700">{money(section.subtotal)}</div>
                  </div>

                  <div className="space-y-2">
                    {section.lines.map((line) => (
                      <div key={line.id} className="rounded-lg border border-white/80 bg-white/80 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900">{line.title || "Untitled line"}</p>
                            {line.details.trim() ? (
                              <p className="mt-1 text-xs leading-5 text-slate-500">{line.details}</p>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-sm font-semibold text-slate-900">
                            {money(line.lineTotal)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <div className="w-full max-w-[280px] rounded-xl border border-[var(--qf-border)] bg-white px-4 py-3 shadow-[var(--qf-shadow-sm)]">
            <PreviewTotalRow label="Subtotal" value={money(customerSubtotal)} />
            <PreviewTotalRow label="Tax" value={money(taxAmount)} />
            <PreviewTotalRow label="Total" value={money(totalAmount)} strong accentColor={totalsColor} />
          </div>
        </div>

        <div className="mt-5">
          <QuoteAttributionFooter
            footerText={footerText}
            showQuoteFlyAttribution={showQuoteFlyAttribution}
            textColor={componentColors?.footerTextColor}
          />
        </div>
      </div>
    </div>
  );
}

function PreviewHeaderCard({
  headerBgColor,
  headerTextColor,
  logo,
  logoPosition,
  quoteTitle,
  preparedDateLabel,
  sentDateLabel,
  quoteReferenceLabel,
  subtitle,
  templateId,
}: {
  headerBgColor: string;
  headerTextColor: string;
  logo: ReactNode;
  logoPosition: BrandingLogoPosition;
  quoteTitle: string;
  preparedDateLabel: string;
  sentDateLabel: string;
  quoteReferenceLabel: string;
  subtitle: string;
  templateId: "modern" | "professional" | "minimal";
}) {
  const alignmentClass =
    logoPosition === "center"
      ? "items-center text-center"
      : logoPosition === "right"
        ? "items-end text-right"
        : "items-start text-left";
  const isProfessional = templateId === "professional";
  const shellClass =
    templateId === "minimal"
      ? "border-b border-[var(--qf-border)] bg-white"
      : "overflow-hidden rounded-[24px] border border-[var(--qf-border)] shadow-[var(--qf-shadow-sm)]";
  const rowClass =
    logoPosition === "center"
      ? "items-center text-center"
      : logoPosition === "right"
        ? "items-end text-right sm:flex-row-reverse sm:items-center"
        : "items-start text-left sm:flex-row sm:items-center";
  const metaClass = isProfessional
    ? "border-white/25"
    : "border-[var(--qf-border)]";

  return (
    <section
      className={`${shellClass} ${isProfessional ? "bg-transparent" : "bg-white"}`}
      style={isProfessional ? { backgroundColor: headerBgColor, color: headerTextColor } : undefined}
    >
      {templateId === "modern" ? (
        <div className="h-1.5" style={{ backgroundColor: headerBgColor }} />
      ) : null}

      <div className="px-5 py-5 sm:px-6 sm:py-6">
        <div className={`flex min-w-0 flex-col gap-4 ${rowClass}`}>
          {logo ? (
            <div className={`flex max-w-full shrink-0 ${isProfessional ? "rounded-xl bg-white p-2" : ""}`}>
              {logo}
            </div>
          ) : null}
          <div className={`min-w-0 flex-1 ${alignmentClass}`}>
            <h3
              className={`max-w-full break-words text-[1.3rem] font-semibold tracking-tight sm:text-[1.45rem] ${
                isProfessional ? "" : "text-slate-950"
              }`}
              style={isProfessional ? { color: headerTextColor } : undefined}
            >
              {quoteTitle.trim() || "Untitled quote"}
            </h3>
            <p className={`mt-1 text-sm ${isProfessional ? "opacity-80" : "text-slate-500"}`}>{subtitle}</p>
          </div>
        </div>

        <div
          className={`mt-4 flex flex-col items-start gap-1 border-t pt-4 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${
            isProfessional ? "opacity-80" : "text-slate-500"
          } ${metaClass}`}
        >
          <span>Prepared {preparedDateLabel} &nbsp;|&nbsp; Sent {sentDateLabel || "N/A"}</span>
          <span className={`font-medium ${isProfessional ? "" : "text-slate-500"}`}>{quoteReferenceLabel}</span>
        </div>
      </div>
    </section>
  );
}

function BrandLogo({ logoUrl }: { logoUrl: string }) {
  return (
    <div className="flex h-12 max-w-[132px] items-center sm:max-w-[160px]">
      <img src={logoUrl} alt="Company logo" className="max-h-12 w-auto max-w-full object-contain" />
    </div>
  );
}

function PreviewInfoCard({
  label,
  value,
  hint,
  labelColor,
}: {
  label: string;
  value: string;
  hint?: string;
  labelColor?: string;
}) {
  return (
    <div className="rounded-[22px] border border-[var(--qf-border)] bg-white px-5 py-5 shadow-[var(--qf-shadow-sm)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: labelColor ?? "#64748b" }}>
        {label}
      </p>
      <p className="mt-3 break-words text-[15px] font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-2 whitespace-pre-line break-words text-sm leading-6 text-slate-500">{hint}</p> : null}
    </div>
  );
}

function PreviewLineMeta({
  label,
  value,
  strong,
  accentColor,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accentColor?: string;
}) {
  return (
    <div className="space-y-1 text-right md:space-y-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 md:hidden">{label}</p>
      <p
        className={`text-xs md:text-sm ${strong ? "font-semibold" : "text-slate-700"}`}
        style={strong ? { color: accentColor ?? "#0f172a" } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

function PreviewTotalRow({
  label,
  value,
  strong,
  accentColor,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accentColor?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--qf-border)] py-2 text-sm last:border-b-0 last:pt-3">
      <span className="text-slate-600">{label}</span>
      <span
        className={strong ? "font-semibold" : "font-medium text-slate-900"}
        style={strong ? { color: accentColor ?? "#0f172a" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function getContrastingTextColor(color: string): string {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#4F7FD2";
  const red = Number.parseInt(safe.slice(1, 3), 16);
  const green = Number.parseInt(safe.slice(3, 5), 16);
  const blue = Number.parseInt(safe.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#111111" : "#ffffff";
}
