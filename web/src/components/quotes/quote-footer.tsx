import type { PlanCode, SupportedLocale } from "../../lib/api";
import { quoteDocumentCopy } from "../../lib/quote-document-copy";

export function shouldShowQuoteFlyAttribution(
  planCode: PlanCode | null | undefined,
  hideQuoteFlyAttribution?: boolean | null,
): boolean {
  if (planCode === "starter" || !planCode) return true;
  return !hideQuoteFlyAttribution;
}

export function buildQuoteFooterText(input: {
  businessName: string;
  businessPhone?: string | null;
  businessEmail?: string | null;
  documentLocale?: SupportedLocale | null;
}): string {
  const copy = quoteDocumentCopy(input.documentLocale);
  const contactParts = [input.businessPhone?.trim(), input.businessEmail?.trim()].filter(
    (value): value is string => Boolean(value),
  );

  if (contactParts.length > 0) {
    return copy.questionsWithContact(input.businessName, contactParts);
  }

  return copy.questionsWithoutContact(input.businessName);
}

export function QuoteAttributionFooter({
  footerText,
  showQuoteFlyAttribution,
  textColor,
  documentLocale,
}: {
  footerText?: string;
  showQuoteFlyAttribution?: boolean;
  textColor?: string;
  documentLocale?: SupportedLocale | null;
}) {
  if (!footerText && !showQuoteFlyAttribution) return null;
  const copy = quoteDocumentCopy(documentLocale);

  return (
    <div className="border-t border-[var(--qf-border)] px-5 py-2.5 text-center sm:px-6">
      {footerText ? (
        <p
          className={`text-[11px] leading-5 ${textColor ? "" : "text-slate-500"}`}
          style={textColor ? { color: textColor } : undefined}
        >
          {footerText}
        </p>
      ) : null}
      {showQuoteFlyAttribution ? (
        <div
          className={`flex items-center justify-center gap-1.5 text-[11px] ${
            textColor ? "" : "text-slate-600"
          } ${footerText ? "mt-1.5" : ""}`}
          style={textColor ? { color: textColor } : undefined}
        >
          <img src="/favicon.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain opacity-80" />
          <span>{copy.createdWithQuoteFly}</span>
        </div>
      ) : null}
    </div>
  );
}
