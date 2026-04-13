export type StandardQuoteTemplateId = "modern" | "professional" | "minimal";

export type QuoteTemplateOption = {
  id: StandardQuoteTemplateId;
  name: string;
  description: string;
  bestFor: string;
  preview: string;
  headerStyle: "bar" | "card" | "minimal";
};

export const QUOTE_TEMPLATE_OPTIONS: QuoteTemplateOption[] = [
  {
    id: "modern",
    name: "Modern",
    description: "Clean top-bar layout with balanced spacing for fast field quoting.",
    bestFor: "Fast field quotes",
    preview: "bg-white",
    headerStyle: "bar",
  },
  {
    id: "professional",
    name: "Professional",
    description: "Structured proposal header with stronger hierarchy for office-ready estimates.",
    bestFor: "Formal proposals",
    preview: "bg-slate-50",
    headerStyle: "card",
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Low-noise document styling that keeps the scope and totals front and center.",
    bestFor: "Lean, text-first quotes",
    preview: "bg-white",
    headerStyle: "minimal",
  },
];

export function normalizeQuoteTemplateId(templateId?: string | null): StandardQuoteTemplateId {
  if (templateId === "modern") return "modern";
  if (templateId === "minimal") return "minimal";
  return "professional";
}

export function getQuoteTemplateOption(templateId?: string | null): QuoteTemplateOption {
  const normalizedId = normalizeQuoteTemplateId(templateId);
  return QUOTE_TEMPLATE_OPTIONS.find((template) => template.id === normalizedId) ?? QUOTE_TEMPLATE_OPTIONS[0];
}
