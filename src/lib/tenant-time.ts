type LocalDateParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

function validTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
    return normalized;
  } catch {
    return "UTC";
  }
}

function localParts(value: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

function wallClockUtc(parts: LocalDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(value: Date, timeZone: string): number {
  const parts = localParts(value, timeZone);
  const renderedAsUtc = wallClockUtc(parts);
  return renderedAsUtc - value.getTime();
}

function localMidnightUtc(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  timeZone: string,
): Date {
  const localEpoch = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0);
  let candidate = localEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = localEpoch - offsetAt(new Date(candidate), timeZone);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

function shiftLocalDate(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  days: number,
) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function tenantLocalDateParts(
  value: Date,
  requestedTimeZone: string,
): Pick<LocalDateParts, "year" | "month" | "day" | "hour" | "minute"> {
  const parts = localParts(value, validTimeZone(requestedTimeZone));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

export function shiftTenantLocalDate(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalDateParts, "year" | "month" | "day"> {
  return shiftLocalDate(date, days);
}

export function tenantWallTimeToUtc(
  value: Pick<LocalDateParts, "year" | "month" | "day" | "hour" | "minute"> & { second?: number },
  requestedTimeZone: string,
): Date | null {
  const desired: LocalDateParts = {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second ?? 0,
  };
  const timeZone = validTimeZone(requestedTimeZone);
  let candidate = wallClockUtc(desired);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = localParts(new Date(candidate), timeZone);
    const delta = wallClockUtc(desired) - wallClockUtc(rendered);
    if (delta === 0) break;
    candidate += delta;
  }
  const finalParts = localParts(new Date(candidate), timeZone);
  if (wallClockUtc(finalParts) !== wallClockUtc(desired)) return null;
  return new Date(candidate);
}

/**
 * Returns every UTC instant that renders as the requested tenant wall time.
 * Most wall times have one candidate, spring-forward gaps have none, and
 * fall-back folds have two. Sampling the offsets around the local date keeps
 * this deterministic without guessing which side of a DST fold the user meant.
 */
export function tenantWallTimeUtcCandidates(
  value: Pick<LocalDateParts, "year" | "month" | "day" | "hour" | "minute"> & { second?: number },
  requestedTimeZone: string,
): Date[] {
  const desired: LocalDateParts = {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second ?? 0,
  };
  const timeZone = validTimeZone(requestedTimeZone);
  const localEpoch = wallClockUtc(desired);
  const possibleOffsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    possibleOffsets.add(offsetAt(new Date(localEpoch + hours * 60 * 60 * 1_000), timeZone));
  }

  const candidates = Array.from(possibleOffsets, (offset) => new Date(localEpoch - offset))
    .filter((candidate) => wallClockUtc(localParts(candidate, timeZone)) === localEpoch)
    .sort((left, right) => left.getTime() - right.getTime());
  return candidates.filter((candidate, index) => (
    index === 0 || candidate.getTime() !== candidates[index - 1]!.getTime()
  ));
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  const normalized = timeZone.trim();
  if (!normalized) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function tenantActivityWindows(
  now: Date,
  requestedTimeZone: string,
) {
  const timeZone = validTimeZone(requestedTimeZone);
  const today = localParts(now, timeZone);
  const todayDate = { year: today.year, month: today.month, day: today.day };
  return {
    timeZone,
    todayStartUtc: localMidnightUtc(todayDate, timeZone),
    tomorrowStartUtc: localMidnightUtc(shiftLocalDate(todayDate, 1), timeZone),
    upcomingEndUtc: localMidnightUtc(shiftLocalDate(todayDate, 8), timeZone),
    completedStartUtc: localMidnightUtc(shiftLocalDate(todayDate, -6), timeZone),
  };
}
