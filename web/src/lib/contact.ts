export const SUPPORT_EMAIL = "support@quotefly.us";
export const INFO_EMAIL = "info@quotefly.us";

function createMailto(email: string, subject: string, body: string): string {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${email}?${params.toString()}`;
}

export const SUPPORT_MAILTO = createMailto(
  SUPPORT_EMAIL,
  "QuoteFly support request",
  [
    "Company name:",
    "Account email:",
    "Page or feature:",
    "Device and browser:",
    "What happened:",
    "",
    "Please attach a screenshot or screen recording when helpful.",
  ].join("\n"),
);

export const INFO_MAILTO = createMailto(
  INFO_EMAIL,
  "QuoteFly sales inquiry",
  ["Name:", "Company:", "Trade:", "Team size:", "How can we help?"].join("\n"),
);
