import type {
  QuoteLineItem,
  ServiceType,
  WorkPresetCategory,
  WorkPresetUnitType,
} from "./api";

export type EditableQuoteLine = {
  id: string;
  title: string;
  details: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
  sourcePresetId?: string | null;
  presetPromptHandled?: boolean;
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

function inferPresetUnitType(line: Pick<EditableQuoteLine, "title" | "details" | "quantity">): WorkPresetUnitType {
  const haystack = `${line.title} ${line.details}`.toLowerCase();
  const quantity = quoteLineNumber(line.quantity);

  if (/\b(sq\.?\s*ft|square\s*feet|square\s*foot|sqft|sf)\b/.test(haystack)) {
    return "SQ_FT";
  }

  if (/\b(hour|hours|hr|hrs)\b/.test(haystack)) {
    return "HOUR";
  }

  if (quantity > 1) {
    return "EACH";
  }

  return "FLAT";
}

function inferPresetCategory(line: Pick<EditableQuoteLine, "title" | "details">): WorkPresetCategory {
  const haystack = `${line.title} ${line.details}`.toLowerCase();
  if (/\b(fee|permit|trip|dispatch|disposal|haul|minimum charge|service call)\b/.test(haystack)) {
    return "FEE";
  }
  if (/\b(material|shingle|pipe|tile|wood|drywall|concrete|mulch|soil|lumber|fixture)\b/.test(haystack)) {
    return "MATERIAL";
  }
  return "SERVICE";
}

export function buildPresetPayloadFromLine(
  serviceType: ServiceType,
  line: Pick<EditableQuoteLine, "title" | "details" | "quantity" | "unitCost" | "unitPrice">,
  options?: { includeDescription?: boolean },
): {
  serviceType: ServiceType;
  name: string;
  description?: string;
  category: WorkPresetCategory;
  unitType: WorkPresetUnitType;
  defaultQuantity: number;
  unitCost: number;
  unitPrice: number;
} {
  return {
    serviceType,
    name: line.title.trim(),
    description: options?.includeDescription === false ? "" : line.details.trim() || undefined,
    category: inferPresetCategory(line),
    unitType: inferPresetUnitType(line),
    defaultQuantity: Math.max(quoteLineNumber(line.quantity), 1),
    unitCost: Math.max(quoteLineNumber(line.unitCost), 0),
    unitPrice: Math.max(quoteLineNumber(line.unitPrice), 0),
  };
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
    sourcePresetId: null,
    presetPromptHandled: false,
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
    sourcePresetId: seed?.sourcePresetId ?? null,
    presetPromptHandled: seed?.presetPromptHandled ?? false,
  };
}
