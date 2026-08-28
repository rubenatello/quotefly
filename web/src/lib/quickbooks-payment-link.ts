const QUICKBOOKS_HOST_SUFFIXES = ["intuit.com", "quickbooks.com"] as const;

export function safeQuickBooksHostedPaymentUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const trustedHost = QUICKBOOKS_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (parsed.protocol !== "https:" || !trustedHost || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isValidQuickBooksBillingEmail(value: string): boolean {
  const normalized = value.trim();
  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function normalizeQuickBooksInvoiceReviewOptions(options: {
  billingEmail?: string | null;
  allowOnlineAchPayment: boolean;
  allowOnlineCardPayment: boolean;
}) {
  return {
    billingEmail: options.billingEmail?.trim() || null,
    allowOnlineAchPayment: options.allowOnlineAchPayment,
    allowOnlineCardPayment: options.allowOnlineCardPayment,
  };
}

export function isCurrentQuickBooksRequestContext(params: {
  requestedSource: string;
  requestedGeneration: number;
  currentSource: string;
  currentGeneration: number;
  requestedInvoiceId?: string;
  responseInvoiceId?: string;
  currentInvoiceId?: string | null;
  requestedInvoiceVersion?: number;
  currentInvoiceVersion?: number | null;
}): boolean {
  return params.requestedSource === params.currentSource
    && params.requestedGeneration === params.currentGeneration
    && (
      params.requestedInvoiceId === undefined
      || (
        (params.responseInvoiceId === undefined || params.responseInvoiceId === params.requestedInvoiceId)
        && (params.currentInvoiceId === undefined || params.currentInvoiceId === params.requestedInvoiceId)
      )
    )
    && (
      params.requestedInvoiceVersion === undefined
      || params.currentInvoiceVersion === params.requestedInvoiceVersion
    );
}

export function isQuickBooksPreviewCurrentForPublish(params: {
  activeInvoiceId: string | null | undefined;
  activeInvoiceVersion: number | null | undefined;
  previewInvoiceId: string | null | undefined;
  previewInvoiceVersion: number | null | undefined;
}): boolean {
  return Boolean(
    params.activeInvoiceId
    && params.previewInvoiceId === params.activeInvoiceId
    && params.activeInvoiceVersion !== null
    && params.activeInvoiceVersion !== undefined
    && params.previewInvoiceVersion === params.activeInvoiceVersion,
  );
}
