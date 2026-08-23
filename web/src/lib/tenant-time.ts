type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type TenantWallTimeChoice = {
  iso: string;
  offsetMinutes: number;
  offsetLabel: string;
  zoneName: string;
};

export type TenantWallTimeResolution =
  | { kind: "valid"; choices: [TenantWallTimeChoice] }
  | { kind: "ambiguous"; choices: [TenantWallTimeChoice, TenantWallTimeChoice, ...TenantWallTimeChoice[]] }
  | { kind: "nonexistent" | "invalid"; choices: [] };

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

function parseWallTime(value: string): DateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const desired: DateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const normalized = new Date(wallClockUtc(desired));
  if (
    normalized.getUTCFullYear() !== desired.year
    || normalized.getUTCMonth() + 1 !== desired.month
    || normalized.getUTCDate() !== desired.day
    || normalized.getUTCHours() !== desired.hour
    || normalized.getUTCMinutes() !== desired.minute
  ) {
    return null;
  }
  return desired;
}

function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function zoneName(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(value).find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/**
 * Resolves a tenant-local wall time without guessing across daylight-saving folds.
 * Callers must ask the user to choose when `kind` is `ambiguous`.
 */
export function resolveTenantWallTime(value: string, requestedTimeZone: string): TenantWallTimeResolution {
  const desired = parseWallTime(value);
  if (!desired) return { kind: "invalid", choices: [] };
  const timeZone = validTimeZone(requestedTimeZone);
  const desiredEpoch = wallClockUtc(desired);
  const candidateOffsets = new Set<number>();

  // Sampling around the requested date captures both sides of a nearby offset
  // transition, including zones with half-hour and quarter-hour offsets.
  for (let hours = -48; hours <= 48; hours += 6) {
    const sampleEpoch = desiredEpoch + hours * 60 * 60 * 1000;
    const renderedEpoch = wallClockUtc(partsInTimeZone(new Date(sampleEpoch), timeZone));
    candidateOffsets.add(Math.round((renderedEpoch - sampleEpoch) / 60_000));
  }

  const choices = [...candidateOffsets]
    .map((offsetMinutes) => {
      const instant = new Date(desiredEpoch - offsetMinutes * 60_000);
      return { instant, offsetMinutes };
    })
    .filter(({ instant }) => wallClockUtc(partsInTimeZone(instant, timeZone)) === desiredEpoch)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime())
    .map(({ instant, offsetMinutes }) => ({
      iso: instant.toISOString(),
      offsetMinutes,
      offsetLabel: offsetLabel(offsetMinutes),
      zoneName: zoneName(instant, timeZone),
    }));

  if (choices.length === 0) return { kind: "nonexistent", choices: [] };
  if (choices.length === 1) return { kind: "valid", choices: [choices[0]] };
  return {
    kind: "ambiguous",
    choices: choices as [TenantWallTimeChoice, TenantWallTimeChoice, ...TenantWallTimeChoice[]],
  };
}

export function tenantWallTimeToIso(value: string, requestedTimeZone: string): string | null {
  const resolution = resolveTenantWallTime(value, validTimeZone(requestedTimeZone));
  return resolution.kind === "valid" || resolution.kind === "ambiguous"
    ? resolution.choices[0].iso
    : null;
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
