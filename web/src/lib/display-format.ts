const ENUM_VALUE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const LOWERCASE_CONNECTORS = new Set(["and", "at", "for", "in", "of", "on", "or", "to"]);
const ACRONYMS = new Set(["AI", "API", "CRM", "HVAC", "ID", "PDF", "SMS", "URL", "UTC"]);

export function formatBackendLabel(value: string) {
  if (!ENUM_VALUE_PATTERN.test(value)) return value;
  return value
    .split("_")
    .filter(Boolean)
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && LOWERCASE_CONNECTORS.has(lower)) return lower;
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

export function isDateResultKey(key: string) {
  return /(?:at|date|since|timestamp|until)(?:utc)?$/i.test(key);
}

function validDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function validTimeZone(timeZone?: string | null) {
  const normalized = timeZone?.trim();
  if (!normalized) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
    return normalized;
  } catch {
    return undefined;
  }
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatShortLocalDate(value: string | Date, timeZone?: string | null) {
  const date = validDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: validTimeZone(timeZone),
  }).format(date);
}

export function formatLocalDateTime(value: string | Date, timeZone?: string | null) {
  const date = validDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: validTimeZone(timeZone),
  }).format(date);
}

export function toUtcIsoString(value: string | Date) {
  const date = validDate(value);
  return date?.toISOString() ?? null;
}
