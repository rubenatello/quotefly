import type { SupportedLocale } from "./api";

export type QuoteDocumentCopy = {
  quotePreview: string;
  customerQuote: string;
  business: string;
  customer: string;
  selectCustomer: string;
  customerDetailsPlaceholder: string;
  overview: string;
  includedWork: string;
  description: string;
  quantity: string;
  unit: string;
  total: string;
  untitledLine: string;
  emptyLines: string;
  alternateOption: string;
  alternatePricing: string;
  optionalPricing: string;
  subtotal: string;
  tax: string;
  prepared: string;
  sent: string;
  notAvailable: string;
  untitledQuote: string;
  companyLogoAlt: string;
  questionsWithContact: (businessName: string, contacts: string[]) => string;
  questionsWithoutContact: (businessName: string) => string;
  createdWithQuoteFly: string;
};

const COPY: Record<SupportedLocale, QuoteDocumentCopy> = {
  "en-US": {
    quotePreview: "Quote preview",
    customerQuote: "Customer quote",
    business: "Business",
    customer: "Customer",
    selectCustomer: "Select customer",
    customerDetailsPlaceholder: "Customer details will show here.",
    overview: "Overview",
    includedWork: "Included Work",
    description: "Description",
    quantity: "Qty",
    unit: "Unit",
    total: "Total",
    untitledLine: "Untitled line",
    emptyLines: "Add quote lines to see the customer-facing document take shape.",
    alternateOption: "Alternate Option",
    alternatePricing: "Alternate pricing",
    optionalPricing: "Optional pricing. Not included in the main total below.",
    subtotal: "Subtotal",
    tax: "Tax",
    prepared: "Prepared",
    sent: "Sent",
    notAvailable: "N/A",
    untitledQuote: "Untitled quote",
    companyLogoAlt: "Company logo",
    questionsWithContact: (businessName, contacts) =>
      `Questions about this quote? Contact ${businessName} at ${contacts.join(" or ")}.`,
    questionsWithoutContact: (businessName) => `Questions about this quote? Contact ${businessName}.`,
    createdWithQuoteFly: "Created with QuoteFly",
  },
  "es-US": {
    quotePreview: "Vista previa de la cotización",
    customerQuote: "Cotización para el cliente",
    business: "Negocio",
    customer: "Cliente",
    selectCustomer: "Selecciona un cliente",
    customerDetailsPlaceholder: "Los datos del cliente aparecerán aquí.",
    overview: "Resumen",
    includedWork: "Trabajo incluido",
    description: "Descripción",
    quantity: "Cant.",
    unit: "Unidad",
    total: "Total",
    untitledLine: "Renglón sin título",
    emptyLines: "Agrega renglones para ver cómo quedará la cotización del cliente.",
    alternateOption: "Opción alterna",
    alternatePricing: "Precios alternos",
    optionalPricing: "Precio opcional. No está incluido en el total principal de abajo.",
    subtotal: "Subtotal",
    tax: "Impuesto",
    prepared: "Preparada",
    sent: "Enviada",
    notAvailable: "N/D",
    untitledQuote: "Cotización sin título",
    companyLogoAlt: "Logotipo del negocio",
    questionsWithContact: (businessName, contacts) =>
      `¿Tienes preguntas sobre esta cotización? Comunícate con ${businessName} al ${contacts.join(" o ")}.`,
    questionsWithoutContact: (businessName) =>
      `¿Tienes preguntas sobre esta cotización? Comunícate con ${businessName}.`,
    createdWithQuoteFly: "Creada con QuoteFly",
  },
};

export function normalizeQuoteDocumentLocale(locale?: string | null): SupportedLocale {
  return locale === "es-US" ? "es-US" : "en-US";
}

export function quoteDocumentCopy(locale?: string | null): QuoteDocumentCopy {
  return COPY[normalizeQuoteDocumentLocale(locale)];
}

export function formatQuoteDocumentMoney(value: string | number, locale?: string | null): string {
  const amount = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat(normalizeQuoteDocumentLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function formatQuoteDocumentDate(
  value: string | Date,
  locale?: string | null,
  timeZone?: string | null,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return quoteDocumentCopy(locale).notAvailable;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  try {
    return new Intl.DateTimeFormat(normalizeQuoteDocumentLocale(locale), {
      ...options,
      ...(timeZone?.trim() ? { timeZone: timeZone.trim() } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(normalizeQuoteDocumentLocale(locale), options).format(date);
  }
}
