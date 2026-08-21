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

function offsetAt(value: Date, timeZone: string): number {
  const parts = localParts(value, timeZone);
  const renderedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
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
