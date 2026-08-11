export const QUOTE_TITLE_MIN_LENGTH = 3;
export const QUOTE_SCOPE_MIN_LENGTH = 3;
export const QUOTE_SECTION_LABEL_MAX_LENGTH = 80;
export const QUOTE_LINE_CHANGE_LIMIT = 300;

type QuoteLineValues = {
  title: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
};

function finiteNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateQuoteHeading(title: string, scopeText: string, taxAmount: string) {
  if (title.trim().length < QUOTE_TITLE_MIN_LENGTH) return "Quote title must be at least 3 characters.";
  if (scopeText.trim().length < QUOTE_SCOPE_MIN_LENGTH) return "Quote scope must be at least 3 characters.";
  const tax = finiteNumber(taxAmount);
  if (tax === null || tax < 0) return "Tax must be a valid amount of 0 or more.";
  return null;
}

export function validateQuoteLine(line: QuoteLineValues, label = "Each line") {
  if (!line.title.trim()) return `${label} needs a title.`;
  if (line.sectionLabel.trim().length > QUOTE_SECTION_LABEL_MAX_LENGTH) {
    return `${label} option label must be 80 characters or fewer.`;
  }
  const quantity = finiteNumber(line.quantity);
  if (quantity === null || quantity <= 0) return `${label} quantity must be greater than 0.`;
  const unitCost = finiteNumber(line.unitCost);
  if (unitCost === null || unitCost < 0) return `${label} cost must be a valid amount of 0 or more.`;
  const unitPrice = finiteNumber(line.unitPrice);
  if (unitPrice === null || unitPrice < 0) return `${label} price must be a valid amount of 0 or more.`;
  return null;
}

export function isCompleteQuoteLine(line: QuoteLineValues) {
  return validateQuoteLine(line) === null;
}
