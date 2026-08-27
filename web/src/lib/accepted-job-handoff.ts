import type { QuoteAcceptedJobSummary } from "./api";

export function resolveAcceptedJobAction(params: Readonly<{
  current: QuoteAcceptedJobSummary | null;
  quoteChanged: boolean;
  quoteIsAccepted: boolean;
  acceptedJob: QuoteAcceptedJobSummary | null | undefined;
}>) {
  if (!params.quoteIsAccepted) return null;
  if (params.acceptedJob !== undefined) return params.acceptedJob;
  return params.quoteChanged ? null : params.current;
}
