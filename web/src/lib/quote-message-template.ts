import type { SupportedLocale, TenantBranding } from "./api";

type QuoteMessageTemplateInput = {
  customerName: string;
  quoteTitle: string;
  quoteTotalAmount: number | string;
  scopeText?: string | null;
  branding?: TenantBranding | null;
  documentLocale?: SupportedLocale;
};

const DEFAULT_QUOTE_MESSAGE_TEMPLATES: Record<SupportedLocale, string> = {
  "en-US": [
  "Hi {customer_name},",
  "",
  "Thanks for the opportunity to quote this project.",
  "",
  "Quote: {quote_title}",
  "Total: {quote_total}",
  "",
  "Scope:",
  "{quote_scope}",
  "",
  "Call: {business_phone}",
  "Email: {business_email}",
  "",
  "Reply to confirm or ask for any revisions.",
  ].join("\n"),
  "es-US": [
    "Hola {customer_name},",
    "",
    "Gracias por la oportunidad de preparar esta cotización.",
    "",
    "Cotización: {quote_title}",
    "Total: {quote_total}",
    "",
    "Alcance:",
    "{quote_scope}",
    "",
    "Teléfono: {business_phone}",
    "Correo electrónico: {business_email}",
    "",
    "Responda para confirmar o solicitar cambios.",
  ].join("\n"),
};

function formatMoney(value: number | string, locale: SupportedLocale) {
  const amount = typeof value === "number" ? value : Number(value);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return Number.isFinite(amount) ? formatter.format(amount) : formatter.format(0);
}

function normalizeTemplateOutput(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cleaned: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const stripped = line.trim();
    const labelOnly = /^\p{L}[\p{L} /&()-]*:\s*$/u.test(stripped);

    if (labelOnly) continue;

    if (stripped.length === 0) {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1] === "") continue;
      cleaned.push("");
      continue;
    }

    cleaned.push(line);
  }

  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") {
    cleaned.pop();
  }

  return cleaned.join("\n");
}

export function buildQuoteMessageDraft(
  input: QuoteMessageTemplateInput,
): { subject: string; body: string } {
  const locale = input.documentLocale === "es-US" ? "es-US" : "en-US";
  const subject =
    locale === "es-US"
      ? `${input.quoteTitle} - Cotización`
      : `${input.quoteTitle} - Quote`;
  // A tenant-authored custom template is used exactly as written. QuoteFly does
  // not machine-translate custom business copy.
  const template =
    input.branding?.quoteMessageTemplate?.trim() ||
    DEFAULT_QUOTE_MESSAGE_TEMPLATES[locale];
  const scopeText =
    input.scopeText?.trim() ||
    (locale === "es-US"
      ? "Consulte el PDF adjunto para ver el alcance completo."
      : "See the attached quote PDF for the full scope.");

  const replacements: Record<string, string> = {
    customer_name: input.customerName,
    quote_title: input.quoteTitle,
    quote_total: formatMoney(input.quoteTotalAmount, locale),
    quote_scope: scopeText,
    business_phone: input.branding?.businessPhone?.trim() ?? "",
    business_email: input.branding?.businessEmail?.trim() ?? "",
  };

  const body = normalizeTemplateOutput(
    template.replace(/\{([a-z_]+)\}/gi, (_, key: string) => replacements[key.toLowerCase()] ?? ""),
  );

  return { subject, body };
}

export const QUOTE_MESSAGE_TEMPLATE_TOKENS = [
  "{customer_name}",
  "{quote_title}",
  "{quote_total}",
  "{quote_scope}",
  "{business_phone}",
  "{business_email}",
] as const;
