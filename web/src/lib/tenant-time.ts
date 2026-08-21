type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value;
  } catch {
    return "UTC";
  }
}

function partsInTimeZone(value: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function wallClockUtc(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

export function tenantWallTimeToIso(value: string, requestedTimeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const desired: DateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const timeZone = validTimeZone(requestedTimeZone);
  let candidate = wallClockUtc(desired);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = partsInTimeZone(new Date(candidate), timeZone);
    const delta = wallClockUtc(desired) - wallClockUtc(rendered);
    if (delta === 0) break;
    candidate += delta;
  }
  const finalParts = partsInTimeZone(new Date(candidate), timeZone);
  if (wallClockUtc(finalParts) !== wallClockUtc(desired)) return null;
  return new Date(candidate).toISOString();
}

export function toTenantDateTimeInput(value: string | Date, requestedTimeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = partsInTimeZone(date, validTimeZone(requestedTimeZone));
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatTenantDateTime(value: string, requestedTimeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: validTimeZone(requestedTimeZone),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}
