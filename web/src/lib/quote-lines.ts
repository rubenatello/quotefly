import type { QuoteLineItem } from "./api";

export type EditableQuoteLine = {
  id: string;
  title: string;
  details: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
};

export function splitQuoteLineDescription(description: string): {
  title: string;
  details: string;
} {
  const normalized = description.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return { title: "", details: "" };
  }

  const [title, ...rest] = normalized.split("\n");
  return {
    title: title.trim(),
    details: rest.join("\n").trim(),
  };
}

export function joinQuoteLineDescription(title: string, details: string): string {
  const normalizedTitle = title.trim();
  const normalizedDetails = details.trim();

  if (!normalizedDetails) {
    return normalizedTitle;
  }

  if (!normalizedTitle) {
    return normalizedDetails;
  }

  return `${normalizedTitle}\n${normalizedDetails}`;
}

export function quoteLineNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function quoteLineAmount(quantity: string, unitPrice: string): number {
  return quoteLineNumber(quantity) * quoteLineNumber(unitPrice);
}

export function quoteLineCostTotal(quantity: string, unitCost: string): number {
  return quoteLineNumber(quantity) * quoteLineNumber(unitCost);
}

export function toEditableQuoteLine(lineItem: QuoteLineItem): EditableQuoteLine {
  const { title, details } = splitQuoteLineDescription(lineItem.description);

  return {
    id: lineItem.id,
    title,
    details,
    quantity: String(Number(lineItem.quantity)),
    unitCost: Number(lineItem.unitCost).toFixed(2),
    unitPrice: Number(lineItem.unitPrice).toFixed(2),
  };
}

export function makeEditableQuoteLine(seed?: Partial<EditableQuoteLine>): EditableQuoteLine {
  const localId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `line-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    id: localId,
    title: seed?.title ?? "",
    details: seed?.details ?? "",
    quantity: seed?.quantity ?? "1",
    unitCost: seed?.unitCost ?? "0.00",
    unitPrice: seed?.unitPrice ?? "0.00",
  };
}
