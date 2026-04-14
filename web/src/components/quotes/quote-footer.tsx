import type { PlanCode } from "../../lib/api";

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
}): string {
  const contactParts = [input.businessPhone?.trim(), input.businessEmail?.trim()].filter(
    (value): value is string => Boolean(value),
  );

  if (contactParts.length > 0) {
    return `Questions about this quote? Contact ${input.businessName} at ${contactParts.join(" or ")}.`;
  }

  return `Questions about this quote? Contact ${input.businessName}.`;
}

export function QuoteAttributionFooter({
  footerText,
  showQuoteFlyAttribution,
}: {
  footerText?: string;
  showQuoteFlyAttribution?: boolean;
}) {
  if (!footerText && !showQuoteFlyAttribution) return null;

  return (
    <div className="border-t border-[var(--qf-border)] px-5 py-2.5 text-center sm:px-6">
      {footerText ? <p className="text-[11px] leading-5 text-slate-500">{footerText}</p> : null}
      {showQuoteFlyAttribution ? (
        <div className={`flex items-center justify-center gap-1.5 text-[11px] text-slate-400 ${footerText ? "mt-1.5" : ""}`}>
          <img src="/favicon.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain opacity-80" />
          <span>Created with QuoteFly</span>
        </div>
      ) : null}
    </div>
  );
}
