import type { TenantBranding } from "./api";

type QuoteMessageTemplateInput = {
  customerName: string;
  quoteTitle: string;
  quoteTotalAmount: number | string;
  scopeText?: string | null;
  branding?: TenantBranding | null;
};

const DEFAULT_QUOTE_MESSAGE_TEMPLATE = [
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
].join("\n");

function formatMoney(value: number | string) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "$0.00";
}

function normalizeTemplateOutput(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cleaned: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const stripped = line.trim();
    const labelOnly = /^[A-Za-z][A-Za-z /&()-]*:\s*$/.test(stripped);

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
  const subject = `${input.quoteTitle} - Quote`;
  const template = input.branding?.quoteMessageTemplate?.trim() || DEFAULT_QUOTE_MESSAGE_TEMPLATE;
  const scopeText = input.scopeText?.trim() || "See the attached quote PDF for the full scope.";

  const replacements: Record<string, string> = {
    customer_name: input.customerName,
    quote_title: input.quoteTitle,
    quote_total: formatMoney(input.quoteTotalAmount),
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
